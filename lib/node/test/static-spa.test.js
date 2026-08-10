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

// ─── Carimbo de versão nos scripts injetados ─────────────────────────────────
//
// O caso real: o `vssh-app-shim.js` foi atualizado e reinstalado, o arquivo em disco estava
// certo, e o navegador seguiu executando o antigo — o app quebrava com `vssh.audio` undefined
// enquanto o `index.html` já era o novo. `Cache-Control: no-cache` mais `Last-Modified` só
// funciona se TODO o caminho colaborar (navegador, proxy do portal, CDN); basta um elo guardar
// a resposta e o usuário fica com bytes velhos sem nenhum sinal.
//
// A correção testada aqui não é um header melhor: é conteúdo novo morar em OUTRA URL.

const esperaMtime = () => new Promise((r) => setTimeout(r, 1100)); // Last-Modified tem 1 s de resolução

test('o script injetado sai carimbado com o hash do CONTEÚDO dele', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await fsp.writeFile(path.join(root, 'shim.js'), 'window.vssh = 1');
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    const html = await (await get('/')).text();
    const m = html.match(/<script src="shim\.js\?v=([0-9a-f]{12})"><\/script>/);
    assert.ok(m, `esperava a tag carimbada, veio: ${html.match(/<script src="shim[^>]*>/)}`);
  });
});

test('mudar o SHIM troca a URL, mesmo sem tocar no index.html', async () => {
  // É o cenário exato do bug: atualizar a lib mexe no `node_modules`, nunca no index. Se o
  // carimbo não entrasse na chave do cache do index, o processo seguiria servindo a URL velha.
  const root = tmpBundle();
  await seedBundle(root);
  const shim = path.join(root, 'shim.js');
  await fsp.writeFile(shim, 'window.vssh = { audio: undefined }');
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    const antes = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];
    await fsp.writeFile(shim, 'window.vssh = { audio: {} }');   // só o shim muda
    const depois = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];
    assert.notEqual(depois, antes, 'conteúdo novo tem de morar em outra URL');
  });
});

test('reinstalar a MESMA versão mantém a URL — o cache do usuário sobrevive', async () => {
  // O carimbo sai do conteúdo, não da data: senão todo deploy invalidaria tudo à toa, e a
  // primeira coisa que alguém faria seria desligá-lo.
  const root = tmpBundle();
  await seedBundle(root);
  const shim = path.join(root, 'shim.js');
  await fsp.writeFile(shim, 'window.vssh = 1');
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    const antes = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];
    await esperaMtime();
    await fsp.writeFile(shim, 'window.vssh = 1');   // mesmos bytes, mtime novo
    const depois = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];
    assert.equal(depois, antes);
  });
});

test('carimbo VÁLIDO ganha immutable; carimbo velho NÃO', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  const shim = path.join(root, 'shim.js');
  await fsp.writeFile(shim, 'window.vssh = 1');
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    const v = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];

    const bom = await get(`/shim.js?v=${v}`);
    assert.match(bom.headers.get('cache-control'), /immutable/);

    // Carimbo de outra versão não pode fixar bytes por um ano — seria trocar um cache velho
    // por um cache velho eterno.
    const velho = await get('/shim.js?v=000000000000');
    assert.equal(velho.headers.get('cache-control'), 'no-cache');
    assert.equal(velho.status, 200);

    // Sem carimbo nenhum, o comportamento de sempre.
    assert.equal((await get('/shim.js')).headers.get('cache-control'), 'no-cache');
  });
});

test('recurso imutável não responde 304 — ele nunca precisa revalidar', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await fsp.writeFile(path.join(root, 'shim.js'), 'window.vssh = 1');
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    const v = (await (await get('/')).text()).match(/shim\.js\?v=([0-9a-f]+)/)[1];
    const first = await get(`/shim.js?v=${v}`);
    const again = await get(`/shim.js?v=${v}`, {
      headers: { 'If-Modified-Since': first.headers.get('last-modified') },
    });
    assert.equal(again.status, 200, 'com carimbo válido a resposta é sempre o conteúdo');
  });
});

test('o index NUNCA é cacheado — é ele que carrega a URL carimbada nova', async () => {
  // Metade do mecanismo. Um index cacheado seguraria o carimbo velho e anularia o resto.
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, injectScripts: ['shim.js'] }, async ({ get }) => {
    assert.equal((await get('/')).headers.get('cache-control'), 'no-store');
  });
});

test('script injetado que não existe em disco não ganha carimbo falso', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, injectScripts: ['nao-existe.js'] }, async ({ get }) => {
    const html = await (await get('/')).text();
    assert.match(html, /<script src="nao-existe\.js"><\/script>/);
  });
});

// ── Mounts ────────────────────────────────────────────────────────────────────
//
// Servir um prefixo de fora da raiz. Desde a v4 as libs de navegador do toolkit chegam por
// `npm install`, então moram no `node_modules` — fora da raiz do bundle por construção. Antes
// disso cada app escrevia a própria rota, e a do Logseq servia os shims sem 304, sem confinamento
// e sem carimbo: exatamente as três coisas que estes testes cobram.

/** Um "node_modules/vssh-app-toolkit/lib/web" de mentira, com um shim dentro. */
async function seedWebDir(corpo = 'window.vssh = {}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-web-'));
  await fsp.writeFile(path.join(dir, 'vssh-app-shim.js'), corpo);
  return dir;
}

test('mount serve arquivo de fora da raiz do bundle', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  const web = await seedWebDir();
  await withServer({ root, mounts: { '/_vssh/': web } }, async ({ get }) => {
    const r = await get('/_vssh/vssh-app-shim.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await r.text(), 'window.vssh = {}');
  });
});

test('sem o mount, o mesmo caminho é 404 — é o mount que serve, não a raiz', async () => {
  // O outro lado do teste acima: sem ele, um arquivo que por acaso existisse na raiz faria o
  // primeiro passar sem o mecanismo ter sido exercitado.
  const root = tmpBundle();
  await seedBundle(root);
  await seedWebDir();
  await withServer({ root }, async ({ get }) => {
    assert.equal((await get('/_vssh/vssh-app-shim.js')).status, 404);
  });
});

test('script injetado de um mount sai CARIMBADO', async () => {
  // A razão de o mount existir em vez de uma rota à mão: o shim é justamente o arquivo do caso
  // real narrado em "Carimbo de versão" — servido velho por um cache, com o disco já certo.
  const root = tmpBundle();
  await seedBundle(root);
  const web = await seedWebDir();
  await withServer(
    { root, mounts: { '/_vssh/': web }, injectScripts: ['_vssh/vssh-app-shim.js'] },
    async ({ get }) => {
      const html = await (await get('/')).text();
      const m = html.match(/_vssh\/vssh-app-shim\.js\?v=([0-9a-f]+)/);
      assert.ok(m, `o script do mount saiu sem carimbo: ${html}`);
      const r = await get(`/_vssh/vssh-app-shim.js?v=${m[1]}`);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    },
  );
});

test('mudar a lib montada troca a URL, sem tocar no index', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  const web = await seedWebDir();
  const opts = { root, mounts: { '/_vssh/': web }, injectScripts: ['_vssh/vssh-app-shim.js'] };
  await withServer(opts, async ({ get }) => {
    const antes = (await (await get('/')).text()).match(/\?v=([0-9a-f]+)/)[1];
    await fsp.writeFile(path.join(web, 'vssh-app-shim.js'), 'window.vssh = {novo: 1}');
    const depois = (await (await get('/')).text()).match(/\?v=([0-9a-f]+)/)[1];
    assert.notEqual(depois, antes, 'o npm atualizou a lib e a URL continuou a mesma');
  });
});

test('o mount não vira caminho para escapar do diretório montado', async () => {
  const root = tmpBundle();
  await seedBundle(root);
  const web = await seedWebDir();
  const fora = tmpBundle();
  await fsp.writeFile(path.join(fora, 'segredo.txt'), 'não');
  await withServer({ root, mounts: { '/_vssh/': web } }, async ({ get }) => {
    // Percent-encoded sobrevive à normalização da URL e chega inteiro no handler.
    assert.equal((await get('/_vssh/%2e%2e%2f%2e%2e%2fsegredo.txt')).status, 404);
    assert.equal((await get('/_vssh/' + encodeURIComponent(path.join(fora, 'segredo.txt')))).status, 404);
  });
});

test('symlink DENTRO do mount apontando para fora não é servido', async () => {
  // Este caso só o `realpath` pega — a checagem lexical passa, porque o caminho ESTÁ dentro.
  //
  // A refutação de `..` e a deste caso deram uma resposta que vale escrever: apagar a checagem
  // lexical sozinha não deixa nenhum teste vermelho, porque tudo que ela recusa o `realpath`
  // também recusa. Ela é atalho, não defesa — e a defesa é esta aqui. Dito para ninguém
  // "consertar" a redundância pelo lado errado.
  const root = tmpBundle();
  await seedBundle(root);
  const web = await seedWebDir();
  const fora = tmpBundle();
  await fsp.writeFile(path.join(fora, 'segredo.txt'), 'não');
  try {
    fs.symlinkSync(path.join(fora, 'segredo.txt'), path.join(web, 'atalho.js'));
  } catch (err) {
    // No Windows sem modo de desenvolvedor, criar symlink exige privilégio. Pular DIZENDO por quê
    // — um teste que se pula calado vira cobertura imaginária.
    if (err.code === 'EPERM' || err.code === 'EACCES') return void console.log(`(pulado: ${err.code} ao criar symlink)`);
    throw err;
  }
  await withServer({ root, mounts: { '/_vssh/': web } }, async ({ get }) => {
    assert.equal((await get('/_vssh/atalho.js')).status, 404);
  });
});

test('caminho direto vence o mount; o mount vence o alias', async () => {
  // A precedência declarada no topo do arquivo. Sem teste ela é comentário.
  const root = tmpBundle();
  await seedBundle(root);
  await fsp.mkdir(path.join(root, '_vssh'), { recursive: true });
  await fsp.writeFile(path.join(root, '_vssh', 'vssh-app-shim.js'), 'DA RAIZ');
  const web = await seedWebDir('DO MOUNT');
  await withServer(
    { root, mounts: { '/_vssh/': web }, aliasPrefixes: { '/_vssh/': '/js/' } },
    async ({ get }) => {
      assert.equal(await (await get('/_vssh/vssh-app-shim.js')).text(), 'DA RAIZ');
      // `main.js` não existe na raiz sob `_vssh/`, existe no mount? não — existe via alias em
      // /js/main.js. Com o mount presente e sem o arquivo, o alias ainda resolve.
      assert.equal((await get('/_vssh/main.js')).status, 200);
    },
  );
});

test('prefixo de mount sem barra é recusado no boot, não em produção', async () => {
  // `'/_vssh'` casaria com `/_vsshzinho`, e o defeito apareceria como um arquivo servido do lugar
  // errado. Falhar ao construir é o momento barato.
  assert.throws(() => createStaticSpa({ root: tmpBundle(), mounts: { '/_vssh': '/tmp' } }),
    /precisa começar e terminar com/);
});

test('mount cujo diretório não existe é 404, não morte no boot', async () => {
  // O caso de subir o backend antes do `npm ci`.
  const root = tmpBundle();
  await seedBundle(root);
  await withServer({ root, mounts: { '/_vssh/': path.join(root, 'nao-instalado') } }, async ({ get }) => {
    assert.equal((await get('/_vssh/vssh-app-shim.js')).status, 404);
    assert.equal((await get('/')).status, 200, 'o resto do app continua de pé');
  });
});
