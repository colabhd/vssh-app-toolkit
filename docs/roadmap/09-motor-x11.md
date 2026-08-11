# Onda 10 — O motor X11 para de ser um cliente hospedado: nós servimos a página, e as janelas dele viram nossas

> **Estado:** 🚧 **em execução — os itens 1 e 2 fecharam, e com eles o ambiente ficou sem nenhum app
> em porta.** A medida veio antes, na Onda 9: as três respostas que decidem esta onda foram tiradas
> de um xpra **6.5.2 de produção**, não da documentação dele. · **Atualizado:** 2026-08-10
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

## 3. 📋 As janelas do xpra viram `VsshWindow`

Hoje o cliente do xpra traz o **próprio gerenciador de janelas**: `frontend/js/Window.js`, **1.501
linhas** — barra de título, botões, minimizar, arraste —, desenhando por cima do desktop que já tem
tudo isso.

E o ambiente paga por essa diferença **do outro lado**. `VsshWindow.js:101-108` diz por extenso:

> *"o canvas do Xpra captura o ponteiro mesmo onde é transparente. Por isso cada janela mantém um
> **proxy invisível** dentro do `#screen`: é ele, e não o conteúdo, que recebe os eventos."*

E registra o dano junto: *"arrastar um arquivo para outra janela do gerenciador nunca chegava aos
handlers de drop dela"*. São **47 ocorrências de `proxy`** naquela classe, mais a dança de
`_dragRaised`/`_dragHooked` — elevar sem focar, porque focar B desfoca A e **reativa o proxy de A**,
quebrando o arraste de volta.

**Nada disso é otimizável: é apagável.** Se cada janela X11 for uma `VsshWindow` de verdade, não há
canvas alheio capturando ponteiro, não há proxy, não há elevação-sem-foco.

**Guarda:** `tests/unit/arraste-entre-janelas.test.js` — arrastar um arquivo de uma janela do
gerenciador para outra chega ao handler de drop **com uma janela X11 aberta na tela**. É o defeito
que o comentário descreve, virado teste. Refuta: reintroduzir o canvas em tela cheia por cima.

## 4. 📋 O último jQuery do ambiente sai — e ele é o maior

A [Onda 8](07-shell-proprio.md) tirou o jQuery do shell (**824 KB a menos**) e fechou. **O ambiente
continua entregando jQuery ao navegador**, escondido dentro deste app:

| | |
|---|---|
| `frontend/js/lib/jquery-ui.js` | **19.061 linhas** |
| `frontend/js/lib/jquery.js` | **10.716 linhas** |
| `frontend/js/lib/slick.js` | **3.011 linhas** |
| `frontend/` inteiro | **2,3 MB**, 31 arquivos |
| **call sites de `$(` no cliente** | **35**, em três arquivos |

**Trinta mil linhas para 35 chamadas** — e as chamadas são `.parents()`, `.closest()`, `.addClass()`
e `.css()` (`Window.js:144,228,369,1234`), que são uma linha de DOM cada.

~~"O item 3 já apaga `Window.js`, que é onde a maioria delas mora."~~ **Contado, e é o contrário:**
`Window.js` tem **5** ocorrências (uma delas comentário), `Notifications.js` tem **9**, e
`Client.js` tem **21** — a maioria mora justamente no arquivo que o item 3 NÃO apaga. E as de lá não
são uma linha de DOM cada: são o carrossel `slick` do Alt+Tab (`window-preview`, `.slick-current`) e
a pasteboard do clipboard. Então este item não sai de carona no 3 — ele tem trabalho próprio, e o
maior pedaço dele é substituir o carrossel. O `jquery-ui` (19.061 linhas) é que sai com o 3: quem o
usa é o `draggable`/`resizable` do `Window.js`, em 16 lugares.

> É a mesma forma do achado da Onda 8: *"a premissa do jQuery estava invertida, e a medida diz de que
> lado"*. Lá o shell tinha menos jQuery do que se dizia; aqui o ambiente tem mais, e num lugar onde
> ninguém procurou.

**Guarda:** o teste que a Onda 8 deixou, apontado para o pacote — nenhum `<script>` de jQuery servido
por app nenhum. Refuta: revendorizar a lib.

---

## 5. 📋 A orquestração de porta morre — e ela mudou de onda para cá

**Era o passo `0d` da [Onda 9](08-editor-do-ambiente.md), e ficar lá era um erro de endereço.** O
passo 0 daquela onda trocou o endereço de um vssh-app de porta para socket, e o `0d` seria a
consequência: apagar os onze lugares que sabem a porta. Só que eles **não sobreviviam por inércia** —
sobreviviam porque **um app ainda declarava `transport: "tcp"`**, e esse app era o xpra. Quem o
deixou sem assunto foi o item 2 desta onda, e por isso o item mora aqui, ao lado da medida que o
autoriza.

**O item 2 fechou: este está liberado, e é o único da onda que ainda não foi feito no `vssh-sso`.**
O gate agora é operacional e não técnico — apagar a orquestração de porta antes de o
`vsshapp-xpra` 0.5.0 estar instalado nos servidores deixa o motor sem endereço, porque o portal
passaria a montar o túnel só para socket enquanto o app instalado ainda binda porta.

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

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 1 | ✅ nós servimos o `frontend/`; xpra com `--html=off` — e o app ganhou um backend Node | `vsshapp-xpra` | — |
| 2 | ✅ a ponte WS → socket nativo, e o `transport` virou `socket` | `vsshapp-xpra` | 1 |
| — | ✅ **o ambiente ficou sem nenhum app em porta** — o item 5 está liberado | | 2 |
| 3 | 📋 as janelas viram `VsshWindow`; os 47 proxies saem | `vsshapp-xpra` + `vssh-sso` | 1 |
| 4 | 📋 o jQuery sai do pacote | `vsshapp-xpra` | 3 |
| 5 | 📋 **a orquestração de porta morre** — os onze lugares, o `nextLoopback` e o teto de **254** (era o `0d` da [Onda 9](08-editor-do-ambiente.md)) | `vssh-sso` | 2 |

**O item 1 destravou tudo e não dependia de nada**, porque servir o próprio frontend é o que todo
vssh-app já faz. O item 3 não espera a ponte: agora que a página é nossa, o cliente é nosso para
reformar.

**E o item 5 é o único que toca o `vssh-sso`**, o que faz dele o fim da fila e não o começo: enquanto
o item 2 não fechar, apagar a orquestração de porta quebra o ambiente — ela existe hoje **para servir
um app só**, e o custo disso está medido: um `127.0.0.x` por servidor e um teto de 254.

## Verificação

- **Toda afirmação sobre o xpra com a medida ao lado**, feita na 6.5.2 de produção — a versão do
  archive do Ubuntu é outra e responderia sobre outra coisa.
- **O controle continua obrigatório.** A medida que decidiu esta onda só valeu porque o mesmo
  servidor serviu por TCP na mesma corrida; sem isso, "o socket não respondeu" seria a montagem do
  teste. Toda medida nova aqui carrega o par.
- **Cada guarda por refutação**, com linha de base verde antes e a fonte real mutada.
- `npm test` do `vssh-sso` parte de **1.362** e não pode cair.

## O que esta onda NÃO faz

- **Não troca o xpra por outro motor.** A pergunta "xpra ou Wayland/`wayvnc`/RDP" é de produto e não
  se responde de passagem; esta onda torna o motor **substituível**, que é o pré-requisito de fazê-la
  um dia. Quem serve a página passa a ser nosso, e o registro de motores da
  [2.7](02b-motores.md) já existe.
- **Não mexe no `IframeHostWindow`.** Ele existe declaradamente para code-server e OnlyOffice
  (`IframeHostWindow.js:3-13`) — o xpra nunca passou por ele.
- **Não promete que o cliente HTML5 aguenta ser dividido em N janelas** sem custo de render. É a
  incerteza real do item 3, e a resposta é uma medida com uma sessão de verdade — não uma frase
  aqui.
