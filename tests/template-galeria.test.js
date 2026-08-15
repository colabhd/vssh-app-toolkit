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
  // `div`, `a` e `code` entraram quando as peças deixaram de ser todas "um botão e um `<pre>`": a
  // zona de soltura e a alça de arraste são divs, o link que prova o desvio de `target="_blank"` é
  // uma âncora sem handler, e o tipo MIME é escrito num `<code>`. Sem eles aqui, um id renomeado
  // nessas peças voltaria a ser um elemento mudo que nada acusa.
  const noHtml = new Set([...idsDoHtml('button'), ...idsDoHtml('pre'), ...idsDoHtml('section'),
                          ...idsDoHtml('div'), ...idsDoHtml('a'), ...idsDoHtml('code')]);
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
  const lista = SERVER.match(/injectScripts:\s*\[([\s\S]*?)\],/)?.[1];
  assert.ok(lista, 'não achei mais o injectScripts — o teste ficou obsoleto');

  // O erro clássico, e o mais caro de descobrir: a tag injetada aponta para um arquivo que
  // ninguém serve. A página carrega inteira, `vssh` simplesmente não existe, e não há erro
  // nenhum ligando uma coisa à outra.
  //
  // Desde a v4 as libs de navegador vêm do `node_modules` — fora da raiz do frontend por
  // construção —, então "existe sob frontend/" deixou de ser a pergunta certa. A pergunta é se
  // cada src cai numa das duas coisas que o static-spa serve: a raiz, ou um `mounts`.
  const prefixo = SERVER.match(/mounts:\s*\{\s*'([^']+)':\s*WEB_DIR\s*\}/)?.[1];
  assert.ok(prefixo, 'o backend não monta mais o WEB_DIR: as libs de navegador viram 404 silencioso');

  const { WEB_DIR, SHIMS } = require('../lib/node/web-assets');
  assert.ok(new RegExp(`SHIMS\\.map\\(\\(s\\) => \`${prefixo.slice(1)}\\$\\{s\\}\``).test(lista),
    `o injectScripts não aponta mais os SHIMS para o prefixo montado ('${prefixo}')`);
  for (const s of SHIMS) {
    assert.ok(fs.existsSync(path.join(WEB_DIR, s)),
      `SHIMS declara '${s}', que não existe em lib/web/: a tag injetada vira 404`);
  }

  const iShim = SHIMS.indexOf('vssh-app-shim.js');
  const iFsa = SHIMS.indexOf('fsa-polyfill.js');
  assert.ok(iShim >= 0, 'o shim saiu da injeção — nada da ponte funciona');
  assert.ok(iFsa < 0 || iFsa > iShim,
    'o polyfill de FSA é injetado ANTES do shim: ele depende do `vssh`, e a falha é um showDirectoryPicker que não existe');

  const srcs = [...lista.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const src of srcs) {
    assert.ok(fs.existsSync(path.join(APP, 'frontend', src)),
      `injectScripts aponta para '${src}', que não existe sob frontend/: a tag vira 404 silencioso`);
  }

  // O código do app entra na injeção pelo carimbo: só o que é injetado ganha o hash do conteúdo na
  // URL, e é o carimbo que garante que uma reinstalação não sirva a versão velha de cache nenhum.
  assert.ok(srcs.includes('galeria.js'),
    'galeria.js saiu da injeção: volta a depender de revalidação por Last-Modified, que é o elo fraco de "atualizei o app e nada mudou"');
  assert.ok(!/<script[^>]+galeria\.js/.test(HTML),
    'galeria.js está injetado E com tag no HTML: ele seria carregado duas vezes, e a segunda sem carimbo');
});

test('o que o backend IMPORTA do toolkit, ele CHAMA', () => {
  // O defeito que esta guarda existe para impedir, e que já aconteceu: `keepLiveAlive` e
  // `clearLiveOnExit` importados na linha 32, com o comentário da rota afirmando *"`keepLiveAlive()`
  // uma vez"* como decisão de desenho — e nenhuma chamada no arquivo inteiro. Não aparecia porque a
  // tarefa de exemplo durava 6,4 s contra um TTL de 60 s: o único caso em que a ausência morde é o
  // que a demonstração não exercitava.
  //
  // Num template, isto é pior que um import morto qualquer. Ele é o arquivo de onde todo app novo
  // nasce, e o comentário sobrevive à cópia — então o defeito se propaga como se fosse a prática
  // recomendada, com a assinatura de quem parece ter pensado no assunto.
  const importados = [...SERVER.matchAll(/const \{([^}]+)\} = require\('vssh-app-toolkit\/[^']+'\)/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter(Boolean);
  assert.ok(importados.length >= 7, 'o backend parou de importar as libs — o teste ficou obsoleto');

  for (const nome of importados) {
    // MAIÚSCULAS é a convenção de VALOR neste repositório (`WEB_DIR`, `SHIMS`): eles se usam por
    // referência, e exigir `NOME(` deles acusaria um uso correto. Para o resto, o que se mede é a
    // CHAMADA — um `require` que só aparece no próprio `require` não faz nada por ninguém.
    const ehValor = nome === nome.toUpperCase();
    const usos = SERVER.match(new RegExp(ehValor ? `\\b${nome}\\b` : `\\b${nome}\\s*\\(`, 'g')) || [];
    assert.ok(usos.length >= 1 && (!ehValor || usos.length > 1),
      `o backend importa '${nome}' do toolkit e nunca o ${ehValor ? 'usa' : 'chama'}: ` +
      'o template ensinaria pelo import uma coisa que o código não faz');
  }
});

test('toda rota que a galeria chama existe no backend', () => {
  const chamadas = new Set([
    ...[...JS.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]),
    ...[...JS.matchAll(/EventSource\('([^']+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(chamadas.size >= 4, 'a galeria parou de chamar o próprio backend — o teste ficou obsoleto');

  for (const chamada of chamadas) {
    // URL relativa, sempre: com barra no começo o app pediria à raiz do portal, não a si mesmo.
    assert.ok(!chamada.startsWith('/'),
      `'${chamada}' começa com barra: sob /<serverId>/proxy/app/<id>/ isso aponta para o portal, não para o app`);
    // O que o backend compara é o `pathname`; a query é parâmetro daquela mesma rota. Sem separar,
    // uma chamada legítima (`api/tarefa-longa?lento=1`) reprovava contra o `if` que a atende.
    const rota = chamada.split('?')[0];
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
  // `_porQueVaapiFalhou` e `_oQueAPlacaSabe` são injetados: eles moram fora do recorte, e sem eles
  // o corpo estoura com ReferenceError — que o teste leria como "o benchmark quebrou" em vez de
  // "o recorte não trouxe os vizinhos".
  const fn = new Function('require', 'process', 'gpuDoServidor', '_porQueVaapiFalhou',
    '_oQueAPlacaSabe', `${corpo}\nreturn benchmarkGpu;`)(
    (m) => (m === 'node:child_process' ? { execFileSync: execFake } : require(m)),
    { hrtime: process.hrtime, env: {} },
    () => gpuFake,
    (s) => (s ? 'diagnóstico de mentira' : null),
    () => ({ tem: false, motivo: 'vainfo de mentira' }),
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

test('o stderr do ffmpeg é CAPTURADO — sem ele o erro não dá o que procurar', () => {
  // Num servidor de verdade a mensagem foi: "Command failed: ffmpeg -hide_banner …". A linha de
  // comando truncada, e nenhuma palavra sobre o que houve. A causa era `stdio: 'ignore'`, que
  // descarta o stderr: `err.stderr` vinha nulo e sobrava o `err.message` do Node.
  const i = SERVER.indexOf('function benchmarkGpu');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i));
  // Recortado no `medir`, e não no `benchmarkGpu` inteiro: a sonda `ffmpeg -version` ao lado
  // IGNORA a saída de propósito — ali não há o que ler. Uma guarda que proibisse `stdio: 'ignore'`
  // no bloco todo estaria medindo a vizinhança em vez da decisão.
  const j = corpo.indexOf('const medir =');
  const medir = corpo.slice(j, corpo.indexOf('\n  };', j));
  assert.ok(j > 0, 'não achei o `medir` — o teste ficou obsoleto');
  assert.match(medir, /stdio: \['ignore', 'ignore', 'pipe'\]/,
    'o stderr do ffmpeg voltou a ser descartado: o erro vira a linha de comando, que não diz nada');
  assert.ok(!/stdio: 'ignore'/.test(medir));
  // E sem `-hwaccel vaapi`: aquilo acelera DECODE, e a fonte é gerada pelo próprio ffmpeg. Pedi-lo
  // faz o erro falar do decode em vez do encode que se queria medir.
  assert.ok(!/'-hwaccel'/.test(corpo),
    'o -hwaccel voltou: ele é para decode, e o erro passa a descrever o caminho errado');
});

test('a falha da GPU é CLASSIFICADA — as causas pedem ações opostas', () => {
  const i = SERVER.indexOf('function _porQueVaapiFalhou');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
  const fn = new Function(`${corpo}\nreturn _porQueVaapiFalhou;`)();

  const VIRTUAL = { virtual: true, fabricante: 'virtio', driver: 'virtio-pci' };
  const FISICA  = { virtual: false, fabricante: 'AMD', driver: 'amdgpu' };

  // O caso REAL, medido num servidor: `vaInitialize: 2` numa virtio. A primeira versão hesitava —
  // "instale o driver, SE ela for física" — mesmo com a descoberta já sabendo que é virtual. E aí
  // a pessoa vai procurar pacote para um problema que nenhum pacote resolve.
  const s = 'Failed to initialise VAAPI connection: 2 (resource allocation failed).';
  assert.match(fn(s, VIRTUAL), /NÃO implementa VA-API/);
  assert.match(fn(s, VIRTUAL), /nenhum pacote resolve/,
    'a resposta deixou esperança onde não há — pior que uma resposta ruim');
  assert.match(fn(s, VIRTUAL), /outro servidor/);

  // A MESMA saída numa placa física é outro diagnóstico: aí o pacote É o caminho.
  assert.match(fn(s, FISICA), /driver ausente/);
  assert.ok(!/nenhum pacote resolve/.test(fn(s, FISICA)),
    'mandou desistir numa placa física, onde instalar o driver resolve');

  assert.match(fn("Unknown encoder 'h264_vaapi'", FISICA), /compilado SEM VAAPI/);
  assert.match(fn('Failed to open /dev/dri/renderD128: Permission denied', FISICA), /grupo `render`/);
  assert.match(fn('No usable encoding entrypoint found for profile', VIRTUAL), /GPU VIRTUAL/);
  assert.strictEqual(fn('', VIRTUAL), null, 'inventou diagnóstico a partir de stderr vazio');
  assert.strictEqual(fn('algo que ninguém previu', VIRTUAL), null,
    'classificou o que não conhece: um diagnóstico errado custa mais que nenhum');
  // Sem dispositivo (o caminho do "não sei"), não pode afirmar que é virtual.
  assert.ok(!/VIRTUAL/.test(fn(s, null) || ''), 'afirmou "virtual" sem ter o dispositivo em mãos');
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

// ─── A seção que o template contribui a Configurações ───────────────────────
//
// `contributes.settings` é o mecanismo que faz um app comum poder ter preferências. O template é
// o exemplo que todo mundo copia — então o que ele ENSINA importa tanto quanto o que ele faz.

test('a contribuição do template executa no escopo de quatro nomes que o shell entrega', () => {
  // Um exemplo que precisasse de um quinto nome documentaria uma API que não existe, e só
  // quebraria na máquina de quem instalou o template — o pior lugar para descobrir.
  const fonte = ler('configuracoes.js');
  const registradas = [];
  const SettingsRegistry = { register: (s) => registradas.push(s) };
  const VsshSettings = { get: () => null, set: () => {} };
  const AppLauncher = { open: () => {} };
  const app = { id: 'hello-world-node', name: 'Hello World (Node)', version: '1.3.0' };

  new Function('SettingsRegistry', 'VsshSettings', 'AppLauncher', 'app', fonte)(
    SettingsRegistry, VsshSettings, AppLauncher, app);

  assert.equal(registradas.length, 1, 'o exemplo deixou de registrar exatamente uma seção');
  const s = registradas[0];
  assert.equal(s.familia, 'apps');
  assert.ok(s.grupos?.[0]?.linhas?.length, 'a seção do exemplo ficou sem linhas');
});

test('a chave do exemplo é derivada do id, e não escrita à mão', () => {
  // Copiar o template e trocar o id é o primeiro passo de todo mundo. Uma chave literal faria o
  // app novo gravar no espaço do hello-world, e os dois se sobrescreveriam sem nada avisar.
  const fonte = ler('configuracoes.js');
  assert.match(fonte, /chave: `appSettings\.\$\{app\.id\}\./,
    'o exemplo passou a escrever o id à mão — quem copiar o template grava no espaço alheio');
  // E não pode voltar a mandar registrar chave no portal: `appSettings` é mapa aberto justamente
  // para que publicar um app não exija um commit no vssh-sso.
  assert.doesNotMatch(fonte, /ALLOWED_KEYS/,
    'o exemplo voltou a mandar o autor registrar a chave no portal, que é o que appSettings evita');
});

test('o manifesto do template declara a contribuição', () => {
  const m = JSON.parse(ler('vssh-app.json'));
  assert.equal(m.contributes?.settings, 'configuracoes.js',
    'sem a declaração no manifesto o arquivo nunca é carregado, e o exemplo vira código morto');
});
