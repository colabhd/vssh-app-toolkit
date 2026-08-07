'use strict';

// Hello World (Node) — template de partida para um vssh-app com backend Node.
//
// Zero dependência npm: só a stdlib do Node e as libs do toolkit vendorizadas em
// `backend/vendor/vssh/` (ressincronize com `vssh-app-lib-sync`). O servidor-alvo pode não ter
// acesso a registry npm num exec não-interativo por SSH, então o que está commitado é o que roda.
//
// O que este template já faz por você, e que a primeira versão de todo app esquece:
//   - log estruturado em $VSSH_APP_DATA_DIR desde a primeira linha (é o que salva a depuração
//     remota: frame minificado sustenta hipótese, log do backend nomeia op e caminho);
//   - checagem do X-Vssh-App-Token, timing-safe;
//   - healthcheck que responde sem depender de nada estar pronto;
//   - um endpoint SSE com os headers que sobrevivem ao proxy e ao CDN.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const { createStaticSpa } = require('./vendor/vssh/node/static-spa');
const { createAppLog } = require('./vendor/vssh/node/app-log');
const { openSseStream } = require('./vendor/vssh/node/sse');

// KeyError proposital se ausente: sem porta não há o que servir, e falhar alto no boot é melhor
// que subir num lugar onde o proxy nunca vai encontrar.
const PORT = Number(process.env.VSSH_APP_PORT);
const APP_ID = process.env.VSSH_APP_ID || 'hello-world-node';
const APP_TOKEN = process.env.VSSH_APP_TOKEN || null;

const log = createAppLog({ appId: APP_ID });

const spa = createStaticSpa({
  root: path.join(__dirname, '..', 'frontend'),

  // A PONTE COM O DESKTOP, em dois passos — esquecer o primeiro é o erro clássico:
  //   1. a lib precisa estar SOB `root`, porque é o navegador que a carrega (por isso ela é
  //      vendorizada em `frontend/vendor/vssh/`, e não junto das libs de backend);
  //   2. `injectScripts` só acrescenta a tag <script> antes do </head> do index — quem SERVE o
  //      arquivo é este mesmo `createStaticSpa`, e ele só serve o que está sob `root`.
  // Com a lib no lugar errado a página carrega normalmente, a tag aponta para 404 e o `vssh`
  // simplesmente não existe — sem erro nenhum que ligue uma coisa à outra.
  // A ORDEM importa: o polyfill de File System Access depende do `vssh` que o shim publica, então
  // ele vem SEMPRE depois. Trocar a ordem não dá erro nenhum — dá um `showDirectoryPicker` que
  // não existe, que é bem pior de descobrir.
  //
  // O polyfill é injetado porque este template é também a GALERIA: a seção "Arquivos do usuário"
  // usa a API padrão do W3C, e é assim que um app real alcança a home. Se o seu app não mexe em
  // arquivo do usuário, tire a segunda linha — ela não custa nada em runtime (o polyfill só age
  // quando alguém chama um seletor), mas o que não se usa não se serve.
  //
  // `galeria.js` — o código DESTE app — entra na mesma lista, e não como uma `<script src>` no
  // index, para ganhar o carimbo de conteúdo na URL: só o que é injetado é carimbado, e o carimbo
  // é o que garante que uma reinstalação não sirva a versão velha de nenhum cache do caminho.
  // Quem tem build (Vite e afins) já recebe um nome com hash e não precisa disto.
  injectScripts: [
    'vendor/vssh/web/vssh-app-shim.js',
    'vendor/vssh/web/fsa-polyfill.js',
    'galeria.js',
  ],

  // Descomente se o seu app usa roteamento HTML5 (History API) em vez de fragmento:
  // spaFallback: true,
  missingBundleHint: 'Rode o build do frontend antes de subir o backend.',
  onWarn: (event) => log('spa-warn', event),
});

// ── Estado do processo, compartilhado por todas as janelas ────────────────────
//
// Um `Set` de streams SSE abertos e um contador. É o menor estado possível que ainda prova o
// modelo: N janelas, UM backend.
const conexoes = new Set();
let contador = 0;
const subiuEm = new Date().toISOString();

const estado = () => ({ contador, conexoes: conexoes.size, subiuEm });
const difundir = () => { for (const s of conexoes) s.send('estado', estado()); };

// ── O que o ambiente decidiu por este processo ────────────────────────────────
//
// Três coisas que o app DECLARA e o ambiente APLICA. As três se leem de dentro do processo, e é
// isso que as torna demonstráveis: o manifesto diz o que se pediu; isto aqui diz o que se recebeu.

/**
 * O teto de memória que está VALENDO, lido do cgroup — não o que o manifesto pediu.
 *
 * A diferença é o ponto da demonstração. O manifesto declara; o `vssh-app-run` traduz para um
 * escopo transitório do systemd; e um servidor sem gerenciador systemd do usuário não aplica nada
 * (`loginctl enable-linger`). Ler o cgroup é a única resposta que não é uma suposição — e quando
 * ela vem vazia, o app está rodando SEM limite, que é uma informação e não um erro.
 */
function limitesDoCgroup() {
  const fs = require('node:fs');
  try {
    // cgroup v2: uma linha só, `0::<caminho relativo à raiz>`.
    const linha = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    if (!linha) return { contido: false, motivo: 'sem cgroup v2 neste servidor' };
    const base = path.join('/sys/fs/cgroup', linha.slice(3).trim());
    const ler = (nome) => {
      try { return fs.readFileSync(path.join(base, nome), 'utf8').trim(); } catch { return null; }
    };
    const memMax = ler('memory.max');
    return {
      // "max" é o valor que o kernel usa para "sem teto" — texto, não número, e confundir os dois
      // faria um app sem limite parecer limitadíssimo.
      contido: !!memMax && memMax !== 'max',
      cgroup: linha.slice(3).trim(),
      memoryMax: memMax, memoryHigh: ler('memory.high'), tasksMax: ler('pids.max'),
      // Quanto o processo está usando AGORA. É o que transforma o teto de número em noção.
      memoryCurrent: ler('memory.current'),
    };
  } catch (err) {
    // Não é Linux, ou o cgroupfs não está montado. "Não sei" é resposta, e diferente de "sem teto".
    return { contido: null, motivo: err.message };
  }
}

/**
 * A GPU, do ponto de vista deste processo.
 *
 * Este template NÃO declara `gpu: true`, e o esperado é justamente isto: `CUDA_VISIBLE_DEVICES`
 * chega como string VAZIA. Não é uma falha — é o padrão do ambiente aparecendo. Quem não pediu a
 * placa não a enxerga, e é isso que deixa um app de inferência conviver com os vizinhos.
 */
/**
 * A GPU deste servidor — o INVENTÁRIO, e não só a variável do CUDA.
 *
 * A primeira versão desta peça mostrava apenas `CUDA_VISIBLE_DEVICES`, e era inútil: o valor
 * `""` (o ambiente escondeu) é indistinguível de "não há placa nenhuma", então a demonstração
 * testava a mesma coisa que não ter. Pior, ela dizia "sem GPU" num servidor com AMD, com Intel ou
 * com placa virtual — porque só sabia perguntar ao `nvidia-smi`.
 *
 * Agora pergunta ao KERNEL, que responde para qualquer fabricante e para placa que nem existe
 * fisicamente: `/sys/class/drm` diz quem é (id do barramento PCI) e qual driver assumiu, e
 * `/dev/dri` diz se este processo consegue abrir. As duas perguntas são diferentes, e a segunda é
 * a que mais trava gente: o dispositivo existe e o usuário não está no grupo `render`.
 *
 * Nada disto precisa de SDK, de driver proprietário ou de pacote instalado.
 */
function gpuDoServidor() {
  const fs = require('node:fs');
  const SYSFS = process.env.VSSH_GPU_SYSFS || '/sys/class/drm';
  const DEV = process.env.VSSH_GPU_DEV || '/dev/dri';
  const FABRICANTES = {
    '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x1022': 'AMD', '0x8086': 'Intel',
    '0x1af4': 'virtio', '0x1234': 'QEMU', '0x15ad': 'VMware', '0x5853': 'Xen', '0x1414': 'Microsoft',
  };
  // Por FABRICANTE primeiro. Um servidor real mostrou uma virtio-gpu reportando
  // `DRIVER=virtio-pci` — o driver do BARRAMENTO, não o do DRM —, e a placa virtual passou por
  // física. O id do fabricante não erra: 0x1af4 é virtio venha o dispositivo pendurado onde vier.
  const VIRT_FAB = new Set(['0x1af4', '0x1234', '0x15ad', '0x5853', '0x1414']);
  const VIRTUAIS = new Set(['virtio_gpu', 'virtio-pci', 'bochs-drm', 'bochs', 'vmwgfx', 'qxl',
                            'vboxvideo', 'simpledrm', 'vgem', 'vkms', 'hyperv_drm']);
  const ler = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

  let cartoes;
  try {
    cartoes = fs.readdirSync(SYSFS).filter((c) => c.startsWith('card') && !c.includes('-')).sort();
  } catch (err) {
    // "Não sei" ≠ "não tem". Um Windows de desenvolvimento cai aqui, e chamar isso de ausência de
    // GPU seria a peça mentindo sobre o servidor.
    return { sei: false, motivo: err.message, dispositivos: [] };
  }

  const dispositivos = cartoes.map((cartao) => {
    const base = path.join(SYSFS, cartao);
    const vendor = ler(path.join(base, 'device', 'vendor'));
    // `uevent` é um arquivo de texto com `DRIVER=amdgpu`; `device/driver` é um symlink de mesmo
    // nome. O arquivo vem primeiro porque é legível em qualquer lugar — e mensurável numa bancada
    // que não pode criar symlinks.
    let driver = null;
    const uevent = ler(path.join(base, 'device', 'uevent'));
    const m = uevent && uevent.split('\n').find((l) => l.startsWith('DRIVER='));
    if (m) driver = m.slice('DRIVER='.length).trim() || null;
    if (!driver) { try { driver = path.basename(fs.realpathSync(path.join(base, 'device', 'driver'))); } catch {} }
    let node = null;
    try {
      const n = fs.readdirSync(path.join(base, 'device', 'drm')).find((x) => x.startsWith('renderD'));
      if (n) node = path.join(DEV, n);
    } catch {}
    let acesso = 'ausente';
    if (node) {
      try { fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK); acesso = 'ok'; }
      catch { acesso = fs.existsSync(node) ? 'negado' : 'ausente'; }
    }
    const v = (vendor || '').toLowerCase();
    const virtual = VIRT_FAB.has(v) ? true : VIRTUAIS.has(driver) ? true : (v || driver) ? false : null;
    return {
      card: cartao, fabricante: FABRICANTES[v] || 'desconhecido',
      vendor, driver, virtual, renderNode: node, acesso,
    };
  });

  const usaveis = dispositivos.filter((d) => d.acesso === 'ok');
  const negados = dispositivos.filter((d) => d.acesso === 'negado');
  return {
    sei: true,
    dispositivos,
    temGpu: usaveis.length > 0,
    // O portão do CUDA continua sendo reportado — mas agora ao LADO do inventário, que é o que
    // torna a variável vazia legível: "escondida do app" deixa de parecer "não existe".
    cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES ?? null,
    resumo: !dispositivos.length ? 'nenhum dispositivo DRM neste servidor'
      : usaveis.length ? usaveis.map((d) => `${d.fabricante} (${d.driver || 'sem driver'}${d.virtual ? ', virtual' : ''})`).join(', ')
      : negados.length ? `${negados.length} dispositivo(s) presentes e SEM ACESSO — falta o grupo 'render' (usermod -aG render <usuario>)`
      : 'dispositivos presentes, sem render node utilizável',
  };
}

/**
 * O segredo do cofre — e **nunca o valor dele**.
 *
 * O que se devolve é: chegou, quantos caracteres tem, e um prefixo de hash que serve para conferir
 * "é o mesmo que eu guardei?" sem que o valor atravesse a rede outra vez. É o hábito que se quer
 * ensinar: um app que ecoa a própria credencial põe a credencial no log de alguém.
 */
function segredo() {
  const v = process.env.HELLO_SEGREDO;

  // O COFRE em disco, lido só pelas CHAVES. Sem isto a peça só sabia olhar `process.env`, e aí
  // "não guardado" e "guardado depois deste processo subir" davam a MESMA resposta — que foi
  // exatamente o que se viu ao testar: guardar, reabrir a janela, e o cartão dizer que não há nada.
  //
  // Reabrir a janela não reinicia o processo: a janela é uma view, o backend continua o mesmo. E o
  // ambiente de um processo é fixado no start — então o valor novo só chega no próximo start. Com
  // as duas fontes a peça distingue os três casos, e o do meio é o que responde "por que não
  // funcionou?".
  //
  // Só as CHAVES. O app já recebe os valores pelo ambiente; reler valores do arquivo não
  // acrescentaria nada e ensinaria o hábito errado a quem copia este template.
  let noCofre = null;
  try {
    const fs = require('node:fs');
    const dados = process.env.VSSH_APP_DATA_DIR;
    if (dados) {
      const j = JSON.parse(fs.readFileSync(path.join(dados, '..', 'secrets.json'), 'utf8'));
      noCofre = Object.keys(j || {});
    }
  } catch { noCofre = null; }   // ausente ou ilegível é "não sei", não "vazio"

  if (!v) {
    const guardadoAgora = Array.isArray(noCofre) && noCofre.includes('HELLO_SEGREDO');
    return {
      definido: false, noCofre: guardadoAgora,
      leitura: guardadoAgora
        ? 'JÁ ESTÁ GUARDADO no cofre — este processo é que subiu antes dele. Reabrir a janela não ' +
          'basta: a janela é uma view, o backend continua o mesmo. Pare e inicie o app (menu de ' +
          'contexto da janela, ou Configurações → Serviços) para ele receber o valor.'
        : 'nada guardado — use o botão "guardar HELLO_SEGREDO" aqui em cima, e depois reinicie o app',
    };
  }
  return {
    definido: true, tamanho: v.length,
    sha256: crypto.createHash('sha256').update(v).digest('hex').slice(0, 12),
    leitura: 'chegou pelo ambiente; o valor não sai daqui',
  };
}

/**
 * O BENCHMARK. Descobrir não basta: um inventário não diz se a placa serve para alguma coisa.
 *
 * **Por que ffmpeg, e não CUDA.** Um benchmark de CUDA só roda onde há CUDA, que é justamente o
 * caso que a versão anterior já cobria e o único. VAAPI atravessa Intel, AMD e NVIDIA, e roda
 * contra o render node do DRM — o mesmo caminho genérico que a descoberta usa. E `ffmpeg` é um
 * pacote, não um SDK: por isso este template o DECLARA em `requiredPackages`, e o ambiente confere
 * antes de instalar. As três metades da Onda 4 se encontram aqui.
 *
 * **O número útil é a RAZÃO.** "180 fps" sozinho não diz nada — depende do vídeo, do preset, da
 * máquina. O mesmo trabalho em CPU e em GPU, medido em seguida, responde a pergunta que se tem de
 * fato: *vale a pena usar a placa deste servidor?* Uma virtio costuma responder que não, e essa é
 * uma resposta boa de ter antes de projetar em cima dela.
 *
 * Timeboxed e não-fatal: um encoder que trava não pode segurar a requisição nem derrubar o app.
 */
/**
 * Traduz o stderr do ffmpeg no motivo, em português, de a GPU não ter codificado.
 *
 * Existe porque as causas pedem ações OPOSTAS e chegam parecidas: uma se conserta instalando um
 * driver, outra dando permissão, e a mais comum não se conserta de jeito nenhum — a placa
 * simplesmente não tem encoder de vídeo, que é o caso de praticamente toda GPU virtual. Sem
 * separá-las, "a GPU não codificou" manda a pessoa caçar driver por horas para descobrir que a
 * resposta era "esta placa não faz isso, e isso é normal".
 */
function _porQueVaapiFalhou(stderr) {
  const s = (stderr || '').toLowerCase();
  if (!s) return null;
  if (s.includes('unknown encoder')) {
    return 'este ffmpeg foi compilado SEM VAAPI — é do pacote, não do servidor nem da placa';
  }
  if (s.includes('permission denied')) {
    return 'sem permissão no render node — falta o grupo `render` (usermod -aG render <usuario>)';
  }
  if (s.includes('entrypoint') || s.includes('not supported') || s.includes('unsupported')) {
    return 'a placa abre, mas NÃO tem motor de codificação de vídeo. É o normal numa GPU virtual: ' +
           'ela serve para desenhar tela, não para computar — e é exatamente o que esta peça ' +
           'existe para descobrir antes de alguém projetar em cima dela';
  }
  if (s.includes('vainitialize') || s.includes('no va display') || s.includes('failed to initialise') ||
      s.includes('failed to create') || s.includes('not implemented')) {
    return 'o VAAPI não inicializou nesta placa — driver ausente, ou uma GPU que não implementa ' +
           'a interface (típico de virtio/bochs). Instalar o pacote do driver do fabricante ' +
           '(mesa-va-drivers, intel-media-va-driver, nvidia) é o caminho, se ela for física';
  }
  return null;
}

/** O que a placa DIZ que sabe fazer, quando `vainfo` existe. É a resposta, não um consolo. */
function _oQueAPlacaSabe(node) {
  const { execFileSync } = require('node:child_process');
  try {
    const saida = execFileSync('vainfo', ['--display', 'drm', '--device', node],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const perfis = saida.split('\n').filter((l) => l.includes('VAEntrypoint')).map((l) => l.trim());
    return { tem: true, entrypoints: perfis.slice(0, 40),
             codifica: perfis.some((l) => /VAEntrypointEnc/.test(l)) };
  } catch (err) {
    // `vainfo` ausente é o caso comum e não é erro: ele não vem instalado por padrão.
    return { tem: false, motivo: (err.stderr?.toString() || err.message || '').split('\n')[0].slice(0, 200) };
  }
}

function benchmarkGpu({ frames = 300 } = {}) {
  const { execFileSync } = require('node:child_process');
  const gpu = gpuDoServidor();
  const node = (gpu.dispositivos || []).find((d) => d.acesso === 'ok')?.renderNode || null;

  const temFfmpeg = (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); return true; }
    catch { return false; }
  })();
  if (!temFfmpeg) {
    return { rodou: false, motivo: 'ffmpeg não está neste servidor — o app o declara em ' +
                                   'requiredPackages, então o instalador deveria ter recusado' };
  }

  // `testsrc` é gerado pelo próprio ffmpeg: sem arquivo de entrada, sem download, sem depender de
  // nada em disco. Saída para /dev/null — o que se mede é o encode, não o I/O.
  //
  // **stderr é CAPTURADO.** A primeira versão usava `stdio: 'ignore'`, e o `err.stderr` vinha nulo:
  // o que sobrava era `err.message`, ou seja, "Command failed: ffmpeg …" — a linha de comando
  // truncada, que não diz absolutamente nada sobre o que houve. Num servidor real isso virou "a
  // GPU não codificou" sem uma pista de por quê. Erro que não dá o que procurar é quase tão ruim
  // quanto erro nenhum.
  const medir = (args, rotulo) => {
    const t0 = process.hrtime.bigint();
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000,
      });
    } catch (err) {
      const saida = (err.stderr?.toString() || '').trim();
      return {
        rotulo, ok: false,
        // As ÚLTIMAS linhas: o ffmpeg põe a causa no fim, e o começo costuma ser ruído de init.
        erro: saida ? saida.split('\n').slice(-4).join(' · ').slice(0, 400)
                    : (err.message || '').slice(0, 200),
        diagnostico: _porQueVaapiFalhou(saida),
      };
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { rotulo, ok: true, ms: Math.round(ms), fps: Math.round((frames / ms) * 1000) };
  };

  const fonte = ['-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${frames / 30}`];
  const cpu = medir([...fonte, '-c:v', 'libx264', '-preset', 'veryfast', '-f', 'null', '-'], 'cpu');
  // Sem `-hwaccel vaapi`: aquilo é para DECODIFICAR em hardware, e a fonte aqui é gerada pelo
  // próprio ffmpeg. Pedir aceleração de decode de um `lavfi` faz o ffmpeg tentar inicializar um
  // caminho que não existe — e o erro que sai daí fala do decode, não do encode que se queria medir.
  const gpuRes = node
    ? medir(['-vaapi_device', node, ...fonte,
             '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'], 'gpu')
    : { rotulo: 'gpu', ok: false, erro: 'nenhum render node acessível — ver o inventário acima' };

  // A razão só existe quando os DOIS lados mediram. Inventar um número a partir de um lado que
  // falhou seria pior que não ter número nenhum.
  const ganho = cpu.ok && gpuRes.ok && gpuRes.ms > 0 ? +(cpu.ms / gpuRes.ms).toFixed(2) : null;
  // Só quando falhou, e só quando há placa: perguntar "o que você sabe fazer?" a uma placa que
  // acabou de codificar seria gastar segundos para confirmar o óbvio.
  const capacidades = !gpuRes.ok && node ? _oQueAPlacaSabe(node) : null;
  return {
    rodou: true, frames, renderNode: node, cpu, gpu: gpuRes, ganho, capacidades,
    leitura: ganho === null
      ? (gpuRes.ok ? 'não deu para comparar'
         // O diagnóstico primeiro, o stderr depois. Quem lê quer saber o que FAZER; o texto do
         // ffmpeg é a prova, e ela vem embaixo para quem for atrás.
         : `a GPU não codificou — ${gpuRes.diagnostico || gpuRes.erro}`)
      : ganho >= 1.2 ? `a GPU deste servidor é ${ganho}× mais rápida que a CPU neste trabalho`
      : ganho <= 0.8 ? `a GPU é MAIS LENTA que a CPU aqui (${ganho}×) — é o que costuma acontecer ` +
                       'com placa virtual, e é bom saber antes de projetar em cima dela'
      : `empate técnico (${ganho}×) — a GPU deste servidor não compensa neste trabalho`,
  };
}

// Comparação de tamanho fixo: hash dos dois lados antes de comparar, para não vazar prefixo pelo
// tempo nem tropeçar em comprimentos diferentes.
function tokenMatches(expected, received) {
  if (typeof received !== 'string' || received.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    // O healthcheck é pollado pelo lifecycle do portal DIRETO na porta, sem passar pelo proxy —
    // então não carrega o X-Vssh-App-Token. Se ele não for isento, o healthcheck nunca passa e o
    // clique de "abrir app" fica pendurado até o teto de ~15s.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (APP_TOKEN && !tokenMatches(APP_TOKEN, req.headers['x-vssh-app-token'])) {
      // A porta é loopback, mas outro processo do mesmo usuário Linux alcança. Apps que dão acesso
      // sensível (shell, arquivos) devem checar; apps triviais podem simplesmente não checar.
      log('token-rejected', { path: url.pathname });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token ausente ou inválido' }));
      return;
    }

    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ pong: true, appId: APP_ID, time: new Date().toISOString() }));
      return;
    }

    // Exemplo de SSE. Prove que eventos chegam sem buffer: `curl -N <baseUrl>api/events`.
    //
    // O stream também entra no conjunto de conexões abertas — é o que faz a demonstração de
    // "duas janelas, um backend" funcionar: quem incrementa é uma janela, e a difusão alcança
    // todas as outras. Sem o `delete` no `close`, cada abrir-e-fechar de janela deixaria um
    // stream morto no conjunto e o número de conexões só subiria.
    if (url.pathname === '/api/events') {
      const stream = openSseStream(res);
      conexoes.add(stream);
      stream.send('estado', estado());
      let n = 0;
      const timer = setInterval(() => {
        if (stream.closed) return clearInterval(timer);
        stream.send('tick', { n: ++n, time: new Date().toISOString() });
      }, 1000);
      res.on('close', () => { clearInterval(timer); conexoes.delete(stream); difundir(); });
      return;
    }

    // ── Duas janelas, um backend ────────────────────────────────────────────
    //
    // O contador vive AQUI, no processo. Duas janelas do mesmo app (menu de contexto da janela →
    // "Nova janela") são duas visões deste mesmo processo — mesma porta, mesmo token, mesmo
    // VSSH_APP_DATA_DIR. É o que este par de rotas demonstra, e também o que ele avisa: estado de
    // UI guardado no backend passa a ter mais de um cliente.
    if (url.pathname === '/api/estado' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(estado()));
      return;
    }

    if (url.pathname === '/api/estado/incrementar' && req.method === 'POST') {
      contador += 1;
      difundir();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(estado()));
      return;
    }

    // ── O que o AMBIENTE decidiu por este processo ──────────────────────────
    //
    // Três coisas que o app não escolhe sozinho — ele DECLARA no manifesto e o ambiente decide.
    // Esta rota existe para que dê para ver as três de dentro do processo, que é o único lugar
    // onde a resposta é a verdadeira.
    if (url.pathname === '/api/runtime') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ limites: limitesDoCgroup(), gpu: gpuDoServidor(), segredo: segredo() }));
      return;
    }

    // O benchmark fica numa rota À PARTE, e num POST. Ele leva segundos e queima CPU: pendurá-lo
    // no `/api/runtime` faria toda abertura da galeria pagar por um número que ninguém pediu.
    if (url.pathname === '/api/gpu/benchmark' && req.method === 'POST') {
      const r = benchmarkGpu();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r));
      return;
    }

    // O static-spa devolve false quando não atendeu: 404 é decisão de quem compõe as rotas.
    if (await spa(req, res, url)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('não encontrado\n');
  } catch (err) {
    log('request-failed', { path: url.pathname, message: err.message, stack: err.stack });
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('erro interno\n');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('listening', { port: PORT, appId: APP_ID, tokenRequired: Boolean(APP_TOKEN) });
});

// Sem estes dois, uma falha assíncrona derruba o processo sem deixar rastro nenhum — e o lifecycle
// só mostra que o app "não subiu".
process.on('uncaughtException', (err) => log('uncaught', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: String(err) }));
