"""Resolução de caminho confinada a uma raiz. Toda entrada vinda do frontend passa por aqui.

O par do `lib/node/vssh-app-fs/paths.js`.

O modelo de ameaça não é "usuário malicioso" — o backend já roda como o próprio usuário Linux,
então ele não tem privilégio nenhum a proteger dele mesmo. O que isto evita é (a) um bug de path do
frontend transformar uma escrita de nota em escrita fora da raiz, e (b) um symlink dentro da raiz
virar caminho de escrita arbitrário para outro processo que fale com este socket.
"""

from __future__ import annotations

import os

__all__ = ["ErroFs", "ENOENT", "EACCES", "EINVAL", "EEXIST", "resolver_na_raiz", "resolver_raiz",
           "dentro_de", "nao_encontrado"]

# Erros com nome estável, para o adaptador de transporte mapear em status HTTP sem casar strings.
ENOENT = "ENOENT"
EACCES = "EACCES"
EINVAL = "EINVAL"
EEXIST = "EEXIST"


class ErroFs(Exception):
    def __init__(self, codigo, mensagem):
        super().__init__(mensagem)
        self.codigo = codigo
        self.mensagem = mensagem


def nao_encontrado(p):
    return ErroFs(ENOENT, f"não encontrado: {p}")


def _fora_da_raiz(p):
    return ErroFs(EACCES, f"caminho fora da raiz: {p}")


def _real_do_ancestral_existente(alvo):
    """`realpath` do ancestral existente mais próximo.

    Necessário porque se quer validar o destino de uma escrita cujo arquivo (e às vezes o
    diretório-pai) ainda não existe, e ao mesmo tempo resolver symlinks nos diretórios que existem.
    """
    atual = os.path.abspath(alvo)
    faltando = []
    while True:
        if os.path.lexists(atual):
            return os.path.realpath(atual), list(reversed(faltando))
        pai = os.path.dirname(atual)
        if pai == atual:
            # Chegou na raiz do filesystem sem encontrar nada que exista.
            return atual, list(reversed(faltando))
        faltando.append(os.path.basename(atual))
        atual = pai


def dentro_de(raiz, candidato):
    return candidato == raiz or candidato.startswith(raiz + os.sep)


def resolver_na_raiz(raiz_real, entrada):
    """Resolve um caminho recebido do cliente contra a raiz.

    Aceita relativo à raiz (`pages/foo.md`) e absoluto (`/home/x/raiz/pages/foo.md`) — as duas
    formas aparecem porque um app costuma usar o caminho absoluto como identidade.

    Devolve `(abs, rel)` com `abs` já resolvido e garantidamente dentro da raiz.
    """
    if not isinstance(entrada, str) or entrada == "":
        raise ErroFs(EINVAL, "caminho ausente")
    if "\0" in entrada:
        raise ErroFs(EINVAL, "caminho com byte nulo")

    junto = os.path.normpath(entrada) if os.path.isabs(entrada) else os.path.join(raiz_real, entrada)

    # Recusa antes mesmo de tocar o disco: pega o caso puramente lexical.
    if not dentro_de(raiz_real, os.path.normpath(junto)):
        raise _fora_da_raiz(entrada)

    real, faltando = _real_do_ancestral_existente(junto)
    # `real` é a parte que existe, com symlinks resolvidos. Se ela escapou da raiz, um symlink
    # dentro da raiz aponta para fora — recusa.
    if not dentro_de(raiz_real, real):
        raise _fora_da_raiz(entrada)

    absoluto = os.path.join(real, *faltando) if faltando else real
    if not dentro_de(raiz_real, absoluto):
        raise _fora_da_raiz(entrada)

    rel = "" if absoluto == raiz_real else os.path.relpath(absoluto, raiz_real)
    return absoluto, rel


def resolver_raiz(raiz):
    """A raiz precisa existir e ser resolvida UMA vez, no setup.

    Todas as comparações depois são contra o caminho já real — senão um symlink no meio da raiz
    derruba todas as checagens de prefixo.
    """
    if not isinstance(raiz, str) or raiz == "":
        raise ErroFs(EINVAL, "raiz ausente")
    os.makedirs(raiz, exist_ok=True)
    return os.path.realpath(raiz)
