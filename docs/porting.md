# Portar um app existente para vssh-app

Árvore de decisão, e o que cada caminho custa. As regras vieram de um port real levado até rodar
num servidor — ver [lessons/logseq-port.md](lessons/logseq-port.md).

## A decisão, em duas perguntas

> **⚠ Esta página fazia uma pergunta só, e isso estava errado.** A árvore era ordenada por *custo de
> rodar*, terminava em *"o shim resolve"*, e não mencionava **uma única vez** o que o ambiente
> oferece a um app — nem linkava [`api.md`](api.md), que é o inventário disso. Quem entrava por aqui
> nunca era levado à página que descreve como um app vira cidadão do ambiente, e o resultado
> previsível é um app que sobe, aparece num iframe e não é cidadão de nada. **Rodar é a primeira
> pergunta, não a única.**

### 1. O app já roda num navegador hoje? — decide o custo de **rodar**

| Situação | Caminho | Custo de rodar |
|---|---|---|
| Sim, tem build web (dual-target) | Rodar o **modo web** + `fsa-polyfill` | Baixo — normalmente sem fork |
| Não, é Electron-only | **Extrair o renderer** e medir o buraco (abaixo) | Médio; o resto vira backend próprio |
| Não, é Tauri | Extrair o frontend + `tauri-shim` | Baixo a médio |
| Não, e é GUI nativa (Qt/GTK) | Não portar: rodar como janela X11 no Xpra | Zero, enquanto houver Xpra |

### 2. O que ele contribui com o ambiente? — decide o custo de **integrar**

Não se responde com o mesmo dado da primeira, e é a coluna que decide se o port entregou um
**aplicativo** ou um servidor dentro de um iframe. A referência completa é [`api.md`](api.md);
abaixo, o que costuma ser pedido:

| O que se quer | Custo de integrar | Onde está |
|---|---|---|
| Diálogo, notificação, seletor de arquivo, "abrir com" | **zero** — já pronto | `vssh.dialog.*`, `vssh.notify`, `vssh.pickFile`, `vssh.openWith` |
| Ler e gravar arquivos do usuário | **zero** — já pronto | `fsa-polyfill`, a FSA padrão do W3C |
| Janela de verdade: título, abas, menu de contexto do cabeçalho | baixo | `window.richChrome`, `vssh.window.*` |
| Ser aberto ao clicar num arquivo | baixo | `opens.extensions` + o evento `open-context` |
| Substituir um launcher embutido (terminal, editor, navegador…) | baixo | `handles` |
| Preferências dentro da tela de Configurações do ambiente | baixo | `contributes.settings` |
| Item no menu de contexto do ambiente (arquivo, pasta, área de trabalho) | baixo | `contributes.contextMenu` — ver [`api.md`](api.md#ter-item-próprio-no-menu-de-contexto-do-ambiente) |
| Item no menu do ícone no Launchpad (jump list) | **não existe** | falta o segundo verbo, não a superfície — item 4 da [Onda 9](roadmap/08-editor-do-ambiente.md) |

> **⚠ Duas linhas desta tabela estavam certas e ficaram erradas.** Ela dizia que
> `contributes.settings` era *"o único mecanismo de contribuição completo que existe hoje"* e que
> item de menu de contexto *"não existe"*. As duas eram verdade quando foram escritas; o item 4 da
> Onda 9 acrescentou `contributes.contextMenu`, e o que continua sem existir é só a **jump list**
> do ícone do Launchpad — por falta de um segundo verbo, e não da superfície.

**A regra que sai daí:** um app que respondeu "nada" à segunda pergunta não está pronto para ser
portado — está pronto para ser **redesenhado**. É o mesmo formato do critério 3.2 em
[`roadmap/criterios.md`](roadmap/criterios.md), e pela mesma razão.

### 3. Ele vai *parecer* uma janela do ambiente? — decide o custo de **pertencer**

> **⚠ Esta pergunta faltava nesta página, e a omissão tinha nome.** O critério 3.3
> ([`roadmap/criterios.md`](roadmap/criterios.md#33--está-belo)) é condição de pronto — *"a promessa
> é que o usuário esqueça que está num navegador"* — e ele registra, com todas as letras, que
> **nenhum vssh-app passava por ele**, porque *"vssh-app não é item de onda: é pacote publicado por
> fora, e a única página que quem porta lê inteira é `porting.md`"*. Ou seja: o critério que existe
> para o usuário esquecer que está num navegador não alcançava exatamente as janelas que mais
> parecem uma página web dentro de uma. Esta seção é a correção.

| O que se quer | Custo | Onde está |
|---|---|---|
| Paleta, tipografia, scrollbar e foco do ambiente | **baixo** — um `<link>` | [`ui.md`](ui.md) |
| Botão, campo, select, switch, lista, abas, estado vazio… | zero — já pronto | `.tuff-*`, ver [`ui.md`](ui.md#os-componentes) |
| Ícones do ambiente | zero — já pronto | `<use href="#ico-…">`, 87 símbolos |
| Acompanhar a cor de destaque do usuário | zero com a biblioteca; baixo sem ela | `vssh.aparencia` |
| Player, grade de miniaturas, zoom/arraste | baixo | as peças de mídia, opt-in |
| Diálogo, menu, aviso, seletor | **zero, e não desenhe** | `vssh.dialog`, `vssh.contextMenu`, `vssh.toast`, `vssh.pickFile` |

**Um app que já tem identidade visual própria não precisa adotar nada disso** — o `recoll` tem tema
claro e continua claro. Mas mesmo ele ganha em ler `vssh.aparencia`: é o que faz a janela acompanhar
a cor que a pessoa escolheu, e é a diferença entre um app que mora no ambiente e um que está
hospedado nele.

> A adoção é **sempre explícita**, no backend do seu app. Atualizar o toolkit nunca reestiliza um app
> que não pediu.

---

## App dual-target (Electron + web)

**Rode o modo web e não ligue o caminho Electron.** Isso não é preguiça — é a escolha certa, e há
dado: no Logseq, ativar o caminho Electron (que é detectado por User-Agent) **troca três
implementações que já funcionam no navegador por IPC a implementar no servidor**:

| | modo web | modo Electron |
|---|---|---|
| Busca full-text | dentro do navegador | precisa de índice FTS server-side |
| Persistência | IndexedDB | precisa de `saveGraph`/`getSerializedGraph`/… |
| URL de asset | relativa | protocolo `assets://`, que não existe fora do Electron |

O que o modo web costuma pedir é acesso a arquivos — e é exatamente o que o `fsa-polyfill` entrega,
**sem o app rodar backend de filesystem nenhum**.

> **⚠ E a coluna "IndexedDB" não é um ponto ganho — este texto a vendia como se fosse.** Pelo
> critério 3.2 ([`roadmap/criterios.md`](roadmap/criterios.md#32--isso-sobrevive-à-troca-de-máquina)),
> **todo estado guardado no navegador é dívida**: quem troca de máquina perde. A leitura certa é que
> o modo web te poupa de **implementar** persistência agora, não que a persistência esteja resolvida.
> A verdade vai para o ambiente remoto; o que fica no navegador é cache reconstruível. Um port que
> encerra com o grafo do usuário só em IndexedDB passou na primeira pergunta e reprovou na segunda.

**Um limite do polyfill que vale conhecer antes de portar.** O `File` devolvido por `getFile()` é
preguiçoso: busca o conteúdo só quando alguém pede de verdade. Isso é o que torna viável abrir um
diretório grande (o padrão de chamada dos apps é pedir o `File` de todo arquivo antes de filtrar).
O custo é que ele não é um `Blob` completo para quem lê o **estado interno** em vez de chamar
métodos — e sobraram exatamente dois caminhos assim:

| caminho | funciona? |
|---|---|
| `.text()` / `.arrayBuffer()` / `.bytes()` / `.stream()` · `file.slice(a, b)` | sim |
| `URL.createObjectURL(file)` → `<img src>` | sim — interceptado, vira URL HTTP do portal |
| `new Response(f)` · `new Request` · `fetch(url, {body: f})` · `FileReader.*` | sim — interceptados |
| `new Blob([f])` · `FormData.append` | **não** — 0 bytes, e avisam no console |

Os dois últimos são síncronos: leem os bytes na hora, e não há onde encaixar a busca. Materialize
antes — `await file.arrayBuffer()` uma vez e eles passam a funcionar sozinhos.

`slice()` merece nota própria porque é o que decide se um leitor por blocos (Parquet, HDF5, Zarr,
DICOM) roda: ele lê **só a faixa pedida**, por `Range` HTTP, sem baixar o arquivo. Abrir um arquivo
de gigabytes para ler alguns kilobytes de índice custa alguns kilobytes.

**Permissão, e o que o app precisa tratar.** O grant persiste entre sessões — é o par necessário
da persistência de handle, já que um handle restaurado sem grant é um handle morto. Mas o usuário
pode revogar, e aí `queryPermission()` responde `'prompt'` em vez de `'granted'`. Um app que
presume `'granted'` (comum: o código foi escrito para um navegador, onde a permissão morre a cada
carga, e alguém "simplificou" a checagem no port) falha na primeira operação em vez de pedir de
novo. `requestPermission()` reabre o seletor, que é o caminho de volta.

---

## App Electron-only: extrair o renderer e medir

O renderer de um app Electron é uma página web. Extraí-la e servi-la pelo `static-spa` é a parte
fácil; o que decide a viabilidade é **o que aquele renderer toca além do DOM**.

### Inventário da superfície, classificado

- **(a) já coberto** por `vssh-app-shim` + `fsa-polyfill` + `electron-shim`
- **(b) barato** — cabe no shim com pouco trabalho
- **(c) exige backend próprio** do vssh-app

| O que o renderer usa | Classe | Como fica |
|---|---|---|
| `dialog.showOpenDialog` / `showSaveDialog` | **a** | Picker do desktop, com grupos de filtro |
| `dialog.showMessageBox` / `showErrorBox` | **a** | `VsshDialogs` |
| `shell.openExternal` | **a** | Navegador do ambiente (`vssh.openUrl`) |
| `shell.openPath` / `showItemInFolder` | **a** | `FileOpener` / gerenciador de arquivos |
| `Notification` / `new Notification()` | **a** | `Toast` |
| `clipboard.readText` / `writeText` | **a** | `navigator.clipboard` |
| `require('fs')` no renderer (nodeIntegration) | **a** | Reescrever chamadas para a FSA; o polyfill cobre a semântica |
| `app.getPath('userData'|'documents'|…)` | **b** | Pasta escolhida pelo usuário, ou `$VSSH_APP_DATA_DIR` via backend |
| `BrowserWindow` (minimizar/maximizar/fechar/título) | **b** | A janela é do shell; o app pede pelo `postMessage` |
| `Menu` / `MenuItem` (menu de aplicação) | **b** | Só menu de contexto e tabbar existem hoje; menubar completo não tem mecanismo |
| `protocol.registerFileProtocol` (`app://`, `assets://`) | **b** | Servir pelo `static-spa` com `aliasPrefixes` ou rota própria |
| `ipcRenderer.invoke('<comando do app>')` | **c** | É lógica escrita sob medida — vira backend do vssh-app |
| API de preload via `contextBridge` | **c** | Idem: superfície bespoke daquele app |
| `child_process` / binário nativo (`.node`) | **c** | Backend próprio, com o binário vendorizado |
| `autoUpdater` | **c** | Não se aplica: quem atualiza é `vssh-app-publish` + `vssh-app-install` |
| Tray, global shortcuts, `powerMonitor` | **c** | Sem equivalente; normalmente dá para remover |

### O que "99%" significa aqui, e como confirmar

As classes (a) e (b) cobrem **a superfície comum** — o que quase todo app Electron usa por ser
Electron. A classe (c) é o que aquele app específico inventou.

A afirmação honesta é: **o shim cobre a superfície padrão do Electron; ele não cobre o que o app
escreveu de próprio.** Que fração dos apps isso resolve depende inteiramente de quanto cada app
colocou em (c) — e isso não dá para saber sem olhar.

Como medir, por app, em minutos:

```bash
# 1. Quantos handlers bespoke existem do lado do main?
grep -rn "ipcMain.handle\|ipcMain.on" src/ | wc -l

# 2. O que o renderer efetivamente invoca?
grep -rhn "ipcRenderer.invoke(\|ipcRenderer.send(" src/ | grep -oE "'[^']+'" | sort -u

# 3. Tem preload com API própria?
grep -rn "contextBridge.exposeInMainWorld" src/
```

O resultado de (2) é a lista de classe (c) daquele app. **Se for curta e as chamadas forem finas
(ler/escrever arquivo, abrir diálogo), o shim resolve.** Se for longa ou envolver processamento
pesado, aquilo é o backend do vssh-app — e escrevê-lo é o trabalho do port, não um contratempo.

**"O shim resolve" fecha a primeira pergunta, não o port.** Ele responde *roda?*, e a página parava
aqui. Falta a segunda: com o renderer no ar, volte à tabela de integrar — porque é ali que se decide
se o que subiu é um aplicativo do ambiente ou uma página hospedada dentro dele.

Ponto de referência: o Logseq tem **98** `defmethod handle` no processo main. Um app com esse
perfil não é "quase pronto" — mas também não precisaria de todos eles, porque o modo web dele já
resolve busca, persistência e assets sem nenhum.

### Por que o transporte não é o problema

Reimplementar `ipcRenderer` sobre HTTP são ~150 linhas. O caro nunca foi o cano — são os handlers
do outro lado. Uma camada de IPC genérica entrega o cano e **zero** dos handlers, e é por isso que
o `electron-shim` cobre a API padrão em vez de tentar ser um `ipcRenderer` universal.

---

## App Tauri

Melhor caso que Electron, por uma razão estrutural: a superfície de `@tauri-apps/api` (`fs`,
`dialog`, `shell`, `notification`, `path`, `os`, `event`, `clipboard`) é **fixa e documentada**, não
escrita sob medida por cada app. `lib/web/tauri-shim.js` a implementa sobre o shell.

O limite é o mesmo, no mesmo lugar: **`invoke()` de comando Rust customizado (`#[tauri::command]`)
não tem tradução genérica**. Ele é o equivalente exato do handler bespoke do Electron — e mede-se
do mesmo jeito:

```bash
grep -rn "#\[tauri::command\]" src-tauri/ | wc -l
```

---

## Onde o backend do port escuta

**Um vssh-app não escuta numa porta.** Desde a Onda 9 o endereço é um **socket unix** em
`$VSSH_APP_SOCKET` (`~/.vssh-apps/<id>/app.sock`), derivado da identidade — não alocado. Se o seu
backend é Node, a linha é uma:

```js
const { escutar } = require('vssh-app-toolkit/listen');   // npm i github:colabhd/vssh-app-toolkit#v4
await escutar(server);
```

**Isto é onde um port costuma bater primeiro**, porque a ferramenta que você está portando quase
sempre tem uma flag de porta e nenhuma de socket. Os três desfechos, em ordem de preferência:

| A ferramenta | O que fazer |
|---|---|
| aceita bindar socket unix (a maioria dos runtimes HTTP) | passe `$VSSH_APP_SOCKET` e acabou |
| não aceita, mas você serve a página | **sirva você** e deixe a ferramenta no protocolo dela — foi o caminho do motor X11 |
| não aceita mesmo | declare `backend.transport: "tcp"` no manifesto e receba `$VSSH_APP_PORT` |

A terceira linha **não é neutra, e o custo está medido**: o loopback não tem dono. Numa sondagem
do ambiente, 23 portas de app estavam escutando, **14 responderam a um `GET /` sem token nenhum**
(10×200, 4×500) e **12 delas eram de outras contas Linux** da mesma máquina. Declarar `tcp` é
escolher isso — por isso a escolha fica escrita no manifesto em vez de ser um default silencioso.

> No desenvolvimento local, um socket não tem URL para abrir no navegador. `socat
> TCP-LISTEN:8080,fork UNIX-CONNECT:$VSSH_APP_SOCKET` resolve — na sua máquina, que é onde a porta
> nunca foi o problema.
## Armadilhas que valem para qualquer port

**Asset path absoluto e CDN de terceiro.** Bundlers embutem URL absoluta no release
(`https://cdn.exemplo/...`). Num servidor sem internet, quebra. Corrija **no arquivo de config do
build**, não por override de linha de comando — o override falha em silêncio e você só descobre
depois de uma compilação inteira.

**Um bundle pode assumir dois prefixos ao mesmo tempo.** Se o dev-server do projeto monta mais de
uma raiz, o bundle depende disso e vai quebrar servindo uma raiz só — e vai quebrar **só nos
caminhos carregados dinamicamente**, que nenhum smoke test pega. É para isso que existe
`aliasPrefixes` no `static-spa`.

**Roteamento HTML5 precisa de fallback.** Ligue `spaFallback: true` no `static-spa`. Roteamento
por fragmento (`#/rota`) não precisa.

**Patch que aplica limpo não é patch que faz efeito.** Verificar que o patch aplicou é barato e
**não substitui** verificar o artefato. Confira que os arquivos referenciados pelo `index.html`
publicado existem de verdade no diretório instalado.

**Healthcheck e token — e o que estava escrito aqui estava errado.** Esta página dizia *"o
healthcheck é pollado direto na porta, sem passar pelo proxy, então não carrega
`X-Vssh-App-Token`; isente essa rota do seu gate"*. **Isso mudou na Onda 4**: a sondagem vai **com**
o header, o mesmo que o proxy injeta. Você **pode** gatear a rota de healthcheck como qualquer
outra, e não há motivo para deixar uma rota aberta. Isentar continua funcionando — é uma rota a
menos protegida, não um erro.

O que mudou junto, e é a razão de a frase antiga ser perigosa: antes a sondagem ia sem header, um
app com gate respondia `403`, e `403` não é 5xx — **contava como pronto**. O portal declarava servindo
um app do qual nunca tinha visto uma resposta de verdade. Hoje `401`/`403` na sondagem significam
"recusou uma requisição credenciada" e **não** contam como pronto. Um `404` conta (o servidor
respondeu), então confira o caminho: `healthcheckPath` errado vira teatro sem ninguém avisar.

**Patch para integrar com o ambiente, nunca para substituir o que o ambiente já oferece.** É a
regra que decide se um fork envelhece bem. Um patch que troca a camada de armazenamento do app
reabre a cada bump do upstream e cresce sem parar. Um patch que apenas informa ao app algo que o
ambiente já resolve — por exemplo, que a permissão de arquivo já foi concedida e sobrevive ao
reload, ao contrário do que vale num navegador — é pequeno e degrada bem: se apodrecer num bump, o
pior caso é o app voltar a perguntar.

**E "normalmente sem fork", lá na primeira tabela, responde só a primeira pergunta.** As duas frases
conviviam a 150 linhas de distância como se não se falassem: uma vendia o port sem fork, a outra
dava a regra de como forkar. Quem lê as duas junto chega onde deveria — o fork não é o custo de
**rodar**, é às vezes o custo de **integrar**, e aparece quando a segunda pergunta precisa de algo
que o upstream não expõe por opção nenhuma. Quando aparecer, a regra acima é o teto: se a lista de
patches deixa de ser "informar o ambiente" e passa a ser "trocar uma camada", o desenho está errado,
não o upstream. O caso trabalhado é a [Onda 9](roadmap/08-editor-do-ambiente.md), onde uma constante
de módulo do VS Code (`extensionGalleryService.ts:35`) não é alcançável por nenhuma opção de
construção — e o patch que a corrige tem uma linha.

**Log desde a primeira linha.** Use `lib/node/app-log.js`. Frame minificado sustenta hipótese; o
log do backend, que nomeia operação e caminho, dá a resposta.
