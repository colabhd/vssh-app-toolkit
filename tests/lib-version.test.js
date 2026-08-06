'use strict';

// A versão que as libs DECLARAM tem de ser a versão que o toolkit TEM.
//
// `lib/web/vssh-app-shim.js` carrega um `LIB_VERSION` literal, porque roda no navegador e não tem
// de onde ler o `package.json`. Um literal é exatamente o tipo de coisa que fica para trás num
// bump — e o custo desse esquecimento é pior que o normal: a versão existe para responder "que
// libs este app está carregando?" num relato de bug. Uma resposta errada é pior que nenhuma,
// porque manda quem investiga para o lugar errado com confiança.
//
// O `.vssh-lib-version` que o `vssh-app-lib-sync` escreve na cópia vendorizada lê deste mesmo
// literal (e não do package.json), então esta conferência amarra as três pontas de uma vez:
// package.json → shim → marcador na cópia do app.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SHIM = path.join(ROOT, 'lib', 'web', 'vssh-app-shim.js');

/** O literal, lido do jeito que o `vssh-app-lib-sync` lê — se um achar, o outro acha. */
function versaoDoShim() {
  const src = fs.readFileSync(SHIM, 'utf8');
  const m = /^\s*const LIB_VERSION = '([^']*)';/m.exec(src);
  return m ? m[1] : null;
}

test('o LIB_VERSION do shim é o version do package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const doShim = versaoDoShim();
  assert.ok(doShim, 'não achei o literal LIB_VERSION em lib/web/vssh-app-shim.js');
  assert.equal(doShim, pkg.version,
    `o shim declara ${doShim} e o package.json diz ${pkg.version} — bumpe os dois`);
});

test('o vssh-app-lib-sync extrai a mesma versão que este teste extrai', () => {
  // As duas leituras são por regex sobre o mesmo arquivo, em linguagens diferentes (`sed` lá,
  // JavaScript aqui). Se alguém reescrever a linha de um jeito que só uma das duas reconheça, o
  // marcador da cópia vendorizada passa a mentir em silêncio — e mentir sobre a própria idade é
  // o defeito que esse marcador existe para não ter.
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'vssh-app-lib-sync'), 'utf8');
  const usaOShim = /vssh-app-shim\.js/.test(script) && /LIB_VERSION/.test(script);
  assert.ok(usaOShim, 'o vssh-app-lib-sync não lê mais a versão do shim');
});

test('a cópia vendorizada do template carimba a versão', () => {
  const marcador = path.join(
    ROOT, 'templates', 'hello-vssh-app-node', 'frontend', 'vendor', 'vssh', '.vssh-lib-version');
  const texto = fs.readFileSync(marcador, 'utf8');
  const m = /^lib_version=(.*)$/m.exec(texto);
  assert.ok(m, 'o marcador não registra lib_version — ressincronize com o vssh-app-lib-sync');
  assert.equal(m[1].trim(), versaoDoShim());
});
