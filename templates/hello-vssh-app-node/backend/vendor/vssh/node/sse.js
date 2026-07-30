'use strict';

// sse — Server-Sent Events que sobrevivem ao proxy do portal e ao CDN na frente dele.
//
// Existe porque a receita não é óbvia e o modo de falhar é cruel: sem os headers certos, os
// eventos ficam presos num buffer em algum ponto do caminho e só aparecem em lote (ou nunca). O
// app parece simplesmente "não receber nada", e não há erro em lugar nenhum para investigar.
//
// Os headers abaixo são os mesmos que o portal já usa em produção nas suas próprias rotas SSE
// (`/api/fs/jobs/:id` e `/api/fs/fetch-url` em src/routes/system.ts) — em especial
// `X-Accel-Buffering: no`, que é o que impede a bufferização na borda.
//
// Quando NÃO usar: se você só precisa empurrar evento e o app já tem WebSocket, use o WS. O proxy
// do portal encaminha upgrade de WebSocket sem configuração nenhuma, e isso é garantido.

/**
 * Abre um stream SSE numa resposta node:http.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {object} [options]
 * @param {number} [options.retryMs] dica de reconexão para o EventSource do navegador
 * @param {number} [options.keepAliveMs] intervalo do comentário de keep-alive (0 desliga)
 * @returns {{ send: (event: string, data: any) => void, comment: (t: string) => void, close: () => void, closed: boolean }}
 */
function openSseStream(res, options = {}) {
  const keepAliveMs = options.keepAliveMs ?? 15000;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Sem isto, a borda (nginx/CDN) segura os eventos até fechar um buffer.
    'X-Accel-Buffering': 'no',
  });
  // Manda os headers na hora: sem flush, o cliente fica esperando o primeiro byte.
  res.flushHeaders?.();

  const stream = {
    closed: false,

    send(event, data) {
      if (stream.closed) return;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
    },

    // Comentário SSE: não vira evento no cliente, serve para manter a conexão viva.
    comment(text) {
      if (stream.closed) return;
      res.write(`: ${text || 'keep-alive'}\n\n`);
    },

    close() {
      if (stream.closed) return;
      stream.closed = true;
      clearInterval(timer);
      res.end();
    },
  };

  if (options.retryMs) res.write(`retry: ${options.retryMs}\n\n`);

  // Proxy e balanceador costumam derrubar conexão ociosa. O comentário periódico é tráfego
  // suficiente para isso não acontecer, e o cliente o ignora.
  const timer = keepAliveMs > 0 ? setInterval(() => stream.comment(), keepAliveMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  // Cliente que fecha a aba não avisa educadamente: o socket simplesmente some.
  res.on('close', () => {
    stream.closed = true;
    clearInterval(timer);
  });

  return stream;
}

module.exports = { openSseStream };
