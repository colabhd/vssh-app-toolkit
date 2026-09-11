// A galeria do `hello-vssh-app-node` — as junções que ninguém vê quebrar.
//
// Este template é duas coisas ao mesmo tempo: o ponto de partida de um app novo E a galeria que se
// instala num servidor para conferir, à mão, se o ambiente faz o que a documentação diz. Por isso
// ele é o único lugar do repositório onde uma peça pode apodrecer sem que nada acuse: marcação,
// comportamento e rotas moram em três arquivos, e um `id` renomeado num deles não é erro em
// lugar nenhum — é um botão que não faz nada, ou uma peça que nunca escreve resposta.
//
// "Botão que não faz nada" não é detalhe cosmético neste projeto: é o defeito que se
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

// Comentário de HTML fora antes de qualquer contagem: a marcação desta galeria é metade prosa, e
// um trecho de exemplo dentro de `<!-- -->` viraria um id que ninguém declarou.
const SEM_COMENTARIOS = HTML.replace(/<!--[\s\S]*?-->/g, '');

/** Os ids que o HTML declara, por tipo de elemento. */
function idsDoHtml(tag) {
  return [...SEM_COMENTARIOS.matchAll(new RegExp(`<${tag}[^>]*\\sid="([^"]+)"`, 'g'))].map((m) => m[1]);
}

/**
 * Todo id da marcação, seja qual for a tag.
 *
 * ⚠ Aqui havia uma LISTA de tags (`button`, `pre`, `section`, `div`, `a`, `code`), e ela era uma
 * armadilha de dois gumes. Um id declarado em qualquer outra tag — `input`, `select`, `label`,
 * `video`, `canvas`, `details` — **escapava da conferência em silêncio**, que é o oposto do que
 * este arquivo existe para fazer. E, do outro lado, o primeiro `<input id="x">` que a galeria
 * ganhasse faria o teste abaixo REPROVAR dizendo que a marcação não tem o id — quando ela tem, e
 * quem não enxergava era a lista.
 *
 * A lista crescia a cada peça de tipo novo (o comentário que estava aqui contava a rodada em que
 * `div`, `a` e `code` entraram). Perguntar "tem id?" não cresce nunca.
 */
function todosOsIds() {
  return [...SEM_COMENTARIOS.matchAll(/<[a-z][\w-]*\b[^>]*\sid="([^"]+)"/gi)].map((m) => m[1]);
}

/** Os ids que o comportamento procura, via o `$()` do arquivo. */
const idsDoJs = new Set([...JS.matchAll(/\$\('([^']+)'\)|escrever\('([^']+)'|falhar\('([^']+)'/g)]
  .map((m) => m[1] || m[2] || m[3]));

test('todo id que a galeria procura existe na marcação', () => {
  // Qualquer elemento com id serve — ver `todosOsIds()` sobre por que a lista de tags saiu.
  const noHtml = new Set(todosOsIds());
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
});

// A demonstração de "um backend, N janelas" NÃO é medida aqui, e isso é escolha.
//
// A afirmação dela — quem clica não é quem escuta — só existe com dois clientes conectados ao mesmo
// processo, e é exatamente o que o smoke do `ci.yml` faz: abre um SSE, faz o POST por fora, e cobra
// que o contador chegou a quem não clicou. Havia aqui quatro `assert.match` citando as linhas do
// `server.js` que implementam isso (`const conexoes = new Set()`, o corpo do `difundir`, o
// `conexoes.delete`). Elas ficavam vermelhas quando alguém reescrevia a difusão preservando o
// comportamento, e verdes se a difusão parasse de funcionar por qualquer outra razão — que é o
// avesso do que se queria saber.

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

function comBenchmark(execFake, gpuFake, hrtime = process.hrtime) {
  const i = SERVER.indexOf('function benchmarkGpu');
  assert.ok(i > 0, 'não achei benchmarkGpu — o teste ficou obsoleto');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
  // `_porQueVaapiFalhou` e `_oQueAPlacaSabe` são injetados: eles moram fora do recorte, e sem eles
  // o corpo estoura com ReferenceError — que o teste leria como "o benchmark quebrou" em vez de
  // "o recorte não trouxe os vizinhos".
  const fn = new Function('require', 'process', 'gpuDoServidor', '_porQueVaapiFalhou',
    '_oQueAPlacaSabe', `${corpo}\nreturn benchmarkGpu;`)(
    (m) => (m === 'node:child_process' ? { execFileSync: execFake } : require(m)),
    { hrtime, env: {} },
    () => gpuFake,
    (s) => (s ? 'diagnóstico de mentira' : null),
    () => ({ tem: false, motivo: 'vainfo de mentira' }),
  );
  return fn();
}

const COM_PLACA = { dispositivos: [{ acesso: 'ok', renderNode: '/dev/dri/renderD128', video: 'vaapi' }] };
const COM_NVIDIA = { dispositivos: [{ acesso: 'ok', renderNode: '/dev/dri/renderD128',
                                      fabricante: 'NVIDIA', driver: 'nvidia', video: 'nvenc' }] };

/** A `gpuDoServidor` de verdade, contra uma `/sys/class/drm` + `/dev/dri` de mentira com UMA placa. */
function descobrir(vendor, driver) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const raiz = mkdtempSync(path.join(tmpdir(), 'vssh-gpu-'));
  const disp = path.join(raiz, 'sys', 'card0', 'device');
  mkdirSync(path.join(disp, 'drm', 'renderD128'), { recursive: true });
  mkdirSync(path.join(raiz, 'dev'));
  writeFileSync(path.join(disp, 'vendor'), `${vendor}\n`);
  writeFileSync(path.join(disp, 'uevent'), `DRIVER=${driver}\n`);
  writeFileSync(path.join(raiz, 'dev', 'renderD128'), '');

  const i = SERVER.indexOf('function gpuDoServidor');
  assert.ok(i > 0, 'não achei gpuDoServidor — o teste ficou obsoleto');
  const corpo = SERVER.slice(i, SERVER.indexOf('\n}\n', i) + 2);
  const fn = new Function('require', 'process', 'path', `${corpo}\nreturn gpuDoServidor;`)(
    require, { env: { VSSH_GPU_SYSFS: path.join(raiz, 'sys'), VSSH_GPU_DEV: path.join(raiz, 'dev') } }, path);
  try { return fn(); } finally { rmSync(raiz, { recursive: true, force: true }); }
}

test('o caminho de codificação sai do DRIVER — e NVIDIA é NVENC, não VA-API', () => {
  // Medido num servidor de verdade: NVIDIA, `vainfo` instalado, libva respondendo a versão — e
  // `h264_vaapi` morrendo em "Failed to initialise VAAPI connection". O driver proprietário não
  // fala VA-API; ele codifica por NVENC.
  assert.strictEqual(descobrir('0x10de', 'nvidia').dispositivos[0].video, 'nvenc');
  assert.strictEqual(descobrir('0x1002', 'amdgpu').dispositivos[0].video, 'vaapi');
  assert.strictEqual(descobrir('0x8086', 'i915').dispositivos[0].video, 'vaapi');
  // Virtual não codifica por caminho nenhum, e driver fora da tabela é "não sei": os dois são
  // `null`, e não um chute que mande o benchmark tentar.
  assert.strictEqual(descobrir('0x1af4', 'virtio_gpu').dispositivos[0].video, null);
  assert.strictEqual(descobrir('0x10de', 'nouveau').dispositivos[0].video, null);
});

test('numa NVIDIA o benchmark codifica por NVENC, sem render node e sem tentar VA-API', () => {
  // O servidor de verdade: `renderD128` presente, e o benchmark antigo tentava `h264_vaapi` ali —
  // falhava, e o diagnóstico mandava instalar o driver que já estava instalado.
  const chamadas = [];
  const r = comBenchmark((bin, args) => { chamadas.push(args); return ''; }, COM_NVIDIA);
  assert.strictEqual(r.video, 'nvenc');
  assert.ok(r.gpu.ok, 'o lado da GPU não rodou');
  const gpu = chamadas.find((a) => a.includes('h264_nvenc'));
  assert.ok(gpu, 'não codificou por NVENC');
  assert.ok(!gpu.includes('-vaapi_device'), 'NVENC não passa pelo render node');
  assert.ok(!gpu.some((a) => /hwupload/.test(a)), 'hwupload é do VA-API; no NVENC o encoder sobe o quadro');
  assert.ok(!chamadas.some((a) => a.includes('h264_vaapi')), 'tentou VA-API numa NVIDIA');
});

test('placa virtual não chega ao ffmpeg — tentar VA-API nela é o que dizia "driver ausente"', () => {
  const chamadas = [];
  const r = comBenchmark((bin, args) => { chamadas.push(args); return ''; },
    { dispositivos: [{ acesso: 'ok', renderNode: '/dev/dri/renderD128',
                       fabricante: 'virtio', driver: 'virtio_gpu', virtual: true, video: null }] });
  assert.strictEqual(r.gpu.ok, false);
  assert.match(r.gpu.erro, /VIRTUAL/);
  assert.ok(!chamadas.some((a) => a.includes('h264_vaapi') || a.includes('h264_nvenc')));
});

/**
 * O benchmark com relógio e processador FALSOS: nada roda, e cada lado é um perfil.
 *
 * `lados[rotulo] = [partida_ms, ms_por_quadro, nucleos]` — o que um ffmpeg daquele lado custaria:
 * um fixo por execução, um por quadro, e quantos núcleos ele ocupa enquanto roda. O relógio é
 * avançado pelo próprio `execFileSync` de mentira, que também devolve a linha do `time` do bash
 * com o processador gasto. O que se mede é a ARITMÉTICA do benchmark, sem placa e sem ffmpeg.
 */
function benchmarkDeMentira(lados, gpuFake = COM_NVIDIA) {
  let parede = 0n;
  const hrtime = { bigint: () => parede };
  return comBenchmark((bin, args) => {
    if (args[0] === '-version') return '';
    const lado = args.some((a) => /nvenc|vaapi/.test(a)) ? 'gpu' : 'cpu';
    const duracao = Number(/duration=([\d.]+)/.exec(args.join(' '))[1]);
    const [partida, porQuadro, nucleos] = lados[lado];
    const ms = partida + porQuadro * duracao * 30;
    parede += BigInt(Math.round(ms * 1e6));
    return `vssh-cpu ${((ms * nucleos) / 1000).toFixed(3)} 0.000\n`;
  }, gpuFake, hrtime);
}

test('a partida é descontada e o fps é o do REGIME', () => {
  // O servidor de verdade: RTX A5500 ao lado de um Ryzen de 16 núcleos. Em 300 quadros o NVENC deu
  // 366 fps contra 507 da CPU — e a média escondia que 450 ms eram partida (contexto CUDA + sessão
  // de encode), pagos UMA vez por transcode. Descontada a partida, a placa faz 1250 fps em regime.
  const r = benchmarkDeMentira({ cpu: [30, 2.0, 16], gpu: [450, 0.8, 1] });
  assert.strictEqual(r.rodou, true);
  assert.ok(r.cpu.ok && r.gpu.ok, 'algum dos lados não rodou');
  assert.strictEqual(r.cpu.fps, 500);
  assert.strictEqual(r.gpu.fps, 1250, 'o fps reportado ainda carrega a partida');
  assert.ok(Math.abs(r.gpu.partida - 450) <= 5, `partida veio ${r.gpu.partida}`);
  assert.ok(r.ganho > 2, `esperava a GPU bem mais rápida em regime, veio ${r.ganho}`);
  assert.ok(r.economia > 10, `16 núcleos contra um: a economia de processador sumiu (${r.economia})`);
  assert.match(r.leitura, /mais rápida/);
  assert.ok(!/virtual/.test(r.leitura));
});

test('placa FÍSICA mais lenta em parede mas poupando processador NÃO é chamada de virtual', () => {
  // Uma placa modesta ao lado de uma CPU enorme: em parede perde, em processador ganha de longe —
  // e é o processador que o desktop de quem está trabalhando está usando. Foi esta frase, solta
  // para qualquer razão baixa, que chamou uma RTX A5500 de "placa virtual".
  const r = benchmarkDeMentira({ cpu: [30, 2.0, 16], gpu: [450, 3.0, 1] });
  assert.ok(r.ganho < 0.8, `esperava a GPU mais lenta em parede, veio ${r.ganho}`);
  assert.ok(r.economia > 3);
  assert.ok(!/virtual/.test(r.leitura), 'chamou uma placa física de virtual');
  assert.match(r.leitura, /núcleos/);
  assert.match(r.leitura, /menos processador/);
});

test('placa lenta que também não poupa processador não compensa — e é dito sem rótulo', () => {
  const r = benchmarkDeMentira({ cpu: [30, 2.0, 4], gpu: [100, 4.0, 4] });
  assert.ok(r.ganho < 0.8);
  assert.match(r.leitura, /não compensa/);
  assert.ok(!/virtual/.test(r.leitura));
});

test('o stderr do ffmpeg é CAPTURADO — sem ele o erro não dá o que procurar', () => {
  // Num servidor de verdade a mensagem foi: "Command failed: ffmpeg -hide_banner …". A linha de
  // comando truncada, e nenhuma palavra sobre o que houve. A causa era `stdio: 'ignore'`, que
  // descarta o stderr: `err.stderr` vinha nulo e sobrava o `err.message` do Node.
  //
  // Medido EXECUTANDO: um ffmpeg de mentira que falha com stderr e com a mensagem do Node, e o que
  // se confere é qual dos dois chegou ao erro reportado.
  const r = comBenchmark((bin, args) => {
    if (args[0] === '-version') return '';
    if (args.includes('h264_vaapi')) {
      const e = new Error('Command failed: bash -c … ffmpeg -hide_banner -loglevel error …');
      e.stderr = Buffer.from('[AVHWDeviceContext] Failed to initialise VAAPI connection: -1.\n');
      throw e;
    }
    return '';
  }, COM_PLACA);
  assert.strictEqual(r.gpu.ok, false);
  assert.match(r.gpu.erro, /Failed to initialise VAAPI/, 'o que o ffmpeg disse não chegou ao erro');
  assert.ok(!/Command failed/.test(r.gpu.erro), 'o erro é a linha de comando do Node, que não diz nada');

  // E sem `-hwaccel vaapi`: aquilo acelera DECODE, e a fonte é gerada pelo próprio ffmpeg. Pedi-lo
  // faz o erro falar do decode em vez do encode que se queria medir.
  const chamadas = [];
  comBenchmark((bin, args) => { chamadas.push(args); return ''; }, COM_PLACA);
  assert.ok(!chamadas.some((a) => a.includes('-hwaccel')),
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

  // ⚠ O caso que motivou tudo isto: NVIDIA de verdade, `vainfo` instalado, libva 1.22 respondendo
  // — e "Failed to initialise VAAPI connection: -1". A resposta antiga era "driver ausente ... o
  // driver NVIDIA", e mandava instalar o que já estava instalado. Não é driver: o proprietário da
  // NVIDIA não fala VA-API, e o caminho é outro.
  const NVIDIA = { virtual: false, fabricante: 'NVIDIA', driver: 'nvidia', video: 'nvenc' };
  const d = fn('Failed to initialise VAAPI connection: -1 (unknown libva error).', NVIDIA);
  assert.match(d, /NVENC/);
  assert.ok(!/driver ausente/.test(d), 'mandou procurar driver onde o driver está instalado');
  // E os erros do PRÓPRIO NVENC, que têm nome e não se confundem com os do VA-API.
  assert.match(fn("Unknown encoder 'h264_nvenc'", NVIDIA), /SEM NVENC/);
  assert.match(fn('Cannot load libnvidia-encode.so.1', NVIDIA), /libnvidia-encode/);
  assert.match(fn('Driver does not support the required nvenc API version. Required: 12.0 Found: 11.1', NVIDIA),
    /atualizar o driver/);
  assert.match(fn('No capable devices found', NVIDIA), /NVENC/);
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
  //
  // Medido RODANDO o arquivo duas vezes com ids diferentes, e não procurando a interpolação no
  // texto: uma chave montada de outro jeito — `'appSettings.' + app.id` — continua correta, e a
  // busca pelo literal a reprovava. O que importa é o valor produzido.
  const chavesDe = (id) => {
    const registradas = [];
    new Function('SettingsRegistry', 'VsshSettings', 'AppLauncher', 'app', ler('configuracoes.js'))(
      { register: (s) => registradas.push(s) },
      { get: () => null, set: () => {} },
      { open: () => {} },
      { id, name: 'App de teste', version: '1.0.0' },
    );
    return registradas
      .flatMap((s) => s.grupos ?? [])
      .flatMap((g) => g.linhas ?? [])
      .map((l) => l.chave)
      .filter(Boolean);
  };

  const doA = chavesDe('app-alfa');
  const doB = chavesDe('app-beta');

  assert.ok(doA.length >= 1, 'o exemplo não declara nenhuma linha com `chave` — não há o que medir');
  assert.deepEqual(doB.length, doA.length, 'o número de chaves mudou com o id, o que não faz sentido');

  for (const [i, chave] of doA.entries()) {
    assert.ok(chave.startsWith('appSettings.'),
      `a chave '${chave}' saiu do espaço 'appSettings.', que é o mapa aberto onde um app grava sem `
      + 'precisar de um commit no portal');
    assert.ok(chave.includes('app-alfa'),
      `a chave '${chave}' não carrega o id do app: quem copiar o template grava no espaço alheio`);
    assert.notEqual(chave, doB[i],
      `a chave '${chave}' é a MESMA para dois ids diferentes — dois apps copiados deste template se `
      + 'sobrescreveriam, sem nada avisar');
  }
});

test('o manifesto do template declara a contribuição', () => {
  const m = JSON.parse(ler('vssh-app.json'));
  assert.equal(m.contributes?.settings, 'configuracoes.js',
    'sem a declaração no manifesto o arquivo nunca é carregado, e o exemplo vira código morto');
});
