"""Os irmãos de pasta — o que faz "próximo" e "anterior" existirem.

Um player sem próximo não toca uma série nem um álbum: a pessoa volta ao gerenciador de arquivos a
cada faixa, que é exatamente o trabalho que o programa deveria absorver.

A parte que apodrece — listar diretório — fica no chamador. Aqui entra uma lista de nomes e sai a
ordem.
"""

import re

#: O que o Palco se propõe a abrir. ⚠ Esta lista e `opens.extensions` no manifesto são a MESMA
#: verdade escrita duas vezes: se divergirem, o ambiente oferece o Palco para um arquivo que ele
#: recusa — e quem clicou vê uma janela abrir e não tocar nada.
EXTENSOES = {
    ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".ts", ".mpg", ".mpeg", ".ogv",
    ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac", ".wma", ".mka",
}

_PEDACOS = re.compile(r"(\d+)")


def chave_natural(nome):
    """A ordem em que uma pessoa põe os arquivos, e não a ordem do byte.

    ⚠ Alfabética crua ordena `ep10` **antes** de `ep2`, porque compara `1` com `2`. Numa série isso
    põe o episódio 10 no meio da primeira metade da temporada, e o "próximo" passa a pular — um
    defeito que parece aleatório e que ninguém liga a uma função de ordenação.
    """
    return [int(p) if p.isdigit() else p.lower() for p in _PEDACOS.split(nome)]


def em_ordem(nomes):
    """Só os que o Palco abre, na ordem natural."""
    return sorted((n for n in nomes if extensao_serve(n)), key=chave_natural)


def extensao_serve(nome):
    ponto = nome.rfind(".")
    return ponto > 0 and nome[ponto:].lower() in EXTENSOES


def vizinhanca(nomes, atual):
    """`(lista_em_ordem, indice_do_atual)`.

    ⚠ O atual entra na lista mesmo que a extensão dele não esteja em `EXTENSOES`: o ambiente pode
    ter mandado abrir um arquivo por MIME, ou a pessoa pode ter escolhido "abrir com". Sumir com o
    arquivo que está tocando da própria lista é pior do que ter um item a mais.
    """
    lista = em_ordem(nomes)
    if atual and atual not in lista:
        lista = sorted([*lista, atual], key=chave_natural)
    return lista, (lista.index(atual) if atual in lista else -1)
