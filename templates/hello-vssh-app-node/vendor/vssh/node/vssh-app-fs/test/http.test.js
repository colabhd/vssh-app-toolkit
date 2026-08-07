'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createAppFs } = require('../ops');
const { createFsHandler } = require('../http');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-app-fs-http-'));
}

// Sobe o handler num servidor real e devolve um cliente. Testar contra node:http de verdade (em
// vez de req/res falsos) é o que pega erro de header, status e streaming.
async function withServer(handlerOptions, run) {
  const handler = createFsHandler(handlerOptions);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await handler(req, res, url))) {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      base,
      rpc: (body, headers) =>
        fetch(base + '/api/fs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      get: (p, headers) => fetch(base + p, { headers }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('RPC: op válida devolve {ok:true, result}', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });
  await fsp.writeFile(path.join(root, 'pages', 'a.md'), '- oi\n');
  const appFs = createAppFs({ root });

  await withServer({ fs: appFs }, async ({ rpc }) => {
    const resp = await rpc({ op: 'read-file', path: 'pages/a.md' });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, result: { content: '- oi\n' } });
  });
});

test('RPC: erros viram status HTTP com código estável', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });

  await withServer({ fs: appFs }, async ({ rpc }) => {
    const missing = await rpc({ op: 'read-file', path: 'nao-existe.md' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'ENOENT');

    const escaping = await rpc({ op: 'read-file', path: '../../etc/passwd' });
    assert.equal(escaping.status, 403);
    assert.equal((await escaping.json()).error.code, 'EACCES');

    const unknown = await rpc({ op: 'inventada', path: 'x' });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, 'EINVAL');
  });
});

test('token: sem o header do proxy, nenhuma rota responde', async () => {
  const root = tmpRoot();
  await fsp.writeFile(path.join(root, 'a.md'), '- x\n');
  const appFs = createAppFs({ root });
  const warnings = [];

  await withServer(
    { fs: appFs, requireToken: 'segredo', onWarn: (w) => warnings.push(w) },
    async ({ rpc, get }) => {
      assert.equal((await rpc({ op: 'read-file', path: 'a.md' })).status, 403);
      assert.equal((await rpc({ op: 'read-file', path: 'a.md' }, { 'X-Vssh-App-Token': 'errado' })).status, 403);
      assert.equal((await get('/assets/a.md')).status, 403);

      const ok = await rpc({ op: 'read-file', path: 'a.md' }, { 'X-Vssh-App-Token': 'segredo' });
      assert.equal(ok.status, 200);

      assert.ok(warnings.some((w) => w.event === 'token-rejected'));
    },
  );
});

test('assets: serve binário com content-type e suporta Range', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await fsp.writeFile(path.join(root, 'assets', 'doc.pdf'), bytes);
  const appFs = createAppFs({ root });

  await withServer({ fs: appFs }, async ({ get }) => {
    const full = await get('/assets/assets/doc.pdf');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'application/pdf');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    const partial = await get('/assets/assets/doc.pdf', { Range: 'bytes=10-19' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 10-19/256');
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(10, 20));

    // Início além do fim do arquivo é insatisfazível (RFC 7233), não clampado.
    const bad = await get('/assets/assets/doc.pdf', { Range: 'bytes=900-999' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */256');

    // Sufixo: últimos 8 bytes.
    const suffix = await get('/assets/assets/doc.pdf', { Range: 'bytes=-8' });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(248));
  });
});

test('assets: caminho que escapa da raiz é recusado', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });
  await withServer({ fs: appFs }, async ({ get }) => {
    // Forma literal: o próprio parsing de URL já normaliza, então nem chega no prefixo /assets/.
    assert.equal((await get('/assets/../../../etc/passwd')).status, 404);
    // Forma percent-encoded: sobrevive à normalização e só o confinamento da lib barra.
    assert.equal((await get('/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).status, 403);
  });
});

test('write-binary grava o corpo cru (imagem colada no editor)', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

  await withServer({ fs: appFs }, async ({ base }) => {
    const resp = await fetch(base + '/api/fs/write-binary?path=' + encodeURIComponent('assets/nova.png'), {
      method: 'POST',
      body: bytes,
    });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).result.size, bytes.length);
    assert.deepEqual(await fsp.readFile(path.join(root, 'assets', 'nova.png')), bytes);
  });
});

test('rota fora do mount não é atendida pelo handler', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });
  await withServer({ fs: appFs }, async ({ get }) => {
    assert.equal((await get('/qualquer/outra')).status, 404);
  });
});
