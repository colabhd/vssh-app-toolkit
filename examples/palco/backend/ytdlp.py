"""Onde o yt-dlp mora, e por que o lugar importa mais que o código.

    caminhos_de_busca(dados, vendor) -> [str]     a ORDEM, que é a decisão inteira
    carregar(...)                    -> módulo | None
    Mundo(...)                       -> `extrair` e `ler_cabecalho` para o `Resolvedor`

─── ⚠ O yt-dlp apodrece, e o plano assume isso desde o primeiro dia ──────────

O YouTube quebra extractor toda semana. Um `pip install` feito na instalação congela a versão, e a
consequência é que **o app funciona por um mês**: um dia alguém abre um vídeo e recebe "não
consegui ler este endereço", sem nada indicando que o conserto é atualizar uma dependência.

A saída não é código, é ordem de busca:

    1. $VSSH_APP_DATA_DIR/ytdlp     o único lugar gravável em execução — é aqui que a atualização cai
    2. ../vendor/py                 o que o `installCommand` deixou, e que só root pode reescrever

⚠ **Inverter os dois desliga a atualização sem nenhum sinal.** O botão diria "atualizado", o
diretório teria a versão nova, o `/healthz` reportaria a versão velha, e quem investigasse veria um
download bem-sucedido e um app que continua quebrado. É um defeito de uma linha e de diagnóstico
caro, e é por isso que a ordem tem teste próprio.

`$VSSH_APP_DATA_DIR` é o caminho certo pelo critério 3.2: ele sobrevive à troca de máquina, ao
contrário de OPFS, e é por usuário — o que aqui é aceitável porque um `pip install --target` do
yt-dlp são poucos MB, ao contrário do modelo de transcrição da Fase 6, que precisa ser por servidor.
"""

import importlib
import os
import subprocess
import sys
from urllib.request import Request, urlopen

# O `read()` de um response não garante os `n` bytes de uma vez — ele devolve o que chegou. Para 4
# KB isso quase nunca importa, e "quase nunca" é exatamente a frequência com que se descobre tarde:
# um cabeçalho truncado faz `ranges_do_cabecalho` devolver `None`, a trilha some do MPD, e a
# qualidade cai sem nada no log.
_TEMPO_LIMITE = 20


def caminhos_de_busca(dados, vendor):
    """Os diretórios onde procurar o yt-dlp, **na ordem em que devem ser procurados**.

    Função pura de propósito: é a única parte disto que dá para medir sem instalar nada, e é a
    parte que, errada, desliga a atualização em silêncio.
    """
    saida = []
    for d in (os.path.join(dados or "", "ytdlp") if dados else None, vendor):
        if d and os.path.isdir(d):
            caminho = os.path.abspath(d)
            if caminho not in saida:
                saida.append(caminho)
    return saida


def carregar(dados=None, vendor=None, caminhos=None, importar=None):
    """O módulo `yt_dlp`, ou `None` se ele não estiver em lugar nenhum.

    ⚠ Devolver `None` em vez de levantar é deliberado: sem yt-dlp o Palco continua sendo um player
    local completo, e derrubar o processo por causa de uma aba que talvez ninguém abra trocaria um
    recurso ausente por um app ausente.
    """
    for caminho in (caminhos if caminhos is not None else caminhos_de_busca(dados, vendor)):
        if caminho not in sys.path:
            sys.path.insert(0, caminho)
    try:
        return (importar or __import__)("yt_dlp")
    except ImportError:
        return None


def versao(modulo):
    """A versão, para o `/healthz` — é o que responde "por que parou de funcionar?"."""
    try:
        return modulo.version.__version__
    except AttributeError:
        return None


# ── O idioma, e a armadilha que ele esconde ──────────────────────────────────
#
# ⚠ **O yt-dlp fixa `hl: "en"` quando ninguém diz o contrário**, e a consequência não é uma interface
# em inglês: é o YouTube devolvendo o título TRADUZIDO. Medido, buscando "receita de bolo" do Brasil:
#
#     sem `lang`   "I MADE IT IN 4 MINUTES!! THE SIMPLEEST AND CHEAPEST CAKE"
#     lang=pt      "FIZ EM 4 MINUTOS!! O BOLO MAIS SIMPLES E BARATO DO MUNDO!"
#
# São os MESMOS vídeos, brasileiros, com o título passado por tradução automática. Quem busca em
# português recebe uma grade em inglês macarrônico e conclui que o app está procurando no lugar
# errado.
#
# ⚠ **E passar `navigator.language` direto QUEBRA TUDO.** A lista do YouTube não tem `pt-BR` — só
# `pt` (que é o português do Brasil) e `pt-PT`. Um código fora da lista faz o extractor levantar
# `Unsupported language code` em TODA chamada: a troca sairia de "títulos em inglês" para "nada
# funciona". A negociação não é polimento, é o que torna o recurso possível.
#
# A lista mora dentro do yt-dlp e muda com ele, então é lida de lá — e `()` quando o atributo sumir
# de lugar, o que devolve o comportamento de hoje em vez de um erro.

_CAMINHO_DOS_IDIOMAS = ("yt_dlp.extractor.youtube._base", "YoutubeBaseInfoExtractor",
                        "_SUPPORTED_LANG_CODES")


def idiomas_suportados(modulo=None, importar=None):
    """Os códigos que o YouTube aceita, lidos do yt-dlp instalado — ou `()` se não der para ler."""
    caminho, classe, atributo = _CAMINHO_DOS_IDIOMAS
    try:
        mod = (importar or importlib.import_module)(caminho)
        return tuple((getattr(getattr(mod, classe), atributo)) or ())
    except (ImportError, AttributeError, TypeError):
        return ()


def negociar_idioma(pedido, suportados):
    """`pt-BR` + a lista do YouTube → `pt`. `None` quando não há como honrar o pedido.

    ⚠ A comparação é **insensível a caixa** aqui e o valor devolvido vem da LISTA, porque o yt-dlp
    compara com `casesense=True`: aceitar `PT-br` de quem pede e repassá-lo cru trocaria um acerto
    por um `Unsupported language code`.

    `None` quer dizer "não mande `lang`" — o padrão do yt-dlp —, e é a resposta certa tanto para um
    pedido vazio quanto para um idioma que o YouTube não tem.
    """
    if not pedido or not suportados:
        return None
    tabela = {str(c).lower(): c for c in suportados if c}
    pedido = str(pedido).strip().lower()
    if pedido in tabela:
        return tabela[pedido]
    # `pt-BR` → `pt`, `en-US` → `en`. O contrário — subir de `pt` para `pt-PT` — NÃO se faz: o
    # YouTube trata `pt` como o do Brasil, e promover um pedido genérico ao primeiro específico da
    # lista entregaria Portugal a quem pediu português.
    base = pedido.split("-")[0]
    return tabela.get(base)


class Mundo:
    """As duas funções que o `Resolvedor` recebe por injeção, aqui implementadas de verdade."""

    def __init__(self, modulo, tempo_limite=_TEMPO_LIMITE, idioma=None):
        self._yt = modulo
        self._tempo = tempo_limite
        # Já NEGOCIADO por quem construiu — ver `negociar_idioma`. Um código cru vindo do navegador
        # levanta `Unsupported language code` em toda chamada, e este é o último lugar onde daria
        # para perceber isso.
        self._idioma = idioma or None

    def _comuns(self):
        opcoes = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "socket_timeout": self._tempo,
        }
        if self._idioma:
            opcoes["extractor_args"] = {"youtube": {"lang": [self._idioma]}}
        return opcoes

    def extrair(self, url, cliente=None):
        """Resolve um vídeo. `cliente` troca o player client do YouTube.

        ⚠ **O `cliente` existe para DIAGNOSTICAR, e não para insistir.** Medido num vídeo que a
        pessoa não conseguiu abrir: com os clientes padrão o YouTube responde "O vídeo não está
        disponível", que não diz nada e não sugere nada; com `player_client=tv` a mesma resolução
        responde **"This video is DRM protected"** — que é a resposta de verdade, e a única que
        permite dizer à pessoa que o vídeo não é remontável aqui e vai abrir no navegador.
        """
        opcoes = {
            **self._comuns(),
            # Sem isto o yt-dlp resolve a playlist inteira quando a URL traz `&list=` — dezenas de
            # chamadas de rede para abrir um vídeo. A fila é assunto de outra rota.
            "noplaylist": True,
        }
        if cliente:
            args = dict(opcoes.get("extractor_args") or {})
            args["youtube"] = {**(args.get("youtube") or {}), "player_client": [cliente]}
            opcoes["extractor_args"] = args
        with self._yt.YoutubeDL(opcoes) as ydl:
            return ydl.extract_info(url, download=False)

    def listar(self, url, de, ate):
        """Busca, playlist ou canal — **plano**, e com teto.

        ⚠ `extract_flat` é o que torna a aba possível, e não uma otimização. Sem ele o yt-dlp
        resolve cada vídeo da lista por inteiro: medido, 4 000 ms para 3 resultados contra 1 570 ms
        para 8 com ele. Uma busca de trinta seriam trinta resoluções completas — para exibir
        título, duração e miniatura.

        E `playlistend` não é cortesia: existem playlists de milhares de vídeos, e sem teto a
        resposta viraria dezenas de MB e uma grade que o navegador não desenha.

        ⚠ **A busca REPETE itens entre páginas, e a playlist não** — medido: pedindo 1–20 e 21–40 de
        `ytsearch60`, dois ids aparecem nas duas; numa playlist, zero. O ranking do YouTube não é
        determinístico entre chamadas, então quem consome PRECISA deduplicar por id. Não é
        capricho: sem isso, rolar uma busca mostra o mesmo vídeo duas vezes na grade.
        """
        opcoes = {
            **self._comuns(),
            "extract_flat": "in_playlist",
            # ⚠ Os dois, e 1-based: `playlistend` sozinho sempre devolveria do começo, e a segunda
            # página seria a primeira de novo.
            "playliststart": max(1, int(de)),
            "playlistend": max(1, int(ate)),
        }
        with self._yt.YoutubeDL(opcoes) as ydl:
            return ydl.extract_info(url, download=False)

    def ler_cabecalho(self, url, headers, n):
        """Os primeiros `n` bytes de uma URL assinada.

        ⚠ O laço existe porque `read(n)` devolve o que chegou, não o que foi pedido. Um cabeçalho
        curto faz `ranges_do_cabecalho` responder `None`, a trilha some do manifesto, e a qualidade
        cai sem uma linha no log dizendo por quê.
        """
        req = Request(url, headers={**(headers or {}), "Range": f"bytes=0-{n - 1}"})
        with urlopen(req, timeout=self._tempo) as r:
            pedacos = []
            lidos = 0
            while lidos < n:
                pedaco = r.read(n - lidos)
                if not pedaco:
                    break
                pedacos.append(pedaco)
                lidos += len(pedaco)
        return b"".join(pedacos)

    def abrir_faixa(self, url, headers, faixa=None):
        """Abre a URL para o proxy repassar. Devolve `(response, status)`.

        Quem fecha é quem chama — o corpo é um cano, e lê-lo inteiro na memória aqui derrotaria o
        propósito de repassar bytes.
        """
        cabs = dict(headers or {})
        if faixa:
            cabs["Range"] = faixa
        r = urlopen(Request(url, headers=cabs), timeout=self._tempo)
        return r, r.status

# ── A atualização, e ela acontece com o app DE PÉ ────────────────────────────
#
# É o que impede o Palco de funcionar por um mês e depois parar. O download é a parte fácil; o que
# decide se o botão vale alguma coisa é o que vem depois dele.
#
# ⚠ **Mexer no `sys.path` NÃO troca a versão — medido, e é o defeito inteiro.** Com o yt-dlp
# 2025.06.09 já importado e o 2026.07.04 recém-baixado à frente no caminho, um `import yt_dlp`
# continuou devolvendo `2025.06.09`: o `sys.modules` responde antes de o caminho ser consultado.
# O botão diria "atualizado", o disco teria a versão nova, e o app seguiria quebrado exatamente
# como antes — a pior forma possível deste recurso falhar.
#
# O que funciona, e foi medido no mesmo experimento: **apagar os 67 módulos `yt_dlp*` do
# `sys.modules` e importar de novo** devolve `2026.07.04` no mesmo processo, com o extractor do
# YouTube junto. E os objetos da versão velha continuam instanciáveis — quem estivesse no meio de
# uma resolução termina em vez de estourar.

_PACOTE = "yt-dlp"


def diretorio_de_atualizacao(dados):
    """Onde a versão nova cai — o mesmo lugar que `caminhos_de_busca` procura PRIMEIRO.

    Uma função, e não a expressão repetida nos dois lugares: se elas divergirem, o download é
    bem-sucedido, o `import` traz a versão velha, e nada no caminho diz que houve divergência.
    """
    return os.path.join(dados, "ytdlp") if dados else None


def _pip(destino):
    return [sys.executable, "-m", "pip", "install", "--upgrade", "--no-cache-dir",
            "--target", destino, _PACOTE]


def recarregar(importar=None):
    """Apaga o yt-dlp do `sys.modules` e importa de novo. Devolve o módulo, ou `None`."""
    for nome in [m for m in sys.modules if m == "yt_dlp" or m.startswith("yt_dlp.")]:
        del sys.modules[nome]
    importlib.invalidate_caches()
    try:
        return (importar or __import__)("yt_dlp")
    except ImportError:
        return None


def atualizar(dados, rodar=None, importar=None, tempo_limite=300):
    """Baixa o yt-dlp mais novo e o coloca em uso AGORA. Devolve `(modulo, detalhe)`.

    `detalhe` traz `versao` quando deu certo e `erro` quando não — e as duas coisas viajam juntas
    porque o caso interessante é o do meio: o download funciona e o import falha, e aí a versão em
    disco e a versão em uso são diferentes.
    """
    destino = diretorio_de_atualizacao(dados)
    if not destino:
        return None, {"erro": "este app não tem diretório de dados para gravar"}

    try:
        os.makedirs(destino, exist_ok=True)
    except OSError as e:
        return None, {"erro": f"não consegui criar {destino}: {e}"}

    rodar = rodar or (lambda argv: subprocess.run(
        argv, capture_output=True, text=True, timeout=tempo_limite, check=False))
    try:
        r = rodar(_pip(destino))
    except Exception as e:  # noqa: BLE001
        return None, {"erro": f"o pip não rodou: {e!r}"[:300]}

    if getattr(r, "returncode", 1) != 0:
        # A última linha do pip é a que diz o motivo; o resto é ruído de resolução de dependência.
        cauda = (getattr(r, "stderr", "") or getattr(r, "stdout", "") or "").strip().splitlines()
        return None, {"erro": (cauda[-1] if cauda else "o pip falhou sem dizer por quê")[:300]}

    # ⚠ O diretório precisa estar no caminho ANTES do reimport — ele pode não estar, porque
    # `caminhos_de_busca` só lista o que já existia quando o app subiu, e numa instalação nova este
    # diretório nasce agora.
    caminho = os.path.abspath(destino)
    if caminho not in sys.path:
        sys.path.insert(0, caminho)

    modulo = recarregar(importar)
    if modulo is None:
        return None, {"erro": "baixou, mas o import falhou — reabra o Palco"}
    return modulo, {"versao": versao(modulo)}
