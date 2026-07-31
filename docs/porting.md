# Portar um app existente para vssh-app

Árvore de decisão, e o que cada caminho custa. As regras vieram de um port real levado até rodar
num servidor — ver [lessons/logseq-port.md](lessons/logseq-port.md).

## A decisão, em uma pergunta

**O app já roda num navegador hoje?**

| Situação | Caminho | Custo |
|---|---|---|
| Sim, tem build web (dual-target) | Rodar o **modo web** + `fsa-polyfill` | Baixo — normalmente sem fork |
| Não, é Electron-only | **Extrair o renderer** e medir o buraco (abaixo) | Médio; o resto vira backend próprio |
| Não, é Tauri | Extrair o frontend + `tauri-shim` | Baixo a médio |
| Não, e é GUI nativa (Qt/GTK) | Não portar: rodar como janela X11 no Xpra | Zero, enquanto houver Xpra |

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

**Um limite do polyfill que vale conhecer antes de portar.** O `File` devolvido por `getFile()` é
preguiçoso: busca o conteúdo só quando alguém chama `.text()`/`.arrayBuffer()`. Isso é o que torna
viável abrir um diretório grande (o padrão de chamada dos apps é pedir o `File` de todo arquivo
antes de filtrar). O custo é que ele não é um `Blob` completo para quem lê o **estado interno** em
vez de chamar métodos:

| caminho | funciona? |
|---|---|
| `await file.text()` / `.arrayBuffer()` / `.stream()` | sim |
| `URL.createObjectURL(file)` → `<img src>` | sim — interceptado, vira URL HTTP do portal |
| `new Response(file)`, `new Blob([file])`, `FileReader`, `FormData.append` | **não** — 0 bytes |

Se o app usa um dos últimos, materialize antes: `new Blob([await file.arrayBuffer()])`.

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
| `shell.openExternal` | **a** | Nova aba |
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

**Healthcheck e token.** O healthcheck é pollado direto na porta, sem passar pelo proxy — então não
carrega `X-Vssh-App-Token`. Isente essa rota do seu gate, ou o app nunca abre.

**Patch para integrar com o ambiente, nunca para substituir o que o ambiente já oferece.** É a
regra que decide se um fork envelhece bem. Um patch que troca a camada de armazenamento do app
reabre a cada bump do upstream e cresce sem parar. Um patch que apenas informa ao app algo que o
ambiente já resolve — por exemplo, que a permissão de arquivo já foi concedida e sobrevive ao
reload, ao contrário do que vale num navegador — é pequeno e degrada bem: se apodrecer num bump, o
pior caso é o app voltar a perguntar.

**Log desde a primeira linha.** Use `lib/node/app-log.js`. Frame minificado sustenta hipótese; o
log do backend, que nomeia operação e caminho, dá a resposta.
