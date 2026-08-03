# Onda 2 — APIs de shell: tray, notificações, clipboard, impressão

> **Estado:** em andamento · **Atualizado:** 2026-08-02 · **Repos:** `vssh-sso` + toolkit
> **Dependência da** [Onda 1](01-sessao-sem-xpra.md) **satisfeita** — a sessão existe
> (`services/session.ts`), e com ela o canal que esta onda precisava.
>
> **Feito:** a [2.1 inteira](#21--tray---concluída) — bandeja com as duas fontes (app com janela e
> `engine`/`service` por arquivo), o transporte da [2.0](#o-transporte-o-coletor-por-servidor---feito),
> a taskbar obedecendo às capabilities e a tela cheia no hambúrguer.
> **Falta:** 2.2 a 2.6.
>
> ⚠ **A [Onda 0c](0c-colapso-de-variantes.md) é pré-requisito da 2.6** e recomendada antes da 2.2:
> enquanto o tema `neon` e o modo `dock` existirem, cada superfície nova aqui nasce com duas
> variantes para manter.

Quatro superfícies que faltam para o ambiente ser um desktop de verdade. As quatro atravessam os
[dois critérios](criterios.md) — e três delas mudaram de escopo por causa disso.

---

## 2.0 — O canal (o problema difícil)

Um `engine`/`service` **não tem iframe**, logo não tem `postMessage`. E a rede é assimétrica: o
portal alcança o app pelo túnel; **o app não alcança o portal**.

O modelo é: **estado por arquivo (pull), ação por HTTP (push)**.

- **Estado** — o app escreve um arquivo; o `vssh-app-supervisor` já estabeleceu o idioma com
  `status.json` (escrita atômica `tmp` + `mv -f`).
- **Ação** — o clique no ícone vira `POST /<serverId>/proxy/app/<id>/<callback>`, que já funciona
  hoje: autenticado, com `X-Vssh-App-Token` injetado pelo proxy.

### Canal shell↔navegador: usar o `/ws/events`, não criar um segundo

Uma versão anterior deste plano pedia um `src/ws/shell.ts` novo. **Depois da Onda 1 ele seria
duplicação.** O `/ws/events` já é tudo que esse canal precisaria ser:

| Requisito | `/ws/events` hoje |
|---|---|
| por (usuário, servidor) | serverId vem do path, `linuxUser` resolvido no upgrade |
| autenticado | `sessionMiddleware` + passport |
| escopo = sessão | carrega `ws.sessionKey`; `retainSession`/`releaseSession` |
| heartbeat | ping/pong de 30 s dos dois lados |
| reconexão automática | `onclose` reabre em 2 s |
| **aberto nos dois modos** | **sim, desde a Onda 1.1** — antes só o caminho do Xpra o abria |

Um segundo socket duplicaria autenticação, heartbeat, resolução de sessão, reconexão e o
tratamento do `migrate` no shutdown, e dobraria conexões por usuário. Rotear para uma sessão é um
`for` sobre `activeEventConnections` filtrando por `ws.sessionKey`.

**Portanto:** mensagens tipadas no canal existente (`{type:'tray'|'notify'|'app-ready'}`). O
comentário do topo de `ws/events.ts` ainda diz *"NÃO conta como sessão de usuário; é canal de
controle"* — ficou desatualizado na Onda 1 e sai junto.

### ⚠ Correção de premissa

> Uma versão anterior deste plano escolheu `fs.watch` como transporte "porque custa zero canais SSH
> novos". **Custa zero apenas para um usuário que já tenha um watch aberto.** Como tray e
> notificações seriam ligadas para *toda sessão*, isso converteria um custo opcional num custo **por
> usuário logado** — contra um orçamento de **~8 canais do servidor inteiro**
> ([diagnostico](diagnostico.md#-teto-de-canais-ssh-8-por-servidor-não-por-usuário)).
>
> O desenho quebraria por volta de **oito usuários simultâneos**, e sem erro legível: o sintoma seria
> a rajada de 409 com o app vivo que `da6bfb5` acabou de consertar.

### O transporte: o coletor por servidor · ✅ feito

`src/services/tray-collector.ts`. A escolha entre as duas opções que este plano listava caiu na
**segunda**, e não por acaso.

O plano preferia um **vigia privilegiado com inotify** (1 canal permanente por servidor) e tratava
o **poll em lote** como alternativa "ao preço de latência". Invertemos: um exec transiente por
servidor a cada 5 s (`VSSH_TRAY_POLL_MS`) ganha em duas coisas que pesam mais que a latência —
**não segura canal nenhum entre os ticks**, e **não precisa de daemon novo** no servidor. E a
bandeja tolera segundos: *"sincronizando 3 de 12"* não é tempo real.

| | vigia inotify | coletor por poll |
|---|---|---|
| canal SSH em repouso | 1 permanente por servidor | **zero** |
| daemon novo no servidor | sim | não |
| custo com N usuários | constante | constante (1 exec cobre todos) |
| latência | ~imediata | ≤ 5 s |

**E uma propriedade que nenhum dos dois desenhos originais tinha:** a lista de quem varrer sai de
`activeSessions()`, não de um glob em `/home/*`. Servidor sem navegador conectado **não recebe exec
nenhum**, por mais daemons que estejam rodando nele — custo proporcional ao *interesse*, não ao
parque.

Detalhes que valem estar escritos:
- o `poolKey` do agrupamento sai da **própria chave da sessão** (`<sshPoolKey>::<linuxUser>`), que a
  Onda 1 já canonicalizou. Sem isso, `serverId` chegando ora como nome ora como id produziria dois
  execs para o mesmo servidor — o custo que o desenho existe para não ter;
- só o **delta** atravessa. Reenviar a bandeja inteira a cada tick faria o `TrayArea`
  re-renderizar de 5 em 5 s, matando hover e fechando menu aberto;
- a leitura roda como root (o provisionador tem sudo) porque um exec só precisa alcançar várias
  homes. Não é capacidade nova — é o mesmo sudo que cria conta e sobe o supervisor. O que se
  restringe é o **alcance**: glob fixo, teto de 8 KB por arquivo, home vinda do `getent`;
- o coletor recebe a fonte de sessões e o canal por **injeção**, não por import. Importar
  `ws/events.ts` fecharia ciclo — e o tick inteiro fica exercitável sem SSH nem WebSocket.

**O que NÃO foi feito, e é escolha:** o `MAX_WATCHES_PER_USER` continua onde está (ver abaixo). O
coletor não substitui o `vssh.fs.watch`, que é por caminho arbitrário e precisa de latência baixa.

### Isto conserta dívida existente

`vssh.fs.watch` **já** segura um canal por usuário hoje, e um vigia por servidor seria o caminho
para os watches de app virarem fan-out dele, aposentando o `MAX_WATCHES_PER_USER = 4`
(`fs-watch.ts:54`).

> **⚠ O coletor da bandeja NÃO conserta isso, e é bom não confundir os dois.** Ele é poll de
> 5 s sobre um caminho fixo; `fs.watch` promete notificação de caminho arbitrário escolhido pelo
> app, com latência de edição de arquivo. Trocar um pelo outro entregaria um `watch` que avisa
> segundos depois — pior que o de hoje, e silenciosamente. O conserto do `fs.watch` continua em
> aberto e continua pedindo inotify.

---

## 2.1 — Tray · ✅ concluída

O item que motivou esta onda. **Toda a Categoria C é inviável sem ela** — ninguém abre Configurações
para saber se o rclone está sincronizando.

> **✅ Feito:** `vssh-client/js/TrayArea.js` + `css/tray.css`; a fonte de **app com janela**
> (`case 'tray'` no `_setupAppBridge`, remoção no `_beforeClose`); `vssh.tray.set/remove` no shim,
> documentado em [`../api.md`](../api.md); o `hello-vssh-app-node` exercita a ponta a ponta.
>
> **✅ E a fonte de `engine`/`service`** — a que serve o caso que motivou a subonda, porque o
> rclone sincronizando não tem janela e portanto não tem `postMessage`. `tray.json` coletado por
> servidor e empurrado pelo `/ws/events`; do lado do app, `lib/node/vssh-tray.js` no toolkit.

**Contrato do arquivo** — `~/.vssh-apps/<id>/tray.json`, só dados:

```jsonc
{
  "icon": "<nome-do-sprite>" | "<path relativo ao pacote>",
  "tooltip": "Sincronizando 3 de 12",
  "badge": { "count": 3 } | { "dot": true } | { "text": "!" },
  "menu": [ { "id": "pause", "label": "Pausar", "icon": "…", "danger": false } ],
  "onClick": { "path": "/tray/click" },
  "updatedAt": "2026-08-01T12:00:00Z"
}
```

O ícone **nunca** é HTML — mesma regra do menu de contexto atual: só dados atravessam, o chrome monta
os elementos.

### ⚠ O que existe hoje NÃO é uma tray

Uma versão anterior dizia "renderiza em `#taskbar-tray`, que **já existe**", o que fazia esta
subonda soar como "acrescentar uma fonte a uma tray pronta". O que existe é um **container flex
vazio** (`vssh-client/index.html:322`, `css/taskbar.css:108`):

- O **único** renderizador é o `_process_new_tray` (`Client.js:3415`), upstream do Xpra: cria um
  `<canvas>` com `backgroundColor: white` e desenha o **pixmap X11** dentro. É bitmap, não modelo
  de dados — não há tooltip, menu nem badge para reusar;
- ele mexe em `float_menu.style.width` (`:3428-3431`): em modo taskbar anexa no `#taskbar-tray`
  mas continua redimensionando o **menu flutuante** do upstream — desenho de outra UI aparafusado
  na nossa;
- `send_tray_configure` é TODO declarado (`:3447`): mudança de geometria é ignorada;
- e o decisivo: sendo dirigido por pacote Xpra, **no perfil sem X11 a tray fica vazia** — o
  perfil que esta roadmap inteira persegue.

**Esta subonda constrói a tray.** Não é integração.

### ⚠ Correção: o `TrayArea` NÃO é dono do `#taskbar-tray`

O plano dizia "novo `TrayArea.js`, **dono** do `#taskbar-tray`", com a coexistência resolvida por o
X11 virar "mais uma fonte dentro dele". **Não dá, e a razão é de uma linha:** `Client.js:3424`
consulta `#taskbar-tray` por **seletor literal**, e Client.js é upstream MPL que a regra de
`vssh-host.js` manda não aumentar. Tomar posse do div exigiria reescrever o `_process_new_tray` —
exatamente o delta que a regra proíbe.

O que foi feito: o `TrayArea` cria o **seu** container, `#vssh-tray`, como irmão imediatamente
**antes** do container do X11 (`#taskbar-tray` em modo taskbar, `#float_tray` em modo dock). Os
dois renderizadores nunca se veem, e visualmente são uma área só; `#taskbar-tray:empty` some por
CSS, então o perfil headless não fica com espaço morto. A incompatibilidade de modelos (pixmap
contra dados declarativos) deixa de ser problema porque eles não dividem nada.

O efeito colateral de `float_menu.style.width` (`Client.js:3428-3431`) **continua** disparando em
modo taskbar, sobre um `#float_menu` escondido. É inofensivo e fica **registrado em vez de
consertado** — pela mesma regra.

**Arquivos (feitos):**
- `vssh-client/js/TrayArea.js` — dono do `#vssh-tray`; contrato de dados, badge, menu delegado ao
  `ContextMenu.show()` (que já monta a partir de dados e já escapa), excedente acima de 4 ícones;
- `vssh-client/css/tray.css`;
- ponte: `case 'tray'` no `_setupAppBridge`, síncrono, sem arquivo nenhum. O `sourceId` é derivado
  do `appId` **pelo shell** — um app que escolhesse o próprio id sobrescreveria o ícone de outro;
- toolkit: `vssh.tray.set/remove` no shim, com timeout curto e `false` em vez de promise pendurada;
- [`../api.md`](../api.md) perdeu a linha "Ícone de bandeja — sem equivalente".

**Da fonte por arquivo:**
- `src/services/tray-collector.ts` (ver [o transporte](#o-transporte-o-coletor-por-servidor---feito));
- `sendToSession()` / `hasSessionListeners()` no `ws/events.ts`, e `activeSessions()` no
  `services/session.ts`;
- `Client.js` ganhou **uma linha** — repassa `{type:'tray'}` como evento de DOM. Quem sabe o que é
  uma bandeja é o `TrayArea`, não o transporte: é a regra do `vssh-host.js` aplicada;
- toolkit: `lib/node/vssh-tray.js` (escrita atômica, mesmo idioma do `status.json`), `--parts tray`
  no `vssh-app-lib-sync`.

**Precedência janela > arquivo.** Um app pode ter os dois; sem a regra, o coletor sobrescreveria o
item da janela a cada tick, trocando callbacks vivos por um POST e fazendo o ícone piscar de 5 em
5 s. Fechar a janela devolve a posse ao arquivo — senão um engine com UI ficaria sem ícone para
sempre depois da primeira abertura.

**`shell.tray` no schema não foi feito, e é decisão:** escrever `tray.json` já É o contrato.
Uma declaração no manifest seria uma segunda fonte de verdade, livre para discordar do disco — e
não economizaria nada, já que o coletor faz um exec por servidor de qualquer forma.

### O item irmão, que apareceu ao testar: a taskbar mentia · ✅ feito

Ao abrir o perfil sem Xpra, a taskbar mostrava **áudio, clipboard e layout de teclado**. Os três
são comandados pelo transporte Xpra — `client._audio_start_stream`, `client.read_clipboard`,
`client.send_keymap`. Sem X11 não há contraparte do outro lado: o botão estava lá, aceitava o
clique e **não fazia nada**. É a mesma classe de erro que a revisão desta roadmap nomeou — *estar
lá* não é *fazer* — só que na cara do usuário em vez de num documento.

O conserto transformou "o que este ambiente faz" em dado consultável: três chaves novas no
contrato do `vsshHost`, e a taskbar consultando antes de mostrar.

| Chave | O que nomeia |
|---|---|
| `audioStream` | o stream de áudio **vindo do servidor** — não "este ambiente tem som" |
| `clipboardServer` | seleção X sincronizada com o clipboard do navegador |
| `keyboardLayout` | trocar o layout do teclado do servidor (`send_keymap`) |

O nome de `audioStream` é deliberado e o [2.5](#25--mixer-de-volume-por-aplicação) explica por quê:
`audio: false` seria falso já no passo seguinte. `#tb-layout-button` (tiling) ficou de fora do
gating — o tiling é do shell, DOM puro, e funciona igual sem X11.

**Tela cheia saiu da taskbar nos dois perfis** e virou item do hambúrguer. É ação de sessão
inteira, não algo que se alterne o tempo todo, e item de menu tem **rótulo**: quem entrou em tela
cheia lê "Sair da tela cheia" em vez de adivinhar um ícone.

---

## 2.2 — Centro de notificações (e o relógio)

### Pré-requisitos que valem antes de começar

Dois, e os dois são para não pagar o mesmo custo três vezes nas subondas 2.2, 2.4 e 2.5:

- ~~**Helper `anchorPanel(el, anchorEl)`**~~ — ✅ **feito**, como `js/AnchorPanel.js`, com
  `geometry()` puro e 11 testes. Eram 6 implementações, e a mais recente — o overflow da bandeja,
  escrito na 2.1 — **não tinha clamp nenhum**: com a barra à direita e o botão perto do rodapé, o
  painel abria metade fora da tela. O hambúrguer tinha clamp só nas duas posições verticais.
  Adotado nesses dois primeiro, de propósito: são os que estavam errados. Os outros quatro
  (StartMenu, TilingPanel, VsshWindow, Client) também alternam classes de animação, então migram
  quando alguém encostar neles — o que o helper garante é que a **7ª cópia não nasce**.
- ~~**Extrair o `/ws/events` do `Client.js`**~~ — ✅ **feito**, como `js/EventsChannel.js`. Eram ~55
  linhas nossas dentro de arquivo upstream MPL, e o custo real acabou sendo maior do que "mais uma
  edição lá": enquanto o canal era método do `XpraClient`, **abrir o canal exigia construir um
  cliente Xpra inteiro** — o que travou a separação do bundle por perfil até esta extração. O que
  chega vira evento de DOM (`vssh-tray`, `vssh-migrate`), e o listener de migração é registrado no
  construtor do cliente: só existe onde o arquivo existe, isto é, só no perfil Xpra.

### O centro de notificações

> **Estado: metade feita.** O sino, o histórico, a identidade por app e o "não perturbe" estão de
> pé (`js/NotificationCenter.js`, 14 testes de modelo). Falta o **jornal no servidor** — e é ele
> que atende o caso que motiva o item: um `kind:"service"` notificando com o shell fechado.

Havia só toasts efêmeros: sem histórico, sem persistência, sem identidade por app, sem ações.

**O que ficou de pé, e as decisões que valem registrar:**

- **A delegação acontece dentro do `Toast.show`, não nos 13 chamadores.** Nenhum call-site mudou, e
  nenhum deles pode esquecer. Quem quiser identidade passa `appId`; quem não passar é o shell
  falando, e o histórico diz `sistema` em vez de inventar um dono.
- **"Não perturbe" silencia a interrupção, não o registro.** O toast não aparece; a notificação
  continua no centro, com badge, esperando ser lida. Silenciar as duas coisas seria perder
  informação — e aí ninguém liga o modo. O botão mora no próprio painel, que é onde a mão vai
  quando o toast interrompe pela terceira vez, e grava em `/api/user/settings` (segue entre
  máquinas).
- **`merge()` já existe e é idempotente por `id`.** É o formato que o coletor vai empurrar: uma
  JANELA de entradas, não um delta exato — o mesmo que a bandeja faz. Sem idempotência, cada tick
  somaria as mesmas notificações e o badge cresceria sozinho para sempre.
- **As notificações X11 entram pelo mesmo histórico** por um wrapper idempotente sobre
  `window.doNotification` (idioma do `host-xpra.js`), e não por edição do `Notifications.js`, que é
  upstream MPL. A marca `_ncWrapped` impede empilhar wrapper sobre wrapper — que seria a mesma
  notificação gravada duas vezes, depois quatro.
- **O teste achou um buraco na primeira execução:** o regex de ícone `^[\w.-]+$` aceita `..`,
  porque o ponto está na classe — `../../etc/passwd` passava inteiro. A validação virou segmento a
  segmento.

**O que falta:**

- o **journal append-only** em `~/.vssh-notifications/journal.ndjson` como verdade, lido pelo tick
  do coletor por servidor que a 2.1 já criou (é o que respeita o teto de ~8 canais SSH por
  servidor) e empurrado pelo `/ws/events`;
- `notify` com `actions: [{id,label}]` e `persistent: true`, com a resposta voltando por
  `postMessage` (app com janela) ou `POST` (engine);
- a **Notification API do navegador** como alcance complementar.

**Onde mora o estado:** journal append-only em `~/.vssh-notifications/journal.ndjson` como **verdade**
— o emissor está no servidor, e um `kind:"service"` pode notificar com o shell fechado. `localStorage`
vira cache de leitura. Do-not-disturb é preferência de usuário → `/api/user/settings`.

**Arquivos:**
- novo `vssh-client/js/NotificationCenter.js` + sino em `#taskbar-right` com badge de não-lidas;
- `Toast.show` passa a **delegar** — mostra o toast **e** grava no histórico. Nenhum call-site muda.
  `Toast` não tem arquivo próprio: vive em `VsshDialogs.js:745`, exportado como `window.Toast`;
- `Notifications.js` é upstream MPL: envolver `window.doNotification` num **wrapper idempotente** (o
  idioma de `host-xpra.js`), para que notificações X11 entrem no mesmo histórico;
- clique → foca a janela: `AppLauncher.open(appId)` já faz isso. Reusar, não reimplementar;
- `notify` ganha `actions: [{id,label}]` e `persistent: true`; a resposta volta por `postMessage`
  para app com janela, ou por `POST` no backend para engine.

**A Notification API do navegador entra como alcance complementar**, não como o mecanismo — é o
[limite 1 do critério](criterios.md#31--o-navegador-já-faz-isso): em tela cheia não há barra de
notificação do SO.

### O relógio

✅ **Feito.** O título fica curto de propósito: a âncora `#o-relógio` é citada de outros arquivos, e
cabeçalho que muda de texto quebra link sem quebrar nada visível.

Vem junto com o sino, e não por conveniência: os dois dividem o mesmo container
(`#taskbar-right`), o mesmo padrão de inserção como irmão, o mesmo helper de ancoragem e a mesma
restrição de 48 px na barra vertical. Em quase todo desktop o relógio **é** o gatilho do centro de
notificações; nascendo separado, a 2.2 mexeria nele de novo.

**Já houve um, e ele era exatamente o desenho errado.** A limpeza da Onda 0c encontrou um
`init_clock()` do upstream vivo no `index.html`: ligado por default, rearmando um `setTimeout` de 1
em 1 segundo **para sempre**, formatando data para escrever em `#clock_text` e `#clock_menu_text` —
ids do menu do dock do xpra-html5 que este fork nunca teve. E a hora dele vinha de
`last_ping_server_time + latência`: a do **servidor**. Saiu junto com o resto do dock. Vale
registrar porque explica os dois lados: por que o ambiente "não tem relógio" mesmo havendo código
de relógio, e por que a tabela abaixo insiste em quem tiquetaqueia.

**A hora serve ao usuário, não ao servidor.** É a decisão que dita o resto:

| Peça | Decisão |
|---|---|
| Quem tiquetaqueia | O **navegador**. Zero backend, zero canal SSH, zero trabalho no host. |
| Referência de precisão | O header `Date` de respostas que o shell **já faz** — o `fetch` de settings, o handshake do `/ws/events`. Custo zero, ~1 s de precisão. NTP por UDP não existe no navegador; este é o análogo alcançável do "pool de sincronização". |
| Fuso exibido | **Preferência do usuário**, string IANA, default = `Intl.DateTimeFormat().resolvedOptions().timeZone`. Mora em `/api/user/settings` e portanto **segue entre máquinas** ([critério 3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)). |
| O host Linux | **Não é fonte da verdade.** O relógio dele pode estar errado, e isso não pode contaminar a barra. |

**O relógio do host vira diagnóstico, não origem.** Se ele divergir da referência, isso aparece como
uma linha em Configurações → Sistema — que é útil de verdade, porque um host com relógio errado
carimba log, cron e mtime errados e ninguém percebe até doer.

**E o efeito colateral que justificava o item sozinho:** havia formatadores de data espalhados,
todos `pt-BR` no fuso do navegador e nenhum declarando isso — dois deles no **mesmo arquivo**, com
formatos diferentes entre si. Todos passaram para o `VsshTime`: a lista e as propriedades do
gerenciador de arquivos, as propriedades do desktop e o histórico do navegador. Agora a data do
arquivo concorda com a barra, inclusive no fuso escolhido. Sem isso o sintoma seria o clássico
*"a data do arquivo está errada"* — quando é o relógio novo que está certo.

**Ficou de fora, e é o par que falta:** o relógio do host como **diagnóstico** em Configurações →
Sistema. A conta já existe (`VsshTime.skewMs()` mede a divergência contra a referência do portal);
falta a linha na janela — e ela cabe melhor na [2.6](#26--a-janela-de-configurações-refeita), que
reescreve aquela tela.

**Como ficou:** `js/VsshTime.js` (a hora e o formato) + `js/Clock.js` (o mostrador e o painel).
O tick é agendado para a **virada do minuto**, não de segundo em segundo: são 60 despertares por
hora em vez de 3.600, e o mostrador é HH:MM. Na barra vertical o relógio empilha `HH` sobre `MM`,
porque 42 px não comportam `12:30` deitado. A chave `timezone` é validada **pelo `Intl`**, nos dois
lados — regex de fuso IANA envelhece, e um fuso inválido gravado faria o formatador lançar dentro
do tick, uma vez por minuto, para sempre.

**Armadilhas nomeadas:**
- ~~chave nova fora de `ALLOWED_KEYS` é descartada com 200 e sem log~~ — evitada: `timezone` entrou
  nas **três** listas (`ALLOWED_KEYS`, `DEFAULTS`, `SANITIZE`), e o teste que cruza as três já
  existia desde a Onda 0c;
- ~~**aba oculta**~~ — resolvida: `visibilitychange` redesenha **e reagenda**. Um `setTimeout` de 40 s
  numa aba de fundo pode voltar minutos depois, e relógio errado é pior que relógio nenhum, porque
  é crível;
- **o default do fuso não pode ser um fuso.** O servidor não sabe onde o usuário está: `''`
  significa "pergunte ao navegador". Chutar `America/Sao_Paulo` mostraria a hora errada com ar de
  escolhida para quem abrisse de Lisboa;
- ~~existe um `init_clock` morto do upstream (47 linhas) e um `#clock_text` com CSS órfão~~ — ✅
  **deletados na Onda 0c**, junto com `.clock_block`. Quando a 2.2 for escrita, ela começa do zero:
  não há nada ali para reusar, e o que havia estava errado de propósito (ver acima).

### Achado de passagem: o `unload` do shell não roda mais

Não é do relógio, mas mora no mesmo arquivo e aparece no console de quem abre o desktop hoje:

```
[Violation] Permissions policy violation: unload is not allowed in this document.
```

`index.html:1495` registra `addEventListener("unload", () => client.close())`. O Chrome **desativou
`unload`** por Permissions Policy — o listener existe e nunca dispara. O que ele faria era fechar o
transporte Xpra na saída da aba; sem ele, quem encerra a sessão é o timeout do lado do servidor, e o
`beforeunload` logo abaixo (que continua valendo) só serve para avisar de transferência de arquivo
em andamento.

**Não é urgente e não é do perfil sem Xpra** — ali `client.close()` não teria o que fechar. É dívida
do tipo "handler que existe e não roda", que é exatamente o modo de falha que a Onda 0c passou a
caçar. O conserto, quando alguém encostar no boot: `pagehide` (ou `visibilitychange` com
`document.visibilityState === 'hidden'`), que é o par vivo do `unload` e o único que o navegador
promete entregar em mobile.

---

## 2.3 — Clipboard: integração, não construção

O escopo encolheu depois de olhar o que já existe.

**O que já funciona e não precisa de nós:** texto simples — cada app resolve com
`navigator.clipboard` no próprio iframe. E o clipboard de **arquivos** do shell (`FileOps.js:44`),
que já independe do xpra.

**O que falta são duas pontes:**

- **`vssh.clipboard.files()`** — o app lê os caminhos que estão no clipboard do shell, reage ao
  evento `clipboard-change`, e pode **colocar** caminhos lá. É isto que faz "copiar no gerenciador,
  colar no app" funcionar — e o inverso.
- **Imagem** — `vssh.clipboard.readImage/writeImage` mediado pelo shell, falhando com **motivo
  nomeado** (`no-user-activation`) em vez de erro genérico. É a diferença entre o autor do app
  corrigir em dois minutos e abrir issue.

**O clipboard do Linux não entra no perfil headless — e isso é escolha, não lacuna.** Sem X11 não há
seleção X para sincronizar. Declarar isso honestamente era **acrescentar `clipboardServer: false`**
às capabilities do `host-standalone` — ✅ **já feito**, junto com a 2.1, porque o botão morto de
clipboard na taskbar precisava exatamente dessa chave para sumir. No perfil x11 o caminho do xpra
continua e a API do shell delega a ele.

---

## 2.4 — Tela de impressão do ambiente

Hoje só existe `window.print()`, que imprime **no cliente**, e a impressão do xpra está desligada
(`--printing=no`).

Falta a **superfície**, no mesmo padrão de `dialog`/`pick` — o shell é dono da UI, o app pede pela
ponte (`vssh.print(...)`) — com três destinos:

1. **Salvar para PDF** → o PDF nasce **no ambiente remoto**, não no download do cliente;
2. **Imprimir no cliente** → aí sim `window.print()`;
3. **Impressoras remotas/de rede**, acrescentáveis à mesma tela.

**A decisão de projeto é como o PDF é gerado.** Gerar no cliente e subir por `/api/fs/write` custa
pouco mas diverge do CSS de impressão; um **engine de impressão** (`provides: ["print/v1"]`, chromium
headless ou WeasyPrint) dá fidelidade e é exatamente o arquétipo B4 — vale como **primeiro consumidor
real** do registro de capabilities da [Onda 5](04-runtime-composicao.md), em vez de um mecanismo
avulso.

Impressora de rede é fila CUPS no host — e o **perfil headless da Onda 1 precisa instalar CUPS
explicitamente**, já que nasce pulando o stack gráfico.

> Este item é o contraexemplo que justifica o [limite 2 do critério](criterios.md#31--o-navegador-já-faz-isso):
> a API do navegador existe, é útil, e cobre **um dos três destinos**. Tratá-la como resposta teria
> eliminado a feature.

---

## 2.5 — Mixer de volume por aplicação

**O próximo passo desta onda.** Nasceu do mesmo teste que achou os botões mortos: o de volume ia
sumir no headless por não ter contraparte — e some, na 2.1 — mas a pergunta certa era outra. Os
apps são **iframes no nosso documento**. Quem faz papel de sistema operacional para o áudio deles
somos nós. Então o botão não volta como toggle: volta como **mixer**, uma coluna master e uma
coluna por fonte, no espírito do mixer do Windows 7.

**As premissas, conferidas contra o código antes de escrever isto:**

| Premissa | Onde |
|---|---|
| Alcançar o `contentDocument` do iframe já é idioma da casa, não técnica nova | `ScramjetEngine.js:681`, `BrowserWindow.js:756`, `UrlViewerWindow.js:175`, `ExtensionRuntime.js:378` |
| O áudio do Xpra é um `<audio>` do **próprio documento do shell** | `Client.js:4249` — `this.audio = document.createElement("audio")` |
| O shim roda dentro da página do app, então alcança o que a varredura não alcança | `lib/web/vssh-app-shim.js` |

A segunda é a que muda o desenho: **o stream do Xpra vira mais uma linha do mixer**, não um caso
especial. O botão deixa de ter dois comportamentos (liga/desliga no x11, nada no headless) e passa
a ter um só — abre o mixer.

**As três vias de controle, em ordem de cobertura:**

1. **Varredura de mídia** — `<audio>`/`<video>` no `contentDocument`, com `MutationObserver` para os
   que nascem depois. Funciona **sem cooperação nenhuma** do app;
2. **Hook de Web Audio no shim** — envolver `AudioNode.prototype.connect` e desviar o que vai para
   `ctx.destination` por um `GainNode` nosso. É o que cobre o app que toca por `AudioContext`, que
   a varredura não alcança;
3. **A linha do Xpra** — `.volume` no `<audio>` do `Client.js`, de fora, sem tocar no upstream. O
   mute dela **para o stream** (o que o botão de hoje já faz), porque volume zero continuaria
   gastando banda.

**O limite honesto, e ele precisa aparecer na UI:** app que usa Web Audio **e** não carrega o shim é
incontrolável. A regra é **só listar fonte que a gente controla de fato** — um slider que não morde
é o mesmo botão morto que a 2.1 acabou de tirar da taskbar.

**Estado no servidor** (`/api/user/settings`), master e por app: é o
[critério 3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina) aplicado na hora, em vez de virar
dívida para a [Onda 7](06-portabilidade.md) migrar — que é exatamente o que aconteceu com os grants.

**Painel** ancorado no botão, com o mesmo posicionamento que `#kb-layout-dropdown` e o
`TilingPanel.js:253` já resolvem para as quatro posições de taskbar.

> Isto é o [critério do navegador](criterios.md#31--o-navegador-já-faz-isso) pelo avesso: não existe
> volume master no navegador, e a resposta não é "sem equivalente". Como TODA fonte de áudio do
> ambiente ou é um elemento de mídia nosso ou é um gain node nosso, o master é um multiplicador —
> e passa a existir porque o ambiente é que é o sistema operacional aqui.

---

## 2.6 — A janela de Configurações, refeita

**Apagar e refazer, não reformar.** Estamos construindo um sistema operacional na web, e quase toda
peça nova desta roadmap cria preferência — do-not-disturb (2.2), fuso do relógio (2.2), volume por
app (2.5), limites de recurso (Onda 4). A tela que recebe tudo isso precisa ser digna da ambição, e
a de hoje não é.

**O que existe:** 1700 linhas, 6 abas fixas montadas por `innerHTML` num render único, **sem
mecanismo de registro nenhum**. Não confundir um `switch` grande com extensibilidade.

**O modelo:** uma janela de configurações de distro Linux — organizada, padronizada e **extensível**.
É o mesmo idioma que a [2.1](#21--tray---concluída) estabeleceu para a bandeja: *a fonte é nomeada
por quem instala, e o chrome monta o elemento*. Um `engine` precisa poder acrescentar a sua seção do
mesmo jeito que um `service` acrescenta o seu ícone.

> ### ⚠ O contrato NÃO é o do `TrayArea`, e copiá-lo falharia no caso que motiva a proposta
>
> A bandeja atravessa **dados** e tem **um** `onClick`. A seção do Scramjet consome **seis** APIs do
> motor — `list`, `available`, `get`, `reset`, `clearCache`, `getStatus`, `reconnect`/`init` — com
> **status ao vivo** e botões com estado de progresso. Um registro só-dados não carrega nada disso.
>
> O contrato precisa de um terceiro modo além de "dados" e "iframe": **seção montada por código do
> próprio shell**, registrada por id. É o que serve motor de navegação, Serviços e teclado — todos
> internos, todos hoje espalhados.

**Consumidores, todos internos e todos já existentes:** motores de navegação (Scramjet), Serviços,
teclado (que hoje vive num **segundo store**, `/api/user/preferences`), e `fileHandlers` — este
último é o melhor primeiro cliente, porque o backend, o leitor e a matéria-prima estão prontos e
**não há um único escritor**.

**Sequenciamento honesto: a 2.6 vem DEPOIS de 2.2–2.5**, e quem chegar primeiro paga. A 2.2
acrescenta seu checkbox à janela atual e joga ~20 linhas fora. É preço aceitável — fazer o Settings
antes atrasaria a onda inteira atrás de um bloco muito maior.

**Pré-requisito extraível, que pode ir antes de tudo:** um `js/VsshSettings.js` (`get`/`set`/
`subscribe`/`hydrate`) tirado do `SettingsWindow`. Desacopla ~22 consumidores do arquivo que vai ser
deletado **e** conserta dois bugs reais: o debounce que engole a primeira de duas escritas em menos
de 400 ms, e o estado vazio quando o backend cai — hoje pins somem, launcher volta ao default e
tiling reseta, **sem nada no console**.

**Pré-requisitos de outra onda:** a [Onda 0c](0c-colapso-de-variantes.md) tira ~280 das 1700 linhas
(neon + dock) **antes**, senão elas seriam reescritas para depois morrer — e a aba "Interface"
inteira, que existe por causa do dock, seria projetada para ser deletada.

**Duas decisões de desenho que precisam ser tomadas antes de codar, não durante:**
- existem **dois stores** (`/api/user/settings` e `/api/user/preferences`) e **duas implementações
  completas** da tela (a do shell e `public/js/modules/settings.js`, 356 linhas, mesmas chaves,
  paletas duplicadas verbatim). Unificar ou conviver é decisão, não detalhe;
- o merge do PUT é **raso**: uma seção que grave um campo objeto com só a sub-chave alterada apaga
  as irmãs. O usuário configura A, depois B, e A volta ao default sem aviso.

**A extensão para vssh-app de terceiro — manifesto declarando seção — não é desta onda.** Ela exige
contrato versionado e negociação por `vssh.capabilities()`, e é ponto de extensão: vai para a
[Onda 5](04-runtime-composicao.md#registro-de-capabilities), ao lado de `provides` e do `FileOpener`
plugável. Um contrato de extensão, três consumidores.

---

## Riscos transversais

1. **Canais SSH** — tudo aqui consome canal. Só o desenho por vigia-por-servidor não acrescenta um
   canal por usuário; qualquer variante precisa de contabilidade explícita e teardown ligado à
   sessão. Os dois já existem desde a Onda 1: `sessionStats()` ao lado de `sshSlotStats()`, e
   `closeSupervisor(key)` como idioma de teardown, chamado pelo `endSession`.
2. **Duas SPAs** — `TrayArea`, `NotificationCenter` e o clipboard vivem em `vssh-client/`, nunca
   em `public/`.
3. **Deploy desacoplado shell↔apps** — o shim já reconhece que "versão dessincronizada é a regra".
   Toda mensagem nova precisa de timeout e de negociação por `vssh.capabilities()`; um shell antigo
   simplesmente não responde.
