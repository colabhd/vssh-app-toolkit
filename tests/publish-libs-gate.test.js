'use strict';

// O portão de versão das libs, dentro do `vssh-app-publish`.
//
// Ele existe porque um app leva as libs do toolkit consigo, e um app publicado contra outra
// GERAÇÃO das libs quebra no servidor — não aqui. Até a v3 as libs eram copiadas por um script e o
// portão lia um marcador escrito à mão (`.vssh-lib-version`); desde a v4 elas vêm por
// `npm i github:colabhd/vssh-app-toolkit#v4` e o portão lê o `package.json` que o npm instalou.
//
// A troca não foi estética: o script tinha o ref default escrito à mão, ficou preso na `v3` quando
// a v4 saiu, e dois apps publicaram com libs de outra major. **O portão pegou os dois** — e é por
// isso que ele merece teste próprio: ele é a última linha antes do servidor.
//
// O trecho é recortado do script pelos DELIMITADORES (`── 2b.` … `── 3.`), nunca por número de
// linha: o script cresce, as linhas andam, e um recorte por número passaria a medir outra coisa
// sem nada avisar. Mesmo idioma do recorte do validador em publish-validacao.test.js.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'vssh-app-publish');
const posix = (p) => p.replace(/\\/g, '/');

function temBash() {
  try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const seNaoTemBash = { skip: temBash() ? false : 'sem bash no PATH' };

/** O bloco 2b do publish, recortado pelos delimitadores reais. */
function portao() {
  const linhas = fs.readFileSync(SCRIPT, 'utf8').replace(/\r/g, '').split('\n');
  const inicio = linhas.findIndex((l) => l.startsWith('# ── 2b.'));
  const fim = linhas.findIndex((l, i) => i > inicio && l.startsWith('# ── 3.'));
  assert.ok(inicio > 0 && fim > inicio, 'não achei a seção 2b no vssh-app-publish');
  return linhas.slice(inicio, fim).join('\n');
}

/**
 * Roda o portão contra um app de mentira.
 *
 * O toolkit de mentira reproduz o layout real (`<raiz>/package.json` + `<raiz>/scripts/<x>`)
 * porque a própria seção calcula a raiz a partir de `$0` — um stub dessa linha testaria o stub.
 */
function rodar(app, { nossaVersao = '4.0.0' } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-gate-'));
  try {
    fs.mkdirSync(path.join(t, 'scripts'));
    if (nossaVersao) fs.writeFileSync(path.join(t, 'package.json'), JSON.stringify({ name: 'vssh-app-toolkit', version: nossaVersao }, null, 2));
    const gate = path.join(t, 'scripts', 'gate.sh');
    fs.writeFileSync(gate, [
      'set -euo pipefail',
      'anotar() { local n="$1" ti="$2"; shift 2; printf "%s|%s|%s\\n" "$n" "$ti" "$*"; }',
      'PKG="$1"',
      portao(),
      'echo "FIM"',
    ].join('\n'));

    const r = spawnSync('bash', [posix(gate), posix(app)], { encoding: 'utf8' });
    return { code: r.status, saida: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

/** Um pacote de app: manifesto, package.json opcional e node_modules opcional. */
function app({ manifesto = {}, declara = false, instalada = null, legado = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-app-'));
  fs.writeFileSync(path.join(dir, 'vssh-app.json'), JSON.stringify({
    id: 'x', version: '1.0.0', backend: { runtime: 'node', entrypoint: 'b.js', ...manifesto },
  }, null, 2));
  if (declara) {
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { 'vssh-app-toolkit': 'github:colabhd/vssh-app-toolkit#v4' } }, null, 2));
  }
  if (instalada) {
    const nm = path.join(dir, 'node_modules', 'vssh-app-toolkit');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: 'vssh-app-toolkit', version: instalada }, null, 2));
  }
  if (legado) {
    const v = path.join(dir, 'backend', 'vendor', 'vssh');
    fs.mkdirSync(v, { recursive: true });
    fs.writeFileSync(path.join(v, '.vssh-lib-version'), 'origin=colabhd/vssh-app-toolkit@v3\nlib_version=3.0.0\n');
  }
  return dir;
}

test('libs da mesma versão passam calado', seNaoTemBash, () => {
  const r = rodar(app({ declara: true, instalada: '4.0.0' }));
  assert.equal(r.code, 0);
  assert.match(r.saida, /FIM/);
  assert.doesNotMatch(r.saida, /major|desatualizadas/);
});

test('libs de outra MAJOR param a publicação', seNaoTemBash, () => {
  // O caso que aconteceu de verdade: app com 3.0.0 e toolkit 4.0.0.
  const r = rodar(app({ declara: true, instalada: '3.0.0' }));
  assert.equal(r.code, 1, 'publicou com libs de outra geração');
  assert.match(r.saida, /error\|libs de outra major/);
  assert.match(r.saida, /3\.0\.0.*4\.0\.0/s);
  assert.match(r.saida, /npm i github:colabhd\/vssh-app-toolkit#v4/, 'o erro tem de trazer o conserto junto');
});

test('minor à frente avisa e deixa passar', seNaoTemBash, () => {
  // A proporção é a regra: recusar o compatível só ensina a ignorar o portão.
  const r = rodar(app({ declara: true, instalada: '4.1.0' }));
  assert.equal(r.code, 0);
  assert.match(r.saida, /warning\|libs desatualizadas/);
});

test('declarar sem levar e sem instalar no alvo é recusado', seNaoTemBash, () => {
  // O tarball iria sem node_modules e sem ninguém para criá-lo: o backend morre no primeiro
  // require, no servidor, longe daqui.
  const r = rodar(app({ declara: true }));
  assert.equal(r.code, 1);
  assert.match(r.saida, /error\|libs declaradas e ausentes/);
});

test('declarar sem levar, mas com installCommand que roda npm, é notice', seNaoTemBash, () => {
  // É o que o scramjet-wisp faz em produção. E o portão DIZ que não conferiu a versão, em vez de
  // deixar entender que conferiu.
  const r = rodar(app({ declara: true, manifesto: { installCommand: 'npm ci --omit=dev' } }));
  assert.equal(r.code, 0);
  assert.match(r.saida, /notice\|libs instaladas no servidor/);
  assert.match(r.saida, /NÃO foi conferida/);
});

test('app que não usa as libs passa, e o portão diz que não tinha o que conferir', seNaoTemBash, () => {
  const r = rodar(app({}));
  assert.equal(r.code, 0);
  assert.match(r.saida, /notice\|sem libs do toolkit/);
});

test('cópia vendorizada antiga é ERRO, não aviso', seNaoTemBash, () => {
  // Um `vendor/vssh/` no pacote depois da v4 é código morto que o app pode estar carregando NO
  // LUGAR das libs instaladas — duas noções da mesma coisa, que é o defeito, não o sintoma.
  const r = rodar(app({ declara: true, instalada: '4.0.0', legado: true }));
  assert.equal(r.code, 1);
  assert.match(r.saida, /error\|libs copiadas à mão/);
});

test('sem saber a própria versão, o portão diz que NÃO conferiu', seNaoTemBash, () => {
  // Checkout esparso sem package.json. Uma conferência que se acha feita sem ter sido é pior que
  // nenhuma — a lição que o próprio script narra sobre o schema.
  const r = rodar(app({ declara: true, instalada: '3.0.0' }), { nossaVersao: null });
  assert.equal(r.code, 0, 'não dá para recusar por uma comparação que não foi feita');
  assert.match(r.saida, /warning\|libs não conferidas/);
});
