'use strict';

// A versão que as libs DECLARAM tem de ser a versão que o toolkit TEM.
//
// `lib/web/vssh-app-shim.js` carrega um `LIB_VERSION` literal, porque roda no navegador e não tem
// de onde ler o `package.json`. Um literal é exatamente o tipo de coisa que fica para trás num
// bump — e o custo desse esquecimento é pior que o normal: a versão existe para responder "que
// libs este app está carregando?" num relato de bug. Uma resposta errada é pior que nenhuma,
// porque manda quem investiga para o lugar errado com confiança.
//
// Este arquivo já amarrou três pontas: package.json → shim → `.vssh-lib-version` da cópia
// vendorizada. A terceira morreu na v4 junto com o `vssh-app-lib-sync` — e morreu por ter
// falhado: o ref default do script ficou preso na `v3`, dois apps sincronizaram libs 3.0.0 contra
// um toolkit 4.0.0, e a conta só apareceu no CI. Hoje quem responde "que versão é esta?" é o npm,
// pelo `package-lock.json` do app. O que sobra aqui é o par que ainda não tem dono automático:
// package.json → shim.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SHIM = path.join(ROOT, 'lib', 'web', 'vssh-app-shim.js');

/** O literal, lido do jeito que o resto do mundo o lê. */
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

// ── O pacote npm ──────────────────────────────────────────────────────────────
//
// Um app instala este repositório como dependência (`npm i github:colabhd/vssh-app-toolkit#v4`) e
// importa por subcaminho (`require('vssh-app-toolkit/listen')`). Duas coisas podem apodrecer sem
// dar sinal aqui dentro, e as duas quebram o app do OUTRO lado, longe da causa:
//
//   1. um `exports` apontando para arquivo que não existe mais — o app recebe
//      ERR_PACKAGE_PATH_NOT_EXPORTED, que não parece com "faltou mover uma linha";
//   2. um `files` que deixa de fora uma pasta que o `exports` alcança — funciona no clone,
//      funciona no CI, e falha só no app instalado. É o pior dos dois.

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('todo subcaminho de exports existe em disco', () => {
  const faltando = [];
  for (const [sub, alvo] of Object.entries(PKG.exports)) {
    if (sub.includes('*')) {
      // `./web/*` → o diretório tem de existir; o arquivo é escolha de quem importa.
      const dir = path.join(ROOT, path.dirname(alvo.replace('*', 'x')));
      if (!fs.existsSync(dir)) faltando.push(`${sub} → ${dir}`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, alvo))) faltando.push(`${sub} → ${alvo}`);
  }
  assert.deepStrictEqual(faltando, [], `exports aponta para o que não existe:\n  ${faltando.join('\n  ')}`);
});

test('o `files` do pacote cobre tudo que o `exports` alcança', () => {
  // Sem isto, `npm i` entrega um pacote em que o require morre — e no clone tudo passa.
  const incluidas = new Set(PKG.files);
  const fora = [];
  for (const alvo of Object.values(PKG.exports)) {
    const raiz = alvo.replace(/^\.\//, '').split('/')[0];
    if (raiz === 'package.json') continue;      // o npm sempre empacota o package.json
    if (!incluidas.has(raiz)) fora.push(`${alvo} (a lista files não tem '${raiz}')`);
  }
  assert.deepStrictEqual(fora, [], `o pacote publicado não levaria:\n  ${fora.join('\n  ')}`);
});

test('o que o `files` NÃO leva é deliberado, e o pacote fica pequeno', () => {
  // A medida que decidiu a lista: sem `files`, o npm empacota a árvore inteira — 1,9 MB por app
  // instalado, contra ~490 KB. Se alguém acrescentar `docs` ou `templates` aqui sem querer, o
  // custo volta calado.
  for (const pesada of ['docs', 'templates', 'examples', 'tests', '.github']) {
    assert.ok(!PKG.files.includes(pesada),
      `'${pesada}' entrou no files — é ~1,4 MB de coisa que app nenhum importa`);
  }
});
