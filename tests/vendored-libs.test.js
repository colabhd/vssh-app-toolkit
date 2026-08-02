// As cópias vendorizadas em templates/*/vendor/vssh/ têm de ser IGUAIS a lib/.
//
// Por que isto vira teste em vez de disciplina: a cópia envelhece em silêncio. Ela
// não quebra nada no repositório — o CI roda os testes contra `lib/`, e o smoke do
// template sobe o backend e passa — mas o que vai para o servidor é a CÓPIA. O
// resultado é um template que demonstra uma API antiga e um app real carregando um
// bug já consertado.
//
// Não é hipótese. Quando este teste foi escrito, dois arquivos estavam atrasados:
//
//   - `static-spa.js` sem a canonicalização com `realpathSync.native` — exatamente o
//     bug de nome curto 8.3 que o cabeçalho do ci.yml narra como achado importante.
//     O conserto entrou em lib/ e nunca chegou ao template;
//   - `electron-shim.js` sem a `Notification` roteada para o toast do shell.
//
// Nenhum dos dois deu sinal. Foram descobertos por acaso, meses depois, procurando
// outra coisa.
//
// O conserto é sempre o mesmo, e é o caminho documentado — nunca um `cp` à mão:
//
//   bash scripts/vssh-app-lib-sync templates/<app> --parts spa,log,sse --dest backend/vendor/vssh
//   bash scripts/vssh-app-lib-sync templates/<app> --parts web         --dest frontend/vendor/vssh

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIB  = path.join(ROOT, 'lib');

// Mapa parte → o que o vssh-app-lib-sync copia. Espelha o bloco `want ...` do script.
// Se os dois divergirem, este teste falha — que é o resultado certo: uma parte que o
// script copia e o teste não conhece é uma parte que ninguém está conferindo.
const PARTS = {
  fs:  { dir: 'node/vssh-app-fs' },
  spa:  { file: 'node/static-spa.js' },
  log:  { file: 'node/app-log.js' },
  sse:  { file: 'node/sse.js' },
  tray: { file: 'node/vssh-tray.js' },
  web: { dir: 'web' },
};

/** Todos os arquivos sob `dir`, como caminhos relativos a ele. Diretório ausente → []. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      e.isDirectory() ? walk(path.join(d, e.name), rel) : out.push(rel);
    }
  })(dir, '');
  return out;
}

/** Cada `vendor/vssh/` dos templates, com as partes que ele declara ter. */
function vendorDirs() {
  const found = [];
  const templates = path.join(ROOT, 'templates');
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.name === 'vssh' && path.basename(d) === 'vendor') {
        const marker = path.join(p, '.vssh-lib-version');
        const parts = fs.existsSync(marker)
          ? (fs.readFileSync(marker, 'utf8').match(/^parts=(.*)$/m)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean)
          : [];
        found.push({ dir: p, rel: path.relative(ROOT, p).replace(/\\/g, '/'), parts });
        continue;                       // não desce: o conteúdo é conferido em bloco
      }
      walk(p);
    }
  })(templates);
  return found;
}

const VENDORS = vendorDirs();

test('há cópias vendorizadas para conferir', () => {
  // Se um dia não houver nenhuma, este arquivo virou decoração e passaria vazio para
  // sempre — um teste que não pode falhar é pior que teste nenhum.
  assert.ok(VENDORS.length > 0, 'nenhum templates/**/vendor/vssh encontrado');
});

for (const v of VENDORS) {
  test(`${v.rel}: declara procedência e partes`, () => {
    assert.ok(fs.existsSync(path.join(v.dir, '.vssh-lib-version')),
      'sem .vssh-lib-version — não dá para saber de onde a cópia veio nem o que deveria ter');
    assert.ok(v.parts.length > 0, 'o marcador não declara `parts=`');
    for (const p of v.parts) {
      assert.ok(p === 'all' || PARTS[p], `parte desconhecida '${p}' — o teste e o vssh-app-lib-sync divergiram`);
    }
  });

  test(`${v.rel}: todo arquivo copiado é IGUAL ao de lib/`, () => {
    const stale = [];
    for (const rel of filesUnder(v.dir)) {
      if (rel === '.vssh-lib-version') continue;   // é o carimbo, não vem de lib/
      const src = path.join(LIB, rel);
      if (!fs.existsSync(src)) {
        stale.push(`${rel}: não existe em lib/ (removido de lá, ou nunca esteve)`);
        continue;
      }
      if (!fs.readFileSync(src).equals(fs.readFileSync(path.join(v.dir, rel)))) {
        stale.push(`${rel}: cópia desatualizada`);
      }
    }
    assert.deepStrictEqual(stale, [],
      `cópia divergente de lib/ — rode o vssh-app-lib-sync (ver o topo deste arquivo):\n  ${stale.join('\n  ')}`);
  });

  test(`${v.rel}: não falta nada do que as partes declaram`, () => {
    // O outro lado do problema: um arquivo NOVO em lib/ que nunca foi vendorizado. O
    // app carrega a tag, o servidor devolve 404 e o sintoma aparece longe da causa —
    // foi assim que o shim já sumiu uma vez do template (ver o smoke no ci.yml).
    const missing = [];
    const parts = v.parts.includes('all') ? Object.keys(PARTS) : v.parts;
    for (const p of parts) {
      const spec = PARTS[p];
      const rels = spec.file ? [spec.file] : filesUnder(path.join(LIB, spec.dir)).map(r => `${spec.dir}/${r}`);
      for (const rel of rels) {
        if (!fs.existsSync(path.join(v.dir, rel))) missing.push(`${rel} (parte '${p}')`);
      }
    }
    assert.deepStrictEqual(missing, [],
      `lib/ tem arquivo que a cópia não tem — rode o vssh-app-lib-sync:\n  ${missing.join('\n  ')}`);
  });
}
