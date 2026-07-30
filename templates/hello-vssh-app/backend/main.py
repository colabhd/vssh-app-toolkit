#!/usr/bin/env python3
"""Hello World — exemplo mínimo de vssh-app.

Prova o pipeline ponta a ponta: a janela abre, o iframe carrega este HTML
servido pelo próprio backend (proxied pelo portal), e o botão de ping faz um
round-trip via fetch() relativo até este mesmo processo. Zero dependências
externas (stdlib), como o xpra-fileserver do cliente Xpra.
"""

import json
import os
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = int(os.environ["VSSH_APP_PORT"])
APP_DIR = Path(__file__).resolve().parent.parent
FRONTEND_INDEX = APP_DIR / "frontend" / "index.html"


class Handler(BaseHTTPRequestHandler):
    server_version = "hello-vssh-app/1.0"

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._serve_index()
        elif self.path.startswith("/api/ping"):
            self._serve_ping()
        else:
            self.send_error(404, "Not found")

    def _serve_index(self):
        body = FRONTEND_INDEX.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_ping(self):
        payload = json.dumps({
            "pong": True,
            "user": os.environ.get("USER", "?"),
            "appId": os.environ.get("VSSH_APP_ID", "?"),
            "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # sem log próprio — ver skill sobre depurar via VSSH_APP_DATA_DIR


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[hello-world] escutando em 127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
