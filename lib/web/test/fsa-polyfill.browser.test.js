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
  //
  // Em sequência, e não num `Promise.all`, por causa do caminho de FALHA: com o `Promise.all` a
  // atribuição só acontece se as DUAS resolverem, então um navegador que não sobe deixava o
  // servidor de origem já escutando e sem ninguém para fechá-lo. O `after` não tinha o que fechar,
  // o handle segurava o event loop, e a suíte inteira ficava rodando para sempre em vez de falhar.
  // Primeiro o barato, que é o que precisa estar guardado quando o caro falhar.
  origem = await servirOrigem(rotaDoFs);
  nav = await abrirNavegador();
});
after(async () => {
  if (nav) await nav.fechar();
  if (origem) await origem.fechar();
});

// Um `window.vssh` mínimo e um filesystem de mentira em memória. O contador de `readBytes` é o
// que sustenta as asserções de preguiça: ele conta requisições que um app real pagaria.
const BOOTSTRAP = `
  window.__req = { readBytes: 0, stat: 0, list: 0 };
  // A raiz OPFS de verdade, guardada ANTES de o polyfill envelopar o getDirectory. É o único
  // jeito de um teste distinguir "não há namespace" de "há um namespace qualquer": sem esta
  // referência, tudo que o app cria é visível de onde ele criou, e as duas situações se parecem.
  window.__raizReal = navigator.storage.getDirectory.bind(navigator.storage);
  const CONTEUDO = ${JSON.stringify(CONTEUDO)};
  const bytes = new TextEncoder().encode(CONTEUDO);
  const GRANDE = ${GRANDE};
  window.vssh = {
    inDesktop: true,
    fs: {
      // Listar um ARQUIVO tem de falhar, como no servidor de verdade: é o que separa "diretório
      // vazio" de "não é diretório", e a guarda de removeEntry se apoia nessa diferença.
      async list(p)      {
        window.__req.list++;
        if (p === '/graf') return { items: [
          { name: 'nota.md',    type: 'file', size: bytes.length, mtime: 111 },
          { name: 'anexo.png',  type: 'file', size: 4,            mtime: 222 },
          { name: 'grande.bin', type: 'file', size: GRANDE,       mtime: 333 },
          { name: 'sub',        type: 'directory' },
        ] };
        if (p === '/graf/sub')   return { items: [{ name: 'dentro.md', type: 'file', size: 2, mtime: 1 }] };
        if (p === '/graf/vazia') return { items: [] };
        throw new Error('não é um diretório: ' + p);
      },
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

/**
 * Aba nova com o polyfill carregado. Uma por teste: o polyfill é um IIFE que remenda globais.
 *
 * `appId` faz a página ser servida no caminho que o portal usa de verdade —
 * `/<serverId>/proxy/app/<appId>/`. Importa para o OPFS: é de lá que o polyfill descobre de quem
 * é a raiz privada, e dois apps na mesma origem são exatamente o caso que o teste precisa montar.
 */
async function pagina(appId = null) {
  const p = await nav.novaPagina(appId ? `${origem.url}srv1/proxy/app/${appId}/` : origem.url);
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

// ── Os buracos que estavam abertos no polyfill ───────────────────────────────

test('instanceof funciona na classe BASE, não só na concreta', seNaoTem, async () => {
  const p = await pagina();
  // Este teste só é possível num navegador de verdade, e é por isso que o defeito sobreviveu: o
  // Chrome JÁ TEM `FileSystemHandle`, o polyfill preservava a nativa, e os nossos handles não
  // descendiam dela. A classe concreta batia e a base não — e `instanceof FileSystemHandle` é o
  // idioma de "isto é um handle, tanto faz qual".
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const arq = await dir.getFileHandle('nota.md');
    return {
      dirBase: dir instanceof FileSystemHandle,
      arqBase: arq instanceof FileSystemHandle,
      dirConcreta: dir instanceof FileSystemDirectoryHandle,
      arqConcreta: arq instanceof FileSystemFileHandle,
      // A base não pode ser a nativa do Chrome, senão voltamos ao estado anterior.
      baseEhNativa: FileSystemHandle.toString().includes('[native code]'),
    };
  })()`);
  assert.deepEqual(r, {
    dirBase: true, arqBase: true, dirConcreta: true, arqConcreta: true, baseEhNativa: false,
  });
});

test('removeEntry sem `recursive` NÃO apaga uma pasta cheia', seNaoTem, async () => {
  const p = await pagina();
  // O `/api/fs/delete` do portal é `rm -rf` incondicional, e a especificação da FSA não é. Sem a
  // conferência, isto apagava a pasta inteira em silêncio — a única divergência do polyfill que
  // perde dado do usuário.
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const out = { erro: null, apagou: [] };
    const original = window.vssh.fs.delete;
    window.vssh.fs.delete = async (p) => { out.apagou.push(p); };
    try { await dir.removeEntry('sub'); }
    catch (e) { out.erro = e.name + ': ' + e.message; }
    window.vssh.fs.delete = original;
    return out;
  })()`);
  assert.match(r.erro || '', /^InvalidModificationError/);
  assert.match(r.erro, /recursive/, 'o erro tem de dizer como prosseguir de propósito');
  assert.deepEqual(r.apagou, [], 'apagou mesmo tendo lançado');
});

test('removeEntry: recursive apaga, e arquivo e pasta VAZIA nunca precisam da flag', seNaoTem, async () => {
  const p = await pagina();
  const apagados = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const out = [];
    window.vssh.fs.delete = async (p) => { out.push(p); };
    await dir.removeEntry('sub', { recursive: true });
    await dir.removeEntry('nota.md');   // arquivo: o list falha, e falhar aqui é "não é diretório"
    await dir.removeEntry('vazia');     // pasta vazia: lista, não tem nada, segue
    return out;
  })()`);
  assert.deepEqual(apagados, ['/graf/sub', '/graf/nota.md', '/graf/vazia']);
});

test('handle.move() renomeia, move, e o handle segue apontando para o certo', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const dir = await showDirectoryPicker();
    const out = { renomes: [] };
    window.vssh.fs.rename = async (de, para) => { out.renomes.push([de, para]); };

    const a = await dir.getFileHandle('nota.md');
    await a.move('outra.md');                          // só o nome
    out.depoisDoNome = [a.name, a.__vsshHandle.path];

    const b = await dir.getFileHandle('anexo.png');
    await b.move(new FileSystemDirectoryHandle('/outro'));            // só a pasta
    out.depoisDaPasta = [b.name, b.__vsshHandle.path];

    const c = await dir.getFileHandle('grande.bin');
    await c.move(new FileSystemDirectoryHandle('/outro'), 'novo.bin'); // pasta + nome
    out.depoisDosDois = [c.name, c.__vsshHandle.path];
    return out;
  })()`);
  assert.deepEqual(r.renomes, [
    ['/graf/nota.md', '/graf/outra.md'],
    ['/graf/anexo.png', '/outro/anexo.png'],
    ['/graf/grande.bin', '/outro/novo.bin'],
  ]);
  // O handle se atualiza no lugar, como a especificação manda. Um handle apontando para o caminho
  // velho seria um handle morto com cara de vivo: o app leria e receberia "não encontrado".
  assert.deepEqual(r.depoisDoNome,  ['outra.md', '/graf/outra.md']);
  assert.deepEqual(r.depoisDaPasta, ['anexo.png', '/outro/anexo.png']);
  assert.deepEqual(r.depoisDosDois, ['novo.bin', '/outro/novo.bin']);
});

test('os descritores do seletor deixam de ser ignorados em silêncio', seNaoTem, async () => {
  const p = await pagina();
  const r = await p.avaliar(`(async () => {
    const pedidos = [];
    window.vssh.pickFile = async (o) => { pedidos.push(o); return '/graf/nota.md'; };
    window.vssh.pickDirectory = async (o) => { pedidos.push(o); return '/graf'; };

    await showOpenFilePicker({ types: [
      { description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } },
      { accept: { 'application/json': ['.json'] } },
    ] });
    const pasta = await showDirectoryPicker();
    await showOpenFilePicker({ startIn: pasta });
    return pedidos;
  })()`);
  // `types` → a string de grupos que o seletor do desktop entende (Qt: `Nome (padrões);;…`).
  assert.equal(r[0].filter, 'Markdown (*.md *.markdown);;*.json');
  // `startIn` sendo um handle é resolvido: é só o caminho dele.
  assert.equal(r[2].dir, '/graf');
});

test('o que o seletor do desktop não faz, o polyfill DIZ', seNaoTem, async () => {
  const p = await pagina();
  await p.avaliar(`(async () => {
    await showOpenFilePicker({ multiple: true, startIn: 'documents' });
  })()`);
  const texto = p.console.map((c) => c.texto).join('\n');
  // Um array de um item, calado, é a pior versão: o app recebe a FORMA certa com o conteúdo
  // errado e segue como se o usuário tivesse escolhido um arquivo só porque quis.
  assert.match(texto, /multiple:true.*escolha/s);
  assert.match(texto, /startIn: 'documents'/);
  assert.equal(p.console.length, 2, 'um dos dois avisos sumiu');
});

// ── T2 · OPFS ────────────────────────────────────────────────────────────────

test('OPFS já existe nativamente — o polyfill não o reimplementa', seNaoTem, async () => {
  const p = await pagina('meu-app');
  // A lista de pendências dizia que `navigator.storage.getDirectory()` "não existe no polyfill".
  // Não precisa existir: é do navegador. Medir isso foi o que mudou o T2 de "implementar OPFS"
  // para "consertar a isolação do OPFS".
  const r = await p.avaliar(`(async () => {
    const raiz = await navigator.storage.getDirectory();
    const h = await raiz.getFileHandle('cache.db', { create: true });
    const w = await h.createWritable();
    await w.write('dados');
    await w.close();
    return { conteudo: await (await h.getFile()).text(), kind: raiz.kind };
  })()`);
  assert.equal(r.conteudo, 'dados');
  assert.equal(r.kind, 'directory');
});

test('T2 · um app NÃO enxerga o OPFS de outro app', seNaoTem, async () => {
  // O teste que justifica o item inteiro. Sem o polyfill isto falha: OPFS é privado por ORIGEM, e
  // todos os vssh-apps são servidos pela origem do portal. O "private" do nome é privado de outros
  // SITES, não de outros APPS — e quem escreve um vssh-app assume a segunda coisa.
  const a = await pagina('app-a');
  await a.avaliar(`(async () => {
    const raiz = await navigator.storage.getDirectory();
    const h = await raiz.getFileHandle('segredo.db', { create: true });
    const w = await h.createWritable();
    await w.write('o banco do app A');
    await w.close();
  })()`);

  const b = await pagina('app-b');
  const visto = await b.avaliar(`(async () => {
    const raiz = await navigator.storage.getDirectory();
    const nomes = [];
    for await (const n of raiz.keys()) nomes.push(n);
    let leu = null;
    try { leu = await (await (await raiz.getFileHandle('segredo.db')).getFile()).text(); }
    catch (e) { leu = e.name; }
    return { nomes, leu };
  })()`);

  assert.deepEqual(visto.nomes, [], 'o app B enxerga o armazenamento do app A');
  assert.equal(visto.leu, 'NotFoundError');

  // E o app A continua enxergando o que é dele — isolar não pode virar apagar.
  const a2 = await pagina('app-a');
  const meu = await a2.avaliar(`(async () => {
    const raiz = await navigator.storage.getDirectory();
    return (await (await raiz.getFileHandle('segredo.db')).getFile()).text();
  })()`);
  assert.equal(meu, 'o banco do app A');
});

test('fora do proxy, o OPFS fica como o navegador entrega', seNaoTem, async () => {
  // `npm run dev`, um teste, uma página solta: não há outro app com quem colidir, e inventar um
  // nome de pasta ali esconderia o armazenamento de quem estava desenvolvendo contra ele.
  const p = await pagina();   // raiz da origem, sem /proxy/app/
  const r = await p.avaliar(`(async () => {
    const raiz = await navigator.storage.getDirectory();
    // A pergunta certa não é "o que eu criei está visível daqui?" — isso é verdade em qualquer
    // namespace. É "esta raiz É a raiz de verdade?".
    return { ehARaizReal: await raiz.isSameEntry(await window.__raizReal()) };
  })()`);
  assert.equal(r.ehARaizReal, true, 'o polyfill enfiou o armazenamento num subdiretório');
});

test('dentro do proxy, a raiz do app NÃO é a raiz real — e leva o id no nome', seNaoTem, async () => {
  const p = await pagina('meu-app');
  const r = await p.avaliar(`(async () => {
    const minha = await navigator.storage.getDirectory();
    const real = await window.__raizReal();
    const irmaos = [];
    for await (const n of real.keys()) irmaos.push(n);
    return { ehARaizReal: await minha.isSameEntry(real), nome: minha.name, irmaos };
  })()`);
  assert.equal(r.ehARaizReal, false, 'o app está escrevendo na raiz compartilhada da origem');
  assert.equal(r.nome, 'vssh-app-meu-app', 'a pasta não leva o id do app — dois apps colidiriam');
  assert.ok(r.irmaos.includes('vssh-app-meu-app'));
});

test('instanceof aceita as DUAS procedências: nossos handles e os nativos do OPFS', seNaoTem, async () => {
  const p = await pagina('meu-app');
  // Depois de trocarmos os globais pelas nossas classes, um handle NATIVO do OPFS deixaria de
  // passar no `instanceof` — trocaríamos um `instanceof` quebrado por outro. Para o app os dois
  // são handles da mesma API, e ele não tem por que distinguir.
  const r = await p.avaliar(`(async () => {
    const doShell = await showDirectoryPicker();
    const arqShell = await doShell.getFileHandle('nota.md');
    const doOpfs = await navigator.storage.getDirectory();
    const arqOpfs = await doOpfs.getFileHandle('x', { create: true });
    return {
      shellDir:  [doShell instanceof FileSystemHandle,  doShell instanceof FileSystemDirectoryHandle],
      shellArq:  [arqShell instanceof FileSystemHandle, arqShell instanceof FileSystemFileHandle],
      opfsDir:   [doOpfs instanceof FileSystemHandle,   doOpfs instanceof FileSystemDirectoryHandle],
      opfsArq:   [arqOpfs instanceof FileSystemHandle,  arqOpfs instanceof FileSystemFileHandle],
      // E o que NÃO é handle continua não sendo — senão a checagem perdeu o sentido.
      naoEhHandle: [({}) instanceof FileSystemHandle, doShell instanceof FileSystemFileHandle,
                    arqOpfs instanceof FileSystemDirectoryHandle],
    };
  })()`);
  assert.deepEqual(r.shellDir, [true, true]);
  assert.deepEqual(r.shellArq, [true, true]);
  assert.deepEqual(r.opfsDir,  [true, true]);
  assert.deepEqual(r.opfsArq,  [true, true]);
  assert.deepEqual(r.naoEhHandle, [false, false, false]);
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
