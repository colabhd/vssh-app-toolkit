'use strict';

// Adaptador node:http do contrato de wire descrito em README.md.
//
// Nada aqui sabe qual app está montando o handler: recebe um objeto de ops (ops.js) e devolve uma
// função `(req, res) => Promise<boolean>` que diz se atendeu a requisição. Quem compõe as rotas é
// o server do app.

const crypto = require('node:crypto');

const { FsError, ENOENT, EACCES, EINVAL } = require('./paths');

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

function contentTypeFor(p) {
  const dot = p.lastIndexOf('.');
  const ext = dot === -1 ? '' : p.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// Errno do Node traduzido em status. O que fica de fora cai em 500 de propósito — 500 significa
// "o servidor não sabe o que aconteceu", e essa distinção só é útil se a lista do que ele SABE for
// honesta. Antes daqui só havia três entradas, e um EISDIR virava 500: um pedido inválido do
// cliente aparecia como defeito do backend, que é o diagnóstico errado.
const STATUS_BY_CODE = {
  [ENOENT]: 404,
  [EACCES]: 403,
  EPERM: 403,
  [EINVAL]: 400,
  EISDIR: 400,
  ENOTDIR: 400,
  ENAMETOOLONG: 400,
  ELOOP: 400,
  EEXIST: 409,
  // ENOSPC, EIO, EMFILE, EROFS e erro de programação continuam em 500: são do servidor mesmo.
};

function statusFor(err) {
  return STATUS_BY_CODE[err && err.code] || 500;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err, op) {
  const status = statusFor(err);
  sendJson(res, status, {
    ok: false,
    error: {
      code: err.code || 'EUNKNOWN',
      message: err.message || String(err),
      // Sem isto o cliente só sabe que "uma op falhou" — e o console do navegador mostra a URL do
      // mount, que é a mesma para todas.
      ...(op ? { op } : {}),
    },
  });
}

// Só o que cai em 500 leva `stack`. Nos erros classificados a pilha não acrescenta nada — é sempre
// a mesma —, e nos 500 é a única coisa que diz onde o backend tropeçou.
//
// `expected` marca ENOENT: "não existe" é resposta de rotina para quem sonda antes de criar, e sem
// essa marca a linha diz `op-failed` e parece defeito. Foi o que fez três sondagens normais
// passarem por sintoma durante a depuração.
function failureEvent(event, err, extra) {
  const classified = Boolean(STATUS_BY_CODE[err && err.code]);
  return {
    event,
    ...extra,
    code: err.code || 'EUNKNOWN',
    message: err.message,
    ...(err && err.code === ENOENT ? { expected: true } : {}),
    ...(classified ? {} : { stack: err.stack }),
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('corpo grande demais'), { code: EINVAL }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Comparação de tamanho fixo: hash dos dois lados antes de comparar, para não vazar o prefixo
// coincidente pelo tempo nem tropeçar em comprimentos diferentes.
function tokenMatches(expected, received) {
  if (typeof received !== 'string' || received.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} options
 * @param {object} options.fs                  objeto devolvido por createAppFs
 * @param {string} [options.mountPath]         rota do RPC JSON (default '/api/fs')
 * @param {string} [options.assetsPrefix]      rota dos binários (default '/assets/')
 * @param {string|null} [options.requireToken] se string, exige X-Vssh-App-Token igual
 * @param {number} [options.maxBodyBytes]
 * @param {(event: object) => void} [options.onWarn]
 */
function createFsHandler(options) {
  const graphFs = options.fs;
  const mountPath = options.mountPath || '/api/fs';
  const assetsPrefix = options.assetsPrefix || '/assets/';
  const requireToken = options.requireToken || null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onWarn = options.onWarn || (() => {});

  const OPS = {
    'exists': (p) => graphFs.exists(p.path),
    'stat': (p) => graphFs.stat(p.path),
    'read-file': (p) => graphFs.readFile(p.path),
    'write-file': (p) => graphFs.writeFile(p.path, p.content ?? ''),
    'mkdir': (p) => graphFs.mkdir(p.path ?? p.dir),
    'mkdir-recur': (p) => graphFs.mkdirRecur(p.path ?? p.dir),
    'readdir': (p) => graphFs.readdir(p.path ?? p.dir, { applyIgnore: !!p.applyIgnore }),
    'unlink': (p) => graphFs.unlink(p.path, { recycle: p.recycle !== false }),
    'rename': (p) => graphFs.rename(p.from ?? p.old, p.to ?? p.new),
    'copy': (p) => graphFs.copy(p.from ?? p.old, p.to ?? p.new),
    'open-dir': (p) => graphFs.openDir(p.path ?? p.dir),
    'get-files': (p) => graphFs.getFiles(p.path ?? p.dir),
  };

  async function handleRpc(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: 'use POST' } });
      return;
    }
    let payload;
    try {
      const raw = await readBody(req, maxBodyBytes);
      payload = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      sendError(res, Object.assign(err, { code: err.code || EINVAL }));
      return;
    }
    const op = OPS[payload && payload.op];
    if (!op) {
      sendJson(res, 400, {
        ok: false,
        error: { code: EINVAL, message: `op desconhecida: ${payload && payload.op}` },
      });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, result: await op(payload) });
    } catch (err) {
      onWarn(failureEvent('op-failed', err, { op: payload.op, path: payload.path }));
      sendError(res, err, payload.op);
    }
  }

  async function handleWriteBinary(req, res, url) {
    if (req.method !== 'POST' && req.method !== 'PUT') {
      sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: 'use POST' } });
      return;
    }
    const target = url.searchParams.get('path');
    try {
      const body = await readBody(req, maxBodyBytes);
      sendJson(res, 200, { ok: true, result: await graphFs.writeFile(target, body) });
    } catch (err) {
      onWarn(failureEvent('write-binary-failed', err, { path: target }));
      sendError(res, err, 'write-binary');
    }
  }

  async function handleAsset(req, res, relative) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: { code: 'EMETHOD', message: 'use GET' } });
      return;
    }
    // `%` malformado faz decodeURIComponent lançar URIError, que não tem `.code` — sem este
    // tratamento ele caía no 500 genérico, quando é URL inválida do cliente, ou seja 400.
    let decoded;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      sendError(res, new FsError(EINVAL, `caminho de asset inválido: ${relative}`));
      return;
    }

    let file;
    try {
      file = await graphFs.openRead(decoded);
    } catch (err) {
      sendError(res, err);
      return;
    }

    const lastModified = new Date(file.mtime).toUTCString();
    const headers = {
      'Content-Type': contentTypeFor(file.path),
      'Last-Modified': lastModified,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
    };

    // Comparação exata de string, não parse de data: o valor veio deste mesmo servidor. Faltava
    // aqui e existia no static-spa — assimetria sem motivo entre as duas peças.
    if (req.headers['if-modified-since'] === lastModified && !req.headers.range) {
      res.writeHead(304, { 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    // Range de um intervalo só — o pdf.js do Logseq usa isso para não baixar o PDF inteiro.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && file.size > 0) {
      const [, rawStart, rawEnd] = range;
      let start = rawStart === '' ? file.size - Number(rawEnd) : Number(rawStart);
      let end = rawStart === '' || rawEnd === '' ? file.size - 1 : Number(rawEnd);
      start = Math.max(0, start);
      end = Math.min(file.size - 1, end);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
        res.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return void file.stream({ start, end }).pipe(res);
    }

    headers['Content-Length'] = file.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    file.stream().pipe(res);
  }

  return async function handle(req, res, url) {
    const pathname = url.pathname;
    const isRpc = pathname === mountPath;
    const isWriteBinary = pathname === mountPath + '/write-binary';
    const isAsset = pathname.startsWith(assetsPrefix);
    if (!isRpc && !isWriteBinary && !isAsset) return false;

    if (requireToken && !tokenMatches(requireToken, req.headers['x-vssh-app-token'])) {
      // Requisição que não veio pelo proxy autenticado do portal. A porta é loopback, mas outro
      // processo do mesmo usuário Linux alcança — e este handler dá acesso a arquivos.
      onWarn({ event: 'token-rejected', pathname });
      sendJson(res, 403, { ok: false, error: { code: EACCES, message: 'token ausente ou inválido' } });
      return true;
    }

    if (isRpc) await handleRpc(req, res);
    else if (isWriteBinary) await handleWriteBinary(req, res, url);
    else await handleAsset(req, res, pathname.slice(assetsPrefix.length));
    return true;
  };
}

module.exports = { createFsHandler, contentTypeFor, tokenMatches, DEFAULT_MAX_BODY_BYTES };
