'use strict';

// A biblioteca de UI num Chrome de verdade.
//
// ─── Por que isto não pode ser teste de texto ────────────────────────────────
//
// *"Cascata se mede executando"* é lição escrita neste ecossistema, e ela nasceu de duas regressões
// visuais que nenhum teste de texto pegou: a função existia, era chamada, a classe estava escrita e
// estava no CSS — e o elemento tinha mudado de casa. Aqui o risco é o mesmo em outra forma:
//
//   • um ERRO DE SINTAXE numa folha passa em todos os testes de texto. O arquivo existe, as classes
//     estão declaradas, o `@layer` está escrito — e o navegador descarta o bloco em silêncio;
//   • a CAMADA não tem representação textual verificável. `@layer vssh { … }` está lá nos dois
//     casos; o que muda é só quem ganha o empate, e isso só existe pintado.
//
// ─── O que se mede ──────────────────────────────────────────────────────────
//
// Junções, e não aparência. Se o botão está bonito é julgamento humano, e a bancada dele é
// `docs/componentes.html`, que abre de `file://` sem servidor nenhum.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const {
  abrirNavegador, caminhoDoNavegador, motivoDoSkip, servirOrigem,
} = require('../../../tests/browser/chrome.js');

const TUFF = path.join(__dirname, '..', 'tuff');
const temNavegador = !!caminhoDoNavegador();
const seNaoTem = { skip: temNavegador ? false : motivoDoSkip() };

// Os valores que a paleta manda, escritos como o `getComputedStyle` os devolve. Não são uma segunda
// cópia da paleta: `tests/tuff-fidelidade.test.js` já prende os tokens ao shell, e o que estes
// números medem é se a folha CHEGOU e foi APLICADA — um arquivo que o navegador descartou por erro
// de sintaxe devolveria o valor inicial do CSS, não estes.
const BG_INPUT = 'rgb(60, 60, 60)';     // --tuff-bg-input #3c3c3c
const ACCENT = 'rgb(14, 99, 156)';      // --tuff-accent   #0e639c

// ⚠ As peças medidas abaixo NÃO podem ser as que o `<style>` do app sobrescreve. Na primeira
// versão o teste da folha usava um `.tuff-btn tuff-btn--primario`, e ele falhou — corretamente:
// a regra `.tuff-btn` do app, fora de camada, vence `.tuff-btn--primario`, que está dentro. Era o
// próprio mecanismo sob teste dando o resultado certo numa pergunta mal feita.

/** A folha pedida, do disco. Serve os arquivos REAIS — uma cópia aqui mediria a cópia. */
function rotaDaBiblioteca(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // ⚠ O `<style>` do app vem ANTES dos `<link>` da biblioteca, de propósito: é a ordem real. O
    // `static-spa` injeta imediatamente antes de `</head>`, ou seja depois de tudo que o app
    // escreveu. Sem `@layer`, a biblioteca ganharia todo empate de especificidade e o app não
    // conseguiria sobrescrever a própria biblioteca sem `!important`.
    res.end(`<!doctype html><meta charset="utf-8"><title>tuff</title>
      <style>
        /* O app, sem camada. Tem de VENCER a biblioteca. */
        .tuff-btn { background: rgb(204, 0, 0); }
      </style>
      <link rel="stylesheet" href="/tuff/tuff-tokens.css">
      <link rel="stylesheet" href="/tuff/tuff-base.css">
      <link rel="stylesheet" href="/tuff/tuff.css">
      <button class="tuff-btn" id="app-manda">o app manda</button>
      <input class="tuff-campo" id="campo">
      <div class="tuff-progresso">
        <div class="tuff-progresso-preenchido" id="preenchido" style="width:50%"></div>
      </div>
      <div id="rolavel" style="width:120px;height:60px;overflow-y:scroll">
        <div style="height:400px"></div>
      </div>`);
    return true;
  }
  const m = /^\/tuff\/([\w.-]+)$/.exec(u.pathname);
  if (m) {
    const alvo = path.join(TUFF, m[1]);
    if (!fs.existsSync(alvo)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end(fs.readFileSync(alvo));
    return true;
  }
  return false;
}

let nav = null;
let origem = null;
before(async () => {
  if (!temNavegador) return;
  // Em sequência, e não em `Promise.all`: com o `Promise.all`, um navegador que não sobe deixaria o
  // servidor escutando sem ninguém para fechá-lo, e a suíte ficaria pendurada em vez de falhar.
  origem = await servirOrigem(rotaDaBiblioteca);
  nav = await abrirNavegador();
});
after(async () => {
  if (nav) await nav.fechar();
  if (origem) await origem.fechar();
});

test('as folhas carregam e valem — um erro de sintaxe apareceria aqui', seNaoTem, async () => {
  // A asserção mais barata e a que mais paga: qualquer bloco descartado pelo navegador (chave
  // sobrando, `@layer` malformado, arquivo faltando no servidor) devolve o valor inicial em vez do
  // token. Nenhum teste de texto distingue as duas coisas.
  const p = await nav.novaPagina(origem.url);
  const fundo = await p.avaliar(
    `getComputedStyle(document.getElementById('campo')).backgroundColor`);
  assert.equal(fundo, BG_INPUT,
    'o `.tuff-campo` não recebeu o fundo de campo: ou a folha não chegou, ou o navegador '
    + 'descartou o bloco por erro de sintaxe');
});

test('o CSS do app VENCE o da biblioteca, sem !important', seNaoTem, async () => {
  // A razão de `@layer` existir neste projeto, e a única asserção deste arquivo que não tem
  // representação textual nenhuma: os dois casos têm `@layer vssh { … }` escrito, e o que muda é
  // quem ganha o empate.
  //
  // Uma biblioteca que vence o app em todo empate não é ferramenta, é camisa de força.
  const p = await nav.novaPagina(origem.url);
  const fundo = await p.avaliar(
    `getComputedStyle(document.getElementById('app-manda')).backgroundColor`);
  assert.equal(fundo, 'rgb(204, 0, 0)',
    'a biblioteca venceu o CSS do app. Alguma regra escapou do `@layer vssh` — e a partir daqui o '
    + 'app só consegue sobrescrever com `!important`');
});

test('a cor do ambiente repinta o que já está na tela', seNaoTem, async () => {
  // O caminho completo da herança, mas medido do lado que importa: o que o `vssh.aparencia` lê é
  // escrito como custom property inline, e a pergunta é se as peças acompanham. Se o botão
  // primário tivesse a cor escrita à mão em vez de `var(--ds-accent)`, tudo passaria até o dia em
  // que alguém trocasse o destaque.
  const p = await nav.novaPagina(origem.url);
  const antes = await p.avaliar(
    `getComputedStyle(document.getElementById('preenchido')).backgroundColor`);
  assert.equal(antes, ACCENT, 'a barra de progresso já não nasce na cor de destaque');

  const depois = await p.avaliar(`(() => {
    document.documentElement.style.setProperty('--ds-accent', '#ae4278');
    return getComputedStyle(document.getElementById('preenchido')).backgroundColor;
  })()`);
  assert.equal(depois, 'rgb(174, 66, 120)',
    'a barra não acompanhou a troca de destaque: em algum lugar a cor está escrita à mão');
});

test('a scrollbar é a do tema, e não a do sistema', seNaoTem, async () => {
  // Item literal da tabela do critério 3.3, e ele não sai em `getComputedStyle`: `::-webkit-scrollbar`
  // não é propriedade computada de elemento nenhum. O que dá para medir é a consequência — a
  // largura que ela ocupa —, e é a medida certa: é exatamente o que o olho vê.
  const p = await nav.novaPagina(origem.url);
  const largura = await p.avaliar(`(() => {
    const el = document.getElementById('rolavel');
    return el.offsetWidth - el.clientWidth;
  })()`);
  assert.equal(largura, 6,
    `a scrollbar ocupa ${largura}px em vez de 6: é a do sistema, e uma barra cinza no meio de uma `
    + 'janela escura é o exemplo que o critério 3.3 usa para explicar por que aparência é critério');
});

test('o tema é escuro por declaração, e não por acaso', seNaoTem, async () => {
  // `color-scheme: dark` é uma linha e conserta o que não é nosso: os controles nativos que
  // sobrarem, o fundo dos campos antes do CSS carregar, a scrollbar de subframes. Sem ela, um
  // `<input type="date">` abre um calendário branco dentro de uma janela escura.
  const p = await nav.novaPagina(origem.url);
  const esquema = await p.avaliar(`getComputedStyle(document.documentElement).colorScheme`);
  assert.equal(esquema, 'dark');
});
