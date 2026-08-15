"""As operações do filesystem privado, sem transporte.

O par do `lib/node/vssh-app-fs/ops.js`. Cada decisão aqui tem uma razão que já custou caro uma vez —
elas estão nos comentários, e não no histórico.
"""

from __future__ import annotations

import os
import shutil

from .paths import EINVAL, ErroFs, nao_encontrado, resolver_na_raiz, resolver_raiz

__all__ = ["criar_fs_do_app", "EXTENSOES_DE_CONTEUDO_PADRAO", "IGNORE_PADRAO",
           "DIR_RECICLAGEM_PADRAO", "MAX_BYTES_DE_CONTEUDO_PADRAO"]

EXTENSOES_DE_CONTEUDO_PADRAO = ["md", "org", "edn", "json", "txt", "csv"]

IGNORE_PADRAO = {
    "prefixes": [],
    "exact": [],
    "dirNames": ["node_modules", ".git"],
    "suffixes": [".DS_Store"],
    "hidden": True,  # qualquer componente começando com "." (mas não "..")
}

DIR_RECICLAGEM_PADRAO = ".recycle"
MAX_BYTES_DE_CONTEUDO_PADRAO = 16 * 1024 * 1024


def _ext(p):
    _, _, ext = p.rpartition(".")
    return ext.lower() if "." in p else ""


def _tem_componente_oculto(rel):
    return any(parte.startswith(".") and parte != ".." for parte in rel.split("/") if parte)


def _fazer_ignorador(ignore):
    cfg = dict(IGNORE_PADRAO)
    cfg.update(ignore or {})

    def ignorado(rel):
        p = rel.replace(os.sep, "/")
        partes = [x for x in p.split("/") if x]
        if any(p.startswith(x) for x in cfg["prefixes"]):
            return True
        if p in cfg["exact"]:
            return True
        if any(parte in cfg["dirNames"] for parte in partes):
            return True
        if any(p.endswith(x) for x in cfg["suffixes"]):
            return True
        return False

    ignorado.cfg = cfg
    return ignorado


def _info(st, caminho):
    return {
        "type": "directory" if os.path.isdir(caminho) else "file",
        "size": st.st_size,
        # Epoch em MILISSEGUNDOS, como o resto do contrato. Segundos aqui fariam toda comparação de
        # mtime com o frontend errar por três ordens de grandeza — e o sintoma seria "o arquivo
        # mudou" respondido sempre, ou nunca.
        "mtime": int(st.st_mtime * 1000),
    }


def criar_fs_do_app(root, content_extensions=None, ignore=None, recycle_dir=None,
                    max_content_bytes=None, ao_avisar=None):
    """Monta as operações confinadas a `root`."""
    raiz_real = resolver_raiz(root)
    extensoes = set(x.lower() for x in (content_extensions or EXTENSOES_DE_CONTEUDO_PADRAO))
    ignorado = _fazer_ignorador(ignore)
    ocultos_ignorados = ignorado.cfg["hidden"]
    dir_reciclagem = recycle_dir or DIR_RECICLAGEM_PADRAO
    max_conteudo = MAX_BYTES_DE_CONTEUDO_PADRAO if max_content_bytes is None else max_content_bytes
    avisar = ao_avisar or (lambda _e: None)

    def resolver(entrada):
        return resolver_na_raiz(raiz_real, entrada)

    def caminhar(inicio, aplicar_ignore=False):
        """Recursivo: descarta symlinks (um link para fora não vaza nem por leitura), devolve só
        arquivos, caminhos absolutos.

        Ocultos NÃO são descartados incondicionalmente — quem decide é sempre a config, senão
        `hidden: False` mentiria: o caminhamento já teria derrubado os ocultos antes da regra rodar.

        `aplicar_ignore` é opt-in porque as duas chamadoras querem coisas diferentes, e isso é
        deliberado: quem coleta conteúdo quer a visão filtrada, e quem lista quer a crua — filtrar
        lá esconderia do consumidor exatamente o que ele foi buscar.
        """
        saida = []
        fila = [inicio]
        while fila:
            diretorio = fila.pop()
            try:
                entradas = list(os.scandir(diretorio))
            except FileNotFoundError:
                continue
            for e in entradas:
                if e.is_symlink():
                    continue
                absoluto = os.path.join(diretorio, e.name)
                rel = os.path.relpath(absoluto, raiz_real).replace(os.sep, "/")
                if ocultos_ignorados and _tem_componente_oculto(rel):
                    continue
                if aplicar_ignore and ignorado(rel):
                    continue
                if e.is_dir():
                    fila.append(absoluto)
                else:
                    saida.append(absoluto)
        saida.sort()
        return saida

    def coletar(dir_abs):
        arquivos = []
        for absoluto in caminhar(dir_abs, aplicar_ignore=True):
            if _ext(absoluto) not in extensoes:
                continue
            try:
                st = os.stat(absoluto)
            except FileNotFoundError:
                continue  # corrida com escrita externa: só ignora
            if st.st_size > max_conteudo:
                # OMITIDO, e não listado com conteúdo vazio: um arquivo que o app não conhece fica
                # intocado, enquanto um listado como vazio é um arquivo vazio aos olhos dele — e o
                # primeiro save por cima apaga o conteúdo real no disco.
                avisar({"event": "file-skipped", "reason": "too-large", "path": absoluto,
                        "size": st.st_size, "limit": max_conteudo})
                continue
            with open(absoluto, "r", encoding="utf-8", errors="replace") as fh:
                conteudo = fh.read()
            info = _info(st, absoluto)
            arquivos.append({"path": absoluto, "content": conteudo, "size": info["size"],
                             "mtime": info["mtime"], "type": info["type"]})
        return arquivos

    class _Fs:
        root = raiz_real

        def stat(self, entrada):
            absoluto, _ = resolver(entrada)
            try:
                return _info(os.stat(absoluto), absoluto)
            except FileNotFoundError:
                raise nao_encontrado(entrada) from None

        def exists(self, entrada):
            """"Existe?" é pergunta booleana e merece resposta booleana.

            `stat` responde com erro quando não existe, e isso está certo — é a resposta correta
            para "me dê os metadados". Mas quem só quer saber se existe acaba usando o erro como
            fluxo de controle, e aí toda sondagem de rotina vira ruído de erro nos dois lados.
            Caminho FORA da raiz continua sendo EACCES: se existe ou não lá fora não é resposta que
            esta lib deva dar.
            """
            absoluto, _ = resolver(entrada)
            return {"exists": os.path.exists(absoluto)}

        def read_file(self, entrada):
            absoluto, _ = resolver(entrada)
            try:
                with open(absoluto, "r", encoding="utf-8", errors="replace") as fh:
                    return {"content": fh.read()}
            except FileNotFoundError:
                raise nao_encontrado(entrada) from None
            except IsADirectoryError:
                raise ErroFs(EINVAL, f"não é arquivo: {absoluto}") from None

        def write_file(self, entrada, conteudo):
            absoluto, _ = resolver(entrada)

            # Gravar por cima de um diretório nunca é o que o chamador quis: significa que o
            # caminho chegou errado. Sem esta checagem o open lança IsADirectoryError, que o
            # transporte não sabe classificar e devolve 500 — um pedido inválido do cliente
            # aparecendo como defeito do servidor.
            if os.path.isdir(absoluto):
                raise ErroFs(EINVAL, f"destino de escrita é um diretório: {absoluto}")
            if not isinstance(conteudo, (str, bytes, bytearray, memoryview)):
                raise ErroFs(EINVAL, f"conteúdo deve ser texto ou bytes, veio {type(conteudo).__name__}")

            os.makedirs(os.path.dirname(absoluto), exist_ok=True)
            if isinstance(conteudo, str):
                with open(absoluto, "w", encoding="utf-8") as fh:
                    fh.write(conteudo)
            else:
                with open(absoluto, "wb") as fh:
                    fh.write(bytes(conteudo))
            info = _info(os.stat(absoluto), absoluto)
            return {"path": absoluto, "size": info["size"], "mtime": info["mtime"]}

        def mkdir(self, entrada):
            absoluto, _ = resolver(entrada)
            try:
                os.mkdir(absoluto)
            except FileExistsError:
                pass  # diretório já existente não é erro — é o estado pedido
            return {}

        def mkdir_recur(self, entrada):
            absoluto, _ = resolver(entrada)
            os.makedirs(absoluto, exist_ok=True)
            return {}

        def readdir(self, entrada=None, aplicar_ignore=False):
            absoluto, _ = resolver(entrada or raiz_real)
            return caminhar(absoluto, aplicar_ignore=aplicar_ignore)

        def unlink(self, entrada, reciclar=True):
            """Por padrão NÃO apaga: move para a reciclagem com o caminho relativo achatado.

            `reciclar=False` apaga de verdade — para app que já tem lixeira própria, ou para o que
            é descartável por natureza (cache) e não deve inchar o diretório de reciclagem.
            """
            absoluto, rel = resolver(entrada)
            if not reciclar:
                try:
                    os.unlink(absoluto)
                except FileNotFoundError:
                    raise nao_encontrado(entrada) from None
                return {"recycled": None}

            reciclagem, _ = resolver(dir_reciclagem)
            os.makedirs(reciclagem, exist_ok=True)
            achatado = rel.replace(os.sep, "/").replace("/", "_")
            destino = os.path.join(reciclagem, achatado)
            try:
                os.replace(absoluto, destino)
            except FileNotFoundError:
                raise nao_encontrado(entrada) from None
            except OSError as err:
                if getattr(err, "errno", None) == 18:  # EXDEV: outro device (bind mount)
                    shutil.copyfile(absoluto, destino)
                    os.unlink(absoluto)
                else:
                    raise
            return {"recycled": destino}

        def rename(self, de, para):
            de_abs, _ = resolver(de)
            para_abs, _ = resolver(para)
            os.makedirs(os.path.dirname(para_abs), exist_ok=True)
            try:
                os.replace(de_abs, para_abs)
            except FileNotFoundError:
                raise nao_encontrado(de) from None
            return {}

        def copy(self, de, para):
            """Sobrescreve sem confirmação — o contrato de wire pede isso explicitamente."""
            de_abs, _ = resolver(de)
            para_abs, _ = resolver(para)
            os.makedirs(os.path.dirname(para_abs), exist_ok=True)
            try:
                shutil.copyfile(de_abs, para_abs)
            except FileNotFoundError:
                raise nao_encontrado(de) from None
            return {}

        def open_dir(self, entrada=None):
            absoluto, _ = resolver(entrada or raiz_real)
            if not os.path.exists(absoluto):
                raise nao_encontrado(entrada or raiz_real)
            if not os.path.isdir(absoluto):
                raise ErroFs(EINVAL, f"não é diretório: {absoluto}")
            return {"path": absoluto, "files": coletar(absoluto)}

        def get_files(self, entrada=None):
            return self.open_dir(entrada)

        def open_read(self, entrada):
            """Metadados + um abridor, para o transporte servir binário sem passar por JSON."""
            absoluto, _ = resolver(entrada)
            if not os.path.exists(absoluto) or os.path.isdir(absoluto):
                raise nao_encontrado(entrada)
            info = _info(os.stat(absoluto), absoluto)
            return {"path": absoluto, "size": info["size"], "mtime": info["mtime"],
                    "abrir": lambda: open(absoluto, "rb")}

    return _Fs()
