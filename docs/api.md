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
| Ícone na bandeja do sistema | `vssh.tray.set()` |
| Escolher arquivo/pasta | `vssh.pickFile/pickSave/pickDirectory()` |
| Ler e gravar na home do usuário | `showDirectoryPicker()` + FSA (via `fsa-polyfill.js`) |
| Saber que um arquivo mudou por fora | `vssh.fs.watch()` |
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

O aviso aparece como toast **e** fica no centro de notificações, com o seu `id` de app como
dono. Se o usuário estiver em "não perturbe", o toast não aparece — a entrada fica lá mesmo
assim, esperando ser lida. Silenciar as duas coisas seria perder informação.

Com a aba oculta e a permissão concedida, o aviso também sai como **notificação do sistema
operacional** — alcance a mais, não mecanismo: nunca conte com ela. O usuário concede no botão
"Avisar fora da aba", dentro do painel de notificações.

### Notificação que pede resposta

```js
vssh.notify('Backup falhou: disco cheio', {
  title: 'Backup',
  level: 'error',
  persistent: true,                                  // não some sozinho
  actions: [
    { id: 'retry',  label: 'Tentar de novo' },
    { id: 'ignore', label: 'Ignorar' },
  ],
});
```

A resposta chega de volta no seu frontend como uma mensagem comum da ponte:

```js
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.vsshApp && m.type === 'notify-action') {
    // m.notificationId, m.actionId
  }
});
```

| | |
|---|---|
| `actions` | No máximo **3**, cada uma `{id, label}`. `id` casa `[\w-]{1,32}`; id repetido é descartado. São **dados** — nunca uma função, e nunca um caminho por botão. |
| `persistent` | O toast não some sozinho. É o `requireInteraction` da Notification API. O **histórico** já é persistente de qualquer forma; isto governa só a interrupção. |

Os botões aparecem **no toast e na linha do painel**. O toast some — é o que ele faz —, e uma
notificação que só pudesse ser respondida enquanto o toast estivesse na tela seria uma
notificação que expira sem avisar.

### Responder a um app sem janela

Se a notificação veio do journal (backend, sem janela aberta), não há iframe para receber o
`postMessage`. Declare para onde o shell deve mandar:

```jsonc
{"id":"backup-2026-08-02","appId":"meu-backup","body":"Backup falhou","level":"error",
 "persistent":true,
 "actions":[{"id":"retry","label":"Tentar de novo"}],
 "onAction":{"path":"api/notificacao"}}
```

O clique vira um `POST` em `/<serverId>/proxy/app/<id>/api/notificacao` — a mesma rota
autenticada que o seu app já usa, com o `X-Vssh-App-Token` injetado — com o corpo:

```json
{"event":"notify-action","notificationId":"backup-2026-08-02","actionId":"retry"}
```

`path` é **relativo ao seu app**: sem esquema, sem `..`, sem `//`. Qualquer outra coisa é
recusada na fronteira.

**Se o app tiver uma janela aberta, ela ganha** — a resposta vai por `postMessage` e o `POST`
não acontece. Um `kind:"service"` pode ter as duas coisas ao mesmo tempo, e entregar pelos dois
lados faria "tentar de novo" clicado uma vez virar dois backups.

Sem janela **e** sem `onAction.path`, o shell diz ao usuário que não há como responder, em vez
de engolir o clique.

### Notificar sem janela aberta (backend, `kind:"service"`)

`vssh.notify` é do frontend: precisa de uma janela viva para atravessar a ponte de
`postMessage`. Um daemon que termina um backup às 3h **não tem janela** — e é exatamente ele
que mais precisa avisar.

Para esse caso, o backend acrescenta uma linha ao **journal** do usuário:

```
~/.vssh-notifications/journal.ndjson
```

Um objeto JSON por linha, sem vírgula e sem colchete em volta (NDJSON):

```jsonc
{"id":"backup-2026-08-02","appId":"meu-backup","title":"Backup",
 "body":"Concluído: 4,2 GB em 12 min","level":"success","at":1754150400000}
```

| Campo | |
|---|---|
| `id` | **Obrigatório.** É a chave de deduplicação — o portal manda uma janela do fim do arquivo, então a mesma linha pode ser lida várias vezes. Linha sem `id` é descartada. Use algo estável e único para o evento (`backup-<data>`), nunca um contador que reinicia com o processo. |
| `body` | O texto. `message` também é aceito. |
| `title`, `level`, `icon` | Opcionais; mesmos valores de `vssh.notify`. |
| `appId` | Quem emitiu. Sem ele a notificação aparece como `sistema`. |
| `at` | Instante da emissão, em ms. **Vale informar:** sem ele a hora exibida é a da entrega, e para um evento que aconteceu com o desktop fechado isso é a hora errada. |

Em shell, é uma linha:

```bash
printf '%s\n' "{\"id\":\"backup-$(date +%F)\",\"appId\":\"meu-backup\",\"body\":\"Backup concluído\",\"level\":\"success\",\"at\":$(date +%s000)}" \
  >> ~/.vssh-notifications/journal.ndjson
```

**Como chega ao desktop:** o portal lê a **janela do fim** do arquivo (as últimas ~50 linhas)
no mesmo tick que já coleta a bandeja — um exec por servidor, cobrindo todos os usuários, e
nenhum canal SSH segurado entre os ticks. Quem abrir o desktop depois recebe o atraso; quem já
viu não vê de novo. A latência é de segundos, não instantânea.

**Duas consequências de ser append-only:** escreva com `>>` (nunca `>`, que apagaria o
histórico), e **rotacione você mesmo** se o app for tagarela — o portal só lê o fim, então um
arquivo grande não o atrapalha, mas ocupa o disco do usuário para sempre.

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

### Ícone na bandeja do sistema

Um ícone do seu app ao lado do relógio, com tooltip, badge e menu — para o app que **continua
fazendo algo** com a janela minimizada ou fechada:

```js
await vssh.tray.set({
  icon:    'refresh',
  tooltip: 'Sincronizando 3 de 12',
  badge:   { count: 3 },
  menu: [
    { id: 'pause', label: 'Pausar' },
    { separator: true },
    { id: 'open',  label: 'Abrir pasta', icon: 'folder_open' },
  ],
  onClick: () => vssh.window.focus(),
  onMenu:  (id) => { if (id === 'pause') pausar(); },
});

await vssh.tray.remove();
```

**Um item por app**, atualizável: chamar `set` de novo troca ícone, tooltip, badge e menu **sem o
ícone mudar de lugar** — o que importa quando o badge muda a cada segundo. Some sozinho quando a
janela fecha.

| Campo | Aceita |
|---|---|
| `icon` | nome de ícone do desktop (`refresh`, `folder`, `terminal`, `settings`…) ou caminho dentro do seu pacote |
| `tooltip` | texto no hover — diga o **estado**, não o nome do app: quem olha a bandeja quer saber como está |
| `badge` | `{ count: 3 }` · `{ dot: true }` · `{ text: '!' }` — `count: 0` **remove** o badge |
| `menu` | mesmos campos do menu de contexto; o `id` do item escolhido volta em `onMenu` |

**Devolve `false` em vez de lançar** quando não há bandeja do outro lado — fora do desktop, ou num
shell mais antigo que o seu app. Trate como "este ambiente não tem bandeja" e siga; não é erro.

#### App **sem** janela (`engine` / `service`)

`vssh.tray` é do frontend, e um `type:"engine"` ou `kind:"service"` não tem iframe — logo não tem
esta ponte. E é justamente ele que mais precisa da bandeja: não tem janela nenhuma onde aparecer.

Para ele o modelo se inverte: **estado por arquivo, ação por HTTP.** Use
[`lib/node/vssh-tray.js`](../lib/node/vssh-tray.js) (`--parts tray` no `vssh-app-lib-sync`):

```js
const { setTray, clearTray, clearTrayOnExit } = require('./vendor/vssh/node/vssh-tray.js');
clearTrayOnExit();

setTray({
  icon: 'refresh',
  tooltip: `Sincronizando ${feitos} de ${total}`,
  badge: { count: total - feitos },
  menu: [{ id: 'pause', label: 'Pausar' }],
  onClick: { path: '/tray' },      // ← o clique chega aqui, como POST
});
```

E no seu backend:

```js
// POST /tray  { event: 'click' }                   → clicaram no ícone
// POST /tray  { event: 'menu', menuId: 'pause' }   → escolheram um item do menu
```

A diferença para a versão com janela é só essa: `onClick`/`onMenu` são **um caminho**, não uma
função — a rede é assimétrica (o portal alcança o seu app pelo túnel; o seu app não alcança o
portal), então o estado é lido e a ação é entregue.

**Latência e custo:** o portal faz poll em lote — um comando por servidor a cada poucos segundos,
cobrindo todos os usuários de uma vez — e **só enquanto houver alguém com o desktop aberto**. Um
daemon rodando sem ninguém olhando não custa nada. Escrever em loop apertado não faz o ícone
aparecer mais rápido.

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
  // Chame a partir de um clique: sem gesto do usuário, devolve 'prompt' sem abrir seletor —
  // é regra do navegador, não nossa.
  if (await dir.requestPermission() !== 'granted') return;
}
```

O usuário revoga em **Permissões de arquivo**, no menu de contexto da janela do app. Trate
`'denied'` como estado normal, não como erro fatal.

Duas precisões que evitam surpresa:

- **`{ mode: 'read' | 'readwrite' }` é aceito e repassado, mas o shell ainda não distingue modo:
  todo grant dele é `readwrite`.** Pedir `{mode:'read'}` e receber `'granted'` está correto —
  readwrite satisfaz read. O parâmetro existe para o dia em que houver grant por modo.
- **Quando não há a quem perguntar, a resposta é `'granted'`.** Shell antigo sem a mensagem
  `grants`, ou desenvolvimento fora do desktop, produzem "não sei" — e "não sei" não é "não". O
  contrário faria o app pedir ao usuário uma permissão que ele já deu.

### Ser avisado quando um arquivo muda por fora

```js
const parar = await vssh.fs.watch(dir, ({ path, closed }) => {
  if (closed) return;          // a assinatura acabou; peça de novo se ainda precisar
  recarregar(path);
});
// …quando não precisar mais:
parar();
```

É a diferença entre "meu editor e o app veem o mesmo arquivo" e "tenho que lembrar de apertar
Refresh". Pega edição por SSH, `git pull`, upload pelo gerenciador de arquivos — qualquer mudança
que não passou pelo app.

**Cancele quando parar de precisar.** Cada watch segura um vigia vivo no servidor Linux, e há teto
por usuário. Fechar a janela cancela tudo automaticamente.

Não está no `fsa-polyfill` de propósito: a File System Access API não tem watch, e pendurar isto
num handle daria cara de padrão a uma extensão nossa.

### O que a persistência de handle cobre

O polyfill reidrata handles lidos do IndexedDB — sem isso o app guarda o handle, recarrega, lê de
volta um objeto sem métodos e conclui que a pasta está vazia.

| lido por | reidrata? |
|---|---|
| `IDBObjectStore.get` / `getAll` | sim |
| `IDBIndex.get` / `getAll` | sim |
| `openCursor()` (store ou índice), via `cursor.value` | sim, e continua valendo após `continue()` |
| handle aninhado (`{ handle, … }`, ou dentro de array) | sim, até 4 níveis |
| `getAllKeys()` | **não** — chave é chave, não handle |

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
| Atalho global, `powerMonitor` | Sem equivalente; normalmente dá para remover |
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
| `fs` (`op: watch`) | sim | `path`, `watchId` — a resposta confirma; as mudanças vêm por `fs-change` |
| `fs` (`op: unwatch`) | sim | `watchId` |
| `grants` | sim | `path?`, `mode?` — com `path`, booleano; sem, a lista |
| `capabilities` | sim | — |
| `open-file` / `open-folder` | não | `path` |
| `open-with` | sim | `path` |
| `tabs` | não | `tabs[]`, `activeTabId` |
| `tray` | sim | `op`: `set`\|`remove`, `item` (só dados: `icon`, `tooltip`, `badge`, `menu`) |

Do shell para o app, sem `requestId`: `open-context`, `grants`, `fs-change`, `tray-event`,
`restore-tabs`, `activate-tab`, `close-tab`, `new-tab`.

`tray-event` traz `event: 'click'|'menu'` e, no segundo caso, o `menuId` do item escolhido. As
funções `onClick`/`onMenu` não atravessam a ponte — função não serializa; o shim as guarda no lado
do app e o shell devolve só o id.

**Toda chamada com `requestId` tem timeout no shim**, e o padrão é 10 minutos — folgado porque
`pick`, `dialog` e `context-menu` esperam uma pessoa decidir, e não dá para distinguir "usuário
pensando" de "shell mudo" pelo relógio. O que importa é que termine: um shell que não conhece o
tipo simplesmente não responde, e sem timer a promise ficaria pendurada para sempre — sem resolver,
sem rejeitar e sem deixar nada no console.

**Prefira o shim.** Ele já trata correlação de `requestId`, timeout, degradação fora do desktop e o
espelho de título — e é a única coisa que não muda quando o protocolo mudar.
