// A galeria do `hello-vssh-app-node` — as junções que ninguém vê quebrar.
//
// Este template é duas coisas ao mesmo tempo: o ponto de partida de um app novo E a galeria que se
// instala num servidor para conferir, à mão, se o ambiente faz o que a documentação diz. Por isso
// ele é o único lugar do repositório onde uma peça pode apodrecer sem que nada acuse: marcação,
// comportamento e rotas moram em três arquivos, e um `id` renomeado num deles não é erro em
// lugar nenhum — é um botão que não faz nada, ou uma peça que nunca escreve resposta.
//
// "Botão que não faz nada" não é detalhe cosmético neste projeto: é o defeito que a Onda 2.1
// removeu da taskbar do shell, com o argumento de que um controle que não morde é pior que a
// ausência dele, porque ensina a pessoa a não confiar em controle nenhum. Uma galeria com uma peça
// morta mente sobre o ambiente — que é justamente o que ela existe para medir.
//
// O que este arquivo NÃO faz: julgar se a peça funciona. Isso é do servidor de verdade e das mãos
// de quem instala. Aqui se mede só que os três lados falam do mesmo.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'templates', 'hello-vssh-app-node');
const ler = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const HTML = ler('frontend/index.html');
const JS = ler('frontend/galeria.js');
const SERVER = ler('backend/server.js');

/** Os ids que o HTML declara, por tipo de elemento. */
function idsDoHtml(tag) {
  return [...HTML.matchAll(new RegExp(`<${tag}[^>]*\\sid="([^"]+)"`, 'g'))].map((m) => m[1]);
}

/** Os ids que o comportamento procura, via o `$()` do arquivo. */
const idsDoJs = new Set([...JS.matchAll(/\$\('([^']+)'\)|escrever\('([^']+)'|falhar\('([^']+)'/g)]
  .map((m) => m[1] || m[2] || m[3]));

test('todo id que a galeria procura existe na marcação', () => {
  const noHtml = new Set([...idsDoHtml('button'), ...idsDoHtml('pre'), ...idsDoHtml('section')]);
  for (const id of idsDoJs) {
    assert.ok(noHtml.has(id),
      `galeria.js procura '#${id}' e a marcação não tem: a peça fica muda, sem erro nenhum`);
  }
});

test('todo botão da marcação é ligado a alguma coisa', () => {
  for (const id of idsDoHtml('button')) {
    assert.ok(idsDoJs.has(id),
      `o botão '#${id}' não é ligado por galeria.js — botão que não faz nada ensina a não clicar em botão nenhum`);
  }
});

test('toda peça tem onde escrever a resposta', () => {
  // Um `<pre>` sem ninguém que escreva nele fica no travessão para sempre, e quem instalou conclui
  // que a capacidade não existe naquele servidor.
  for (const id of idsDoHtml('pre')) {
    assert.ok(idsDoJs.has(id), `o '#${id}' nunca recebe texto: a peça parece quebrada no ambiente`);
  }
});

test('o que o backend injeta existe em disco, e a ordem importa', () => {
  const lista = SERVER.match(/injectScripts:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(lista, 'não achei mais o injectScripts — o teste ficou obsoleto');
  const srcs = [...lista.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // O erro clássico, e o mais caro de descobrir: a lib vendorizada fora da raiz do frontend. A
  // página carrega, a tag aponta para um 404 e `vssh` simplesmente não existe — sem erro nenhum
  // que ligue uma coisa à outra.
  for (const src of srcs) {
    assert.ok(fs.existsSync(path.join(APP, 'frontend', src)),
      `injectScripts aponta para '${src}', que não existe sob frontend/: a tag vira 404 silencioso`);
  }

  const iShim = srcs.findIndex((s) => s.endsWith('vssh-app-shim.js'));
  const iFsa = srcs.findIndex((s) => s.endsWith('fsa-polyfill.js'));
  assert.ok(iShim >= 0, 'o shim saiu da injeção — nada da ponte funciona');
  assert.ok(iFsa < 0 || iFsa > iShim,
    'o polyfill de FSA é injetado ANTES do shim: ele depende do `vssh`, e a falha é um showDirectoryPicker que não existe');

  // O código do app entra na injeção pelo carimbo: só o que é injetado ganha o hash do conteúdo na
  // URL, e é o carimbo que garante que uma reinstalação não sirva a versão velha de cache nenhum.
  assert.ok(srcs.includes('galeria.js'),
    'galeria.js saiu da injeção: volta a depender de revalidação por Last-Modified, que é o elo fraco de "atualizei o app e nada mudou"');
  assert.ok(!/<script[^>]+galeria\.js/.test(HTML),
    'galeria.js está injetado E com tag no HTML: ele seria carregado duas vezes, e a segunda sem carimbo');
});

test('toda rota que a galeria chama existe no backend', () => {
  const chamadas = new Set([
    ...[...JS.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]),
    ...[...JS.matchAll(/EventSource\('([^']+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(chamadas.size >= 4, 'a galeria parou de chamar o próprio backend — o teste ficou obsoleto');

  for (const rota of chamadas) {
    // URL relativa, sempre: com barra no começo o app pediria à raiz do portal, não a si mesmo.
    assert.ok(!rota.startsWith('/'),
      `'${rota}' começa com barra: sob /<serverId>/proxy/app/<id>/ isso aponta para o portal, não para o app`);
    assert.ok(SERVER.includes(`'/${rota}'`),
      `a galeria chama '${rota}' e o backend não atende esse caminho`);
  }
});

test('a janela extra abre a rota que o próprio app sabe atender', () => {
  // A junção mais fácil de quebrar sem sinal: o botão pede uma rota, e é o MESMO arquivo que
  // decide o que fazer com ela. Renomeie um dos dois e a janela extra abre… a galeria inteira de
  // novo. Nada falha, nada avisa, e a demonstração passa a provar o contrário do que afirma —
  // porque uma cópia é exatamente o que ela existe para NÃO ser.
  const pedido = JS.match(/vssh\.window\.abrir\('\?([a-z]+)=/)?.[1];
  assert.ok(pedido, 'ninguém mais pede a janela extra — o botão perdeu o que demonstrar');
  assert.match(JS, new RegExp(`URLSearchParams\\(location\\.search\\)\\.has\\('${pedido}'\\)`),
    `a galeria pede '?${pedido}=' e não trata esse parâmetro: a janela extra abriria uma cópia`);

  // E o painel tem de ser OUTRA coisa: se ele montasse a galeria, o parâmetro seria decorativo.
  assert.match(JS, /return montarPainel\(\)/);
  assert.match(JS, /function montarPainel\(\)/);
});

test('a demonstração de duas janelas prova o que diz: um backend só', () => {
  // O contador vive no processo e a mudança é DIFUNDIDA para todos os streams abertos. Sem a
  // difusão, cada janela veria só o próprio clique — e a peça provaria o contrário do que afirma.
  assert.match(SERVER, /const conexoes = new Set\(\)/);
  assert.match(SERVER, /const difundir = \(\) => \{ for \(const s of conexoes\) s\.send\('estado'/,
    'a mudança de estado não é difundida: a segunda janela nunca ficaria sabendo');
  assert.match(SERVER, /conexoes\.delete\(stream\)/,
    'o stream fechado não sai do conjunto: o número de janelas conectadas só subiria');
  assert.match(JS, /src\.addEventListener\('estado'/,
    'a galeria não escuta o evento difundido — a peça mostraria só o próprio clique');
});
