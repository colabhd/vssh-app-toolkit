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
// `\r\n` → `\n` na leitura. Um checkout Windows (`core.autocrlf=true`, padrão do Git for Windows)
// traz CRLF, e qualquer recorte por `\n}\n` devolve −1 ali: o `slice` vai até o fim do arquivo,
// o `new Function` compila meio repositório e o erro que aparece é sobre um símbolo que não tem
// nada a ver com a peça sendo medida. Verde no CI, indecifrável na máquina de quem escreve.
const ler = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n');

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

// ─── O que o ambiente decidiu por este app ────────────────────────────────────
//
// A peça mais fácil de estragar da galeria, porque estragá-la não quebra nada: bastaria devolver o
// valor do segredo junto com o resto e a demonstração continuaria "funcionando" — só teria virado
// exatamente o hábito que ela existe para ensinar a não ter.

test('o backend NUNCA devolve o valor do segredo', () => {
  // Medido EXECUTANDO a função, e não lendo o texto dela. A primeira versão deste teste procurava
  // um `v` solto no fonte e falhava contra si mesma — o próprio `.replace` que ela usava para
  // ignorar `.length` transformava `tamanho: v.length` em `tamanho: v`, que era exatamente o
  // padrão proibido. Uma guarda que precisa normalizar o fonte antes de olhar está medindo a
  // normalização. A resposta da função não tem essa ambiguidade.
  const i = SERVER.indexOf('function segredo()');
  assert.ok(i > 0, 'não achei a função do segredo — o teste ficou obsoleto');
  // `+2` inclui o `}` que fecha a função — sem ele o corpo fica sem fechamento e o `new Function`
  // devolve um erro de sintaxe que não diz nada sobre o que se queria medir.
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
  const fn = new Function('crypto', 'process', `${corpo}\nreturn segredo;`)(
    require('node:crypto'), { env: { HELLO_SEGREDO: 'sk-nao-pode-vazar-9f8e7d' } });

  const r = fn();
  assert.equal(r.definido, true);
  assert.ok(!JSON.stringify(r).includes('sk-nao-pode-vazar'),
    'o valor do segredo atravessou a rota — é assim que uma credencial vai parar no log de alguém');
  assert.equal(r.tamanho, 'sk-nao-pode-vazar-9f8e7d'.length);
  assert.match(r.sha256, /^[0-9a-f]{12}$/,
    'o prefixo de hash sumiu: sem ele não dá para responder "é o mesmo que eu guardei?"');

  // E a ausência é a outra metade: sem segredo, a peça tem de DIZER o que fazer — inclusive que
  // guardar não basta, porque o ambiente de um processo é fixado no start.
  const vazio = new Function('crypto', 'process', `${corpo}\nreturn segredo;`)(
    require('node:crypto'), { env: {} },
  )();
  assert.equal(vazio.definido, false);
  assert.match(vazio.leitura, /REINICIE/);
});

test('o limite mostrado vem do cgroup, não do manifesto', () => {
  // É a demonstração inteira: o manifesto diz o que se PEDIU, o cgroup diz o que se RECEBEU. Ler o
  // próprio manifesto aqui daria sempre a resposta bonita — inclusive num servidor onde nada foi
  // aplicado, que é justamente o caso que a peça precisa saber mostrar.
  const i = SERVER.indexOf('function limitesDoCgroup()');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i));
  assert.match(corpo, /\/proc\/self\/cgroup/);
  assert.match(corpo, /memory\.max/);
  assert.ok(!/vssh-app\.json|resources/.test(corpo),
    'a peça passou a ler o manifesto: ela mostraria o teto pedido mesmo onde nada foi aplicado');
  // "max" é o valor do kernel para "sem teto", e é texto. Confundi-lo com número faria um app sem
  // limite nenhum aparecer como limitadíssimo.
  assert.match(corpo, /!== 'max'/);
});

test('o manifesto do template declara os três, e o `secrets` sem valor', () => {
  const mf = JSON.parse(ler('vssh-app.json'));
  assert.ok(mf.resources?.memoryMax, 'o template parou de declarar limite — não há o que demonstrar');
  assert.deepEqual(mf.secrets?.map((s) => s.name), ['HELLO_SEGREDO']);
  for (const s of mf.secrets) {
    for (const proibido of ['value', 'valor', 'default']) {
      assert.ok(!(proibido in s), `o template traz o VALOR do segredo no manifesto (${proibido})`);
    }
  }
  // `gpu` fica de FORA de propósito: o que a peça demonstra é o PADRÃO — quem não pede não vê a
  // placa. Um template que declarasse `gpu: true` ensinaria o contrário do que o ambiente decide.
  assert.ok(!('gpu' in mf),
    'o template passou a pedir GPU: a peça deixa de demonstrar o padrão, que é não enxergar');
});
