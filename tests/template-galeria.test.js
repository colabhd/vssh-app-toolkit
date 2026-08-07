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

  // E a ausência é a outra metade: sem segredo, a peça tem de DIZER o que fazer.
  const vazio = new Function('crypto', 'process', `${corpo}\nreturn segredo;`)(
    require('node:crypto'), { env: {} },
  )();
  assert.equal(vazio.definido, false);
  assert.match(vazio.leitura, /reinicie/i);
});

test('guardado no cofre e ausente do ambiente é o TERCEIRO estado — não "nada guardado"', () => {
  // O caso que pareceu defeito ao testar num servidor: guardar, reabrir a janela, e a peça dizer
  // que não havia nada. Reabrir a janela não reinicia o processo — a janela é uma view, o backend
  // continua o mesmo —, e o ambiente de um processo é fixado no start.
  //
  // Olhando só `process.env`, "nunca guardado" e "guardado depois deste processo subir" dão a
  // MESMA resposta. E a segunda é a única em que a pessoa fez tudo certo, o que a torna a mais
  // cara de diagnosticar: ela conclui que o cofre não funciona.
  const os = require('node:os'); const fsr = require('node:fs'); const p = require('node:path');
  const dir = fsr.mkdtempSync(p.join(os.tmpdir(), 'vssh-seg-'));
  try {
    fsr.mkdirSync(p.join(dir, 'data'));
    fsr.writeFileSync(p.join(dir, 'secrets.json'), JSON.stringify({ HELLO_SEGREDO: 'sk-x' }));
    const i = SERVER.indexOf('function segredo()');
    const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
    const r = new Function('crypto', 'path', 'require', 'process', `${corpo}\nreturn segredo;`)(
      require('node:crypto'), p, require, { env: { VSSH_APP_DATA_DIR: p.join(dir, 'data') } },
    )();
    assert.equal(r.definido, false);
    assert.equal(r.noCofre, true, 'a peça não olha o cofre em disco: o estado do meio some');
    assert.match(r.leitura, /J[ÁA] EST[ÁA] GUARDADO/,
      'a peça diz "nada guardado" para um segredo que ESTÁ guardado — e a pessoa conclui que o cofre falhou');
    // E só as chaves: o valor não pode aparecer em lugar nenhum da resposta.
    assert.ok(!JSON.stringify(r).includes('sk-x'), 'a peça leu o VALOR do cofre em disco');
  } finally { fsr.rmSync(dir, { recursive: true, force: true }); }
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
  // `gpu: true`, e a decisão MUDOU depois de rodar num servidor de verdade.
  //
  // A primeira versão não declarava, para demonstrar o padrão (quem não pede não vê). Só que o
  // padrão se demonstra com uma variável vazia — que é indistinguível de "não há placa" — enquanto
  // o benchmark, que é a peça que responde algo, precisa da placa para rodar. Uma galeria existe
  // para ser EXERCITADA num servidor; escolher a demonstração conceitual sobre a utilizável era
  // preferir a explicação ao experimento.
  //
  // O padrão continua guardado onde ele é mensurável: em gpu-e-cofre.test.js, contra um manifesto
  // que não declara nada.
  assert.strictEqual(mf.gpu, true,
    'o template parou de pedir GPU: o benchmark não teria placa para medir, e a peça volta a ser ' +
    'uma explicação em vez de um experimento');
});

// ─── O benchmark ──────────────────────────────────────────────────────────────
//
// Descobrir não basta: um inventário não diz se a placa serve para alguma coisa. E o número que
// importa não é "180 fps" — é a RAZÃO entre o mesmo trabalho em CPU e em GPU, porque só ela
// responde "vale a pena usar a placa DESTE servidor?".
//
// Medido EXECUTANDO a função com um `child_process` de mentira. Rodar o ffmpeg de verdade aqui
// mediria o ffmpeg; o que se quer medir é a aritmética e, principalmente, o que a função faz
// quando um dos lados falha.

function comBenchmark(execFake, gpuFake) {
  const i = SERVER.indexOf('function benchmarkGpu');
  assert.ok(i > 0, 'não achei benchmarkGpu — o teste ficou obsoleto');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
  const fn = new Function('require', 'process', 'gpuDoServidor', `${corpo}\nreturn benchmarkGpu;`)(
    (m) => (m === 'node:child_process' ? { execFileSync: execFake } : require(m)),
    { hrtime: process.hrtime, env: {} },
    () => gpuFake,
  );
  return fn();
}

const COM_PLACA = { dispositivos: [{ acesso: 'ok', renderNode: '/dev/dri/renderD128' }] };

test('o ganho é a razão entre os dois lados — e é isso que responde a pergunta', () => {
  // 600 ms em CPU contra 200 ms em GPU = 3×. O relógio é o `hrtime` de verdade, então o fake
  // dorme de mentira: o que se mede é a fórmula, não o cronômetro.
  let n = 0;
  const r = comBenchmark((bin, args) => {
    if (args[0] === '-version') return '';
    const alvo = args.includes('h264_vaapi') ? 60 : 180;
    const fim = Date.now() + alvo; while (Date.now() < fim) { n++; }
    return '';
  }, COM_PLACA);
  assert.strictEqual(r.rodou, true);
  assert.ok(r.cpu.ok && r.gpu.ok, 'algum dos lados não rodou');
  assert.ok(r.ganho > 1.5, `esperava a GPU bem mais rápida, veio ${r.ganho}`);
  assert.match(r.leitura, /mais rápida/);
});

test('GPU mais LENTA é dita como tal — é o caso da placa virtual', () => {
  // A resposta mais útil que este benchmark dá. Uma virtio costuma perder para a CPU, e descobrir
  // isso depois de projetar em cima dela custa muito mais que descobrir agora.
  const r = comBenchmark((bin, args) => {
    if (args[0] === '-version') return '';
    const alvo = args.includes('h264_vaapi') ? 180 : 60;
    const fim = Date.now() + alvo; while (Date.now() < fim) { /* espera */ }
    return '';
  }, COM_PLACA);
  assert.ok(r.ganho < 0.8, `esperava a GPU mais lenta, veio ${r.ganho}`);
  assert.match(r.leitura, /MAIS LENTA/);
});

test('um lado que FALHA não vira um número inventado', () => {
  // Calcular a razão com um lado ausente daria um número com cara de medição. Melhor não ter
  // número: `null` é uma resposta, e a mensagem diz qual lado caiu.
  const r = comBenchmark((bin, args) => {
    if (args[0] === '-version') return '';
    if (args.includes('h264_vaapi')) { const e = new Error('vaapi falhou'); e.stderr = Buffer.from('no VAAPI'); throw e; }
    return '';
  }, COM_PLACA);
  assert.strictEqual(r.gpu.ok, false);
  assert.strictEqual(r.ganho, null, 'inventou uma razão com um dos lados caído');
  assert.match(r.leitura, /não codificou/);
});

test('sem render node acessível, o benchmark diz isso em vez de medir a CPU duas vezes', () => {
  const r = comBenchmark((bin, args) => (args[0] === '-version' ? '' : ''),
    { dispositivos: [{ acesso: 'negado', renderNode: '/dev/dri/renderD128' }] });
  assert.strictEqual(r.gpu.ok, false);
  assert.match(r.gpu.erro, /nenhum render node acessível/);
});

test('sem ffmpeg, não roda — e o motivo aponta o requiredPackages', () => {
  const r = comBenchmark(() => { throw new Error('ENOENT'); }, COM_PLACA);
  assert.strictEqual(r.rodou, false);
  assert.match(r.motivo, /requiredPackages/,
    'o motivo não liga a falta do ffmpeg ao mecanismo que deveria tê-la impedido');
});

test('o template DECLARA o ffmpeg — senão o benchmark é uma promessa sem lastro', () => {
  const mf = JSON.parse(ler('vssh-app.json'));
  assert.ok((mf.requiredPackages || []).includes('ffmpeg'),
    'o benchmark usa ffmpeg e o manifesto não o declara: o instalador deixaria passar um servidor ' +
    'onde a peça não funciona');
});
