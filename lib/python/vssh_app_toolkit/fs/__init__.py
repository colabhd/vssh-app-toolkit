"""Filesystem privado de um vssh-app, exposto ao frontend por HTTP.

O par do `lib/node/vssh-app-fs/`. O contrato de wire é o MESMO — ver o README daquele diretório,
que vale para os dois runtimes: o frontend não sabe (nem deve saber) em que linguagem o backend
está escrito.

Quando usar esta lib e quando NÃO usar: ela serve o caso "store privado do app" — uma raiz
confinada, com token próprio, funcionando inclusive fora do desktop. Para dar ao app acesso aos
arquivos DO USUÁRIO (a home, com o seletor do desktop e o modelo de permissão da File System Access
API), o caminho é o `fsa-polyfill` de `lib/web/`, que fala com o `/api/fs/*` do portal — sem exigir
que o app rode filesystem nenhum.

    from vssh_app_toolkit.fs import criar_fs_do_app, criar_handler_fs

    arquivos = criar_fs_do_app(root="/home/fulano/.vssh-apps/meu-app/data/privado")
    servir_fs = criar_handler_fs(arquivos, mount_path="/api/privado",
                                 require_token=os.environ.get("VSSH_APP_TOKEN"))

    # no do_POST/do_GET:
    if servir_fs(self):
        return
"""

from .ops import (
    DIR_RECICLAGEM_PADRAO,
    EXTENSOES_DE_CONTEUDO_PADRAO,
    IGNORE_PADRAO,
    MAX_BYTES_DE_CONTEUDO_PADRAO,
    criar_fs_do_app,
)
from .http import criar_handler_fs, tipo_de_conteudo, token_confere
from .paths import EACCES, EEXIST, EINVAL, ENOENT, ErroFs

__all__ = [
    "criar_fs_do_app",
    "criar_handler_fs",
    "tipo_de_conteudo",
    # Comparação de token resistente a timing. Exportada porque o gate da lib já usava isto
    # enquanto a cola do app comparava com `!=` comum.
    "token_confere",
    "ErroFs",
    "ENOENT",
    "EACCES",
    "EINVAL",
    "EEXIST",
    "EXTENSOES_DE_CONTEUDO_PADRAO",
    "IGNORE_PADRAO",
    "DIR_RECICLAGEM_PADRAO",
    "MAX_BYTES_DE_CONTEUDO_PADRAO",
]
