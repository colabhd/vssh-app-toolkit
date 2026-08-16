"""De um endereço do YouTube para o que o Palco deve mostrar — ou para `None`.

`analisar(url)` devolve um `Alvo`, ou `None` quando o endereço não é nosso.

⚠ **`None` é o valor mais importante daqui, e não é um erro.** Ele quer dizer "devolva este link",
e quem chama devolve com `vssh.openUrl(url, {destino: 'navegador'})`. É o que impede o deeplink de
virar beco: no instante em que o Palco passa a receber os links do YouTube, todo endereço que ele
não souber montar vira uma tela de erro na frente de alguém que só clicou num link. Devolver é
honesto; adivinhar não é.

Nada aqui fala com a rede. O que a URL sabe, a URL responde; o resto (o vídeo existe? o canal
transmite agora?) é do resolvedor.
"""

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, unquote_plus, urlsplit

# O id de vídeo do YouTube: 11 caracteres de um alfabeto fechado (base64 url-safe).
#
# ⚠ Conferir a forma não é purismo. Sem isto, `youtu.be/robots.txt` vira "o vídeo robots.txt" e a
# pessoa recebe um erro do resolvedor em vez do site que ela pediu — o beco que este módulo existe
# para não produzir.
_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Os hosts que são nossos, e o casamento NÃO é por sufixo.
#
# ⚠ `'evilyoutube.com'.endswith('youtube.com')` é `True`. O `opens.urls` recusa esse engano no
# schema; recusá-lo aqui também é o que impede o app de fazer por dentro o que o manifesto impede
# por fora — e este módulo é o único ponto do backend que decide "é meu".
_HOSTS = {"youtube.com", "youtu.be", "youtube-nocookie.com"}
_SUB_OK = {"www", "m", "music"}

# Listas que só existem dentro de uma conta: pedi-las sem login devolve erro, não uma fila vazia.
_LISTAS_DA_CONTA = {"WL", "LL"}

# `/feed/...` é histórico, inscrições e afins — tudo atrás de autenticação Google. Montar uma casca
# vazia seria pior que devolver o link para quem consegue mostrá-lo.
_PREFIXOS_DE_CONTA = ("feed", "account", "playlist_history")


@dataclass
class Alvo:
    tipo: str                       # 'video' | 'playlist' | 'canal' | 'busca' | 'inicio'
    id: Optional[str] = None        # vídeo
    t: Optional[int] = None         # segundos em que começar
    lista: Optional[str] = None     # playlist, quando há uma
    indice: Optional[int] = None    # posição dentro da lista
    canal: Optional[str] = None     # '@handle', 'UC…', ou o nome de /c e /user
    termo: Optional[str] = None     # busca
    ao_vivo: bool = False           # o endereço já diz que é transmissão


def segundos_de(texto):
    """`90`, `90s`, `2m`, `1m30s`, `1h2m3s` → segundos. Torto → `None`.

    ⚠ Torto devolve `None` e não levanta: o `t` é secundário, e recusar o endereço inteiro por
    causa dele mandaria a pessoa para o navegador por um detalhe que ela nem vê.
    """
    if not texto:
        return None
    texto = str(texto).strip().lower()
    if texto.isdigit():
        return int(texto)
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", texto)
    if not m or not any(m.groups()):
        return None
    h, mi, s = (int(g or 0) for g in m.groups())
    return h * 3600 + mi * 60 + s


def _nosso(host):
    """O host é do YouTube — casando por rótulo, e nunca por sufixo."""
    host = (host or "").lower().rstrip(".")
    if host.startswith("www.") and host[4:] in _HOSTS:
        return True
    if host in _HOSTS:
        return True
    partes = host.split(".")
    return len(partes) > 2 and partes[0] in _SUB_OK and ".".join(partes[1:]) in _HOSTS


def _primeiro(q, chave):
    v = q.get(chave)
    return v[0] if v else None


def _lista_de(q):
    """A playlist do endereço, ou `None` quando ela não é uma playlist de verdade.

    ⚠ `RD…` é o rádio que o YouTube inventa a partir de um vídeo. Ele não existe como lista
    buscável e o yt-dlp responde erro — tratá-lo como fila daria um beco com cara de bug.
    `WL`/`LL` existem, mas são da conta de quem está logado, e nós não logamos.
    """
    lista = _primeiro(q, "list")
    if not lista or lista in _LISTAS_DA_CONTA or lista.startswith("RD"):
        return None
    return lista


def _inteiro(texto):
    try:
        return int(texto)
    except (TypeError, ValueError):
        return None


def _video(vid, q, ao_vivo=False):
    if not vid or not _ID.match(vid):
        return None
    return Alvo(
        tipo="video",
        id=vid,
        t=segundos_de(_primeiro(q, "t") or _primeiro(q, "start")),
        lista=_lista_de(q),
        indice=_inteiro(_primeiro(q, "index")),
        ao_vivo=ao_vivo,
    )


def analisar(url):
    """O endereço → um `Alvo`, ou `None` para "devolva este link"."""
    if not isinstance(url, str) or not url:
        return None
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not _nosso(p.hostname):
        return None

    q = parse_qs(p.query)
    partes = [seg for seg in p.path.split("/") if seg]

    # `youtu.be/<id>` — o id é o caminho, e o host inteiro existe só para isso.
    if (p.hostname or "").lower().rstrip(".").removeprefix("www.") == "youtu.be":
        return _video(partes[0], q) if partes else None

    if not partes:
        return Alvo(tipo="inicio")

    cabeca = partes[0]

    if cabeca in _PREFIXOS_DE_CONTA:
        return None

    if cabeca == "watch":
        return _video(_primeiro(q, "v"), q)

    # `/shorts` é enquadramento vertical e `/embed` é moldura de terceiro: os dois são o mesmo
    # vídeo, e o mesmo player toca.
    if cabeca in ("shorts", "embed", "v") and len(partes) > 1:
        return _video(partes[1], q)

    if cabeca == "live" and len(partes) > 1:
        return _video(partes[1], q, ao_vivo=True)

    if cabeca == "playlist":
        lista = _lista_de(q)
        return Alvo(tipo="playlist", lista=lista) if lista else None

    if cabeca == "results":
        termo = unquote_plus(_primeiro(q, "search_query") or _primeiro(q, "q") or "")
        # Busca sem termo não é erro nem beco: é a aba do YouTube, aberta.
        return Alvo(tipo="busca", termo=termo) if termo else Alvo(tipo="inicio")

    # ── Canal ────────────────────────────────────────────────────────────────
    #
    # Quatro formas por herança: `/user` é de 2005, `/c` de 2012, `/channel` carrega o id
    # verdadeiro e `/@handle` é de 2022. Todas continuam circulando — e é justamente o link antigo,
    # de um e-mail ou de um PDF, que chega por deeplink.
    nome = None
    if cabeca.startswith("@"):
        nome = cabeca
    elif cabeca in ("channel", "c", "user") and len(partes) > 1:
        nome = partes[1]
    if nome:
        # `/@fulano/live` não nomeia um vídeo: é "o que este canal transmite agora", e quem
        # responde isso é o resolvedor. A aba (`/videos`, `/streams`) é navegação dentro do canal.
        return Alvo(tipo="canal", canal=nome, ao_vivo=partes[-1] == "live" and len(partes) > 1)

    return None
