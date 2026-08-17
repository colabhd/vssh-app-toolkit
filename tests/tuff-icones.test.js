'use strict';

// Os ícones: os do shell não derivam, os nossos seguem a forma, e nenhum `#ico-…` citado é fantasma.
//
// ─── O modo de falha que justifica este arquivo ──────────────────────────────
//
// ⚠ **Um `<use href>` que não resolve NÃO LANÇA. Ele simplesmente não desenha.**
//
// Não é hipótese. No `vssh-sso`, `ContextMenu._ICON_MAP` apontava `text_decrease` para um
// `ico-minus` que **não existia**, e "Diminuir Fonte" apareceu como um quadrado vazio de 14×14 em
// dois menus, por meses, sem uma linha no console. Foi achado por acidente. O
// `tests/unit/sprite-icons.test.js` de lá nasceu disso, e este é o irmão dele deste lado do iframe.
//
// A gravidade é a mesma da classe CSS que não existe, e pela mesma razão: não faz nada e não avisa.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const FONTE = path.join(RAIZ, 'lib', 'web', 'tuff', 'tuff-icones.js');
const ler = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** Os `<symbol>` que a biblioteca carrega, por nome (sem o prefixo `ico-`). */
function nossosSimbolos() {
  const js = ler(FONTE);
  const mapa = new Map();
  for (const m of js.matchAll(/'(<symbol id="ico-([a-z0-9-]+)"[\s\S]*?<\/symbol>)'/g)) {
    mapa.set(m[2], m[1].replace(/\\'/g, "'"));
  }
  return mapa;
}

/** Os do shell, se houver um checkout do `vssh-sso` alcançável. */
function spriteDoShell() {
  const candidatos = [
    process.env.VSSH_SSO_DIR && path.resolve(process.env.VSSH_SSO_DIR),
    path.join(RAIZ, '..', 'vssh-sso'),
  ].filter(Boolean);
  for (const base of candidatos) {
    const alvo = path.join(base, 'vssh-client', 'index.html');
    if (fs.existsSync(alvo)) {
      const html = ler(alvo);
      const mapa = new Map();
      for (const m of html.matchAll(/<symbol id="ico-([a-z0-9-]+)"[\s\S]*?<\/symbol>/g)) {
        mapa.set(m[1], m[0].replace(/\s+/g, ' '));
      }
      return mapa;
    }
  }
  return null;
}

const DO_SHELL = spriteDoShell();
const seNaoTemShell = {
  skip: DO_SHELL ? false : 'sem o checkout do vssh-sso ao lado — defina VSSH_SSO_DIR',
};

// ─── O que é NOSSO ───────────────────────────────────────────────────────────
//
// Os ícones que não existem no shell, acrescentados para o que um visualizador de fotos e um player
// de vídeo precisam. Cada um é **candidato a subir** para o sprite de lá: quando subir, ele sai
// desta lista e passa a ser conferido pela fidelidade, como todos os outros.
//
// ⚠ **E seis já subiram.** A central de mídia do shell precisou de `play`, `pause`, `rewind`,
// `forward`, `skip-back` e `skip-forward`, e eles foram copiados DAQUI para o `index.html` de lá —
// o player do Palco e a central do ambiente mostram o mesmo controle, e dois desenhos para a mesma
// ação é a divergência que ninguém reporta e todo mundo sente. Saíram desta lista e passaram a ser
// cobrados pela fidelidade, que é exatamente o que o parágrafo acima promete que acontece.
const NOSSOS = new Set([
  'stop',
  // A segunda leva, para o player completo do Palco. `cast` foi considerado e RECUSADO: não há
  // Chromecast neste ambiente, e ícone sem consumidor é a mesma dívida da classe que não estiliza
  // nada — a lição que `chevron-left`/`chevron-right` já custaram logo abaixo.
  // `repeat-one` não é enfeite do `repeat`: repetir é TRI-ESTADO, e o terceiro estado precisa de
  // glifo próprio — cor sozinha distingue dois, não três.
  'pip', 'subtitles', 'speed', 'repeat', 'repeat-one', 'shuffle',
  'zoom-in', 'zoom-out', 'fit', 'rotate-left', 'rotate-right', 'crop', 'eye', 'eye-off',
  // ⚠ Só `chevron-up`. Eu havia acrescentado `chevron-left` e `chevron-right`, e as duas eram
  // DUPLICATAS: no shell as setas horizontais se chamam `arrow-left`/`arrow-right`, e o desenho é o
  // mesmo chevron (`M10.5 3L5 8l5.5 5` contra o meu `M10 3.5L5.5 8l4.5 4.5`). Eu procurei por
  // "chevron", achei só `chevron-down`, e concluí que faltavam três — a armadilha exata que o
  // `criterios.md` nomeia: *"procurar o vocabulário existente não é procurar pelo nome que se
  // espera; a ausência de um nome não é a ausência da coisa."*
  //
  // `chevron-up` fica porque é o par que falta do `chevron-down`, e não há `arrow-up` no shell.
  // A inconsistência de nomenclatura de lá (horizontal = `arrow`, vertical = `chevron`) é dívida
  // deles, e resolvê-la aqui criaria uma terceira convenção.
  'chevron-up',
  'star', 'check-circle', 'x-circle', 'help',
  'filter', 'list', 'columns', 'tag', 'calendar',
  'link', 'share', 'save', 'drag',
]);

test('os ícones herdados são IDÊNTICOS aos do shell', seNaoTemShell, () => {
  // Verbatim, e não "equivalente". Dois desenhos parecidos do mesmo ícone lado a lado no mesmo
  // ambiente — um na janela do app, outro na barra de tarefas — é pior que dois desenhos
  // diferentes: o olho registra que algo está errado e não sabe dizer o quê.
  const nossos = nossosSimbolos();
  const divergentes = [];
  for (const [nome, svg] of DO_SHELL) {
    if (!nossos.has(nome)) continue;
    if (nossos.get(nome) !== svg) divergentes.push(nome);
  }
  assert.deepEqual(divergentes, [],
    'estes ícones foram redesenhados em vez de copiados. O mesmo símbolo tem de ser o mesmo traço '
    + 'nos dois lados do iframe.');
});

test('ícone que o shell tem e a biblioteca não reprova', seNaoTemShell, () => {
  const nossos = nossosSimbolos();
  const faltando = [...DO_SHELL.keys()].filter((n) => !nossos.has(n));
  assert.deepEqual(faltando, [],
    'o shell ganhou ícones que a biblioteca não tem: um app que usasse o mesmo nome desenharia '
    + 'nada, em silêncio');
});

test('ícone declarado como NOSSO que já subiu para o shell reprova', seNaoTemShell, () => {
  // O espelho, e a razão é a mesma das listas de token: uma entrada que sobrevive ao fato que a
  // justificava vira autorização sem dono. Se o shell adotou o ícone, ele deixa de ser nosso e
  // passa a ser conferido pela fidelidade — que é uma garantia mais forte.
  const jaLaEmCima = [...NOSSOS].filter((n) => DO_SHELL.has(n));
  assert.deepEqual(jaLaEmCima, [],
    'estes ícones já existem no shell: tire-os de NOSSOS para que a fidelidade passe a cobri-los');
});

test('todo ícone da biblioteca é do shell ou está declarado como nosso', () => {
  // Roda SEM o irmão, e é o que impede alguém de acrescentar um desenho no meio do arquivo sem
  // dizer de onde ele veio.
  const nossos = nossosSimbolos();
  assert.ok(nossos.size >= 85, `só ${nossos.size} ícones lidos — o parser parou de enxergar o mapa`);

  const semProcedencia = DO_SHELL
    ? [...nossos.keys()].filter((n) => !DO_SHELL.has(n) && !NOSSOS.has(n))
    : [];
  assert.deepEqual(semProcedencia, [],
    'estes ícones não vêm do shell nem estão declarados em NOSSOS — de onde saíram?');

  const declaradosSemExistir = [...NOSSOS].filter((n) => !nossos.has(n));
  assert.deepEqual(declaradosSemExistir, [],
    'NOSSOS declara ícones que não estão no arquivo');
});

test('os ícones novos seguem a forma do conjunto', () => {
  // 16×16 e `currentColor` não são estilo: são o que faz um ícone acompanhar a cor do texto e
  // encaixar na mesma grade dos outros. Um SVG de 24×24 no meio do conjunto sai maior e desalinhado,
  // e um com cor fixa fica invisível quando o botão inverte.
  const nossos = nossosSimbolos();
  const fora = [];
  for (const nome of NOSSOS) {
    const svg = nossos.get(nome) || '';
    if (!/viewBox="0 0 16 16"/.test(svg)) fora.push(`${nome}: viewBox fora de 16×16`);
    if (!/currentColor/.test(svg)) fora.push(`${nome}: não usa currentColor`);
  }
  assert.deepEqual(fora, []);
});

test('todo #ico-… citado no repositório existe', () => {
  // A guarda que o defeito do `ico-minus` produziu no shell, deste lado. Varre o que uma pessoa
  // escreve à mão — a galeria de componentes, os templates, o CSS — e recusa referência fantasma.
  const nossos = nossosSimbolos();
  const alvos = [
    path.join(RAIZ, 'docs', 'componentes.html'),
    path.join(RAIZ, 'lib', 'web', 'tuff', 'tuff.css'),
    path.join(RAIZ, 'lib', 'web', 'tuff', 'tuff-midia.css'),
    path.join(RAIZ, 'lib', 'web', 'tuff', 'tuff-midia.js'),
    path.join(RAIZ, 'templates', 'hello-vssh-app-node', 'frontend', 'index.html'),
    path.join(RAIZ, 'templates', 'hello-vssh-app-node', 'frontend', 'galeria.js'),
  ].filter((p) => fs.existsSync(p));

  const fantasmas = [];
  for (const arquivo of alvos) {
    // Sem comentário: a prosa que EXPLICA o idioma cita `#ico-folder` como exemplo, e ela acusaria
    // a si mesma. É a mesma armadilha que o `sem-comentarios.js` do shell existe para desarmar.
    const texto = ler(arquivo)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/[^\n]*/gm, '');
    for (const m of texto.matchAll(/#ico-([a-z0-9-]+)/g)) {
      if (!nossos.has(m[1])) fantasmas.push(`${path.basename(arquivo)}: #ico-${m[1]}`);
    }
  }
  assert.deepEqual(fantasmas, [],
    'referência a ícone que não existe. Um `<use href>` que não resolve não lança e não desenha — '
    + 'foi assim que "Diminuir Fonte" ficou meses como um quadrado vazio no shell.');
});

test('a deriva de espessura do sprite do shell está MEDIDA, e não corrigida no chute', seNaoTemShell, () => {
  // Não é uma asserção sobre o que deveria ser: é o registro de um fato que apareceu ao copiar, e
  // que é decisão de quem desenhou o conjunto, não minha.
  //
  // O sprite do shell tem TRÊS espessuras de traço — 1.3, 1.4 e 1.5 — e dois ícones sólidos. Parte
  // disso é legítima: ícone denso costuma ser afinado de propósito para o peso óptico bater, e
  // `more`/`audio` são sólidos por natureza. Parte parece deriva. Normalizar sem desenhar seria
  // adivinhar, e a lição escrita no `criterios.md` é a oposta: *"antes de escrever CSS, ler o que
  // está lá; a ausência de um nome não é a ausência da coisa."*
  //
  // Este teste falha se a distribuição MUDAR — o que quer dizer que alguém mexeu no conjunto lá, e
  // é a hora de olhar de novo em vez de continuar copiando no automático.
  const espessuras = {};
  for (const svg of DO_SHELL.values()) {
    const m = /stroke-width="([0-9.]+)"/.exec(svg);
    const chave = m ? m[1] : 'sólido (fill)';
    espessuras[chave] = (espessuras[chave] || 0) + 1;
  }
  // Medido, não estimado: 45 a 1.5, NOVE a 1.3, sete a 1.4 e CINCO sem traço nenhum.
  //
  // ⚠ Duas derivas, ambas do transporte de mídia que subiu daqui para o `index.html` do shell, e
  // ambas registradas em vez de apagadas — que é o ponto deste caso: número novo entra depois de
  // ser explicado.
  //
  //   sólidos 1 → 5   play, pause, skip-back e skip-forward são `fill` por natureza: um triângulo
  //                   de play desenhado a traço fica com um buraco no meio.
  //   1.3     7 → 9   `voltar-10` e `avancar-10` são os únicos ícones com um NÚMERO dentro, e um
  //                   "10" a 1.5 de espessura fecha os vazios do zero a 16px. A espessura menor é
  //                   o preço de caber um dígito legível — não é desleixo, é o que o glifo exigiu.
  assert.deepEqual(espessuras, { 1.5: 45, 1.3: 9, 1.4: 7, 'sólido (fill)': 5 },
    'a distribuição de espessuras do sprite do shell mudou. Reveja a cópia antes de seguir: '
    + `agora é ${JSON.stringify(espessuras)}`);
});
