"""Como uma resposta de mídia é enquadrada — o `Range` do arquivo, e o `chunked` do cano.

    resolver(cabecalho, tamanho) -> Resposta(status, inicio, fim, comprimento, cabecalhos)
    enquadrar(dados)             -> um bloco `chunked`
    terminador(status, enviados) -> o fim do corpo, ou `b""` para deixá-lo INCOMPLETO

Sem Range não há busca: o `<video>` toca do começo e arrastar a linha do tempo baixa tudo de novo.
Com Range errado é pior, porque *parece* funcionar — o vídeo corrompe a partir do ponto em que a
pessoa buscou, e o sintoma não aponta para cá.

Três coisas que este arquivo existe para acertar, cada uma um erro clássico:

    `bytes=0-99` são CEM bytes         os dois extremos são inclusivos
    `bytes=-500` são os ÚLTIMOS 500    e não "a partir do byte -500"
    Range que não se entende           é IGNORADO (200), não recusado (416)

A terceira parece detalhe e não é: 416 afirma "o que você pediu não existe", que é uma afirmação
diferente de "não entendi o que você pediu" — e responder a segunda com a primeira manda o cliente
concluir a coisa errada sobre o arquivo.

Nada aqui abre socket nem lê disco. Entra um número e uma string; sai a resposta.
"""

import re
from dataclasses import dataclass, field
from typing import Dict

# Uma faixa só, e de propósito. Responder a várias exige `multipart/byteranges` — que nenhum
# `<video>` pede e que seria mecanismo sem consumidor. A norma permite ignorar o cabeçalho, e é o
# que fazemos: devolver o arquivo inteiro é sempre correto; devolver a primeira faixa fingindo ter
# atendido as duas, não.
_FAIXA = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$", re.I)


@dataclass
class Resposta:
    status: int                                          # 200 | 206 | 416
    inicio: int
    fim: int                                             # INCLUSIVO
    comprimento: int
    cabecalhos: Dict[str, str] = field(default_factory=dict)


def _tudo(tamanho):
    return Resposta(
        status=200, inicio=0, fim=max(0, tamanho - 1), comprimento=tamanho,
        # ⚠ `Accept-Ranges` na resposta de 200 é o ANÚNCIO de que a busca existe. Sem ele o
        # navegador nem tenta: assume que o servidor não sabe, e a linha do tempo vira decoração.
        cabecalhos={"Accept-Ranges": "bytes", "Content-Length": str(tamanho)},
    )


def _fora(tamanho):
    # ⚠ `Content-Range: bytes */N` é o que permite ao cliente se corrigir sozinho. Um 416 sem ele
    # deixa o player em laço: pede errado, leva 416, e não recebe o que precisaria para pedir certo.
    return Resposta(
        status=416, inicio=0, fim=0, comprimento=0,
        cabecalhos={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{tamanho}",
                    "Content-Length": "0"},
    )


def resolver(cabecalho, tamanho):
    """O `Range` da requisição contra o tamanho do arquivo."""
    tamanho = max(0, int(tamanho))
    if not cabecalho:
        return _tudo(tamanho)

    m = _FAIXA.match(str(cabecalho))
    if not m:
        return _tudo(tamanho)

    bruto_ini, bruto_fim = m.group(1), m.group(2)
    if not bruto_ini and not bruto_fim:
        return _tudo(tamanho)                       # `bytes=-`: não diz nada

    if not bruto_ini:
        # Sufixo: os ÚLTIMOS N bytes. É o que um MP4 não otimizado precisa, porque o índice
        # (`moov`) fica no fim do arquivo — ler isto como início negativo faz o vídeo não abrir,
        # e não abrir de um jeito que parece problema do arquivo.
        n = int(bruto_fim)
        if n == 0 or tamanho == 0:
            return _fora(tamanho)
        inicio = max(0, tamanho - n)
        fim = tamanho - 1
    else:
        inicio = int(bruto_ini)
        if inicio >= tamanho:
            return _fora(tamanho)
        # Fim ausente = até o fim do arquivo. Fim além do fim é APARADO: o navegador pede folga de
        # propósito ("a partir daqui, até 5 MB"), e recusar quebraria a leitura antecipada de todo
        # player.
        fim = tamanho - 1 if not bruto_fim else min(int(bruto_fim), tamanho - 1)
        if fim < inicio:
            # `bytes=99-50` é faixa inválida, e faixa inválida invalida o cabeçalho — que então se
            # ignora. Não é 416: não é que o pedido não caiba, é que ele não é um pedido.
            return _tudo(tamanho)

    comprimento = fim - inicio + 1                  # ⚠ o `+ 1`: os extremos são INCLUSIVOS
    return Resposta(
        status=206, inicio=inicio, fim=fim, comprimento=comprimento,
        cabecalhos={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {inicio}-{fim}/{tamanho}",
            "Content-Length": str(comprimento),
        },
    )


# ── O cano: o enquadramento `chunked`, e onde a falha vira sinal ─────────────
#
# ⚠ **Esta é a regra que um defeito medido escreveu**, e ela é contraintuitiva o bastante para morar
# num lugar com teste em vez de dentro de um `finally`.
#
# Um cano não tem `Content-Length`: quem diz onde o corpo acaba é o terminador `0\r\n\r\n`. Escrevê-lo
# sempre — que é o reflexo, e era o que estava aqui — significa que um ffmpeg morto no primeiro
# quadro produz um corpo **bem formado e curto**. Do lado do navegador isso é byte a byte igual a um
# filme que acabou: ele dispara `ended`, o player avança para o próximo arquivo, e a falha não tem
# por onde chegar à tela. Foi assim que um `.avi` quebrado apareceu como "tocou um quadro e voltou
# para o vídeo anterior" — um sintoma que não se parece com erro nenhum.
#
# Omitir o terminador é o canal que faltava: um corpo `chunked` incompleto é erro de rede para o
# navegador, `error` no `<video>`, e uma frase que a pessoa pode ler.

_TERMINADOR = b"0\r\n\r\n"


def enquadrar(dados):
    """Um bloco no enquadramento `chunked`. Bloco vazio não existe: ele É o terminador."""
    if not dados:
        return b""
    return b"%X\r\n" % len(dados) + bytes(dados) + b"\r\n"


def terminador(status, enviados):
    """O fim do corpo — ou `b""` quando a resposta tem de ficar incompleta de propósito.

    Duas condições, e a segunda não é redundante: um ffmpeg que sai com zero **sem escrever byte
    nenhum** também é falha. Ele acontece (entrada sem faixa mapeável, filtro que não casa), e um
    corpo vazio bem terminado é um vídeo de duração zero — que o navegador aceita em silêncio.
    """
    return _TERMINADOR if status == 0 and enviados > 0 else b""
