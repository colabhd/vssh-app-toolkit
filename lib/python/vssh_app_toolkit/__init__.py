"""Bibliotecas para o backend Python de um vssh-app.

O par do `lib/node/`, com as mesmas garantias e as mesmas armadilhas resolvidas. Cada peça é
importada por si:

    from vssh_app_toolkit.listen import criar_servidor
    from vssh_app_toolkit.log import criar_log_do_app
    from vssh_app_toolkit.spa import criar_spa_estatica
    from vssh_app_toolkit.sse import abrir_stream_sse
    from vssh_app_toolkit.notify import notificar
    from vssh_app_toolkit.live import definir_live, limpar_live
    from vssh_app_toolkit.tray import definir_bandeja, limpar_bandeja
    from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS, ESTILOS
    from vssh_app_toolkit.fs import criar_fs_do_app, criar_handler_fs

Não há um "importe o toolkit inteiro": são peças independentes, e um barrel obrigaria a carregar as
nove para usar uma. É a mesma decisão que o `package.json` do lado Node registra ao não ter uma
entrada `"."` em `exports`.

Nenhuma delas lê variável de ambiente por conta própria além do que o CONTRATO do vssh-app define
(`VSSH_APP_SOCKET`, `VSSH_APP_DATA_DIR`, `VSSH_APP_ID`, `HOME`) — e cada uma aceita `env` para que
um teste possa medir sem mexer no processo.
"""

# A versão é lida do pacote instalado, e não escrita aqui. Uma constante à mão é mais um lugar para
# esquecer de atualizar — e o número que importa é o do que foi INSTALADO, não o do que foi escrito.
try:  # pragma: no cover - caminho de instalação normal
    from importlib.metadata import version as _version

    __version__ = _version("vssh-app-toolkit")
except Exception:  # pragma: no cover - rodando do checkout, sem instalar
    __version__ = "0.0.0+local"

__all__ = ["__version__"]
