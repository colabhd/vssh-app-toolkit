'use strict';

// Hello World (Node) — template de partida para um vssh-app com backend Node.
//
// Uma dependência npm, e ela é o toolkit: `npm i github:colabhd/vssh-app-toolkit#v4`. O resto é
// stdlib do Node. Quem instala no servidor é o `installCommand` do manifesto (`npm ci --omit=dev`),
// e o lock commitado é o que fixa a versão — medido: o `npm ci` resolve o pacote pelo tarball do
// codeload, sem precisar de `git` nem de chave SSH no alvo.
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

const { createStaticSpa } = require('vssh-app-toolkit/spa');
const { createAppLog } = require('vssh-app-toolkit/log');
const { openSseStream } = require('vssh-app-toolkit/sse');
const { escutar } = require('vssh-app-toolkit/listen');
const { WEB_DIR, SHIMS, ESTILOS, SCRIPTS } = require('vssh-app-toolkit/web');
// As duas vozes de um app SEM janela. Elas dizem coisas diferentes, e trocar uma pela outra é o
// erro que enche o sino de quem usa o ambiente:
//
//   notify()  um FATO que aconteceu, e que a pessoa vai querer reencontrar. Fica no histórico.
//   live      uma CONDIÇÃO que é verdade AGORA. Some quando deixa de ser, sem deixar rastro.
const { notify } = require('vssh-app-toolkit/notify');
const { setLive, clearLive, keepLiveAlive, clearLiveOnExit } = require('vssh-app-toolkit/live');
// A bandeja do app SEM janela. O par do `vssh.tray.*` do shim, e não um substituto: aquele é
// síncrono e morre com a janela; este escreve um arquivo que o portal lê, e o clique volta como
// POST — porque a rede é assimétrica (o portal alcança o app; o app não alcança o portal).
const { setTray, clearTray, clearTrayOnExit } = require('vssh-app-toolkit/tray');
// O filesystem PRIVADO do app: uma raiz confinada, servida por HTTP ao próprio frontend. Não
// confundir com os arquivos do usuário, que são a File System Access — ver a peça na galeria.
const { createAppFs, createFsHandler } = require('vssh-app-toolkit/fs');

// Onde este backend escuta é decisão do lifecycle, não deste arquivo: socket unix em
// $VSSH_APP_SOCKET. Quem lê a variável,
// limpa socket órfão e falha alto quando não veio nenhuma é o `escutar()`, lá no fim.
//
// Base só para PARSING de URL relativa. Ela era `http://127.0.0.1:${PORT}` e isso amarrava o
// roteamento ao transporte sem necessidade: num socket unix não existe porta, `${PORT}` vira `NaN`
// e o `new URL` estoura em toda requisição. O host aqui nunca vai à rede.
const BASE_URL = 'http://vssh-app.invalid';
const APP_ID = process.env.VSSH_APP_ID || 'hello-world-node';
const APP_TOKEN = process.env.VSSH_APP_TOKEN || null;

const log = createAppLog({ appId: APP_ID });

// As duas metades do prazo de validade de uma atividade, ligadas no boot porque é uma linha cada e
// porque esquecê-las não quebra nada — só deixa uma barra mentindo no painel de outra pessoa.
//
//   keepLiveAlive()   renova o `at` das atividades vivas a cada 20 s. O portal descarta o que passa
//                     ~60 s sem renovar, porque um arquivo `live` sobrevive a um `kill -9`. Sem
//                     isto, toda atividade mais longa que um minuto some no meio — e some SOZINHA,
//                     o que parece defeito do ambiente. Com `_vivas` vazio ele não faz nada, e o
//                     temporizador é `unref`: não segura o processo.
//   clearLiveOnExit() apaga o que ficou vivo num Ctrl+C ou num SIGTERM. O TTL já cobre o `kill -9`;
//                     isto cobre a saída LIMPA, onde 60 s de "sincronizando" seria um minuto de
//                     mentira que dava para não contar.
//
// Este bloco esteve importado e NÃO chamado, com o comentário da rota afirmando o contrário. Não
// aparecia porque a tarefa de exemplo durava 6,4 s contra um TTL de 60 s — o defeito só se
// manifestava no caso que ninguém exercita. A guarda está em tests/template-galeria.test.js.
keepLiveAlive();
clearLiveOnExit();
// Ícone órfão mente sobre o estado do ambiente: ele fica na bandeja depois que o app morreu, e
// quem o vê conclui que o app está de pé.
clearTrayOnExit();

// ── O armazém privado deste app ──────────────────────────────────────────────
//
// A raiz fica DENTRO do `VSSH_APP_DATA_DIR`, que é o único diretório gravável garantido — o pacote
// em `/opt/vssh-apps/<id>/` é root-owned e somente leitura. Fora do VSSH (o seu `npm run dev`) não
// há data dir, e aí um diretório temporário serve: a peça continua exercitável na sua máquina.
const RAIZ_PRIVADA = path.join(
  process.env.VSSH_APP_DATA_DIR || path.join(require('node:os').tmpdir(), `${APP_ID}-data`),
  'privado',
);
const arquivosPrivados = createAppFs({ root: RAIZ_PRIVADA, onWarn: (e) => log('fs-warn', e) });
const servirPrivado = createFsHandler({
  fs: arquivosPrivados,
  mountPath: '/api/privado',
  // O MESMO token do resto do app. A lib confere sozinha, com comparação resistente a timing — e é
  // por isso que ela tem essa opção em vez de deixar cada app comparar com `!==`.
  requireToken: APP_TOKEN,
  onWarn: (e) => log('fs-warn', e),
});

const spa = createStaticSpa({
  root: path.join(__dirname, '..', 'frontend'),

  // A PONTE COM O DESKTOP, em dois passos — esquecer o primeiro é o erro clássico:
  //   1. o navegador é quem carrega a lib, então alguém tem de SERVI-LA. Ela mora no
  //      `node_modules`, fora da raiz do bundle, e é o `mounts` abaixo que a põe numa URL;
  //   2. `injectScripts` só acrescenta a tag <script> antes do </head> do index — quem serve o
  //      arquivo é este mesmo `createStaticSpa`.
  // Sem o mount a página carrega normalmente, a tag aponta para 404 e o `vssh` simplesmente não
  // existe — sem erro nenhum que ligue uma coisa à outra.
  // A ORDEM importa, e por isso ela vem pronta em `SHIMS`: o polyfill de File System Access
  // depende do `vssh` que o shim publica. Trocar a ordem não dá erro nenhum — dá um
  // `showDirectoryPicker` que não existe, que é bem pior de descobrir.
  mounts: { '/_vssh/': WEB_DIR },
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
  // A aparência do ambiente. Listas SEPARADAS do `SHIMS` de propósito: adotar a biblioteca de UI é
  // escolha deste app, e não consequência de atualizar o toolkit — um app com identidade visual
  // própria (ou que sirva conteúdo de terceiros) não pode ser reestilizado por um `npm i`.
  //
  // As folhas saem antes dos scripts no `<head>`, e é o `injectStyles` que garante isso: um `<link>`
  // bloqueia a primeira pintura, então descobri-lo cedo é o que evita a página aparecer sem estilo
  // por um quadro. Escrevê-los à mão no HTML funcionaria e perderia o carimbo de conteúdo — e uma
  // folha velha de cache não parece cache, parece decisão de design.
  injectStyles: ESTILOS.map((f) => `_vssh/${f}`),
  injectScripts: [...SHIMS.map((s) => `_vssh/${s}`), ...SCRIPTS.map((s) => `_vssh/${s}`), 'galeria.js'],

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
// O temporizador da tarefa longa, para que um segundo clique reinicie em vez de empilhar.
let tarefaEmCurso = null;

const estado = () => ({ contador, conexoes: conexoes.size, subiuEm });
const difundir = () => { for (const s of conexoes) s.send('estado', estado()); };
// A difusão genérica, para o que o BACKEND recebe sem ninguém ter perguntado: o clique na bandeja
// e a ação de uma notificação chegam ao processo por POST, e é por aqui que uma janela aberta fica
// sabendo. Com nenhuma janela aberta, o `for` não itera — e o app recebeu do mesmo jeito.
const difundirEvento = (nome, dado) => { for (const s of conexoes) s.send(nome, dado); };

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
 * antes de instalar.
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
function _porQueVaapiFalhou(stderr, dispositivo) {
  const s = (stderr || '').toLowerCase();
  if (!s) return null;
  if (s.includes('unknown encoder')) {
    return 'este ffmpeg foi compilado SEM VAAPI — é do pacote, não do servidor nem da placa';
  }
  if (s.includes('permission denied')) {
    return 'sem permissão no render node — falta o grupo `render` (usermod -aG render <usuario>)';
  }

  // **O diagnóstico usa o que a DESCOBERTA já sabe.** A primeira versão não recebia o dispositivo e
  // por isso hesitava — "instale o driver, SE ela for física" — mesmo tendo a resposta a uma função
  // de distância. Num servidor real isso mandou procurar pacote para uma virtio, onde nenhum
  // pacote resolve. Duas informações que existiam e não se encontravam: o mesmo defeito que fez
  // "sem GPU" e "sem permissão" darem a mesma resposta.
  const virtual = dispositivo && dispositivo.virtual === true;
  const naoInicializou = s.includes('vainitialize') || s.includes('no va display') ||
    s.includes('failed to initialise') || s.includes('failed to create') || s.includes('not implemented');
  const semEntrypoint = s.includes('entrypoint') || s.includes('not supported') || s.includes('unsupported');

  if (virtual && (naoInicializou || semEntrypoint)) {
    // Definitivo, e de propósito: uma resposta que deixa esperança onde não há custa mais que uma
    // resposta ruim. Quem lê isto precisa parar de procurar pacote e trocar de servidor.
    return `esta é uma GPU VIRTUAL (${dispositivo.fabricante || dispositivo.driver}) — ela NÃO ` +
           'implementa VA-API, e nenhum pacote resolve. Ela existe para desenhar tela, não para ' +
           'codificar vídeo nem computar. Um app que depende de aceleração precisa de outro ' +
           'servidor, com placa física — e descobrir isso agora é o que esta peça existe para fazer';
  }
  if (semEntrypoint) {
    return 'a placa abre, mas NÃO tem motor de codificação de vídeo — ela pode servir para render ' +
           'e não para vídeo';
  }
  if (naoInicializou) {
    return 'o VAAPI não inicializou nesta placa física — driver ausente. O pacote do fabricante ' +
           '(mesa-va-drivers para AMD, intel-media-va-driver para Intel, o driver NVIDIA) é o caminho';
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
    // `vainfo` ausente é o caso COMUM e não é erro — ele não vem instalado por padrão. Devolver o
    // `spawnSync vainfo ENOENT` cru seria jogar na cara de quem lê um detalhe de implementação do
    // Node em vez da única coisa acionável: instale o pacote e a pergunta fica respondida.
    const bruto = (err.stderr?.toString() || err.message || '');
    return {
      tem: false,
      motivo: /ENOENT/.test(bruto)
        ? 'o `vainfo` não está instalado neste servidor — `apt-get install -y vainfo` e esta peça ' +
          'passa a listar o que a placa sabe fazer'
        : bruto.split('\n')[0].slice(0, 200),
    };
  }
}

function benchmarkGpu({ frames = 300 } = {}) {
  const { execFileSync } = require('node:child_process');
  const gpu = gpuDoServidor();
  // O dispositivo, e não só o caminho: o diagnóstico da falha precisa saber se a placa é virtual
  // para responder em vez de hesitar.
  const alvo = (gpu.dispositivos || []).find((d) => d.acesso === 'ok') || null;
  const node = alvo?.renderNode || null;

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
        diagnostico: _porQueVaapiFalhou(saida, alvo),
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

/**
 * O corpo JSON de uma requisição — para os POSTs que o AMBIENTE faz no seu backend (o clique na
 * bandeja, a ação de uma notificação).
 *
 * Corpo ilegível vira `{}` em vez de erro, de propósito: estas rotas existem para reagir a um
 * clique do usuário, e derrubar a reação porque o JSON veio torto seria perder o gesto dele. O
 * teto é para que um corpo enorme não vire memória — um clique não tem 64 KB a dizer.
 */
function lerCorpo(req) {
  return new Promise((resolve) => {
    let dados = '';
    req.on('data', (pedaco) => {
      dados += pedaco;
      if (dados.length > 64 * 1024) { dados = ''; req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(dados || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
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
  const url = new URL(req.url, BASE_URL);

  try {
    // O healthcheck é pollado pelo lifecycle do portal DIRETO na porta, até 15x/1s, bloqueando o
    // clique de "abrir app". A sondagem vai COM o X-Vssh-App-Token, então gatear
    // esta rota seria permitido — o comentário anterior aqui dizia que isentá-la era obrigatório,
    // e isso estava errado. Ela fica isenta por outro motivo, que continua valendo: responde `ok`
    // sem tocar em nada, e assim o healthcheck não depende do token estar certo para dizer se o
    // processo subiu. O que NÃO conta como pronto é 000, 5xx e 401/403.
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

    // ── A tarefa longa, e o ciclo completo de uma atividade ────────────────────
    //
    // O que este endpoint demonstra é o que um `kind:"service"` faz o dia inteiro: trabalho que
    // demora, com o usuário podendo estar olhando para outra coisa. Três decisões dentro dele:
    //
    //  1. **`setLive` a cada passo, com a MESMA chave.** Ela reescreve no lugar — vinte relatos
    //     de progresso não viram vinte linhas no painel de quem está trabalhando;
    //  2. **A renovação do `at`**, ligada uma vez no boot por `keepLiveAlive()` (ver o topo do
    //     arquivo). O portal descarta a atividade que passa ~60 s sem renovar o carimbo de tempo,
    //     porque um arquivo chamado `live` sobrevive a um `kill -9` — e uma barra parada em 30%
    //     para sempre é pior que barra nenhuma;
    //  3. **`clearLive` com `registrar` no fim.** A atividade some e deixa UMA notificação. Se o
    //     desfecho não interessasse (uma indisponibilidade que se resolveu), seria `clearLive`
    //     sem argumento nenhum, e não sobraria rastro — que é o certo nesse caso.
    //
    // `?lento=1` é o que torna a decisão 2 OBSERVÁVEL: oito passos de 10 s passam de 80 s, bem
    // além do TTL de 60 s. Com a renovação ligada, a barra atravessa; sem ela, some no meio
    // sozinha — que é o defeito que dorme numa demonstração de 6 segundos.
    if (url.pathname === '/api/tarefa-longa' && req.method === 'POST') {
      const lento = url.searchParams.get('lento') === '1';
      const intervalo = lento ? 10000 : 800;
      const total = 8;
      let feito = 0;
      // Uma tarefa por vez: um segundo clique reinicia em vez de somar dois temporizadores
      // escrevendo na MESMA chave — dois donos do mesmo arquivo é progresso que anda para trás.
      if (tarefaEmCurso) clearInterval(tarefaEmCurso);
      const passo = () => {
        feito++;
        setLive('exemplo-backend', {
          titulo: 'Tarefa do backend',
          texto: `passo ${feito}${lento ? ' (devagar — atravessa o TTL)' : ''}`,
          formato: 'progresso',
          progresso: { feito, total },
        });
        if (feito >= total) {
          clearInterval(tarefaEmCurso);
          tarefaEmCurso = null;
          clearLive('exemplo-backend', {
            registrar: { titulo: 'Tarefa concluída', texto: `${total} passos`, level: 'success' },
          });
        }
      };
      passo();
      tarefaEmCurso = setInterval(passo, intervalo);
      // `unref`: um temporizador de demonstração não pode ser o motivo de o processo não encerrar.
      tarefaEmCurso.unref?.();

      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ iniciada: true, total, intervalo, duracaoMs: total * intervalo }));
      return;
    }

    // Uma notificação de backend com `key` estável. O portal lê uma JANELA do fim do journal, não
    // um delta — então é a `key` que impede o mesmo aviso de chegar a cada tick. Chamar isto dez
    // vezes no mesmo dia rende UMA notificação; no dia seguinte, outra.
    if (url.pathname === '/api/avisar' && req.method === 'POST') {
      const hoje = new Date().toISOString().slice(0, 10);
      notify('O disco do servidor está acima de 90%.', {
        title: 'Hello World', level: 'warning', key: `disco-cheio-${hoje}`,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ notificada: true, key: `disco-cheio-${hoje}` }));
      return;
    }

    // Uma notificação com AÇÃO, vinda do backend. A diferença para a de cima é o `path`: sem ele,
    // o botão da notificação não teria para onde mandar a resposta. O clique pode acontecer com o
    // app sem janela nenhuma aberta — e é por isso que o destino é uma rota do processo, e não um
    // callback do frontend.
    if (url.pathname === '/api/avisar-com-acao' && req.method === 'POST') {
      notify('O índice está desatualizado. Reconstruir agora?', {
        title: 'Hello World', level: 'warning', persistent: true,
        actions: [{ id: 'reconstruir', label: 'Reconstruir' }],
        path: '/api/acao',
        key: `indice-${Date.now()}`,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ notificada: true, acao: 'reconstruir', rota: '/api/acao' }));
      return;
    }

    // O destino da ação. Quem faz este POST é o desktop, não o seu frontend.
    if (url.pathname === '/api/acao' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      log('acao-de-notificacao', { acao: corpo });   // aninhado pela mesma razão da rota da bandeja
      difundirEvento('acao', { ...corpo, em: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── A bandeja pela lib, e o clique que volta ────────────────────────────
    if (url.pathname === '/api/bandeja' && req.method === 'POST') {
      const ok = setTray({
        icon: 'refresh',
        tooltip: 'Hello World — posto pelo BACKEND',
        badge: { dot: true },
        menu: [
          { id: 'oi', label: 'Um item do menu' },
          { separator: true },
          { id: 'sair', label: 'Remover este ícone', danger: true },
        ],
        // Só DADOS atravessam o arquivo: aqui vai uma rota, não uma função. É a mesma restrição
        // do menu de contexto, pela mesma razão — função não serializa.
        onClick: { path: '/api/bandeja/clique' },
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok, motivo: ok ? null : 'sem VSSH_APP_DATA_DIR nem VSSH_APP_ID' }));
      return;
    }

    if (url.pathname === '/api/bandeja' && req.method === 'DELETE') {
      clearTray();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/api/bandeja/clique' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      // ANINHADO, e não espalhado. `createAppLog` monta `{ts, event, ...detail}` — e o corpo que o
      // ambiente manda TEM uma chave `event` (`click`/`menu`). Espalhá-lo sequestra o nome do
      // evento: as duas rotas do app apareciam no log como `"event":"click"` e `"event":"menu"`,
      // sem uma palavra dizendo que vieram da bandeja. Medido rodando o template de verdade.
      log('clique-na-bandeja', { clique: corpo });
      if (corpo.menuId === 'sair') clearTray();
      difundirEvento('bandeja', corpo);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // O filesystem privado, servido pela lib. Ela devolve `true` quando atendeu — mesmo contrato
    // do static-spa, e pela mesma razão: quem compõe as rotas é o app, não a lib.
    if (await servirPrivado(req, res, url)) return;

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

escutar(server)
  .then(({ transporte, endereco }) => {
    log('listening', { transporte, endereco, appId: APP_ID, tokenRequired: Boolean(APP_TOKEN) });
  })
  .catch((err) => {
    // `VSSH_APP_JA_ESCUTANDO` não é falha: significa que outra instância já atende neste endereço,
    // e o lifecycle trata sair-em-silêncio como sucesso (é o mesmo contrato do `exit 0` do
    // `vssh-app-run` quando encontra alguém escutando). Qualquer outro erro é fatal e tem de
    // aparecer: um backend que não escuta e não reclama vira janela em branco sem causa.
    if (err.code === 'VSSH_APP_JA_ESCUTANDO') {
      log('already-listening', { message: err.message });
      process.exit(0);
    }
    log('listen-failed', { message: err.message, code: err.code });
    console.error('[hello-world-node] não consegui escutar:', err.message);
    process.exit(1);
  });

// Sem estes dois, uma falha assíncrona derruba o processo sem deixar rastro nenhum — e o lifecycle
// só mostra que o app "não subiu".
process.on('uncaughtException', (err) => log('uncaught', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (err) => log('unhandled-rejection', { message: String(err) }));
