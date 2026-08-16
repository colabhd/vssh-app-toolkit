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
    contextMenu: (x, y, itens) => anota({ op: 'contextMenu', x, y, itens }, Promise.resolve(null)),
    window: { close: () => anota({ op: 'close' }) },
    dialog: { alert: (m, t) => anota({ op: 'alert', m, t }, Promise.resolve()) },
    openFolder: (p) => anota({ op: 'openFolder', p }),
    pickFile: () => anota({ op: 'pickFile' }, Promise.resolve(null)),
    lembrarRota: (r) => anota({ op: 'lembrarRota', r }),
    onOpenContext: (fn) => { window.__abrirContexto = fn; },
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
      '<script src="/palco.js"></script>',
    ].join('\n');
    html = html.replace('</head>', `${tags}\n</head>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (p === '/api/abrir') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ABERTURA));
    return true;
  }
  if (p === '/api/vizinhos') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(VIZINHOS));
    return true;
  }
  // O cano e a legenda: o teste não toca mídia, e um 204 evita que o `<video>` fique tentando.
  if (p.startsWith('/api/')) { res.writeHead(204); res.end(); return true; }

  const doApp = /^\/(palco\.(?:js|css))$/.exec(p);
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
