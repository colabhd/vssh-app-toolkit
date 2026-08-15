"""Onde moram as libs que o NAVEGADOR carrega — o shim do `vssh`, o polyfill da FSA.

O par do `lib/node/web-assets.js`, e a razão de existir é a mesma: as libs de `lib/web/` chegam ao
navegador por uma tag `<script>`, e alguém tem de SERVI-LAS sob a raiz que o app publica. Elas
moram dentro do pacote instalado, fora da raiz do frontend por construção — e quem as põe numa URL
é o `mounts` do `criar_spa_estatica`:

    from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS
    from vssh_app_toolkit.spa import criar_spa_estatica

    spa = criar_spa_estatica(
        root="frontend",
        mounts={"/_vssh/": DIRETORIO_WEB},
        inject_scripts=[f"_vssh/{s}" for s in SHIMS],
    )

**O ponto que não é óbvio:** estas libs NÃO têm versão Python, e não precisam ter. Elas rodam no
navegador — o mesmo shim, o mesmo polyfill, servidos ao mesmo navegador. O que muda entre um app
Node e um app Python é só quem os SERVE. Um app Python com o `vssh` completo é, portanto, uma
questão de montar o diretório certo, e não de portar 2.200 linhas de JavaScript.

A ORDEM de `SHIMS` importa e é por isso que ela é dada aqui, e não deixada para cada app relembrar:
o `fsa-polyfill` decide o que instalar olhando o `vssh` já presente, e um app que carregue os dois
na ordem inversa fica sem `showOpenFilePicker` — sem erro nenhum, só sem a função.
"""

from __future__ import annotations

import os

__all__ = ["DIRETORIO_WEB", "SHIMS"]

_AQUI = os.path.dirname(os.path.abspath(__file__))
# Instalado: os `.js` viajam DENTRO do pacote, postos ali pelo `force-include` do pyproject.
_EMBUTIDO = os.path.join(_AQUI, "web")
# Rodando do checkout (o `python3 backend/main.py` de quem desenvolve o toolkit, e a bancada de
# testes): o wheel não foi construído, então o diretório acima não existe e a fonte é `lib/web/`.
# Sem este ramo, desenvolver contra o repositório serviria 404 em todo shim — e a mensagem seria a
# ausência do `vssh` no navegador, que não aponta para cá.
_NO_CHECKOUT = os.path.normpath(os.path.join(_AQUI, "..", "..", "web"))

#: Diretório das libs de navegador deste pacote.
DIRETORIO_WEB = _EMBUTIDO if os.path.isdir(_EMBUTIDO) else _NO_CHECKOUT

#: Os dois que quase todo app quer, na ordem em que têm de ser carregados.
SHIMS = ["vssh-app-shim.js", "fsa-polyfill.js"]
