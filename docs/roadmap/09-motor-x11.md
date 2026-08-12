# Onda 10 — O motor X11 para de ser um cliente hospedado: nós servimos a página, e as janelas dele viram nossas

> **Estado:** 🚧 **em execução — os itens 1 e 2 fecharam, e com eles o ambiente ficou sem nenhum app
> em porta.** A medida veio antes, na Onda 9: as três respostas que decidem esta onda foram tiradas
> de um xpra **6.5.2 de produção**, não da documentação dele. · **Atualizado:** 2026-08-12
>
> **Repos:** `vsshapp-xpra` + `vssh-sso`
>
> **Depende do [passo 0 da Onda 9](08-editor-do-ambiente.md)**, que já entregou o contrato de
> transporte — e **herdou dele o item 5**. Enquanto esta onda não rodar, o `xpra` é o único app do
> ambiente declarando `backend.transport: "tcp"`, e enquanto UM declarar, o `_reconcileAppPort`, o
> cache de porta, o `nextLoopback` e o teto de **254 servidores** continuam de pé para servir a ele.
> O item que os apaga era o `0d` da Onda 9 e **mudou de onda para cá**, porque é o item 2 daqui que o
> autoriza — não fazia sentido ficar lá marcado como bloqueado por tempo indeterminado.
>
> ### O que a medida disse antes de a onda começar
>
> | A afirmação | O que a medida disse |
> |---|---|
> | "o xpra é `binary`, provavelmente nem sabe bindar socket" | **Errado — foi meu, e ao contrário.** O transporte NATIVO do xpra é socket unix (`~/.xpra/`); ele usa `--bind-tcp` porque **o lifecycle só sabia dar porta** |
> | "então basta trocar `--bind-tcp` por `--bind`" | **Não basta.** `--bind-ws` aceita só `[HOST]:[PORT]`; com caminho responde `xpra initialization error` |
> | "o xpra precisa servir o cliente HTML5" | **Não precisa, e o `--html` aponta para a NOSSA pasta.** Com `--html=off` o WebSocket continua respondendo `101` |
> | "o socket nativo não fala com a gente" | **Fala.** `connect()` cru abre e fica de pé; a um pacote malformado ele **espera o resto** em vez de fechar |
>
> **Duas medidas anteriores mediram a coisa errada com o instrumento errado**, e estão registradas
> na [Onda 9](08-editor-do-ambiente.md#o-xpra-é-o-único-que-fica-em-tcp-e-isso-foi-medido-com-controle):
> eu testava `--bind` (o socket do protocolo nativo, que não fala HTTP por desenho) com um cliente
> HTTP, e lia `/tmp/x.log`, que só tem o preâmbulo do modo daemon. **A pergunta certa não era sobre
> socket** — era *por que o xpra está servindo o nosso HTML*.

---

## A inversão, numa linha — e como ela ficou

```sh
# antes · vsshapp-xpra/backend/entrypoint.sh:185-186
  --bind-tcp="127.0.0.1:${VSSH_APP_PORT}" \
  --html="${AQUI}/frontend" \

# depois · vsshapp-xpra/backend/xpra.sh (o mesmo arquivo, renomeado: ele não é mais o entrypoint)
  --bind-tcp="${VSSH_X11_BIND}" \
  --html=off \
```

**`${AQUI}/frontend` era o nosso próprio diretório.** Não era o xpra nos dando um cliente — éramos
nós entregando a nossa pasta e pedindo que ele fosse um servidor de arquivo estático. Era a única
razão de existir uma camada HTTP no bind dele, e é por isso que a porta não sai enquanto isso não
mudar.

O comentário de `:11` já dizia metade: *"`--bind-tcp` na porta que o lifecycle alocou, e SÓ nela"* —
a porta veio do que o lifecycle sabia dar, não do que o xpra precisa. Hoje `$VSSH_X11_BIND` é
**interna**, pedida ao kernel (`listen(:0)`) pelo backend a cada boot; a porta do lifecycle é do
`backend/server.js`, e some no item 2.

---

## 1. ✅ Nós servimos a página; o xpra fica com o protocolo

O backend do app serve `frontend/` com o `static-spa` do toolkit — que é o que todo outro vssh-app
já faz — e o xpra sobe com **`--html=off`**. `vsshapp-xpra` **0.4.0**.

O endereço do WebSocket **já era configurável**: o cliente monta a URI de `host`/`port`/`path`
(`Client.js:535`, `Protocol.js:193`), e `motor/xpra-engine.js:738-744` registra a briga que isso já
deu. Metade da inversão sempre esteve pronta — e por isso **nenhuma linha do lado-cliente mudou**.

**O que este item custou, e não estava escrito aqui:** o app não tinha backend nenhum. Ele era
`runtime: "binary"` com `exec xpra`, e o PID rastreado pelo lifecycle era o do próprio xpra. Agora é
`runtime: "node"`, o entrypoint é `backend/server.js`, e o xpra é **filho** dele — com a vida
amarrada nas duas direções, porque um backend que sobrevive ao motor fica de pé servindo arquivos
para uma sessão que não existe, com healthcheck verde, e o supervisor nunca o relança. O antigo
`entrypoint.sh` virou `backend/xpra.sh` e continua sendo o único lugar que sabe montar a linha do
xpra: display, teclado, Xvfb e mimeapps não subiram para o Node.

**A premissa que a medida derrubou — e ela era minha, escrita aqui em cima:** *"`GET /` devolve o
`index.html` do pacote"*. **Não há `index.html` neste pacote, nunca houve, e não deve haver.** Ele é
`type: "engine"`: quem serve a página do ambiente é o portal, e o que este app entrega é o
CARREGADOR (`motor/xpra-engine.js`), injetado como `<script>` depois de o backend responder. Servir
um index aqui seria inventar uma segunda página. Então `/` responde **404 dizendo o que o app é**, e
o `healthcheckPath` do manifesto foi para `/healthz` — um 404 conta como pronto para o lifecycle,
mas apoiar a prontidão num erro envelhece mal. Fecha junto o **R3** da Onda 2c, que perguntava
exatamente isto e supunha a mesma coisa errada.

**E veio de graça o que o xpra nunca soube fazer: o `X-Vssh-App-Token`.** O proxy do portal injeta
esse header no HTTP **e no upgrade de WebSocket** — e ele viajava para ninguém, porque quem atendia
era o xpra, que não sabe conferi-lo. A porta é loopback, e loopback é compartilhado por toda conta
Linux da máquina (medido na Onda 9: 14 de 23 portas de app responderam a um GET sem token, 12 delas
de contas alheias). Do outro lado desta não há uma sessão X11 qualquer: há **a** sessão gráfica do
usuário. Agora o backend confere o token em tudo menos no `/healthz`, inclusive no upgrade, e o
token **não atravessa** para o xpra. Era a "decisão aberta" do README do pacote; a inversão a
decidiu.

**Guarda:** `tests/serve-o-proprio-frontend.test.js`, **10 casos** — os bytes do lado-cliente saem do
nosso backend (comparados com o disco, arquivo a arquivo), o upgrade devolve `101` e atravessa nos
dois sentidos, o `Host` é reescrito, o token é exigido e não vaza, e sem xpra do outro lado o
upgrade **falha alto em vez de travar** a aba. A outra metade lê o `xpra.sh` e cobra `--html=off`.
Refutação medida nas duas direções: devolver o `--html` ao xpra deixa **1 vermelho e 9 verdes** —
vermelho *por servir a página de outro lugar*, não por deixar de servir; tirar o `static-spa` do
backend deixa **3 vermelhos**, e nenhum deles é o do `--html`.

## 2. ✅ A ponte que desembrulha o WebSocket, e a porta some

O listener de WS do xpra **não aceita caminho** (medido), então a ponte não pode ficar sendo um cano
de bytes cru. O que fica de pé: o nosso backend termina o WebSocket do navegador e escreve o payload
no `--bind` unix nativo — **o mesmo protocolo que vai dentro dos frames binários**. São dezenas de
linhas com o `ws`, que o `vssh-sso` já usa.

**O item 1 deixou o lugar pronto e a ponte no estado provisório**: hoje `backend/server.js` recebe o
upgrade e o REPETE contra o listener do xpra, sem olhar frame nenhum (`ponteWebSocket`). É a metade
que já se sabia funcionar, porque quem atende do outro lado é exatamente o listener que o navegador
alcançava antes. O item 2 troca duas coisas nessa função — quem termina o WebSocket, e o endereço —
e apaga **duas** portas de uma vez: a do lifecycle e a interna que o backend pede ao kernel para o
xpra.

**Metade do que faltava provar foi provado sem servidor nenhum, lendo o cliente que este pacote
entrega.** Os bytes que vão dentro dos frames binários são o protocolo nativo, literalmente:
`Protocol.js:497-525` monta um cabeçalho de 8 bytes — `'P'`, flags, nível, `0`, e o tamanho em 4
bytes big-endian — concatena o payload e faz `websocket.send(packet.buffer)`. E o lado de recepção
(`:265-296`) **remonta o cabeçalho atravessando fronteira de pedaço** (*"we need more data to
continue"*), isto é, o cliente nunca supôs que um frame fosse um pacote: ele trata o que chega como
um FLUXO. Uma ponte que concatene os payloads dos frames no socket e reparta o fluxo do socket em
frames não muda nada do que o cliente vê — e essa era a dúvida cara.

**O que continua sem prova é só o lado do servidor:** que o `--bind` unix do xpra aceite esse mesmo
fluxo vindo de quem não é um cliente nativo. `connect()` de pé prova que o transporte está aberto,
não que o protocolo atravessa — embora a medida da Onda 9 (*a um pacote malformado ele espera o
resto em vez de fechar*) seja exatamente o comportamento de quem está lendo um cabeçalho de 8 bytes.
A guarda que fecha isso é o handshake completo: o cliente HTML5 conectando pela ponte e desenhando
uma janela, numa sessão de verdade.

Feito isto, o manifesto do xpra trocou `transport: "tcp"` por `"socket"` (`vsshapp-xpra` **0.5.0**,
com `minShellVersion: "4.1.0"` — o `escutar()` da v4 exige um `vssh-app-run` da Onda 9), e **o
ambiente ficou sem nenhum app em porta**. São dois endereços agora, e nenhum deles é um número:
`~/.vssh-apps/xpra/app.sock` para o portal, `~/.vssh-apps/xpra/xpra.sock` para o xpra — o segundo
derivado do primeiro, no mesmo diretório 0700.

**Duas coisas que só apareceram na implementação, e as duas são do NAVEGADOR:**

- **o subprotocolo tem de ser respondido.** O cliente abre com `new WebSocket(uri, "binary")`
  (`Protocol.js:193`), e o Chrome aborta o handshake quando mandou subprotocolo e não recebeu
  nenhum de volta. Quem respondia isso era o listener do xpra; ao trazer o WebSocket para dentro do
  backend, a resposta viria vazia. É erro que **não aparece em teste com cliente permissivo** — por
  isso a guarda mede o header na resposta, e não a linha de código;
- **o frame tem de ser BINÁRIO**, e a guarda que perguntava isso estava errada: o `ws` entrega um
  `Buffer` nas duas modalidades, então `Buffer.isBuffer()` fica verde com a ponte mandando texto. A
  pergunta certa é a flag `isBinary`. Achado ao refutar — a mutação "mande texto" passou verde, que
  é o que uma refutação existe para descobrir.

**E a contrapressão não é enfeite:** uma janela rolando empurra megabytes por segundo, e sem
`pause()`/`resume()` nas duas pontas o `bufferedAmount` cresce sem teto até o processo morrer — e
quem morre é o BACKEND, que também serve o `frontend/` e vigia o xpra.

**Guarda:** `tests/ponte-ws-socket.test.js`, 7 casos — o `hello` do cliente chega ao socket como
protocolo nativo (**nenhuma linha de HTTP** atravessa), o do servidor volta byte a byte como frame
binário, um pacote partido em três escritas chega inteiro, e as duas pontas que caem levam a outra
junto. Ela roda no Windows também, e isso foi escolha: o alvo é endereçado por CAMINHO, e no Windows
um caminho de `listen()` é um named pipe — mesmo `net.connect({ path })` dos dois lados. Uma guarda
que só roda no CI só é lida depois do push.

**A refutação achou um defeito na própria guarda, e é exatamente o que o plano avisava:** cortar a
ponte no meio de um frame fazia o ARQUIVO inteiro travar por 120 s (o timeout do runner) em vez de o
caso ficar vermelho em 4 s — e, travando, ele **escondia a própria refutação**: a mutação passava
por "0 vermelhos". A causa não era a ponte, era o `finally` da bancada: `server.close()` espera as
conexões abertas terminarem, e num caso que falhou elas seguem abertas **por definição**. E
`closeAllConnections()` não bastou — medido: **ele não alcança um socket que já virou WebSocket**.
Quem tem de morrer é o cliente. Junto veio um teto por caso (`--test-timeout=30000` no `npm test`),
para que travar seja sempre um vermelho com nome, e não um arquivo lento.

**Refutação, com a bancada consertada: 5 mutações, 5 pegas**, cada uma nomeando o caso certo — a
ponte que não avisa quando o xpra cai, a que não fecha o socket quando o navegador some, a que manda
texto no lugar de binário, o subprotocolo recusado, e o upgrade aceito antes de achar o xpra.

## 3. 📋 O xpra vira **apenas mais uma forma de adicionar janelas**

**A decisão de produto está tomada, e é ela que dá o desenho:** todo o gerenciamento de janelas já
existe no ambiente, então a janela X11 não ganha cromo próprio nem marca de "janela do servidor" —
ela é uma `VsshWindow` como qualquer outra, e o motor deixa de ser gerenciador para ser **produtor**.
O que sai daqui não é uma reforma visual: é a deleção de um segundo gerenciador de janelas.

Hoje o cliente do xpra traz o próprio: `frontend/js/Window.js`, **1.501 linhas** — barra de título,
botões, minimizar, arraste —, desenhando por cima do desktop que já tem tudo isso. E o cromo dele já
é uma **cópia** do nosso: os quatro SVGs de pin/minimizar/maximizar/fechar estão duplicados em
`Window.js:208-213` e `VsshWindow.js:18-21`, e o `add_headerbar` monta a mesma barra com outros ids.

### O que a medida mostrou, e é maior que "47 proxies"

A conta que este item trazia era o proxy invisível do `VsshWindow.js` — e ela está certa, mas é a
menor das três. **O ambiente fala DOIS dialetos de "janela", e mantém os dois à mão:**

| Onde | O que existe hoje, e só existe por isso |
|---|---|
| `TilingManager.js:622-682` | **dois adaptadores** para a mesma pergunta: `xpraAdapter` (`win.div`, `win.x/y/w/h`, `geometry_cb`) e `pseudoAdapter` (`win._div`, strings CSS, `_saveState`) — 60 linhas que dizem duas vezes "onde está esta janela e ponha-a aqui" |
| `ContextMenu.js:257-283` | `showForWindow` é uma UNIÃO por duck-typing: `win.minimized ?? win._minimized`, `win._maximized ?? win.maximized`, `win.toggle_minimized?.()`, `win.window_closed_cb ? … : win.close?.()`, `win.wid \|\| win._id` |
| `MenuCustom.js` (taskbar), `TilingPanel.js` | mais ramos do mesmo tipo |
| **total, em 4 arquivos do shell** | **31 pontos** que perguntam de que família a janela é |
| `VsshWindow.js` | **43 ocorrências de `proxy`** (27 em código — a nota anterior dizia 47), mais `_dragRaised`/`_dragHooked` |

O proxy é a consequência, não a causa: ele existe porque a janela X11 mora **dentro do `#screen`**
(`Client.js:3399`), e o canvas de lá captura o ponteiro mesmo onde é transparente. O dano está
escrito junto, em `VsshWindow.js:101-108`: *"arrastar um arquivo para outra janela do gerenciador
nunca chegava aos handlers de drop dela"*.

### O desenho, e onde ele encosta

`XpraWindow` passa a **estender `VsshWindow`**, e a subclasse mora **no pacote** — o shell continua
sem saber o nome deste motor, que é a regra da [2.7](02b-motores.md). O que ela guarda é o que é do
xpra (canvas, `do_paint`, cursor, eventos de ponteiro, metadata); o que ela apaga é o que é do
ambiente:

- `add_headerbar`, `make_draggable`, `make_resizable`, `toggle_maximized/minimized/pinned`,
  `save/restore_geometry`, `update_zindex`, `focus` — **e com eles o `jquery-ui` inteiro**, que só o
  `Window.js` usa (`draggable`/`resizable` em 16 lugares);
- do lado do shell: o `xpraAdapter`, os 31 ramos por família e os proxies.

**A geometria fica em duas vias, e é o único trabalho novo:** o que o usuário faz na `VsshWindow`
(mover, redimensionar, maximizar) vira `configure-window` para o X11; o que o X11 manda
(`move_resize`) vira estilo na div. O `_setupDragResize` do shell já entrega os dois ganchos
(`arrastar.js`), então não há biblioteca a substituir — há uma a apagar.

**E a janela sai do `#screen`.** `_initChrome` põe a div no `body`; dentro do `#screen` ficam só as
superfícies nuas (menu, tooltip, bandeja) e, no modo desktop/shadow, uma janela em tela cheia.

### O que apaga o proxy não é apagar o proxy — e são DOIS donos, não um

Medido ao começar o 3b, e é a correção que faltava para ele: **`#screen` é `z-index: 100`**
(`client.css:209`), e uma janela desfocada fica em 90. Ou seja, ela está literalmente ATRÁS de um
elemento que cobre a tela inteira — e um `div` vazio recebe hit-test na sua área do mesmo jeito.
Tirar as janelas de dentro dele (o 3a) é necessário e **não é suficiente**: o `#screen` continua na
frente.

O que resolve é uma linha de CSS — **`#screen { pointer-events: none }`**, com `pointer-events: auto`
nas superfícies de dentro. Aí nada em `#screen` intercepta ponteiro a não ser o que de fato é
desenho do X11, e o proxy fica sem função.

E **há um segundo dono de proxy que este item não contava**: os ÍCONES da área de trabalho
(`Desktop.js:466-484`, com o próprio `_syncProxy` e o próprio `sincronizarProxies`). Eles têm o
problema pela mesma razão e somem pela mesma linha — o que faz o 3b apagar duas máquinas, não uma.

**Os consumidores a limpar, contados:** `VsshWindow.js` (o dono), `Desktop.js` (o segundo dono),
`TilingManager.js`, `WindowStateManager.js`, `VsshAppWindow.js`, `VsshDialogs.js`,
`FileBrowserWindow.js` e o `index.html` — mais a guarda `tests/unit/screen-scale-proxies.test.js`,
que existe HOJE para proteger a mecânica do proxy e tem de **inverter**: passar a cobrar que ele não
existe e que o `pointer-events` está no lugar. É a mesma inversão que a conferência do `jquery-ui`
sofreu no 3a.

**Guarda:** `tests/unit/arraste-entre-janelas.test.js` — arrastar um arquivo de uma janela do
gerenciador para outra chega ao handler de drop **com uma janela X11 aberta na tela**. É o defeito
que o comentário descreve, virado teste. Refuta: reintroduzir o canvas em tela cheia por cima.
E uma segunda, que é a que prova a frase deste item: **nenhum arquivo do shell pergunta de que
família a janela é** — os 31 pontos viram zero, e o `xpraAdapter` não existe mais.

**E o 3b desbloqueia uma coisa que ele não sabia que estava bloqueando: o `host-xpra`.** Ninguém
instala aquele host — `VsshHost.autoSelect()` escolhe o `standalone` sempre —, e por isso o
`vsshHost.captureKeyboard(false)` das treze subclasses de `VsshWindow` é um **no-op** (é a causa da
soltura de teclado que não funcionava, [registrada
abaixo](#e-a-soltura-não-funcionou--porque-nenhum-host-está-instalado)). Instalá-lo hoje acenderia
junto o `nativeWindows()` — que devolve as janelas X11 ao `TilingManager` pelo `xpraAdapter`, DUPLICANDO
o que o `pseudoAdapter` já entrega desde o 3a — e o `workarea()`, que devolve um **array em pixel de
dispositivo** onde o shell espera `{x,y,w,h}` em pixel CSS. Com o `xpraAdapter` apagado e o `workarea`
do pacote corrigido (ou abandonado, porque o shell já deriva o dele da viewport), instalar o host passa
a ser seguro — e é ele que faz o ambiente inteiro voltar a poder dizer "este teclado é meu".

## 3c. 📋 Um vssh-app passa a receber (e a produzir) arquivo arrastado

**Trava no 3b, e a razão não é a que parece.** O pedido veio do VSSHCode — arrastar um arquivo do
gerenciador para dentro do editor —, e a primeira leitura foi "o proxy de janelas atrapalha". A
medida diz outra coisa, e o bloqueio é **uma linha**:

```js
// Só o gerenciador de arquivos aceita — assim um Terminal no caminho do arraste
// nunca é levantado.
_acceptsDragRaise() { return false; }        // VsshWindow.js:176
```

Só o `FileBrowserWindow` sobrescreve para `true` (`:1863`). Uma janela de vssh-app **nunca é
elevada** durante um arraste, então o proxy invisível continua na frente e o `drop` não chega ao
iframe. Não é defeito: é política deliberada, escrita quando app nenhum podia aceitar arquivo.

**Então por que travar no 3b, se o bloqueio é outro?** Porque construir agora é construir **contra a
máquina que o 3b demole**: `_dragRaised`, `_armDragRaise`, o watchdog de 600 ms e os 43 proxies. Com
`#screen { pointer-events: none }`, não há elevação nem proxy — o `drop` simplesmente chega, e
`_acceptsDragRaise` deixa de existir junto. Feito antes, seria escrito duas vezes.

### O contrato é UM, e as três direções caem dele

O terreno já existe: o ambiente arrasta `application/x-vssh-files` (`FileOps.js:117`), com os
caminhos absolutos separados por linha. O que falta é publicá-lo e deixar o app dos dois lados.

| peça | onde | o que ela resolve |
|---|---|---|
| o MIME vira contrato **publicado** | toolkit (`api.md` + shim) | hoje ele é constante interna do shell; um app não tem como saber que existe |
| o app **declara** que aceita arquivo solto | manifesto | é o que substitui `_acceptsDragRaise`: dado declarado, e quem decide é o shell — a mesma forma do `contributes.contextMenu` |
| o app **lê** o que caiu | `vssh.onArquivosSoltos(cb)` | o iframe é mesma origem, então o `dataTransfer` é legível direto — não há postMessage no caminho |
| o app **escreve** o mesmo MIME no `dragstart` dele | o mesmo contrato, ao contrário | é o que faz "arrastar de dentro do editor para a área de trabalho" existir |

**A terceira direção — entre duas janelas do mesmo app — cai de graça das outras duas:** A escreve o
MIME, B lê o MIME, e o ambiente no meio não precisa saber de nada. Isso é o teste de que o contrato é
um só, e não três integrações.

**O VSSHCode é o primeiro cliente dos três lados**, e ele já tem onde encostar: o patch `0010` da
[Onda 9](08-editor-do-ambiente.md) traduz caminho em `vscode.open`/`vscode.openFolder`, com o `tipo`
separando arquivo de pasta. Um arquivo solto na janela é o mesmo destino por outra porta.

**Guarda:** `tests/unit/arraste-para-app.test.js` — um manifesto de mentira declara que aceita
arquivo, e o caminho chega ao ouvinte do app; um que não declara não recebe nada. Refuta: voltar
`_acceptsDragRaise` para `false` fixo. E a de junção: o MIME que o shell escreve é o mesmo que o
shim lê — **um valor, um lugar**, porque dois seriam duas verdades sobre a mesma coisa.

## 4. ✅ O último jQuery do ambiente saiu — e ele escondia o Alt+Tab

A [Onda 8](07-shell-proprio.md) tirou o jQuery do shell (**824 KB a menos**) e fechou. **O ambiente
continuava entregando jQuery ao navegador**, escondido dentro deste app. Saiu na 0.6.0, e com ele
**33.980 linhas de lib** — `−14.488` linhas no total do pacote:

| | |
|---|---|
| `frontend/js/lib/jquery-ui.js` | **19.061 linhas** — saiu no item 3a |
| `frontend/js/lib/jquery.js` | **10.716 linhas** |
| `frontend/js/lib/slick.js` | **3.011 linhas** |
| `frontend/js/lib/jquery.ba-throttle-debounce.js` | **252 linhas**, um consumidor só |

~~"35 call sites de `$(` no cliente, em três arquivos."~~ **Contado de novo, e por dois lados:** são
**39**, porque a varredura procurava `$(` e havia **8 em `jQuery(`** — `jQuery("body")`,
`jQuery("title")`, `jQuery(document).scrollLeft()`. E o `Window.js`, que o item anterior apontava
como onde a maioria morava, tinha **zero reais**: a única ocorrência é comentário.

Dos 134 originais, a divisão que decidiu o trabalho:

| | | |
|---|---|---|
| **16** | `draggable`/`resizable` de um gerenciador de janelas | o ambiente já tinha um — **apagado no 3a** |
| **17** | o carrossel Alt+Tab | **apagado**, com o `slick` junto |
| **21** | `.addClass()`, `.text()`, `.offset()`, `.select()` | uma linha de DOM cada — **portadas** |

**Dois terços viraram deleção, não porte.** É o mesmo achado da Onda 8 — *"a premissa do jQuery
estava invertida, e a medida diz de que lado"* —, e aqui ele aparece na forma mais forte: o custo
não estava em portar as chamadas, estava em duas funcionalidades que o ambiente já tinha ou já
deveria ter.

### O Alt+Tab não era do shell. Era deste pacote, e ninguém sabia

~~"Quando cada janela X11 for uma `VsshWindow`, a taskbar e o `TilingManager` já as listam — e o
carrossel deixa de ser jQuery a portar para virar código a apagar."~~ **A primeira metade é
verdadeira e a segunda esconde uma perda.** Medido:

- a tecla era presa em `Client.js:868`, **dentro do pacote** — o alternador de janelas do ambiente
  só existia com o motor X11 carregado;
- ele listava `client.id_to_window`: **janelas X11, e nada mais.** Com um navegador e um terminal
  na tela, o Alt+Tab não os via;
- varredura ampla no `vssh-client/`: **zero** handlers de Alt+Tab. Não há outro;
- e a tela de atalhos do shell documenta `Alt+Tab · Alternar janelas`
  (`settings/secoes-ambiente.js:623`) como se fosse do ambiente;
- o comentário `VsshWindow.js:592` — *"o Alt+Tab lê `VsshWindow._all`"* — **é falso**. Quem lê
  `_all` naquele handler é o tiling (Super+setas).

Então apagá-lo **deixa o ambiente sem Alt+Tab**, e isso vira um item novo do lado do `vssh-sso` —
o **4d**, abaixo. Enquanto ele não existe, quem troca de janela é a taskbar, que lista todas
inclusive as X11; e como nada mais consome a tecla, o Tab volta a ser encaminhado ao remoto, que é
o que uma aplicação X11 espera dele.

### O item 3a estava QUEBRADO como commitado, e o item 4 é que descobriu

`conferirDependencias()`, em `motor/xpra-engine.js`, continuou exigindo `jQuery.ui.draggable`
**depois** de o 3a apagar o `jquery-ui`. O motor teria recusado carregar em produção, com uma
mensagem citando *"16 lugares do Window.js"* que já não existiam. A conferência nº 9 do pacote não
pegou porque perguntava só ao `Window.js` e ao `Client.js` — e o defeito morava no carregador.

**E o conserto óbvio reintroduziria o mesmo defeito com outra roupa.** Trocar por
`typeof self.VsshWindow !== 'function'` seria recusar o motor pela ausência de uma classe presente:
o shell declara `class VsshWindow {}` no topo de um script clássico, e **declaração de classe cria
binding no ambiente léxico global — não vira propriedade de `window`.** Confere-se o nome **nu**.

> A lição, que virou guarda: **conferência de dependência que nomeia uma lib é dívida com data
> marcada.** A pergunta certa é pelo que o ambiente provê e o pacote *não* traz.

### E o sino do ambiente nunca recebeu uma notificação X11 sequer

O `NotificationCenter` do shell envolve `window.doNotification` para gravar toda notificação X11 no
histórico (`_wrapX11`, `NotificationCenter.js:607`). **Medido: o envelope nunca é aplicado.**
`NotificationCenter.mount()` roda dentro do `init_page()` (`index.html:850`); o motor X11 é
carregado depois e de forma assíncrona, por `_carregarMotorDoApp()` (`index.html:1011`). Quando
`_wrapX11()` procura a função, o `Notifications.js` ainda não foi servido — ela não existe, o
envelope desiste em silêncio, e nada chega ao sino.

O conserto ficou no pacote, e é melhor que o envelope: **quem produz anuncia**, em vez de quem
consome remendar. O `Notifications.js` chama `NotificationCenter.push(..., {toast: false})` e põe a
marca `_ncWrapped` que o próprio shell definiu, para um `mount()` posterior não gravar duas vezes.

**O desenho do toast ficou aqui, e o motivo é um limite medido, não preguiça:** no shell, ação de
notificação é **dado** (`{id, label}`) roteado por HTTP ao backend do app (`runAction` → `_entregar`,
que exige um caminho); numa notificação X11 a resposta tem de voltar **pelo protocolo**, ao processo
que a emitiu. Não há caminho HTTP: o emissor é um processo X11, não um vssh-app. Roteando o desenho
para o sino, uma notificação com botões passaria a responder *"O aplicativo não está aberto e não
deixou como responder."* **Unificar os dois toasts custa as ações** — e isso é decisão do shell.

Três defeitos do upstream caíram junto, porque o arquivo estava sendo reescrito de qualquer forma:

- título e corpo iam para `innerHTML` **interpolados** — injeção de HTML vinda de um processo X11
  qualquer, na página do ambiente. Com `createElement` + `textContent` o vetor fecha sozinho;
- `expire_timeout` chega em **milissegundos** (freedesktop) e era tratado como segundos: um toast de
  5 s ficava **83 minutos** na tela;
- `id=notification"${action_id}"` tinha as aspas trocadas de lugar, então **todos** os botões de
  ação nasciam com o mesmo id.

**Guardas:** a nº 7 do `conferir-pacote.mjs` **inverteu** — cobrava a presença do jQuery, agora
cobra que ele não voltou: nem no manifesto, nem no disco, nem chamado. E varre **todo arquivo
não-lib por diretório**, em vez de uma lista à mão; foi a lista que deixou o defeito do 3a passar. A
nº 8 deixou de rodar predicados (a `__XPRA_JA_TENHO` ficou vazia: sem lib compartilhada não há
segunda instância possível) e passou a perguntar o que ainda pode ficar incoerente — inclusive que
`conferirDependencias` **só exija o que o pacote realmente usa**, que é o defeito do 3a virado
pergunta. Refutado: **nove mutações, nove vermelhos**, e verde de volta ao fim.

---

## 4d. 📋 O ambiente ganha o Alt+Tab que o motor levou embora

**Item novo, e ele nasceu de uma medida do item 4:** o Alt+Tab do ambiente morava no pacote do xpra
e listava só janelas X11. Ele saiu na 0.6.0. O shell nunca teve um — e documenta um, na tela de
atalhos.

O trabalho é pequeno **porque o 3a já o preparou**: desde que a janela X11 é uma `VsshWindow`, o
registro `VsshWindow._all` tem tudo o que o alternador precisa listar, sem distinção de família.
Não há `id_to_window` a consultar, nem adaptador a escolher.

| | |
|---|---|
| onde | `vssh-sso`, ao lado da taskbar (`MenuCustom.js`) ou como módulo próprio |
| a lista | `VsshWindow._all`, ordenada por foco recente |
| o markup órfão | `#window_preview` (`index.html:415`), `css/slick.css` (109 linhas) e o que sobrou do `menu-skin.css` — o carrossel se foi, e eles ficaram |
| trava em | o pacote 0.6.0 instalado nos servidores, **ou nada**: sem ele o Alt+Tab velho continua funcionando e o novo o substitui |

**Guarda:** abrir um terminal e uma janela X11, e o alternador listar **as duas**. É a frase que o
carrossel nunca conseguiu cumprir. Refuta: filtrar a lista por família.

## 5. 📋 A orquestração de porta morre — e ela mudou de onda para cá

**Era o passo `0d` da [Onda 9](08-editor-do-ambiente.md), e ficar lá era um erro de endereço.** O
passo 0 daquela onda trocou o endereço de um vssh-app de porta para socket, e o `0d` seria a
consequência: apagar os onze lugares que sabem a porta. Só que eles **não sobreviviam por inércia** —
sobreviviam porque **um app ainda declarava `transport: "tcp"`**, e esse app era o xpra. Quem o
deixou sem assunto foi o item 2 desta onda, e por isso o item mora aqui, ao lado da medida que o
autoriza.

**O item 2 fechou, e este está liberado.** O gate é operacional e não técnico — apagar a
orquestração de porta antes de o `vsshapp-xpra` **0.5.0** estar instalado nos servidores deixa o
motor sem endereço, porque o portal passaria a montar o túnel só para socket enquanto o app
instalado ainda binda porta.

**E o gate é a 0.5.0, não a versão mais nova.** Quem trocou o transporte foi ela; a 0.6.0 não
encosta em endereço nenhum. Confundir as duas seria esperar por uma publicação que este item não
precisa — a 0.5.0 **já está publicada**, e o que falta é a instalação nos servidores, que é o que
se confere com `ss -tln`.

**O que já saiu com o 0c**, e não espera nada: a ponta **local** do `-L` passou a ser decidida no
portal (`alocarPortaLocal`), então o `ss -tlnp` remoto sobra exclusivamente para `tcp` — isto é, para
o xpra. É uma ida de SSH por app que morre no dia em que o item 2 fechar.

**O que fica para este item**, quando o ambiente não tiver mais nenhum app em porta:

| # | O que apaga | Por que ele existia |
|---|---|---|
| 1 | `_allocateAppPort` e a varredura remota | achar porta livre no servidor |
| 2 | o cache Redis `app_port:` | não repetir a varredura |
| 4–5 | ler `/proc/<pid>/environ` e o `_reconcileAppPort` | **existiam porque 2 e 4 discordavam** — endereço derivado não tem o que reconciliar |
| 6–8 | o fallback `40000 + (UID % 10000)`, o `/dev/tcp` e a releitura do supervisor | o lifecycle escolhendo porta por conta própria |
| 9–10 | o espelhamento do `-L` e o **`nextLoopback`** | a chave do túnel era `<loopback>:<porta>`, e um `127.0.0.x` por servidor **com teto de 254** existe por causa desse espelhamento |
| 11 | o disjuntor indexado por porta | passa a ser indexado pelo endereço |

**O teto de 254 servidores é o que este item entrega de verdade** — não é limpeza, é um limite de
produto que ninguém escolheu.

**E há um décimo-segundo lugar, achado ao fechar o item 2:** o `startApp` escreve
`VSSH_APP_PORT=<porta>` no arquivo `env` de **todo** app (`vssh-apps.ts:940`), inclusive nos de
socket — e nesses o número é a ponta LOCAL do túnel, que não tem relação nenhuma com onde o app
escuta. Não quebra nada hoje (o `vssh-app-run` ignora a variável quando o transporte é socket, e a
lib do toolkit prefere `VSSH_APP_SOCKET`), e é exatamente por isso que é armadilha: uma variável com
nome certo e valor de outra coisa, esperando alguém lê-la.

**Guarda:** a que já existe (`app-sem-porta.test.js`) estendida ao ambiente inteiro — `ss -tln` no
servidor não mostra porta de app **nenhum**, com o xpra rodando. Refuta: devolver **um** app ao
`tcp`; o teste tem de ficar vermelho por causa dele, e nomear qual.

---

## O incidente de 11/08/2026 — quatro defeitos, e um deles não é deste app

**A onda tinha os itens do pacote fechados quando o motor ficou inalcançável por horas** num
servidor real. O portal mostrava `ECONNRESET` e depois `HTTP 000` sem parar. Fica registrado aqui,
e não num changelog, porque três dos quatro defeitos são **decisões desta onda** — e o quarto é do
toolkit e ainda está aberto.

`vsshapp-xpra` **0.6.1**.

### O que os dados disseram, em 49 milissegundos

```
.542  socket-do-xpra  estado=removido      ← instância A
.549  escutando       app.sock             ← A ganhou o endereço
.591  socket-do-xpra  estado=inexistente   ← instância B, 49ms depois
57.3  xpra-saiu       codigo=21            ← os dois xpras colidiram
```

O portal pediu **dois starts quase simultâneos** para o mesmo par usuário+app. Isso é defeito do
`vssh-sso` — não há trava de start em voo —, e não deixa de ser defeito nosso ter quebrado com ele.

| # | O defeito | De quem |
|---|---|---|
| **D1** | `subir()` fazia `spawn do xpra` → `escutar`. **`escutar()` é o único mecanismo de exclusão que existe**: é ele que descobre que outra instância já atende o endereço. Chamá-lo depois do efeito colateral é jogar a exclusão fora — B só soube que perdeu três linhas depois de o segundo xpra existir | item 2 desta onda |
| **D2** | `xpra.sock` vivo → **`process.exit(0)`**. O lifecycle lê 0 como sucesso: nenhum start seguinte bindava o `app.sock`, ninguém tentava de novo, e o app ficou morto até alguém entrar por SSH e matar o xpra à mão | item 2 desta onda |
| **D3** | saída antecipada não matava o filho — foi o que **orfanou** o xpra que travou tudo | item 2 desta onda |
| **D4** | `log(...)` seguido de `process.exit()` **perde a linha** | **o toolkit**, e continua aberto |

### D1 e D2: a ordem certa muda a resposta certa

O conserto do D1 é uma reordenação: **ganhar o endereço primeiro, causar efeito depois.** Quem perde
a corrida sai sem ter criado nada.

E isso reescreve a pergunta do D2. Antes, com o `escutar` no fim, um `xpra.sock` vivo era ambíguo —
podia ser um xpra de outra instância nossa ainda de pé, e desistir parecia prudente. **Depois da
reordenação não é mais ambíguo:** nós já detemos o `app.sock`, que é o **único** endereço pelo qual
o portal alcança este app. Se há xpra atendendo, ele é órfão de uma vida anterior, e a sessão dele
está inalcançável por qualquer navegador.

Então a resposta deixou de ser desistir e passou a ser **adotar** — e veio com uma propriedade que
valia a pena de graça: **a sessão X11 do usuário sobrevive a um reinício do backend.** As janelas
continuam abertas onde estavam.

Um xpra adotado não tem `filho.on('exit')`, então ganhou vigília: uma sondagem a cada 15 s, que é a
**mesma** operação que o `limparSocketOrfao` já faz no boot — o xpra não vê um tipo novo de tráfego,
vê uma a mais. Sem ela, a morte do adotado deixaria o backend verde servindo o vazio, que é o estado
que o próprio arquivo declara ser pior que uma queda.

### D4: o log ficava cego exatamente nos momentos que importam — e é do toolkit

O `createAppLog` escreve num `createWriteStream`: assíncrono e bufferizado. `process.exit()` não
drena buffer nenhum. **Provado pelos dados do incidente, não por teoria:** o evento
`xpra-ja-atende` aparece no `run.log` e **não** aparece no `app.log`, sendo a **mesma** chamada de
`log()`. O `run.log` é stdout redirecionado para arquivo, e escrita em arquivo é síncrona no POSIX;
o `app.log` é o stream, e ele morreu com o buffer cheio.

O resultado é o pior tipo de buraco: o registro estruturado é cego justamente quando o processo
desiste, que são os únicos instantes que interessam depois. Foi o que fez este diagnóstico depender
de comparar dois arquivos de log para descobrir que um deles estava mentindo por omissão.

**Isto vale para TODO vssh-app**, inclusive o template do toolkit — qualquer um que faça `log(...)` +
`process.exit()` perde a última linha. O `vsshapp-xpra` resolveu por fora (`registrarSincrono`, sobre
o `log.path` que o toolkit publica) porque o conserto de lá só chega quando a tag `v4` mover.

**O conserto no toolkit** é abrir o arquivo uma vez e usar `fs.writeSync` em vez do stream: um
syscall por linha, e o volume aqui é de eventos e não de quadros. Fica como item aberto — ver a
tabela de status.

**Guarda que o pacote já tem, e é a mais incomum delas:** um teste que sobe dois subprocessos, um
gravando por stream e outro por `appendFileSync`, os dois com `process.exit(0)` imediato, e exige que
o primeiro perca a linha. Ele mede a **premissa** do conserto, não o conserto. No dia em que o
toolkit gravar síncrono ele fica vermelho — e será a notícia certa: dá para apagar o contorno.

### E o que o incidente provou A FAVOR

**O `--bind` unix do xpra funciona.** Era a única peça que o item 2 registrou como não verificada
(*"o que continua sem prova é só o lado do servidor"*), e foi a primeira de que eu suspeitei. A
sessão de `01:41:13` rodou **seis minutos** e saiu com `143` = 128+SIGTERM: desligamento limpo pelo
portal, a pedido dele. Não há mais nada pendente de prova no item 2.

E o colapso de SSH que aparece no fim do log do portal — `terminal-ws`, `ssh-exec` pooled, `coletor`
e todos os `fs/*` com `Keepalive timeout` ao mesmo tempo, mais túneis de **outro usuário** fechando
com 255 — é outro problema, e provavelmente **amplificado** por este: o laço de crash faz o portal
abrir uma sessão SSH por `start`/`stop`/`list`, e 255 é o `ssh` saindo com erro, compatível com o
`MaxStartups` do sshd começando a recusar.

**Guardas:** `tests/boot-sem-xpra-orfao.test.js`, 9 casos — cada um é uma linha daquele `app.log`.
Refutado: **8 mutações, 8 vermelhos**, entre elas devolver a ordem antiga do boot e devolver o
`exit 0` da adoção. E a guarda que cobrava o literal `escutar(servidor)` passou a cobrar coisa mais
forte: que o **padrão** do parâmetro injetável seja o `escutar` do toolkit — padrão errado é o modo
de falhar que a injeção introduz, e nenhum teste que passe um duplo o pegaria.

---

## 6. ✅ O portal não deixa dois starts do mesmo app em voo — **feito**

**Item novo, e a causa primeira do incidente acima.** Dois `startApp` para o mesmo par usuário+app
saíram a 49 ms de distância. O app foi consertado para não quebrar com isso — a exclusão dele agora
está no lugar certo, e quem perde a corrida sai sem criar nada. Mas **pedir dois é do portal**, e
custa duas sessões SSH, dois `vssh-app-run` e a chance de a corrida achar o próximo defeito.

| | |
|---|---|
| onde | `vssh-sso`, no `startApp` (`vssh-apps.ts`) — o trabalho virou `_iniciarApp`, e o `startApp` passou a ser a trava |
| a chave | `<serverId>:<sshUser>:<appId>` — **e não `<usuário>:<appId>`**, como este item dizia: o mesmo usuário pode ter o mesmo app em dois servidores, e esses dois backends não têm nada a ver um com o outro |
| o quê | uma promessa em voo por par, e o segundo pedido **espera a primeira** em vez de abrir a sua |
| de brinde | o `HTTP 000` do healthcheck deixa de ser corrida — duas sondagens não concorrem mais pelo mesmo endereço |

**O cliente já coalescia, e não alcançava o caso.** `AppLauncher._inflightStarts` existe desde a
Onda 8 e faz exatamente isto — mas aquele mapa vive **numa página**. Duas abas, dois navegadores, o
eager start de engines e um `restartApp` concorrente são chamadores diferentes, e nenhum vê o mapa
do outro. Trava de concorrência tem de morar onde o **efeito** mora, não onde o pedido nasce.

### Três decisões que só a implementação cobrou

| | |
|---|---|
| **É trava, não cache** | um start que **falha** solta a chave. Guardar o resultado impediria o par usuário+app de subir até o pod reiniciar — um defeito **pior** que o que a trava conserta |
| **O veredito é um, os interessados são N** | `aoResolver` é por chamador (é por ele que a janela sai de "Iniciando…"). Coalescer ingenuamente **descarta o do segundo**, e aquela janela fica em "Iniciando…" para sempre. Eles são acumulados e avisados todos — e um que lança não cala os outros |
| **`restartApp` NÃO coalesce** | ele **espera** o start em voo terminar antes de matar. Sem isso o `_killAppTree` mataria o processo que o start acabou de subir, e o `startApp` do fim devolveria a promessa daquele start — reportando *pronto* um backend que já não existe |

**Guarda:** `tests/unit/um-start-por-vez.test.js`, **5 casos, refutação 5/5**. E ela **executa o
`startApp` real** — sem mock, sem recorte de texto: num ambiente sem banco ele falha em **~1 ms**
dentro do `getPooledSshConnection`, **depois** da trava, e a **identidade do objeto `Error`** diz se
dois chamadores compartilharam o mesmo trabalho. Foi assim que o defeito foi confirmado **antes** do
conserto: dois `startApp` no mesmo tick devolviam dois `Error` distintos.

A versão fácil desta bancada seria procurar `_startsEmVoo` no texto do arquivo — e ela ficaria verde
com o mapa declarado e nunca consultado, com a chave montada errada e com um `delete` que nunca
roda. As duas últimas são os modos de falha **reais** de uma trava de concorrência, e as cinco
mutações da refutação são exatamente elas.

**E uma bancada existente ficou vermelha, pelo motivo certo:** `gpu-e-cofre.test.js` recortava
`async function startApp` por texto para cobrar que o cofre **não** é escrito onde o `env` é
truncado. Com o start dividido em dois, o recorte pegou a trava — que não escreve `env` nenhum. Ela
falhou com a própria mensagem que previa isso (*"o startApp mudou de forma — reveja a premissa"*) e
passou a recortar `_iniciarApp`. O `assert.ok` de delimitação é o que fez isso aparecer em vez de o
teste ficar verde medindo a coisa errada.

---

## A primeira sessão real depois do item 4 — dois defeitos do 3a, e uma pergunta em aberto

`vsshapp-xpra` **0.6.2**. Os dois defeitos têm a mesma origem, e ela é a decisão central do item 3a:
**a janela X11 mudou de casa.** Ela é uma `VsshWindow`, e o `_initChrome` do shell faz
`document.body.appendChild(div)` — então tudo o que dependia de ela morar dentro do `#screen` parou
de valer, calado.

### O cursor: um método de jQuery que a guarda não via

```
Window.js:1293  Uncaught TypeError: window_element.css is not a function
    at set_cursor_url
```

Antes do 3a era `var window_element = jQuery('#' + this.wid)`. O 3a trocou por `this.div` — elemento
do DOM — e deixou os dois `.css()` em cima. É `TypeError` no primeiro cursor que a sessão desenha,
isto é, imediatamente.

**E a conferência nº 7 passou verde com isto no arquivo.** Ela procurava `$(` e `jQuery(` — o
**símbolo**. Um método de jQuery chamado numa **variável** é invisível a esse padrão: a guarda media
de ONDE o objeto veio, e o defeito estava em COMO ele era usado.

> A lição, e ela generaliza: **guarda que procura o símbolo de uma lib mede a importação, não o uso.**
> A pergunta completa precisa dos métodos.

Passou a procurar 23 métodos que **não existem** em DOM, Array, String ou Response. `find`, `text`,
`closest`, `append`, `data`, `is` e `show` ficam de fora **de propósito**: `Array.prototype.find`,
`Response.text()` e `Element.closest()` são legítimos e este pacote usa os três. Falso positivo em
guarda de tudo-ou-nada é o caminho mais curto para alguém desligá-la.

### As janelas do tamanho de duas, e o ponteiro no dobro da distância

`this.w/h/x/y` são pixels de **dispositivo**: o cliente pede ao xpra um framebuffer `scale`× maior
que a viewport (`desktop_width = clientWidth * scale`), e **é daí que vem a nitidez em HiDPI**. A
conversão para pixel CSS era um `transform: scale(1/scale)` no `#screen`, com
`width/height: 100*scale%`.

Fora do `#screen`, o transform não alcança mais a janela. Numa tela dpr 2: tudo exatamente **2×**, e
o `getMouse` (`clientX * scale`) mirando no dobro.

**A conversão desceu para o canvas** — o idioma padrão de HiDPI:

| | |
|---|---|
| `canvas.width` | buffer, em pixels de **dispositivo** — a nitidez vem daqui, e é a MESMA de antes |
| `canvas.style.width` | apresentação, em pixels **CSS** (`w / scale`) — o tamanho vem daqui |

**E fazer aqui é melhor que consertar o transform**, por três razões medidas e não por gosto:

- **o cromo é do ambiente agora, e não deve escalar.** Um transform no contêiner escalava a barra de
  título junto, que precisa ter o mesmo tamanho da de um terminal ao lado;
- **a geometria do `div` passa a ser em pixels CSS** — a unidade em que o arraste, o resize, o tiling
  e a taskbar do shell falam. Sem isso, cada um deles precisaria conhecer a escala do motor;
- **o `#screen` deixa de ter transform**, e o shell tem um mecanismo inteiro só para observar esse
  transform e invalidar proxies quando ele muda (`_observarEscalaDosMotores`, `index.html`). Isto o
  deixa sem assunto: **o item 3b fica menor.**

**Um terceiro achado, que era uma dependência escondida:** `_screen_resized` fazia
`desktop_width = container.clientWidth` **sem** `* scale` — e estava certo, por construção. Com o
contêiner em `100 * scale`%, o `clientWidth` dele **já era** `viewport × scale`; o `init_state()`
fazia `clientWidth * scale` antes do transform existir, e as duas contas coincidiam. Nada dizia que
uma dependia da outra. Tirar o transform quebraria exatamente ali, e o sintoma seria a nitidez HiDPI
morrendo **no primeiro redimensionamento de janela**, sem erro nenhum.

**E a conferência nº 6 estava medindo um comentário.** Ela lê o corpo do `init()` para cobrar do
de-init tudo o que ele escreve — e lia **cru**, sem `soCodigo`. O comentário que explica a remoção
do transform cita as quatro linhas removidas, e a guarda continuou anunciando *"width, height,
transform, transformOrigin"* com o `init()` já não escrevendo nenhum deles. É o modo de falhar que o
`soCodigo` existe para impedir, documentado no cabeçalho dele — desta vez ele só não estava sendo
chamado ali. Consertada, e **invertida** junto: o `init()` agora é proibido de escrever `transform`,
`transformOrigin`, `width` e `height` no `#screen`. Confiar ao de-init não bastaria — ele limpa na
saída, e o estrago acontece com o motor ligado.

**Duas coisas que eu suspeitei e a medida absolveu**, e valem registro porque quase viraram commit:

- *"o div da janela X11 não tem a classe `window`, então `body > .window { --dpr: 1 }` não a alcança
  e o cromo está inflado"* — **falso.** O 3a portou todas as classes do upstream para `classList`
  (`window`, `window-<tipo>`, `desktop`, `tray`, `override-redirect`, `windowinfocus`, `wmclass-*`,
  `undecorated`). Eu tinha varrido só o `Client.js`;
- *"a classe `vssh-window` que o 3a adicionou é do visualizador de URL e não devia estar ali"* —
  **falso.** É a classe padrão de toda janela do shell (`VsshWindow.js:579`). O que ela de fato
  arrasta é `min-width: 400px; min-height: 300px`, então um diálogo X11 pequeno fica esticado — é
  cosmético, é a convenção do shell, e fica anotado em vez de combatido.

### O DPI da sessão era 96 — sondado, e a sonda virou uma versão

**Era hipótese; foi medido no dia seguinte, numa sessão de produção:**

```
xdpyinfo | grep resolution   →  96x96 dots per inch
xrdb -query | grep -i dpi    →  Xft.dpi: 96  ·  Xft/DPI: 98304   (= 96 × 1024)
```

**O `--dpi` do servidor vence o `hello` do cliente, e todo aplicativo da sessão faz layout a
96 dpi.** A nitidez que o ambiente tem em HiDPI vem de o cliente pedir um framebuffer `dpr`× maior —
isto é, de um render de 96 dpi **superamostrado** e apresentado em metade do tamanho. O texto sai
liso porque tem o dobro de pixels; as **métricas** são de 96 dpi, com hinting calculado para a grade
errada e ícones dobrados em vez de desenhados grandes.

A `0.7.0` troca `--dpi=96` por `--dpi=0` — que é como o xpra diz *"use o que o cliente informar"*. E
ela é **a medida, não a conclusão**: o valor do cliente só existe depois de um cliente conectar, e
nenhuma leitura estática decidiria isto. A pergunta que fecha é `xrdb -query` de uma tela dpr 2 —
192 confirma o mecanismo, 96 diz que `--dpi=0` não é o caminho e a mudança volta atrás com o achado
escrito.

**Uma variável de cada vez:** o `-dpi 96` do `Xvfb` fica. Ele é o que o `xdpyinfo` reporta como
resolução física; o `Xft.dpi` — que é o que os toolkits leem para escalar UI — é o que o xpra
escreve por XSETTINGS. Mudar os dois juntos deixaria a medida sem controle.

**E a tensão que faz 96 fixo não ser obviamente errado fica registrada:** o DPI é da SESSÃO, e a
sessão é longa — mais ainda desde que a 0.6.1 adota uma sessão existente em vez de matá-la. Um
cliente em dpr 1 e outro em dpr 2 querem DPIs diferentes, e o xpra tem um por sessão. Fixar em 96
era a escolha neutra; seguir o cliente é a escolha do caso real, que é uma pessoa numa máquina.

> E uma nota de ferramenta, porque custou duas idas: **`xpra info` e `xpra list` não acham esta
> sessão.** Eles descobrem servidores varrendo `~/.xpra/`, e o nosso `--bind` num caminho próprio
> substitui o socket padrão de lá. Quem responde sobre a sessão é o X: `xdpyinfo` e `xrdb -query`,
> que foi o que de fato mediu.

A fonte se contradizia assim:

| | |
|---|---|
| `backend/xpra.sh:136` | `Xvfb -screen 0 WxHx24 **-dpi 96**` |
| `backend/xpra.sh:197` | `xpra start ... **--dpi=96**` |
| `js/Client.js:787,792` | o cliente calcula `_get_DPI()` (mede o `#dpi` do shell **× dpr**) e o manda no `hello` |

**Se o 96 do servidor vencer**, todo aplicativo da sessão faz layout a 96 dpi, e a nitidez que
temos vem de um render de 96 dpi jogado numa grade de 2× pixels e apresentado em metade do tamanho.
O texto fica liso porque está superamostrado — mas as **métricas** são de 96 dpi. Com o DPI real
chegando à sessão, GTK e Qt fariam layout HiDPI **nativo**: hinting de verdade, métricas de verdade,
ícones no tamanho certo em vez de dobrados.

**E há uma tensão real, que é por que 96 não é obviamente errado:** o DPI é da SESSÃO, e a sessão é
longa — mais ainda desde que a 0.6.1 adota uma sessão existente. Um cliente em dpr 1 e outro em
dpr 2 querem DPIs diferentes, e o xpra tem um por sessão. Fixar em 96 é a escolha neutra.

**A sonda, em três perguntas:**

```sh
# 1. o --dpi do servidor vence o hello do cliente?
xpra info | grep -i dpi
xdpyinfo | grep -i resolution
# 2. o que os aplicativos veem?
xrdb -query | grep -i dpi
# 3. e o controle: sem o --dpi fixo, o valor do cliente entra?
#    (subir uma sessão de teste sem `--dpi=96` e repetir a 1)
```

Se a resposta de (3) for "entra", a escolha passa a ser de produto e não técnica: **DPI por sessão
seguindo o primeiro cliente** (melhor para o caso real, que é uma pessoa numa máquina) **ou 96 fixo
com supersampling** (neutro para qualquer cliente). Só então vale escrever código.

---

## O teclado da janela X11 — uma linha que a Onda 2.7 apagou e ninguém herdou

`vsshapp-xpra` **0.7.5**. Sessão real, com a `0.7.4` rodando: *"as janelas do Xpra não estão
capturando o teclado."*

`capture_keyboard` nasce **falso** (`Client.js`, `do_init_keyboard`), e quem o ligava era o shell — uma
linha dentro do `client.on_connect` que o `index.html` montava à mão:

```js
// vssh-client/index.html, antes do commit e03f9b0
if (client) client.on_connect = function() {
  if (typeof client.send_keymap === 'function') client.send_keymap(true);
  enable_clipboard_autofocus();
  client.capture_keyboard = true;      // ← esta
```

O passo 2 da Onda 2.7 apagou aquele arquivo junto com o cliente, **corretamente** — o cliente saiu de
lá. O `send_keymap(true)` foi herdado pelo `xpra-engine.js`; a linha do teclado **não teve
substituta**, em lugar nenhum. Medida: `grep` em todo o pacote e em todo o `vssh-client/js` — o único
`= true` que existe hoje é o `_releaseKeyboard()` do ambiente e o fechar de menu.

> **A lição, e ela não é sobre teclado:** quando um subsistema muda de casa, o que se audita é o que
> ele *usava* — os globais nus, as libs, os arquivos. O que passa batido é o que **alguém fazia por
> ele** de fora. `client` e `jQuery` foram cobrados de volta porque quebravam ALTO, com
> `ReferenceError`. Esta era um booleano: quebrou **em silêncio**, no commit `e03f9b0` (04/08/2026), e
> só apareceu oito dias depois, quando alguém tentou digitar.

**E o defeito era intermitente, que é como ele sobreviveu a uma bancada.** O ambiente liga a captura
de lado — `_releaseKeyboard()` de toda janela com input próprio (terminal, editor, diálogos), e o
fechar do menu de contexto, do Iniciar e do Launchpad. Bastava clicar com o botão direito na janela
uma vez para o teclado "voltar" até a próxima sessão.

**A linha antiga não serve de volta como era**, e essa é a decisão do item: no ambiente de hoje o
motor conecta em **segundo plano**, a qualquer hora, com um terminal possivelmente em foco. Ligar a
captura no connect roubaria as teclas de quem está digitando. Quem tem de ligá-la é o **foco** — que é
também o único momento em que existe para onde mandar tecla, porque `_keyb_process` manda para
`focused_wid`.

| onde | por que ali |
|---|---|
| `Window.js`, `_onFocus()` | o ambiente focou a janela. **Antes** da trava de reentrância: ela existe para cortar o laço `foco → servidor → updateFocus → foco`, e escrever um booleano não participa dele — depois dela, a linha perderia justamente o foco que veio do X11 |
| `Window.js`, `updateFocus()`, ramo sem cromo | menu Qt, tooltip, bandeja e o modo desktop **não passam** pelo foco do ambiente. Sem isto, um submenu aberto não responde a seta nem a Enter |

O par disto já existia do outro lado, e é por isso que são duas linhas e não um mecanismo: toda janela
do ambiente com input próprio **desliga** a captura no `_onFocus()` dela. Ninguém devolve o teclado ao
perder o foco — quem ganha o foco declara o que quer, e duas autoridades sobre o mesmo booleano é
exatamente como o proxy nasceu.

**Nada do `vssh-sso` muda**, e isso era requisito: o Xpra é a prioridade mais baixa, então o conserto
não pode encostar nos proxies que o item 3b vai apagar. A correção é do pacote, nos dois arquivos que
já são dele.

**Guarda** — conferência nº 10, cinco mutações refutadas uma a uma: sem `_tomarTeclado`; o booleano ao
contrário; só um dos dois sítios chamando; a tomada **depois** da trava; e o de-init do motor deixando
de devolver o teclado. A última é a que protege o ambiente — sem ela, desligar o X11 nas configurações
deixaria um cliente morto engolindo tecla, porque `_keyb_process` não pergunta nada além do booleano.

### A captura voltou; a soltura nunca foi regra

Sessão seguinte, mesma pessoa: *"deu certo agora a captura, mas ainda não a descaptura."* E a conta
diz por quê — das **treze** subclasses de `VsshWindow`, sete soltavam o teclado ao ganhar o foco e
**seis não soltavam nada**:

| solta (`captureKeyboard(false)` no `_onFocus`) | **não solta** |
|---|---|
| `ArchiveWindow`, `BrowserWindow`, `FileBrowserWindow`, `SettingsWindow`, `TerminalWindow`, `TextEditorWindow`, `VsshDialogs` | `BrowserFallbackWindow`, `DesktopPropertiesWindow`, `IframeHostWindow`, `LogWindow`, `PrintDialog`, `UrlViewerWindow`, **`VsshAppWindow`** |

**As seis funcionavam por acidente**, e o acidente era o defeito de cima: `capture_keyboard` ficava
falso quase sempre porque *nada* o ligava. Com o motor voltando a ligá-lo no foco, as seis passaram a
não receber tecla — inclusive a `VsshAppWindow`, que é a janela de **todo vssh-app**.

> Não é regressão do motor. É a **soltura nunca ter sido regra**: ela existia sete vezes, à mão, e
> toda janela nova tinha de lembrar. Regra que se cumpre por lembrança tem taxa de acerto de 7/13 —
> e essa é a medida, não uma estimativa.

Então o padrão **inverte**, e numa linha só, no `VsshWindow.focus()`:

```js
vsshHost.captureKeyboard(false);   // focar SOLTA o teclado remoto…
this._onFocus();                   // …e quem o quer o TOMA aqui (hoje: a janela X11, e mais ninguém)
```

Uma autoridade, ordenada por construção — sem timer e sem re-checagem. A alternativa que eu quase
escrevi era soltar no `_onDefocus()` da janela X11, dentro do pacote, e ela tem uma **corrida**: o
`set_focus` do cliente percorre `id_to_window` em ordem de `wid`, então trocar o foco entre duas
janelas X11 poderia soltar depois de tomar, e o teclado ficaria com ninguém. Duas autoridades sobre o
mesmo booleano é exatamente o que o comentário do `_tomarTeclado` avisa.

**Isto é do `vssh-sso` e mesmo assim não encosta no 3b:** `focus()` é o único ponto por onde toda
janela passa — nenhuma subclasse o sobrescreve, e isso virou asserção de teste —, e a linha não fala
com `#screen` nem com `_proxy`. Os sete `captureKeyboard(false)` ficam redundantes e inofensivos;
apagá-los é limpeza de outro dia, em sete arquivos.

**Guarda:** `tests/unit/teclado-por-foco.test.js` **executa** o `focus()` sobre uma janela de mentira,
porque a afirmação é sobre **ordem** e uma varredura aprovaria as duas linhas em qualquer uma delas.
Três refutações, e a do meio é a que justifica o custo de executar: a soltura **depois** do
`_onFocus()` deixa a janela X11 sem teclado no próprio foco, e passa verde em qualquer regex.

### E a soltura não funcionou — porque **nenhum host está instalado**

Terceiro relato, e ele refuta o meu diagnóstico de duas horas antes: *"deu certo a captura, mas ainda
não a descaptura."* A linha que eu tinha posto no `VsshWindow.focus()` é **inerte**, e a razão vale
mais que o conserto:

```js
// vssh-client/js/host/vssh-host.js
VsshHost.autoSelect = function () {
  VsshHost.use(VsshHostStandalone);      // ← sempre, desde a Onda 2.7
```

`vsshHost` só encaminha para a implementação instalada. No `host-standalone`, `captureKeyboard` é um
**no-op** e `can('keyboardGrab')` é **falso**. O `host-xpra.js` existe — está no manifesto do pacote,
define `window.VsshHostXpra` — e **nenhum arquivo o consome**: o próprio comentário do `autoSelect`
diz que "se ele definir `VsshHostXpra` depois do boot, é tarde".

> Então as treze subclasses e a minha linha nova pedem o teclado de volta, e **nenhuma é ouvida**. A
> tabela de "7 de 13" que eu escrevi acima está certa sobre quem pediu e errada sobre o efeito: **as
> treze eram no-op.** Foi a captura, que o pacote faz direto no `client`, que funcionou — e é por isso
> que ela funcionou e a soltura não.

**Instalar o host resolveria os dois lados de uma vez, e é decisão do item 3b — não deste conserto.**
O que vem junto, medido:

| o que acende | e o que ele faz hoje |
|---|---|
| `keyboardGrab` | **o que se quer**: os treze `captureKeyboard(false)` passam a ser ouvidos |
| `nativeApps` | "Abrir com" volta a oferecer aplicativo Linux em 6 sítios, lançando por `client.start_command`. Era o comportamento pré-2.7, e o mime vem do portal (`/api/apps/mime-cache`), não do X11 |
| `workarea()` | **quebra**: devolve `[x,y,w,h]` — ARRAY, em pixel de DISPOSITIVO — onde o `TilingManager` espera `{x,y,w,h}` em pixel CSS. `wa.w` seria `undefined` |
| `nativeWindows()` | **duplica**: devolve as janelas X11 ao `TilingManager` pelo `xpraAdapter`, e desde o 3a elas já estão em `VsshWindow._all`, pelo `pseudoAdapter` |

As duas últimas são exatamente a dupla autoridade que o **3b** apaga. Ligá-las hoje seria trabalhar
contra ele — então a ordem é: 3b primeiro, depois `host-xpra.js` conserta o `workarea` (ou o
abandona, porque o shell já deriva o dele da viewport) e some com o `nativeWindows`, e só então
`autoSelect` volta a ter alternativa.

**Enquanto isso o pacote segura as duas pontas** (`0.7.6`), o que é honesto porque é ele quem alcança
o `client`:

| | |
|---|---|
| `_tomarTeclado()` | no foco — `_onFocus` e o ramo sem cromo do `updateFocus` |
| `_soltarTeclado()` | no desfoco (`_onDefocus`) **e no minimizar**, que não passa por `_defocus()`: o `set_minimized` esconde a div sem tocar no foco do ambiente, e o teclado ficava com uma janela que ninguém vê |
| o árbitro | `focused_wid`. O `set_focus` percorre `id_to_window` **em ordem de `wid`**, então trocar o foco entre duas janelas X11 podia soltar DEPOIS de tomar — defeito que só aparece com duas janelas abertas, e na ordem errada |

A linha do `VsshWindow.focus()` **fica**, com o comentário corrigido: é o lado do shell da mesma
regra, no lugar certo, para o dia em que o host for instalado. As duas pontas dizem a mesma coisa.

### E desligar o motor deixava o Iniciar e o Launchpad cheios

Mesmo relato, mesma forma: **o motor escreve no ambiente e não desfaz.** Quem enche as duas listas com
os aplicativos X11 é o `Client.js`, no handshake — `window.startMenu.populate(this.xdg_menu)` —, e
desligar o Motor X11 deixava a lista inteira na tela. Clicar num ícone dela chamaria o
`iniciarComando` de um motor que já não existe.

O de-init chama `populate({})`: o **mesmo caminho** da população, vazio. Os vssh-apps não saem, e é de
propósito — o `_injectVsshApps()` que o `populate` chama no fim os remonta de `GET /api/apps`, que não
tem nada a ver com X11.

A **conferência nº 6** passou a cruzar isto do mesmo jeito que já cruzava a geometria: lê do
`Client.js` quais superfícies do ambiente o motor popula e cobra cada uma do `desinicializar()`. Uma
atualização do xpra-html5 que popule uma terceira fica vermelha aqui. Entre as seis refutações está o
de-init **citando** os menus num comentário sem fazer nada — a armadilha que o `soCodigo` existe para
pegar, e que já tinha pegado esta guarda uma vez.

**Fica em aberto, e é do `vssh-sso`:** o `enable_clipboard_autofocus()` da mesma função perdida também
não foi herdado por ninguém, e a `SettingsWindow` desliga a captura no `_onFocus()` **sem**
`_onDefocus` que a devolva — hoje inócuo, porque nenhuma das duas pontas do shell é ouvida. Os dois
valem uma varredura quando o 3b abrir o arquivo.

---

## Dois defeitos do carregador num log de duas linhas — e o 502, que é do portal

`vsshapp-xpra` **0.7.7**. O console de quem desabilitou e reabilitou o Motor X11:

```
GET .../js/lib/detect-zoom.js  502     ← uma cadeia, já no MEIO do manifesto
GET .../js/lib/rencode.js      502     ← OUTRA cadeia, no PRIMEIRO arquivo dele
```

Duas posições diferentes do mesmo manifesto ao mesmo tempo, e é o que denuncia os dois defeitos —
nenhum deles é o 502.

**1. `carregarTudo()` recarregava tudo a cada `conectar()`.** Com o manifesto em mãos ele chamava
`carregar(0)`: baixava e **reavaliava** os 22 arquivos. O shell já promete o contrário, na linha em que
religa um motor — *"religar é `conectar()`, sem baixar nada de novo"*. E reavaliar não é desperdício, é
**errado**: um `<script>` clássico que declara `class XpraClient` avaliado duas vezes é
`SyntaxError: Identifier 'XpraClient' has already been declared` — o arquivo não roda, **o `onload`
dispara igual**, e a cadeia segue como se nada tivesse acontecido.

**2. Duas cadeias em voo**, porque nada impedia que houvesse duas.

| | |
|---|---|
| `cargaEmVoo` | uma carga por página. Quem chega depois recebe a **mesma** promessa, inclusive depois de ela resolver — é isso que torna reconectar barato de verdade. Falhou? volta a `null`, para que a próxima tentativa seja uma tentativa |
| `carregados` | até onde se chegou. Uma carga interrompida no meio **retoma** dali, em vez de passar por cima do que já entrou |

**O 502 é do proxy do portal, e não se conserta daqui.** Ele significa que o backend do app não estava
atendendo quando o arquivo foi pedido — e o `_carregarMotorDoApp()` do shell já espera o
`AppLauncher.ensureRunning()` antes de injetar o carregador, com um comentário dizendo que o proxy
devolve **409** enquanto o processo não estiver confirmado de pé. Veio 502, não 409: ou o processo caiu
entre o `ensureRunning` e o pedido seguinte, ou o `ensureRunning` resolveu com uma prontidão que já não
valia. **A pergunta que decide é uma:** o `app.log` tem uma das seis linhas de saída
(`xpra-saiu`, `xpra-adotado-sumiu`, `xpra-nao-lancou`, `escuta-falhou`, `ja-escutando`,
`encerrando`)? Todas as seis são gravadas com `registrarSincrono`, que existe justamente para
sobreviver ao `process.exit` — se nenhuma estiver lá, o processo não morreu e a prontidão é que estava
velha, o que põe isto ao lado do item 6.

**Guarda:** `tests/carregador-nao-recarrega.test.js` **executa** o carregador num ambiente de mentira
(`currentScript`, `createElement`, `head.appendChild`, um `fetch` que recusa e um `XpraClient` que
estoura de propósito), e o manifesto que ele usa é o de verdade — avalia o `arquivos.js` do pacote. As
duas afirmações são sobre **contagem** e **ordem**; varredura de texto não alcança nenhuma das duas.

> **E a refutação pegou um erro meu, que é a razão de ela existir.** Eu ia acrescentar um
> `anunciar('erro')` na carga, com a justificativa de que uma falha deixava o motor preso em
> `carregando` e o erro existia só no console. **Falso:** o `.catch` no fim de `conectar()` anuncia
> `erro` desde sempre, e o comentário dele já citava *"rede caindo no meio dos 28 arquivos"*. Tirar o
> meu `catch` deixava o teste **verde** — o que só é possível se alguém mais estivesse fazendo o
> trabalho. O `catch` redundante saiu; o caso ficou, apontado para o mecanismo de verdade.

---

## 7. 📋 O portal conta ao motor a DPI da tela de quem está abrindo

> **Este item era "o tamanho E a DPI", e a metade do tamanho se dissolveu na `0.7.3`.** Uma linha do
> log, três segundos antes de qualquer cliente existir, mudou o diagnóstico:
>
> ```
> Warning: cannot set resolution to (8192, 4096) · (this resolution is not available)
> ```
>
> **O próprio xpra tenta esticar a tela na largada** — ele quer um root window espaçoso para depois
> encaixar a resolução de cada cliente dentro dele, por RandR. Com `-screen 0 1920x1080`, o pedido é
> recusado, e é essa recusa que faz o `xrandr --newmode` do cliente levar `BadMatch`: **não se
> adiciona modo maior que o tamanho máximo da tela.** Não faltava RandR, faltava espaço.
>
> Eu lia `VSSH_X11_WIDTH/HEIGHT` como "o tamanho da área de trabalho". Elas eram o **teto** — e um
> teto de 1920x1080 é também o piso. A `0.7.3` põe o padrão em 5760x2560 (59 MB de framebuffer, o
> padrão histórico do xpra), e o cliente passa a escolher a resolução dentro dele **sem o portal
> mandar nada**: o `hello` já informa o tamanho.
>
> **Sobra a metade da DPI, e ela não se dissolve** — mas primeiro ela piorou, por minha causa, e o
> log mostrou as duas coisas na mesma sessão:
>
> ```
> server virtual display now set to 2881x1565    ← a resolução passou a acertar
> DPI set to 48 x 59 (wanted 168 x 168)          ← e a DPI caiu pela metade
> ```
>
> **O que o Xvfb fixa é o tamanho FÍSICO**, que é `teto / -dpi`. Teto 3× maior com o mesmo `-dpi` dá
> físico 3× maior — e o xpra encolhe a RESOLUÇÃO para dentro dele, então a DPI efetiva cai na mesma
> proporção. A conta fecha nos dois eixos: `2881/1524mm × 25.4 = 48,0` e `1565/677mm × 25.4 = 58,7`.
> Para quem usa, isso é fonte minúscula em toda aplicação: **pior que os 96 de antes.**
>
> A `0.7.4` faz o `-dpi` escalar com o teto (`DPI × teto_largura / 1920`), de modo que o físico fique
> sempre em **508 × 285,75 mm** — as medidas de um 1080p de 23", qualquer que seja o teto. E aí o
> comportamento é o certo e não uma heurística: mais pixels no mesmo tamanho físico **é** mais denso.
> `1920x1080 → 96x96`, `2881x1565 → 144x139`, `3840x2160 → 192x192`.
>
> **E o teto teve de mudar de proporção junto**, o que foi a segunda armadilha: 5760x2560 é o padrão
> histórico do xpra e eu o copiei sem fazer a conta. Ele é 2.25:1 contra 1.78:1 da referência, e o
> Xvfb aceita **um** `-dpi` para os dois eixos — daí sairia `96 x 122` num cliente 1080p. Passou a
> ser 5760x3240, que é 3× a referência exata (71 MB em vez de 56).
>
> **Os 168 exatos seguem fora de alcance com Xvfb, e agora se sabe exatamente por quê:** o físico
> teria de ser `resolução_do_cliente / DPI_do_cliente`, o que depende do cliente na criação da tela
> — inclusive da proporção dele. Ou o portal manda os três, ou se usa o dummy do Xorg, que sabe mudar
> o físico junto com o modo. É o que o xpra recomenda ao recusar, e agora com a aritmética por trás.


**Item novo, e ele fecha DOIS sintomas medidos numa sessão real** — não é refinamento. O log do
próprio xpra, em 11/08/2026, diz os dois com as palavras dele:

```
client total display size is 2881x1565
tried to set resolution to 2881x1565 and ended up with 1920x1080
 1 sizes are supported → 1920x1080

Chromium 151 (436x237 mm - DPI: 168x168)
DPI Issue · DPI set to 96 x 96 (wanted 168 x 168)
 to fix this issue, try the dpi switch, or use a patched Xorg dummy driver
```

| O sintoma | O que estava acontecendo |
|---|---|
| **a sessão é menor que a janela** | `Xvfb -screen 0 1920x1080x24` oferece **um** modo RandR; o xpra tenta adicionar `2881x1565` e leva `BadMatch`. Nenhuma janela X11 alcança a borda, e maximizar preenche 1920×1080 de uma área maior |
| **o texto é supersampling, não HiDPI** | a DPI de uma tela X é **derivada** — pixels sobre tamanho físico em mm —, e o `Xvfb` fixa o tamanho físico ao criar a tela. Nem o `--dpi` do xpra nem cliente nenhum a mudam depois |

**Os dois têm a mesma raiz, e ela é uma só frase: o servidor X é criado pequeno e fixo, antes de
existir cliente.** Foi por isso que a tentativa anterior falhou — a `0.7.0` trocou `--dpi=96` por
`--dpi=0` (que diz ao xpra "siga o cliente"), e o `xrdb -query` continuou em 96: o xpra tentou e o
servidor recusou.

**O pacote já fez a metade dele** (`0.7.2`): `VSSH_X11_DPI` existe, com padrão 96, na mesma costura
que `VSSH_X11_WIDTH`/`VSSH_X11_HEIGHT` já usavam — o portal escreve no `env` do app o que só ele
sabe. E o Xvfb passou a declarar `+extension RANDR +extension Composite` em vez de contar com o
padrão do build, que foi o que produziu *"1 sizes are supported"*.

**O que falta é do `vssh-sso`:**

| | |
|---|---|
| onde | o `startApp`, no ponto em que ele escreve o arquivo `env` do app (`vssh-apps.ts`) |
| o quê | `VSSH_X11_WIDTH` e `VSSH_X11_HEIGHT` = `innerWidth/innerHeight × min(dpr, 2)`, e `VSSH_X11_DPI` = `96 × min(dpr, 2)` |
| quem sabe | o **navegador**, e só ele. O valor tem de subir do cliente ao portal na hora de ligar o motor |

Com os três chegando, a tela nasce do tamanho certo e **não há redimensionamento a recusar** — o que
resolve os dois sintomas com o `Xvfb` de sempre, sem depender do dummy do Xorg.

**A alternativa, e ela já existe no pacote:** o ramo `VSSH_X11_XVFB=xorg` (`xpra.sh`) sobe um `Xorg`
com o driver dummy, que é literalmente o que a mensagem do xpra recomenda — ele tem lista de modos e
tamanho virtual grande, então aceita redimensionar e reportar outra DPI. Exige `/etc/xpra/xorg.conf`
no servidor, e é decisão de provisionamento e não de código.

**A limitação que fica de pé nos dois caminhos, e é honesto dizê-la:** a tela é da **sessão**, e a
sessão sobrevive ao navegador — mais ainda desde que a `0.6.1` adota uma sessão existente. Um segundo
navegador com janela de outro tamanho volta a bater no teto. É a mesma tensão do DPI, e ela só
desaparece com um servidor X que aceite redimensionar ao vivo — ou seja, com o ramo `xorg`.

**Guarda:** com o portal mandando os três, o log do xpra da sessão **não** contém `DPI Issue` nem
`tried to set resolution`. São as duas linhas que ele imprime quando recusa, então a ausência delas
é a afirmação — e refutar é fixar `VSSH_X11_WIDTH` num valor diferente do da janela.

---

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 1 | ✅ nós servimos o `frontend/`; xpra com `--html=off` — e o app ganhou um backend Node | `vsshapp-xpra` | — |
| 2 | ✅ a ponte WS → socket nativo, e o `transport` virou `socket` | `vsshapp-xpra` | 1 |
| — | ✅ **o ambiente ficou sem nenhum app em porta** — o item 5 está liberado | | 2 |
| 3a | ✅ a janela X11 vira uma `VsshWindow`; o cromo, o arraste, o resize e o `jquery-ui` (19.061 linhas) saem do motor | `vsshapp-xpra` | 1 |
| 4 | ✅ o jQuery sai do pacote (**33.980 linhas**) — e o carrossel Alt+Tab é apagado, não portado | `vsshapp-xpra` | **3a**, não 3 |
| — | ✅ **o repositório do pacote fechou** — o que resta da onda é todo do `vssh-sso` | | 4 |
| — | ✅ **e reabriu por um incidente**: 0.6.1, quatro defeitos, três deles decisões do item 2 | `vsshapp-xpra` | — |
| 3b | 📋 o outro lado: os proxies (**dois donos**), o `xpraAdapter` e os **31 ramos por família** saem | `vssh-sso` | 3a |
| 3c | 📋 um vssh-app recebe e produz arquivo arrastado — **um contrato**, e as três direções caem dele | toolkit + `vssh-sso` | **3b**, para não escrever contra a máquina que ele demole |
| 4d | 📋 o ambiente ganha o Alt+Tab que o motor levou embora — sobre `VsshWindow._all` | `vssh-sso` | 3a |
| 5 | 📋 **a orquestração de porta morre** — os onze lugares, o `nextLoopback` e o teto de **254** (era o `0d` da [Onda 9](08-editor-do-ambiente.md)) | `vssh-sso` | 2 |
| 6 | ✅ **feito** — um start em voo por `<servidor, usuário, app>`; é trava e não cache, e o `restartApp` espera em vez de coalescer | `vssh-sso` | — |
| 7 | 📋 o portal conta ao motor a **DPI** da tela — a metade do TAMANHO se dissolveu na 0.7.3 (o teto do Xvfb era 1920x1080) | `vssh-sso` | — |
| — | 📋 **o `createAppLog` do toolkit grava síncrono** — hoje todo vssh-app perde a última linha antes de `process.exit()` | `toolkit` | — |

**A onda declarou o pacote fechado e o pacote reabriu.** Vale registrar por que isso não é o processo
falhando: o item 2 tinha uma peça marcada como não verificável sem servidor real, e o incidente foi
o servidor real chegando. O que ele achou não foram detalhes de implementação — foram **três decisões
de desenho**: a ordem do boot, o significado de um socket vivo, e quem mata o filho. Nenhuma delas
teria aparecido em teste de unidade escrito antes, porque as três só existem sob concorrência que só
o portal produz.

**O item 1 destravou tudo e não dependia de nada**, porque servir o próprio frontend é o que todo
vssh-app já faz. O item 3 não espera a ponte: agora que a página é nossa, o cliente é nosso para
reformar.

~~"O item 4 trava no item 3."~~ **Trava no 3a, e a diferença fechou o repositório do pacote.** A
razão de o carrossel virar deleção é a janela X11 já estar em `VsshWindow._all` — quem entrega isso
é o **3a**, dentro do `vsshapp-xpra`. O **3b** apaga o *outro* lado (proxies, `xpraAdapter`, os 31
ramos), e nada do que o item 4 removeu lia qualquer um deles. Ou seja: o 4 pôde ser feito sem o 3b,
e com ele **o `vsshapp-xpra` não tem mais trabalho nesta onda**.

**O que restou é todo do `vssh-sso`** — 3b, 4d e 5 —, e nenhum dos três trava nos outros dois.
O 5 é o único com trava operacional: apagar a orquestração de porta antes de o pacote **0.6.0**
estar instalado nos servidores deixa o motor sem endereço.

## Verificação

- **Toda afirmação sobre o xpra com a medida ao lado**, feita na 6.5.2 de produção — a versão do
  archive do Ubuntu é outra e responderia sobre outra coisa.
- **O controle continua obrigatório.** A medida que decidiu esta onda só valeu porque o mesmo
  servidor serviu por TCP na mesma corrida; sem isso, "o socket não respondeu" seria a montagem do
  teste. Toda medida nova aqui carrega o par.
- **Cada guarda por refutação**, com linha de base verde antes e a fonte real mutada.
- `npm test` do `vssh-sso` parte de **1.476** e não pode cair. **⚠ Este número dizia 1.362, e estava
  velho de novo** — a suíte cresceu 109 casos entre a escrita e a execução do item 6, e um piso
  desatualizado não segura nada. É a **segunda** vez que o mesmo número envelhece nesta dupla de
  ondas; ele só vale relido no dia em que se fecha um item.

## O que esta onda NÃO faz

- **Não troca o xpra por outro motor.** A pergunta "xpra ou Wayland/`wayvnc`/RDP" é de produto e não
  se responde de passagem; esta onda torna o motor **substituível**, que é o pré-requisito de fazê-la
  um dia. Quem serve a página passa a ser nosso, e o registro de motores da
  [2.7](02b-motores.md) já existe.
- **Não mexe no `IframeHostWindow`.** Ele existe declaradamente para code-server e OnlyOffice
  (`IframeHostWindow.js:3-13`) — o xpra nunca passou por ele.
- **Não promete que o cliente HTML5 aguenta ser dividido em N janelas** sem custo de render. É a
  incerteza real do item 3, e a resposta é uma medida com uma sessão de verdade — não uma frase
  aqui. O que a leitura do código já garante é que o custo não muda de natureza: cada janela X11 já
  tem hoje um `<canvas>` próprio (`init_canvas`), com `OffscreenCanvas` por janela quando o worker
  de decode está ligado. O que muda é o PAI da div, não o número de canvases.
