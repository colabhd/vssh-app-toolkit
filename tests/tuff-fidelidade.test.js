'use strict';

// Os tokens do Tuff aqui são os MESMOS que os do shell.
//
// ─── Por que este arquivo existe ─────────────────────────────────────────────
//
// `lib/web/tuff/tuff-tokens.css` é uma cópia de
// `vssh-sso/vssh-client/css/design-tokens.css`. Dois repositórios que se instalam
// separados, sem CI cruzado, sem uma linha de código atravessando — que é a forma exata do defeito
// que o `vssh-app-shim.js` já narra sobre o MIME de arraste (`application/x-vssh-files`, duplicado
// entre os dois lados): *"nada acende, nada cai e nada loga — dos dois lados."*
//
// E não é hipótese. O `vsshapp-recoll` recriou esta paleta à mão em 259 linhas, com uma ponte de
// JavaScript ao lado — e a ponte **já apodreceu**: ela escuta `{type:'vssh-theme'}` e cita
// `custom_xprahtml5/js/SettingsWindow.js`. Um `grep` no `vssh-sso` inteiro devolve **zero** para os
// dois. Uma das três pernas está morta há tempo indeterminado, e o sintoma seria só a cor parando de
// acompanhar — nada que caia, nada que logue.
//
// Este teste é o que troca "cópia que apodrece" por "cópia medida".
//
// ─── O que ele mede, e nos dois sentidos ─────────────────────────────────────
//
//   • valor diferente para o mesmo nome  → reprova (a deriva silenciosa)
//   • o shell tem e nós não              → reprova, salvo em NAO_TRAZIDOS, com motivo
//   • nós temos e o shell não            → reprova, salvo em ADIANTE_DO_SHELL, com motivo
//
// As duas listas têm o mesmo desenho das EXCECOES do `galeria-cobertura.test.js`, e pela mesma
// razão: uma exceção sem motivo escrito é o lugar onde a próxima divergência vai se esconder. E
// entrada que perdeu o fato que a justificava também reprova — autorização sem dono é lixo que
// autoriza.
//
// ─── Sem o repositório irmão ─────────────────────────────────────────────────
//
// Pula, com motivo nomeado. É o idioma que este repositório já usa para Chrome
// (`fsa-polyfill.browser.test.js`), bash (`publish-libs-gate.test.js`) e python3
// (`publish-validacao.test.js`): a ausência de uma ferramenta externa não pode reprovar quem mexeu
// noutra coisa. O CI é quem roda com o irmão ao lado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const NOSSO = path.join(RAIZ, 'lib', 'web', 'tuff', 'tuff-tokens.css');

/** O `design-tokens.css` do shell, se houver um checkout do `vssh-sso` alcançável. */
function arquivoDoShell() {
  const candidatos = [
    process.env.VSSH_SSO_DIR && path.resolve(process.env.VSSH_SSO_DIR),
    path.join(RAIZ, '..', 'vssh-sso'),
  ].filter(Boolean);
  for (const base of candidatos) {
    const alvo = path.join(base, 'vssh-client', 'css', 'design-tokens.css');
    if (fs.existsSync(alvo)) return alvo;
  }
  return null;
}

const DO_SHELL = arquivoDoShell();
const seNaoTemShell = {
  skip: DO_SHELL ? false : 'sem o checkout do vssh-sso ao lado — defina VSSH_SSO_DIR',
};

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * As custom properties declaradas num CSS, já sem comentário.
 *
 * Tirar os comentários ANTES é obrigatório, não higiene: os dois arquivos explicam tokens dentro de
 * `/* *\/` citando o nome deles, e um comentário que cite `--ds-accent:` entraria no mapa como se
 * fosse declaração — o teste passaria a medir a prosa.
 */
function tokensDe(css) {
  const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const mapa = new Map();
  for (const m of semComentarios.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    mapa.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return mapa;
}

/**
 * O valor LITERAL de um token, com as indireções `var()` resolvidas.
 *
 * Comparar `var(--tuff-accent)` com `var(--tuff-accent)` não prova nada: os dois lados poderiam
 * apontar para bases diferentes e o teste ficaria verde sobre duas cores distintas. O que interessa
 * é a cor que sai na tela, então a comparação é feita depois de resolver.
 *
 * `vistos` corta ciclo. Ele não deveria existir num arquivo são, e é justamente por isso que ele
 * está aqui: um ciclo acidental viraria estouro de pilha no meio da suíte, longe da causa.
 */
function resolver(mapa, valor, vistos = new Set()) {
  return valor.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (todo, nome, alternativo) => {
    if (vistos.has(nome)) return todo;
    if (!mapa.has(nome)) return alternativo != null ? alternativo.trim() : todo;
    return resolver(mapa, mapa.get(nome), new Set([...vistos, nome]));
  });
}

function resolvidos(css) {
  const mapa = tokensDe(css);
  const fora = new Map();
  for (const [nome, valor] of mapa) fora.set(nome, resolver(mapa, valor));
  return fora;
}

// ─── As duas listas de divergência deliberada ────────────────────────────────

/** Tokens que a biblioteca tem e o shell não. Cada um é trabalho pendente NO SHELL. */
const ADIANTE_DO_SHELL = {
  // ⚠ `--ds-on-accent` ESTAVA aqui, e saiu porque a dívida foi paga: o shell passou a declará-lo, e
  // os cinco `color: #fff` que ele escrevia à mão sobre a cor de destaque viraram
  // `var(--ds-on-accent)`. Quem mandou apagar a entrada foi o teste "divergência declarada que o
  // shell já resolveu reprova" — a primeira vez que ele mordeu, e exatamente para isto que existe.
  // A partir daqui o token é coberto pela comparação de VALOR, que é garantia mais forte.

  // O shell DECLARA `--tuff-gap-*` e não os usa: medindo os literais de `design-components.css` e
  // `vssh-dialogs.css`, 8px aparece 21 vezes e ao lado dele 5, 6, 10, 3, 7 e 14. Isso não é uma
  // escala com exceções, é deriva. A biblioteca promove a escala a semântica para não herdá-la.
  '--ds-gap-xs': 'o shell não promove espaçamento a --ds-*, e seus componentes derivaram para px literal',
  '--ds-gap-sm': 'idem --ds-gap-xs',
  '--ds-gap-md': 'idem --ds-gap-xs',
  '--ds-gap-lg': 'idem --ds-gap-xs',
  '--ds-gap-xl': 'idem --ds-gap-xs',
  '--ds-gap-2xl': 'idem --ds-gap-xs',
};

/** Tokens que o shell tem e a biblioteca deliberadamente não traz. */
const NAO_TRAZIDOS = {
  '--ds-fundo-padrao': 'o papel de parede da área de trabalho — um app nunca desenha a área de trabalho',
  '--ds-statusbar-bg': 'a barra de status do shell, que não existe dentro da janela de um app',
  '--ds-accent-glow': 'resquício de um tema que não existe mais: vale `none` em todo lugar',
  '--ds-bg-glass': 'igual a --ds-bg num sistema que declara --ds-blur: none — um nome que promete '
    + 'vidro onde não há vidro mente para quem ler depois',
};

// ─── Os testes ───────────────────────────────────────────────────────────────

test('cada token da biblioteca vale o MESMO que no shell', seNaoTemShell, () => {
  const nossos = resolvidos(fs.readFileSync(NOSSO, 'utf8'));
  const deles = resolvidos(fs.readFileSync(DO_SHELL, 'utf8'));

  assert.ok(deles.size >= 60,
    `só ${deles.size} tokens lidos de ${DO_SHELL} — o parser parou de enxergar o arquivo do shell`);

  const divergentes = [];
  for (const [nome, valor] of nossos) {
    if (!deles.has(nome)) continue;              // ausência é assunto dos outros dois testes
    if (deles.get(nome) !== valor) {
      divergentes.push(`${nome}: aqui ${valor} · no shell ${deles.get(nome)}`);
    }
  }

  assert.deepEqual(divergentes, [],
    'a paleta da biblioteca divergiu da do shell. Um app com estes tokens vai desenhar uma janela '
    + 'de cor ligeiramente diferente das outras do ambiente — que é o modo de falha mais caro que '
    + 'existe aqui, porque ninguém repara e todo mundo sente. Iguale os valores, ou, se a diferença '
    + 'for deliberada, leve o conserto ao shell.');
});

test('token que o shell tem e a biblioteca não, ou está na lista ou reprova', seNaoTemShell, () => {
  const nossos = resolvidos(fs.readFileSync(NOSSO, 'utf8'));
  const deles = resolvidos(fs.readFileSync(DO_SHELL, 'utf8'));

  const faltando = [...deles.keys()]
    .filter((n) => !nossos.has(n))
    .filter((n) => !(n in NAO_TRAZIDOS));

  assert.deepEqual(faltando, [],
    'o shell ganhou tokens que a biblioteca não tem. Traga-os, ou declare em NAO_TRAZIDOS com o '
    + 'motivo — uma ausência sem motivo escrito é indistinguível de esquecimento.');
});

test('token que a biblioteca tem e o shell não, ou está na lista ou reprova', seNaoTemShell, () => {
  const nossos = resolvidos(fs.readFileSync(NOSSO, 'utf8'));
  const deles = resolvidos(fs.readFileSync(DO_SHELL, 'utf8'));

  const sobrando = [...nossos.keys()]
    .filter((n) => !deles.has(n))
    .filter((n) => !(n in ADIANTE_DO_SHELL));

  assert.deepEqual(sobrando, [],
    'a biblioteca declara tokens que o shell não conhece. Um app que os use vai se parecer com um '
    + 'ambiente que não existe. Declare em ADIANTE_DO_SHELL com o motivo — e a entrada é dívida: '
    + 'ela existe para ser esvaziada levando o token ao shell.');
});

test('divergência declarada que o shell já resolveu reprova', seNaoTemShell, () => {
  // O espelho dos dois testes acima, e ele importa tanto quanto. Uma entrada que sobrevive ao fato
  // que a justificava vira autorização sem dono, e quem ler a lista depois vai supor que alguém
  // pensou no caso — quando o caso já não existe.
  const nossos = resolvidos(fs.readFileSync(NOSSO, 'utf8'));
  const deles = resolvidos(fs.readFileSync(DO_SHELL, 'utf8'));

  const jaEstaNoShell = Object.keys(ADIANTE_DO_SHELL).filter((n) => deles.has(n));
  assert.deepEqual(jaEstaNoShell, [],
    'estes tokens já existem no shell: apague a entrada de ADIANTE_DO_SHELL — a dívida foi paga, e '
    + 'o teste de valor passa a cobrir o token sozinho');

  const oShellNaoTemMais = Object.keys(NAO_TRAZIDOS).filter((n) => !deles.has(n));
  assert.deepEqual(oShellNaoTemMais, [],
    'estes tokens não existem mais no shell: apague a entrada de NAO_TRAZIDOS, que dispensa algo '
    + 'que já não há');

  const trazidoAfinal = Object.keys(NAO_TRAZIDOS).filter((n) => nossos.has(n));
  assert.deepEqual(trazidoAfinal, [],
    'estes tokens estão declarados como "não trazidos" e a biblioteca os traz');
});

// ─── O que NÃO depende do repositório irmão ──────────────────────────────────

test('os arquivos de fonte que o CSS pede existem em disco', () => {
  // Um `src:` apontando para arquivo ausente não dá erro em lugar nenhum: o navegador cai na pilha
  // do sistema e a página continua funcionando, só que estrangeira. É o defeito que a fonte
  // embarcada existe para impedir, e ele seria invisível a qualquer teste que não olhasse o disco.
  const css = fs.readFileSync(NOSSO, 'utf8');
  const pedidos = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].trim().replace(/['"]/g, ''));

  assert.ok(pedidos.length >= 2,
    `só ${pedidos.length} url() no CSS de tokens — os dois subconjuntos da fonte sumiram`);

  const ausentes = pedidos.filter((u) => !fs.existsSync(path.join(path.dirname(NOSSO), u)));
  assert.deepEqual(ausentes, [],
    'o CSS pede arquivos de fonte que não existem: o navegador cai na fonte do sistema sem erro '
    + 'nenhum, e a janela fica estrangeira ao lado das outras do ambiente');

  // Relativa, e não absoluta. Um app instalado vive sob `/<serverId>/proxy/app/<id>/`, e uma URL
  // começando em `/` sairia do prefixo: 404 em produção, certo em dev. O sintoma seria só a fonte
  // errada — de novo, sem erro na tela.
  const absolutas = pedidos.filter((u) => u.startsWith('/') || /^https?:/.test(u));
  assert.deepEqual(absolutas, [],
    'URL de fonte absoluta: ela resolve fora do prefixo do proxy e dá 404 em todo app instalado');
});
