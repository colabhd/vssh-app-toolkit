'use strict';

// O vocabulário da biblioteca: nada declarado sem uso, nada usado sem declaração.
//
// ─── Por que este arquivo existe ─────────────────────────────────────────────
//
// É o espelho de `tests/unit/client-css-classes.test.js` do `vssh-sso`, e o motivo dele está escrito
// no `criterios.md`: a gravidade está no MODO DE FALHA. *"Id que não existe estoura um `null`;
// classe que não existe não faz nada e não avisa — o elemento só nasce sem estilo, e quem escreveu
// jura que escreveu."*
//
// O outro sentido importa igual, e por uma razão que só vale para uma BIBLIOTECA: um componente que
// ninguém demonstra é um componente que ninguém pode conferir. O critério 3.3 se decide olhando, e
// não há como olhar o que não está em lugar nenhum — ele apodrece entre um bump e outro, e a
// primeira pessoa a usá-lo descobre sozinha.
//
// ─── O que NÃO se mede aqui ──────────────────────────────────────────────────
//
// Se a cascata funciona. Isso é do Chrome de verdade (`lib/web/test/tuff.browser.test.js`), porque
// *"cascata se mede executando"* — o seletor pode estar escrito, a classe pode estar no HTML, e o
// que muda é só quem ganha.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const TUFF = path.join(RAIZ, 'lib', 'web', 'tuff');
const CATALOGO = path.join(RAIZ, 'docs', 'componentes.html');

const ler = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const semComentarios = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** As folhas de componente — os tokens não declaram classe nenhuma. */
const FOLHAS = ['tuff-base.css', 'tuff.css'];

/** Toda classe `.tuff-*` que a biblioteca DECLARA. */
function classesDeclaradas() {
  const fora = new Set();
  for (const nome of FOLHAS) {
    for (const m of semComentarios(ler(path.join(TUFF, nome))).matchAll(/\.(tuff-[\w-]+)/g)) {
      fora.add(m[1]);
    }
  }
  return fora;
}

/**
 * Toda classe usada nos `class="..."` de um HTML.
 *
 * Extraída do atributo, e não procurada por substring: `tuff-btn` é prefixo de
 * `tuff-btn--primario`, e um `includes` diria que o primeiro está em uso quando só o segundo está.
 * O teste passaria sobre uma classe morta.
 */
function classesUsadas(html) {
  const fora = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) fora.add(c);
  }
  return fora;
}

test('toda classe da biblioteca aparece no catálogo', () => {
  const declaradas = classesDeclaradas();
  const usadas = classesUsadas(ler(CATALOGO));

  assert.ok(declaradas.size >= 30,
    `só ${declaradas.size} classes lidas das folhas — o parser parou de enxergar o CSS`);

  const semDemonstracao = [...declaradas].filter((c) => !usadas.has(c)).sort();
  assert.deepEqual(semDemonstracao, [],
    'estes componentes não aparecem em docs/componentes.html. Um componente que ninguém demonstra '
    + 'é um componente que ninguém pode conferir — e o critério 3.3 se decide olhando. '
    + 'Acrescente a peça ao catálogo, ou apague o CSS.');
});

test('toda classe do catálogo existe no CSS', () => {
  const declaradas = classesDeclaradas();
  const usadas = classesUsadas(ler(CATALOGO));

  const fantasmas = [...usadas].filter((c) => c.startsWith('tuff-') && !declaradas.has(c)).sort();
  assert.deepEqual(fantasmas, [],
    'o catálogo usa classes `tuff-` que a biblioteca não declara: o elemento nasce sem estilo e '
    + 'nada avisa — quem escreveu jura que escreveu');
});

test('o tooltip por atributo é exercitado', () => {
  // Ele não é classe, então escapa dos dois testes acima — e é justamente a peça que NÃO existe no
  // shell, ou seja, a que menos gente vai reparar se sumir.
  const css = semComentarios(ler(path.join(TUFF, 'tuff.css')));
  assert.match(css, /\[data-tuff-dica\]/, 'o tooltip saiu da biblioteca');
  assert.match(ler(CATALOGO), /data-tuff-dica="/, 'o catálogo não exercita o tooltip');
});

test('os componentes leem tokens, e não cores escritas à mão', () => {
  // A regra que o `design-tokens.css` do shell escreve em prosa, e que os componentes dele cumprem
  // (196 usos de `--ds-*`, zero de `--tuff-*`). Aqui ela é medida.
  //
  // ⚠ **Duas isenções, e as duas são deliberadas.**
  //
  // 1. A escala de TIPO e as métricas da scrollbar (`--tuff-size-*`, `--tuff-weight-*`,
  //    `--tuff-sb-*`) são lidas da camada bruta porque o shell não as promove a semânticas — e ali
  //    a razão da regra não se aplica: ela existe para *"trocar a base sem caçar cor em 24
  //    arquivos"*, e não há uma segunda base de tamanhos.
  // 2. Cor dentro de um `url("data:image/svg+xml…")`. Um data URI não lê custom property, e a
  //    técnica que resolveria (`mask-image`) precisa de um elemento próprio — que `<select>` e
  //    `<input>` não têm. Está dito em voz alta no CSS, ao lado da seta.
  for (const nome of FOLHAS) {
    const css = semComentarios(ler(path.join(TUFF, nome)))
      .replace(/url\("data:[^"]*"\)/g, 'url(DATA)');

    const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepEqual(hex, [],
      `${nome} tem cor escrita à mão: ela não acompanha a paleta, e a divergência aparece como uma `
      + 'peça fora do tom que ninguém sabe de onde veio');

    const rgb = [...css.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((m) => m[0]);
    assert.deepEqual(rgb, [],
      `${nome} tem cor funcional escrita à mão — mesma consequência do hexadecimal`);

    const brutos = [...css.matchAll(/var\(\s*(--tuff-(?!size-|weight-|sb-)[\w-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(brutos)], [],
      `${nome} lê a camada BRUTA de tokens. Componentes leem apenas \`--ds-*\`: é o que permite `
      + 'trocar a base sem caçar cor em folha nenhuma');
  }
});

test('a biblioteca NÃO reimplementa o que é do desktop', () => {
  // Diálogo, menu de contexto, aviso, bandeja e seletor são superfícies do SHELL, pedidas por
  // `vssh.*`. Uma versão nossa não seria só redundante — ela ficaria **presa dentro do iframe**: não
  // cobriria a janela, não sobreviveria a um app em tela cheia, e não apareceria por cima do resto
  // do ambiente. Um `<div>` com `position: fixed` dá a impressão de diálogo até alguém maximizar.
  //
  // A busca é pelas MARCAS da coisa, e não pelo nome: uma classe chamada `.tuff-modal` seria fácil
  // de evitar renomeando, e o defeito é o comportamento.
  const proibidos = [
    [/position:\s*fixed/, 'sobreposição em tela cheia — é o desenho de um modal ou de um toast'],
    [/\[role="dialog"\]|\.tuff-modal|\.tuff-dialogo/, 'um diálogo próprio'],
    [/\.tuff-(menu|ctx|contextmenu)\b/, 'um menu de contexto próprio'],
    [/\.tuff-(toast|notificacao|aviso-flutuante)\b/, 'um aviso flutuante próprio'],
    [/backdrop-filter/, 'vidro — o sistema declara `--ds-blur: none`, e isso é decisão de produto'],
  ];

  for (const nome of FOLHAS) {
    const css = semComentarios(ler(path.join(TUFF, nome)));
    for (const [padrao, oQue] of proibidos) {
      assert.doesNotMatch(css, padrao,
        `${nome} traz ${oQue}. Essa superfície é do desktop: peça por \`vssh.dialog\`, `
        + '`vssh.contextMenu`, `vssh.toast` ou `vssh.tray`. Uma versão nossa fica presa no iframe, '
        + 'e ainda ensina o oposto do que o ambiente construiu.');
    }
  }
});

test('a biblioteca inteira mora em @layer, senão o app não consegue sobrescrevê-la', () => {
  // A folha injetada entra depois do CSS do app. Sem camada, ela ganha todo empate de
  // especificidade — e a biblioteca vira camisa de força, com `!important` como única saída.
  //
  // Isto se mede de verdade executando (ver `tuff.browser.test.js`); aqui se mede a condição
  // necessária, que é barata e pega o caso de alguém acrescentar uma folha nova sem a camada.
  for (const nome of [...FOLHAS, 'tuff-tokens.css']) {
    const css = semComentarios(ler(path.join(TUFF, nome)));
    assert.match(css, /@layer\s+vssh\s*\{/,
      `${nome} não está em @layer vssh: as regras dele passam a vencer as do app por ordem de fonte`);

    // Regra fora da camada é o furo real: basta uma para o app perder o controle daquela peça.
    const forade = css.split(/@layer\s+vssh\s*\{/)[0];
    assert.doesNotMatch(forade, /^\s*[.:[#a-z*][^{}]*\{/mi,
      `${nome} tem regra ANTES do @layer — ela escapa da camada e vence o CSS do app`);
  }
});
