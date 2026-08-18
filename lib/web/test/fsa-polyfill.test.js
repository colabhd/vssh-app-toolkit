'use strict';

// Testes do fsa-polyfill fora do navegador. Só precisam de Blob/WritableStream/ReadableStream,
// que o Node tem; IndexedDB é stubado porque o polyfill envelopa dois métodos dele.
//
// Os dois primeiros testes existem por causa de defeitos reais encontrados ao medir o polyfill
// contra um consumidor de verdade (o port do Logseq) — ver docs/lessons/logseq-port.md:
//   1. getFile() ansioso: o app chama getFile() para TODO arquivo antes de filtrar por extensão,
//      então buscar o corpo ali dentro transformava abrir uma pasta em centenas de downloads.
//   2. escrita binária virando texto: `blob.text()` num PNG o corrompe em silêncio.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

function loadPolyfill(fsImpl) {
  // Estado por carga: o polyfill é um IIFE que escreve em `window`.
  const calls = { readBytes: 0, stat: 0, list: 0, write: [], writeBytes: [] };
  const fs = {
    list: async (p) => { calls.list++; return fsImpl.list(p); },
    stat: async (p) => { calls.stat++; return fsImpl.stat(p); },
    read: async (p) => fsImpl.read(p),
    readBytes: async (p) => { calls.readBytes++; return fsImpl.readBytes(p); },
    write: async (p, c) => { calls.write.push([p, c]); },
    writeBytes: async (p, b) => { calls.writeBytes.push([p, b]); },
    mkdir: async () => {}, delete: async () => {},
  };

  // urlFor é síncrona e sai do shim; aqui basta o formato — quem o testa é o shim.
  fs.urlFor = (p) => `/srv1/api/fs/read?path=${encodeURIComponent(p)}`;

  // O shell é quem decide a permissão. `granted` é a lista que ele responderia; deixá-la
  // manipulável é o que permite testar o handle restaurado sem grant.
  const granted = new Set(fsImpl.granted || ['/graf']);
  calls.granted = granted;
  calls.modes = [];
  if (!fsImpl.noIsGranted) {
    fs.isGranted = async (p, opts) => {
      calls.modes.push(opts?.mode);
      // `null` = não obtive resposta. É a terceira resposta que não existia, e a que separa
      // "o shell disse não" de "o shell não disse nada".
      if (fsImpl.grantsUnknown) return null;
      return [...granted].some((g) => p === g || p.startsWith(g + '/'));
    };
  }

  const win = { vssh: { inDesktop: true, fs }, matchMedia: () => ({ matches: false }) };
  // O seletor concede — é assim que a FSA real funciona, e é o caminho de volta que
  // requestPermission() usa quando um handle restaurado já não tem grant.
  calls.picks = [];
  win.vssh.pickDirectory = async (o) => { calls.picks.push(o); granted.add('/graf'); return '/graf'; };
  win.vssh.pickFile      = async (o) => { calls.picks.push(o); return null; };

  // Stubs de IndexedDB. Não são só para o polyfill carregar: é sobre eles que se verifica a
  // reidratação de handle, que é o que separa "o app reabre a pasta" de "o app conclui que a
  // pasta está vazia". O `store` é o que a base devolveria.
  const store = fsImpl.store || {};
  class IDBRequest { get result() { return this._r; } }
  class IDBCursorWithValue { get value() { return this._v; } }
  const mkReq = (v) => { const r = new IDBRequest(); r._r = v; return r; };
  const mkCursor = (values) => {
    const c = new IDBCursorWithValue();
    let i = 0;
    c._v = values[0];
    c.continue = () => { c._v = values[++i]; };   // avançar troca o value, e o getter tem de seguir
    return mkReq(c);
  };
  class IDBObjectStore {
    get(k) { return mkReq(k in store ? store[k] : null); }
    getAll() { return mkReq(Object.values(store)); }
    openCursor() { return mkCursor(Object.values(store)); }
  }
  class IDBIndex {
    get(k) { return mkReq(k in store ? store[k] : null); }
    getAll() { return mkReq(Object.values(store)); }
    openCursor() { return mkCursor(Object.values(store)); }
  }

  // URL é stubado: o polyfill envelopa createObjectURL/revokeObjectURL, e o Node não os tem.
  const revoked = [];
  const FakeURL = {
    createObjectURL: (o) => `blob:fake/${o && o.constructor ? o.constructor.name : 'x'}`,
    revokeObjectURL: (u) => revoked.push(u),
  };

  const sandbox = {
    window: win, Blob, WritableStream, ReadableStream, TextDecoder, TextEncoder,
    File, IDBObjectStore, IDBIndex, IDBRequest, IDBCursorWithValue, console, atob, btoa,
    URL: FakeURL, location: { pathname: '/srv1/proxy/app/meu-app/', origin: 'https://portal' },
    // `navigator.userActivation` só entra quando o teste pede: sem ele o polyfill não pode
    // consultar gesto do usuário e segue em frente, que é o comportamento correto.
    navigator: fsImpl.userActivation === undefined
      ? undefined
      : { userActivation: { isActive: fsImpl.userActivation } },
  };
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'fsa-polyfill.js'), 'utf8');
  const vm = require('node:vm');
  const ctx = vm.createContext(sandbox);
  // O polyfill referencia `window.*` e os globais do navegador diretamente.
  vm.runInContext(src, ctx);
  globalThis.__lastURL = ctx.URL;   // o polyfill substituiu os métodos dentro do contexto
  // As classes DEPOIS de envelopadas: o polyfill mexeu nos protótipos dentro do contexto, então
  // pegá-las de fora testaria os stubs originais em vez do que o polyfill fez com eles.
  win.__idb = { IDBObjectStore: ctx.IDBObjectStore, IDBIndex: ctx.IDBIndex };
  return { win, calls, URL: ctx.URL, revoked };
}

const SAMPLE = 'conteudo real';

const fakeFs = {
  list: async () => ({ items: [
    { name: 'nota.md', type: 'file', size: SAMPLE.length, mtime: 111 },
    { name: 'anexo.png', type: 'file', size: 4, mtime: 222 },
    { name: 'sub', type: 'directory' },
  ] }),
  stat: async () => ({ size: SAMPLE.length, mtime: 111 }),
  read: async () => SAMPLE,
  readBytes: async () => new TextEncoder().encode(SAMPLE),
};

test('getFile() de uma listagem não busca conteúdo — só ao pedir text()', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const dir = new win.FileSystemDirectoryHandle('/graf');

  const files = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file') files.push([name, h]);
  assert.equal(files.length, 2);

  // É este o ponto: percorrer o diretório inteiro e pegar o File de cada arquivo não pode custar
  // uma requisição por arquivo. Era o que fazia abrir um grafo baixar todos os anexos.
  const handles = await Promise.all(files.map(([, h]) => h.getFile()));
  assert.equal(calls.readBytes, 0, 'getFile() não pode ler o corpo');
  assert.equal(calls.stat, 0, 'size/mtime vêm da listagem, sem stat');

  // Os metadados têm de estar lá mesmo sem leitura — são propriedades síncronas.
  assert.equal(handles[0].name, 'nota.md');
  assert.equal(handles[0].size, SAMPLE.length);
  assert.equal(handles[0].lastModified, 111);

  // Só agora o conteúdo é buscado, e uma vez só.
  assert.equal(await handles[0].text(), SAMPLE);
  assert.equal(calls.readBytes, 1);
  await handles[0].text();
  assert.equal(calls.readBytes, 1, 'segunda leitura vem do cache');
});

test('getFile() fora de listagem paga um stat, não o corpo', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const dir = new win.FileSystemDirectoryHandle('/graf');
  const h = await dir.getFileHandle('nota.md');
  const file = await h.getFile();
  assert.equal(calls.readBytes, 0);
  assert.equal(file.size, SAMPLE.length);
});

test('escrita de texto vai pela rota de texto', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const h = new win.FileSystemFileHandle('/graf/nota.md');
  const w = await h.createWritable();
  await w.write('- alpha\n');
  await w.close();

  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0][1], '- alpha\n');
  assert.equal(calls.writeBytes.length, 0);
});

test('escrita binária NÃO passa por texto — um PNG tem de sair intacto', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const h = new win.FileSystemFileHandle('/graf/anexo.png');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const w = await h.createWritable();
  await w.write(png);
  await w.close();

  assert.equal(calls.write.length, 0, 'binário não pode ir pela rota de texto');
  assert.equal(calls.writeBytes.length, 1);
  assert.deepEqual(Array.from(calls.writeBytes[0][1]), Array.from(png));
});

test('createWritable() devolve um WritableStream de verdade (pipeTo funciona)', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const h = new win.FileSystemFileHandle('/graf/stream.bin');
  const w = await h.createWritable();

  assert.ok(w instanceof WritableStream, 'precisa ser WritableStream, senão pipeTo lança');

  const src = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); },
  });
  await src.pipeTo(w);   // fecha o stream, o que dispara o commit

  assert.equal(calls.writeBytes.length, 1);
  assert.deepEqual(Array.from(calls.writeBytes[0][1]), [1, 2, 3]);
});

test('showDirectoryPicker cancelado lança AbortError, não erro genérico', async () => {
  const { win } = loadPolyfill(fakeFs);
  win.vssh.pickDirectory = async () => null;   // usuário cancelou
  await assert.rejects(() => win.showDirectoryPicker(), (err) => err.name === 'AbortError');
});

// ── Permissão: perguntar a quem decide ─────────────────────────────────────
//
// `queryPermission()` respondia 'granted' incondicionalmente. Era mentira com consequência: um
// handle restaurado do IndexedDB podia já não ter permissão, o app ouvia "pode" e era negado na
// primeira operação — com stack trace no lugar de explicação e sem caminho de volta.

test('handle restaurado sem grant responde prompt, não granted', async () => {
  const { win } = loadPolyfill({ ...fakeFs, granted: [] });
  const dir = new win.FileSystemDirectoryHandle('/graf');   // veio do IndexedDB, não do seletor
  assert.equal(await dir.queryPermission(), 'prompt');
});

test('requestPermission reabre o seletor e concede de novo', async () => {
  const { win, calls } = loadPolyfill({ ...fakeFs, granted: [] });
  const dir = new win.FileSystemDirectoryHandle('/graf');

  assert.equal(await dir.requestPermission(), 'granted');
  assert.equal(calls.picks.length, 1, 'é o único caminho de volta para um handle sem grant');
  // E, concedido, não incomoda o usuário de novo.
  assert.equal(await dir.requestPermission(), 'granted');
  assert.equal(calls.picks.length, 1);
});

test('escolher outro caminho não concede o handle antigo', async () => {
  const { win } = loadPolyfill({ ...fakeFs, granted: [] });
  const other = new win.FileSystemDirectoryHandle('/outro');
  // O seletor devolve '/graf'; o handle aponta para '/outro' e continua sem permissão. Responder
  // 'granted' aqui só adiaria a mesma negação para a primeira operação.
  assert.equal(await other.requestPermission(), 'denied');
});

test('shim sem isGranted mantém o comportamento antigo em vez de pedir à toa', async () => {
  const { win } = loadPolyfill({ ...fakeFs, noIsGranted: true, granted: [] });
  const dir = new win.FileSystemDirectoryHandle('/graf');
  assert.equal(await dir.queryPermission(), 'granted');
});

// ── "não" e "não sei" pedem ações opostas ──────────────────────────────────
//
// Este é o defeito que custou três versões do primeiro app portado: um shell sem a mensagem
// `grants` produzia o mesmo `false` que uma negação de verdade. O app entrava no caminho de
// reconceder e o grafo não carregava — ENQUANTO as operações de arquivo funcionavam, porque `fs`
// o shell implementa e `grants` não. Sintoma que não aponta para a causa.

test('shell que não responde sobre grants vale "não sei", e não sei é granted', async () => {
  const { win, calls } = loadPolyfill({ ...fakeFs, grantsUnknown: true, granted: [] });
  const dir = new win.FileSystemDirectoryHandle('/graf');

  assert.equal(await dir.queryPermission(), 'granted', 'null não pode virar prompt');
  // E o mesmo caso não pode abrir seletor: não dá para verificar o resultado de uma escolha cujo
  // canal de verificação está mudo.
  assert.equal(await dir.requestPermission(), 'granted');
  assert.equal(calls.picks.length, 0, 'nada de seletor no escuro');
});

test('um shell sem `grants` é o mesmo caso que um shim sem `isGranted`', async () => {
  const semShell = loadPolyfill({ ...fakeFs, grantsUnknown: true, granted: [] });
  const semShim  = loadPolyfill({ ...fakeFs, noIsGranted: true,   granted: [] });
  const a = await new semShell.win.FileSystemDirectoryHandle('/graf').queryPermission();
  const b = await new semShim.win.FileSystemDirectoryHandle('/graf').queryPermission();
  // Em nenhum dos dois há a quem perguntar. Antes um dava 'granted' e o outro 'prompt'.
  assert.equal(a, b);
  assert.equal(a, 'granted');
});

test('requestPermission não abre seletor sem gesto do usuário', async () => {
  // Abrir seletor sem gesto não funciona nem no navegador. O Logseq chama requestPermission no
  // meio do boot, ao restaurar o grafo — era um seletor que ninguém pediu, quando ninguém olha.
  const { win, calls } = loadPolyfill({ ...fakeFs, granted: [], userActivation: false });
  const dir = new win.FileSystemDirectoryHandle('/graf');
  assert.equal(await dir.requestPermission(), 'prompt');
  assert.equal(calls.picks.length, 0);
});

test('com gesto do usuário, requestPermission abre o seletor', async () => {
  const { win, calls } = loadPolyfill({ ...fakeFs, granted: [], userActivation: true });
  const dir = new win.FileSystemDirectoryHandle('/graf');
  assert.equal(await dir.requestPermission(), 'granted');
  assert.equal(calls.picks.length, 1);
});

test('o descriptor {mode} é repassado em vez de descartado em silêncio', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  const dir = new win.FileSystemDirectoryHandle('/graf');
  await dir.queryPermission({ mode: 'read' });
  assert.deepEqual(calls.modes, ['read']);
  // Hoje o shell não distingue modo: todo grant dele é readwrite, e readwrite satisfaz read —
  // então 'granted' aqui é correto, não uma simplificação que engana.
  assert.equal(await dir.queryPermission({ mode: 'readwrite' }), 'granted');
});

// ── URL.createObjectURL sobre um Blob preguiçoso ────────────────────────────
//
// A terceira lacuna, e a mais traiçoeira: `LazyFile extends Blob` com `super([])` tem a sequência
// de bytes interna VAZIA. Os métodos sobrescritos entregam o conteúdo, mas a plataforma não chama
// método nenhum — ela lê o estado interno. Resultado: `URL.createObjectURL(file)` produzia um
// `blob:` vazio, e a imagem do grafo simplesmente não aparecia. Sintoma que não aponta para nada.

test('createObjectURL de um File preguiçoso devolve URL HTTP, não blob: vazio', async () => {
  const { win } = loadPolyfill(fakeFs);
  const dir = new win.FileSystemDirectoryHandle('/graf');
  const h = await dir.getFileHandle('anexo.png');
  const file = await h.getFile();

  const url = globalThis.__lastURL.createObjectURL(file);
  assert.ok(!url.startsWith('blob:'), `devolveu um blob: — é exatamente o bug (${url})`);
  assert.match(url, /\/api\/fs\/read\?path=/);
  assert.match(url, /anexo\.png/);
});

test('createObjectURL de um Blob de verdade continua nativo', async () => {
  const { win } = loadPolyfill(fakeFs);
  const url = globalThis.__lastURL.createObjectURL(new Blob(['oi']));
  assert.ok(url.startsWith('blob:'), 'Blob real não pode ser sequestrado');
});

// ── Reidratação de handle ──────────────────────────────────────────────────
//
// O envelope `__vsshHandle` existe porque structured clone descarta métodos: sem reidratar, o app
// guarda o handle, recarrega, lê de volta um objeto morto e conclui que a pasta está vazia.
// A cobertura era `IDBObjectStore.get`/`getAll` e nada mais — o primeiro app portado usava `get`
// na raiz e funcionava por sorte, não por contrato.

const HANDLE = { __vsshHandle: { v: 1, kind: 'directory', path: '/graf' } };

test('handle guardado num índice também volta vivo, não só no object store', () => {
  const { win } = loadPolyfill({ ...fakeFs, store: { g: HANDLE } });
  const viaStore = new win.__idb.IDBObjectStore().get('g').result;
  const viaIndex = new win.__idb.IDBIndex().get('g').result;
  assert.equal(typeof viaStore.entries, 'function');
  assert.equal(typeof viaIndex.entries, 'function', 'IDBIndex não tinha hook nenhum');
  assert.equal(viaIndex._path, '/graf');
});

test('handle aninhado num objeto volta vivo — apps guardam {handle, ...}, não o handle cru', () => {
  const guardado = { handle: HANDLE, lastOpened: 123, tags: [HANDLE] };
  const { win } = loadPolyfill({ ...fakeFs, store: { g: guardado } });
  const lido = new win.__idb.IDBObjectStore().get('g').result;

  assert.equal(typeof lido.handle.entries, 'function', 'aninhado voltava cru, sem métodos');
  assert.equal(typeof lido.tags[0].entries, 'function', 'dentro de array também');
  assert.equal(lido.lastOpened, 123, 'o resto do objeto tem de sobreviver intacto');
});

test('cursor reidrata, e continua reidratando depois de continue()', () => {
  const outro = { __vsshHandle: { v: 1, kind: 'file', path: '/graf/a.md' } };
  const { win } = loadPolyfill({ ...fakeFs, store: { a: HANDLE, b: outro } });
  const cursor = new win.__idb.IDBObjectStore().openCursor().result;

  assert.equal(cursor.value._path, '/graf');
  assert.equal(cursor.value.kind, 'directory');
  cursor.continue();
  // O `value` do cursor muda a cada continue(): cachear devolveria o primeiro registro para sempre.
  assert.equal(cursor.value._path, '/graf/a.md');
  assert.equal(cursor.value.kind, 'file');
});

test('objeto sem handle nenhum atravessa idêntico', () => {
  const plain = { a: 1, b: { c: 'x' } };
  const { win } = loadPolyfill({ ...fakeFs, store: { g: plain } });
  assert.equal(new win.__idb.IDBObjectStore().get('g').result, plain, 'sem handle, sem cópia');
});

test('objeto cíclico não trava a reidratação', () => {
  const ciclo = { nome: 'raiz' };
  ciclo.self = ciclo;
  const { win } = loadPolyfill({ ...fakeFs, store: { g: ciclo } });
  // O limite de profundidade é teto de custo E proteção contra ciclo — uma recursão ingênua
  // aqui estouraria a pilha em vez de devolver.
  const lido = new win.__idb.IDBObjectStore().get('g').result;
  assert.equal(lido.nome, 'raiz');
});

test('revokeObjectURL não quebra com a URL HTTP que devolvemos', async () => {
  const { win, revoked } = loadPolyfill(fakeFs);
  const dir = new win.FileSystemDirectoryHandle('/graf');
  const file = await (await dir.getFileHandle('anexo.png')).getFile();

  const httpUrl = globalThis.__lastURL.createObjectURL(file);
  globalThis.__lastURL.revokeObjectURL(httpUrl);      // não pode lançar nem chegar no nativo
  assert.equal(revoked.length, 0, 'URL não-blob: não vai para a implementação nativa');

  const blobUrl = globalThis.__lastURL.createObjectURL(new Blob(['x']));
  globalThis.__lastURL.revokeObjectURL(blobUrl);
  assert.equal(revoked.length, 1, 'blob: de verdade continua sendo revogada');
});

// ─── A terceira resposta: tenho a permissão e não tenho o handle ─────────────
//
// O grant mora no USUÁRIO (`appGrants` em /api/user/settings), e por isso viaja de
// computador em computador. O handle mora no IndexedDB do app, que é por perfil de navegador e
// **não viaja**. Num computador novo, o app acorda com a permissão viva e sem nada para abrir.
//
// Sem `grantedHandles()`, esse estado se lê como "primeira vez": o app pede a pasta de novo, e a
// pessoa reconcede o que já concedeu. Com ela, o app reabre sem seletor — o consentimento já
// aconteceu, uma vez, e o que faltava era um objeto para representá-lo desta máquina.

test('grantedHandles() reabre o que já foi concedido, SEM abrir seletor', async () => {
  const { win, calls } = loadPolyfill({
    ...fakeFs,
    stat: async (p) => (p === '/graf' ? { isDirectory: true } : { isDirectory: false, size: 13, mtime: 111 }),
  });
  win.vssh.fs.grantedPaths = () => ['/graf', '/notas/a.md'];

  const handles = await win.vssh.fs.grantedHandles();

  assert.equal(handles.length, 2);
  assert.equal(handles[0].kind, 'directory');
  assert.equal(handles[0].name, 'graf');
  assert.equal(handles[1].kind, 'file');
  assert.equal(handles[1].name, 'a.md');

  // O ponto inteiro: nenhum seletor. Um seletor aqui pediria de novo o consentimento que já
  // existe — e pior, exigiria gesto do usuário no boot, onde não há nenhum.
  assert.equal(calls.picks.length, 0, 'grantedHandles() abriu seletor');
});

test('o que não existe mais SOME da lista, em vez de virar handle morto', async () => {
  // A pasta pode ter sido apagada no servidor desde a concessão. Devolver um handle para ela
  // empurraria a falha para a primeira leitura, longe da causa — e o app não teria como
  // distinguir "sumiu" de "está vazia".
  const { win, calls } = loadPolyfill({
    ...fakeFs,
    stat: async (p) => {
      if (p === '/sumiu') throw new Error('não encontrado');
      return { isDirectory: true };
    },
  });
  win.vssh.fs.grantedPaths = () => ['/graf', '/sumiu'];

  // `Array.from` deste realm, e não `.map` do array que veio do `vm`: o `deepEqual` compara
  // protótipos, e um array criado lá dentro reprova por proveniência em vez de por conteúdo. É a
  // mesma armadilha que o `igual()` do harness dos shims documenta.
  const handles = await win.vssh.fs.grantedHandles();
  assert.deepEqual(Array.from(handles, (h) => h.name), ['graf']);

  // E o caminho que sumiu não pode virar um seletor: "a pasta que voce concedeu nao existe mais"
  // nao se resolve pedindo outra no boot, sem gesto do usuario e sem ele saber por que.
  assert.equal(calls.picks.length, 0, 'o caminho que sumiu abriu seletor');
});

test('sem grant nenhum, a lista é vazia — e não um seletor disfarçado', async () => {
  const { win, calls } = loadPolyfill(fakeFs);
  win.vssh.fs.grantedPaths = () => [];
  assert.equal((await win.vssh.fs.grantedHandles()).length, 0);
  assert.equal(calls.picks.length, 0);
});
