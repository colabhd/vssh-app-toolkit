"""Busca, playlist e canal — as três listagens da aba, e o que cada uma cobra.

    url_de_listagem(alvo)      -> str | None    o que pedir ao yt-dlp
    normalizar(info)           -> Listagem      o que a grade desenha

Nada aqui fala com a rede. Quem chama é `youtube.Resolvedor`, com o extractor injetado.

─── ⚠ `extract_flat` não é otimização, é o que torna a aba possível ──────────

Medido com yt-dlp 2026.07.04:

    busca de 8, com `extract_flat`       1 570 ms
    busca de 3, SEM `extract_flat`       4 000 ms

Sem ele o yt-dlp resolve **cada vídeo da lista por inteiro** — 86 chaves e 33 formatos por
entrada. Uma busca de 20 resultados seriam 20 resoluções completas, para exibir título, duração e
miniatura. Com ele, é uma chamada, e a entrada já traz tudo que a grade precisa.

O preço é que a entrada não tem formatos — o que está certo: quem clica num resultado passa por
`/api/yt/abrir`, e é lá que a resolução cara acontece, uma vez, para o vídeo que a pessoa escolheu.

─── ⚠ A URL nua de um canal NÃO devolve vídeos ───────────────────────────────

Este é o achado que só aparece medindo, e o sintoma seria silencioso e ridículo:

    /@BlenderOfficial            3 entradas, todas `_type: 'playlist'`
                                 "Blender - Videos", "Blender - Shorts", …
    /@BlenderOfficial/videos     6 entradas, `_type: 'url'` — vídeos de verdade, e 700 ms
                                 contra 1 500 ms

A URL nua cai na página inicial do canal, que é uma lista de **abas**, não de vídeos. Sem
acrescentar `/videos`, a grade do canal mostraria três cartões chamados "Fulano - Videos",
"Fulano - Shorts" e "Fulano - Playlists" — cada um sem duração e sem miniatura, e nenhum abrindo
coisa alguma. Nada falharia.

E `_type` é a guarda que sobrevive à mudança: se um dia a aba `/videos` também trouxer seções,
`normalizar` as descarta em vez de fingir que são vídeos.
"""

import re
from dataclasses import dataclass, field
from typing import List, Optional

# ⚠ Quantos resultados pedir. Não é gosto: `playlistend` é o que impede uma playlist de 5 000
# vídeos — que existem — de virar uma resposta de dezenas de MB e uma grade que o navegador não
# desenha. A paginação de verdade é assunto de outro dia; o teto honesto é hoje.
POR_PAGINA = 30

# `_type` das entradas que são vídeo. O yt-dlp usa `url` para "um item que aponta para um vídeo" e
# `playlist` para "uma seção/aba/lista". Só o primeiro vira cartão.
_TIPO_DE_VIDEO = ("url", "video", None)

# ⚠ **`_type` NÃO basta, e isto foi medido em uso.** Uma busca por "lofi girl" traz o CANAL entre
# os resultados, e ele vem com `_type: 'url'` — exatamente como um vídeo. O que os separa é o
# extractor: `Youtube` é vídeo, `YoutubeTab` é canal, playlist ou aba.
#
# Sem esta guarda o canal virava um cartão, e o `id` dele — `UCSJ4gkVC6NrvII8umztf0Ow`, 24
# caracteres — ia parar na URL da miniatura, que respondia **400**. Na tela: um cartão sem capa,
# sem duração, que não abre nada. Nada falha.
_EXTRACTOR_DE_VIDEO = ("Youtube", None)

# O id de vídeo do YouTube: 11 caracteres de um alfabeto fechado. É a mesma conferência de
# `urls.py`, e ela está aqui como REDE DE SEGURANÇA da de cima — se o yt-dlp renomear `YoutubeTab`
# um dia, o formato do id continua sendo o que ele é.
_ID_DE_VIDEO = re.compile(r"^[A-Za-z0-9_-]{11}$")


@dataclass
class Item:
    id: str
    titulo: str
    duracao: Optional[float] = None
    canal: str = ""
    canal_id: Optional[str] = None
    miniatura: Optional[str] = None
    visualizacoes: Optional[int] = None
    ao_vivo: bool = False


@dataclass
class Listagem:
    tipo: str                                  # busca | playlist | canal
    titulo: str = ""
    canal: str = ""
    itens: List[Item] = field(default_factory=list)
    total: Optional[int] = None
    # Só existe em playlist: é o que permite "tocar a lista" e o próximo/anterior.
    lista: Optional[str] = None
    # Em que posição da lista esta página começa (1-based), e se vale pedir a próxima.
    de: int = 1
    tem_mais: bool = False


def url_de_listagem(alvo, ate=POR_PAGINA):
    """O `Alvo` de `urls.py` → o que pedir ao yt-dlp, ou `None` se não é listagem.

    ⚠ A busca vira `ytsearchN:` e não uma URL de `/results`: o extractor de busca do yt-dlp aceita
    o número de resultados na própria chave, e pedir a página de resultados devolveria a página
    inteira do YouTube para depois raspá-la.

    ⚠ E `ate` é o índice FINAL, não o tamanho da página — porque `ytsearchN` significa "busque N
    resultados", e não "pule para o N-ésimo". Para mostrar os itens 31 a 60 é preciso pedir
    `ytsearch60` e recortar com `playliststart`; pedir `ytsearch30` de novo devolveria os mesmos
    trinta primeiros. Canal e playlist não têm esse problema: a URL é a mesma e só o recorte muda.
    """
    if alvo is None:
        return None
    if alvo.tipo == "busca":
        termo = (alvo.termo or "").strip()
        return f"ytsearch{max(1, int(ate))}:{termo}" if termo else None
    if alvo.tipo == "playlist" and alvo.lista:
        return f"https://www.youtube.com/playlist?list={alvo.lista}"
    if alvo.tipo == "canal" and alvo.canal:
        nome = alvo.canal
        # As quatro formas que continuam circulando. `@handle` e o id `UC…` vão direto; `/c` e
        # `/user` também são caminhos de topo, e o yt-dlp resolve os dois.
        base = (f"https://www.youtube.com/{nome}" if nome.startswith("@")
                else f"https://www.youtube.com/channel/{nome}" if nome.startswith("UC")
                else f"https://www.youtube.com/c/{nome}")
        # ⚠ `/videos`, sempre. Ver o cabeçalho: a URL nua devolve as ABAS do canal.
        return f"{base}/videos"
    return None


# ⚠ **A miniatura tem URL canônica, e é o que torna o proxy dela SEM ESTADO.** Medido: para todos
# os vídeos que testei — inclusive o mais antigo do site, de 2005 — `mqdefault.jpg` responde 200,
# 320×180, ~16 KB. `hq720.jpg` e `maxresdefault.jpg` respondem **404** nos antigos, e são 4 a 10
# vezes maiores para um cartão de 180 px.
#
# A alternativa era guardar um cache de id → URL assinada só para servir imagens, que envelheceria
# junto com as credenciais e não caberia entre processos. Uma URL previsível dispensa a peça
# inteira: quem pede `api/yt/miniatura?v=<id>` recebe, e nada precisa ter listado aquele vídeo antes.
URL_DA_MINIATURA = "https://i.ytimg.com/vi/{}/mqdefault.jpg"


def _miniatura(entrada):
    """A miniatura mais próxima do tamanho de um cartão.

    ⚠ Nem a primeira nem a última. O yt-dlp ordena da pior para a melhor, e as listagens trazem de
    94 px a 404 px de altura: a primeira fica borrada num cartão de 180 px, e a última é o dobro do
    necessário — multiplicado por trinta cartões, é banda do servidor (as miniaturas passam pelo
    nosso proxy) para pixels que ninguém vê.
    """
    minis = [t for t in (entrada.get("thumbnails") or []) if t.get("url")]
    if not minis:
        return None
    comAltura = [t for t in minis if t.get("height")]
    if not comAltura:
        return minis[-1]["url"]
    return min(comAltura, key=lambda t: abs(int(t["height"]) - 180))["url"]


def _item(entrada):
    """Uma entrada do yt-dlp → `Item`, ou `None` se ela não é um vídeo."""
    if not isinstance(entrada, dict):
        return None
    if entrada.get("_type") not in _TIPO_DE_VIDEO:
        return None                                   # é uma aba/seção do canal, não um vídeo
    if entrada.get("ie_key") not in _EXTRACTOR_DE_VIDEO:
        return None                                   # é um canal ou playlist entre os resultados
    vid = entrada.get("id")
    if not vid or not _ID_DE_VIDEO.match(str(vid)):
        return None
    if not entrada.get("title"):
        # ⚠ Vídeo removido ou privado dentro de uma playlist: o yt-dlp devolve a entrada com o
        # título nulo. Um cartão sem nome não é clicável nem explicável — some, e a contagem no
        # cabeçalho (`total`) continua sendo a que o YouTube declarou, que é a verdade.
        return None
    dur = entrada.get("duration")
    return Item(
        id=str(vid),
        titulo=str(entrada.get("title")),
        duracao=float(dur) if isinstance(dur, (int, float)) else None,
        canal=entrada.get("channel") or entrada.get("uploader") or "",
        canal_id=entrada.get("channel_id"),
        miniatura=_miniatura(entrada),
        visualizacoes=entrada.get("view_count"),
        # `live_status` é `'is_live'` quando está no ar agora; `'was_live'` é gravação, e uma
        # gravação tem duração e busca normalíssimas.
        ao_vivo=entrada.get("live_status") == "is_live",
    )


def normalizar(info, tipo, lista=None, de=1, pedidos=None):
    """O `extract_info` plano → o que a grade desenha.

    ⚠ `tem_mais` é decidido pela contagem BRUTA de entradas, e não pela de itens aproveitados: uma
    página em que metade das entradas eram canais ou vídeos removidos ainda veio cheia, e parar ali
    esconderia o resto da lista. A pergunta é "o YouTube tinha mais para dar?", não "quantos
    couberam na grade?".
    """
    info = info if isinstance(info, dict) else {}
    brutas = [e for e in (info.get("entries") or []) if e is not None]
    itens = [i for i in (_item(e) for e in brutas) if i is not None]
    titulo = str(info.get("title") or "")
    if tipo == "canal":
        # O yt-dlp devolve "Blender - Videos" ao pedir a aba. O sufixo é dele, não do canal.
        titulo = info.get("channel") or titulo.removesuffix(" - Videos")
    return Listagem(
        tipo=tipo,
        titulo=titulo,
        canal=info.get("channel") or "",
        itens=itens,
        total=info.get("playlist_count"),
        lista=lista,
        de=max(1, int(de or 1)),
        tem_mais=bool(pedidos) and len(brutas) >= pedidos,
    )


def como_json(listagem):
    """O corpo que a rota devolve. Nomes em português, iguais aos do resto do app."""
    return {
        "tipo": listagem.tipo,
        "titulo": listagem.titulo,
        "canal": listagem.canal,
        "total": listagem.total,
        "lista": listagem.lista,
        "de": listagem.de,
        "temMais": listagem.tem_mais,
        "itens": [{
            "id": i.id, "titulo": i.titulo, "duracao": i.duracao, "canal": i.canal,
            "canalId": i.canal_id, "visualizacoes": i.visualizacoes, "aoVivo": i.ao_vivo,
            # ⚠ A miniatura vai pelo NOSSO proxy, e não como URL do `i.ytimg.com`. Duas razões: a
            # página não pode buscar de outra origem sem CORS, e todo byte que a pessoa recebe
            # atravessa o ambiente — que é a promessa do vssh, não um detalhe de implementação.
            "miniatura": f"api/yt/miniatura?v={i.id}" if i.miniatura else None,
        } for i in listagem.itens],
    }
