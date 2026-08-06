'use strict';

// O `.d.ts` declara exatamente a superfície que o shim expõe — nem mais, nem menos.
//
// Um arquivo de tipos que envelhece é PIOR que nenhum, e a razão é específica: ele mente para o
// compilador e para o editor ao mesmo tempo, com a autoridade de quem parece ter sido verificado.
// Nas duas direções o estrago é real e silencioso:
//
//   membro que existe e não está declarado  → o app escreve `vssh.print(…)` e o TypeScript recusa
//                                             compilar algo que funcionaria. A pessoa conclui que
//                                             a API não existe e escreve um contorno.
//   membro declarado que não existe          → o editor autocompleta, o build passa, e quebra em
//                                             produção com `undefined is not a function`.
//
// Por isso a conferência é de junção e é dupla: a superfície REAL é enumerada em runtime (não
// lida por regex do JavaScript, que erraria), e o `.d.ts` é lido do arquivo. Um teste que só
// olhasse um dos lados aprovaria os dois estados acima.
//
// O `.d.ts` é conferido pela estrutura, não por compilação: o toolkit não tem dependência npm, e
// trazer o `typescript` só para isto custaria mais do que ele mede. O que uma compilação pegaria a
// mais são os TIPOS dos argumentos; o que quebra na prática, e o que este teste pega, é membro
// faltando ou sobrando.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const WEB = path.join(__dirname, '..');

// ── A superfície REAL, enumerada em runtime ──────────────────────────────────

function superficieReal() {
  const win = {
    addEventListener() {}, removeEventListener() {},
    // `parent !== window` é o que faz o shim se considerar dentro do desktop — e é lá que a
    // superfície é completa. Enumerar fora do desktop mediria o modo degradado.
    parent: { postMessage() {} },
    matchMedia: () => ({ matches: false }),
  };
  const sandbox = {
    window: win,
    document: { title: 't', head: {}, querySelector: () => null, addEventListener() {} },
    location: { pathname: '/srv1/proxy/app/x/', origin: 'https://p', search: '' },
    navigator: { clipboard: { read() {}, write() {} } },
    console: { log() {}, warn() {}, info() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0,
    Map, Set, WeakMap, btoa, atob, Promise, Object, Error,
  };
  vm.runInContext(fs.readFileSync(path.join(WEB, 'vssh-app-shim.js'), 'utf8'), vm.createContext(sandbox));

  const arvore = {};
  for (const chave of Object.keys(win.vssh)) {
    const v = win.vssh[chave];
    arvore[chave] = (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort() : null;
  }
  return arvore;
}

// ── O que o `.d.ts` declara ──────────────────────────────────────────────────

const DTS = fs.readFileSync(path.join(WEB, 'vssh-app-shim.d.ts'), 'utf8');

/** Corpo de `interface Nome { … }`, respeitando chaves aninhadas nos tipos. */
function corpoDaInterface(nome) {
  const abre = DTS.indexOf(`interface ${nome} {`);
  if (abre < 0) return null;
  let i = DTS.indexOf('{', abre);
  let profundidade = 0;
  for (let j = i; j < DTS.length; j++) {
    if (DTS[j] === '{') profundidade++;
    else if (DTS[j] === '}') {
      profundidade--;
      if (profundidade === 0) return DTS.slice(i + 1, j);
    }
  }
  return null;
}

/**
 * Membros declarados numa interface, e o tipo de cada um quando ele é um nome simples.
 *
 * A varredura é por PROFUNDIDADE: só linhas no nível de topo do corpo contam. Sem isso, os campos
 * de um tipo inline (`{ dot: true }`) entrariam como se fossem membros da interface.
 */
function membros(nome) {
  const corpo = corpoDaInterface(nome);
  if (corpo === null) return null;

  const saida = new Map();
  let profundidade = 0;
  for (const linhaBruta of corpo.split('\n')) {
    const linha = linhaBruta.trim();
    const antes = profundidade;
    for (const c of linha) {
      if (c === '{' || c === '(') profundidade++;
      else if (c === '}' || c === ')') profundidade--;
    }
    if (antes !== 0) continue;                          // dentro de um tipo inline
    if (!linha || linha.startsWith('//') || linha.startsWith('*') || linha.startsWith('/*')) continue;
    if (linha.startsWith('[')) continue;                // assinatura de índice: não é membro nomeado

    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*([(:])\s*(.*)$/.exec(linha);
    if (!m) continue;
    const [, campo, sinal, resto] = m;
    // `nome: OutroTipo;` é o que permite descer; método e tipo inline não descem.
    const tipo = sinal === ':' ? (/^([A-Za-z_$][\w$]*)\s*;/.exec(resto)?.[1] ?? null) : null;
    saida.set(campo, tipo);
  }
  return saida;
}

// ── A conferência ────────────────────────────────────────────────────────────

test('o .d.ts declara a raiz `vssh` inteira, e só ela', () => {
  const real = superficieReal();
  const declarado = membros('Vssh');
  assert.ok(declarado, 'não achei `interface Vssh` no .d.ts');

  const faltando = Object.keys(real).filter((k) => !declarado.has(k)).sort();
  const sobrando = [...declarado.keys()].filter((k) => !(k in real)).sort();

  assert.deepEqual(faltando, [],
    'o shim expõe isto e o .d.ts não declara — o TypeScript vai recusar código que funciona');
  assert.deepEqual(sobrando, [],
    'o .d.ts declara isto e o shim não expõe — o editor autocompleta algo que quebra em produção');
});

test('cada objeto aninhado do shim tem interface própria, com os mesmos membros', () => {
  const real = superficieReal();
  const raiz = membros('Vssh');
  const aninhados = Object.entries(real).filter(([, filhos]) => filhos !== null);

  // Se um dia não houver nenhum, este teste virou decoração e passaria vazio para sempre.
  assert.ok(aninhados.length >= 6, `só ${aninhados.length} objetos aninhados — a superfície mudou de forma`);

  for (const [nome, filhosReais] of aninhados) {
    const tipo = raiz.get(nome);
    assert.ok(tipo, `\`vssh.${nome}\` é um objeto, e o .d.ts o declara sem um tipo nomeado`);

    const filhosDeclarados = membros(tipo);
    assert.ok(filhosDeclarados, `o .d.ts cita o tipo \`${tipo}\` para \`vssh.${nome}\` e não o define`);

    assert.deepEqual(
      filhosReais.filter((k) => !filhosDeclarados.has(k)), [],
      `\`vssh.${nome}\` expõe membros que \`${tipo}\` não declara`);
    assert.deepEqual(
      [...filhosDeclarados.keys()].filter((k) => !filhosReais.includes(k)), [],
      `\`${tipo}\` declara membros que \`vssh.${nome}\` não tem`);
  }
});

test('o .d.ts é global, não um módulo — o shim entra por tag <script>', () => {
  // Um `export` ou `import` de topo transformaria o arquivo em módulo, e aí NADA dele seria
  // visível globalmente: o app carrega o shim por `<script>` e usa `vssh` cru. O sintoma seria
  // "os tipos não funcionam", sem nada apontando para cá.
  const semComentarios = DTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(semComentarios, /^\s*(export|import)\s/m,
    'declaração de módulo: os tipos deixariam de ser globais');
  assert.match(semComentarios, /declare const vssh: Vssh;/,
    'sem o global `vssh`, só `window.vssh` teria tipo');
  assert.match(semComentarios, /interface Window\s*\{[^}]*vssh: Vssh/,
    'sem aumentar `Window`, `window.vssh` fica sem tipo');
});

test('o package.json aponta os tipos, senão ninguém os acha', () => {
  // Vendorizado, o `.d.ts` é achado por estar ao lado do `.js` — mas quem consumir o toolkit como
  // pacote depende deste campo. Declarar o caminho errado é o mesmo que não declarar.
  const pkg = JSON.parse(fs.readFileSync(path.join(WEB, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.types, 'package.json sem `types`');
  assert.ok(fs.existsSync(path.join(WEB, '..', '..', pkg.types)),
    `package.json aponta types: "${pkg.types}", que não existe`);
});
