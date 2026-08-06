'use strict';

// O fsa-polyfill num NAVEGADOR de verdade.
//
// O irmão deste arquivo (`fsa-polyfill.test.js`) roda o polyfill num contexto `vm` do Node, e é
// onde mora a maior parte da cobertura: é rápido, não precisa de ambiente e mede bem o que o
// nosso código faz. O que ele NÃO mede é o que a plataforma faz com o nosso código — e é essa a
// fronteira exata deste arquivo.
//
// A fronteira foi medida, não estimada. Um `Blob` de respaldo vazio com `stream()` sobrescrito:
//
//     new Response(f).text()   →  Node/undici: os bytes   ·  navegador: ""
//
// O undici constrói o corpo pelo método `.stream()` público; o navegador segue o Fetch, que usa o
// *get stream* interno do Blob e nunca olha para o método. Um conserto do T1 apoiado em
// `stream()` ficaria verde no Node com o navegador ainda quebrado. Daí a regra de divisão:
//
//   • comportamento do polyfill (preguiça, permissão, reidratação, escrita)  → arquivo `vm`
//   • leitura feita PELA PLATAFORMA sobre o que devolvemos                    → este arquivo
//
// Sem navegador instalado os testes se pulam. Falhar por ausência de ambiente é ruído; o CI do
// Ubuntu já traz Chrome, e no desenvolvimento `VSSH_TEST_CHROME` aponta um.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { abrirNavegador, caminhoDoNavegador, motivoDoSkip, servirOrigem } = require('../../../tests/browser/chrome.js');

const FONTE = require('node:fs').readFileSync(path.join(__dirname, '..', 'fsa-polyfill.js'), 'utf8');
const CONTEUDO = 'conteudo real';
const temNavegador = !!caminhoDoNavegador();

// O arquivo grande existe para uma asserção só, e é a que decide o arquétipo A3: fatiar 64 bytes
// de um arquivo de 100 kB tem de transferir 64 bytes, não 100 kB.
const GRANDE = 100000;
const bytesDoGrande = Buffer.alloc(GRANDE, 'x');
/** Quanto o servidor entregou, por caminho. É o que separa "leu a faixa" de "leu tudo e fatiou". */
let servido = {};

/**
 * A API de arquivos do portal, do jeito que o `urlFor()` do shim aponta — com `Range` de
 * verdade. Sem esta rota o `fetch` de faixa cairia na página em branco da origem e o teste
 * mediria o fixture: foi exatamente o que aconteceu na primeira execução, e o `slice()` devolveu
 * os oito primeiros bytes de `<!doctype html>` com cara de conteúdo.
 */
function rotaDoFs(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/srv1/api/fs/read') return false;
  const caminho = u.searchParams.get('path');
  const corpo = caminho === '/graf/grande.bin' ? bytesDoGrande : Buffer.from(CONTEUDO);

  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    const ini = Number(m[1]);
    const fim = m[2] === '' ? corpo.length - 1 : Math.min(Number(m[2]), corpo.length - 1);
    const pedaco = corpo.subarray(ini, fim + 1);
    servido[caminho] = (servido[caminho] || 0) + pedaco.length;
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${ini}-${fim}/${corpo.length}`,
      'content-length': String(pedaco.length),
    });
    return res.end(pedaco), true;
  }
  servido[caminho] = (servido[caminho] || 0) + corpo.length;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(corpo.length) });
  return res.end(corpo), true;
}

let nav = null;
let origem = null;
before(async () => {
  if (!temNavegador) return;
  // Toda página deste arquivo roda numa origem http de verdade, e não em `about:blank`. Não é
  // capricho: `about:blank` é origem opaca, o IndexedDB é negado ali, e um vssh-app real é
  // servido por HTTP de qualquer forma — medir na origem opaca é medir outra coisa.
  [nav, origem] = await Promise.all([abrirNavegador(), servirOrigem(rotaDoFs)]);
});
after(async () => {
  if (nav) await nav.fechar();
  if (origem) await origem.fechar();
});

// Um `window.vssh` mínimo e um filesystem de mentira em memória. O contador de `readBytes` é o
// que sustenta as asserções de preguiça: ele conta requisições que um app real pagaria.
const BOOTSTRAP = `
  window.__req = { readBytes: 0, stat: 0, list: 0 };
  const CONTEUDO = ${JSON.stringify(CONTEUDO)};
  const bytes = new TextEncoder().encode(CONTEUDO);
  const GRANDE = ${GRANDE};
  window.vssh = {
    inDesktop: true,
    fs: {
      async list(p)      { window.__req.list++; return { items: [
        { name: 'nota.md',    type: 'file', size: bytes.length, mtime: 111 },
        { name: 'anexo.png',  type: 'file', size: 4,            mtime: 222 },
        { name: 'grande.bin', type: 'file', size: GRANDE,       mtime: 333 },
        { name: 'sub',        type: 'directory' },
      ] }; },
      async stat(p)      { window.__req.stat++; return { size: p.endsWith('grande.bin') ? GRANDE : bytes.length, mtime: 111 }; },
      async read(p)      { return CONTEUDO; },
      // A ponte devolve o arquivo INTEIRO — é o caminho caro, e o contador existe para provar
      // que o slice() não passa por aqui.
      async readBytes(p) { window.__req.readBytes++; return p.endsWith('grande.bin') ? new Uint8Array(GRANDE) : bytes; },
      async write()      {}, async writeBytes() {}, async mkdir() {}, async delete() {},
      async isGranted()  { return true; },
      urlFor: (p) => '/srv1/api/fs/read?path=' + encodeURIComponent(p),
    },
    pickDirectory: async () => '/graf',
    pickFile:      async () => '/graf/nota.md',
  };
`;

/** Aba nova com o polyfill carregado. Uma por teste: o polyfill é um IIFE que remenda globais. */
async function pagina() {
  const p = await nav.novaPagina(origem.url);
  await p.avaliar(BOOTSTRAP);
  await p.avaliar(FONTE);
  // O polyfill avisa e desiste se o shim não estiver lá; um console limpo aqui é a prova de que
  // ele realmente instalou, e não de que o teste seguinte mediu o vazio.
  assert.deepEqual(p.console, [], 'o polyfill reclamou ao carregar');
  assert.deepEqual(p.excecoes, [], 'o polyfill lançou ao carregar');
  return p;
}

const seNaoTem = { skip: temNavegador ? false : motivoDoSkip() };

// ── O instrumento, antes do que ele mede ──────────────────────────────────────

test('a plataforma sob teste é a real, não os stubs do vm', seNaoTem, async () => {
  const p = await pagina();
  // Cada um destes existe no navegador e NÃO existe (ou existe diferente) no runner de `vm`.
  // Se algum dia esta asserção falhar, o arquivo inteiro parou de medir o que promete.
  assert.deepEqual(await p.avaliar(`[
    typeof FileReader, typeof FormData, typeof Response, typeof IDBRequest,
    typeof navigator.userActivation
  ]`), ['function', 'function', 'function', 'function', 'object']);
});

// ── T1: as leituras que a plataforma faz por dentro ───────────────────────────
//
// Cada teste daqui até o fim da seção falha enquanto `LazyFile` for construído com `super([])`.
// É esse o critério de pronto do T9: o defeito documentado no T1 aparecendo como vermelho, num
// instrumento onde ele possa aparecer.

test('T1 · new Response(file) entrega os bytes', seNaoTem, async () => {
  const p = await pagina();
  const texto = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const h = await dir.getFileHandle('nota.md');
    return new Response(await h.getFile()).text();
  })()`);
  assert.equal(texto, CONTEUDO);
});

test('T1 · new Blob([file]): o limite é conhecido, e agora é barulhento', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const frio = await (await dir.getFileHandle('nota.md')).getFile();
    const antes = { texto: await new Blob([frio]).text() };

    // O mesmo File, depois de lido: os bytes existem, então o envelope troca por um Blob real.
    const quente = await (await dir.getFileHandle('nota.md')).getFile();
    await quente.arrayBuffer();
    const depois = { texto: await new Blob([quente]).text(), size: new Blob([quente]).size };
    return { antes, depois };
  })()`);

  // `new Blob([f])` lê a sequência de bytes interna de forma SÍNCRONA. Não há onde encaixar um
  // `await`, e por isso este caminho não tem conserto — está registrado assim no cabeçalho do
  // polyfill e em docs/api.md. O que mudou é que ele deixou de ser silencioso.
  assert.equal(r.antes.texto, '');
  assert.equal(p.console.length, 1, 'o Blob vazio saiu sem aviso nenhum');
  assert.match(p.console[0].texto, /new Blob\(\[file\]\)/);
  assert.match(p.console[0].texto, /await file\.arrayBuffer\(\)/, 'o aviso não diz o que fazer');

  // E, uma vez lido o conteúdo, o caminho passa a funcionar sozinho.
  assert.equal(r.depois.texto, CONTEUDO);
  assert.equal(r.depois.size, CONTEUDO.length);
});

test('T1 · FileReader lê o arquivo', seNaoTem, async () => {
  const p = await pagina();
  // Este teste não tem como existir no runner de `vm`: o Node não tem `FileReader`. É o caso mais
  // puro do que o T9 comprou.
  const texto = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('nota.md')).getFile();
    return new Promise((ok, erro) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result);
      fr.onerror = () => erro(fr.error);
      fr.readAsText(f);
    });
  })()`);
  assert.equal(texto, CONTEUDO);
});

test('T1 · FormData: o limite é conhecido, e agora é barulhento', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const monta = async (f) => { const fd = new FormData(); fd.append('arquivo', f, 'nota.md'); return new Response(fd).text(); };

    const frio = await (await dir.getFileHandle('nota.md')).getFile();
    const antes = await monta(frio);

    const quente = await (await dir.getFileHandle('nota.md')).getFile();
    await quente.arrayBuffer();
    return { antes, depois: await monta(quente) };
  })()`);

  // `append()` copia o Blob para dentro do FormData na hora, de forma síncrona — o mesmo caso do
  // construtor de Blob. O modo de falha é o pior do conjunto: o corpo sai com
  // `filename="nota.md"` e ZERO bytes, e o servidor recebe um upload perfeitamente formado de um
  // arquivo em branco.
  assert.match(r.antes, /filename="nota\.md"/);
  assert.doesNotMatch(r.antes, new RegExp(CONTEUDO));
  assert.equal(p.console.length, 1, 'o upload vazio saiu sem aviso nenhum');
  assert.match(p.console[0].texto, /FormData\.append\(\)/);

  assert.match(r.depois, new RegExp(CONTEUDO), 'com o conteúdo já lido, o upload tem de subir');
});

test('T1 · slice() lê por range sem exigir leitura prévia', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('nota.md')).getFile();
    // Sem nenhum text()/arrayBuffer() antes: é assim que um leitor de Parquet/HDF5/DICOM começa,
    // e é o que bloqueia o arquétipo A3 enquanto lançar.
    const pedaco = f.slice(0, 8);
    return { texto: await pedaco.text(), tamanho: pedaco.size };
  })()`);
  assert.equal(r.texto, CONTEUDO.slice(0, 8));
  assert.equal(r.tamanho, 8);
});

test('T1 · slice() transfere a faixa, não o arquivo — é isto que destrava o A3', seNaoTem, async () => {
  const p = await pagina();
  servido = {};
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('grande.bin')).getFile();
    const meio = f.slice(50000, 50064);
    const ab = await meio.arrayBuffer();
    return { tamanho: ab.byteLength, pelaPonte: window.__req.readBytes };
  })()`);
  assert.equal(r.tamanho, 64);
  // As duas asserções são o ponto inteiro do conserto. Um leitor de Parquet/HDF5/Zarr abre um
  // arquivo de gigabytes para ler alguns kilobytes de índice; se cada leitura arrastasse o
  // arquivo inteiro, "funciona" e "utilizável" seriam coisas diferentes.
  assert.equal(r.pelaPonte, 0, 'a faixa foi buscada pelo caminho caro, que lê tudo');
  assert.equal(servido['/graf/grande.bin'], 64, `o servidor entregou ${servido['/graf/grande.bin']} bytes para uma faixa de 64`);
});

test('slice() segue a especificação do Blob: índice negativo, faixa invertida, encadeamento', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const um = async () => (await (await dir.getFileHandle('nota.md')).getFile());
    return {
      doFim:      await (await um()).slice(-4).text(),
      invertida:  await (await um()).slice(9, 3).text(),
      alemDoFim:  await (await um()).slice(0, 999).text(),
      tipo:       (await um()).slice(0, 4, 'text/plain').type,
      encadeado:  await (await um()).slice(0, 8).slice(4).text(),
    };
  })()`);
  assert.equal(r.doFim, CONTEUDO.slice(-4));
  assert.equal(r.invertida, '', 'faixa invertida é vazia, não erro');
  assert.equal(r.alemDoFim, CONTEUDO);
  assert.equal(r.tipo, 'text/plain');
  // Fatiar uma fatia é o que um leitor por blocos faz o tempo todo, e o deslocamento tem de
  // acumular: sem isso a segunda fatia leria a partir do começo do arquivo.
  assert.equal(r.encadeado, CONTEUDO.slice(4, 8));
});

test('fetch(url, {body: file}) sobe o arquivo de verdade', seNaoTem, async () => {
  const p = await pagina();
  // O `fetch` interno do navegador NÃO usa o `window.Request` que envelopamos — sem um envelope
  // próprio, este caminho subiria vazio mesmo com o `Request` tratado. É a diferença entre
  // remendar a classe e remendar o uso.
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('nota.md')).getFile();
    const req = new Request('/eco', { method: 'POST', body: f });
    return { pedidoDireto: await new Response(f).text(), corpoDoRequest: await req.text() };
  })()`);
  assert.equal(r.pedidoDireto, CONTEUDO);
  assert.equal(r.corpoDoRequest, CONTEUDO);
});

test('T1 · o stream() do File entrega os bytes pela plataforma', seNaoTem, async () => {
  const p = await pagina();
  const total = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('nota.md')).getFile();
    let n = 0;
    for await (const pedaco of f.stream()) n += pedaco.byteLength;
    return n;
  })()`);
  assert.equal(total, CONTEUDO.length);
});

// ── O que já funciona, e que o conserto do T1 não pode quebrar ────────────────

test('os métodos sobrescritos continuam entregando o conteúdo', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('nota.md')).getFile();
    return {
      texto: await f.text(),
      buffer: new TextDecoder().decode(await f.arrayBuffer()),
      nome: f.name, tamanho: f.size, mtime: f.lastModified,
    };
  })()`);
  assert.equal(r.texto, CONTEUDO);
  assert.equal(r.buffer, CONTEUDO);
  assert.equal(r.nome, 'nota.md');
  assert.equal(r.tamanho, CONTEUDO.length);
  assert.equal(r.mtime, 111);
});

test('percorrer o diretório não busca conteúdo nenhum', seNaoTem, async () => {
  const p = await pagina();
  const req = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    for await (const [nome, h] of dir.entries()) if (h.kind === 'file') await h.getFile();
    return window.__req;
  })()`);
  // A preguiça é o que torna o polyfill utilizável: um grafo de 300 arquivos não pode virar 300
  // downloads só por ter sido listado. Medida aqui de novo, no navegador, porque o conserto do
  // T1 é exatamente onde ela morreria sem ninguém perceber.
  assert.equal(req.readBytes, 0, 'listar a pasta baixou conteúdo');
  assert.equal(req.list, 1);
});

test('URL.createObjectURL de um File preguiçoso vira URL do portal', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const f = await (await dir.getFileHandle('anexo.png')).getFile();
    const nossa = URL.createObjectURL(f);
    const alheia = URL.createObjectURL(new Blob(['x']));   // Blob comum segue pelo caminho nativo
    return { nossa, alheia, req: window.__req.readBytes };
  })()`);
  assert.equal(r.nossa, '/srv1/api/fs/read?path=%2Fgraf%2Fanexo.png');
  assert.match(r.alheia, /^blob:/);
  assert.equal(r.req, 0, 'virar <img src> não pode baixar o arquivo pelo caminho errado');
});

test('a persistência em IndexedDB reidrata handle de verdade', seNaoTem, async () => {
  const p = await pagina();
  // No runner de `vm` isto roda contra stubs de IndexedDB escritos à mão. Aqui é o IndexedDB do
  // navegador, com structured clone de verdade — que é quem descarta os métodos do handle e cria
  // o problema que o envelope `__vsshHandle` existe para resolver.
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const db = await new Promise((ok, erro) => {
      const req = indexedDB.open('t', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('h');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
    await new Promise((ok, erro) => {
      const tx = db.transaction('h', 'readwrite');
      tx.objectStore('h').put({ handle: dir, aberto: 1 }, 'ultimo');   // aninhado, como os apps guardam
      tx.oncomplete = ok; tx.onerror = () => erro(tx.error);
    });
    const lido = await new Promise((ok, erro) => {
      const req = db.transaction('h').objectStore('h').get('ultimo');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
    const h = lido && lido.handle;
    return {
      ehHandle: typeof h?.entries === 'function',
      nome: h?.name,
      // A prova de que está vivo não é responder ao typeof: é conseguir listar.
      filhos: h ? (await Array.fromAsync(h.keys())) : null,
    };
  })()`);
  assert.equal(r.ehHandle, true, 'o handle voltou do IndexedDB sem métodos');
  assert.equal(r.nome, 'graf');
  assert.deepEqual(r.filhos, ['nota.md', 'anexo.png', 'grande.bin', 'sub']);
});
