'use strict';

// Roda com `node --test backend/vssh-app-fs/`. Sem dependência, sem env var do VSSH — se algum
// teste aqui precisar de uma, a fronteira da lib vazou.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createAppFs } = require('../ops');
const { LOGSEQ_PRESET } = require('../presets/logseq');

// path.relative devolve o separador do SO. Sem normalizar, toda asserção de caminho relativo
// falha no Windows e passa no Linux — foi assim que estes testes ficaram presos ao CI.
function relOf(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-app-fs-'));
}

async function seedGraph(root) {
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });
  await fsp.mkdir(path.join(root, 'journals'), { recursive: true });
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(root, 'logseq', '.recycle'), { recursive: true });
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(path.join(root, 'pages', 'alpha.md'), '- alpha\n');
  await fsp.writeFile(path.join(root, 'journals', '2026_07_30.md'), '- hoje\n');
  await fsp.writeFile(path.join(root, 'logseq', 'config.edn'), '{:foo 1}\n');
  await fsp.writeFile(path.join(root, 'assets', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fsp.writeFile(path.join(root, '.DS_Store'), 'x');
  await fsp.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
  await fsp.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
  await fsp.writeFile(path.join(root, 'logseq', '.recycle', 'lixo.md'), 'apagado');
  await fsp.writeFile(path.join(root, 'logseq', 'graphs-txid.edn'), '[1 "uuid"]');
}

test('open-dir devolve só as extensões da allowlist, com conteúdo', async () => {
  const root = tmpRoot();
  await seedGraph(root);
  // Fixtures de grafo Logseq → política do Logseq. O default da lib é neutro de propósito.
  const appFs = createAppFs({ root, ...LOGSEQ_PRESET });

  const result = await appFs.openDir();
  const rels = result.files.map((f) => relOf(root, f.path)).sort();

  assert.deepEqual(rels, ['journals/2026_07_30.md', 'logseq/config.edn', 'pages/alpha.md']);
  assert.equal(result.path, fs.realpathSync(root));

  const alpha = result.files.find((f) => f.path.endsWith('alpha.md'));
  assert.equal(alpha.content, '- alpha\n');
  assert.equal(alpha.type, 'file');
  assert.equal(alpha.size, 8);
  assert.ok(Number.isInteger(alpha.mtime) && alpha.mtime > 0);
});

test('open-dir ignora .git, node_modules, .recycle, .DS_Store e caches do Logseq', async () => {
  const root = tmpRoot();
  await seedGraph(root);
  const appFs = createAppFs({ root });

  const result = await appFs.openDir();
  const joined = result.files.map((f) => f.path).join('\n');

  for (const forbidden of ['.git', 'node_modules', '.recycle', '.DS_Store', 'graphs-txid.edn']) {
    assert.ok(!joined.includes(forbidden), `não deveria listar ${forbidden}`);
  }
  // assets/pic.png existe, mas não está na allowlist de conteúdo — vai pelo GET /assets/, não aqui.
  assert.ok(!joined.includes('pic.png'));
});

test('write-file cria diretório-pai e devolve size/mtime', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });

  const out = await appFs.writeFile('pages/nova/sub.md', '- conteúdo\n');
  assert.ok(Number.isInteger(out.mtime));
  assert.equal(out.size, Buffer.byteLength('- conteúdo\n'));
  assert.equal(await fsp.readFile(path.join(root, 'pages/nova/sub.md'), 'utf8'), '- conteúdo\n');
});

test('write-file aceita Buffer (asset colado no editor)', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });

  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  await appFs.writeFile('assets/colado.png', bytes);
  assert.deepEqual(await fsp.readFile(path.join(root, 'assets/colado.png')), bytes);
});

test('caminho absoluto dentro da raiz é aceito (é o que o Logseq emite)', async () => {
  const root = tmpRoot();
  await seedGraph(root);
  const appFs = createAppFs({ root });

  const abs = path.join(fs.realpathSync(root), 'pages', 'alpha.md');
  assert.equal((await appFs.readFile(abs)).content, '- alpha\n');
});

test('confinamento: .. , caminho absoluto de fora e symlink pra fora são recusados', async () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  await seedGraph(root);
  await fsp.writeFile(path.join(outside, 'segredo.md'), 'não deveria sair daqui');
  fs.symlinkSync(outside, path.join(root, 'escapa'));

  const appFs = createAppFs({ root });

  await assert.rejects(() => appFs.readFile('../segredo.md'), { code: 'EACCES' });
  await assert.rejects(() => appFs.readFile('pages/../../segredo.md'), { code: 'EACCES' });
  await assert.rejects(() => appFs.readFile(path.join(outside, 'segredo.md')), { code: 'EACCES' });
  await assert.rejects(() => appFs.readFile('escapa/segredo.md'), { code: 'EACCES' });
  await assert.rejects(() => appFs.writeFile('escapa/novo.md', 'x'), { code: 'EACCES' });
  await assert.rejects(() => appFs.readFile('pages/\0alpha.md'), { code: 'EINVAL' });

  // e o symlink não vaza pela listagem
  const listed = (await appFs.openDir()).files.map((f) => f.path).join('\n');
  assert.ok(!listed.includes('segredo.md'));
});

test('unlink move pro recycle com o caminho achatado, não apaga', async () => {
  const root = tmpRoot();
  await seedGraph(root);
  const appFs = createAppFs({ root });

  const out = await appFs.unlink('pages/alpha.md');

  assert.equal(fs.existsSync(path.join(root, 'pages/alpha.md')), false);
  // Default neutro da lib; o 'logseq/.recycle' virou parte do preset do app.
  const recycled = path.join(root, '.recycle/pages_alpha.md');
  assert.equal(out.recycled, recycled);
  assert.equal(await fsp.readFile(recycled, 'utf8'), '- alpha\n');
});

test('stat, readdir, rename e copy', async () => {
  const root = tmpRoot();
  await seedGraph(root);
  const appFs = createAppFs({ root });

  const info = await appFs.stat('pages/alpha.md');
  assert.equal(info.type, 'file');
  assert.equal(info.size, 8);

  assert.equal((await appFs.stat('pages')).type, 'directory');

  // readdir é recursivo e não filtra extensão, mas descarta ocultos (inclui .git)
  const all = await appFs.readdir();
  const rels = all.map((p) => relOf(root, p)).sort();
  assert.deepEqual(rels, [
    'assets/pic.png',
    'journals/2026_07_30.md',
    'logseq/config.edn',
    'logseq/graphs-txid.edn',
    'node_modules/pkg/index.js',
    'pages/alpha.md',
  ]);

  await appFs.rename('pages/alpha.md', 'pages/beta.md');
  assert.equal(await fsp.readFile(path.join(root, 'pages/beta.md'), 'utf8'), '- alpha\n');

  await appFs.copy('pages/beta.md', 'pages/gama.md');
  assert.equal(await fsp.readFile(path.join(root, 'pages/gama.md'), 'utf8'), '- alpha\n');
});

test('op em arquivo inexistente devolve ENOENT', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });

  await assert.rejects(() => appFs.readFile('pages/fantasma.md'), { code: 'ENOENT' });
  await assert.rejects(() => appFs.stat('pages/fantasma.md'), { code: 'ENOENT' });
  await assert.rejects(() => appFs.unlink('pages/fantasma.md'), { code: 'ENOENT' });
});

test('mkdir existente não é erro; mkdir-recur cria a cadeia', async () => {
  const root = tmpRoot();
  const appFs = createAppFs({ root });

  await appFs.mkdirRecur('a/b/c');
  assert.ok(fs.statSync(path.join(root, 'a/b/c')).isDirectory());
  await appFs.mkdir('a/b/c'); // não deve lançar
});

test('arquivo acima de maxContentBytes é omitido da listagem, não listado vazio', async () => {
  // Listar com conteúdo vazio seria pior que omitir: o Logseq trataria como página vazia e o
  // primeiro save por cima apagaria o arquivo de verdade no disco.
  const root = tmpRoot();
  const warnings = [];
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true });
  await fsp.writeFile(path.join(root, 'pages', 'grande.md'), 'x'.repeat(2048));
  await fsp.writeFile(path.join(root, 'pages', 'normal.md'), '- ok\n');
  const appFs = createAppFs({ root, maxContentBytes: 1024, onWarn: (w) => warnings.push(w) });

  const result = await appFs.openDir();
  assert.deepEqual(
    result.files.map((f) => relOf(root, f.path)),
    ['pages/normal.md'],
  );
  assert.equal(warnings[0].event, 'file-skipped');
  assert.equal(warnings[0].reason, 'too-large');

  // Continua legível por caminho explícito — só não entra na carga do grafo.
  assert.equal((await appFs.readFile('pages/grande.md')).content.length, 2048);
});

test('allowlist e ignore são configuráveis pelo app, não hardcoded', async () => {
  const root = tmpRoot();
  await fsp.mkdir(path.join(root, 'notas'), { recursive: true });
  await fsp.writeFile(path.join(root, 'notas', 'a.txt'), 'texto');
  await fsp.writeFile(path.join(root, 'notas', 'b.md'), '- md');

  const appFs = createAppFs({
    root,
    contentExtensions: ['txt'],
    ignore: { prefixes: ['notas/ignorado'], exact: [], dirNames: [], suffixes: [], hidden: true },
  });

  const rels = (await appFs.openDir()).files.map((f) => relOf(root, f.path));
  assert.deepEqual(rels, ['notas/a.txt']);
});

test('raiz inexistente é criada no setup', () => {
  const parent = tmpRoot();
  const root = path.join(parent, 'Documents', 'logseq');
  const appFs = createAppFs({ root });
  assert.ok(fs.statSync(root).isDirectory());
  assert.equal(appFs.root, fs.realpathSync(root));
});
