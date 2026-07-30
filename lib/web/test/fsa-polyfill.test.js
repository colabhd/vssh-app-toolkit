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

  const win = { vssh: { inDesktop: true, fs }, matchMedia: () => ({ matches: false }) };

  // O polyfill envelopa IDBObjectStore.get/getAll; stubs bastam para ele carregar.
  class IDBRequest { get result() { return this._r; } }
  class IDBObjectStore {
    get() { const r = new IDBRequest(); r._r = null; return r; }
    getAll() { const r = new IDBRequest(); r._r = []; return r; }
  }

  const sandbox = {
    window: win, Blob, WritableStream, ReadableStream, TextDecoder, TextEncoder,
    File, IDBObjectStore, IDBRequest, console, atob, btoa,
  };
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'fsa-polyfill.js'), 'utf8');
  const vm = require('node:vm');
  const ctx = vm.createContext(sandbox);
  // O polyfill referencia `window.*` e os globais do navegador diretamente.
  vm.runInContext(src, ctx);
  return { win, calls };
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
