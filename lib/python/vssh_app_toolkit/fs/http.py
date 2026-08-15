"""O adaptador do contrato de wire para o `http.server` da stdlib.

O par do `lib/node/vssh-app-fs/http.js`. O contrato é o MESMO — um RPC JSON num POST, mais uma rota
de binário com `Range` — porque o frontend é o mesmo em qualquer runtime. Um app que trocasse o
backend de Node para Python não deveria precisar tocar numa linha do próprio JavaScript.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from email.utils import formatdate
from urllib.parse import unquote, urlsplit, parse_qs

from .paths import EACCES, EINVAL, ENOENT, ErroFs

__all__ = ["criar_handler_fs", "tipo_de_conteudo", "token_confere", "MAX_BYTES_DE_CORPO_PADRAO"]

MAX_BYTES_DE_CORPO_PADRAO = 64 * 1024 * 1024

# Mapa de conteúdo de DADOS do app (o que o usuário guarda), e não de bundle web — este é o irmão
# do mapa do `spa.py`, e eles são separados de propósito: as duas peças são independentes.
_TIPOS = {
    "md": "text/markdown; charset=utf-8", "txt": "text/plain; charset=utf-8",
    "json": "application/json; charset=utf-8", "edn": "application/edn; charset=utf-8",
    "org": "text/plain; charset=utf-8", "csv": "text/csv; charset=utf-8",
    "html": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "svg": "image/svg+xml", "ico": "image/x-icon", "bmp": "image/bmp",
    "pdf": "application/pdf",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4",
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "zip": "application/zip",
}

_STATUS = {ENOENT: 404, EACCES: 403, EINVAL: 400, "EEXIST": 409, "EMETHOD": 405}


def tipo_de_conteudo(caminho):
    _, _, ext = caminho.rpartition(".")
    return _TIPOS.get(ext.lower(), "application/octet-stream")


def token_confere(esperado, recebido):
    """Comparação resistente a timing.

    Hash dos dois lados antes de comparar: sem isso, o tempo de resposta vaza o PREFIXO acertado, e
    comprimentos diferentes vazam o tamanho. É exportada porque o gate da lib já fazia isto
    enquanto a cola de cada app comparava com `!=` — lib rigorosa não adianta se quem a monta não
    for.
    """
    if not isinstance(recebido, str) or recebido == "":
        return False
    a = hashlib.sha256(esperado.encode("utf-8")).digest()
    b = hashlib.sha256(recebido.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def _mandar_json(handler, status, corpo):
    dados = json.dumps(corpo, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(dados)))
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(dados)


def _mandar_erro(handler, err, op=None):
    codigo = getattr(err, "codigo", None) or "EINTERNAL"
    # 500 é reservado para o que é DEFEITO NOSSO. Um caminho que não existe, um pedido malformado
    # ou um acesso negado são respostas corretas a pedidos errados — e chamá-los de 500 faz o
    # monitoramento acordar alguém por um clique num arquivo apagado.
    status = _STATUS.get(codigo, 500)
    corpo = {"ok": False, "error": {"code": codigo, "message": str(err)}}
    if op:
        corpo["error"]["op"] = op
    _mandar_json(handler, status, corpo)


def _ler_corpo(handler, maximo):
    tamanho = int(handler.headers.get("Content-Length") or 0)
    if tamanho > maximo:
        raise ErroFs(EINVAL, f"corpo maior que o teto ({tamanho} > {maximo})")
    return handler.rfile.read(tamanho) if tamanho else b""


def criar_handler_fs(fs, mount_path="/api/fs", assets_prefix="/assets/", require_token=None,
                     max_body_bytes=None, ao_avisar=None):
    """Devolve `servir(handler) -> bool`. `True` quer dizer que a requisição foi atendida."""
    maximo = MAX_BYTES_DE_CORPO_PADRAO if max_body_bytes is None else max_body_bytes
    avisar = ao_avisar or (lambda _e: None)

    OPS = {
        "exists": lambda p: fs.exists(p.get("path")),
        "stat": lambda p: fs.stat(p.get("path")),
        "read-file": lambda p: fs.read_file(p.get("path")),
        "write-file": lambda p: fs.write_file(p.get("path"), p.get("content") or ""),
        "mkdir": lambda p: fs.mkdir(p.get("path") or p.get("dir")),
        "mkdir-recur": lambda p: fs.mkdir_recur(p.get("path") or p.get("dir")),
        "readdir": lambda p: fs.readdir(p.get("path") or p.get("dir"),
                                        aplicar_ignore=bool(p.get("applyIgnore"))),
        "unlink": lambda p: fs.unlink(p.get("path"), reciclar=p.get("recycle") is not False),
        "rename": lambda p: fs.rename(p.get("from") or p.get("old"), p.get("to") or p.get("new")),
        "copy": lambda p: fs.copy(p.get("from") or p.get("old"), p.get("to") or p.get("new")),
        "open-dir": lambda p: fs.open_dir(p.get("path") or p.get("dir")),
        "get-files": lambda p: fs.get_files(p.get("path") or p.get("dir")),
    }

    def _rpc(handler):
        if handler.command != "POST":
            _mandar_json(handler, 405, {"ok": False, "error": {"code": "EMETHOD", "message": "use POST"}})
            return
        try:
            carga = json.loads(_ler_corpo(handler, maximo).decode("utf-8") or "{}")
        except ErroFs as err:
            _mandar_erro(handler, err)
            return
        except (ValueError, UnicodeDecodeError) as err:
            _mandar_erro(handler, ErroFs(EINVAL, f"corpo não é JSON: {err}"))
            return

        op = OPS.get(carga.get("op")) if isinstance(carga, dict) else None
        if not op:
            nome = carga.get("op") if isinstance(carga, dict) else None
            _mandar_json(handler, 400, {"ok": False,
                                        "error": {"code": EINVAL, "message": f"op desconhecida: {nome}"}})
            return
        try:
            _mandar_json(handler, 200, {"ok": True, "result": op(carga)})
        except ErroFs as err:
            avisar({"event": "op-failed", "op": carga.get("op"), "path": carga.get("path"),
                    "code": err.codigo, "message": str(err)})
            _mandar_erro(handler, err, carga.get("op"))
        except OSError as err:
            avisar({"event": "op-failed", "op": carga.get("op"), "path": carga.get("path"),
                    "message": str(err)})
            _mandar_erro(handler, err, carga.get("op"))

    def _escrever_binario(handler, consulta):
        if handler.command not in ("POST", "PUT"):
            _mandar_json(handler, 405, {"ok": False, "error": {"code": "EMETHOD", "message": "use POST"}})
            return
        alvo = (parse_qs(consulta).get("path") or [None])[0]
        try:
            corpo = _ler_corpo(handler, maximo)
            _mandar_json(handler, 200, {"ok": True, "result": fs.write_file(alvo, corpo)})
        except (ErroFs, OSError) as err:
            avisar({"event": "write-binary-failed", "path": alvo, "message": str(err)})
            _mandar_erro(handler, err, "write-binary")

    def _asset(handler, relativo):
        if handler.command not in ("GET", "HEAD"):
            _mandar_json(handler, 405, {"ok": False, "error": {"code": "EMETHOD", "message": "use GET"}})
            return
        try:
            decodificado = unquote(relativo, errors="strict")
        except (UnicodeDecodeError, ValueError):
            _mandar_erro(handler, ErroFs(EINVAL, f"caminho de asset inválido: {relativo}"))
            return

        try:
            arquivo = fs.open_read(decodificado)
        except (ErroFs, OSError) as err:
            _mandar_erro(handler, err)
            return

        ultima = formatdate(arquivo["mtime"] / 1000.0, usegmt=True)
        faixa_pedida = handler.headers.get("Range")

        if handler.headers.get("If-Modified-Since") == ultima and not faixa_pedida:
            handler.send_response(304)
            handler.send_header("Last-Modified", ultima)
            handler.send_header("Cache-Control", "no-cache")
            handler.end_headers()
            return

        tamanho = arquivo["size"]
        inicio, fim = 0, tamanho - 1
        parcial = False

        # Range de UM intervalo só — é o que um leitor de PDF ou um `<video>` usa para não baixar o
        # arquivo inteiro. Multipart não vale o custo aqui, e nenhum cliente do ambiente o pede.
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", faixa_pedida or "")
        if m and tamanho > 0:
            cru_inicio, cru_fim = m.group(1), m.group(2)
            try:
                if cru_inicio == "":
                    inicio = tamanho - int(cru_fim)
                    fim = tamanho - 1
                else:
                    inicio = int(cru_inicio)
                    fim = int(cru_fim) if cru_fim else tamanho - 1
            except ValueError:
                inicio, fim = 0, -1
            inicio = max(0, inicio)
            fim = min(tamanho - 1, fim)
            if inicio > fim:
                handler.send_response(416)
                handler.send_header("Content-Range", f"bytes */{tamanho}")
                handler.end_headers()
                return
            parcial = True

        comprimento = fim - inicio + 1 if tamanho else 0
        handler.send_response(206 if parcial else 200)
        handler.send_header("Content-Type", tipo_de_conteudo(arquivo["path"]))
        handler.send_header("Last-Modified", ultima)
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Accept-Ranges", "bytes")
        if parcial:
            handler.send_header("Content-Range", f"bytes {inicio}-{fim}/{tamanho}")
        handler.send_header("Content-Length", str(comprimento))
        handler.end_headers()
        if handler.command == "HEAD":
            return
        with arquivo["abrir"]() as fh:
            fh.seek(inicio)
            restante = comprimento
            while restante > 0:
                pedaco = fh.read(min(64 * 1024, restante))
                if not pedaco:
                    break
                handler.wfile.write(pedaco)
                restante -= len(pedaco)

    def servir(handler):
        partes = urlsplit(handler.path)
        caminho = partes.path
        e_rpc = caminho == mount_path
        e_binario = caminho == mount_path + "/write-binary"
        e_asset = caminho.startswith(assets_prefix)
        if not (e_rpc or e_binario or e_asset):
            return False

        if require_token and not token_confere(require_token, handler.headers.get("X-Vssh-App-Token")):
            # Requisição que não veio pelo proxy autenticado do portal. O socket é 0600 do dono,
            # mas outro processo do MESMO usuário Linux o alcança — e este handler dá acesso a
            # arquivos.
            avisar({"event": "token-rejected", "pathname": caminho})
            _mandar_json(handler, 403, {"ok": False,
                                        "error": {"code": EACCES, "message": "token ausente ou inválido"}})
            return True

        if e_rpc:
            _rpc(handler)
        elif e_binario:
            _escrever_binario(handler, partes.query)
        else:
            _asset(handler, caminho[len(assets_prefix):])
        return True

    return servir
