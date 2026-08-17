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

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from dash import CABECALHO, escolher_formatos, e_dash_em_mp4, ranges_do_cabecalho

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


def legendas_de(info, idiomas=None):
    """As faixas de legenda oferecíveis, as manuais antes das automáticas.

    ⚠ A ordem não é estética. Legenda automática de fala espontânea erra nomes próprios e pontuação;
    quando existe a manual, ela é outra qualidade de texto. Oferecer as duas misturadas faria a
    pessoa escolher no escuro entre "Português" e "Português", e o `auto` no rótulo é o que permite
    decidir.
    """
    info = info or {}
    saida = []
    for chave, automatica in (("subtitles", False), ("automatic_captions", True)):
        for lang, faixas in (info.get(chave) or {}).items():
            if idiomas and lang not in idiomas:
                continue
            # Só as que já são texto temporizado. O yt-dlp oferece `json3`, `srv1`… e converter
            # cada formato seria trabalho para chegar ao mesmo VTT que ele entrega direto.
            f = next((x for x in faixas if x.get("ext") in ("vtt", "srt")), None)
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


class Resolvedor:
    """O que sabe pedir ao YouTube — com quem pede entrando de fora.

    `extrair(url)` devolve o dicionário do `extract_info`; `ler_cabecalho(url, headers, n)` devolve
    os primeiros `n` bytes daquela URL. Nenhuma das duas é escrita aqui, e é o que torna este módulo
    testável sem rede.
    """

    def __init__(self, extrair, ler_cabecalho, agora=time.time, paralelas=_PARALELAS):
        self._extrair = extrair
        self._ler = ler_cabecalho
        self._agora = agora
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
            legendas=legendas_de(info),
            expira=expira,
        )
        self._resolucoes[vid] = r
        return r

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
