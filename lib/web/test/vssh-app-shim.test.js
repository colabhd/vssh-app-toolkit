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

// ── Plataforma de áudio de mentira ──────────────────────────────────────────
//
// Duas coisas precisam existir para o shim ter o que envolver: o par de acessores
// `volume`/`muted` do HTMLMediaElement (é sobre eles que a multiplicação é montada) e o
// `AudioNode.prototype.connect`. Nenhum dos dois existe em Node, e imitá-los é o que permite
// medir a conta em vez de confiar nela.
function fakeAudio() {
  // O "hardware": o que sobrou depois de o shim escrever. É o que o teste observa.
  const HTMLMediaElement = function () {};
  Object.defineProperties(HTMLMediaElement.prototype, {
    volume: { configurable: true, get() { return this._realVol ?? 1; }, set(v) { this._realVol = v; } },
    muted:  { configurable: true, get() { return this._realMudo ?? false; }, set(v) { this._realMudo = v; } },
  });

  const nós = [];
  const AudioNode = function () {};
  AudioNode.prototype.connect = function (d) { nós.push(['connect', this, d]); return d; };
  AudioNode.prototype.disconnect = function (d) { nós.push(['disconnect', this, d]); };

  const criarCtx = (estado = 'running') => {
    const ctx = { state: estado };
    ctx.destination = Object.assign(new AudioNode(), { context: ctx, __nome: 'destination' });
    ctx.createGain = () => Object.assign(new AudioNode(), {
      context: ctx, __nome: 'gain', gain: { value: 1 },
    });
    return ctx;
  };

  const midia = (tag = 'AUDIO') => Object.assign(new HTMLMediaElement(), {
    tagName: tag, nodeType: 1, paused: true, ended: false,
  });

  return { HTMLMediaElement, AudioNode, criarCtx, midia, nós };
}

function run(win, pathname, doc = null, extras = null) {
  const warnings = [];
  const sandbox = {
    window: win,
    location: { pathname, origin: 'https://portal', search: '' },
    console: { log: () => {}, error: () => {}, info: () => {}, warn: (m) => warnings.push(String(m)) },
    setTimeout, clearTimeout, setInterval: () => 0, Map, Set, WeakMap,
    btoa, atob, Promise, Object, Error,
  };
  if (doc) { sandbox.document = doc; sandbox.MutationObserver = doc.__Observer; }
  // `navigator`/`document` de mentira para o clipboard de texto e imagem, que NÃO passa pela
  // ponte: ele fala com a plataforma daqui de dentro mesmo.
  if (extras) Object.assign(sandbox, extras);
  vm.runInContext(require('node:fs').readFileSync(SRC, 'utf8'), vm.createContext(sandbox));
  return warnings;
}

function loadShim({ pathname = '/srv1/proxy/app/meu-app/', doc = null, extras = null } = {}) {
  const sent = [];
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    // Sem isto o shim não consegue desassinar, e um watch cancelado seguiria entregando eventos.
    removeEventListener: (type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    parent: { postMessage: (m) => sent.push(m) },
  };
  const warnings = run(win, pathname, doc, extras);

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
  // Mudança de arquivo empurrada pelo shell, endereçada a uma assinatura.
  const pushChange = (watchId, path, closed = false) => {
    for (const fn of listeners) {
      fn({
        origin: 'https://portal',
        source: win.parent,
        data: { vsshApp: true, type: 'fs-change', watchId, path, closed },
      });
    }
  };
  // Clipboard de arquivos mudou — por fora do app, que é o caso que importa.
  const pushClipboard = (clipboard) => {
    for (const fn of listeners) {
      fn({
        origin: 'https://portal',
        source: win.parent,
        data: { vsshApp: true, type: 'clipboard-change', clipboard },
      });
    }
  };
  // O mixer da barra empurrando volume. Mão única: o app nunca pede.
  const pushVolume = (gain, muted = false) => {
    for (const fn of listeners) {
      fn({
        origin: 'https://portal',
        source: win.parent,
        data: { vsshApp: true, type: 'volume', gain, muted },
      });
    }
  };
  return { vssh: win.vssh, sent, warnings, reply, pushGrants, pushChange, pushClipboard, pushVolume, doc };
}

// ── Impressão ─────────────────────────────────────────────────────────────

test('print PEDE a tela e resolve quando ela abre, não quando o usuário imprime', async () => {
  // O app não imprime: ele pede. Esperar o usuário decidir prenderia o app numa promise de
  // ritmo humano — e ele não tem o que fazer com a resposta, porque quem escolhe destino e
  // confirma é o desktop.
  const { vssh, sent, reply } = loadShim();
  const p = vssh.print('/home/ana/relatorio.pdf', { name: 'relatorio.pdf' });
  const msg = sent[sent.length - 1];
  assert.equal(msg.type, 'print');
  assert.equal(msg.path, '/home/ana/relatorio.pdf');
  assert.equal(msg.name, 'relatorio.pdf');
  reply(msg.requestId, true);
  assert.equal(await p, true);
});

test('print devolve false quando o shell não conhece o tipo, em vez de pendurar', async (t) => {
  // Shell mais antigo que o shim não responde NADA. Sem timeout a promise ficaria pendurada
  // para sempre: não resolve, não rejeita, não deixa rastro — o pior modo de falha que existe.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { vssh } = loadShim();
  const p = vssh.print('/home/ana/x.pdf');
  t.mock.timers.tick(6000);
  assert.equal(await p, false);
});

test('print fora do desktop é false sem lançar', async () => {
  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  win.parent = win;
  run(win, '/');
  assert.equal(await win.vssh.print('/home/ana/x.pdf'), false);
});

// ── Clipboard ─────────────────────────────────────────────────────────────
//
// Duas metades por caminhos diferentes, e o teste existe em boa parte para fixar POR QUE:
// arquivos atravessam a ponte porque só o shell tem esse clipboard; texto e imagem não
// atravessam porque a ponte os quebraria — ativação transitória não sobrevive a postMessage.

test('o clipboard de ARQUIVOS atravessa a ponte, porque só o shell o tem', async () => {
  const { vssh, sent, reply } = loadShim();
  const p = vssh.clipboard.files();
  assert.equal(sent[sent.length - 1].type, 'clipboard');
  assert.equal(sent[sent.length - 1].op, 'files');
  reply(sent[sent.length - 1].requestId, { action: 'copy', paths: ['/home/ana/a.md'] });
  assert.deepEqual(await p, { action: 'copy', paths: ['/home/ana/a.md'] });
});

test('setFiles manda só string, e lista vazia não vira mensagem', async () => {
  const { vssh, sent, reply } = loadShim();
  const antes = sent.length;
  assert.equal(await vssh.clipboard.setFiles([]), false);
  assert.equal(await vssh.clipboard.setFiles([null, '', 42]), false);
  assert.equal(sent.length, antes, 'nada para copiar não custa uma ida ao shell');

  const p = vssh.clipboard.setFiles(['/home/ana/a.md', null, '/home/ana/b.md']);
  assert.deepEqual(sent[sent.length - 1].paths, ['/home/ana/a.md', '/home/ana/b.md']);
  reply(sent[sent.length - 1].requestId, 2);
  assert.equal(await p, true);
});

test('onChange ouve o que mudou por fora, e a função devolvida cancela', () => {
  const { vssh, pushClipboard } = loadShim();
  const vistos = [];
  const parar = vssh.clipboard.onChange(c => vistos.push(c));

  pushClipboard({ action: 'copy', paths: ['/x'] });
  pushClipboard(null);                              // o usuário limpou
  assert.deepEqual(vistos, [{ action: 'copy', paths: ['/x'] }, null]);

  parar();
  pushClipboard({ action: 'cut', paths: ['/y'] });
  assert.equal(vistos.length, 2, 'cancelar tem de cancelar de verdade');
});

test('fora do desktop o clipboard de arquivos degrada, não lança', async () => {
  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  win.parent = win;                                  // é assim que o shim detecta standalone
  run(win, '/');
  assert.equal(await win.vssh.clipboard.files(), null);
  assert.equal(await win.vssh.clipboard.setFiles(['/x']), false);
});

/** Um `navigator` de mentira que recusa do jeito que o navegador recusa. */
function comClipboard({ erro = null, itens = [], focado = true, ativo = true } = {}) {
  return {
    navigator: {
      clipboard: {
        read: async () => { if (erro) throw erro; return itens; },
        write: async () => { if (erro) throw erro; return true; },
      },
      userActivation: { isActive: ativo },
    },
    document: { hasFocus: () => focado, addEventListener: () => {} },
    ClipboardItem: class { constructor(o) { Object.assign(this, o); } },
  };
}

const naoPermitido = () => Object.assign(new Error('recusado'), { name: 'NotAllowedError' });

test('imagem NÃO passa pela ponte — e a falha vem com motivo, não genérica', async () => {
  // O motivo é o item. `NotAllowedError` genérico faz o autor do app abrir issue; "chame de
  // dentro do clique" faz ele consertar em dois minutos.
  const semGesto = loadShim({ extras: comClipboard({ erro: naoPermitido(), focado: false }) });
  // Delta, não total: o shim já pede os grants ao carregar, então a linha de base não é zero.
  const antes = semGesto.sent.length;
  await assert.rejects(() => semGesto.vssh.clipboard.readImage(), (e) => e.reason === 'no-user-activation');
  assert.equal(semGesto.sent.length, antes, 'a imagem não pode virar ida ao shell');

  // Com foco e ativação, o mesmo NotAllowedError quer dizer outra coisa: o usuário negou.
  const negado = loadShim({ extras: comClipboard({ erro: naoPermitido() }) });
  await assert.rejects(() => negado.vssh.clipboard.readImage(), (e) => e.reason === 'denied');
});

test('readImage devolve a primeira imagem, e null quando só há texto', async () => {
  const png = { tipo: 'blob' };
  const comImagem = loadShim({ extras: comClipboard({ itens: [
    { types: ['text/plain'], getType: async () => 'texto' },
    { types: ['text/html', 'image/png'], getType: async (t) => (t === 'image/png' ? png : 'html') },
  ] }) });
  assert.equal(await comImagem.vssh.clipboard.readImage(), png);

  const soTexto = loadShim({ extras: comClipboard({ itens: [{ types: ['text/plain'], getType: async () => 'x' }] }) });
  assert.equal(await soTexto.vssh.clipboard.readImage(), null, 'sem imagem é null, não erro');
});

test('navegador sem clipboard.read diz `unsupported`, não "falhou"', async () => {
  const { vssh } = loadShim({ extras: { navigator: {}, document: { hasFocus: () => true, addEventListener: () => {} } } });
  await assert.rejects(() => vssh.clipboard.readImage(), (e) => e.reason === 'unsupported');
});

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

test('abrir() PEDE a janela extra, e leva a rota que decide o que vai nela', async () => {
  // É a única op de janela que espera resposta, e é por isso que ela não está na lista acima: as
  // outras mexem no que já existe e não têm o que dar errado; esta pode ser recusada — por rota
  // inválida ou por um shell que ainda não a conhece — e o app precisa saber.
  const { vssh, sent, reply } = loadShim();
  const pendente = vssh.window.abrir('?painel=1', { title: 'Painel', width: 380, height: 330 });

  const req = sent.find((m) => m.type === 'window' && m.op === 'open');
  assert.ok(req, 'a janela extra não foi pedida ao shell');
  assert.equal(req.rota, '?painel=1');
  assert.equal(req.title, 'Painel');
  assert.equal(req.width, 380);
  assert.ok(req.requestId !== undefined, 'sem requestId não há como o shell dizer que recusou');

  reply(req.requestId, true);
  assert.equal(await pendente, true);
});

test('abrir() sem rota é a CÓPIA, e continua sendo um pedido válido', async () => {
  const { vssh, sent, reply } = loadShim();
  const pendente = vssh.window.abrir();
  const req = sent.find((m) => m.type === 'window' && m.op === 'open');
  assert.equal(req.rota, '', 'rota ausente tem de virar string vazia, não undefined');
  reply(req.requestId, true);
  assert.equal(await pendente, true);
});

test('um shell que recusa a janela extra devolve false, e não uma exceção', async () => {
  // Shell e apps são publicados à parte: um app novo contra um shell antigo é o caso comum, não o
  // exótico. `false` é "aqui não dá" — o app mostra o caminho alternativo em vez de estourar.
  const { vssh, sent, reply } = loadShim();
  const pendente = vssh.window.abrir('?painel=1');
  reply(sent[sent.length - 1].requestId, 'op de janela não suportada: open', false);
  assert.equal(await pendente, false);
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

// ─── T6: exists, rename e copy ──────────────────────────────────────────────

test('exists devolve booleano, e o shell é quem decide', async () => {
  const { vssh, sent, reply } = loadShim();
  const p = vssh.fs.exists('/casa/proj/a.md');
  const msg = sent[sent.length - 1];
  assert.equal(msg.type, 'fs');
  assert.equal(msg.op, 'exists');
  assert.equal(msg.path, '/casa/proj/a.md');
  reply(msg.requestId, { exists: false });
  assert.equal(await p, false);
});

test('exists NÃO transforma erro em "não existe"', async () => {
  // O idioma que todo mundo escreve — stat(p).catch(() => false) — colapsa TRÊS respostas em
  // duas: "não existe", "sem permissão" e "não consegui perguntar" saem todas como false. O app
  // então cria por cima de um arquivo que estava lá, ou conclui que a pasta do usuário está vazia
  // porque a rede piscou. A recusa tem de subir.
  const { vssh, sent, reply } = loadShim();
  const p = vssh.fs.exists('/casa/segredo/a.md');
  reply(sent[sent.length - 1].requestId, 'sem permissão', false);
  await assert.rejects(() => p, /sem permissão/);
});

test('rename e copy mandam os DOIS caminhos, e não sobrescrevem por padrão', async () => {
  const { vssh, sent, reply } = loadShim();

  vssh.fs.rename('/casa/proj/a.md', '/casa/proj/b.md');
  let msg = sent[sent.length - 1];
  assert.equal(msg.op, 'rename');
  assert.equal(msg.from, '/casa/proj/a.md');
  assert.equal(msg.to, '/casa/proj/b.md');
  // Perder um arquivo do usuário não tem desfazer: sobrescrever é opt-in explícito.
  assert.equal(msg.policy, 'fail');
  reply(msg.requestId, { ok: true });

  vssh.fs.copy('/casa/proj/b.md', '/casa/proj/c.md', { overwrite: true });
  msg = sent[sent.length - 1];
  assert.equal(msg.op, 'copy');
  assert.equal(msg.policy, 'overwrite');
  reply(msg.requestId, { ok: true });
});

test('rename/copy não mandam `path` — quem confere os dois é o shell', async () => {
  // O gate do shell lê os campos que cada op declara (`from`/`to` para estas duas). Mandar também
  // um `path` daria ao gate um caminho que a operação não usa — e um app poderia pôr ali algo
  // concedido para acompanhar dois que não são.
  const { vssh, sent, reply } = loadShim();
  vssh.fs.rename('/casa/proj/a.md', '/casa/proj/b.md');
  const msg = sent[sent.length - 1];
  assert.equal(msg.path, undefined, 'a mensagem carrega um `path` que o gate não deveria ver');
  reply(msg.requestId, { ok: true });
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

// ── "não" e "não sei" ──────────────────────────────────────────────────────

test('isGranted devolve null quando o shell recusa a pergunta, não false', async () => {
  const { vssh, sent, reply } = loadShim();
  const pending = vssh.fs.isGranted('/home/user/graf');
  const req = sent.find((m) => m.type === 'grants' && m.path);
  reply(req.requestId, 'tipo desconhecido', false);   // shell que não implementa `grants`
  // `false` mandaria o app desistir; `null` diz que não houve resposta, e quem chama decide.
  // Colapsar os dois escolhe a ação errada exatamente quando o canal está com problema.
  assert.equal(await pending, null);
});

test('isGranted fora do desktop é null, não false', async () => {
  const win = { addEventListener: () => {} };
  win.parent = win;
  run(win, '/');
  // Não existe sistema de grants fora do desktop — é "não sei", pelo mesmo motivo.
  assert.equal(await win.vssh.fs.isGranted('/qualquer'), null);
});

test('isGranted repassa o mode em vez de descartá-lo', async () => {
  const { vssh, sent } = loadShim();
  vssh.fs.isGranted('/home/user/graf', { mode: 'read' });
  assert.equal(sent.find((m) => m.type === 'grants' && m.path)?.mode, 'read');
});

// ── Watch ──────────────────────────────────────────────────────────────────

test('watch assina, recebe mudança, e a função devolvida cancela', async () => {
  const { vssh, sent, reply, pushChange } = loadShim();

  const vistos = [];
  const pending = vssh.fs.watch('/home/user/graf', (ev) => vistos.push(ev));
  const req = sent.find((m) => m.type === 'fs' && m.op === 'watch');
  assert.ok(req, 'o watch precisa chegar ao shell');
  assert.equal(req.path, '/home/user/graf');
  reply(req.requestId, { ok: true });
  const parar = await pending;

  pushChange(req.watchId, '/home/user/graf/nota.md');
  // Campo a campo: o objeto nasce dentro do contexto do shim, e deepEqual compararia protótipos
  // de realms diferentes.
  assert.equal(vistos.length, 1);
  assert.equal(vistos[0].path, '/home/user/graf/nota.md');
  assert.equal(vistos[0].closed, false);

  parar();
  const off = sent.find((m) => m.type === 'fs' && m.op === 'unwatch');
  assert.equal(off?.watchId, req.watchId, 'cancelar precisa avisar o shell');

  // Cada watch segura um vigia vivo no servidor: depois de cancelar, nada mais pode chegar.
  pushChange(req.watchId, '/home/user/graf/tarde.md');
  assert.equal(vistos.length, 1);
});

test('mudança de OUTRO watch não vaza para este', async () => {
  const { vssh, sent, reply, pushChange } = loadShim();
  const vistos = [];
  const pending = vssh.fs.watch('/a', (ev) => vistos.push(ev));
  const req = sent.find((m) => m.type === 'fs' && m.op === 'watch');
  reply(req.requestId, { ok: true });
  await pending;

  pushChange('outro-id', '/b/x.md');
  assert.equal(vistos.length, 0);
});

test('watch que o shell recusa não deixa listener pendurado', async () => {
  const { vssh, sent, reply, pushChange } = loadShim();
  const vistos = [];
  const pending = vssh.fs.watch('/negado', (ev) => vistos.push(ev));
  const req = sent.find((m) => m.type === 'fs' && m.op === 'watch');
  reply(req.requestId, 'sem permissão', false);
  await assert.rejects(() => pending);

  pushChange(req.watchId, '/negado/x.md');
  assert.equal(vistos.length, 0, 'assinatura que falhou não pode continuar escutando');
});

// ── Bandeja ────────────────────────────────────────────────────────────────

// Empurra um evento da bandeja do shell para o app: mão única, sem requestId — quem
// clica é o usuário, minutos depois do `set`, e não há requisição esperando por isso.
function pushTray(listeners, win, event, menuId) {
  for (const fn of listeners) {
    fn({
      origin: 'https://portal',
      source: win.parent,
      data: { vsshApp: true, type: 'tray-event', event, menuId },
    });
  }
}

test('tray.set manda só dados — onClick/onMenu não atravessam a ponte', async () => {
  const { vssh, sent, reply } = loadShim();
  const pending = vssh.tray.set({
    icon: 'refresh', tooltip: 'Sincronizando', badge: { count: 3 },
    menu: [{ id: 'pause', label: 'Pausar' }],
    onClick: () => {}, onMenu: () => {},
  });

  const req = sent.find((m) => m.type === 'tray');
  assert.equal(req.op, 'set');
  assert.equal(req.item.tooltip, 'Sincronizando');
  // Função não serializa: mandá-la viraria `undefined` no structured clone (ou uma
  // exceção), e o app acharia que registrou um callback que nunca dispara.
  assert.equal('onClick' in req.item, false);
  assert.equal('onMenu' in req.item, false);

  reply(req.requestId, true);
  assert.equal(await pending, true);
});

test('clique e menu voltam por push e chamam os callbacks certos', async () => {
  // Reconstroi o harness aqui porque este teste precisa da lista de listeners crua.
  const sent = [];
  const listeners = [];
  const win = {
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    parent: { postMessage: (m) => sent.push(m) },
  };
  run(win, '/srv1/proxy/app/meu-app/');

  const vistos = [];
  const p = win.vssh.tray.set({
    icon: 'refresh',
    onClick: () => vistos.push('click'),
    onMenu:  (id) => vistos.push('menu:' + id),
  });
  const req = sent.find((m) => m.type === 'tray');
  for (const fn of listeners) {
    fn({ origin: 'https://portal', source: win.parent,
         data: { vsshApp: true, type: 'result', requestId: req.requestId, ok: true, value: true } });
  }
  await p;

  pushTray(listeners, win, 'click');
  pushTray(listeners, win, 'menu', 'pause');
  assert.deepEqual(vistos, ['click', 'menu:pause']);
});

test('tray.set resolve false quando o shell não responde, em vez de pendurar', async (t) => {
  // O modo de falha que importa: shell e apps são deployados à parte, então um shell
  // mais antigo que o app simplesmente NÃO responde ao tipo que não conhece. Sem
  // timeout a promise ficaria pendurada para sempre — sem resolver, sem rejeitar e
  // sem deixar nada no console. `false` é "este ambiente não tem bandeja"; o app
  // trata e segue, que é o contrário de travar num `await`.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { vssh, sent } = loadShim();

  const pending = vssh.tray.set({ icon: 'refresh' });
  assert.ok(sent.some((m) => m.type === 'tray'));

  t.mock.timers.tick(5000);
  assert.equal(await pending, false);
});

test('tray fora do desktop devolve false sem lançar', async () => {
  const win = { addEventListener: () => {} };
  win.parent = win;
  run(win, '/');

  assert.equal(await win.vssh.tray.set({ icon: 'refresh' }), false);
  assert.equal(await win.vssh.tray.remove(), false);
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

// ── Áudio: o ambiente é o mixer ───────────────────────────────────────────────
//
// O que estes testes protegem não é uma API — é o fato de o app não precisar de nenhuma. Um
// vssh-app que nunca ouviu falar do mixer tem de obedecer ao slider assim mesmo, e é isso que
// justifica o shim mexer em `HTMLMediaElement.prototype` e em `AudioNode.prototype`.

/** Um app com mídia e/ou Web Audio, já carregado, com a plataforma falsa injetada. */
function comAudio(midias = []) {
  const A = fakeAudio();
  const doc = fakeDocument();
  const ouvidos = [];
  doc.querySelectorAll = () => midias;
  doc.documentElement = { tag: 'html' };
  doc.addEventListener = (tipo, fn) => ouvidos.push([tipo, fn]);
  const h = loadShim({
    doc,
    extras: { HTMLMediaElement: A.HTMLMediaElement, AudioNode: A.AudioNode },
  });
  return { ...h, A, ouvidos, dispara: (tipo) => ouvidos.filter(([t]) => t === tipo).forEach(([, f]) => f()) };
}

test('o volume do ambiente MULTIPLICA o do app, em vez de sobrescrever', () => {
  const A = fakeAudio();
  const el = A.midia();
  const { vssh, pushVolume } = comAudio([el]);
  void vssh;

  // O app pediu meio volume.
  el.volume = 0.5;
  assert.equal(el._realVol, 0.5, 'sem mixer, o que o app pede é o que toca');

  // O usuário põe o master em 40%.
  pushVolume(0.4);
  assert.ok(Math.abs(el._realVol - 0.2) < 1e-9, `esperava 0.5×0.4=0.2, veio ${el._realVol}`);

  // E o app continua dono do valor DELE: quem lê `el.volume` vê o que pediu.
  assert.equal(el.volume, 0.5, 'o getter devolve o volume do app, não o do ambiente');

  // Se o app mexer de novo depois, a multiplicação continua valendo — este é o ponto: sem
  // interceptar o setter, o próximo `el.volume = 1` do app desfaria o mixer em silêncio.
  el.volume = 1;
  assert.ok(Math.abs(el._realVol - 0.4) < 1e-9, `esperava 1×0.4, veio ${el._realVol}`);
});

test('mudo do ambiente vence, e desmutar não desfaz o mudo do APP', () => {
  const A = fakeAudio();
  const el = A.midia();
  const { pushVolume } = comAudio([el]);

  pushVolume(1, true);
  assert.equal(el._realMudo, true);

  pushVolume(1, false);
  assert.equal(el._realMudo, false);

  // Agora o APP se cala. O ambiente não pode "desmutar" o que não foi ele que calou.
  el.muted = true;
  pushVolume(1, false);
  assert.equal(el._realMudo, true, 'o mudo do app sobreviveu ao desmute do ambiente');
});

test('mídia que nasce DEPOIS entra no mesmo regime', () => {
  const A = fakeAudio();
  const lista = [];
  const h = comAudio(lista);
  h.pushVolume(0.5);

  const novo = A.midia();
  lista.push(novo);
  h.doc.__flush();      // dispara o MutationObserver do shim
  // O observer do harness não passa `addedNodes`; o que importa é que a próxima aplicação
  // adote o elemento novo — e é o que o push seguinte faz.
  h.pushVolume(0.5);
  assert.ok(Math.abs(novo._realVol - 0.5) < 1e-9, `esperava 0.5, veio ${novo._realVol}`);
});

test('Web Audio: o que ia para a saída passa pelo NOSSO gain', () => {
  const { A, pushVolume } = comAudio([]);
  const ctx = A.criarCtx();
  const fonte = new A.AudioNode();
  fonte.context = ctx;

  fonte.connect(ctx.destination);

  // Duas ligações: o nosso gain → destination (feita pelo shim), e a fonte → nosso gain.
  const ligacoes = A.nós.filter(([tipo]) => tipo === 'connect');
  const gainNoDestino = ligacoes.find(([, de, para]) => de.__nome === 'gain' && para.__nome === 'destination');
  const fonteNoGain   = ligacoes.find(([, de, para]) => de === fonte && para.__nome === 'gain');
  assert.ok(gainNoDestino, 'o shim não ligou o gain à saída');
  assert.ok(fonteNoGain, 'a fonte foi ligada direto na saída — o mixer não a alcança');

  // E o slider mexe nele.
  pushVolume(0.25);
  assert.equal(fonteNoGain[2].gain.value, 0.25);
  pushVolume(0.25, true);
  assert.equal(fonteNoGain[2].gain.value, 0, 'mudo tem de zerar o gain, não só baixar');
});

test('Web Audio: desconectar da saída desliga do gain, não do destination', () => {
  const { A } = comAudio([]);
  const ctx = A.criarCtx();
  const fonte = new A.AudioNode();
  fonte.context = ctx;
  fonte.connect(ctx.destination);
  fonte.disconnect(ctx.destination);

  const [, , alvo] = A.nós.find(([tipo]) => tipo === 'disconnect');
  assert.equal(alvo.__nome, 'gain',
    'sem o disconnect simétrico o nó nunca se desliga — ele nunca esteve ligado ao destination');
});

test('o app que toca por Web Audio se ANUNCIA — senão o mixer não o lista', () => {
  const { A, sent } = comAudio([]);
  assert.ok(!sent.some((m) => m.type === 'audio-state' && m.hasAudio),
    'app silencioso não deve anunciar áudio');

  const ctx = A.criarCtx();
  const fonte = new A.AudioNode();
  fonte.context = ctx;
  fonte.connect(ctx.destination);

  const relato = sent.filter((m) => m.type === 'audio-state').pop();
  assert.ok(relato?.hasAudio, 'sem relato o app fica controlável mas invisível no mixer');
  assert.equal(relato.playing, true, 'contexto rodando é som tocando');
});

test('vssh.audio é só leitura, e degrada fora do desktop', () => {
  const { vssh, pushVolume } = comAudio([]);
  const vistos = [];
  const cancelar = vssh.audio.onChange((v) => vistos.push(v));

  pushVolume(0.6);
  assert.equal(vssh.audio.gain(), 0.6);
  assert.equal(vssh.audio.muted(), false);

  pushVolume(0.6, true);
  assert.equal(vssh.audio.gain(), 0, 'gain() já leva o mudo em conta');
  assert.equal(vssh.audio.muted(), true);
  // Campo a campo: os objetos nascem DENTRO do vm, com outro Object.prototype, e um
  // deepEqual entre realms falha por identidade de protótipo mesmo com a estrutura igual.
  assert.deepEqual(vistos.map((v) => [v.gain, v.muted]), [[0.6, false], [0.6, true]]);

  cancelar();
  pushVolume(0.1);
  assert.equal(vistos.length, 2, 'cancelar tem de parar de entregar');

  // Standalone: o app roda fora do desktop e não pode ver volume zero nem lançar.
  const win = { addEventListener: () => {} };
  win.parent = win;
  run(win, '/');
  assert.equal(win.vssh.audio.gain(), 1);
  assert.equal(win.vssh.audio.muted(), false);
  assert.equal(typeof win.vssh.audio.onChange(() => {}), 'function');
});

test('o gain fora de faixa é clampeado, não propagado', () => {
  const A = fakeAudio();
  const el = A.midia();
  const { pushVolume } = comAudio([el]);
  el.volume = 1;
  for (const [bruto, esperado] of [[5, 1], [-2, 0], ['x', 0], [null, 0]]) {
    pushVolume(bruto);
    assert.equal(el._realVol, esperado, `gain ${bruto}`);
  }
});
