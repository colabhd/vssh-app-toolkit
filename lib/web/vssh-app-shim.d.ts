// Tipos do `vssh-app-shim.js` — a ponte entre um vssh-app e o desktop.
//
// Este arquivo NÃO é um módulo: o shim é carregado por tag `<script>` e escreve em `window`, então
// aqui tudo é declaração global. Basta o arquivo estar no `include` do seu `tsconfig.json` (ou
// referenciado com `/// <reference path="…/vssh-app-shim.d.ts" />`) para `vssh.` autocompletar.
//
// **Todo membro aqui foi lido do código, e é conferido contra ele.** `lib/web/test/tipos.test.js`
// carrega o shim, enumera a superfície REAL em runtime e compara com o que este arquivo declara,
// nos dois sentidos: membro que existe e não está declarado reprova, e membro declarado que não
// existe também. Um `.d.ts` que envelhece é pior que nenhum — ele mente para o compilador e para o
// editor ao mesmo tempo, com a autoridade de quem parece ter sido verificado.
//
// O que ele deliberadamente NÃO promete: os tipos das mensagens internas do `postMessage`. Isso é
// protocolo entre o shim e o shell, não superfície do app — quem programa contra ele já saiu do
// caminho suportado.

/** Severidade de uma notificação. `info` é o padrão. */
type VsshNivel = 'info' | 'success' | 'warning' | 'error';

/**
 * Quanto uma notificação interrompe. `level` é TOM (a cor); isto é IMPORTÂNCIA.
 *
 *   'baixa'   badge e histórico. Não aparece na tela.
 *   'normal'  + aviso de 4 s.                                       ← o padrão
 *   'alta'    + aviso que não some sozinho (pede resposta).
 *
 * Não há `'critica'` aqui de propósito: ela abre um diálogo bloqueante, e o desktop a rebaixa
 * para `'alta'` quando vem de um app. Bloquear a tela de quem está trabalhando é poder do
 * ambiente, não de quem escreve um app — para uma pergunta que precisa de resposta, use
 * `vssh.dialog.confirm()`, que é uma pergunta que a pessoa escolheu abrir.
 */
type VsshPrioridade = 'baixa' | 'normal' | 'alta';

/** Ação de uma notificação: DADO, nunca função. A resposta volta por `notify-action`. */
interface VsshAcaoDeNotificacao {
  id: string;
  label: string;
}

interface VsshOpcoesDeNotificacao {
  title?: string;
  level?: VsshNivel;
  prioridade?: VsshPrioridade;
  /**
   * Identidade SEMÂNTICA: uma notificação nova com a mesma chave SUBSTITUI a anterior no lugar,
   * em vez de empilhar. É o que faz "3 de 5 baixados" ser uma linha, e não cinco.
   */
  chave?: string;
  /** Até três. A quarta viraria menu, e menu numa notificação ninguém abre. */
  actions?: VsshAcaoDeNotificacao[];
  /** Não suma sozinha — o `requireInteraction` da Notification API. Equivale a `'alta'`. */
  persistent?: boolean;
}

interface VsshOpcoesDeAviso {
  title?: string;
  level?: VsshNivel;
  /** Milissegundos até sumir sozinho. `0` = fica até alguem dispensar. */
  timeout?: number;
  /** Mesma chave reescreve o aviso na tela em vez de abrir um segundo. */
  chave?: string;
}

/** O que o app está fazendo agora. Some quando acaba; nada disto vai para o histórico. */
interface VsshAtividade {
  titulo?: string;
  texto?: string;
  level?: VsshNivel;
  /** `'simples'` ou `'progresso'`. Com `progresso`, o desktop desenha a barra. */
  formato?: 'simples' | 'progresso';
  progresso?: { feito: number; total: number } | { indeterminado: true };
  acoes?: VsshAcaoDeNotificacao[];
  /**
   * Epoch ms, RENOVADO enquanto a atividade vive.
   *
   * Só importa no caminho por ARQUIVO (`lib/node/vssh-live.js`): um arquivo chamado `live`
   * sobrevive a um `kill -9`, e sem prazo de validade ele passa a mentir que algo está
   * acontecendo. Pela janela, quem dá o prazo é a própria janela estar aberta.
   */
  at?: number;
}

interface VsshControleDeAtividade {
  set(chave: string, item: VsshAtividade): void;
  /** Encerra. Sem `registrar`, não deixa rastro — e é esse o padrão. */
  clear(chave: string, opts?: { registrar?: { titulo?: string; texto?: string; level?: VsshNivel } }): void;
}

/**
 * O que este ambiente sabe fazer, e qual ele é.
 *
 * Aberto de propósito (`[k: string]: unknown`): as capacidades são declaradas pelo HOST que
 * hospeda o shell, e um host novo pode declarar chaves que este arquivo não conhece. Fechar o
 * tipo obrigaria a bumpar o toolkit para ler uma chave que já está chegando.
 */
interface VsshCapabilities {
  /** `false` = ambiente sem X11: não há programa Linux com UI para lançar. */
  nativeApps: boolean;
  x11Interop: boolean;
  keyboardGrab?: boolean;
  sessionStats?: boolean;
  /** Nome do host: `xpra`, `standalone`, `none` (fora do desktop) ou `unknown`. */
  host: string;
  /**
   * Versão DECLARADA do shell. `null` quer dizer *"shell antigo demais para se declarar"* — é
   * resposta legítima, não erro. Trate como desconhecido: `caps.shellVersion ?? 'desconhecida'`.
   */
  shellVersion: string | null;
  /** Versão das libs do toolkit que ESTE app carrega. Vem embutida no shim. */
  libVersion: string;
  [k: string]: unknown;
}

interface VsshOpcoesDeSeletor {
  title?: string;
  /** Grupos de filtro, no idioma do gerenciador de arquivos: `'*.md'`, `'Imagens (*.png *.jpg)'`. */
  filter?: string;
  /** Diretório inicial. */
  dir?: string;
  /** Nome sugerido — só faz sentido em `pickSave`. */
  name?: string;
}

interface VsshEntrada {
  name: string;
  type?: 'file' | 'directory';
  /** Grafia alternativa que algumas respostas usam; trate as duas. */
  isDirectory?: boolean;
  size?: number;
  /** Epoch em milissegundos. */
  mtime?: number;
}

interface VsshListagem {
  items: VsshEntrada[];
}

interface VsshStat {
  size: number;
  mtime: number;
  [k: string]: unknown;
}

/** O que `vssh.fs.watch` entrega. `closed: true` = a assinatura acabou de vez. */
interface VsshMudanca {
  path: string | null;
  closed: boolean;
}

interface VsshFs {
  list(path: string): Promise<VsshListagem>;
  stat(path: string): Promise<VsshStat>;
  /** Conteúdo como texto. Para binário use `readBytes` — texto-encodar bytes os corrompe. */
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string): Promise<unknown>;
  writeBytes(path: string, bytes: Uint8Array | ArrayBufferView): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
  delete(path: string): Promise<unknown>;

  /**
   * `false` significa **não existe** — e só isso. Falta de permissão, servidor fora ou rede
   * piscando **lançam**, em vez de virarem `false`. Não escreva
   * `exists(p).catch(() => false)`: é justamente esse colapso que esta função existe para evitar.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Renomeia — e é também o **mover**, como o `mv`. Origem e destino precisam **ambos** estar
   * concedidos pelo usuário; sem isso o shell recusa com 403.
   *
   * Destino existente **falha**. `{ overwrite: true }` é a forma de dizer que você quer mesmo.
   */
  rename(from: string, to: string, opts?: { overwrite?: boolean }): Promise<unknown>;
  copy(from: string, to: string, opts?: { overwrite?: boolean }): Promise<unknown>;

  /**
   * Avisa quando algo muda dentro de `path` por fora do app. Devolve a função que cancela —
   * **cancele quando parar de precisar**: cada watch segura um vigia vivo no servidor.
   */
  watch(path: string, onChange: (e: VsshMudanca) => void): Promise<() => void>;

  /**
   * "O usuário me deu permissão para este caminho?" — TRÊS respostas, e a terceira importa:
   * `null` é *"não obtive resposta"* (shell antigo, erro, timeout), que pede ação OPOSTA a
   * `false`. Uma manda desistir; a outra manda seguir.
   */
  isGranted(path: string, opts?: { mode?: 'read' | 'readwrite' }): Promise<boolean | null>;

  /**
   * Os caminhos que este app JÁ pode tocar, sem abrir seletor — inclusive os de sessões anteriores
   * e **de outras máquinas**, porque o grant mora no usuário e não no navegador.
   *
   * Síncrona: o espelho já está em memória, alimentado pelo push do shell. É a matéria-prima de
   * `grantedHandles()` do polyfill, que os transforma em handles da File System Access API.
   */
  grantedPaths(): string[];

  /**
   * URL HTTP para o conteúdo, pronta para `<img src>`, `<video>` ou `fetch`. **Síncrona de
   * propósito** — é o que permite substituir `URL.createObjectURL`. Suporta `Range`.
   */
  urlFor(path: string): string;
}

interface VsshJanela {
  minimize(): void;
  maximize(): void;
  restore(): void;
  focus(): void;
  close(): void;
  /**
   * Outra janela deste mesmo app. `rota` é um caminho relativo DENTRO do app — é ela que faz a
   * janela ser **extra** (um painel, uma prévia) em vez de uma cópia da mesma página. Continua
   * sendo um backend só. `false` num shell que ainda não sabe abrir.
   */
  abrir(rota?: string, opts?: { title?: string; width?: number; height?: number }): Promise<boolean>;

  /**
   * "Me agarraram aqui" — começa o arraste da janela a partir de um ponto do SEU documento.
   *
   * Só para quem declara `window.cabecalho: "app"` no manifesto.
   *
   * ⚠ **Aqui estava escrito "não mande `pointermove`". Estava errado.** Enquanto o botão está
   * apertado sobre o seu quadro, o documento do ambiente não recebe evento de ponteiro nenhum — o
   * gesto é seu do primeiro ponto ao último, e entregá-lo pela metade perde pontos sem avisar.
   *
   * Capture o ponteiro e mande os três:
   *
   * ```js
   * barra.addEventListener('pointerdown', (e) => {
   *   if (e.button !== 0) return;
   *   barra.setPointerCapture(e.pointerId);
   *   vssh.window.arrastar(e.clientX, e.clientY, e.screenX, e.screenY);
   * });
   * barra.addEventListener('pointermove', (e) => vssh.window.arrastarPara(e.screenX, e.screenY));
   * barra.addEventListener('pointerup',   () => vssh.window.arrastarFim());
   * ```
   *
   * O limiar que separa clique de arraste é seu, pelo mesmo motivo. Containment, encaixe e onde a
   * janela para continuam do ambiente — e geometria não atravessa em direção nenhuma.
   */
  arrastar(x: number, y: number, telaX?: number, telaY?: number): void;

  /**
   * Um ponto do arraste em curso, em coordenada de **tela** (`e.screenX`, `e.screenY`).
   *
   * ⚠ De tela, e não do seu quadro: enquanto a janela é arrastada o seu quadro se move junto com
   * ela, então `clientX` vira `tela − posição da janela` — um laço de realimentação que aparece
   * como TREMOR quando chega mais de um evento por quadro. `screenX` não se move com a janela.
   */
  arrastarPara(telaX: number, telaY: number): void;

  /**
   * O fim do arraste. **Obrigatório** — sem ele a janela continua seguindo o ponteiro depois que o
   * usuário solta. Chame no `pointerup` e no `pointercancel`.
   */
  arrastarFim(): void;

  /** O duplo-clique da barra de título. Alterna, e não maximiza — é o gesto, não a ação. */
  alternarMaximizado(): void;

  /** O menu de contexto do cabeçalho (mover, maximizar, fechar, log do backend…). */
  menuDoCabecalho(x: number, y: number): void;
}

interface VsshDialogo {
  alert(message: string, title?: string): Promise<void>;
  error(message: string, title?: string): Promise<void>;
  confirm(message: string, title?: string): Promise<boolean>;
  prompt(message: string, value?: string, title?: string): Promise<string | null>;
  password(message: string, title?: string): Promise<string | null>;
}

/**
 * Item do menu de contexto. Só DADOS atravessam — nunca função, nunca HTML.
 *
 * As três formas são exclusivas na prática: separador, cabeçalho, ou item. Um item sem `id` é
 * identificado pelo próprio `label` na resposta.
 */
interface VsshItemDeMenu {
  id?: string;
  label?: string;
  /** Nome de ícone do desktop. */
  icon?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  header?: string;
  /** **Um nível só** — o shell ignora submenu dentro de submenu. */
  submenu?: VsshItemDeMenu[];
}

interface VsshAba {
  id: string;
  title: string;
  /** Só apps que querem as abas restauradas entre reloads precisam mandar. */
  sessionName?: string;
}

/** O que o shell empurra para o app quando o usuário mexe nas abas. */
type VsshEventoDeAba =
  | { type: 'activate-tab'; tabId?: string }
  | { type: 'close-tab'; tabId?: string }
  | { type: 'new-tab' }
  | { type: 'restore-tabs'; tabs: Array<{ sessionName: string }> | null; activeSessionName?: string };

interface VsshAbas {
  /** Substitui a lista inteira. O shell monta os botões; o app só descreve. */
  update(tabs: VsshAba[], activeTabId?: string): void;
  on(handler: (e: VsshEventoDeAba) => void): void;
}

/** `count: 0` não é badge — um contador que zerou tem de sumir. */
type VsshBadge = { dot: true } | { count: number } | { text: string };

interface VsshItemDeBandeja {
  /** Nome de ícone do desktop, ou caminho dentro do seu pacote. */
  icon?: string;
  tooltip?: string;
  badge?: VsshBadge;
  menu?: Array<{ id?: string; label?: string }>;
  onClick?: () => void;
  onMenu?: (menuId: string) => void;
}

interface VsshBandeja {
  /** `false` quando não há bandeja do outro lado — não rejeita, não pendura. */
  set(item?: VsshItemDeBandeja): Promise<boolean>;
  remove(): Promise<boolean>;
}

/** O clipboard de ARQUIVOS do desktop. `action` é sempre `copy`. */
interface VsshClipboardDeArquivos {
  action: string;
  paths: string[];
}

/** Motivo nomeado de uma recusa do clipboard do sistema. É o que separa issue de conserto. */
type VsshMotivoDeClipboard = 'no-user-activation' | 'denied' | 'unsupported' | 'unknown';

interface VsshErroDeClipboard extends Error {
  reason: VsshMotivoDeClipboard;
  cause?: unknown;
}

interface VsshClipboard {
  files(): Promise<VsshClipboardDeArquivos | null>;
  setFiles(paths: string | string[]): Promise<boolean>;
  /** Avisa quando o clipboard de arquivos muda, inclusive por fora do app. Devolve o cancelador. */
  onChange(fn: (c: VsshClipboardDeArquivos | null) => void): () => void;
  /** `null` = não havia imagem. **Lança** `VsshErroDeClipboard` quando o navegador recusa. */
  readImage(): Promise<Blob | null>;
  writeImage(blob: Blob): Promise<boolean>;
}

/**
 * O volume que o ambiente aplica a este app — **só de leitura**, e a maioria dos apps não precisa
 * disto: o shim já multiplica a mídia sozinho. Não reaja a `onChange` escrevendo `el.volume`;
 * isso desfaz a multiplicação.
 */
interface VsshAudio {
  /** Ganho efetivo de 0 a 1. Mudo devolve 0. */
  gain(): number;
  muted(): boolean;
  /** Devolve a função que cancela. */
  onChange(fn: () => void): () => void;
}

/**
 * Os tokens de destaque que o ambiente escolheu. As chaves são nomes de custom property CSS, para
 * o app poder escrevê-las direto no `:root` dele sem traduzir nada.
 *
 * São **quatro**, e não uma: o shell escreve `--ds-accent-h` a partir de uma conta própria
 * (`IconeDeDestaque.clara`). Derivar as outras três a partir do destaque traria essa fórmula para
 * cá, numa cópia entre dois repositórios que não se medem.
 */
interface VsshTokensDeAparencia {
  '--ds-accent': string;
  '--ds-accent-h': string;
  '--ds-accent-bg': string;
  '--ds-sel': string;
}

/**
 * A aparência que o ambiente escolheu — hoje, a cor de destaque do usuário.
 *
 * Isto **reporta**; quem pinta é a biblioteca de UI (`lib/web/tuff/`) ou o próprio app. A separação
 * é o que permite a um app com identidade visual própria puxar só a cor sem herdar a paleta.
 */
interface VsshAparencia {
  /**
   * `null` quando não há ambiente a quem perguntar — aba solta, ou app servido de outra origem.
   *
   * `null` e não os padrões, de propósito: os padrões já estão no CSS da biblioteca, que é onde
   * precisam estar para a página pintar certo antes de qualquer JavaScript. Devolvê-los aqui faria
   * do hex padrão uma segunda cópia. `null` quer dizer "não sobrescreva nada".
   */
  tokens(): VsshTokensDeAparencia | null;
  /** Avisa quando o usuário troca a cor, e só então. Devolve a função que cancela. */
  onChange(fn: (t: VsshTokensDeAparencia | null) => void): () => void;
}

/** "Abra assim" — o arquivo ou caminho com que o app foi aberto (campo `opens` do manifesto). */
/**
 * O cofre: credenciais que o app precisa e o USUÁRIO guarda.
 *
 * Repare no que NÃO existe aqui: um `get()`. Não é esquecimento — o valor chega ao seu app pelo
 * AMBIENTE (`process.env.<NOME>`), e um cofre que devolvesse o que guardou seria uma porta a mais
 * sem servir para nada. `set()` também não recebe o segredo: quem digita fala com o diálogo do
 * desktop.
 *
 * Fora do desktop tudo devolve `null` em vez de lançar — em desenvolvimento local a credencial vem
 * de onde o autor quiser, e a ausência de cofre não é uma falha.
 */
interface VsshCofre {
  /** Os NOMES guardados para este app. Nunca os valores. `null` fora do desktop. */
  list(): Promise<string[] | null>;

  /**
   * Pede ao desktop que guarde uma credencial. **Chame no momento em que ela falta** — no clique
   * de "conectar", quando não há token —, e não mande a pessoa procurar Configurações: ela não
   * sabe o nome da variável que o seu app espera.
   *
   * `cancelado: true` quando a pessoa desistiu, que é resposta e não erro. `requerReinicio: true`
   * porque o ambiente de um processo é fixado no start: guardar não basta, o app precisa reiniciar
   * para enxergar.
   */
  set(nome: string, opts?: { title?: string; description?: string }):
    Promise<{ names: string[] | null; cancelado?: boolean; requerReinicio?: boolean } | null>;

  /** Apaga uma credencial deste app. */
  remove(nome: string): Promise<{ names: string[]; requerReinicio?: boolean } | null>;
}

interface VsshContextoDeAbertura {
  type: 'open-context';
  path?: string;
  [k: string]: unknown;
}

interface Vssh {
  /** Estou dentro do desktop VSSH, ou no `npm run dev`? Síncrono. */
  readonly inDesktop: boolean;
  /** Versão das libs do toolkit que este app carrega. Síncrono. */
  readonly libVersion: string;

  capabilities(): Promise<VsshCapabilities>;

  /** Um FATO que aconteceu. Fica no histórico do sino até ser lido. */
  notify(message: string, opts?: VsshOpcoesDeNotificacao): void;
  /** Uma frase que se lê e se esquece. Some em segundos, SEM deixar rastro. */
  toast(message: string, opts?: VsshOpcoesDeAviso): void;
  /** Uma CONDIÇÃO que é verdade agora. Some quando deixa de ser. */
  live: VsshControleDeAtividade;

  dialog: VsshDialogo;

  /**
   * Seletores do desktop. Devolvem o caminho absoluto escolhido, ou `null` se o usuário cancelou
   * — e `null` também fora do desktop, onde não há caminho de servidor que faça sentido.
   *
   * **Escolher é o que concede permissão** ao `vssh.fs`: sem passar por um seletor, o app não
   * alcança arquivo nenhum do usuário.
   */
  pickFile(opts?: VsshOpcoesDeSeletor): Promise<string | null>;
  pickSave(opts?: VsshOpcoesDeSeletor): Promise<string | null>;
  pickDirectory(opts?: VsshOpcoesDeSeletor): Promise<string | null>;

  /** Abre no visualizador do desktop, escolhido pela extensão. */
  openFile(path: string): void;
  openFolder(path: string): void;
  /** Deixa o usuário escolher COM QUE abrir. Devolve o rótulo escolhido, ou `null`. */
  openWith(path: string): Promise<string | null>;
  /**
   * Abre um link no navegador DO AMBIENTE, e não numa aba do navegador hospedeiro.
   *
   * Aquele navegador resolve a rede a partir do servidor Linux, então `http://localhost:3000` aqui
   * é o loopback **do servidor**. Só `http`/`https`; o ambiente recusa o resto.
   */
  openUrl(url: string): Promise<null>;

  fs: VsshFs;

  /**
   * Título da janela. Você raramente precisa chamar: o shim observa `document.title` e repassa
   * sozinho, então um app que já faz `document.title = …` funciona sem uma linha nova.
   */
  setTitle(title: string): void;

  /**
   * "Se eu voltar, volte assim." A rota que o ambiente guarda e devolve na URL da janela quando a
   * sessão é restaurada — sem pedir código de restauração nenhum do seu lado.
   *
   * Só um caminho DENTRO do app (sem esquema, sem `/` inicial, sem `..`), com teto de 512. Vazio
   * limpa. É ponteiro, não armazém: o que não couber num endereço vai para o backend do seu app.
   */
  lembrarRota(rota: string): void;

  window: VsshJanela;

  /**
   * Menu de contexto do desktop, nas coordenadas do SEU viewport (o shell soma a posição da
   * janela). Devolve o `id` do item escolhido — ou o `label`, se o item não tiver `id` — e `null`
   * se o usuário fechou sem escolher.
   */
  contextMenu(x: number, y: number, items: VsshItemDeMenu[]): Promise<string | null>;

  /** Abas no cabeçalho da janela. Precisa de `"richChrome": true` no manifesto. */
  tabs: VsshAbas;

  tray: VsshBandeja;

  secrets: VsshCofre;

  /**
   * Pede a tela de impressão do desktop para um arquivo do SERVIDOR. Resolve assim que a tela
   * abre — não espera o usuário imprimir. `false` fora do desktop, ou num shell que não conhece.
   */
  print(path: string, opts?: { name?: string }): Promise<boolean>;

  clipboard: VsshClipboard;
  audio: VsshAudio;
  aparencia: VsshAparencia;

  /** "Abra assim": o path de "Abrir Terminal Aqui", ou o arquivo escolhido para abrir com este app. */
  onOpenContext(handler: (ctx: VsshContextoDeAbertura) => void): void;

  /**
   * O tipo MIME do arraste de arquivo do ambiente: caminhos absolutos, um por linha.
   *
   * Exposto para quem quiser escrever os ouvintes à mão. Se for esse o caso, lembre do
   * `preventDefault` no `dragover` — sem ele o navegador recusa a soltura, e o `drop` nunca
   * acontece, sem erro nenhum.
   */
  readonly ARQUIVOS_MIME: string;

  /**
   * Chama o handler quando arquivos do ambiente são soltos no app. Devolve a função que desliga —
   * cancelar importa, porque o ouvinte fica no documento.
   */
  onArquivosSoltos(
    handler: (info: VsshArquivosSoltos) => void,
    opts?: { alvo?: EventTarget },
  ): () => void;

  /**
   * Põe caminhos do usuário num arraste que o APP inicia — chamado de dentro do `dragstart` dele.
   * O fim do gesto é avisado ao ambiente sozinho. Devolve `false` se nenhum caminho era absoluto.
   */
  arrastarArquivos(
    dataTransfer: DataTransfer | null,
    caminhos: string | string[],
    opts?: { efeito?: string },
  ): boolean;
}

interface VsshArquivosSoltos {
  /** Caminhos absolutos no servidor. Sempre pelo menos um. */
  caminhos: string[];
  /** Onde a soltura aconteceu, no viewport do app. */
  x: number;
  y: number;
  alvo: EventTarget | null;
}

declare const vssh: Vssh;

interface Window {
  vssh: Vssh;
}
