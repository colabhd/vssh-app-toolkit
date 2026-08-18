"""Do id de um vídeo às trilhas que o MPD precisa — sem que nada aqui saiba o que é a rede.

    Resolvedor(extrair, ler_cabecalho).video(id) -> Resolucao

⚠ **As duas funções que falam com o mundo entram por injeção**, e não é purismo de teste: o plano
foi escrito com essa restrição porque o YouTube quebra extractor toda semana. Uma suíte que
resolvesse de verdade ficaria vermelha quando o Google mexesse em qualquer coisa — e um teste que
fica vermelho sozinho é um teste que alguém desliga. Aqui os testes alimentam JSON gravado.

─── ⚠ Dois caches, com vidas DIFERENTES, e a diferença foi medida ────────────

Resolvendo o mesmo vídeo duas vezes seguidas:

    a URL       muda toda vez      é credencial: leva `ip`, `expire` e uma assinatura
    os ranges   idênticos          são propriedade do ARQUIVO, e o arquivo é imutável

Daí a separação. O cache de URLs morre com o `expire` que a própria URL carrega (6 h, medido); o de
ranges não precisa morrer nunca — o `sidx` do itag 134 daquele vídeo está onde está desde que o
YouTube o codificou.

**O que isso poupa:** resolver um vídeo custa 18 leituras de 4 KB, uma por formato. Com o cache de
ranges, reabrir custa **zero** — e "reabrir" inclui a segunda pessoa a assistir o mesmo vídeo, o
retorno depois de fechar a janela, e o F5.

⚠ E é por isso que o proxy de bytes não pode guardar só a URL: numa reprodução longa ela expira no
meio. Quem serve bytes tem de poder pedir uma resolução nova, e `video()` devolve do cache ou
resolve conforme a validade — a decisão é aqui, não em quem chama.
"""

import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from dash import CABECALHO, escolher_formatos, e_dash_em_mp4, ranges_do_cabecalho

# ⚠ **A lista branca do proxy, e ela é curta de propósito.** Repassar a resposta do googlevideo
# inteira levaria cabeçalhos do Google — `Set-Cookie`, identificadores de borda, `Alt-Svc` — para
# dentro da sessão de quem assiste, na origem do ambiente. Nada disso é preciso para tocar: o player
# usa os quatro abaixo e ignora o resto.
CABECALHOS_REPASSADOS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")

_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ITAG = re.compile(r"^\d{1,4}$")


def id_valido(vid):
    return bool(vid) and bool(_ID.match(str(vid)))


def itag_valido(itag):
    return bool(itag) and bool(_ITAG.match(str(itag)))

# Quantas leituras de cabeçalho ao mesmo tempo. Oito porque são requisições que passam 99% do tempo
# esperando a rede — mais threads não aceleram um servidor que responde em 250 ms, e cada uma custa
# uma conexão a mais para o mesmo host, que é como se pede para ser limitado.
_PARALELAS = 8

# A margem antes do `expire` declarado. Uma URL que vale mais 30 segundos é uma URL que expira no
# meio do próximo fragmento — e o sintoma seria o vídeo parando sem erro, no meio, para quem assiste.
_MARGEM = 300

# Quanto vale uma resolução quando a URL não diz. Não deveria acontecer; se acontecer, cinco minutos
# erram para o lado de resolver de novo à toa, que custa uma chamada, e não para o lado de servir
# uma credencial morta, que custa a reprodução.
_SEM_EXPIRE = 300


@dataclass
class Resolucao:
    id: str
    titulo: str = ""
    canal: str = ""
    duracao: Optional[float] = None
    miniatura: Optional[str] = None
    ao_vivo: bool = False
    trilhas: list = field(default_factory=list)          # `dash.Trilha`, para montar o MPD
    urls: Dict[str, str] = field(default_factory=dict)   # itag → URL assinada, para o proxy
    cabecalhos: Dict[str, dict] = field(default_factory=dict)
    legendas: List[dict] = field(default_factory=list)
    expira: float = 0.0

    def valida_em(self, quando, margem=_MARGEM):
        return quando + margem < self.expira


def expira_em(url):
    """O `expire` que a URL assinada carrega, como timestamp — ou `None`.

    É o próprio YouTube dizendo até quando aquela credencial vale, o que é melhor que qualquer TTL
    que nós inventássemos: um TTL fixo ou expira cedo demais (e re-resolve à toa) ou tarde demais
    (e serve uma URL morta no meio do filme).
    """
    # ⚠ O `isinstance` vem ANTES do `try`, e não é redundância: `urlsplit` de um não-texto levanta
    # `AttributeError`, que nenhum `except (ValueError, TypeError)` pega. Um campo que chega como
    # número — de um JSON malformado, de um extractor mudado — derrubaria a resolução inteira por
    # causa de um prazo que é opcional.
    if not isinstance(url, str):
        return None
    try:
        v = (parse_qs(urlsplit(url).query).get("expire") or [None])[0]
        return float(v) if v else None
    except (ValueError, TypeError):
        return None


def metadados(info):
    """O `extract_info` → o que a tela precisa, e só isso.

    ⚠ O dicionário do yt-dlp tem centenas de chaves e algumas são enormes (`automatic_captions` de
    um vídeo popular passa de 100 KB de traduções). Mandá-lo inteiro para o frontend seria pagar
    esse peso em toda abertura para exibir um título e um nome de canal.
    """
    info = info or {}
    minis = info.get("thumbnails") or []
    # A última é a maior — o yt-dlp ordena da pior para a melhor. `thumbnail` no topo existe às
    # vezes e às vezes não, então a lista é a fonte confiável e o campo é o recuo.
    mini = (minis[-1].get("url") if minis else None) or info.get("thumbnail")
    return {
        "id": info.get("id") or "",
        "titulo": info.get("title") or "",
        "canal": info.get("channel") or info.get("uploader") or "",
        "canalId": info.get("channel_id") or None,
        "duracao": info.get("duration"),
        "miniatura": mini,
        # ⚠ `is_live` responde "está no ar AGORA"; `was_live` responde "foi uma transmissão". Um
        # vídeo que já acabou tem `is_live` falso e é um arquivo comum — tratá-lo como ao vivo
        # esconderia a linha do tempo de uma gravação que tem duração e busca perfeitamente normais.
        "aoVivo": bool(info.get("is_live")),
        "visualizacoes": info.get("view_count"),
        "publicado": info.get("upload_date") or None,
    }


# O `<track>` do navegador lê VTT e mais nada. O YouTube oferece sete formatos por idioma e o VTT
# é o ÚLTIMO deles — ver `_FORMATOS`, abaixo, para por que essa ordem importa tanto.
_FORMATOS = ("vtt",)


def _mesma_lingua(a, b):
    """`pt` casa com `pt-BR`, e `pt` não casa com `pl`."""
    return str(a).lower().split("-")[0] == str(b).lower().split("-")[0]


def legendas_de(info, auto_em=None):
    """As faixas de legenda oferecíveis, as manuais antes das automáticas.

    ⚠ A ordem não é estética. Legenda automática de fala espontânea erra nomes próprios e pontuação;
    quando existe a manual, ela é outra qualidade de texto. Oferecer as duas misturadas faria a
    pessoa escolher no escuro entre "Português" e "Português", e o `auto` no rótulo é o que permite
    decidir.

    ⚠ **`auto_em` não é filtro opcional, é o que torna o menu utilizável.** Medido em dois vídeos
    quaisquer: `automatic_captions` traz **157 idiomas**. Sem recorte, o menu Legenda ganharia 157
    entradas e o `<video>` 157 elementos `<track>` — e a legenda que a pessoa quer, a do idioma
    dela, ficaria perdida no meio. As manuais passam todas: são as que alguém escreveu de
    propósito, e um vídeo bem legendado tem dezenas, não centenas.

    ⚠ **E o formato é `vtt` e SÓ ele.** A lista do YouTube vem
    `['json3','srv1','srv2','srv3','ttml','srt','vtt']` — com o `srt` ANTES do `vtt` — então um
    `ext in ("vtt","srt")` escolhe sempre o SRT. A rota o serviria como `text/vtt`, o navegador não
    parsearia nada, e o efeito na tela seria uma legenda que aparece no menu, liga, e não escreve
    uma palavra: a forma mais cara de falhar que existe, porque não deixa erro em lugar nenhum.
    """
    info = info or {}
    saida = []
    for chave, automatica in (("subtitles", False), ("automatic_captions", True)):
        for lang, faixas in (info.get(chave) or {}).items():
            if automatica and not (auto_em and any(_mesma_lingua(lang, x) for x in auto_em)):
                continue
            f = next((x for x in (faixas or []) if x.get("ext") in _FORMATOS), None)
            if not f:
                continue
            saida.append({
                "idioma": lang,
                "nome": f.get("name") or lang,
                "automatica": automatica,
                "url": f.get("url"),
                "ext": f.get("ext"),
            })
    saida.sort(key=lambda x: (x["automatica"], x["idioma"]))
    return saida


# ── Por que um vídeo não abriu ────────────────────────────────────────────────
#
# ⚠ **Antes disto, TODA falha de resolução dizia "o extractor pode estar desatualizado — Ferramentas
# → Atualizar yt-dlp".** Para um vídeo protegido por DRM isso é mandar a pessoa consertar a coisa
# errada, e ela pode clicar naquele botão para sempre: o extractor está perfeito, o vídeo é que não
# se remonta sem Widevine. Um conserto sugerido que não conserta é pior que nenhum — ele consome a
# única pista que a pessoa tinha.
#
# ⚠ **A frase do YouTube vem TRADUZIDA, e é por isso que a classificação não pode ser sobre ela.**
# Com `hl=pt` o log traz "O vídeo não está disponível"; com o padrão, "This video is not available".
# Casar texto do YouTube passaria a errar no dia em que alguém usasse o app em outro idioma.
#
# O que dá para casar com segurança são as mensagens do **yt-dlp**, que são dele e sempre em inglês.
# Então a regra é essa divisão:
#
#     mensagem do yt-dlp  → o extractor envelheceu, e o botão de atualizar É o conserto
#     mensagem do YouTube → mostra o que ele disse, e abre no navegador
#
# ⚠ `drm` é a exceção que vale o custo de uma segunda chamada: `player_client=tv` responde
# "This video is DRM protected" — em inglês, do yt-dlp — onde os clientes padrão só dizem
# "indisponível". Ver `Mundo.extrair(cliente=…)`.

# Do yt-dlp, nunca do YouTube. Envelhecer o extractor produz exatamente estas.
_DO_EXTRACTOR = (
    "unable to extract", "failed to extract", "player response", "nsig", "signature",
    "no player clients", "not a bot", "unable to download api page", "unsupported language code",
)
_DE_DRM = ("drm",)


def classificar_falha(*mensagens):
    """`(classe, frase, conserto)` para o que impediu um vídeo de abrir.

    Recebe TODAS as mensagens colhidas — a dos clientes padrão e a da segunda opinião —, porque a
    que nomeia a causa pode ser qualquer uma delas.
    """
    texto = " || ".join(str(m or "") for m in mensagens)
    baixo = texto.lower()

    if any(p in baixo for p in _DE_DRM):
        return ("drm",
                "Este vídeo é protegido por DRM e não pode ser remontado aqui.",
                "Abrindo no navegador, que sabe decifrá-lo.")

    # ⚠ O DRM é conferido ANTES: "This video is DRM protected" não contém nenhum sinal de
    # extractor, mas a ordem inversa ainda assim seria uma armadilha esperando uma frase nova.
    if any(p in baixo for p in _DO_EXTRACTOR):
        return ("extractor",
                "Não consegui ler este vídeo do YouTube.",
                "O extractor pode estar desatualizado — Ferramentas → Atualizar o yt-dlp.")

    # ⚠ Aqui a frase é do YOUTUBE, e vai como ele a escreveu — no idioma de quem assiste, porque é
    # o mesmo `hl` que a busca usa. Ele sabe por que recusou; nós não temos nada melhor a dizer.
    return ("youtube", primeira_frase(texto) or "Este vídeo não está disponível.",
            "Abrindo no navegador.")


def primeira_frase(texto):
    """A razão que o YouTube deu, sem o `ERROR: [youtube] <id>:` na frente e sem o resto."""
    bruto = str(texto or "").split(" || ")[0].strip()
    bruto = re.sub(r"^ERROR:\s*", "", bruto)
    bruto = re.sub(r"^\[[^\]]+\]\s*", "", bruto)
    bruto = re.sub(r"^[A-Za-z0-9_-]{6,15}:\s*", "", bruto)
    return bruto[:200]


def resposta_de_abertura(alvo, resolucao=None):
    """O corpo JSON de `/api/yt/abrir` — a decisão de rota, sem nada de HTTP em volta.

    ⚠ **`nao-e-nosso` NÃO é erro, e é o valor mais importante daqui.** Ele quer dizer "devolva este
    link", e quem chama devolve com `vssh.openUrl(url, {destino:'navegador'})`. É a regra que impede
    o deeplink de virar beco: no instante em que o Palco passa a receber os links do YouTube, todo
    endereço que ele não souber montar vira uma tela de erro na frente de alguém que só clicou.

    E isso vale hoje para playlist, canal e busca — que o `urls.py` sabe analisar e a interface
    ainda não sabe mostrar. Enquanto não souber, devolver é o único caminho honesto.
    """
    if alvo is None:
        return {"tipo": "nao-e-nosso"}
    if alvo.tipo != "video":
        return {"tipo": "nao-e-nosso", "porque": alvo.tipo}
    if resolucao is None:
        return {"tipo": "video", "id": alvo.id, "t": alvo.t, "lista": alvo.lista}
    return {
        "tipo": "video",
        "id": resolucao.id,
        # ⚠ A lista viaja com o VÍDEO, e é o que transforma `watch?v=…&list=…` numa fila em vez de
        # um vídeo solto. É a forma mais comum de link de playlist que circula — quem compartilha
        # "o vídeo 4 da lista" manda exatamente isto —, e sem este campo o próximo/anterior ficaria
        # apontando para a pasta do último arquivo local aberto.
        "lista": alvo.lista,
        "titulo": resolucao.titulo,
        "canal": resolucao.canal,
        "duracao": resolucao.duracao,
        "miniatura": resolucao.miniatura,
        "aoVivo": resolucao.ao_vivo,
        "t": alvo.t,
        # ⚠ **SEM barra inicial.** O app é servido sob `/<serverId>/proxy/app/<id>/`, e um
        # `/api/…` sai do prefixo — chegando num 404 do PORTAL, não do backend. Foi assim que a
        # primeira reprodução de verdade falhou, com o dash.js pedindo
        # `https://vssh.colabh.org/api/yt/mpd?v=…` e recebendo 404, enquanto a miniatura ao lado
        # funcionava: `listas.py` já montava a dela relativa.
        "mpd": f"api/yt/mpd?v={resolucao.id}",
        # ⚠ A URL da legenda NÃO viaja para a tela: ela é assinada, vence junto com as outras, e
        # publicá-la faria a página tentar buscá-la direto — onde a mesma origem a barra. O
        # frontend pede por idioma, e o servidor busca.
        "legendas": [{k: x[k] for k in ("idioma", "nome", "automatica")}
                     for x in resolucao.legendas],
        "qualidades": sorted({t.altura for t in resolucao.trilhas if t.altura}),
    }


class Resolvedor:
    """O que sabe pedir ao YouTube — com quem pede entrando de fora.

    `extrair(url)` devolve o dicionário do `extract_info`; `ler_cabecalho(url, headers, n)` devolve
    os primeiros `n` bytes daquela URL. Nenhuma das duas é escrita aqui, e é o que torna este módulo
    testável sem rede.
    """

    def __init__(self, extrair, ler_cabecalho, listar=None, agora=time.time,
                 paralelas=_PARALELAS, idioma=None):
        self._extrair = extrair
        self._ler = ler_cabecalho
        # ⚠ Listar é uma terceira função, e não o mesmo `extrair` com outra opção: as duas chamadas
        # pedem coisas de custos MUITO diferentes. Resolver um vídeo traz 33 formatos; listar traz
        # trinta entradas planas. Medido, a diferença é 4 000 ms para 3 resultados contra 1 570 ms
        # para 8. Uma função só, com um parâmetro de modo, esconderia isso de quem lê a chamada.
        self._listar = listar
        self._agora = agora
        # O idioma de quem assiste, já negociado. Ele decide UMA coisa aqui — de que idiomas as
        # legendas automáticas são oferecidas —, e o resto do efeito dele mora no `Mundo`.
        self._idioma = idioma or None
        self._paralelas = max(1, int(paralelas))
        self._resolucoes = {}   # vid → Resolucao (morre com o `expire` da URL)
        self._ranges = {}       # (vid, itag) → Ranges (não morre: é do arquivo)

    # ── o cache de ranges, que é o que paga a conta ──────────────────────────

    def _ranges_de(self, vid, formatos):
        """Os ranges de cada formato, lendo só os que ainda não conhecemos."""
        faltando = [f for f in formatos if (vid, str(f.get("format_id"))) not in self._ranges]

        def ler(f):
            itag = str(f.get("format_id"))
            try:
                cab = self._ler(f["url"], f.get("http_headers") or {}, CABECALHO)
            except Exception:  # noqa: BLE001
                # ⚠ Uma trilha a menos degrada a qualidade disponível; uma exceção subindo daqui
                # tira o vídeo inteiro do ar por causa de uma altura que ninguém talvez usasse.
                return itag, None
            return itag, ranges_do_cabecalho(cab)

        if faltando:
            with ThreadPoolExecutor(max_workers=min(self._paralelas, len(faltando))) as pool:
                for itag, r in pool.map(ler, faltando):
                    if r is not None:
                        self._ranges[(vid, itag)] = r

        return {itag: r for (v, itag), r in self._ranges.items() if v == vid}

    # ── a resolução ──────────────────────────────────────────────────────────

    def video(self, vid, forcar=False):
        """O vídeo, do cache ou resolvido agora."""
        agora = self._agora()
        cache = self._resolucoes.get(vid)
        if cache and not forcar and cache.valida_em(agora):
            return cache

        info = self._extrair(f"https://www.youtube.com/watch?v={vid}")
        formatos = [f for f in (info.get("formats") or []) if e_dash_em_mp4(f)]

        ranges = self._ranges_de(vid, formatos)
        trilhas = escolher_formatos(formatos, ranges)

        # ⚠ O menor `expire` de TODAS as URLs, não o da primeira: elas vêm de hosts diferentes
        # (`rr3---sn-…`, `rr5---sn-…`) e nada garante que expirem juntas. Usar a primeira faria a
        # trilha de áudio morrer enquanto o vídeo segue — imagem sem som, no meio, sem erro.
        prazos = [e for e in (expira_em(f.get("url")) for f in formatos) if e]
        expira = min(prazos) if prazos else agora + _SEM_EXPIRE

        m = metadados(info)
        r = Resolucao(
            id=vid, titulo=m["titulo"], canal=m["canal"], duracao=m["duracao"],
            miniatura=m["miniatura"], ao_vivo=m["aoVivo"],
            trilhas=trilhas,
            urls={str(f["format_id"]): f["url"] for f in formatos if f.get("url")},
            cabecalhos={str(f["format_id"]): (f.get("http_headers") or {}) for f in formatos},
            # A do idioma de quem assiste, mais a original do vídeo — que é a que existe quando o
            # canal não legendou nada e é o caso mais comum de todos.
            legendas=legendas_de(info, auto_em={x for x in (self._idioma,
                                                            info.get("language")) if x}),
            expira=expira,
        )
        self._resolucoes[vid] = r
        return r

    def listar(self, alvo, de=1, por_pagina=None):
        """Uma PÁGINA de busca, playlist ou canal — ou `None` se o alvo não é listagem.

        ⚠ **Sem cache, e é decisão.** As três listagens são exatamente as coisas que mudam: uma
        busca tem de refletir o que existe agora, um canal acabou de publicar, uma playlist foi
        reordenada. Guardá-las trocaria 700 ms por uma tela que mente — e o que custa caro (resolver
        o vídeo escolhido) já é cacheado do outro lado.

        `de` é 1-based, como o `playliststart` do yt-dlp — e manter a mesma origem que a biblioteca
        de baixo evita o `+1`/`-1` no meio, que é onde este tipo de contagem apodrece.
        """
        from listas import POR_PAGINA, normalizar, url_de_listagem

        n = int(por_pagina or POR_PAGINA)
        de = max(1, int(de or 1))
        ate = de + n - 1

        url = url_de_listagem(alvo, ate)
        if url is None or self._listar is None:
            return None
        info = self._listar(url, de, ate)
        return normalizar(info, alvo.tipo, lista=alvo.lista, de=de, pedidos=n)

    def url_de(self, vid, itag):
        """A URL assinada de um formato, re-resolvendo se a que temos está perto de vencer.

        É o que o proxy de bytes chama a cada requisição. Numa reprodução de duas horas a credencial
        vence no meio, e sem esta checagem o vídeo pararia sozinho — sem erro do nosso lado, porque
        do nosso lado nada falhou.
        """
        r = self.video(vid)
        if itag not in r.urls:
            return None, None
        return r.urls[itag], r.cabecalhos.get(itag) or {}
