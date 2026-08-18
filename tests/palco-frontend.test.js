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

// ⚠ O app roda sob `/<serverId>/proxy/app/<id>/`, e a bancada precisa poder imitar isso: uma URL
// que o backend devolva com barra inicial funciona perfeitamente na raiz e sai do prefixo no
// servidor de verdade. Servir só a raiz era o que deixava esse defeito invisível aqui.
const PREFIXO = '/sub/prefixo';

function servir(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.startsWith(PREFIXO + '/') ? u.pathname.slice(PREFIXO.length) : u.pathname;

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
    aberturasDeYt.push({ url: u.searchParams.get('url'), hl: u.searchParams.get('hl') });
    // ⚠ `null` aqui NÃO serve para simular falha: `JSON.stringify(null)` é `"null"`, que é JSON
    // perfeitamente válido — o `fetch` resolve, o `.json()` resolve, e quem recebe leva um
    // `TypeError` ao ler um campo. Foi assim que a primeira versão deste teste mediu nada.
    if (respostaDeYt === 'FALHAR') { res.writeHead(502); res.end('{}'); return true; }
    res.writeHead(200, { 'content-type': 'application/json' });
    // ⚠ A resposta reflete o `v=` PEDIDO quando ele é conhecido. Devolver sempre o mesmo id fazia
    // a fila parecer travada — o player andava, o servidor de mentira respondia o vídeo anterior,
    // e o teste acusava um defeito que era dele. Um duble que ignora o pedido mede o duble.
    let corpo = respostaDeYt;
    if (corpo && corpo.tipo === 'video' && !respostaDeYtFixa) {
      const pedido = new URL(u.searchParams.get('url') || 'http://x', 'http://x')
        .searchParams.get('v');
      if (pedido) corpo = { ...corpo, id: pedido, titulo: `Vídeo ${pedido}` };
    }
    res.end(JSON.stringify(corpo));
    return true;
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(respostaDeHealthz);
    return true;
  }
  if (p === '/api/marca') {
    // ⚠ O duble responde 400 sem `caminho` **como o backend responde** — é o que faz o defeito
    // aparecer aqui em vez de só no servidor de verdade. Um duble que aceitasse qualquer corpo
    // aprovaria um `caminho: null` calado, que é exatamente o que estava indo.
    if (req.method === 'DELETE') {
      esquecimentos.push(u.searchParams.get('caminho'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return true;
    }
    let bruto = '';
    req.on('data', (c) => { bruto += c; });
    req.on('end', () => {
      let corpo = null;
      try { corpo = JSON.parse(bruto || 'null'); } catch { corpo = null; }
      marcas.push(corpo);
      const ok = corpo && typeof corpo.caminho === 'string' && corpo.caminho;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(ok ? '{"ok":true}' : '{"erro":"sem caminho"}');
    });
    return true;
  }
  if (p === '/api/yt/legenda') {
    legendasPedidas.push({ v: u.searchParams.get('v'), idioma: u.searchParams.get('idioma'),
                           auto: u.searchParams.get('auto') });
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
    res.end('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nolá\n');
    return true;
  }
  if (p === '/api/yt/atualizar') {
    atualizacoes += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respostaDeAtualizar));
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
    if (bytesRecusados) { res.writeHead(502); res.end('{}'); return true; }
    if (!midia) { res.writeHead(503); res.end(); return true; }
    midia.servirBytes(req, res, bytes);
    return true;
  }

  if (p === '/api/yt/listar') {
    const de = Number(u.searchParams.get('de') || 1);
    listagens.push({ url: u.searchParams.get('url'), de, hl: u.searchParams.get('hl') });
    if (respostaDeListar instanceof Error) {
      res.writeHead(respostaDeListar.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erro: respostaDeListar.message }));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    // ⚠ Uma FUNÇÃO quando o teste quer paginar: um objeto fixo devolveria a mesma página para
    // sempre, e a rolagem infinita "funcionaria" mostrando trinta cópias do mesmo resultado. O
    // duble tem de responder ao que foi pedido, senão mede o duble.
    res.end(JSON.stringify(typeof respostaDeListar === 'function'
      ? respostaDeListar(de) : respostaDeListar));
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
// Quando o teste quer um título estável, e não o que o `v=` pedido produziria.
let respostaDeYtFixa = false;
let pedidosDoDash = 0;
let respostaDeListar = null;
let listagens = [];
let aberturasDeYt = [];
let marcas = [];
let esquecimentos = [];
let legendasPedidas = [];
let atualizacoes = 0;
let respostaDeHealthz = 'ok\nversao: 0.1.31\nyt-dlp: 2026.07.04\nidioma: pt\n';
let respostaDeAtualizar = { ok: true, antes: '2025.06.09', versao: '2026.07.04', mudou: true };
let pedidosDeBytes = 0;
// Faz o proxy de bytes recusar, como um servidor que perdeu a credencial do googlevideo.
let bytesRecusados = false;
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
  // ⚠ RELATIVO, como o backend monta. Um `/api/yt/bytes?…` absoluto resolveria certo em qualquer
  // caminho e esconderia o defeito que a bancada existe para pegar: o `<BaseURL>` do DASH é
  // resolvido contra a URL do MANIFESTO, e o MPD é servido em `…/api/yt/mpd`.
  midia = dashDeTeste.montar('bytes?v=aaaaaaaaaaa&f=');
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
/**
 * Espera o SERVIDOR ver uma consulta nova, e não a tela parecer diferente.
 *
 * ⚠ Esperar por DOM aqui é o que deixou um teste instável: depois de rolar, uma segunda busca
 * esconde a grade — e `scrollTop` de um elemento escondido é 0 no mesmo instante, enquanto os
 * cartões da busca ANTERIOR continuam no documento. As duas condições passam a valer antes de a
 * resposta chegar, e o teste lê `listagens[0]` de um array vazio. Um teste instável é pior que um
 * teste ausente: ele ensina a ignorar o vermelho.
 */
async function ateChegarem(quantas, prazo = 8000) {
  const fim = Date.now() + prazo;
  while (Date.now() < fim && listagens.length < quantas) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(listagens.length >= quantas,
    `o servidor viu ${listagens.length} consulta(s), esperava ${quantas}`);
}

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
  assert.match(listagens[0].url, /results\?search_query=gatos/);
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
  respostaDeYtFixa = true;
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
  assert.match(listagens[0].url, /playlist\?list=PLabc123/);
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

// ── A fila ──────────────────────────────────────────────────────────────────
//
// ⚠ **A fila é UMA**, e é o que faz próximo/anterior, `ended`, repetir e os botões da central de
// mídia funcionarem para a pasta e para o YouTube sem nenhum deles saber que existem duas origens.
// Uma segunda lista, só para o YouTube, seria seis lugares para as duas divergirem.

/** Toca um vídeo do YouTube já com uma fila, e espera a imagem. */
async function comFila(itens, atual) {
  // ⚠ Dinâmico de propósito: andar na fila é justamente pedir vídeos DIFERENTES, e um duble que
  // devolvesse sempre o mesmo faria a fila parecer travada quando o travado seria o duble.
  respostaDeYtFixa = false;
  respostaDeListar = { tipo: 'busca', titulo: 'gatos', itens };
  respostaDeYt = {
    tipo: 'video', id: atual, titulo: `Vídeo ${atual}`, canal: 'C',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.tuff-miniatura')"));
  const posicao = itens.findIndex((i) => i.id === atual);
  await p.avaliar(`(async () => {
    document.querySelectorAll('.tuff-miniatura')[${posicao}]
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const v = document.getElementById('video');
    const prazo = Date.now() + 15000;
    while (Date.now() < prazo && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 100));
  })()`);
  return p;
}

test('abrir um resultado faz a LISTA virar a fila', seNaoTemMidia, async () => {
  // ⚠ Sem isto, apertar "próximo" depois de abrir o quarto resultado de uma busca daria o próximo
  // arquivo da última pasta local aberta — que é uma resposta absurda e perfeitamente silenciosa.
  const p = await comFila(LISTAGEM.itens, LISTAGEM.itens[3].id);
  const r = await p.avaliar(`(() => {
    const linhas = [...document.querySelectorAll('.linha-arq')];
    return {
      naFila: linhas.length,
      tocando: linhas.findIndex((l) => l.classList.contains('linha-arq--tocando')),
      anterior: !document.getElementById('btn-anterior').disabled,
      proximo: !document.getElementById('btn-proximo').disabled,
    };
  })()`);
  assert.equal(r.naFila, LISTAGEM.itens.length, 'a fila não assumiu a Biblioteca');
  assert.equal(r.tocando, 3, 'o vídeo em reprodução não foi localizado dentro da fila');
});

test('a fila SOBREVIVE a um passo — o próximo do próximo existe', seNaoTemMidia, async () => {
  // ⚠ **O defeito que este teste existe para impedir tinha exatamente um passo de vida.**
  // `abrirYoutube` limpa `vizinhos` na entrada, o que é certo: senão a lista do vídeo anterior
  // sobreviveria e o "próximo" apontaria para outra coisa. Mas ao ANDAR na fila é a mesma lista, e
  // sem repassá-la o segundo item viraria o último — "próximo" funcionaria uma vez e depois não
  // faria nada, sem erro nenhum.
  const p = await comFila(LISTAGEM.itens, LISTAGEM.itens[0].id);
  const passo = `(async () => {
    document.getElementById('btn-proximo').click();
    const prazo = Date.now() + 15000;
    while (Date.now() < prazo && document.getElementById('preparando').hidden === false) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    const linhas = [...document.querySelectorAll('.linha-arq')];
    return {
      naFila: linhas.length,
      tocando: linhas.findIndex((l) => l.classList.contains('linha-arq--tocando')),
    };
  })()`;

  const um = await p.avaliar(passo);
  assert.equal(um.naFila, LISTAGEM.itens.length, 'a fila sumiu depois do primeiro passo');
  assert.equal(um.tocando, 1, `o primeiro "próximo" não andou: ${JSON.stringify(um)}`);

  const dois = await p.avaliar(passo);
  assert.equal(dois.naFila, LISTAGEM.itens.length,
    'a fila sumiu no segundo passo — ela viveu exatamente um');
  assert.equal(dois.tocando, 2, `o segundo "próximo" não andou: ${JSON.stringify(dois)}`);
});

test('um link com &list= vira fila, e o vídeo pedido é o que toca', seNaoTemMidia, async () => {
  // A forma mais comum de link de playlist que circula: quem compartilha "o vídeo 4 da lista"
  // manda exatamente `watch?v=…&list=…`.
  respostaDeListar = { tipo: 'playlist', titulo: 'Minha lista', itens: LISTAGEM.itens };
  respostaDeYtFixa = true;
  respostaDeYt = {
    tipo: 'video', id: LISTAGEM.itens[2].id, titulo: 'O terceiro', canal: 'C',
    lista: 'PLabc123',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaa2&list=PLabc123' });
    const v = document.getElementById('video');
    let prazo = Date.now() + 15000;
    while (Date.now() < prazo && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 100));
    prazo = Date.now() + 8000;
    while (Date.now() < prazo && !document.querySelector('.linha-arq')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const linhas = [...document.querySelectorAll('.linha-arq')];
    return {
      tempo: v.currentTime,
      nome: document.getElementById('agora-nome').textContent,
      naFila: linhas.length,
      tocando: linhas.findIndex((l) => l.classList.contains('linha-arq--tocando')),
      pasta: document.getElementById('bib-pasta').textContent,
      naAba: !!document.querySelector('#painel-reproduzindo.painel--ativo'),
    };
  })()`);

  assert.ok(r.tempo >= 0.5, `o vídeo do link não tocou: ${JSON.stringify(r)}`);
  assert.equal(r.nome, 'O terceiro', 'tocou outro vídeo que não o pedido no link');
  assert.equal(r.naFila, LISTAGEM.itens.length, 'o `&list=` não virou fila');
  assert.equal(r.tocando, 2, 'o vídeo do link não foi localizado dentro da fila');
  assert.equal(r.pasta, 'Minha lista');
  assert.equal(r.naAba, true);
});

test('um vídeo SEM lista não herda a fila do anterior', seNaoTemMidia, async () => {
  // ⚠ O outro lado da mesma moeda, e o mais fácil de errar ao consertar o primeiro: se `vizinhos`
  // não fosse limpo na entrada, abrir um vídeo solto depois de uma playlist deixaria o "próximo"
  // apontando para o item seguinte de uma lista que não tem nada a ver com o que está tocando.
  const p = await comFila(LISTAGEM.itens, LISTAGEM.itens[0].id);
  respostaDeYt = {
    tipo: 'video', id: 'zzzzzzzzzzz', titulo: 'Solto', canal: 'C',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  const r = await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://youtu.be/zzzzzzzzzzz' });
    const v = document.getElementById('video');
    const prazo = Date.now() + 15000;
    while (Date.now() < prazo && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    return {
      nome: document.getElementById('agora-nome').textContent,
      naFila: document.querySelectorAll('.linha-arq').length,
    };
  })()`);
  assert.equal(r.nome, 'Solto');
  assert.equal(r.naFila, 0, 'o vídeo solto herdou a fila da busca anterior');
});

test('a faixa de "Consultando" fica DENTRO do painel, e não no canto da janela', seNaoTem,
  async () => {
    // ⚠ **Defeito visto em uso, e ele nasceu de reaproveitar uma classe.** `.yt-carregando` usava
    // `.preparando`, que é `position:absolute; left:50%; top:50%` com
    // `transform: translate(-50%,-50%)` — uma pílula flutuando sobre o vídeo. Forçar
    // `position: static` por cima não basta: `left`/`top` deixam de valer, mas o `transform`
    // CONTINUA, e joga a caixa meia largura para a esquerda e meia altura para cima da própria
    // área. Na tela, a mensagem aparecia no canto, cortada.
    //
    // ⚠ E é por isso que a asserção é de GEOMETRIA, e não "o elemento está visível": ele estava
    // visível o tempo todo. Só não estava onde deveria.
    respostaDeListar = LISTAGEM;
    const p = await comAbaAberta();
    const r = await p.avaliar(`(() => {
      const painel = document.getElementById('painel-youtube').getBoundingClientRect();
      const c = document.getElementById('yt-carregando');
      c.hidden = false;
      const cx = c.getBoundingClientRect();
      return {
        painel: { l: painel.left, t: painel.top, r: painel.right, b: painel.bottom },
        caixa: { l: cx.left, t: cx.top, r: cx.right, b: cx.bottom, w: cx.width, h: cx.height },
      };
    })()`);

    assert.ok(r.caixa.w > 60 && r.caixa.h > 10, `a faixa não tem tamanho: ${JSON.stringify(r.caixa)}`);
    assert.ok(r.caixa.l >= r.painel.l - 1 && r.caixa.r <= r.painel.r + 1,
      `a faixa saiu do painel na horizontal: ${JSON.stringify(r)}`);
    assert.ok(r.caixa.t >= r.painel.t - 1 && r.caixa.b <= r.painel.b + 1,
      `a faixa saiu do painel na vertical: ${JSON.stringify(r)}`);
  });

test('a URL do MPD que o app pede fica DENTRO do prefixo do app', seNaoTem, async () => {
  // ⚠ **O defeito que derrubou a primeira reprodução de verdade.** O app é servido sob
  // `/<serverId>/proxy/app/<id>/`, e o backend devolvia `"/api/yt/mpd?v=…"` com barra inicial — que
  // sai do prefixo e bate num 404 do PORTAL. No console: `GET https://host/api/yt/mpd?v=… 404`,
  // sem o caminho do app no meio.
  //
  // O lado Python prende o valor que o backend PRODUZ; este prende o que o navegador PEDE, que é
  // a metade que faltava: a bancada usava um duble escrito à mão com o valor certo, então ela
  // media um contrato que o backend não cumpria.
  respostaDeYtFixa = true;
  respostaDeYt = {
    tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'C',
    duracao: 6, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  const p = await nav.novaPagina(origem.url + 'sub/prefixo/');
  const r = await p.avaliar(`(async () => {
    const pedidas = [];
    const orig = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (m, u, ...resto) {
      pedidas.push(String(u));
      return orig.call(this, m, u, ...resto);
    };
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://youtu.be/aaaaaaaaaaa' });
    await new Promise((r) => setTimeout(r, 2500));
    return pedidas.filter((u) => u.includes('yt/mpd'));
  })()`);

  assert.ok(r.length > 0, 'o dash.js não chegou a pedir o manifesto');
  for (const u of r) {
    const caminho = new URL(u, origem.url + 'sub/prefixo/').pathname;
    assert.ok(caminho.startsWith('/sub/prefixo/'),
      `o MPD foi pedido em ${caminho} — fora do prefixo do app`);
  }
});

// ── A rolagem infinita ──────────────────────────────────────────────────────
//
// ⚠ **A busca REPETE itens entre páginas** — medido com o yt-dlp de verdade: pedindo 1–20 e 21–40
// da mesma busca, DOIS ids aparecem nas duas. O ranking do YouTube não é determinístico entre
// chamadas. Numa playlist a sobreposição é zero.
//
// Por isso o duble abaixo repete de propósito: um servidor de mentira que devolvesse páginas
// perfeitamente disjuntas aprovaria um cliente sem deduplicação, e o defeito só apareceria na tela
// de quem rolasse uma busca de verdade.

const POR_PAGINA_TESTE = 30;

/** Uma listagem paginada, com `repetidos` itens da página anterior no começo de cada página. */
function paginada({ total = 90, repetidos = 2 } = {}) {
  return (de) => {
    const inicio = Math.max(1, de - (de > 1 ? repetidos : 0));
    const itens = [];
    for (let n = inicio; n < de + POR_PAGINA_TESTE && n <= total; n += 1) {
      itens.push({
        id: `vid${String(n).padStart(8, '0')}`,
        titulo: `Resultado ${n}`,
        duracao: 60,
        canal: 'Canal',
        miniatura: `api/yt/miniatura?v=vid${String(n).padStart(8, '0')}`,
      });
    }
    return { tipo: 'busca', titulo: 'gatos', de, itens, temMais: de + POR_PAGINA_TESTE <= total };
  };
}

/** Rola a grade até o fim e espera a contagem de cartões parar de crescer. */
const ROLAR_ATE_O_FIM = `(async () => {
  const g = document.getElementById('yt-grade');
  let antes = -1;
  for (let volta = 0; volta < 40; volta += 1) {
    g.scrollTop = g.scrollHeight;
    await new Promise((r) => setTimeout(r, 250));
    const agora = document.querySelectorAll('.yt-nome').length;
    const fim = g.scrollHeight - g.scrollTop - g.clientHeight;
    if (agora === antes && fim < 4) break;
    antes = agora;
  }
})()`;

test('rolar até o fim traz a página seguinte', seNaoTem, async () => {
  respostaDeListar = paginada({ total: 90 });
  listagens = [];
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));

  const antes = await p.avaliar("document.querySelectorAll('.yt-nome').length");
  await p.avaliar(ROLAR_ATE_O_FIM);
  const r = await p.avaliar(`(() => {
    const nomes = [...document.querySelectorAll('.yt-nome')].map((e) => e.textContent);
    return { desenhados: nomes.length, ultimo: nomes[nomes.length - 1] };
  })()`);

  // A grade é VIRTUALIZADA: ela nunca desenha tudo. O sinal de que a página seguinte chegou não é
  // "há 90 cartões no DOM" — é que a rolagem passou do fim da primeira página.
  assert.ok(listagens.length >= 2,
    `só ${listagens.length} consulta(s): a página seguinte nunca foi pedida`);
  assert.equal(listagens[0].de, 1);
  assert.equal(listagens[1].de, 1 + POR_PAGINA_TESTE,
    `a segunda página foi pedida em ${listagens[1].de}`);
  assert.ok(r.desenhados > 0, 'a grade ficou vazia depois de rolar');
  assert.match(r.ultimo, /Resultado (3[1-9]|[4-9]\d)/,
    `o fim da grade ainda é da primeira página: ${r.ultimo}`);
  assert.ok(antes > 0);
});

test('os itens REPETIDOS entre páginas não viram cartões duplicados', seNaoTem, async () => {
  // ⚠ É o teste que a medição contra o YouTube real tornou obrigatório. Sem deduplicar por id, os
  // dois itens que reaparecem em cada página viram cartões repetidos na grade — e quanto mais a
  // pessoa rola, mais eles se acumulam.
  respostaDeListar = paginada({ total: 90, repetidos: 5 });
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));
  await p.avaliar(ROLAR_ATE_O_FIM);

  const nomes = await p.avaliar(`(() => {
    const g = document.getElementById('yt-grade');
    // Passa por toda a grade recolhendo os nomes: ela é virtualizada, então só o que está na
    // janela existe no DOM a cada instante.
    const vistos = [];
    return new Promise((ok) => {
      let y = 0;
      const passo = () => {
        g.scrollTop = y;
        setTimeout(() => {
          for (const e of document.querySelectorAll('.yt-nome')) vistos.push(e.textContent);
          y += g.clientHeight;
          if (y > g.scrollHeight) ok(vistos); else passo();
        }, 60);
      };
      passo();
    });
  })()`);

  const unicos = new Set(nomes);
  assert.ok(unicos.size > POR_PAGINA_TESTE,
    `a grade não passou da primeira página: ${unicos.size} itens distintos`);
  // Cada nome aparece uma vez POR POSIÇÃO na grade; o que não pode é o mesmo nome ocupar duas
  // posições ao mesmo tempo. Recolhemos por janelas sobrepostas, então a checagem é sobre a lista
  // ordenada de posições, não sobre a contagem bruta.
  // ⚠ Só as células VISÍVEIS. A grade recicla nós: os que sobram ficam com `display:none` e
  // guardam o conteúdo da posição anterior. Um `querySelectorAll('.yt-nome')` cru os inclui, e a
  // primeira versão deste teste acusou "repetidos" que ninguém vê na tela.
  const posicoes = await p.avaliar(`[...document.querySelectorAll('.tuff-miniatura')]
    .filter((n) => n.style.display !== 'none')
    .map((n) => (n.querySelector('.yt-nome') || {}).textContent)
    .filter(Boolean)`);
  assert.equal(new Set(posicoes).size, posicoes.length,
    `a mesma janela da grade mostra nomes repetidos: ${posicoes.join(' | ')}`);
});

test('a rolagem PARA quando a lista acaba, em vez de pedir para sempre', seNaoTem, async () => {
  // ⚠ Duas condições no cliente, e a segunda é a que morde aqui: uma página inteira de repetidos
  // significa que a lista acabou, por mais que o servidor diga "tem mais". Sem ela, cada rolagem
  // dispararia outra consulta — para sempre, contra o YouTube, sem nada aparecer na tela.
  respostaDeListar = (de) => ({
    tipo: 'busca',
    titulo: 'gatos',
    de,
    // Sempre os MESMOS trinta, e sempre dizendo que há mais. É o servidor mentindo.
    itens: Array.from({ length: 30 }, (_, i) => ({
      id: `vid${String(i).padStart(8, '0')}`,
      titulo: `Resultado ${i}`,
      duracao: 60,
      canal: 'Canal',
      miniatura: `api/yt/miniatura?v=vid${String(i).padStart(8, '0')}`,
    })),
    temMais: true,
  });
  listagens = [];
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));

  // ⚠ Rolagens FORÇADAS, e não `ROLAR_ATE_O_FIM`. Aquele laço para quando a contagem de cartões
  // estabiliza — o que acontece na segunda volta justamente porque a lista não cresce, e assim ele
  // nunca chegava a pedir muitas páginas. O teste passava sem a guarda: media a saída do laço, e
  // não a teimosia do cliente. Achado refutando.
  await p.avaliar(`(async () => {
    const g = document.getElementById('yt-grade');
    for (let volta = 0; volta < 10; volta += 1) {
      g.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 30));
      g.scrollTop = g.scrollHeight;
      await new Promise((r) => setTimeout(r, 160));
    }
  })()`);

  assert.ok(listagens.length <= 3,
    `pediu ${listagens.length} páginas de uma lista que não cresce — a rolagem não sabe parar`);
});

test('trocar de busca ZERA a grade e a paginação', seNaoTem, async () => {
  // ⚠ Sem zerar `vistos`, buscar "gatos", rolar, e depois buscar "cachorros" traria uma grade
  // vazia: todo id novo seria comparado com o conjunto da busca anterior, e por azar de colisão —
  // ou por um vídeo que aparece nas duas — sumiria sem explicação.
  respostaDeListar = paginada({ total: 90 });
  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', "document.querySelector('.yt-cartao')"));
  await p.avaliar(ROLAR_ATE_O_FIM);

  // A segunda busca devolve EXATAMENTE os mesmos ids da primeira — o pior caso para um `Set` que
  // não fosse zerado, e um caso real: duas buscas parecidas trazem vídeos em comum.
  listagens = [];
  // ⚠ A espera é sobre o que o SERVIDOR viu — ver `ateChegarem`. A tela mente aqui: a grade
  // escondida durante o carregamento já reporta `scrollTop === 0`, e os cartões da busca anterior
  // ainda estão no documento, então qualquer condição de DOM passa antes da resposta chegar.
  await p.avaliar(BUSCAR('gatos de novo', 'false'));
  await ateChegarem(1);
  await p.avaliar(`(async () => {
    const prazo = Date.now() + 5000;
    while (Date.now() < prazo && !document.querySelector('.yt-cartao')) {
      await new Promise((r) => setTimeout(r, 50));
    }
  })()`);
  const r = await p.avaliar(`(() => ({
    desenhados: document.querySelectorAll('.yt-nome').length,
    topo: document.getElementById('yt-grade').scrollTop,
  }))()`);

  assert.ok(r.desenhados > 0, 'a busca nova veio vazia — o conjunto de vistos não foi zerado');
  assert.equal(r.topo, 0, 'a busca nova começou no meio da rolagem anterior');
  assert.equal(listagens[0].de, 1, 'a busca nova continuou de onde a anterior parou');
});

test('uma falha de segmento é RETOMADA uma vez, e não mata a reprodução', seNaoTemMidia,
  async () => {
    // ⚠ **O defeito medido em uso:** o vídeo ficou parado um tempo e, ao voltar, a pessoa recebeu
    // "A reprodução deste vídeo do YouTube falhou". A causa provável é a credencial do googlevideo
    // — ela vale 6 h e o YouTube gira chaves antes disso — e o servidor já resolve isso sozinho.
    // O que faltava era o cliente: o manifesto aponta para NÓS, então refazê-lo do mesmo ponto é
    // barato e pega exatamente esse caso.
    //
    // Aqui a falha é produzida do jeito que ela acontece: os bytes param de responder por um
    // tempo, e voltam. Uma tentativa é o bastante.
    respostaDeListar = LISTAGEM;
    respostaDeYtFixa = true;
    respostaDeYt = {
      tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'C',
      duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
    };
    bytesRecusados = true;                 // o proxy recusando, como um 502 do servidor
    const p = await comUrlAberta('https://youtu.be/aaaaaaaaaaa', respostaDeYt);

    // Espera o aviso OU a recuperação — o que vier primeiro.
    await p.avaliar(`(async () => {
      const prazo = Date.now() + 8000;
      while (Date.now() < prazo && document.getElementById('aviso').hidden) {
        await new Promise((r) => setTimeout(r, 120));
      }
    })()`);

    // Agora o servidor volta a responder, e a retomada tem de pegar.
    bytesRecusados = false;
    const r = await p.avaliar(`(async () => {
      const v = document.getElementById('video');
      const prazo = Date.now() + 20000;
      while (Date.now() < prazo && v.currentTime < 0.5) await new Promise((r) => setTimeout(r, 150));
      return { tempo: v.currentTime, altura: v.videoHeight };
    })()`);

    assert.ok(r.tempo >= 0.5,
      `a reprodução não se recuperou depois de os bytes voltarem: ${JSON.stringify(r)}`);
    assert.ok(r.altura > 0, 'nada foi desenhado depois da retomada');
  });

test('um erro que PERSISTE acaba dizendo que falhou', seNaoTemMidia, async () => {
  // ⚠ A outra metade, e sem ela o conserto acima vira um vídeo que nunca admite não ir tocar.
  // Uma tentativa, e só.
  respostaDeYtFixa = true;
  respostaDeYt = {
    tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'C',
    duracao: dashDeTeste.DURACAO, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', legendas: [], qualidades: [90],
  };
  bytesRecusados = true;
  const p = await comUrlAberta('https://youtu.be/aaaaaaaaaaa', respostaDeYt);
  const r = await p.avaliar(`(async () => {
    const prazo = Date.now() + 20000;
    while (Date.now() < prazo && document.getElementById('aviso').hidden) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      aviso: document.getElementById('aviso').hidden,
      texto: document.getElementById('aviso-t').textContent,
      preparando: document.getElementById('preparando').hidden,
    };
  })()`);
  bytesRecusados = false;
  assert.equal(r.aviso, false, 'o erro persistente nunca foi dito na tela');
  assert.match(r.texto, /falhou/i);
  assert.equal(r.preparando, true, '"Retomando" ficou preso para sempre');
});

// ─────────────────────────────────────────────────────────────────────────────
// A sessão de uso de 18/08, segunda leva: o que a primeira reprodução completa
// mostrou depois que o vídeo passou a tocar.
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO_COM_LEGENDA = {
  tipo: 'video', id: 'aaaaaaaaaaa', titulo: 'Um vídeo', canal: 'Um canal',
  duracao: 6, mpd: 'api/yt/mpd?v=aaaaaaaaaaa', qualidades: [90],
  legendas: [
    { idioma: 'pt', nome: 'Português', automatica: false },
    { idioma: 'pt', nome: 'Português', automatica: true },
  ],
};

/** Abre um vídeo do YouTube de verdade (dash.js + mídia) e espera ele tocar. */
async function comYoutubeTocando(resposta = VIDEO_COM_LEGENDA) {
  respostaDeYtFixa = true;
  respostaDeYt = resposta;
  const p = await nav.novaPagina(origem.url);
  await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://youtu.be/aaaaaaaaaaa' });
    const prazo = Date.now() + 12000;
    const v = document.getElementById('video');
    while (Date.now() < prazo && !(v.readyState >= 2 && v.duration > 0)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  })()`);
  return p;
}

test('a marca de um vídeo do YouTube tem CHAVE, e o servidor não responde 400',
  seNaoTemMidia, async () => {
    // ⚠ **O defeito veio de um console colado por quem usava o app:**
    //
    //     POST …/api/palco/api/marca 400 (Bad Request)
    //
    // a cada quinze segundos, durante toda a reprodução. `atual.caminho` é `null` no DASH — não
    // existe arquivo — e o `null` ia no corpo assim mesmo. Na tela, nada: o único sinal era a
    // linha vermelha de quem tivesse as ferramentas do navegador abertas. E junto com o ruído ia
    // um recurso inteiro: um vídeo longo do YouTube nunca lembrava onde a pessoa parou.
    marcas = [];
    const p = await comYoutubeTocando();
    await p.avaliar(`(async () => {
      const v = document.getElementById('video');
      v.currentTime = 3;
      v.pause();                                  // 'pause' e' um dos gatilhos de marcar()
      await new Promise((r) => setTimeout(r, 600));
    })()`);

    assert.ok(marcas.length > 0, 'nenhuma marca foi enviada — o vídeo do YouTube não é lembrado');
    for (const m of marcas) {
      assert.ok(m && typeof m.caminho === 'string' && m.caminho,
        `a marca foi enviada sem chave: ${JSON.stringify(m)} — é o 400 do relato`);
      assert.match(m.caminho, /^yt:aaaaaaaaaaa$/,
        `a chave não identifica o vídeo: ${m.caminho}`);
    }
  });

test('"Esquecer onde parei" usa a MESMA chave que gravou', seNaoTemMidia, async () => {
  // Duas formas de nomear a mesma coisa dariam um "esquecer" que apaga uma entrada que ninguém
  // gravou — e deixa a de verdade no lugar, com a pessoa vendo o botão não funcionar.
  esquecimentos = [];
  marcas = [];
  const p = await comYoutubeTocando();
  await p.avaliar(`(async () => {
    const v = document.getElementById('video');
    v.currentTime = 3; v.pause();
    await new Promise((r) => setTimeout(r, 400));
    window.__escolha = 'esquecer';
    document.querySelector('.menubar [data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  assert.ok(esquecimentos.length > 0, 'o "esquecer" não chegou ao servidor');
  assert.equal(esquecimentos[0], marcas[0].caminho,
    'a chave de esquecer é diferente da que gravou');
});

test('o console NÃO acusa `Invalid URL` durante a reprodução', seNaoTemMidia, async () => {
  // ⚠ **A linha que veio no relato**, uma por resposta de segmento:
  //
  //     [CmcdController] Failed to record response received in CMCD reporter.
  //     TypeError: Failed to construct 'URL': Invalid URL
  //
  // O dash.js propaga a forma da URL do MANIFESTO para os segmentos: recebendo um endereço
  // relativo, tudo fica relativo, e o CmcdController faz `new URL(<relativa>)` sem base. Ele
  // engole a exceção, então nada quebra — e é justamente esse o custo: dezenas de linhas
  // vermelhas por minuto enterrando qualquer erro de verdade que apareça no meio.
  const p = await comYoutubeTocando();
  await p.avaliar('new Promise((r) => setTimeout(r, 1500))');
  const ruins = p.console.filter((m) => /Invalid URL/i.test(m.texto));
  assert.deepEqual(ruins.map((m) => m.texto.slice(0, 120)), [],
    `${ruins.length} linha(s) de URL inválida no console`);
});

test('o manifesto chega ao dash.js ABSOLUTO', seNaoTem, async () => {
  // A causa do teste acima, medida diretamente: o dash.js pede o MPD exatamente como recebeu.
  // Um endereço relativo aqui resolve certo no navegador — por isso o defeito não impede a
  // reprodução — e contamina toda a árvore de URLs que ele deriva.
  respostaDeYtFixa = true;
  respostaDeYt = { ...VIDEO_COM_LEGENDA, legendas: [] };
  const p = await nav.novaPagina(origem.url + 'sub/prefixo/');
  const r = await p.avaliar(`(async () => {
    const pedidas = [];
    const orig = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (m, u, ...resto) {
      pedidas.push(String(u));
      return orig.call(this, m, u, ...resto);
    };
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://youtu.be/aaaaaaaaaaa' });
    await new Promise((r) => setTimeout(r, 2500));
    return pedidas.filter((u) => u.includes('yt/mpd'));
  })()`);

  assert.ok(r.length > 0, 'o dash.js não chegou a pedir o manifesto');
  for (const u of r) {
    assert.match(u, /^https?:\/\//,
      `o dash.js recebeu o manifesto relativo (${u}) — é daí que sai o "Invalid URL"`);
    assert.ok(new URL(u).pathname.startsWith('/sub/prefixo/'),
      `o MPD foi pedido fora do prefixo do app: ${u}`);
  }
});

// ── As legendas do YouTube ──────────────────────────────────────────────────

test('as legendas do YouTube viram `<track>` NOSSO, e nunca do YouTube', seNaoTemMidia,
  async () => {
    // ⚠ `<track>` é sujeito à mesma origem e o host das legendas do YouTube não responde CORS —
    // apontar para lá daria uma legenda que aparece no menu e nunca carrega.
    const p = await comYoutubeTocando();
    const r = await p.avaliar(`(() => [...document.querySelectorAll('#video track')]
      .map((t) => ({ label: t.label, src: t.getAttribute('src'), lang: t.srclang })))()`);

    assert.equal(r.length, 2, `${r.length} faixa(s) de legenda desenhadas`);
    for (const t of r) {
      assert.ok(!/youtube|googlevideo/.test(t.src), `a legenda aponta para fora: ${t.src}`);
      assert.ok(t.src.startsWith('api/yt/legenda?'),
        `a legenda não vem da nossa rota: ${t.src}`);
      assert.ok(!t.src.startsWith('/'),
        `barra inicial em ${t.src} — sai do prefixo do app e bate num 404 do portal`);
      assert.equal(t.lang, 'pt');
    }
    // A automática vem MARCADA. Sem isso a escolha seria entre "Português" e "Português", no
    // escuro — e as duas são qualidades de texto muito diferentes.
    assert.deepEqual(r.map((t) => t.label), ['Português', 'Português (automática)']);
    assert.ok(r[1].src.includes('auto=1'), 'a automática não se distingue no pedido');
  });

test('a legenda do YouTube aparece no menu Legenda e o servidor a serve', seNaoTemMidia,
  async () => {
    legendasPedidas = [];
    const p = await comYoutubeTocando();
    const itens = await p.avaliar(`(async () => {
      window.__escolha = null;
      document.querySelector('.menubar [data-menu="legenda"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
      return c.itens.map((i) => i.label).filter(Boolean);
    })()`);
    assert.deepEqual(itens, ['Sem legenda', 'Português', 'Português (automática)']);

    // E ligar uma pede o VTT ao nosso servidor — o passo que separa "está no menu" de "aparece
    // na tela", e o único que exercita a rota inteira.
    await p.avaliar(`(async () => {
      document.getElementById('video').textTracks[0].mode = 'showing';
      await new Promise((r) => setTimeout(r, 800));
    })()`);
    assert.deepEqual(legendasPedidas, [{ v: 'aaaaaaaaaaa', idioma: 'pt', auto: null }]);
  });

// ── O idioma de quem assiste ────────────────────────────────────────────────

test('o idioma do navegador viaja nas DUAS rotas do YouTube', seNaoTem, async () => {
  // ⚠ Sem ele o yt-dlp fixa `hl: "en"` e o YouTube devolve o título TRADUZIDO — medido: os mesmos
  // vídeos brasileiros voltam como "I MADE IT IN 4 MINUTES!! THE SIMPLEEST AND CHEAPEST CAKE".
  // Quem busca em português recebe uma grade em inglês macarrônico.
  //
  // ⚠ E as DUAS rotas, e não só a de abrir: a busca é onde isso aparece primeiro, porque é uma
  // grade inteira de títulos traduzidos de uma vez.
  listagens = [];
  aberturasDeYt = [];
  respostaDeListar = paginada({ total: 30 });
  respostaDeYtFixa = true;
  respostaDeYt = { ...VIDEO_COM_LEGENDA, legendas: [] };

  const p = await comAbaAberta();
  await p.avaliar(BUSCAR('gatos', 'false'));
  await ateChegarem(1);
  await p.avaliar(`(async () => {
    window.__abrirContexto({ type: 'open-context', tipo: 'url',
      url: 'https://youtu.be/aaaaaaaaaaa' });
    await new Promise((r) => setTimeout(r, 600));
  })()`);

  const esperado = await p.avaliar('navigator.language');
  assert.ok(esperado, 'o navegador desta bancada não declara idioma');
  assert.equal(listagens[0].hl, esperado, 'a busca foi ao YouTube sem idioma');
  assert.ok(aberturasDeYt.length > 0, 'nenhuma abertura registrada');
  assert.equal(aberturasDeYt[aberturasDeYt.length - 1].hl, esperado,
    'abrir um vídeo foi ao YouTube sem idioma');
});

// ── O botão que faz o app durar ─────────────────────────────────────────────

test('Ferramentas oferece atualizar o yt-dlp, e a frase diz a VERSÃO', seNaoTem, async () => {
  // ⚠ É o que impede o Palco de funcionar por um mês e depois parar: o YouTube quebra extractor
  // toda semana e o `pip install` da instalação congela a versão. Sem esta saída, a única resposta
  // para "parou de abrir vídeo" seria entrar no servidor como root.
  atualizacoes = 0;
  respostaDeAtualizar = { ok: true, antes: '2025.06.09', versao: '2026.07.04', mudou: true };
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__escolha = 'yt-atualizar';
    document.querySelector('.menubar [data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 800));
    const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
    return { itens: c.itens.map((i) => i.label).filter(Boolean),
             aviso: document.getElementById('aviso-t').textContent };
  })()`);

  assert.ok(r.itens.includes('Atualizar o yt-dlp'), `o item não está no menu: ${r.itens}`);
  assert.equal(atualizacoes, 1, 'o clique não chegou ao servidor');
  // A frase diz a versão, e não "pronto": quando o extractor já estava atualizado o conserto é
  // outro, e um "pronto" mandaria a pessoa procurar o defeito no lugar errado.
  assert.match(r.aviso, /2026\.07\.04/, `a frase não diz a versão: ${r.aviso}`);
});

test('atualizar sem novidade DIZ que já estava na versão mais nova', seNaoTem, async () => {
  respostaDeAtualizar = { ok: true, antes: '2026.07.04', versao: '2026.07.04', mudou: false };
  const p = await nav.novaPagina(origem.url);
  const aviso = await p.avaliar(`(async () => {
    window.__escolha = 'yt-atualizar';
    document.querySelector('.menubar [data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 800));
    return document.getElementById('aviso-t').textContent;
  })()`);
  assert.match(aviso, /já estava/, `a frase mente sobre ter atualizado: ${aviso}`);
});

test('"Mostrar no gerenciador" fica DESABILITADO num vídeo do YouTube', seNaoTemMidia,
  async () => {
    // ⚠ Habilitado, ele levava um `TypeError` sobre `null.replace` — o menu fechava, nada
    // acontecia, e não havia nada na tela dizendo por quê. Não existe pasta de um vídeo do
    // YouTube, e desabilitar é a resposta honesta.
    const p = await comYoutubeTocando();
    const r = await p.avaliar(`(async () => {
      window.__escolha = null;
      document.querySelector('.menubar [data-menu="ferramentas"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
      return c.itens.filter((i) => i.id).map((i) => [i.id, !!i.disabled]);
    })()`);
    const mapa = Object.fromEntries(r);
    assert.equal(mapa.mostrar, true, 'o item está habilitado sobre um vídeo sem arquivo');
    assert.equal(mapa['yt-atualizar'], false, 'atualizar o yt-dlp não depende do que está tocando');
  });

test('"Sobre o Palco" DIZ a versão instalada', seNaoTem, async () => {
  // ⚠ **O portão que teria encurtado uma sessão inteira de investigação.** Veio um relato de que
  // a miniatura não aparecia e a lista mostrava só a primeira página — a descrição exata do
  // comportamento de uma versão ANTERIOR ao conserto de tudo isso. Não havia como distinguir
  // "instalou o velho" de "o conserto não pegou" sem entrar no servidor, e as duas conclusões
  // levam a trabalhos opostos.
  //
  // É a mesma fronteira da tag `v4`: o que roda no servidor é outro arquivo do que está no disco
  // de quem escreve, e ninguém percorre as duas pontas.
  respostaDeHealthz = 'ok\nversao: 0.1.31\nyt-dlp: 2026.07.04\nidioma: pt\n';
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    window.__escolha = 'sobre';
    document.querySelector('.menubar [data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const a = window.__chamadas.filter((x) => x.op === 'alert').pop();
    const c = window.__chamadas.filter((x) => x.op === 'contextMenu').pop();
    return { texto: a ? a.m : null, itens: c.itens.map((i) => i.label).filter(Boolean) };
  })()`);

  assert.ok(r.itens.includes('Sobre o Palco'), `o item não está no menu: ${r.itens}`);
  assert.ok(r.texto, 'o diálogo não abriu');
  // As três respostas que a investigação precisou e não tinha.
  assert.match(r.texto, /0\.1\.31/, `não diz a versão do app: ${r.texto}`);
  assert.match(r.texto, /2026\.07\.04/, `não diz a versão do yt-dlp: ${r.texto}`);
  assert.match(r.texto, /pt/, `não diz o idioma negociado: ${r.texto}`);
  // O `ok` é para o supervisor, e não diz nada a quem abriu o diálogo.
  assert.ok(!/^ok$/m.test(r.texto), `o "ok" do healthz vazou para a tela: ${r.texto}`);
});

test('"Sobre o Palco" não fica em branco quando o backend não responde', seNaoTem, async () => {
  // Um diálogo vazio seria pior que a ausência do item: ele afirma que não há nada a dizer.
  const p = await nav.novaPagina(origem.url);
  const texto = await p.avaliar(`(async () => {
    window.fetch = () => Promise.reject(new Error('sem rede'));
    window.__escolha = 'sobre';
    document.querySelector('.menubar [data-menu="ferramentas"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const a = window.__chamadas.filter((x) => x.op === 'alert').pop();
    return a ? a.m : null;
  })()`);
  assert.match(texto || '', /servidor/, `a frase de recuo sumiu: ${texto}`);
});
