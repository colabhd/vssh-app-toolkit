'use strict';

// Hello World (Node) — template de partida para um vssh-app com backend Node.
//
// Zero dependência npm: só a stdlib do Node e as libs do toolkit vendorizadas em
// `backend/vendor/vssh/` (ressincronize com `vssh-app-lib-sync`). O servidor-alvo pode não ter
// acesso a registry npm num exec não-interativo por SSH, então o que está commitado é o que roda.
//
// O que este template já faz por você, e que a primeira versão de todo app esquece:
//   - log estruturado em $VSSH_APP_DATA_DIR desde a primeira linha (é o que salva a depuração
//     remota: frame minificado sustenta hipótese, log do backend nomeia op e caminho);
//   - checagem do X-Vssh-App-Token, timing-safe;
//   - healthcheck que responde sem depender de nada estar pronto;
//   - um endpoint SSE com os headers que sobrevivem ao proxy e ao CDN.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const { createStaticSpa } = require('./vendor/vssh/node/static-spa');
const { createAppLog } = require('./vendor/vssh/node/app-log');
const { openSseStream } = require('./vendor/vssh/node/sse');

// KeyError proposital se ausente: sem porta não há o que servir, e falhar alto no boot é melhor
// que subir num lugar onde o proxy nunca vai encontrar.
const PORT = Number(process.env.VSSH_APP_PORT);
const APP_ID = process.env.VSSH_APP_ID || 'hello-world-node';
const APP_TOKEN = process.env.VSSH_APP_TOKEN || null;

const log = createAppLog({ appId: APP_ID });

const spa = createStaticSpa({
  root: path.join(__dirname, '..', 'frontend'),
  // Descomente se o seu app usa roteamento HTML5 (History API) em vez de fragmento:
  // spaFallback: true,
  missingBundleHint: 'Rode o build do frontend antes de subir o backend.',
  onWarn: (event) => log('spa-warn', event),
});

// Comparação de tamanho fixo: hash dos dois lados antes de comparar, para não vazar prefixo pelo
// tempo nem tropeçar em comprimentos diferentes.
function tokenMatches(expected, received) {
  if (typeof received !== 'string' || received.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    // O healthcheck é pollado pelo lifecycle do portal DIRETO na porta, sem passar pelo proxy —
    // então não carrega o X-Vssh-App-Token. Se ele não for isento, o healthcheck nunca passa e o
    // clique de "abrir app" fica pendurado até o teto de ~15s.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (APP_TOKEN && !tokenMatches(APP_TOKEN, req.headers['x-vssh-app-token'])) {
      // A porta é loopback, mas outro processo do mesmo usuário Linux alcança. Apps que dão acesso
      // sensível (shell, arquivos) devem checar; apps triviais podem simplesmente não checar.
      log('token-rejected', { path: url.pathname });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token ausente ou inválido' }));
      return;
    }

    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ pong: true, appId: APP_ID, time: new Date().toISOString() }));
      return;
    }

    // Exemplo de SSE. Prove que eventos chegam sem buffer: `curl -N <baseUrl>api/events`.
    if (url.pathname === '/api/events') {
      const stream = openSseStream(res);
      let n = 0;
      const timer = setInterval(() => {
        if (stream.closed) return clearInterval(timer);
        stream.send('tick', { n: ++n, time: new Date().toISOString() });
      }, 1000);
      res.on('close', () => clearInterval(timer));
      return;
    }

    // O static-spa devolve false quando não atendeu: 404 é decisão de quem compõe as rotas.
    if (await spa(req, res, url)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('não encontrado\n');
  } catch (err) {
    log('request-failed', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('erro interno\n');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('listening', { port: PORT, appId: APP_ID, tokenRequired: Boolean(APP_TOKEN) });
});

// Sem estes dois, uma falha assíncrona derruba o processo sem deixar rastro nenhum — e o lifecycle
// só mostra que o app "não subiu".
process.on('uncaughtException', (err) => log('uncaught', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: String(err) }));
