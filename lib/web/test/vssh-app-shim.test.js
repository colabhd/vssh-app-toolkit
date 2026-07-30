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

function run(win, pathname) {
  const warnings = [];
  const sandbox = {
    window: win,
    location: { pathname, origin: 'https://portal', search: '' },
    console: { log: () => {}, error: () => {}, info: () => {}, warn: (m) => warnings.push(String(m)) },
    setTimeout, clearTimeout, Map, Set, btoa, atob, Promise,
  };
  vm.runInContext(require('node:fs').readFileSync(SRC, 'utf8'), vm.createContext(sandbox));
  return warnings;
}

function loadShim({ pathname = '/srv1/proxy/app/meu-app/' } = {}) {
  const sent = [];
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    parent: { postMessage: (m) => sent.push(m) },
  };
  const warnings = run(win, pathname);

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
  return { vssh: win.vssh, sent, warnings, reply };
}

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

test('fora do desktop, os seletores devolvem null em vez de lançar', async () => {
  // window.parent === window é como o shim detecta "estou rodando standalone, em dev".
  const win = { addEventListener: () => {} };
  win.parent = win;
  run(win, '/');

  assert.equal(win.vssh.inDesktop, false);
  assert.equal(await win.vssh.pickFile(), null);
  assert.equal(await win.vssh.pickDirectory(), null);
});
