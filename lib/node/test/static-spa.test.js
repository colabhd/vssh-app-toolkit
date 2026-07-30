'use strict';

// Testes da peça de servir bundle. O caso do alias existe porque um 404 em script carregado
// dinamicamente não aparece no carregamento da página — foi preciso instalar o app num servidor
// real para descobrir que `static/js/shepherd.min.js` não resolvia.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStaticSpa } = require('../static-spa');

function tmpBundle() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-spa-'));
}

// Reproduz o layout que scripts/build-logseq.sh instala: o conteúdo de `static/` na raiz.
async function seedBundle(root) {
  await fsp.mkdir(path.join(root, 'js'), { recursive: true });
  await fsp.mkdir(path.join(root, 'css'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'index.html'),
    '<!DOCTYPE html><html><head><title>t</title></head><body><script defer src="./js/main.js"></script></body></html>',
  );
  await fsp.writeFile(path.join(root, 'js', 'main.js'), 'console.log(1)');
  await fsp.writeFile(path.join(root, 'js', 'shepherd.min.js'), 'window.Shepherd = {}');
  await fsp.writeFile(path.join(root, 'css', 'style.css'), 'body{}');
}

async function withServer(options, run) {
  const spa = createStaticSpa(options);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await spa(req, res, url))) {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, get: (p, init) => fetch(base + p, init) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ALIAS = { '/static/': '/' };

test('serve o index com os scripts injetados', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, injectScripts: ['vssh-boot.js'] }, async ({ get }) => {
    const html = await (await get('/')).text();
    assert.match(html, /<script src="vssh-boot\.js"><\/script>\s*<\/head>/);
  });
});

test('caminho direto do bundle é servido', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    const resp = await get('/js/main.js');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await resp.text(), 'console.log(1)');
  });
});

test('alias resolve /static/<x> para <x> — o caso do JS_ROOT do Logseq', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    // Exatamente a URL que 404ava no servidor real.
    const shepherd = await get('/static/js/shepherd.min.js');
    assert.equal(shepherd.status, 200);
    assert.equal(await shepherd.text(), 'window.Shepherd = {}');

    // Vale para qualquer subcaminho, não só js/ — é o ponto de resolver no servidor e não no fork.
    assert.equal((await get('/static/css/style.css')).status, 200);
    assert.equal((await get('/static/js/main.js')).status, 200);
  });
});

test('sem aliasPrefixes o mesmo caminho não resolve (o alias é que conserta)', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root }, async ({ get }) => {
    assert.equal((await get('/static/js/shepherd.min.js')).status, 404);
  });
});

test('caminho direto tem prioridade: o alias nunca sombreia arquivo real', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await fsp.mkdir(path.join(root, 'static', 'js'), { recursive: true });
  await fsp.writeFile(path.join(root, 'static', 'js', 'main.js'), 'o de verdade');

  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    assert.equal(await (await get('/static/js/main.js')).text(), 'o de verdade');
  });
});

test('arquivo inexistente nos dois prefixos dá 404', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    assert.equal((await get('/static/js/fantasma.js')).status, 404);
    assert.equal((await get('/js/fantasma.js')).status, 404);
  });
});

test('o alias não vira caminho para escapar da raiz', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  const outside = tmpBundle();
  await fsp.writeFile(path.join(outside, 'segredo.txt'), 'nao');

  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    // Percent-encoded sobrevive à normalização da URL e chega inteiro no handler.
    assert.equal((await get('/static/%2e%2e%2f%2e%2e%2fsegredo.txt')).status, 404);
    assert.equal((await get('/%2e%2e%2fsegredo.txt')).status, 404);
    assert.equal((await get('/static/' + encodeURIComponent(path.join(outside, 'segredo.txt')))).status, 404);
  });
});

test('diretório não é servido como arquivo, nem pelo alias', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    assert.equal((await get('/js')).status, 404);
    assert.equal((await get('/static/js')).status, 404);
  });
});

test('revalidação com 304 vale também para o caminho aliasado', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, aliasPrefixes: ALIAS }, async ({ get }) => {
    const first = await get('/static/js/shepherd.min.js');
    assert.equal(first.status, 200);
    const again = await get('/static/js/shepherd.min.js', {
      headers: { 'If-Modified-Since': first.headers.get('last-modified') },
    });
    assert.equal(again.status, 304);
  });
});

test('bundle ausente devolve 500 com instrução, não 404 silencioso', async () => {
  const root = tmpBundle(); // sem index.html
  const warnings = [];
  const hint = 'Rode scripts/build.sh antes de subir o backend.';
  await withServer({ root, missingBundleHint: hint, onWarn: (w) => warnings.push(w) }, async ({ get }) => {
    const resp = await get('/');
    assert.equal(resp.status, 500);
    // A instrução é do app, não da lib: quem monta o handler diz como reconstruir o bundle.
    assert.match(await resp.text(), /build\.sh/);
    assert.equal(warnings[0].event, 'index-missing');
  });
});
