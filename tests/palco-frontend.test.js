'use strict';

// O frontend do Palco, montado num Chrome de verdade.
//
// ─── Por que este teste existe, e por que ele mora aqui ──────────────────────
//
// `examples/palco/test/` mede o backend em Python. Nada ali toca a tela, e um app de player pode
// ter backend perfeito e não carregar: um `id` errado, um ícone inexistente, uma `@container` sem
// contêiner — nenhuma dessas coisas dá erro, e todas quebram a janela.
//
// Ele serve os arquivos REAIS do app e as libs REAIS do toolkit, na MESMA ordem de injeção que
// `criar_spa_estatica` usa no backend. É a propriedade que faz o teste valer: uma cópia divergiria
// em silêncio, e a ordem errada (estilos depois de scripts, `tuff-midia.js` ausente) é justamente
// o tipo de coisa que só aparece na tela.
//
// O `vssh` é de mentira porque o app roda dentro do desktop e aqui não há desktop; o backend é de
// mentira porque `api/abrir` já tem 108 testes do lado Python. O que está sob medida é o que sobra:
// a página monta, o transporte responde, e o que tem de cair a 560px cai.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const {
  abrirNavegador, caminhoDoNavegador, motivoDoSkip, servirOrigem,
} = require('./browser/chrome.js');

const RAIZ = path.join(__dirname, '..');
const APP = path.join(RAIZ, 'examples', 'palco', 'frontend');
const WEB = path.join(RAIZ, 'lib', 'web');

const temNavegador = !!caminhoDoNavegador();
const seNaoTem = { skip: temNavegador ? false : motivoDoSkip() };

// ⚠ A MESMA ordem do `criar_spa_estatica` em `backend/main.py`. Se as duas divergirem, este teste
// aprova um carregamento que não acontece — e a divergência mais provável é alguém acrescentar uma
// peça lá e esquecer aqui, então a lista abaixo é conferida contra o main.py logo no primeiro teste.
const ESTILOS = ['tuff/tuff-tokens.css', 'tuff/tuff-base.css', 'tuff/tuff.css', 'tuff/tuff-midia.css'];
const SCRIPTS = ['vssh-app-shim.js', 'fsa-polyfill.js',
                 'tuff/tuff-icones.js', 'tuff/tuff.js', 'tuff/tuff-midia.js'];

const ABERTURA = {
  caminho: '/home/ana/Vídeos/aula 03.mkv',
  nome: 'aula 03.mkv',
  duracao: 3617.2,
  temVideo: true,
  modo: 'remux',
  motivo: 'esta máquina não abre o container avi',
  faixaDeAudio: 1,
  audios: [{ indice: 1, codec: 'ac3', idioma: 'por', titulo: 'Original', canais: 6, padrao: true },
           { indice: 2, codec: 'aac', idioma: 'eng', titulo: null, canais: 2, padrao: false }],
  legendas: [{ indice: 3, codec: 'subrip', idioma: 'por', titulo: null, padrao: false }],
  retomarEm: 724,
  gpu: false,
};

const VIZINHOS = {
  pasta: '/home/ana/Vídeos',
  atual: 2,
  itens: ['aula 01.mkv', 'aula 02.mkv', 'aula 03.mkv', 'aula 10.mkv']
    .map((n) => ({ nome: n, caminho: `/home/ana/Vídeos/${n}` })),
};

/**
 * O `vssh` que o shim daria dentro do desktop, reduzido ao que este app chama.
 *
 * ⚠ Ele entra **depois** dos scripts reais, e a ordem não é detalhe: `vssh-app-shim.js` termina com
 * `window.vssh = vssh`, então um duble instalado antes é simplesmente sobrescrito — e o app passa a
 * falar com o shim de verdade, que sem um shell do outro lado não responde nada. Foi assim que este
 * teste falhou primeiro, e o sintoma (`onOpenContext` nunca chamado) não apontava para a ordem.
 *
 * Os scripts reais continuam sendo carregados na ordem real: o que se mede aqui é que eles
 * carregam e convivem; o que eles CONVERSAM com o shell tem bancada própria em `lib/web/test/`.
 */
const VSSH_FALSO = `
  window.__chamadas = [];
  const anota = (o, r) => { window.__chamadas.push(o); return r; };
  window.vssh = {
    inDesktop: true,
    fs: { urlFor: (p) => anota({ op: 'urlFor', p }, 'blob:falso/' + encodeURIComponent(p)) },
    // ⚠ Devolve \`window.__escolha\` quando o teste tiver posto uma, e \`null\` por padrão. É o que
    // permite exercitar o caminho INTEIRO — botão → menu do ambiente → \`executar()\` — em vez de
    // chamar a função de dentro por uma porta que o app não tem.
    contextMenu: (x, y, itens) => anota({ op: 'contextMenu', x, y, itens },
                                        Promise.resolve(window.__escolha ?? null)),
    window: { close: () => anota({ op: 'close' }) },
    dialog: { alert: (m, t) => anota({ op: 'alert', m, t }, Promise.resolve()) },
    openFolder: (p) => anota({ op: 'openFolder', p }),
    pickFile: () => anota({ op: 'pickFile' }, Promise.resolve(null)),
    lembrarRota: (r) => anota({ op: 'lembrarRota', r }),
    onOpenContext: (fn) => { window.__abrirContexto = fn; },
    // A saída do laço: o app devolve o que não sabe mostrar. Sem ela, um link que o Palco não
    // trata vira uma tela de erro na frente de quem só clicou.
    openUrl: (u, o) => anota({ op: 'openUrl', u, destino: o && o.destino }),
  };`;

function servir(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    let html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    const tags = [
      ...ESTILOS.map((f) => `<link rel="stylesheet" href="/_vssh/${f}">`),
      '<link rel="stylesheet" href="/palco.css">',
      ...SCRIPTS.map((s) => `<script src="/_vssh/${s}"></script>`),
      `<script>${VSSH_FALSO}</script>`,   // ⚠ DEPOIS do shim: ver a nota acima
      // ⚠ A MESMA ordem do `criar_spa_estatica`: `youtube.js` antes, porque ele só DEFINE
      // `montarYoutube`, e é o `palco.js` que a chama no fim do próprio boot. Invertidos, a
      // função ainda não existiria e a aba ficaria inerte — sem erro nenhum.
      '<script src="/youtube.js"></script>',
      '<script src="/palco.js"></script>',
    ].join('\n');
    html = html.replace('</head>', `${tags}\n</head>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (p === '/api/abrir') {
    aberturas += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respostaDeAbrir));
    return true;
  }
  if (p === '/api/vizinhos') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(VIZINHOS));
    return true;
  }
  // ── O YouTube ─────────────────────────────────────────────────────────────
  if (p === '/api/yt/abrir') {
    // ⚠ `null` aqui NÃO serve para simular falha: `JSON.stringify(null)` é `"null"`, que é JSON
    // perfeitamente válido — o `fetch` resolve, o `.json()` resolve, e quem recebe leva um
    // `TypeError` ao ler um campo. Foi assim que a primeira versão deste teste mediu nada.
    if (respostaDeYt === 'FALHAR') { res.writeHead(502); res.end('{}'); return true; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respostaDeYt));
    return true;
  }
  if (p === '/api/yt/mpd') {
    if (!midia) { res.writeHead(503); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'application/dash+xml' });
    res.end(midia.mpd);
    return true;
  }
  const bytes = /^\/api\/yt\/bytes$/.test(p) && u.searchParams.get('f');
  if (bytes) {
    pedidosDeBytes += 1;
    if (!midia) { res.writeHead(503); res.end(); return true; }
    midia.servirBytes(req, res, bytes);
    return true;
  }

  if (p === '/api/yt/listar') {
    listagens.push(u.searchParams.get('url'));
    if (respostaDeListar instanceof Error) {
      res.writeHead(respostaDeListar.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erro: respostaDeListar.message }));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respostaDeListar));
    return true;
  }
  if (p === '/api/yt/miniatura') {
    // 1x1 GIF transparente: o cartão precisa de uma imagem que CARREGA, e não de bytes de verdade.
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    return true;
  }

  // O cano e a legenda: o teste não toca mídia local, e um 204 evita que o `<video>` fique tentando.
  if (p.startsWith('/api/')) { res.writeHead(204); res.end(); return true; }

  // ⚠ Contado, e não só servido: a carga SOB DEMANDA do dash.js é uma decisão de 714 KB, e o único
  // jeito de medir "sob demanda" é contar quem pediu e quando.
  if (p === '/vendor/dash.mediaplayer.min.js') {
    pedidosDoDash += 1;
    const arq = path.join(APP, 'vendor', 'dash.mediaplayer.min.js');
    if (!fs.existsSync(arq)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(arq));
    return true;
  }

  const doApp = /^\/((?:palco|youtube)\.(?:js|css))$/.exec(p);
  const daLib = /^\/_vssh\/([\w./-]+)$/.exec(p);
  const alvo = doApp ? path.join(APP, doApp[1])
    : daLib && !daLib[1].includes('..') ? path.join(WEB, daLib[1]) : null;
  if (!alvo || !fs.existsSync(alvo)) { res.writeHead(404); res.end(); return true; }
  res.writeHead(200, {
    'content-type': alvo.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : alvo.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream',
  });
  res.end(fs.readFileSync(alvo));
  return true;
}

// O que `/api/abrir` responde. É variável porque o modo e a DURAÇÃO mudam o comportamento do
// player, e a duração é a régua que separa "o filme acabou" de "o cano morreu".
let respostaDeAbrir = ABERTURA;
// O que `/api/yt/abrir` responde, e o contador de quem pediu o dash.js.
let respostaDeYt = null;
let pedidosDoDash = 0;
let respostaDeListar = null;
let listagens = [];
let pedidosDeBytes = 0;
let midia = null;
// ⚠ Quantas vezes o app pediu para abrir. É o que mede "ele avançou de arquivo" sem ambiguidade: a
// bancada responde sempre o mesmo `nome`, então ler a tela não distingue avançar de ficar parado.
let aberturas = 0;

let nav = null;
let origem = null;

before(async () => {
  if (!temNavegador) return;
  nav = await abrirNavegador();
  origem = await servirOrigem(servir);
});
after(async () => {
  if (nav) await nav.fechar();
  if (origem && origem.fechar) await origem.fechar();
});

/** Uma página com o app montado e um arquivo já aberto. */
async function comArquivoAberto(largura) {
  const p = await nav.novaPagina(origem.url);
  if (largura) await p.avaliar(`document.querySelector('.janela').style.width = '${largura}px'`);
  await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'arquivo', path: ${JSON.stringify(ABERTURA.caminho)} });
    await new Promise((r) => setTimeout(r, 250));
  })()`);
  return p;
}

// ── Um `ended` não quer dizer que o arquivo acabou ──────────────────────────
//
// ⚠ O defeito que este bloco existe para impedir, e ele já aconteceu na tela: um `.avi` tocou UM
// QUADRO e o player pôs de volta o vídeo anterior. O cano tinha morrido, o corpo `chunked` fechou
// limpo, o navegador disparou `ended`, e o avanço automático fez o resto — transformando uma falha
// em outra coisa tocando. É o pior formato de defeito que existe: o sintoma não parece erro, parece
// o programa funcionando.

/** Dispara um `ended` na página e devolve quantas aberturas ele provocou. */
async function comEndedApos(resposta) {
  respostaDeAbrir = resposta;
  const p = await comArquivoAberto();
  const antes = aberturas;
  const aviso = await p.avaliar(`(async () => {
    document.getElementById('video').dispatchEvent(new Event('ended'));
    await new Promise((r) => setTimeout(r, 300));
    // ⚠ O texto E o \`hidden\`: o aviso vive num elemento que só aparece quando tem o que dizer, e
    // um teste que lesse só o texto aprovaria uma caixa vazia desenhada sobre o vídeo para sempre.
    const a = document.getElementById('aviso');
    return a.hidden ? '' : document.getElementById('aviso-t').textContent;
  })()`);
  respostaDeAbrir = ABERTURA;
  return { avancou: aberturas - antes, aviso };
}

test('um `ended` LONGE do fim é falha, e não motivo para avançar', seNaoTem, async () => {
  // Duração de uma hora, e o `<video>` nem chegou a tocar: `agoraReal()` é zero. É o `.avi` que
  // morreu no primeiro quadro, reproduzido.
  const r = await comEndedApos(ABERTURA);
  assert.equal(r.avancou, 0,
    'o player abriu outro arquivo por causa de um fluxo truncado — é o defeito do `.avi` inteiro');
  assert.match(r.aviso, /parou em .*antes do fim/i,
    'e quem estava assistindo não ficou sabendo que o fluxo caiu');
});

test('sem régua verdadeira, o `ended` continua avançando', seNaoTem, async () => {
  // ⚠ A outra metade, e sem ela a guarda viraria um desligamento do recurso: quando o `ffprobe` não
  // soube a duração não há de que desconfiar, e recusar o avanço ali deixaria uma pasta parando a
  // cada arquivo — trocando um defeito raro por um constante.
  const r = await comEndedApos({ ...ABERTURA, duracao: null });
  assert.equal(r.avancou, 1, 'sem duração conhecida o fim de arquivo tinha de avançar normalmente');
  // ⚠ Não se afirma que o aviso está VAZIO: a bancada responde 204 no cano, então o `<video>` erra
  // de verdade e a barra diz isso com razão. O que não pode aparecer é o diagnóstico de truncamento,
  // que aqui seria falso.
  assert.doesNotMatch(r.aviso, /antes do fim/,
    'acusou fluxo truncado sem ter régua para saber disso');
});

test('Informações do arquivo diz COMO está sendo servido e quanto a tela perdeu', seNaoTem, async () => {
  // ⚠ Este diálogo é o instrumento de diagnóstico do app, e por isso é medido: quando alguém diz
  // "está travando", o caminho tem quatro trechos (ffmpeg, portal, rede, navegador) e os três
  // primeiros aparecem no log do servidor. O quarto só existe na máquina que desenha.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(async () => {
    window.__chamadas.length = 0;
    window.__escolha = 'info';
    document.querySelector('[data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const alerta = window.__chamadas.find((c) => c.op === 'alert');
    return alerta ? alerta.m : null;
  })()`);
  assert.ok(r, 'o diálogo de informações não abriu');
  assert.match(r, /reembalado no servidor/, 'não disse como o arquivo está sendo servido');
  // Sem mídia de verdade na bancada não há quadros, e a linha some — o que se prende aqui é que ela
  // não é inventada: `getVideoPlaybackQuality` com zero quadros não vira "0 perdidos (NaN%)".
  assert.doesNotMatch(r, /NaN|undefined/, 'o diálogo mostrou conta de quadros sem ter quadros');
});

// ── A lista de injeção, contra o backend ────────────────────────────────────

test('a ordem de injeção deste teste é a do backend', seNaoTem, () => {
  // ⚠ Sem isto o teste apodrece silenciosamente: alguém acrescenta uma folha ao `main.py`, a
  // página real passa a ter uma peça a mais, e aqui continua verde medindo outra coisa.
  const main = fs.readFileSync(path.join(RAIZ, 'examples', 'palco', 'backend', 'main.py'), 'utf8');
  assert.ok(main.includes('ESTILOS_MIDIA'), 'o backend deixou de injetar as folhas de mídia');
  assert.ok(main.includes('SCRIPTS_MIDIA'),
    'o backend deixou de injetar `tuff-midia.js` — sem ela não há trilha nem timecode');
  assert.ok(main.includes('"palco.css"'), 'o backend deixou de injetar o CSS do app');
  assert.ok(main.includes('"palco.js"'), 'o backend deixou de injetar o JS do app');
});

// ── A página monta ──────────────────────────────────────────────────────────

test('a página carrega sem erro de script', seNaoTem, async () => {
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => ({
    temVssh: typeof window.vssh === 'object',
    temTuffMidia: typeof window.TuffMidia === 'object',
    ligouOpenContext: typeof window.__abrirContexto === 'function',
    trilha: !!document.querySelector('.tuff-trilha-trilho'),
    veloc: document.getElementById('btn-veloc').textContent,
  }))()`);

  // Se o `palco.js` tivesse lançado, `__abrirContexto` não existiria: é a última coisa que ele
  // liga, e por isso o melhor sinal de "o arquivo rodou até o fim".
  assert.equal(r.ligouOpenContext, true, 'o palco.js não chegou ao fim — houve exceção no meio');
  assert.equal(r.temTuffMidia, true);
  assert.equal(r.trilha, true, 'a TuffMidia não montou a trilha dentro do transporte');
  assert.equal(r.veloc, '1×');
});

test('o botão de tocar mantém o ÍCONE depois de a lib mexer nele', seNaoTem, async () => {
  // O defeito que este app revelou na biblioteca: `textContent = '▶'` apagava o `<svg>`. Aqui a
  // conferência é sobre o app montado de verdade, e não sobre uma bancada mínima.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const b = document.getElementById('btn-play');
    return { icone: b.querySelector('use')?.getAttribute('href'), rotulo: b.getAttribute('aria-label') };
  })()`);
  assert.equal(r.icone, '#ico-play');
  assert.equal(r.rotulo, 'Reproduzir');
});

// ── Abrir um arquivo ────────────────────────────────────────────────────────

test('o open-context abre o arquivo e a interface responde inteira', seNaoTem, async () => {
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(() => ({
    nome: document.getElementById('agora-nome').textContent,
    titulo: document.title,
    vazioSumiu: document.getElementById('vazio-palco').hidden,
    retomar: document.getElementById('retomar').hidden === false
      ? document.getElementById('retomar-t').textContent : null,
    total: document.querySelector('[data-tuff-tempo-total]').textContent,
    legendas: [...document.querySelectorAll('#video track')].map((t) => t.label),
    modosDeLegenda: [...document.getElementById('video').textTracks].map((t) => t.mode),
    linhas: [...document.querySelectorAll('.linha-arq')].map((l) => l.textContent),
    tocando: document.querySelector('.linha-arq--tocando')?.textContent,
  }))()`);

  assert.equal(r.nome, 'aula 03.mkv');
  assert.match(r.titulo, /^aula 03\.mkv — Palco$/);
  assert.equal(r.vazioSumiu, true, 'o estado vazio continuou por cima do vídeo');

  // ⚠ A duração vem do ffprobe, não do `<video>` — que aqui não carregou mídia nenhuma. É a
  // fonte de tempo da TuffMidia funcionando: sem ela a linha do tempo ficaria `--:--` no modo
  // remuxado, que é justamente onde o navegador não sabe responder.
  assert.equal(r.total, '1:00:17', `a régua não veio do servidor: ${r.total}`);
  assert.equal(r.retomar, '12:04', 'a faixa de retomada não apareceu com o tempo certo');

  assert.deepEqual(r.legendas, ['Português'],
    'a legenda embutida não virou `<track>` com nome legível');
  assert.deepEqual(r.modosDeLegenda, ['disabled'],
    'a legenda nasceu LIGADA: tampar a imagem de quem não pediu é escolha do app, não padrão');

  // A ordem natural veio do backend e a tabela a preserva; a linha que toca é a terceira.
  assert.equal(r.linhas.length, 4);
  assert.ok(r.tocando.includes('aula 03.mkv'), `a linha marcada é ${r.tocando}`);
});

test('a busca da biblioteca filtra, e o número da linha continua sendo o da PASTA', seNaoTem, async () => {
  // ⚠ O número renumerado ao filtrar mentiria: "3 de 4" viraria "1 de 1", e a pessoa perderia a
  // referência de onde o arquivo está na pasta — que é a única coisa que a coluna serve para dizer.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(() => {
    const campo = document.getElementById('bib-busca');
    campo.value = '10';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return [...document.querySelectorAll('.linha-arq')].map((l) => l.firstChild.textContent);
  })()`);
  assert.deepEqual(r, ['4'], 'o filtro renumerou as linhas');
});

// ── O transporte ────────────────────────────────────────────────────────────

test('a velocidade abre uma LISTA em vez de ciclar', seNaoTem, async () => {
  // Ciclar num botão só exigia quatro cliques para chegar ao valor vizinho e escondia as opções.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(async () => {
    document.getElementById('btn-veloc').click();
    await new Promise((r) => setTimeout(r, 30));
    const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
    return {
      houve: !!c,
      valores: c ? c.itens.filter((i) => i.id).map((i) => i.label) : [],
      marcado: c ? c.itens.find((i) => i.checked)?.label : null,
      cabecalho: c ? c.itens[0].header : null,
    };
  })()`);

  assert.equal(r.houve, true, 'o botão de velocidade não pediu menu ao ambiente');
  assert.equal(r.valores.length, 7);
  assert.equal(r.marcado, 'Normal (1×)', 'o valor atual não vem marcado, e ele é a âncora da lista');
  assert.equal(r.cabecalho, 'Velocidade');
});

test('a engrenagem só oferece o que ESTE arquivo tem', seNaoTem, async () => {
  // Contextual: um menu com "Faixa de áudio" vazio informa que o programa é complicado e não
  // ajuda em nada. E o rótulo da faixa é o que a torna escolhível — "Faixa 1" não é escolha.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(async () => {
    document.getElementById('btn-ajustes').click();
    await new Promise((r) => setTimeout(r, 30));
    const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
    return c.itens.map((i) => (i.separator ? '───' : i.header || i.label));
  })()`);

  assert.deepEqual(r, [
    'Faixa de áudio', 'Português · Original · 6 canais', 'Inglês',
    // A régua entre os dois grupos: sem ela, "Português" da legenda encosta em "Inglês" do áudio e
    // as duas listas leem como uma só, em que a pessoa escolheria idioma de áudio sem querer.
    '───',
    'Legenda', 'Sem legenda', 'Português',
  ]);
});

test('repetir é TRI-estado, e o terceiro troca de ícone', seNaoTem, async () => {
  // Cor sozinha distingue dois estados, não três: "repetindo a pasta" e "repetindo este" ficariam
  // idênticos, e o botão viraria uma aposta.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(() => {
    const b = document.getElementById('btn-repetir');
    const estado = () => [b.getAttribute('aria-pressed'), b.querySelector('use').getAttribute('href')];
    const fora = estado(); b.click();
    const lista = estado(); b.click();
    const uma = estado(); b.click();
    return { fora, lista, uma, volta: estado() };
  })()`);

  assert.deepEqual(r.fora, ['false', '#ico-repeat']);
  assert.deepEqual(r.lista, ['true', '#ico-repeat']);
  assert.deepEqual(r.uma, ['true', '#ico-repeat-one'], 'o terceiro estado não trocou de ícone');
  assert.deepEqual(r.volta, ['false', '#ico-repeat']);
});

test('o teclado não rouba as teclas de dentro de um campo', seNaoTem, async () => {
  // ⚠ A guarda que todo player esquece: sem ela, filtrar a biblioteca pausa o vídeo a cada
  // espaço digitado, e as setas saltam dez segundos em vez de mover o cursor.
  const p = await comArquivoAberto();
  const r = await p.avaliar(`(() => {
    const campo = document.getElementById('bib-busca');
    campo.focus();
    const dentro = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    campo.dispatchEvent(dentro);
    const fora = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(fora);
    return { noCampo: dentro.defaultPrevented, noCorpo: fora.defaultPrevented };
  })()`);

  assert.equal(r.noCampo, false, 'o atalho roubou o espaço de dentro de um campo de texto');
  assert.equal(r.noCorpo, true, 'e fora do campo ele tem de continuar valendo');
});

// ── A janela estreita ───────────────────────────────────────────────────────

test('a 560px o PLAY continua na tela, e o que cai é o secundário', seNaoTem, async () => {
  // ⚠ Medido, e foi um defeito de verdade no mockup: sem o `container-type` na `.janela`, as
  // `@container` não tinham ancestral e simplesmente não se aplicavam — nada caía, e o botão de
  // tocar era empurrado para fora da janela. Um player sem play.
  const p = await comArquivoAberto(560);
  const r = await p.avaliar(`(() => {
    const janela = document.querySelector('.janela').getBoundingClientRect();
    const cx = (id) => {
      const e = document.getElementById(id);
      const b = e.getBoundingClientRect();
      return { visivel: b.width > 0, dentro: b.left >= janela.left - 1 && b.right <= janela.right + 1 };
    };
    return {
      play: cx('btn-play'),
      trilha: document.querySelector('.tuff-trilha').getBoundingClientRect().width > 40,
      anterior: cx('btn-anterior').visivel,
      aleatorio: cx('btn-aleatorio').visivel,
      ajustes: cx('btn-ajustes').visivel,
      tela: cx('btn-tela').visivel,
      menuVideo: document.querySelector('[data-menu=video]').getBoundingClientRect().width > 0,
      menuMidia: document.querySelector('[data-menu=midia]').getBoundingClientRect().width > 0,
    };
  })()`);

  assert.deepEqual(r.play, { visivel: true, dentro: true },
    'o botão de tocar saiu da janela — é o controle que a pessoa procura sem olhar');
  assert.equal(r.trilha, true, 'a trilha foi espremida a nada');
  assert.equal(r.ajustes, true, 'faixas e legendas não podem cair: é o que resolve vídeo mudo');
  assert.equal(r.tela, true, 'tela cheia não pode cair');
  assert.equal(r.anterior, false, 'os secundários do transporte tinham de cair');
  assert.equal(r.aleatorio, false);
  assert.equal(r.menuVideo, false, 'os menus secundários tinham de cair');
  assert.equal(r.menuMidia, true, 'Mídia e Reprodução nunca caem');
});

// ── O YouTube: a COSTURA, não a reprodução ─────────────────────────────────
//
// Que um MPD gerado pelo backend toca no dash.js quem prova é `palco-dash.test.js`, com o ffmpeg
// e o Chrome. O que falta provar é a costura no app, e ela tem três partes que só quebram em
// silêncio: devolver o que não sabemos mostrar, carregar 714 KB só quando são precisos, e soltar o
// elemento antes que outra fonte o assuma.

const dashDeTeste = require('./browser/dash-de-teste.js');

const semMidia = dashDeTeste.motivoDoSkip();
const seNaoTemMidia = { skip: seNaoTem.skip || semMidia || false };

before(() => {
  if (seNaoTemMidia.skip) return;
  midia = dashDeTeste.montar('/api/yt/bytes?v=aaaaaaaaaaa&f=');
});
after(() => { if (midia) midia.limpar(); });

/** Abre uma URL pela porta de entrada do app — o mesmo caminho que o roteamento de link usa. */
async function comUrlAberta(url, resposta) {
  respostaDeYt = resposta;
  const p = await nav.novaPagina(origem.url);
  await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url', url: ${JSON.stringify(url)} });
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  return p;
}

test('o que o Palco não sabe mostrar VOLTA para o navegador', seNaoTem, async () => {
  // ⚠ É a regra que impede o deeplink de ficar PIOR que não existir: quem clica num link tem de
  // chegar a algum lugar.
  //
  // ⚠ E o exemplo MUDOU junto com a aba. Antes era uma playlist — que hoje abre a aba, e por isso
  // este teste passou a falhar quando ela nasceu. A falha estava certa: o que sobra para devolver
  // é o que o Palco não reivindica, e é isso que o teste tem de medir agora. Um teste que
  // continuasse usando playlist estaria prendendo o comportamento antigo contra o novo.
  const p = await comUrlAberta('https://vimeo.com/12345',
                               { tipo: 'nao-e-nosso' });
  const chamadas = await p.avaliar('window.__chamadas.filter((c) => c.op === "openUrl")');
  assert.equal(chamadas.length, 1, 'o link não foi devolvido');
  assert.equal(chamadas[0].destino, 'navegador');
  assert.match(chamadas[0].u, /vimeo\.com/);
});

test('o dash.js NÃO é baixado ao abrir um arquivo da pasta', seNaoTem, async () => {
  // 714 KB. Quem abre um `.mkv` da própria pasta não pode pagar por um cliente DASH que nunca vai
  // usar — e abrir arquivo local é o caso principal deste app, não o secundário.
  pedidosDoDash = 0;
  await comArquivoAberto();
  assert.equal(pedidosDoDash, 0,
    'o dash.js foi carregado para tocar um arquivo local: a carga sob demanda quebrou');
});

test('um vídeo do YouTube toca no MESMO player, e o dash.js vem uma vez só', seNaoTemMidia,
  async () => {
    pedidosDoDash = 0;
    const p = await comUrlAberta('https://youtu.be/aaaaaaaaaaa', {
      tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'Um canal',
      duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90, 180],
    });
    const r = await p.avaliar(`(async () => {
      const v = document.getElementById('video');
      const ate = Date.now() + 15000;
      while (Date.now() < ate && v.currentTime < 1) await new Promise((r) => setTimeout(r, 100));
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
      return {
        tempo: v.currentTime, altura: v.videoHeight, desenhados: q.totalVideoFrames || 0,
        nome: document.getElementById('agora-nome').textContent,
        vazio: document.getElementById('vazio-palco').hidden,
        preparando: document.getElementById('preparando').hidden,
      };
    })()`);

    assert.ok(r.tempo >= 1, `não tocou: ${JSON.stringify(r)}`);
    assert.ok(r.altura > 0, 'nada foi desenhado na tela');
    assert.equal(r.nome, 'Um vídeo', 'o transporte não mostrou o que está tocando');
    assert.equal(r.vazio, true, 'o estado vazio continuou por cima do vídeo');
    assert.equal(r.preparando, true, '"Preparando" ficou preso na tela');
    assert.equal(pedidosDoDash, 1, `o dash.js foi baixado ${pedidosDoDash} vezes`);
  });

test('abrir um arquivo local DEPOIS de um do YouTube funciona', seNaoTemMidia, async () => {
  // ⚠ **O defeito da SEGUNDA abertura**, e nenhum teste de abertura única o acharia. O dash.js
  // mantém `MediaSource` e `SourceBuffer` presos ao `<video>`; um `video.src = …` por cima não os
  // desfaz, e o arquivo local simplesmente não toca — sem erro, porque quem manda no elemento
  // ainda é o outro player.
  const p = await comUrlAberta('https://youtu.be/aaaaaaaaaaa', {
    tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'Um canal',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  });
  await p.avaliar(`(async () => {
    const v = document.getElementById('video');
    const ate = Date.now() + 15000;
    while (Date.now() < ate && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 100));
  })()`);

  const r = await p.avaliar(`(async () => {
    window.__chamadas.length = 0;
    window.__abrirContexto({ type: 'open-context', tipo: 'arquivo', path: ${JSON.stringify(ABERTURA.caminho)} });
    await new Promise((r) => setTimeout(r, 500));
    const v = document.getElementById('video');
    return {
      src: v.currentSrc || v.src,
      nome: document.getElementById('agora-nome').textContent,
    };
  })()`);

  // ⚠ O sinal é a FONTE do `<video>`, e não uma chamada ao `vssh`: o arquivo desta bancada é modo
  // `remux`, então ele vai pelo cano (`api/fluxo`) e nunca passa por `fs.urlFor`. A primeira versão
  // deste teste contava `urlFor` e falhou por medir o caminho errado — o que foi sorte, porque
  // um teste que medisse o caminho errado e passasse não denunciaria nada.
  assert.equal(r.nome, ABERTURA.nome, 'o transporte não trocou de faixa');
  assert.match(r.src, /api\/fluxo/,
    `o <video> continuou com a fonte do dash.js (${r.src}) — o MediaSource não foi solto`);
  assert.doesNotMatch(r.src, /^blob:/, 'a fonte ainda é um MediaSource');
});

test('dois vídeos do YouTube em sequência, e o dash.js continua vindo uma vez só', seNaoTemMidia,
  async () => {
    // Duas coisas de uma vez: que o segundo vídeo toca (dois `MediaPlayer` sobre o mesmo `<video>`
    // é o cenário onde eles poderiam brigar) e que os 714 KB não são baixados de novo.
    const yt = {
      tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'C',
      duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
    };
    pedidosDoDash = 0;
    const p = await comUrlAberta('https://youtu.be/aaaaaaaaaaa', yt);
    await p.avaliar(`(async () => {
      const v = document.getElementById('video');
      const ate = Date.now() + 15000;
      while (Date.now() < ate && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 100));
    })()`);

    const r = await p.avaliar(`(async () => {
      const v = document.getElementById('video');
      window.__abrirContexto({ type: 'open-context', tipo: 'url', url: 'https://youtu.be/bbbbbbbbbbb' });
      await new Promise((r) => setTimeout(r, 800));
      const ate = Date.now() + 15000;
      while (Date.now() < ate && v.currentTime < 1.5) await new Promise((r) => setTimeout(r, 100));
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
      return { tempo: v.currentTime, altura: v.videoHeight, desenhados: q.totalVideoFrames || 0 };
    })()`);

    assert.ok(r.tempo >= 1.5, `o segundo vídeo não tocou: ${JSON.stringify(r)}`);
    assert.ok(r.altura > 0, 'o segundo vídeo não desenhou nada');
    assert.equal(pedidosDoDash, 1, `o dash.js foi baixado ${pedidosDoDash} vezes para dois vídeos`);
  });

test('quando a reprodução do YouTube falha, a tela DIZ — e não fica em "Preparando"', seNaoTem,
  async () => {
    // ⚠ O defeito que este teste prende apareceu ao investigar por que uma mutação não mordia.
    // Quem esconde "Preparando" no caminho normal são os eventos `loadeddata`/`playing` do
    // `<video>`; quando o dash.js falha, nenhum dos dois chega. Sem o ouvinte de erro a pessoa
    // fica olhando um spinner que nunca termina, e nada no console diz por quê.
    //
    // A bancada produz a falha do jeito mais realista: um MPD que não carrega. `midia` é `null`
    // aqui de propósito quando não há ffmpeg — e mesmo com ele, o `v=` abaixo não tem mídia.
    const p = await comUrlAberta('https://youtu.be/zzzzzzzzzzz', {
      tipo: 'video', id: 'zzzzzzzzzzz', titulo: 'Vídeo quebrado', canal: 'C',
      duracao: 10, mpd: 'api/yt/mpd-que-nao-existe', legendas: [], qualidades: [],
    });
    const r = await p.avaliar(`(async () => {
      const ate = Date.now() + 12000;
      while (Date.now() < ate && document.getElementById('aviso').hidden) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        preparando: document.getElementById('preparando').hidden,
        aviso: document.getElementById('aviso').hidden,
        texto: document.getElementById('aviso-t').textContent,
      };
    })()`);

    assert.equal(r.aviso, false, 'a falha não foi dita na tela');
    assert.match(r.texto, /falhou/i);
    assert.equal(r.preparando, true, '"Preparando" ficou preso para sempre');
  });

test('uma falha ao consultar o YouTube devolve o link, em vez de ficar com ele', seNaoTem,
  async () => {
    // ⚠ Este caminho é diferente do `nao-e-nosso`: ali o servidor RESPONDEU "não é meu"; aqui ele
    // não respondeu. O reflexo é mostrar um erro e parar — mas quem clicou num link tem de chegar
    // a algum lugar, e o navegador é um lugar. Ficar com o link é o beco de novo, por outra porta.
    respostaDeYt = 'FALHAR';                   // faz `/api/yt/abrir` responder 502
    const p = await nav.novaPagina(origem.url);
    await p.avaliar(`(async () => {
      window.__abrirContexto({ type: 'open-context', tipo: 'url', url: 'https://youtu.be/ccccccccccc' });
      await new Promise((r) => setTimeout(r, 600));
    })()`);
    const chamadas = await p.avaliar('window.__chamadas.filter((c) => c.op === "openUrl")');
    assert.equal(chamadas.length, 1, 'o link não foi devolvido depois da falha');
    assert.equal(chamadas[0].destino, 'navegador');
  });

test('um corpo vazio com 200 também devolve o link', seNaoTem, async () => {
  // ⚠ Este é o caso que ensinou a guarda `!r`, e ele é traiçoeiro porque NADA falha: `null` é JSON
  // válido, o `fetch` resolve, o `.json()` resolve, e a primeira leitura de campo levanta um
  // `TypeError` de dentro de um `async` — que ninguém pega. O spinner fica, o link some, e o
  // console mostra um erro que não parece ter relação com o link em que a pessoa clicou.
  respostaDeYt = null;                       // 200, com o corpo literal `null`
  const p = await nav.novaPagina(origem.url);
  await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url', url: 'https://youtu.be/ddddddddddd' });
    await new Promise((r) => setTimeout(r, 600));
  })()`);
  const r = await p.avaliar(`({
    openUrl: window.__chamadas.filter((c) => c.op === 'openUrl').length,
    preparando: document.getElementById('preparando').hidden,
  })`);
  assert.equal(r.openUrl, 1, 'o link não foi devolvido — o corpo vazio virou um TypeError solto');
  assert.equal(r.preparando, true, '"Preparando" ficou preso');
});

// ── A aba do YouTube ────────────────────────────────────────────────────────
//
// Ela é o que destrava `opens.urls`: no instante em que o roteamento existe, TODO endereço do
// YouTube chega aqui. Estes testes são a régua de que nenhum deles vira beco.

const LISTAGEM = {
  tipo: 'busca',
  titulo: 'gatos',
  itens: Array.from({ length: 12 }, (_, i) => ({
    id: `aaaaaaaaaa${i}`,
    titulo: `Vídeo número ${i} com um título comprido o bastante para cortar em duas linhas`,
    duracao: 60 + i * 30,
    canal: `Canal ${i}`,
    visualizacoes: 1500000 + i,
    aoVivo: i === 3,
    miniatura: `api/yt/miniatura?v=aaaaaaaaaa${i}`,
  })),
};

async function comAbaAberta() {
  const p = await nav.novaPagina(origem.url);
  await p.avaliar(`(async () => {
    document.querySelector('[data-aba="youtube"]').click();
    await new Promise((r) => setTimeout(r, 100));
  })()`);
  return p;
}

/** Digita na caixa e espera os cartões — o caminho que a pessoa percorre. */
const BUSCAR = (termo, ate) => `(async () => {
  const b = document.getElementById('yt-busca');
  b.value = ${JSON.stringify(termo)};
  b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const prazo = Date.now() + 8000;
  while (Date.now() < prazo && !(${ate})) await new Promise((r) => setTimeout(r, 100));
})()`;

test('a aba existe, e o transporte NÃO some ao entrar nela', seNaoTem, async () => {
  // ⚠ É a diferença entre um programa de reprodução e uma página com vídeo dentro: o vídeo não
  // parou de tocar só porque a pessoa foi procurar a próxima coisa.
  const p = await comAbaAberta();
  const r = await p.avaliar(`(() => {
    const t = document.getElementById('transporte').getBoundingClientRect();
    return {
      painel: !!document.querySelector('#painel-youtube.painel--ativo'),
      aba: document.querySelector('[data-aba="youtube"]').getAttribute('aria-selected'),
      transporte: t.height,
      temBusca: !!document.getElementById('yt-busca'),
    };
  })()`);
  assert.equal(r.painel, true, 'o painel do YouTube não ficou ativo');
  assert.equal(r.aba, 'true');
  assert.ok(r.transporte > 40, `o transporte sumiu na aba do YouTube (${r.transporte}px)`);
  assert.equal(r.temBusca, true);
});

test('buscar desenha cartões com capa, duração e canal', seNaoTem, async () => {
  respostaDeListar = LISTAGEM;
  listagens = [];
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));
  const r = await p.avaliar(`(() => {
    const cartoes = [...document.querySelectorAll('.yt-cartao')];
    const um = cartoes[0];
    const capa = um && um.querySelector('.yt-capa');
    return {
      quantos: cartoes.length,
      temImagem: !!(capa && capa.querySelector('img')),
      capaLargura: capa ? capa.getBoundingClientRect().width : 0,
      dur: um ? (um.querySelector('.yt-dur') || {}).textContent : null,
      nome: um ? um.querySelector('.yt-nome').textContent.slice(0, 20) : null,
      canal: um ? um.querySelector('.yt-canal').textContent : null,
      aoVivo: [...document.querySelectorAll('.yt-dur.ao-vivo')].map((e) => e.textContent),
      vazio: document.getElementById('yt-vazio').hidden,
    };
  })()`);

  assert.ok(r.quantos >= 4, `poucos cartões desenhados: ${r.quantos}`);
  assert.equal(r.temImagem, true, 'o cartão saiu sem capa');
  // ⚠ A largura, e não só a existência: um `<svg>`/`<div>` sem CSS tem tamanho default e satisfaz
  // qualquer "existe" — foi assim que uma bancada aprovou a versão quebrada numa sessão anterior.
  assert.ok(r.capaLargura > 60, `a capa não tem tamanho (${r.capaLargura}px) — o CSS não pegou`);
  assert.equal(r.dur, '1:00', 'o selo de duração não é o tempo do vídeo');
  assert.match(r.nome, /Vídeo número 0/);
  assert.match(r.canal, /Canal 0 · 1,5 mi de visualizações/);
  assert.deepEqual(r.aoVivo, ['AO VIVO'], 'a transmissão ao vivo não foi marcada');
  assert.equal(r.vazio, true, 'o estado vazio ficou por cima da grade');
  assert.equal(listagens.length, 1);
  assert.match(listagens[0], /results\?search_query=gatos/);
});

test('uma busca nova NÃO deixa os cartões da anterior na tela', seNaoTem, async () => {
  // ⚠ O defeito que este teste prende é da própria lib, e é silencioso: a grade só remonta uma
  // célula quando o ÍNDICE dela muda — o certo para rolagem, e errado aqui. Com o mesmo número de
  // resultados, os cartões antigos ficariam com os títulos e as capas anteriores sobre uma lista
  // nova. Nada falharia, e a grade estaria mentindo.
  respostaDeListar = LISTAGEM;
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));

  // A segunda resposta tem o MESMO número de itens, e títulos diferentes.
  respostaDeListar = {
    ...LISTAGEM,
    titulo: 'cachorros',
    itens: LISTAGEM.itens.map((i, n) => ({ ...i, titulo: `Cachorro ${n}` })),
  };
  await p.avaliar(BUSCAR(
    'cachorros',
    "(document.querySelector('.yt-nome') || {}).textContent?.startsWith('Cachorro')"));
  const nomes = await p.avaliar(
    "[...document.querySelectorAll('.yt-nome')].slice(0, 4).map((e) => e.textContent)");
  assert.ok(nomes.length >= 4, 'a grade ficou vazia');
  for (const nome of nomes) {
    assert.match(nome, /^Cachorro/, `um cartão da busca anterior ficou na tela: ${nome}`);
  }
});

test('abrir um cartão toca no MESMO player e volta para Reproduzindo', seNaoTemMidia, async () => {
  respostaDeListar = LISTAGEM;
  respostaDeYt = {
    tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Vídeo escolhido', canal: 'Canal 0',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.tuff-miniatura')"));
  const r = await p.avaliar(`(async () => {
    // Duplo-clique, que é o gesto do gerenciador de arquivos e o que a grade escuta.
    document.querySelector('.tuff-miniatura')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const v = document.getElementById('video');
    const prazo = Date.now() + 15000;
    while (Date.now() < prazo && v.currentTime < 1) await new Promise((r) => setTimeout(r, 100));
    return {
      tempo: v.currentTime,
      altura: v.videoHeight,
      naAba: !!document.querySelector('#painel-reproduzindo.painel--ativo'),
      nome: document.getElementById('agora-nome').textContent,
    };
  })()`);

  assert.ok(r.tempo >= 1, `o cartão não tocou: ${JSON.stringify(r)}`);
  assert.ok(r.altura > 0, 'nada foi desenhado');
  assert.equal(r.naAba, true, 'não voltou para Reproduzindo — quem abre um vídeo quer vê-lo');
  assert.equal(r.nome, 'Vídeo escolhido');
});

test('um link de PLAYLIST abre a aba, e não o player vazio', seNaoTem, async () => {
  // ⚠ A metade que torna o deeplink honesto. Sem ela o Palco declararia `opens.urls` e devolveria
  // ao navegador metade dos endereços que reivindicou.
  respostaDeListar = { ...LISTAGEM, tipo: 'playlist', titulo: 'Minha lista' };
  listagens = [];
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://www.youtube.com/playlist?list=PLabc123' });
    const prazo = Date.now() + 8000;
    while (Date.now() < prazo && !document.querySelector('.yt-cartao')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      naAba: !!document.querySelector('#painel-youtube.painel--ativo'),
      titulo: document.getElementById('yt-titulo').textContent,
      cartoes: document.querySelectorAll('.yt-cartao').length,
      openUrl: window.__chamadas.filter((c) => c.op === 'openUrl').length,
    };
  })()`);
  assert.equal(r.naAba, true, 'a playlist não abriu a aba do YouTube');
  assert.ok(r.cartoes > 0, 'a playlist abriu a aba vazia');
  assert.equal(r.titulo, 'Minha lista');
  assert.equal(r.openUrl, 0, 'a playlist foi devolvida ao navegador — o deeplink virou beco');
  assert.equal(listagens.length, 1);
  assert.match(listagens[0], /playlist\?list=PLabc123/);
});

test('um link de CANAL também abre a aba', seNaoTem, async () => {
  respostaDeListar = { ...LISTAGEM, tipo: 'canal', titulo: 'Blender' };
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://www.youtube.com/@BlenderOfficial' });
    const prazo = Date.now() + 8000;
    while (Date.now() < prazo && !document.querySelector('.yt-cartao')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      naAba: !!document.querySelector('#painel-youtube.painel--ativo'),
      titulo: document.getElementById('yt-titulo').textContent,
      openUrl: window.__chamadas.filter((c) => c.op === 'openUrl').length,
    };
  })()`);
  assert.equal(r.naAba, true, 'o canal não abriu a aba');
  assert.equal(r.titulo, 'Blender');
  assert.equal(r.openUrl, 0);
});

test('um canal sem vídeos DIZ o que houve, e não manda atualizar o yt-dlp', seNaoTem, async () => {
  // ⚠ A distinção importa porque o conserto é diferente: "este canal não tem vídeos" é uma
  // resposta legítima do YouTube (medida: "This channel does not have a videos tab"), e mandar a
  // pessoa atualizar uma dependência por causa disso é mandá-la resolver o problema errado.
  respostaDeListar = Object.assign(new Error('este canal não tem vídeos publicados'),
                                   { status: 404 });
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://www.youtube.com/@vazio' });
    const prazo = Date.now() + 8000;
    while (Date.now() < prazo
           && document.getElementById('yt-vazio-titulo').textContent === 'Procure um vídeo') {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      titulo: document.getElementById('yt-vazio-titulo').textContent,
      msg: document.getElementById('yt-vazio-msg').textContent,
      vazio: document.getElementById('yt-vazio').hidden,
    };
  })()`);
  assert.equal(r.vazio, false, 'o estado vazio não apareceu');
  assert.match(r.titulo, /não tem vídeos/);
  assert.doesNotMatch(r.msg, /yt-dlp/i, 'mandou atualizar o yt-dlp por um canal vazio');
});
