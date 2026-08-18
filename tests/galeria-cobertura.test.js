'use strict';

// Todo membro do `vssh` aparece em alguma peça da galeria.
//
// ─── Por que este arquivo existe ─────────────────────────────────────────────
//
// `lib/web/test/tipos.test.js` prende o `.d.ts` à superfície real do shim nos dois sentidos, e é
// bom nisso. Mas ele mede a DECLARAÇÃO, e havia um segundo lugar que também envelhece sem sinal: a
// galeria — o app que se instala num servidor para responder *"este ambiente faz isto?"*.
//
// A ausência deste teste foi medida. Quando ele foi escrito, a galeria cobria 23 dos 68 membros da
// superfície, e as QUATRO APIs mais recentes do toolkit (4.9 a 4.12 — jump list, `openUrl`,
// `lembrarRota`, o desvio de `window.open`) não tinham uma peça sequer. Nada estava quebrado: cada
// bump publicou uma capacidade, documentou-a em `docs/api.md`, e ninguém tinha por que reparar que
// a galeria continuava medindo o ambiente de meses atrás.
//
// Uma galeria incompleta não é uma galeria menor — ela mente sobre o ambiente. Quem instala percorre
// as peças, não encontra clipboard, e conclui que o ambiente não tem clipboard. É o mesmo argumento
// que tirou o botão morto da taskbar na Onda 2.1: um controle que não morde ensina a pessoa a não
// confiar em controle nenhum.
//
// ─── O que ele NÃO mede ──────────────────────────────────────────────────────
//
// Se a peça funciona. Isso é do servidor de verdade e das mãos de quem instala. Aqui se mede que a
// capacidade tem onde ser exercitada — e é por isso que a busca é pelo uso REAL (`vssh.fs.copy(`),
// não por menção: um nome dentro de um comentário explicando que a API existe é exatamente o
// estado que este teste existe para reprovar.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { caminhosDaSuperficie } = require('../lib/web/test/_superficie.js');

const TEMPLATES = path.join(__dirname, '..', 'templates');

/**
 * As galerias, descobertas em vez de listadas.
 *
 * Uma lista escrita à mão é mais uma coisa a lembrar de atualizar quando o template Python entrar —
 * e a consequência de esquecer seria este teste passando verde sobre uma galeria que ninguém mede.
 */
function galerias() {
  return fs.readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ nome: d.name, js: path.join(TEMPLATES, d.name, 'frontend', 'galeria.js') }))
    .filter((g) => fs.existsSync(g.js))
    .map((g) => ({ ...g, fonte: fs.readFileSync(g.js, 'utf8').replace(/\r\n/g, '\n') }));
}

// ─── As exceções, e o motivo de cada uma ─────────────────────────────────────
//
// Uma lista de exceções sem motivo escrito é o lugar onde a próxima API vai se esconder. Cada
// entrada aqui responde "por que ISTO não cabe numa galeria?", e a resposta é sempre a mesma
// forma: exercitá-la exigiria um MANIFESTO diferente do que a galeria tem.
const EXCECOES = {
  // `window.richChrome: true` põe uma tabbar de verdade no cabeçalho da janela. Não é um botão a
  // mais: o chrome do portal passa a montar abas a partir do que o app manda, e a janela deixa de
  // ter o cabeçalho comum. Um app não pode ter os dois cabeçalhos, então demonstrar abas custaria
  // a demonstração de todo o resto no cabeçalho padrão.
  'tabs.update': 'exige window.richChrome, que reescreve o cabeçalho do app inteiro',
  'tabs.on': 'exige window.richChrome, que reescreve o cabeçalho do app inteiro',

  // ⚠ A central de mídia exige mídia TOCANDO, e a galeria não toca nada: a atividade só nasce
  // quando o shell acha um `<audio>`/`<video>` vivo. Chamar `transporte()` numa galeria silenciosa
  // declararia uma fila que não existe, e o `aoAgir` receberia uma ação que não teria o que fazer —
  // que é exatamente o botão morto que a API existe para impedir. Quem exercita isto é o Palco.
  'media.transporte': 'exige mídia tocando; a galeria é silenciosa por desenho',
  'media.aoAgir': 'exige mídia tocando; a galeria é silenciosa por desenho',
  'media.agora': 'exige mídia tocando; a galeria é silenciosa por desenho',

  // `window.cabecalho: "app"` é a outra metade da mesma exclusão: o shell PARA de desenhar a barra
  // de título, e o app assume arrastar, duplo-clique e menu de contexto. Um app que declarasse isso
  // e não ligasse os três entregaria uma janela que não se move — e ligá-los aqui esconderia o
  // cabeçalho do ambiente, que é o que as outras peças exercitam.
  'window.arrastar': 'exige window.cabecalho:"app" — o shell deixa de desenhar a barra de título',
  'window.arrastarPara': 'exige window.cabecalho:"app" — o shell deixa de desenhar a barra de título',
  'window.arrastarFim': 'exige window.cabecalho:"app" — o shell deixa de desenhar a barra de título',
  'window.alternarMaximizado': 'exige window.cabecalho:"app" — é o gesto de duplo-clique NA barra do app',
  'window.menuDoCabecalho': 'exige window.cabecalho:"app" — é o menu da barra que o app desenha',

  // Esta é a única exceção que NÃO é sobre manifesto, e por isso ela tem prova própria (abaixo): o
  // caminho recomendado é não chamar nada. O shim observa `document.title` e repassa sozinho, e a
  // galeria exercita exatamente isso — chamar `setTitle` explicitamente ensinaria o caminho pior.
  setTitle: 'o caminho recomendado é `document.title = …`, que o shim espelha sozinho',
};

/** O uso REAL de um caminho da superfície, no idioma que um app escreve. */
function usa(fonte, { caminho, ehFuncao }) {
  const escapado = caminho.replace(/\./g, '\\.');
  // Método: exige o parêntese da CHAMADA — `vssh.fs.copy(`. Valor: a leitura basta.
  return new RegExp(`\\bvssh\\.${escapado}\\s*${ehFuncao ? '\\(' : '\\b'}`).test(fonte);
}

test('cada galeria exercita a superfície inteira do vssh', () => {
  const lista = galerias();
  assert.ok(lista.length >= 1, 'não achei galeria nenhuma sob templates/*/frontend/galeria.js');

  const superficie = caminhosDaSuperficie();
  assert.ok(superficie.length >= 60,
    `só ${superficie.length} membros na superfície — o harness parou de enumerar o shim inteiro`);

  for (const galeria of lista) {
    const faltando = superficie
      .filter((m) => !(m.caminho in EXCECOES))
      .filter((m) => !usa(galeria.fonte, m))
      .map((m) => m.caminho);

    assert.deepEqual(faltando, [],
      `${galeria.nome}: a galeria não exercita estes membros do vssh. Quem instalar a galeria vai ` +
      'concluir que o ambiente não os tem — que é o oposto do que ela existe para dizer. ' +
      'Acrescente a peça, ou declare a exceção com o motivo em EXCECOES.');
  }
});

test('exceção que perdeu a API que a justificava reprova', () => {
  // O espelho do teste acima, e ele importa tanto quanto: uma exceção que sobrevive ao membro que
  // ela dispensava vira autorização sem dono — e a próxima pessoa a ler esta lista vai supor que
  // alguém pensou no caso, quando o caso já não existe.
  const naSuperficie = new Set(caminhosDaSuperficie().map((m) => m.caminho));
  const orfas = Object.keys(EXCECOES).filter((c) => !naSuperficie.has(c));
  assert.deepEqual(orfas, [],
    'estas exceções dispensam membros que o shim não expõe mais: apague-as');
});

test('a exceção do setTitle tem prova: a galeria exercita o espelho de document.title', () => {
  // A única exceção que não é sobre manifesto tem de mostrar que o caminho recomendado É
  // exercitado. Sem isto, ela seria indistinguível de "esquecemos o título".
  for (const galeria of galerias()) {
    assert.match(galeria.fonte, /document\.title\s*=/,
      `${galeria.nome}: `
      + 'a exceção do `setTitle` se apoia no espelho automático de `document.title`, e a galeria não '
      + 'escreve nele em lugar nenhum — então o título não é exercitado por caminho nenhum');
  }
});
