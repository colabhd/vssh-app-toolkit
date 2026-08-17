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

import os
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


class Mundo:
    """As duas funções que o `Resolvedor` recebe por injeção, aqui implementadas de verdade."""

    def __init__(self, modulo, tempo_limite=_TEMPO_LIMITE):
        self._yt = modulo
        self._tempo = tempo_limite

    def extrair(self, url):
        opcoes = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            # Sem isto o yt-dlp resolve a playlist inteira quando a URL traz `&list=` — dezenas de
            # chamadas de rede para abrir um vídeo. A fila é assunto de outra rota.
            "noplaylist": True,
            "socket_timeout": self._tempo,
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
