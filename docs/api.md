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
| Tocar som obedecendo ao volume do ambiente | **nada** — já é automático |
| Ler o volume que o ambiente aplica | `vssh.audio.gain()` / `.muted()` / `.onChange()` |
| Falar com outro app, ou com o shell | `new BroadcastChannel(…)` — mesma origem, sem ponte nossa |
| Usar um motor sem saber o nome dele | declare `provides` no manifesto de quem oferece |
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

**Use a lib do toolkit** — `vssh-app-lib-sync . --parts notify`:

```js
const { notify } = require('./vendor/vssh/node/vssh-notify.js');

notify('Backup concluído: 4,2 GB em 12 min', { title: 'Backup', level: 'success' });

// Avisar UMA VEZ SÓ, mesmo rodando de hora em hora:
notify('Disco quase cheio', { key: `disco-${new Date().toISOString().slice(0, 10)}` });
```

Ela existe por causa do `id` — ver abaixo por que ele é fácil de errar e por que errar é
silencioso. Fora do VSSH devolve `null` sem lançar, então o seu `npm run dev` não quebra.

O formato cru, para quem não usa Node — o backend acrescenta uma linha ao **journal** do
usuário:

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
| `id` | **Obrigatório**, e a razão de a lib existir. É a chave de deduplicação: o portal manda uma janela do fim do arquivo, então a mesma linha é lida várias vezes. Errar falha **em silêncio nos dois sentidos** — id que se repete entre eventos diferentes faz o segundo nunca aparecer; id que muda para o mesmo evento faz a mesma coisa avisar várias vezes. Nunca use um contador do processo: ele reinicia junto, e o id de ontem volta a existir. |
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

## Clipboard

Duas metades, e elas **não** passam pelo mesmo caminho.

**Texto e imagem: use `navigator.clipboard` direto.** O iframe do seu app é da mesma origem
que o desktop e recebe `allow="clipboard-read; clipboard-write"`, então a API padrão funciona
aqui dentro. Não há ponte para isso, e não deveria haver: `clipboard.write()` exige ativação
transitória do usuário, e ativação **não atravessa `postMessage`** — mediar pelo shell
quebraria justamente o que a mediação existiria para permitir.

O que o shim acrescenta é o **motivo** da falha:

```js
try {
  const img = await vssh.clipboard.readImage();     // Blob, ou null se não havia imagem
} catch (e) {
  if (e.reason === 'no-user-activation') { /* chame de dentro de um clique */ }
  if (e.reason === 'denied')             { /* o usuário negou a permissão */ }
  if (e.reason === 'unsupported')        { /* navegador sem clipboard.read */ }
}

await vssh.clipboard.writeImage(blob);
```

`NotAllowedError` genérico é a diferença entre abrir uma issue e consertar em dois minutos:
as três causas chegam com o **mesmo** nome de erro, e só o estado do documento as distingue.

**Arquivos: use a ponte.** O clipboard de arquivos é do shell — quem guarda `{action, paths}`
é o gerenciador de arquivos, e nenhuma API de navegador o alcança. É esta metade que faz
"copiar no gerenciador, colar no app" existir, e o inverso.

```js
const clip = await vssh.clipboard.files();          // {action:'copy'|'cut', paths:[]} | null

await vssh.clipboard.setFiles(['/home/ana/relatorio.pdf']);   // agora dá para colar no gerenciador

const parar = vssh.clipboard.onChange((clip) => { /* mudou, inclusive por fora do app */ });
```

`setFiles` sempre **copia**. Recortar move arquivo do usuário na próxima colagem, e isso
continua sendo do gerenciador, onde ele vê o que está fazendo.

`onChange` devolve a função que cancela — e cancelar importa se o seu app monta e desmonta
componentes.

> **Sem X11 não há clipboard do Linux para sincronizar**, e isso está declarado:
> `clipboardServer: false` em `vssh.capabilities()`. Tudo acima funciona igual nos dois
> perfis — é DOM e é do shell.

### Imprimir

```js
const path = await vssh.pickFile();
await vssh.print(path);            // abre a tela de impressão do desktop
```

O app **não imprime**: ele pede a tela. Quem escolhe o destino e confirma é o usuário — mesmo
padrão de `dialog` e `pick`. Resolve assim que a tela **abre**, não quando o usuário imprime;
devolve `false` fora do desktop ou num shell sem suporte.

O caminho é um arquivo **do servidor**. O destino que o desktop oferece primeiro é a fila CUPS
do próprio servidor, e a razão vale saber ao projetar o app: **ali o arquivo não viaja**.
Imprimir um PDF de 200 páginas pelo navegador significa baixá-lo inteiro antes de imprimir.

"Imprimir no navegador" aparece como alternativa para o que o navegador sabe renderizar (PDF,
imagem, texto, HTML). Para os demais tipos ele não aparece — abriria uma janela em branco, e o
usuário acharia que a impressão falhou.

Se o servidor não tem CUPS — o caso comum no perfil sem X11 — a tela diz isso com essas
palavras, em vez de mostrar uma lista vazia.

### Som: o ambiente é o mixer, e você não precisa fazer nada

O desktop tem um mixer de volume na barra, com uma barra geral e uma linha por aplicativo. **O seu
app já obedece a ele**, sem chamar nada, sem configurar nada:

```js
new Audio('/algo.mp3').play();      // respeita o volume do app no mixer
ctx.createOscillator().connect(ctx.destination);   // este também
```

O shim cuida das duas vias, que são diferentes porque `<audio>` e Web Audio não se alcançam pelo
mesmo lugar: ele **multiplica** o volume dos elementos de mídia e **interpõe um `GainNode`** no
que vai para `ctx.destination`.

**Multiplica, não sobrescreve** — e é a diferença que importa para quem escreve o app:

```js
el.volume = 0.5;        // "metade do meu volume máximo"
// usuário põe este app em 40% no mixer → sai 0.2
el.volume;              // 0.5 — você continua lendo o SEU valor
```

Se o shim sobrescrevesse, o seu próximo `el.volume = 1` desfaria o mixer sem ninguém entender por
quê. Pelo mesmo motivo, **não reaja ao mixer escrevendo `el.volume`**: isso é o que o shim já faz,
e escrever por cima só desfaz a conta.

Para quem desenha o próprio controle de volume ou quer pausar trabalho enquanto está mudo:

```js
vssh.audio.gain();                       // 0 a 1, já com o mudo aplicado
vssh.audio.muted();
const parar = vssh.audio.onChange(({ gain, muted }) => desenharBarrinha(gain, muted));
```

Fora do desktop, `gain()` devolve `1` e `muted()` devolve `false` — o app toca normal em dev.

> **Uma consequência de projeto:** só aparece no mixer o app que o desktop **consegue controlar**.
> Um app que toca por Web Audio e **não carrega o shim** é invisível lá — não porque foi esquecido,
> mas porque um slider que não morde é pior que slider nenhum. Carregar o shim é o que põe o seu
> app na lista. Ver [SKILL.md](../.claude/skills/vssh-app/SKILL.md) para os dois passos do
> vendoring.
>
> Isso **não** depende de Xpra: no perfil sem X11 o mixer controla exatamente as mesmas fontes,
> porque todas elas são elementos do documento do desktop ou de iframes mesma-origem. O que muda
> é só que a linha "Sessão remota" (o stream do Xpra) não existe lá.

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

### A terceira resposta: tenho a permissão, e não tenho o handle

O grant mora **no usuário** (ele viaja com a pessoa para qualquer computador). O handle mora no
`IndexedDB`, que é **por perfil de navegador** — e não viaja. Num computador novo, um app acorda
sem handle nenhum e com a permissão já concedida: não é `granted` (não há por onde ler) nem
`denied` (ninguém negou nada). É *"a escolha já foi feita, e a prova dela ficou na outra máquina"*.

Tratar essa terceira resposta como uma das outras duas dá um app que ou pede de novo a pasta que já
tem, ou tenta ler de um handle morto. A saída é reabrir **sem seletor** o que já está concedido:

```js
// No boot, ANTES de mostrar "abrir pasta": o que este app já pode tocar?
const [meuGrafo] = await vssh.fs.grantedHandles();   // handles, sem abrir seletor
if (meuGrafo) await carregar(meuGrafo);
else          await carregar(await showDirectoryPicker());
```

| | |
|---|---|
| `vssh.fs.grantedPaths()` | **síncrono** — os caminhos concedidos a este app, inclusive de sessões anteriores e de outras máquinas |
| `vssh.fs.grantedHandles()` | os mesmos, como handles da FSA. Um `stat` por caminho decide `file`/`directory`, e **o que não existe mais some da lista** em vez de virar handle morto |

Isto **não contorna o consentimento** — o consentimento já aconteceu, uma vez, quando a pessoa
escolheu a pasta num seletor. O que faltava não era permissão: era um objeto para representá-la
nesta máquina.

### Existe? Renomear, mover, copiar

```js
if (await vssh.fs.exists(destino)) { /* … */ }

await vssh.fs.rename('/casa/proj/rascunho.md', '/casa/proj/final.md');   // rename É o mover
await vssh.fs.copy('/casa/proj/final.md', '/casa/backup/final.md');
await vssh.fs.rename(a, b, { overwrite: true });                         // opt-in explícito
```

Três precisões, e cada uma existe por um modo de falha concreto:

- **`exists()` devolve `false` só quando o arquivo não existe.** Falta de permissão, servidor fora
  ou rede piscando **lançam**. Isso parece pedante até você notar o que o idioma comum faz:

  ```js
  const existe = await stat(p).then(() => true).catch(() => false);   // ⚠ não faça
  ```

  Ali, três respostas viram duas. "Não pude perguntar" vira "não existe", e o app cria por cima de
  um arquivo que estava lá — ou conclui que a pasta do usuário está vazia porque um `fetch` falhou.
  **Não escreva `exists(p).catch(() => false)`**: é exatamente o colapso que esta função existe
  para evitar.

- **Origem e destino precisam AMBOS estar concedidos.** Quem impõe é o shell, e a recusa é 403
  nomeando o caminho reprovado. Sem os dois lados, um `rename` levaria um arquivo do usuário para
  fora do que ele autorizou, e um `copy` traria para dentro algo que o app não podia ler — e as
  duas operações **sucederiam**, sem erro nenhum.

- **Destino existente falha.** `{ overwrite: true }` é a forma de dizer que você quer mesmo.
  Sobrescrever sem pedir não tem desfazer.

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

### OPFS — cada app tem a sua raiz, e ela é cache

`navigator.storage.getDirectory()` funciona: é nativo do navegador, e é o que DuckDB-WASM,
sqlite-wasm e Pyodide usam para cache local. O polyfill não o reimplementa — **ele o isola**.

```js
const raiz = await navigator.storage.getDirectory();   // a SUA raiz, não a da origem
```

> **Por que isso precisou de conserto.** OPFS é privado por **origem**, e todos os vssh-apps são
> servidos pela origem do portal. Sem isolamento, um app lia — e sobrescrevia — o `cache.db` de
> outro. O *"Origin Private File System"* é privado de outros **sites**, não de outros **apps**.
> Cada app passa a receber um subdiretório próprio, nomeado pelo seu id. O handle continua sendo
> **nativo**, então `createSyncAccessHandle()` e o resto funcionam sem nada nosso no caminho.
>
> Fora do proxy (`npm run dev`) nada é isolado: não há outro app com quem colidir, e esconder o
> armazenamento de quem está desenvolvendo seria pior.

⚠️ **OPFS é cache, nunca a verdade.** O padrão natural do `sqlite-wasm` é usar OPFS como
armazenamento **primário** — e isso perde tudo quando o usuário troca de máquina, **sem erro
nenhum**. O ponto do VSSH é o pesquisador pular de um computador para outro sem perder nada; todo
estado guardado no navegador é dívida contra isso.

A verdade vai para o ambiente remoto — o filesystem do usuário (`showDirectoryPicker`) ou o backend
do seu app. OPFS é aceleração **reconstruível**: se ele sumir, o app fica lento, não amnésico.

### O que o polyfill faz, e o que ele não faz

| chamada | |
|---|---|
| `showDirectoryPicker` · `showOpenFilePicker` · `showSaveFilePicker` | sim, e `types`/`accept` viram o filtro do seletor |
| `startIn` **sendo um handle** | sim — abre no caminho dele |
| `handle.move(nome)` · `.move(pasta)` · `.move(pasta, nome)` | sim, e o handle se atualiza no lugar |
| `handle.remove({recursive})` · `dir.removeEntry(nome, {recursive})` | sim, **e recusam pasta cheia sem a flag** |
| `handle instanceof FileSystemHandle` | sim — inclusive na classe base |
| persistência de handle em IndexedDB | sim, até 4 níveis de aninhamento |
| `showOpenFilePicker({multiple:true})` | **não** — o seletor do desktop é de escolha única. Devolve 1 e **avisa** |
| `startIn: 'documents'` e afins | **não** — o shell não resolve diretórios XDG. **Avisa** |

> **`removeEntry` recusa apagar uma pasta com conteúdo**, como manda a especificação — o erro é
> `InvalidModificationError`. Isso merece nota porque a API de arquivos do portal por baixo é um
> `rm -rf`: sem essa guarda, `removeEntry('pasta')` apagaria tudo em silêncio. Se você quer mesmo,
> `{ recursive: true }` é explícito.

**Limites do `File` preguiçoso**, que valem conhecer antes de portar. Cada linha é medida num
Chrome de verdade em `lib/web/test/fsa-polyfill.browser.test.js` — inclusive as duas últimas:

| caminho | funciona? |
|---|---|
| `await file.text()` / `.arrayBuffer()` / `.bytes()` / `.stream()` | sim |
| `file.slice(a, b)` | sim — lê **só a faixa**, por `Range` HTTP, sem leitura prévia |
| `URL.createObjectURL(file)` → `<img src>` | sim — vira URL HTTP do portal, com Range |
| `new Response(f)` · `new Request(…, {body: f})` · `fetch(url, {body: f})` | sim — o corpo vira o stream do arquivo |
| `FileReader.readAsText` / `ArrayBuffer` / `DataURL` / `BinaryString` | sim |
| `new Blob([f])` · `FormData.append(nome, f)` | **não** — 0 bytes, **com aviso no console** |

Os dois últimos leem a sequência de bytes do `Blob` de forma **síncrona**, e não há onde encaixar
a busca do conteúdo. Eles passam a funcionar sozinhos assim que o arquivo tiver sido lido uma vez
(`await file.arrayBuffer()`), porque aí os bytes já existem — e é essa a saída recomendada:

```js
await file.arrayBuffer();          // ou .text(), ou qualquer leitura
new Blob([file]);                   // agora carrega o conteúdo
```

Enquanto isso não acontecer, os dois **avisam no console** em vez de devolverem vazio em silêncio.
O modo de falha que isso encerra vale ser explícito: `new Blob([f])` devolvia `size` correto com
conteúdo vazio, e um `FormData` subia `filename="nota.md"` com zero bytes — um upload perfeitamente
formado de um arquivo em branco, sem erro nenhum em lugar nenhum.

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
// { nativeApps, x11Interop, keyboardGrab, sessionStats, host, shellVersion, libVersion }
```

`nativeApps: false` significa **ambiente sem Xpra**: não existe programa Linux com UI para lançar,
e o "Abrir com" é habitado só por vssh-apps. Não é um recurso faltando — é uma categoria que não
existe ali. Use isto para esconder o que não faz sentido, nunca para degradar o essencial.

`vssh.inDesktop` (síncrono) responde a pergunta mais simples: estou dentro do VSSH ou no seu
`npm run dev`?

### TypeScript

`lib/web/vssh-app-shim.d.ts` vem junto na vendorização e declara a superfície inteira. **Não é um
módulo**: o shim entra por tag `<script>` e escreve em `window`, então o arquivo é uma declaração
global — inclua-o e pronto.

```jsonc
// tsconfig.json
{ "include": ["src/**/*", "frontend/vendor/vssh/web/*.d.ts"] }
```

Depois disso `vssh.` autocompleta, `window.vssh` tem tipo, e `caps.shellVersion` já vem como
`string | null` — o que força a tratar o "não sei" no lugar certo.

O arquivo é conferido contra o código, não escrito de memória: `lib/web/test/tipos.test.js` carrega
o shim, enumera a superfície real em runtime e compara nos dois sentidos. Membro que existe e não
está declarado reprova, e declarado que não existe também — porque os dois estragos são
silenciosos, e opostos: um faz o compilador recusar código que funciona, o outro faz o editor
autocompletar algo que quebra em produção.

> **`electron-shim` e `tauri-shim` não trazem `.d.ts`, e é de propósito.** Um app portado já usa
> `@types/electron` ou `@tauri-apps/api`, que declaram aquelas superfícies inteiras. Publicar uma
> segunda declaração do mesmo nome não somaria informação: ou conflita, ou vence a de upstream e
> passa a esconder o que o nosso shim **não** implementa — que é a metade que quem porta precisa
> enxergar. Consulte a tabela de cada shim em [`porting.md`](porting.md).

### As duas versões, e por que elas vêm em par

| campo | o que é | quem sabe |
|---|---|---|
| `shellVersion` | a versão **declarada** do desktop que hospeda o app | o shell responde |
| `libVersion` | a versão das libs do toolkit que **este app** carrega | está embutida no shim |

Elas respondem perguntas diferentes e nenhuma das duas sozinha basta. O app é vendorizado: ele leva
uma cópia das libs no tarball, e essa cópia envelhece independente do desktop, que é deployado por
outra gente em outro momento. **Versão dessincronizada é a regra, não a exceção** — e sem o par,
um relato de "não funciona" não diz qual combinação estava em jogo.

O uso mais barato, e o que se paga na primeira depuração remota, é carimbar o par no seu log:

```js
const { shellVersion, libVersion } = await vssh.capabilities();
log('ambiente', { shellVersion, libVersion });     // lib/node/app-log.js
```

`libVersion` também está em `vssh.libVersion`, **síncrono** — é conhecido dentro do shim e não
depende de perguntar a ninguém.

`shellVersion: null` é resposta legítima, e quer dizer *"este shell é antigo demais para se
declarar"* — não é erro. Trate como desconhecido:

```js
const versao = caps.shellVersion ?? 'desconhecida';
```

> **Isto não é o gate de compatibilidade.** `capabilities()` responde **em runtime**, no ponto de
> uso, e quem decide o que fazer com o "não" é o app — degradar, esconder um botão, avisar. O gate
> que recusa **no publish**, contra um número declarado no manifesto (`minShellVersion`), é outra
> coisa e está na [Onda 5](roadmap/04-runtime-composicao.md#o-contrato-do-manifesto-um-schema-uma-validação-uma-guarda).
> Construir um e achar que o outro ficou resolvido é o erro natural aqui.

---

## Com o que você pode contar quando a rede pisca

O desktop **não se desmonta** porque o portal ficou fora do ar. Ele é JS rodando no navegador: uma
queda do portal é uma requisição que falha, não uma desconexão. As janelas continuam abertas, e a
sua entre elas.

Isso muda o que você deve escrever no seu app:

- **não feche a sua janela porque um `fetch` falhou.** Mostre o estado e ofereça "tentar de novo" —
  o ambiente ao redor continua vivo, e fechar é a única coisa que o usuário não consegue desfazer;
- **não apague o que já está na tela num `catch`.** Uma lista que o servidor já entregou é dado
  bom; substituí-la por vazio porque a atualização falhou faz o conteúdo piscar e sumir sem
  explicação;
- **não recarregue a página.** `location.reload()` de dentro de um app derruba o desktop inteiro,
  não só o seu app.

O desktop já avisa por você: quando o portal não responde, aparece um aviso na bandeja dizendo que
o que está aberto continua ali e que ele avisa quando voltar. Você não precisa construir esse aviso
— precisa não contradizê-lo.

**A garantia é estreita, e vale saber onde ela acaba:** uma escrita que falhou continua perdida, e
nada disso vale para o **seu backend**. Se o processo do seu app cair, o seu app cai — o que
sobrevive é o desktop em volta dele. Não é offline mode.

---

## Falar com outro app

Não há API nossa para isto, e é de propósito: **use `BroadcastChannel`**.

```js
const canal = new BroadcastChannel('meu-app:indice');
canal.postMessage({ tipo: 'reindexado', arquivos: 128 });
canal.onmessage = (e) => { /* … */ };
```

Funciona entre dois vssh-apps, entre o seu app e o shell, e entre duas janelas do mesmo app —
porque **shell e apps compartilham uma origem só**. O seu backend é servido por caminho relativo
na origem do portal (`/<serverId>/proxy/app/<seu-id>/`), não por subdomínio, e a janela do app não
é um iframe sandboxed. Pelo mesmo motivo funcionam o `localStorage` compartilhado e o `postMessage`
sem `targetOrigin`.

Construir uma ponte nossa em cima disso seria embrulhar o que o navegador já faz melhor — e
acrescentar um lugar a mais onde a mensagem pode se perder.

**Onde isto acaba, e vale saber:** a mesma origem única é o que torna o isolamento entre apps
fraco. O modelo hoje é *"um admin instalou, portanto é confiável"* — outro app da mesma sessão
**escuta os seus canais**. Não mande por `BroadcastChannel` o que você não mandaria por um mural.
Se um dia houver origem separada por app, isto para de funcionar e a mensageria passará a
atravessar o shell; o seu código muda nesse dia, e não antes.

---

## O que **não** existe

Ser honesto aqui vale mais que a lista de cima, porque é o que decide se o seu port é viável.

| Não existe | O que fazer |
|---|---|
| Menubar de aplicação (`Menu` do Electron) | Menu de contexto + UI própria dentro da janela |
| Atalho global, `powerMonitor` | Sem equivalente; normalmente dá para remover |
| `setSize`/`setPosition` da janela | Tamanho inicial pelo manifest; depois é do usuário |
| Badge/progresso na taskbar | — |
| Abrir uma janela com **conteúdo de fora** (URL arbitrária, `new BrowserWindow` de outra origem) | `vssh.window.abrir(rota)` abre outra janela **do seu app**, num caminho relativo. Ver a nota abaixo |
| `child_process`, binário nativo, FTS server-side | **Backend do seu app** — é para isso que ele existe |
| `ipcRenderer.invoke('<comando seu>')` | Idem: vira uma rota HTTP no seu backend |

A última linha é a fronteira real de um port de Electron/Tauri: o shim cobre a **superfície padrão**
do framework, não o que aquele app inventou. Como medir isso antes de começar está em
[porting.md](porting.md).

> **Várias janelas do mesmo app existem, e há dois caminhos até elas.** O usuário pede uma cópia
> em **Nova janela**, no menu de contexto da janela. O app pede a sua com
> `vssh.window.abrir(rota, { title, width, height })`:
>
> ```js
> await vssh.window.abrir('?painel=notas', { title: 'Notas', width: 380, height: 520 });
> ```
>
> **É a `rota` que separa a janela EXTRA da cópia.** Sem ela, a janela nova abre a mesma página —
> útil para ver dois pedaços do mesmo documento lado a lado. Com ela, o app escolhe o que vai
> dentro: um painel, uma prévia, um segundo documento. `rota` é um caminho **dentro do seu app**,
> relativo, como todo `fetch` que você escreve; URL absoluta, `javascript:` e `..` são recusados
> pelo shell, porque a janela leva o título e o ícone do seu app e servir outra coisa ali seria o
> material de uma tela falsa.
>
> O que muda para quem escreve o app: **o backend continua sendo um só**. As janelas são visões do
> mesmo processo, como abas do navegador no mesmo servidor — mesma porta, mesmo token, mesmo
> `VSSH_APP_DATA_DIR`. Um app que guarda estado de UI no backend como se houvesse um cliente só vai
> ver as janelas disputando esse estado; guarde por conexão (ou no `localStorage` do próprio
> frontend, que é por origem e vale para todas).
>
> Notificação com ação e o veredito do healthcheck vão para **uma** janela — a última que teve
> foco. É deliberado: entregar às duas faria a ação acontecer duas vezes.
>
> `abrir()` devolve `false` num shell anterior a esta capacidade — versão dessincronizada é a
> regra, não a exceção. Trate como "aqui não dá" e siga; não é erro.

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
| `fs` | sim | `op`: `list`\|`stat`\|`read`\|`readBytes`\|`write`\|`writeBytes`\|`mkdir`\|`delete`\|`exists`, `path` |
| `fs` | sim | `op`: `rename`\|`copy` — **`from` e `to`** em vez de `path`, e o gate confere os dois |
| `fs` (`op: watch`) | sim | `path`, `watchId` — a resposta confirma; as mudanças vêm por `fs-change` |
| `fs` (`op: unwatch`) | sim | `watchId` |
| `grants` | sim | `path?`, `mode?` — com `path`, booleano; sem, a lista |
| `capabilities` | sim | — |
| `open-file` / `open-folder` | não | `path` |
| `open-with` | sim | `path` |
| `tabs` | não | `tabs[]`, `activeTabId` |
| `tray` | sim | `op`: `set`\|`remove`, `item` (só dados: `icon`, `tooltip`, `badge`, `menu`) |
| `audio-state` | sim | `hasAudio`, `playing` — "tenho som"; é o que põe o app no mixer |

Do shell para o app, sem `requestId`: `open-context`, `grants`, `fs-change`, `tray-event`,
`volume`, `restore-tabs`, `activate-tab`, `close-tab`, `new-tab`.

`volume` traz `{ gain, muted }` e chega a cada mexida no mixer. Sem o shim, aplicá-lo é por sua
conta — e o `audio-state` também: o shell **enxerga** os seus `<audio>`, mas não tem como saber
que existe um `AudioContext` aí dentro, e é o relato que faz o app aparecer no painel.

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
