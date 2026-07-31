# Referência de API: o que um vssh-app pode pedir ao ambiente

Um vssh-app é uma página web dentro de uma janela de um desktop. O desktop já tem janelas,
diálogos, notificações, menus, seletor de arquivos e um gerenciador de arquivos completo — **não
reconstrua nada disso**. Esta página é o inventário do que dá para pedir, e do que não dá.

Tudo aqui vem de `lib/web/vssh-app-shim.js`, carregado pelo `injectScripts` do `static-spa` (sem
tocar no seu HTML):

```js
createStaticSpa({ root, injectScripts: ['vssh-app-shim.js'] });
```

**Nada nesta página passa pelo Xpra.** É o mesmo comportamento com ou sem ele.

**Fora do desktop** (`window.parent === window`, o seu `npm run dev`) tudo degrada em vez de
lançar: diálogos viram `window.confirm`, seletores devolvem `null`, controles de janela viram
no-op. Você desenvolve fora do VSSH sem `if` nenhum.

---

## Índice rápido

| Quero… | Use |
|---|---|
| Trocar o título da janela | `document.title = '…'` (automático) |
| Minimizar / maximizar / fechar | `vssh.window.*` |
| Mostrar um aviso não-bloqueante | `vssh.notify()` |
| Perguntar algo ao usuário | `vssh.dialog.*` |
| Menu de contexto do desktop | `vssh.contextMenu()` |
| Escolher arquivo/pasta | `vssh.pickFile/pickSave/pickDirectory()` |
| Ler e gravar na home do usuário | `showDirectoryPicker()` + FSA (via `fsa-polyfill.js`) |
| Abrir um arquivo no visualizador certo | `vssh.openFile()` |
| Deixar o usuário escolher com que abrir | `vssh.openWith()` |
| Receber um arquivo que abriram com o meu app | `vssh.onOpenContext()` |
| Abas no cabeçalho da janela | `vssh.tabs.*` (exige `richChrome`) |
| Saber onde estou rodando | `await vssh.capabilities()` |

---

## Janela

### Título

**Você não precisa de API.** O shim observa `document.title` e repassa sozinho:

```js
document.title = `${nome} — Editor`;    // a janela do desktop acompanha
```

Isso é deliberado: é o que faz um app portado funcionar sem uma linha nova, porque o mesmo código
que dá título à aba do navegador dá título à janela. `vssh.setTitle(t)` existe para quem prefere
ser explícito, e faz exatamente a mesma coisa.

### Controles

```js
vssh.window.minimize();
vssh.window.maximize();
vssh.window.restore();     // desfaz minimizado ou maximizado
vssh.window.focus();
vssh.window.close();
```

São fire-and-forget: não devolvem promise e não têm resposta a esperar.

**Tamanho é do manifest, não da API.** `window.width`/`window.height` no `vssh-app.json` definem o
tamanho de abertura; depois disso o tamanho é do usuário. Não há `setSize()` de propósito — uma
janela que se redimensiona sozinha briga com quem acabou de arrastá-la.

```json
{ "window": { "width": 1100, "height": 720, "richChrome": false } }
```

---

## Falar com o usuário

### Notificação (não bloqueia)

```js
vssh.notify('Índice reconstruído', { title: 'Busca', level: 'success', timeout: 4000 });
```

`level`: `info` (padrão), `success`, `warning`, `error`.

### Diálogos (bloqueiam, devolvem valor)

```js
await vssh.dialog.alert('Pronto.');
await vssh.dialog.error('Não foi possível salvar.', 'Erro');
const ok   = await vssh.dialog.confirm('Descartar alterações?');   // → boolean
const nome = await vssh.dialog.prompt('Nome do grafo:', 'meu-grafo');
const pw   = await vssh.dialog.password('Senha do repositório:');
```

São os diálogos do desktop, com o visual do desktop. `confirm` devolve `true`/`false`; os de
entrada devolvem a string ou `null` se o usuário cancelou.

### Menu de contexto

O menu do desktop, montado com os itens que **você** descreve:

```js
el.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const id = await vssh.contextMenu(e.clientX, e.clientY, [
    { id: 'open',   label: 'Abrir',    icon: 'folder_open' },
    { id: 'rename', label: 'Renomear', icon: 'edit' },
    { separator: true },
    { id: 'del',    label: 'Excluir',  icon: 'delete', danger: true },
  ]);
  if (id) executar(id);
});
```

Devolve o `id` do item escolhido, ou `null` se o usuário fechou sem escolher — **trate o `null`**,
ele é o caso comum.

Campos por item: `id`, `label`, `icon`, `danger`, `disabled`, `checked`, `separator`, `header`,
`submenu` (um nível). As coordenadas são as do **seu** viewport; o shell soma a posição da janela.

**Só dados atravessam** — rótulo, ícone e `id`, nunca função e nunca HTML. É o que permite ao
desktop montar o menu ele mesmo, e é por isso que o seu menu se parece com o resto do ambiente em
vez de ser um `<div>` que você estilizou.

---

## Arquivos

### Seletores

```js
const dir  = await vssh.pickDirectory({ title: 'Escolher grafo' });
const file = await vssh.pickFile({ title: 'Abrir', filter: '*.md' });
const save = await vssh.pickSave({ name: 'export.pdf' });
```

Devolvem o **caminho absoluto no servidor Linux**, ou `null` se o usuário cancelou. É o
gerenciador de arquivos do desktop em picker mode — com grupos de filtro, diretório inicial e nome
sugerido.

**Escolher é consentir.** O que o usuário escolheu passa a ser alcançável pelo app; o que ele não
escolheu, não. É o modelo da File System Access API, e não há segunda confirmação.

### Ler e gravar: use a API padrão

Para trabalhar com arquivos do usuário, carregue `lib/web/fsa-polyfill.js` e use a **File System
Access API do W3C** — não invente uma API própria e não monte o `vssh-app-fs`:

```js
const dir = await showDirectoryPicker();
for await (const [name, handle] of dir.entries()) {
  if (handle.kind !== 'file') continue;
  const file = await handle.getFile();          // preguiçoso: não baixa nada ainda
  if (!name.endsWith('.md')) continue;          // filtre ANTES de ler
  const texto = await file.text();              // só agora busca o conteúdo
}

const w = await (await dir.getFileHandle('nota.md', { create: true })).createWritable();
await w.write('# título\n');
await w.close();
```

Duas consequências: o app **não precisa de backend de filesystem nenhum**, e um web app que já usa
FSA (Logseq, Excalidraw, tldraw, editores em geral) roda **sem fork**.

Handles sobrevivem a `IndexedDB` — o polyfill cuida do structured clone — **e a permissão
sobrevive junto**, que é o par necessário: um handle restaurado sem permissão é um handle morto.

```js
if (await dir.queryPermission() !== 'granted') {     // responde de verdade; não presuma 'granted'
  if (await dir.requestPermission() !== 'granted') return;   // reabre o seletor
}
```

O usuário revoga em **Permissões de arquivo**, no menu de contexto da janela do app. Trate
`'denied'` como estado normal, não como erro fatal.

**Limites do `File` preguiçoso**, que valem conhecer antes de portar:

| caminho | funciona? |
|---|---|
| `await file.text()` / `.arrayBuffer()` / `.stream()` | sim |
| `URL.createObjectURL(file)` → `<img src>` | sim — vira URL HTTP do portal, com Range |
| `new Response(f)`, `new Blob([f])`, `FileReader`, `FormData.append` | **não** — 0 bytes |

Precisa de um dos últimos? Materialize: `new Blob([await file.arrayBuffer()])`.

### Abrir no visualizador do desktop

```js
vssh.openFile('/home/user/relatorio.pdf');    // roteia por extensão: PDF, vídeo, imagem, texto, office, zip
vssh.openFolder('/home/user/Documents');      // gerenciador de arquivos
const escolhido = await vssh.openWith('/home/user/nota.md');   // usuário escolhe com que abrir
```

Você manda o caminho absoluto e mais nada — **o app nunca precisa saber o `serverId` nem montar
URL de API.**

### Ser um dos alvos de "Abrir com"

Declare no `vssh-app.json`:

```json
{ "opens": { "extensions": ["md", "org"], "mimeTypes": ["text/markdown"] } }
```

O app passa a aparecer no "Abrir com" do gerenciador de arquivos para esses tipos, e recebe o
arquivo por `open-context`:

> **Hoje o casamento é por extensão.** `mimeTypes` é aceito no manifest e projetado por
> `GET /api/apps`, mas o menu "Abrir com" roteia por `extensions` — declare a extensão, sempre.
> Preencher `mimeTypes` não faz mal e prepara o casamento com o `mimeinfo.cache` nativo.

```js
vssh.onOpenContext(({ path }) => { if (path) abrir(path); });
```

`open-context` também chega com o diretório de origem quando o app é aberto por "Abrir Terminal
Aqui" e afins. Apps que não tratam simplesmente ignoram.

---

## Abas no cabeçalho da janela

Opt-in, com `"richChrome": true` no manifest. A tabbar é do shell; o **app** é dono do estado:

```js
vssh.tabs.update([{ id: 't1', title: 'nota.md', sessionName: 's1' }], 't1');
vssh.tabs.on((msg) => {
  switch (msg.type) {
    case 'new-tab':      criarAba(); break;
    case 'close-tab':    fecharAba(msg.tabId); break;
    case 'activate-tab': ativarAba(msg.tabId); break;
    case 'restore-tabs': restaurar(msg.tabs, msg.activeSessionName); break;   // após F5
  }
});
```

`sessionName` é o que persiste no lock file da janela: é como as abas voltam depois de um reload.

---

## Onde estou rodando

```js
const caps = await vssh.capabilities();
// { nativeApps, x11Interop, keyboardGrab, sessionStats, host }
```

`nativeApps: false` significa **ambiente sem Xpra**: não existe programa Linux com UI para lançar,
e o "Abrir com" é habitado só por vssh-apps. Não é um recurso faltando — é uma categoria que não
existe ali. Use isto para esconder o que não faz sentido, nunca para degradar o essencial.

`vssh.inDesktop` (síncrono) responde a pergunta mais simples: estou dentro do VSSH ou no seu
`npm run dev`?

---

## O que **não** existe

Ser honesto aqui vale mais que a lista de cima, porque é o que decide se o seu port é viável.

| Não existe | O que fazer |
|---|---|
| Menubar de aplicação (`Menu` do Electron) | Menu de contexto + UI própria dentro da janela |
| Ícone de bandeja, atalho global, `powerMonitor` | Sem equivalente; normalmente dá para remover |
| `setSize`/`setPosition` da janela | Tamanho inicial pelo manifest; depois é do usuário |
| Badge/progresso na taskbar | — |
| Múltiplas janelas do mesmo app | Uma janela por app; use abas (`richChrome`) |
| `child_process`, binário nativo, FTS server-side | **Backend do seu app** — é para isso que ele existe |
| `ipcRenderer.invoke('<comando seu>')` | Idem: vira uma rota HTTP no seu backend |

A última linha é a fronteira real de um port de Electron/Tauri: o shim cobre a **superfície padrão**
do framework, não o que aquele app inventou. Como medir isso antes de começar está em
[porting.md](porting.md).

---

## O protocolo cru

Se você não puder carregar o shim, a ponte é `postMessage` direto. O shell filtra por
`e.origin === location.origin` **e** `e.source === iframe.contentWindow`.

```js
// app → shell
window.parent.postMessage({ vsshApp: true, type, requestId?, ...payload }, location.origin);
// shell → app, só quando houve requestId
{ vsshApp: true, type: 'result', requestId, ok, value }
```

| `type` | devolve valor? | payload |
|---|---|---|
| `notify` | não | `message`, `title?`, `level?`, `timeout?` |
| `title` | não | `title` |
| `window` | não | `op`: `minimize`\|`maximize`\|`restore`\|`focus`\|`close` |
| `dialog` | sim | `variant`: `alert`\|`error`\|`confirm`\|`prompt`\|`password`, `message`, `title?`, `value?` |
| `pick` | sim | `variant`: `open`\|`save`\|`directory`, `title?`, `filter?`, `name?` |
| `context-menu` | sim | `x`, `y`, `items[]` |
| `fs` | sim | `op`: `list`\|`stat`\|`read`\|`readBytes`\|`write`\|`writeBytes`\|`mkdir`\|`delete`, `path` |
| `grants` | sim | `path?` — com `path`, booleano; sem, a lista |
| `capabilities` | sim | — |
| `open-file` / `open-folder` | não | `path` |
| `open-with` | sim | `path` |
| `tabs` | não | `tabs[]`, `activeTabId` |

Do shell para o app, sem `requestId`: `open-context`, `grants`, `restore-tabs`, `activate-tab`,
`close-tab`, `new-tab`.

**Prefira o shim.** Ele já trata correlação de `requestId`, timeout, degradação fora do desktop e o
espelho de título — e é a única coisa que não muda quando o protocolo mudar.
