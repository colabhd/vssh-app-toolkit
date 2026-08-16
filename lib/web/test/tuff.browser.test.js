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
const ACCENT_H = 'rgb(17, 119, 187)';   // --tuff-accent-h #1177bb

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
      <link rel="stylesheet" href="/tuff/tuff-midia.css">
      <script src="/tuff/tuff-midia.js"></script>
      <button class="tuff-btn" id="app-manda">o app manda</button>
      <input class="tuff-campo" id="campo">
      <div class="tuff-progresso">
        <div class="tuff-progresso-preenchido" id="preenchido" style="width:50%"></div>
      </div>
      <div id="rolavel" style="width:120px;height:60px;overflow-y:scroll">
        <div style="height:400px"></div>
      </div>
      <div id="grade" style="width:400px;height:200px"></div>
      <div id="raiz-player">
        <div class="tuff-palco" data-tuff-palco style="height:80px"></div>
        <div class="tuff-chrome" id="chrome" data-tuff-chrome>
          <button class="tuff-btn" id="bt-play" data-tuff-play>play</button>
        </div>
      </div>
      <div id="raiz-icone">
        <button class="tuff-btn tuff-btn--icone" id="bt-play-ico" data-tuff-play aria-label="x">
          <svg class="tuff-ico"><use href="#ico-play"></use></svg>
        </button>
      </div>
      <div id="raiz-tempo">
        <div class="tuff-trilha" id="trilha-tempo" data-tuff-trilha style="width:200px"></div>
        <span class="tuff-tempo" id="tempo-tempo" data-tuff-tempo></span>
        <span id="so-atual" data-tuff-tempo-atual></span>
        <span id="so-total" data-tuff-tempo-total></span>
      </div>
      <div class="tuff-vazio" id="vazio" style="height:400px;justify-content:center">
        <div class="tuff-vazio-titulo">Nada aqui</div>
        <div class="tuff-vazio-msg" id="vazio-msg">o que fazer a respeito</div>
        <div class="tuff-acoes" id="vazio-acoes"><button class="tuff-btn">Fazer</button></div>
      </div>
      <div class="tuff-painel" id="painel" style="height:200px;display:flex;flex-direction:column">
        <div>topo</div>
        <div class="tuff-acoes" id="painel-acoes"><button class="tuff-btn">Salvar</button></div>
      </div>
      <div class="tuff-dica" id="dica">um texto com <strong id="dica-forte">ênfase</strong> no meio</div>
      <div class="tuff-transporte">
        <button class="tuff-btn tuff-btn--icone" id="tg-on" aria-pressed="true" aria-label="ligado">a</button>
        <button class="tuff-btn tuff-btn--icone" id="tg-off" aria-pressed="false" aria-label="desligado">b</button>
      </div>`);
    return true;
  }
  const m = /^\/tuff\/([\w.-]+)$/.exec(u.pathname);
  if (m) {
    const alvo = path.join(TUFF, m[1]);
    if (!fs.existsSync(alvo)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, {
      'content-type': alvo.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8',
    });
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

// ── As peças de mídia ────────────────────────────────────────────────────────

test('a grade não põe dez mil elementos no DOM', seNaoTem, async () => {
  // A razão de a grade existir. Uma pasta de fotos tem dezenas de milhares de arquivos, e um `<img>`
  // por arquivo trava a aba na abertura sem se recuperar — um defeito que o autor do app só encontra
  // no diretório de outra pessoa, nunca no dele.
  //
  // Isto NÃO se mede lendo o código: a virtualização pode estar escrita e o laço ainda montar tudo.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    TuffMidia.grade(document.getElementById('grade'), {
      total: 10000, largura: 96, altura: 68, gap: 6, montar(i, no) { no.textContent = i; },
    });
    const el = document.getElementById('grade');
    return {
      nos: el.querySelectorAll('.tuff-miniatura').length,
      alturaDoFuso: el.querySelector('.tuff-grade-fuso').offsetHeight,
    };
  })()`);

  assert.ok(r.nos > 0 && r.nos < 200,
    `a grade montou ${r.nos} nós para 10 000 itens — a virtualização não está valendo`);
  // O fuso precisa ter a altura do conteúdo INTEIRO, senão a barra de rolagem mente sobre o
  // tamanho da pasta e não há como chegar ao fim dela.
  assert.ok(r.alturaDoFuso > 100000,
    `o fuso tem ${r.alturaDoFuso}px: a rolagem não alcança os 10 000 itens`);
});

test('rolar a grade remonta os nós em vez de acumular DOM', seNaoTem, async () => {
  // O outro lado da virtualização, e o que separa "monta só o visível" de "monta o visível e
  // esquece de reusar": rolar até o meio de uma pasta grande não pode fazer o DOM crescer.
  //
  // ⚠ A asserção NÃO é contagem idêntica — foi a primeira versão, e ela media a coisa errada. O
  // número de fileiras visíveis varia em uma conforme a rolagem alinha ou não com o início de uma
  // linha, então exigir igualdade mediria o alinhamento. A propriedade que importa é continuar
  // LIMITADO: um punhado de nós, e não dez mil.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const el = document.getElementById('grade');
    TuffMidia.grade(el, { total: 10000, largura: 96, altura: 68, gap: 6,
      montar(i, no) { no.textContent = i; } });
    const antes = el.querySelectorAll('.tuff-miniatura').length;
    el.scrollTop = 40000;
    el.dispatchEvent(new Event('scroll'));
    return { antes, depois: el.querySelectorAll('.tuff-miniatura').length,
             texto: el.querySelector('.tuff-miniatura').textContent };
  })()`);

  assert.ok(r.depois <= r.antes + 6,
    `o DOM foi de ${r.antes} para ${r.depois} nós ao rolar: o pool não está sendo reaproveitado, e `
    + 'numa pasta de verdade ele cresce até travar a aba');
  assert.ok(Number(r.texto) > 1000,
    `depois de rolar, o primeiro nó ainda mostra "${r.texto}" — os nós não foram remontados`);
});

test('uma dica com <strong> no meio continua sendo um parágrafo', seNaoTem, async () => {
  // ⚠ Defeito que JÁ ESTAVA PUBLICADO, e que só apareceu olhando o catálogo ampliado.
  //
  // `.tuff-dica` era `display: flex`. Num contêiner flex, **todo filho é blocado** — um `<strong>`
  // vira um item de bloco, e cada pedaço de texto solto ao redor dele vira um item anônimo. O
  // resultado é o parágrafo partido numa fileira de colunas estreitas de uma palavra cada.
  //
  // O que torna isto grave é qual uso ele quebrava: escrever texto com uma ênfase no meio é a forma
  // MAIS ÓBVIA de usar o componente. As duas dicas do próprio catálogo estavam assim, e passaram por
  // todos os testes de texto — porque a marcação estava certa; o que estava errado era a caixa.
  //
  // A medição é do mecanismo, e não da aparência: se o `<strong>` computa `display: block`, ele foi
  // blocado como item de flex. `inline` quer dizer que o texto corre.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const forte = document.getElementById('dica-forte');
    const dica = document.getElementById('dica');
    return { display: getComputedStyle(forte).display,
             linhas: Math.round(dica.getBoundingClientRect().height) };
  })()`);

  assert.equal(r.display, 'inline',
    `o <strong> dentro de uma dica computa \`display: ${r.display}\` — ele foi blocado como item de `
    + 'flex, e o parágrafo virou uma fileira de colunas de uma palavra');
  assert.ok(r.linhas < 60,
    `a dica tem ${r.linhas}px de altura para uma linha de texto: ela está empilhando em vez de fluir`);
});

test('um alternador LIGADO se distingue de um desligado, dentro do transporte', seNaoTem, async () => {
  // ⚠ Esta é uma medição de CASCATA, e ela não se faz lendo o arquivo.
  //
  // O estado ligado (`.tuff-btn[aria-pressed="true"]`) e a regra que tira a moldura do botão de
  // ícone dentro do transporte (`.tuff-transporte .tuff-btn--icone`) têm **a mesma especificidade**
  // — 0,2,0. Quando duas regras empatam, ganha a que vier por último no arquivo. Escrita antes, a
  // do estado ligado seria apagada exatamente nos lugares onde ela mais aparece: barra, chrome e
  // transporte, que é onde todo alternador de mídia mora.
  //
  // O modo de falha é silencioso dos dois lados: o CSS está lá, o atributo está lá, e o botão
  // continua igual. Só medindo o valor computado dá para saber quem ganhou.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const cor = (id) => getComputedStyle(document.getElementById(id)).color;
    const fundo = (id) => getComputedStyle(document.getElementById(id)).backgroundColor;
    return { corOn: cor('tg-on'), corOff: cor('tg-off'),
             fundoOn: fundo('tg-on'), fundoOff: fundo('tg-off') };
  })()`);

  assert.notEqual(r.corOn, r.corOff,
    `ligado e desligado têm a MESMA cor (${r.corOn}): o estado de \`aria-pressed\` foi apagado pela `
    + 'regra do transporte — as duas empatam em especificidade, e a ordem no arquivo decide');
  // E o realce é o do AMBIENTE, e não uma cor qualquer: `--ds-accent-h`, o mesmo de
  // `.tuff-gaveta-item--ativo`. Dois jeitos de dizer "ligado" na mesma janela é o defeito.
  assert.equal(r.corOn, ACCENT_H,
    `o alternador ligado está em ${r.corOn}, e não no destaque do ambiente`);

  // ⚠ O FUNDO é medido ao contrário, e isto não é preguiça — é a asserção certa.
  //
  // A primeira versão deste teste exigia que o fundo do ligado e o do desligado FOSSEM diferentes,
  // e ela reprovou com `rgb(204, 0, 0)`: o vermelho que a bancada declara em `.tuff-btn`, fora de
  // camada, para provar que o app manda. Ou seja, eu estava exigindo que a biblioteca vencesse o
  // app — exatamente o que `@layer` existe para impedir.
  //
  // Um app que pinta `.tuff-btn` pinta TODOS eles, inclusive os ligados, e isso está certo. O que a
  // biblioteca ainda entrega nesse caso é a `color`, que o app não tocou — e é por isso que o
  // realce do alternador não pode depender só do fundo.
  assert.equal(r.fundoOn, r.fundoOff,
    'o fundo do alternador ligado escapou da regra do app: `@layer` deveria deixar o app vencer');
});

test('duplo-clique numa miniatura ABRE — e não só o Enter', seNaoTem, async () => {
  // ⚠ Isto nasceu de um defeito real, achado montando um app sobre a lib: `aoAbrir` estava ligado
  // **só à tecla Enter**. Numa grade de miniaturas o mouse selecionava e parava ali — não havia
  // como abrir nada sem teclado.
  //
  // O buraco era invisível dos dois lados. Quem escreve a lib vê `aoAbrir` ser chamado (pelo
  // teclado, que é como se testa rápido); quem usa o app conclui que o app é que não implementou.
  // E não há gerenciador de arquivos, visualizador de fotos ou grade de mídia em que duplo-clique
  // não abra: é o gesto mais estabelecido que existe para "quero este".
  //
  // Os DOIS caminhos são medidos, e de propósito: um teste só do mouse deixaria alguém "consertar"
  // trocando o Enter pelo duplo-clique, o que reabriria o buraco do outro lado.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const el = document.getElementById('grade');
    const abertos = [];
    TuffMidia.grade(el, { total: 500, largura: 96, altura: 68, gap: 6,
      montar(i, no) { no.textContent = i; }, aoAbrir(i) { abertos.push(i); } });

    const nos = el.querySelectorAll('.tuff-miniatura');
    nos[3].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const porMouse = abertos.slice();

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { porMouse, porTeclado: abertos.slice(porMouse.length) };
  })()`);

  assert.deepEqual(r.porMouse, [3],
    'duplo-clique numa miniatura não chamou `aoAbrir`: numa grade de mídia isso quer dizer que o '
    + 'mouse não abre nada, e quem usa conclui que o app é que não implementou');
  assert.deepEqual(r.porTeclado, [0],
    'o Enter deixou de abrir — o conserto do mouse não pode custar o teclado');
});

// ── A fonte de tempo ─────────────────────────────────────────────────────────
//
// O caso que ela existe para atender: o servidor está remuxando o arquivo e mandando por um cano.
// Sem `Content-Length` não há `Accept-Ranges`, e sem ele o `<video>` não sabe a duração nem aceita
// `currentTime =`. A régua verdadeira está no servidor (o `ffprobe` mediu), e buscar é reiniciar o
// ffmpeg com `-ss` — nada disso o elemento consegue relatar nem executar.
//
// O `<video>` de mentira aqui não é economia de bancada: é o único jeito de encenar um elemento
// que está tocando o TRECHO 30:00–30:30 de um filme de uma hora, que é justamente o estado em que
// as duas réguas discordam.

/** O `<video>` de mentira: um cano de 30 s que o servidor cortou aos 30 min. */
const CANO = `{
  paused: true, duration: 30, currentTime: 12, volume: 1, muted: false,
  buffered: { length: 1, start: () => 0, end: () => 25 },
  addEventListener() {}, removeEventListener() {}, play() {}, pause() {},
}`;

test('a fonte de tempo manda na régua — e o <video> não é mais consultado', seNaoTem, async () => {
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const falso = ${CANO};
    const buscados = [];
    TuffMidia.player(document.getElementById('raiz-tempo'), falso, {
      tempo: {
        duracao: () => 3600,
        atual: () => 1800 + falso.currentTime,
        buscar: (t) => buscados.push(t),
      },
    });

    const trilha = document.getElementById('trilha-tempo');
    // Meio da trilha: 200px de largura, então o clique aos 100px é 50% de UMA HORA.
    const r = trilha.getBoundingClientRect();
    trilha.setPointerCapture = () => {};
    trilha.dispatchEvent(new PointerEvent('pointerdown',
      { clientX: r.left + r.width / 2, bubbles: true, pointerId: 1 }));

    return {
      timecode: document.getElementById('tempo-tempo').textContent,
      polegar: trilha.querySelector('.tuff-trilha-polegar').style.left,
      buffer: trilha.querySelector('.tuff-trilha-buffer').style.width,
      buscados,
      currentTimeDoVideo: falso.currentTime,
      valuemax: trilha.getAttribute('aria-valuemax'),
    };
  })()`);

  assert.equal(r.timecode, '30:12 / 1:00:00',
    'o timecode veio do <video> (0:12 / 0:30) — a fonte de tempo não foi consultada');
  assert.equal(r.valuemax, '3600', 'um leitor de tela ouviria a duração do cano, não a do filme');

  // Comparado por número e não por texto: `50.33333333333333%` é o que o navegador escreve, e
  // prender a asserção nesse tanto de casas mediria a impressão do float, não o cálculo.
  const perto = (s, esperado, msg) => {
    const v = parseFloat(s);
    assert.ok(Math.abs(v - esperado) < 0.01, `${msg} (esperava ~${esperado}%, veio ${s})`);
  };

  perto(r.polegar, 100 * 1812 / 3600,
    'o polegar está na fração do CANO, e não na da linha do tempo');

  // 25 s de buffer sobre um cano que começa aos 1800 → carregado até 1825 de 3600.
  perto(r.buffer, 100 * 1825 / 3600,
    'o buffer foi pintado nas coordenadas do cano: a barra de carregado apareceria no começo do '
    + 'filme em vez de junto do playhead');

  assert.deepEqual(r.buscados, [1800],
    'o clique no meio da trilha não chegou a `buscar` com o tempo da LINHA (1800 s de 3600)');
  assert.equal(r.currentTimeDoVideo, 12,
    'escreveu em `video.currentTime` mesmo havendo `buscar`: num cano isso é ignorado pelo '
    + 'elemento, e o seek simplesmente não acontece');
});

test('num estado vazio o botão fica JUNTO da frase que o explica', seNaoTem, async () => {
  // ⚠ Duas peças da biblioteca que, compostas, davam o resultado errado. `.tuff-acoes` tem
  // `margin-top: auto` porque num painel a barra de ações pertence ao rodapé — mas num vazio ALTO
  // (o palco de um player, uma lista de tela inteira) isso jogava o botão a centenas de pixels da
  // frase. E aí ele deixa de ser o convite que o vazio existe para fazer: a pessoa lê "abra um
  // vídeo", não vê botão por perto, e conclui que não há um.
  //
  // A outra metade é conferida junto: no PAINEL o `margin-top: auto` tem de continuar valendo,
  // senão o conserto vira o defeito que o comentário original descreve — botão flutuando no meio
  // do espaço.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const dist = (a, b) => document.getElementById(b).getBoundingClientRect().top
                         - document.getElementById(a).getBoundingClientRect().bottom;
    return { noVazio: dist('vazio-msg', 'vazio-acoes'), noPainel: dist('painel', 'painel-acoes') };
  })()`);

  assert.ok(r.noVazio < 24,
    `o botão ficou a ${Math.round(r.noVazio)}px da frase — ele tem de ler como parte dela`);
  assert.ok(r.noPainel < 0,
    'no painel as ações deixaram de grudar no rodapé: o conserto do vazio não pode custar isso');
});

test('o botão de play com ÍCONE não é apagado pela própria biblioteca', seNaoTem, async () => {
  // ⚠ O defeito era autoinfligido e circular: `TuffIcones`, deste mesmo pacote, manda escrever
  // `<button><svg><use href="#ico-play"></svg></button>`. E o player fazia `textContent = '▶'`, que
  // apaga os filhos — o ícone sumia no primeiro quadro e sobrava um caractere solto no meio do
  // transporte. A biblioteca desfazia o que a biblioteca pedia.
  //
  // O `aria-label` continua sendo escrito nos dois casos: é o nome do botão para quem não vê glifo
  // nenhum, e a metade que nenhum app deve ter de repetir.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const falso = {
      paused: true, duration: 100, currentTime: 0, volume: 1, muted: false,
      buffered: { length: 0 },
      addEventListener() {}, removeEventListener() {}, play() {}, pause() {},
    };
    TuffMidia.player(document.getElementById('raiz-icone'), falso);
    TuffMidia.player(document.getElementById('raiz-player'), falso);
    const comIcone = document.getElementById('bt-play-ico');
    const semIcone = document.getElementById('bt-play');
    return {
      icone: !!comIcone.querySelector('use'),
      rotuloDoIcone: comIcone.getAttribute('aria-label'),
      glifo: semIcone.textContent,
      rotuloDoTexto: semIcone.getAttribute('aria-label'),
    };
  })()`);

  assert.equal(r.icone, true,
    'a biblioteca apagou o ícone que a própria biblioteca manda usar');
  assert.equal(r.rotuloDoIcone, 'Reproduzir', 'o nome acessível tem de ser escrito mesmo assim');
  assert.equal(r.glifo, '▶',
    'um botão sem ícone perdeu o glifo — o conserto não pode custar o comportamento antigo');
  assert.equal(r.rotuloDoTexto, 'Reproduzir');
});

test('o relógio de DUAS PONTAS, que é o que um transporte quer', seNaoTem, async () => {
  // ⚠ `data-tuff-tempo` junta `12:04 / 41:37` num elemento só, e num transporte de dois andares
  // isso desperdiça justamente a largura que a trilha usaria: o decorrido vai à esquerda dela e o
  // total à direita. Sem estes dois atributos, o app reescrevia o relógio à mão — e perdia a fonte
  // de tempo junto, que é o que faz o modo remuxado ter linha do tempo.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const falso = ${CANO};
    TuffMidia.player(document.getElementById('raiz-tempo'), falso, {
      tempo: { duracao: () => 3600, atual: () => 1800 + falso.currentTime },
    });
    return {
      atual: document.getElementById('so-atual').textContent,
      total: document.getElementById('so-total').textContent,
      juntos: document.getElementById('tempo-tempo').textContent,
    };
  })()`);

  assert.equal(r.atual, '30:12', 'a ponta esquerda não recebeu o decorrido');
  assert.equal(r.total, '1:00:00', 'a ponta direita não recebeu a duração');
  assert.equal(r.juntos, '30:12 / 1:00:00',
    'a forma antiga tem de continuar valendo — os apps que a usam não podem quebrar');
});

test('sem a opção, a régua continua sendo a do <video>, byte a byte', seNaoTem, async () => {
  // A outra metade do contrato, e a que impede a opção de virar mudança de comportamento para os
  // apps que já existem: `tempo` é opt-in, e sem ela nada aqui muda.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(() => {
    const falso = ${CANO};
    TuffMidia.player(document.getElementById('raiz-tempo'), falso);
    const trilha = document.getElementById('trilha-tempo');
    const r = trilha.getBoundingClientRect();
    trilha.setPointerCapture = () => {};
    trilha.dispatchEvent(new PointerEvent('pointerdown',
      { clientX: r.left + r.width / 2, bubbles: true, pointerId: 1 }));
    return {
      timecode: document.getElementById('tempo-tempo').textContent,
      buffer: trilha.querySelector('.tuff-trilha-buffer').style.width,
      currentTimeDoVideo: falso.currentTime,
    };
  })()`);

  // `0:15`, e não `0:12`: aqui a busca é síncrona (escreve em `video.currentTime`) e o relógio já
  // repintou. É a diferença que separa os dois modos — no de cima a busca sai pela rede, o
  // elemento não se move, e o relógio só avança quando o novo trecho chega.
  assert.equal(r.timecode, '0:15 / 0:30');
  assert.ok(Math.abs(parseFloat(r.buffer) - 100 * 25 / 30) < 0.01,
    `25 de 30 s, sem deslocamento nenhum — veio ${r.buffer}`);
  assert.equal(r.currentTimeDoVideo, 15, 'sem `buscar`, o seek continua sendo `video.currentTime =`');
});

test('o chrome NÃO some com o foco do teclado dentro dele', seNaoTem, async () => {
  // ⚠ A regra que separa esta peça de uma armadilha, e a que não se descobre testando com o mouse:
  // sumir com o foco dentro deixa quem navega por teclado com o foco num botão que saiu da tela,
  // sem controle nenhum e sem caminho de volta.
  //
  // O `<video>` é de mentira de propósito — o que está sob teste é a lógica do chrome, e um vídeo
  // de verdade tocando num headless traria só variáveis a mais.
  const p = await nav.novaPagina(origem.url);
  const r = await p.avaliar(`(async () => {
    const falso = {
      paused: false, duration: 100, currentTime: 0, volume: 1, muted: false,
      buffered: { length: 0 },
      addEventListener() {}, removeEventListener() {}, play() {}, pause() {},
    };
    TuffMidia.player(document.getElementById('raiz-player'), falso, { ocioMs: 30 });
    const chrome = document.getElementById('chrome');
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));

    document.getElementById('bt-play').focus();
    document.getElementById('raiz-player').dispatchEvent(new PointerEvent('pointermove'));
    await espera(120);
    const comFoco = chrome.classList.contains('tuff-chrome--oculto');

    document.getElementById('bt-play').blur();
    document.getElementById('raiz-player').dispatchEvent(new PointerEvent('pointermove'));
    await espera(120);
    const semFoco = chrome.classList.contains('tuff-chrome--oculto');
    return { comFoco, semFoco };
  })()`);

  assert.equal(r.comFoco, false,
    'o chrome sumiu com o foco do teclado dentro dele: quem navega por teclado fica sem controles '
    + 'e sem caminho de volta');
  assert.equal(r.semFoco, true,
    'o chrome não some nem sem foco — a regra virou "nunca some", que é outro defeito');
});
