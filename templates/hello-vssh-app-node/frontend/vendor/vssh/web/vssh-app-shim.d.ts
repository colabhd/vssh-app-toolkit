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

interface VsshOpcoesDeNotificacao {
  title?: string;
  level?: VsshNivel;
  /** Milissegundos até sumir sozinha. */
  timeout?: number;
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

/** "Abra assim" — o arquivo ou caminho com que o app foi aberto (campo `opens` do manifesto). */
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
  notify(message: string, opts?: VsshOpcoesDeNotificacao): void;

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

  fs: VsshFs;

  /**
   * Título da janela. Você raramente precisa chamar: o shim observa `document.title` e repassa
   * sozinho, então um app que já faz `document.title = …` funciona sem uma linha nova.
   */
  setTitle(title: string): void;

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

  /**
   * Pede a tela de impressão do desktop para um arquivo do SERVIDOR. Resolve assim que a tela
   * abre — não espera o usuário imprimir. `false` fora do desktop, ou num shell que não conhece.
   */
  print(path: string, opts?: { name?: string }): Promise<boolean>;

  clipboard: VsshClipboard;
  audio: VsshAudio;

  /** "Abra assim": o path de "Abrir Terminal Aqui", ou o arquivo escolhido para abrir com este app. */
  onOpenContext(handler: (ctx: VsshContextoDeAbertura) => void): void;
}

declare const vssh: Vssh;

interface Window {
  vssh: Vssh;
}
