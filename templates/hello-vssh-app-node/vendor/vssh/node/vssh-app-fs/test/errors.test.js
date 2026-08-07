'use strict';

// Como cada falha é classificada. Existe porque um EISDIR virava 500 no servidor real: um pedido
// inválido do cliente aparecia como defeito do backend, que manda investigar o lado errado.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-err-'));
}

async function withServer(root, run, options = {}) {
  const warnings = [];
  const appFs = createAppFs({ root, onWarn: (w) => warnings.push(w), ...options.fsOptions });
  const handler = createFsHandler({ fs: appFs, onWarn: (w) => warnings.push(w) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await handler(req, res, url))) {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (body) => {
    const resp = await fetch(base + '/api/fs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  };
  try {
    await run({ rpc, warnings, appFs, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('escrever sobre diretório é 400 com mensagem, não 500', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });

  await withServer(root, async ({ rpc }) => {
    const resp = await rpc({ op: 'write-file', path: 'pages', content: 'x' });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'EINVAL');
    assert.match(resp.body.error.message, /diretório/);
    // O diretório continua intacto.
    assert.ok(fs.statSync(path.join(root, 'pages')).isDirectory());
  });
});

test('ler diretório como arquivo é 400 (EISDIR), não 500', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });

  await withServer(root, async ({ rpc }) => {
    const resp = await rpc({ op: 'read-file', path: 'pages' });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'EISDIR');
  });
});

test('caminho cujo pai é arquivo é erro do cliente, não 500', async () => {
  const root = tmpRoot();
  await fsp.writeFile(path.join(root, 'arquivo.md'), 'sou um arquivo');

  await withServer(root, async ({ rpc }) => {
    const resp = await rpc({ op: 'read-file', path: 'arquivo.md/dentro.md' });
    // O errno depende do SO: Linux dá ENOTDIR (400), Windows dá ENOENT (404). O que este teste
    // garante é a doutrina, não o número — o pedido é inválido, então a resposta é 4xx e o 500
    // continua significando "o servidor não sabe o que aconteceu".
    assert.ok(resp.status >= 400 && resp.status < 500, `esperava 4xx, veio ${resp.status}`);
    assert.ok(
      ['ENOTDIR', 'ENOENT'].includes(resp.body.error.code),
      `código inesperado: ${resp.body.error.code}`,
    );
  });
});

test('conteúdo que não é texto nem bytes é 400, não TypeError em 500', async () => {
  const root = tmpRoot();
  await withServer(root, async ({ rpc }) => {
    const resp = await rpc({ op: 'write-file', path: 'pages/a.md', content: { nao: 'string' } });
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, 'EINVAL');
    assert.match(resp.body.error.message, /texto ou bytes/);
  });
});

test('o corpo do erro diz qual op falhou', async () => {
  const root = tmpRoot();
  await withServer(root, async ({ rpc }) => {
    assert.equal((await rpc({ op: 'read-file', path: 'x.md' })).body.error.op, 'read-file');
    assert.equal((await rpc({ op: 'stat', path: 'x.md' })).body.error.op, 'stat');
  });
});

test('erro classificado loga sem pilha; o não classificado loga com pilha', async () => {
  const root = tmpRoot();

  await withServer(root, async ({ rpc, warnings, appFs }) => {
    await rpc({ op: 'read-file', path: 'fantasma.md' });
    const classified = warnings.find((w) => w.event === 'op-failed');
    assert.equal(classified.code, 'ENOENT');
    assert.equal(classified.path, 'fantasma.md');
    assert.equal(classified.stack, undefined, 'ENOENT é conhecido: pilha não acrescenta nada');

    // Falha que a lib não classifica — é para isso que o 500 existe.
    appFs.stat = async () => {
      throw new Error('algo inesperado');
    };
    const resp = await rpc({ op: 'stat', path: 'x.md' });
    assert.equal(resp.status, 500);
    assert.equal(resp.body.error.code, 'EUNKNOWN');
    const unclassified = warnings.filter((w) => w.event === 'op-failed').pop();
    assert.match(unclassified.stack, /algo inesperado/);
  });
});

test('cada errno da tabela vira o status combinado', async () => {
  const root = tmpRoot();
  const cases = [
    ['ENOENT', 404],
    ['EACCES', 403],
    ['EPERM', 403],
    ['EINVAL', 400],
    ['EISDIR', 400],
    ['ENOTDIR', 400],
    ['ENAMETOOLONG', 400],
    ['ELOOP', 400],
    ['EEXIST', 409],
    ['ENOSPC', 500],
    ['EIO', 500],
  ];

  await withServer(root, async ({ rpc, appFs }) => {
    for (const [code, expected] of cases) {
      appFs.stat = async () => {
        throw Object.assign(new Error(code), { code });
      };
      const resp = await rpc({ op: 'stat', path: 'x.md' });
      assert.equal(resp.status, expected, `${code} deveria virar ${expected}`);
      assert.equal(resp.body.error.code, code);
    }
  });
});

test('sondagem ENOENT é marcada como esperada no log', async () => {
  const root = tmpRoot();
  await withServer(root, async ({ rpc, warnings }) => {
    await rpc({ op: 'read-file', path: 'fantasma.md' });
    const w = warnings.find((x) => x.event === 'op-failed');
    assert.equal(w.expected, true, 'ENOENT é resposta de rotina, não defeito');

    warnings.length = 0;
    await rpc({ op: 'write-file', path: 'x', content: 1234 });
    const invalid = warnings.find((x) => x.event === 'op-failed');
    assert.equal(invalid.expected, undefined, 'EINVAL não é sondagem');
  });
});

test('exists responde booleano em 200, sem transformar ausência em erro', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });
  await fsp.writeFile(path.join(root, 'pages', 'a.md'), '- oi\n');

  await withServer(root, async ({ rpc, warnings }) => {
    const presente = await rpc({ op: 'exists', path: 'pages/a.md' });
    assert.equal(presente.status, 200);
    assert.deepEqual(presente.body, { ok: true, result: { exists: true } });

    const ausente = await rpc({ op: 'exists', path: 'pages/fantasma.md' });
    assert.equal(ausente.status, 200);
    assert.deepEqual(ausente.body, { ok: true, result: { exists: false } });

    // Diretório existe — a pergunta é sobre o caminho, não sobre ser arquivo.
    assert.equal((await rpc({ op: 'exists', path: 'pages' })).body.result.exists, true);

    // Nada disso gera linha de falha: é justamente o ponto da op.
    assert.deepEqual(warnings, []);
  });
});

test('exists fora da raiz é recusado, não respondido', async () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  await fsp.writeFile(path.join(outside, 'segredo.txt'), 'x');

  await withServer(root, async ({ rpc }) => {
    // Responder "false" já seria vazar que a lib olhou; e "true" vazaria a existência.
    const resp = await rpc({ op: 'exists', path: path.join(outside, 'segredo.txt') });
    assert.equal(resp.status, 403);
    assert.equal(resp.body.error.code, 'EACCES');
  });
});
