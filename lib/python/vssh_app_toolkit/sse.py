"""Server-Sent Events que sobrevivem ao proxy do portal e ao CDN na frente dele.

O par do `lib/node/sse.js`. Existe porque a receita não é óbvia e o modo de falhar é cruel: sem os
cabeçalhos certos, os eventos ficam presos num buffer em algum ponto do caminho e só aparecem em
lote — ou nunca. O app parece "não receber nada", e não há erro em lugar nenhum.

`X-Accel-Buffering: no` é o que impede a bufferização na borda, e é o mesmo cabeçalho que o portal
usa nas rotas SSE dele.

── O que muda em relação ao Node ──

O `http.server` da stdlib serve UMA requisição por thread e só devolve a conexão ao fechar o
handler. Um stream SSE, portanto, **segura a thread daquela requisição** — o que é correto e é
exatamente o que se quer, mas obriga o servidor a ser threading (é o que `criar_servidor` entrega).

E o cliente que fecha a aba não avisa: o socket simplesmente some. Por isso toda escrita é
protegida e marca `fechado` em vez de levantar — um `BrokenPipeError` estourando dentro de um
`for` de difusão derrubaria o envio para as OUTRAS janelas, que é o oposto do que se quer.
"""

from __future__ import annotations

import json
import threading
import time

__all__ = ["abrir_stream_sse", "StreamSse"]


class StreamSse:
    """Um stream SSE aberto sobre um `BaseHTTPRequestHandler`."""

    def __init__(self, handler, retry_ms=None, keep_alive_ms=15000):
        self._handler = handler
        self._tranca = threading.Lock()
        self.fechado = False

        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "keep-alive")
        # Sem isto, a borda (nginx/CDN) segura os eventos até fechar um buffer.
        handler.send_header("X-Accel-Buffering", "no")
        handler.end_headers()
        # Sem o flush, o cliente fica esperando o primeiro byte — e o `EventSource` do navegador
        # nem dispara o `onopen`.
        self._descarregar()

        if retry_ms:
            self._escrever(f"retry: {int(retry_ms)}\n\n")

        # Proxy e balanceador derrubam conexão ociosa. O comentário periódico é tráfego suficiente
        # para isso não acontecer, e o cliente o ignora. `daemon` porque um keep-alive não pode ser
        # o motivo de o processo não encerrar.
        self._timer = None
        if keep_alive_ms and keep_alive_ms > 0:
            self._intervalo = keep_alive_ms / 1000.0
            self._agendar()

    # ── interno ──────────────────────────────────────────────────────────────

    def _descarregar(self):
        try:
            self._handler.wfile.flush()
        except OSError:
            self.fechado = True

    def _escrever(self, texto):
        if self.fechado:
            return False
        with self._tranca:
            if self.fechado:
                return False
            try:
                self._handler.wfile.write(texto.encode("utf-8"))
                self._handler.wfile.flush()
                return True
            except OSError:
                # O cliente sumiu. Marcar e seguir: quem difunde para N janelas não pode perder as
                # outras porque uma fechou a aba.
                self.fechado = True
                return False

    def _agendar(self):
        if self.fechado:
            return
        self._timer = threading.Timer(self._intervalo, self._bater)
        self._timer.daemon = True
        self._timer.start()

    def _bater(self):
        if self.fechado:
            return
        self.comentar()
        self._agendar()

    # ── superfície ───────────────────────────────────────────────────────────

    def enviar(self, evento, dados):
        """Um evento nomeado. `dados` vira JSON, a menos que já seja texto.

        `separators` compactos, e não o padrão do `json.dumps`: é o que o `JSON.stringify` do lado
        Node produz, e um evento SSE é uma LINHA — os espaços do padrão do Python entrariam no
        wire. Sem isto, o mesmo app emite bytes diferentes conforme o runtime, e quem escreve um
        teste de ponta a ponta (ou um `grep` num stream) descobre isso da pior forma.
        """
        carga = (dados if isinstance(dados, str)
                 else json.dumps(dados, ensure_ascii=False, default=str, separators=(",", ":")))
        return self._escrever(f"event: {evento}\ndata: {carga}\n\n")

    def comentar(self, texto=None):
        """Comentário SSE: não vira evento no cliente, serve para manter a conexão viva."""
        return self._escrever(f": {texto or 'keep-alive'}\n\n")

    def fechar(self):
        if self.fechado:
            return
        self.fechado = True
        if self._timer:
            self._timer.cancel()

    def esperar_fechar(self, intervalo=0.5):
        """Segura a thread da requisição enquanto o cliente estiver conectado.

        É o que falta para o `do_GET` não retornar — e retornar FECHA a conexão na hora. Sem isto,
        um stream SSE em Python "abre e fecha imediatamente", e o sintoma no navegador é um
        `EventSource` reconectando em laço, sem um erro sequer do lado do servidor.

        Quem descobre que o cliente sumiu é o keep-alive: a escrita dele falha e marca `fechado`.
        Por isso este laço só DORME — mandar o próprio comentário aqui dobraria o tráfego para
        medir a mesma coisa duas vezes.
        """
        while not self.fechado:
            time.sleep(intervalo)


def abrir_stream_sse(handler, retry_ms=None, keep_alive_ms=15000):
    """Abre um stream SSE sobre um `BaseHTTPRequestHandler`."""
    return StreamSse(handler, retry_ms=retry_ms, keep_alive_ms=keep_alive_ms)
