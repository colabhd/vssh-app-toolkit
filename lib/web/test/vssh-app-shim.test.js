'use strict';

// Testes do vssh-app-shim fora do navegador. O foco é `urlFor()`, que é a peça em que a
// renderização de imagem/PDF de um app portado se apoia: ela precisa ser SÍNCRONA (a assinatura de
// URL.createObjectURL é), sair só do caminho, e carregar autorização sozinha — um `<img src>` não
// passa por fetch e não aceita header.

const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const SRC = path.join(__dirname, '..', 'vssh-app-shim.js');

// `document` só entra quando o teste pede: sem ele o espelho de título não liga, que é
// exatamente o que queremos nos testes que não são sobre título.
function fakeDocument() {
  const observers = [];
  const titleEl = {};
  const doc = {
    title: 'inicial',
    head: { tag: 'head' },
    querySelector: (sel) => (sel === 'title' ? titleEl : null),
    addEventListener: () => {},
  };
  // Um MutationObserver que o teste dispara à mão — o real observa o DOM, que aqui não existe.
  doc.__flush = () => { for (const cb of observers) cb(); };
  doc.__Observer = class { constructor(cb) { observers.push(cb); } observe() {} };
  return doc;
}

function run(win, pathname, doc = null) {
  const warnings = [];
  const sandbox = {
    window: win,
    location: { pathname, origin: 'https://portal', search: '' },
    console: { log: () => {}, error: () => {}, info: () => {}, warn: (m) => warnings.push(String(m)) },
    setTimeout, clearTimeout, Map, Set, btoa, atob, Promise,
  };
  if (doc) { sandbox.document = doc; sandbox.MutationObserver = doc.__Observer; }
  vm.runInContext(require('node:fs').readFileSync(SRC, 'utf8'), vm.createContext(sandbox));
  return warnings;
}

function loadShim({ pathname = '/srv1/proxy/app/meu-app/', doc = null } = {}) {
  const sent = [];
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    parent: { postMessage: (m) => sent.push(m) },
  };
  const warnings = run(win, pathname, doc);

  // Entrega uma resposta do shell pelo mesmo caminho que o shim escuta.
  const reply = (requestId, value, ok = true) => {
    for (const fn of listeners) {
      fn({
        origin: 'https://portal',
        source: win.parent,
        data: { vsshApp: true, type: 'result', requestId, ok, value },
      });
    }
  };
  // O push de grants do shell: mão única, sem requestId.
  const pushGrants = (paths) => {
    for (const fn of listeners) {
      fn({
        origin: 'https://portal',
        source: win.parent,
        data: { vsshApp: true, type: 'grants', paths },
      });
    }
  };
  return { vssh: win.vssh, sent, warnings, reply, pushGrants, doc };
}

// ── Título, janela e menu: a superfície "semi-Electron" ────────────────────

test('trocar document.title repassa o título para a janela do shell, sem o app pedir', () => {
  // É o que faz um app portado funcionar sem uma linha nova: o mesmo código que dá título à aba
  // do navegador dá título à janela do desktop. O shell lia o título uma vez, no load do iframe.
  const doc = fakeDocument();
  const { sent } = loadShim({ doc });

  doc.title = 'Meu documento — Editor';
  doc.__flush();

  const msg = sent.filter((m) => m.type === 'title').pop();
  assert.equal(msg?.title, 'Meu documento — Editor');
});

test('título que não mudou não vira mensagem', () => {
  const doc = fakeDocument();
  const { sent } = loadShim({ doc });
  const before = sent.filter((m) => m.type === 'title').length;
  doc.__flush();
  doc.__flush();
  assert.equal(sent.filter((m) => m.type === 'title').length, before);
});

test('contextMenu manda só dados e devolve o id escolhido', async () => {
  const { vssh, sent, reply } = loadShim();
  const pending = vssh.contextMenu(10, 20, [
    { id: 'rename', label: 'Renomear', icon: 'edit' },
    { separator: true },
    { id: 'del', label: 'Excluir', danger: true },
  ]);

  const req = sent.find((m) => m.type === 'context-menu');
  assert.ok(req);
  assert.deepEqual([req.x, req.y], [10, 20]);
  // Nada de função atravessa a ponte — o shell é quem monta o menu.
  assert.ok(req.items.every((it) => Object.values(it).every((v) => typeof v !== 'function')));

  reply(req.requestId, 'del');
  assert.equal(await pending, 'del');
});

test('controles de janela são fire-and-forget, não pedem resposta', () => {
  const { vssh, sent } = loadShim();
  vssh.window.minimize();
  vssh.window.close();
  const ops = sent.filter((m) => m.type === 'window');
  assert.deepEqual(ops.map((m) => m.op), ['minimize', 'close']);
  assert.ok(ops.every((m) => m.requestId === undefined), 'sem requestId = sem promise pendurada');
});

test('urlFor monta a URL do portal a partir do serverId do próprio path', () => {
  const { vssh } = loadShim();
  // O serverId é o 1º segmento do path, disponível de imediato e sem handshake — que é o que
  // permite a esta função responder de forma síncrona.
  assert.equal(
    vssh.fs.urlFor('/home/user/graf/foto.png'),
    '/srv1/api/fs/read?path=%2Fhome%2Fuser%2Fgraf%2Ffoto.png',
  );
});

test('urlFor avisa quando o caminho não passou por um seletor', () => {
  const { vssh, warnings } = loadShim();
  vssh.fs.urlFor('/etc/passwd');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fora do que o usuário escolheu/);
});

test('escolher no seletor concede o caminho, e o que está sob ele não avisa', async () => {
  const { vssh, sent, warnings, reply } = loadShim();

  const pending = vssh.pickDirectory();
  const req = sent.find((m) => m.type === 'pick');
  assert.ok(req, 'o pick precisa ter sido enviado ao shell');
  reply(req.requestId, '/home/user/graf');
  assert.equal(await pending, '/home/user/graf');

  vssh.fs.urlFor('/home/user/graf/sub/foto.png');
  assert.equal(warnings.length, 0, 'caminho sob o diretório escolhido não avisa');

  vssh.fs.urlFor('/home/outro/x.png');
  assert.equal(warnings.length, 1, 'fora dele, avisa');
});

// ── Grants que sobrevivem à sessão ─────────────────────────────────────────
//
// O polyfill guarda o handle do diretório no IndexedDB do app para ele reabrir o mesmo grafo
// depois de um reload. Enquanto o grant morresse junto com a janela, o app voltava com um handle
// que não podia usar e era negado na primeira operação. Persistência de handle sem persistência
// de grant é a assimetria, e estes testes travam o par.

test('o shim pede os grants ao carregar, sem esperar o push do shell', () => {
  const { sent } = loadShim();
  const req = sent.find((m) => m.type === 'grants');
  assert.ok(req, 'sem isto, urlFor() avisaria em falso até o load do iframe chegar');
  assert.equal(req.path, undefined, 'sem path = "me dê a lista"');
});

test('grants empurrados pelo shell valem para urlFor sem passar por seletor nenhum', () => {
  // É o caso do reload: o usuário escolheu numa sessão anterior, não nesta.
  const { vssh, warnings, pushGrants } = loadShim();
  pushGrants(['/home/user/graf']);

  vssh.fs.urlFor('/home/user/graf/foto.png');
  assert.equal(warnings.length, 0, 'grant restaurado tem de valer igual a um recém-escolhido');
});

test('o push substitui a lista — revogar no shell apaga aqui', () => {
  const { vssh, warnings, pushGrants } = loadShim();
  pushGrants(['/home/user/graf']);
  vssh.fs.urlFor('/home/user/graf/a.png');
  assert.equal(warnings.length, 0);

  pushGrants([]);   // usuário revogou em "Permissões de arquivo"
  vssh.fs.urlFor('/home/user/graf/a.png');
  assert.equal(warnings.length, 1, 'o espelho não pode acumular; o shell é a fonte da verdade');
});

test('isGranted pergunta ao shell em vez de ler o espelho local', async () => {
  const { vssh, sent, reply } = loadShim();
  const pending = vssh.fs.isGranted('/home/user/graf');
  const req = sent.find((m) => m.type === 'grants' && m.path);
  // Ler o espelho seria síncrono e barato — e erraria enquanto ele não tivesse chegado, fazendo
  // o app pedir ao usuário uma permissão que ele já deu.
  assert.ok(req, 'precisa consultar quem decide');
  reply(req.requestId, true);
  assert.equal(await pending, true);
});

test('fora do desktop, os seletores devolvem null em vez de lançar', async () => {
  // window.parent === window é como o shim detecta "estou rodando standalone, em dev".
  const win = { addEventListener: () => {} };
  win.parent = win;
  run(win, '/');

  assert.equal(win.vssh.inDesktop, false);
  assert.equal(await win.vssh.pickFile(), null);
  assert.equal(await win.vssh.pickDirectory(), null);
});
