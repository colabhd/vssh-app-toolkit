// O arraste de arquivo entre o ambiente e um app — o contrato, exercitado nas duas pontas.
//
// ─── O que este contrato é ───────────────────────────────────────────────────
//
// UM tipo MIME, com os caminhos absolutos separados por linha. Ele existia no ambiente desde
// sempre — o gerenciador de arquivos e a área de trabalho já o escrevem no `dataTransfer` — e era
// **constante interna do shell**: um app não tinha como saber que existe. Publicá-lo é o item
// inteiro, e as três direções caem dele:
//
//   ambiente → app     o app é servido na MESMA origem, então o iframe recebe o próprio `drop` e
//                      lê o `dataTransfer` direto. O shell não está no caminho.
//   app → ambiente     o app escreve o mesmo tipo e AVISA o shell, porque todo alvo de soltura do
//                      ambiente abre o portão num estado de módulo do documento dele.
//   app → app          cai de graça das outras duas — e é o caso medido aqui, porque ele é a prova
//                      de que o contrato é UM, e não três integrações.
//
// ─── Por que executando ──────────────────────────────────────────────────────
//
// Porque o modo de falha deste contrato não deixa rastro. Se o `dragover` não chamar
// `preventDefault`, o navegador entende que o alvo recusa a soltura: **o `drop` nunca acontece** —
// sem erro, sem log, com o cursor de "proibido" e mais nada. Uma guarda de texto veria o ouvinte
// instalado e ficaria verde sobre um app onde nada cai.
//
// O `DataTransfer` de mentira é o do navegador em vinte linhas, com a regra que importa: `getData`
// devolve o que `setData` escreveu, e `types` lista o que foi escrito — que é a diferença entre
// decidir aceitar (olha `types`) e ler (olha o conteúdo).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web', 'vssh-app-shim.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// ─── O navegador, no mínimo que o contrato toca ──────────────────────────────

function dataTransferFalso() {
  const dados = new Map();
  return {
    dropEffect: 'none', effectAllowed: 'uninitialized',
    get types() { return [...dados.keys()]; },
    setData(t, v) { dados.set(t, String(v)); },
    getData(t) { return dados.get(t) ?? ''; },
  };
}

function documentoFalso() {
  const ouvintes = new Map();
  return {
    addEventListener(t, fn) { (ouvintes.get(t) || ouvintes.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { ouvintes.get(t)?.delete(fn); },
    quantos(t) { return ouvintes.get(t)?.size || 0; },
    disparar(t, ev) { for (const fn of [...(ouvintes.get(t) || [])]) fn(ev); },
    createElement: () => ({ style: {}, addEventListener() {}, append() {}, appendChild() {} }),
    querySelectorAll: () => [],
    documentElement: {},
  };
}

/**
 * Carrega o shim como o navegador o carrega, com o app DENTRO do desktop (`parent !== window`), e
 * devolve `{ vssh, postados, doc }`.
 *
 * O shim se publica em `window.vssh`; o `window` de mentira é quem o recebe.
 */
function carregarShim({ noDesktop = true } = {}) {
  const doc = documentoFalso();
  const postados = [];
  const pai = { postMessage: (m) => postados.push(m) };
  const win = {
    addEventListener() {}, removeEventListener() {},
    // `pathname` é lido na carga (o shim deriva o serverId do primeiro segmento), então não é
    // enfeite: sem ele o módulo nem termina de carregar.
    location: { origin: 'https://exemplo', pathname: '/srv1/proxy/app/exemplo/' },
    document: doc,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    navigator: {}, console,
  };
  win.parent = noDesktop ? pai : win;
  win.self = win;

  new Function('window', 'document', 'location', 'navigator', 'console',
               'setTimeout', 'clearTimeout', 'setInterval', 'AudioNode', 'atob', 'btoa',
    SHIM)(win, doc, win.location, win.navigator, console,
          win.setTimeout, win.clearTimeout, win.setInterval, undefined, undefined, undefined);

  assert.ok(win.vssh, 'o shim não se publicou em window.vssh');
  return { vssh: win.vssh, postados, doc };
}

const evento = (tipo, dt) => {
  const e = { type: tipo, dataTransfer: dt, clientX: 12, clientY: 34, target: null, barrou: false };
  e.preventDefault = () => { e.barrou = true; };
  return e;
};

// ─── O contrato ──────────────────────────────────────────────────────────────

test('o tipo é o MESMO literal que o ambiente escreve', () => {
  // A ÚNICA comparação com constante desta suíte, e ela existe por um motivo que nenhum teste de
  // comportamento cobre: o outro lado do contrato mora noutro repositório, sem CI cruzado. Cada
  // lado fica verde sozinho com o literal errado — e a divergência não acende, não cai e não loga
  // em ponta nenhuma, porque o tipo simplesmente não aparece em `dataTransfer.types`.
  const { vssh } = carregarShim();
  assert.equal(vssh.ARQUIVOS_MIME, 'application/x-vssh-files',
    'o tipo mudou aqui e o vssh-sso não sabe: todo arraste entre ambiente e apps morre em silêncio');
});

test('o que um app arrasta, outro app lê — o contrato é UM', () => {
  // A terceira direção, e a prova de que não são três integrações: A escreve, B lê, e ninguém no
  // meio precisa saber de nada.
  const a = carregarShim();
  const b = carregarShim();

  const dt = dataTransferFalso();
  assert.equal(a.vssh.arrastarArquivos(dt, ['/home/u/nota.md', '/home/u/foto.png']), true);

  const caiu = [];
  b.vssh.onArquivosSoltos((info) => caiu.push(info));
  b.doc.disparar('dragover', evento('dragover', dt));
  b.doc.disparar('drop', evento('drop', dt));

  assert.equal(caiu.length, 1, 'o que um app escreveu não chegou ao outro');
  assert.deepEqual(caiu[0].caminhos, ['/home/u/nota.md', '/home/u/foto.png']);
});

test('sem o preventDefault no dragover o drop NÃO acontece — e é o modo de falha mudo', () => {
  const { vssh, doc } = carregarShim();
  vssh.onArquivosSoltos(() => {});

  const dt = dataTransferFalso();
  dt.setData('application/x-vssh-files', '/home/u/a.md');
  const sobre = evento('dragover', dt);
  doc.disparar('dragover', sobre);

  assert.equal(sobre.barrou, true,
    'o dragover não barrou o padrão: o navegador recusa a soltura, e o gesto morre sem erro nenhum');
  assert.equal(dt.dropEffect, 'copy', 'sem dropEffect o cursor não diz que ali pode soltar');
});

test('um arraste que NÃO é do ambiente passa direto', () => {
  // Uma guarda que só cobra o caso positivo fica verde com um app que sequestra todo arraste da
  // página — inclusive o de texto dele mesmo.
  const { vssh, doc } = carregarShim();
  const caiu = [];
  vssh.onArquivosSoltos((i) => caiu.push(i));

  const dt = dataTransferFalso();
  dt.setData('text/plain', 'só um texto');
  const sobre = evento('dragover', dt);
  doc.disparar('dragover', sobre);
  doc.disparar('drop', evento('drop', dt));

  assert.equal(sobre.barrou, false, 'o app barrou um arraste que não é dele');
  assert.equal(caiu.length, 0);
});

test('desligar desliga de verdade — o ouvinte fica no documento', () => {
  const { vssh, doc } = carregarShim();
  const desligar = vssh.onArquivosSoltos(() => {});
  assert.equal(doc.quantos('drop'), 1);
  desligar();
  assert.equal(doc.quantos('drop'), 0, 'cancelar não removeu o ouvinte: ele acumula a cada chamada');
});

// ─── O aviso ao shell, que é o que faz a saída existir ───────────────────────

test('arrastar avisa o shell no início E no fim', () => {
  // O fim é obrigatório porque `dragend` não atravessa documentos: o shell limpa o estado de
  // arraste no `drop`/`dragend` do documento DELE, e um gesto que começa e termina dentro do
  // iframe nunca chega lá. Sem o aviso, todo alvo do ambiente fica aceso para um arraste que já
  // acabou.
  const { vssh, postados, doc } = carregarShim();
  vssh.arrastarArquivos(dataTransferFalso(), ['/home/u/a.md']);

  const arrastes = postados.filter((m) => m.type === 'arraste');
  assert.deepEqual(arrastes.map((m) => m.fase), ['inicio']);
  assert.deepEqual(arrastes[0].caminhos, ['/home/u/a.md']);

  doc.disparar('dragend', evento('dragend', null));
  assert.deepEqual(postados.filter((m) => m.type === 'arraste').map((m) => m.fase),
    ['inicio', 'fim'], 'o shell nunca soube que o arraste terminou');
});

test('o ouvinte de fim é de UMA vez — dois arrastes não deixam dois pendurados', () => {
  const { vssh, doc } = carregarShim();
  vssh.arrastarArquivos(dataTransferFalso(), ['/a']);
  doc.disparar('dragend', evento('dragend', null));
  vssh.arrastarArquivos(dataTransferFalso(), ['/b']);
  assert.equal(doc.quantos('dragend'), 1,
    'cada arraste deixou um ouvinte para trás — o shell recebe N "fim" pelo mesmo gesto');
});

test('caminho que não é absoluto não vira arraste', () => {
  // O que viaja aqui é caminho de disco do usuário. Um relativo não significa nada do outro lado,
  // e mandar assim mesmo seria pedir ao ambiente que adivinhe a partir de quê.
  const { vssh, postados } = carregarShim();
  const dt = dataTransferFalso();
  assert.equal(vssh.arrastarArquivos(dt, ['nota.md', '']), false);
  assert.equal(dt.types.length, 0, 'escreveu no dataTransfer um caminho que o ambiente não resolve');
  assert.equal(postados.filter((m) => m.type === 'arraste').length, 0);
});

test('fora do desktop, arrastar continua funcionando entre janelas do próprio app', () => {
  // Desenvolver o app fora do VSSH é um caso declarado do shim: o que falta é o aviso ao shell, que
  // não existe para ser ouvido — e não a escrita no dataTransfer, que é do navegador.
  const { vssh, postados } = carregarShim({ noDesktop: false });
  const dt = dataTransferFalso();
  assert.equal(vssh.arrastarArquivos(dt, ['/home/u/a.md']), true);
  assert.equal(dt.getData('application/x-vssh-files'), '/home/u/a.md');
  assert.equal(postados.length, 0);
});
