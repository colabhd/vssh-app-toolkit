# Diagnóstico — onde estamos

> **Estado:** vigente · **Atualizado:** 2026-08-02
> Base: `vssh-sso` na `main` (`frontend-revisao-geral` já mergeada via PR #17) e este toolkit em `main`.
>
> A [Fase 1 da limpeza](00-limpeza-de-terreno.md) já resolveu parte do que está descrito abaixo —
> os itens afetados estão marcados. O resto do diagnóstico continua valendo.

## 1.1 O que já é sólido

Sistema de janelas (`VsshWindow`), tiling, taskbar, Start Menu, Launchpad; persistência de janelas em
lock files (`~/.vssh/psd/`); a fronteira `VsshHost` com `host-xpra`/`host-standalone`; o gerenciador
de arquivos com undo por pilha de efeitos e recibos verificados no servidor (`FileOps.js`,
`src/routes/system.ts`); o ciclo de vida de vssh-app (alocação de porta, reconciliação via `/proc`,
detecção de drift por hash, `EnvironmentFile`); o proxy semântico com gate 409 e
`X-Vssh-App-Token`; túneis SSH com dedup e idle-close; o repositório de artefatos com sha256.

> **Ressalva, e ela vira restrição de projeto.** O ciclo de vida de app só ficou sólido em `da6bfb5`,
> que consertou um ciclo em que `startApp` reiniciava o backend sem derrubar o túnel — e o proxy lê
> **"existe túnel" como "o app está de pé"**. Como `_allocateAppPort` prefere sempre a mesma porta
> determinística, o app voltava na mesma porta e o túnel morto continuava parecendo válido. O
> invariante restaurado — **o túnel cai junto com o backend; ausência de túnel significa "confira se
> está vivo"** — era o que a [Onda 1](01-sessao-sem-xpra.md) podia quebrar ao fazer a sessão dona dos
> túneis. **Preservado:** o `endSession` fecha só os watchers de fs; túnel e supervisor sobrevivem à
> sessão de propósito. Derrubar túnel por lease expirado quebraria usuário ativo que só perdeu rede.

## 1.2 Matriz de prontidão sem-X11

Três vereditos distintos. A distinção é o que impede a roadmap de construir meia-ponte para o outro
lado de um rio que não existe.

### (a) Nunca dependeu do Xpra

Listado para fechar a dúvida, não porque estivesse em risco: janelas, tiling, taskbar, launcher;
gerenciador de arquivos, editor, Office, VS Code, navegador; vssh-apps com janela; **clipboard de
arquivos** (`FileOps.js:44` — estado JS do shell); **som dentro de um app** (passa pelo iframe do
próprio app).

### (b) Categoria que deixa de existir sem X11

Não é lacuna, e construir substituto é desperdício: clipboard de texto/imagem servidor↔navegador
(sincroniza com a *seleção X11*); som de app X11; apps Linux com UI.

### (c) Lacunas de verdade

| Capacidade | Com Xpra | Sem Xpra hoje |
|---|---|---|
| ~~**Quem serve o shell HTML**~~ | o xpra (`--html=`) em `/proxy/desktop/` | ✅ **o portal**, em `/proxy/vssh-desktop/` — [Onda 1](01-sessao-sem-xpra.md) |
| ~~**Supervisor de `kind:"service"`**~~ | lançado em `startXpra()` | ✅ **`ensureSession`** (`services/session.ts`) — [Onda 1](01-sessao-sem-xpra.md) |
| **System tray** | protocolo xpra (`#taskbar-tray`) | **vazio** |
| **Notificação/diálogo vindo do backend** | `vssh-psdialogd` (hijack D-Bus) | **inexistente** |
| **API de clipboard para apps** | inexistente | inexistente — lacuna nos dois modos |
| **Impressão** | já desligada (`--printing=no`) | só `window.print()`, que imprime **no cliente** |

### Três achados verificados no código

Nenhum deles aparece em `vssh-sso/docs/refactor-backlog.md`.

**1. ✅ RESOLVIDO — O supervisor de serviços era filho da sessão Xpra.**
Nascia dentro do `startXpra()` e morria dentro do `stopXpra()`, então sem Xpra **nenhum app
`kind:"service"` subia** e a categoria "daemon" inteira dependia de X11 para existir. Era o gargalo
estrutural do objetivo. Hoje é o `ensureSession` (`services/session.ts`) quem o garante, chamado do
`startXpra`, do upgrade de `/ws/events` e do start de app — nunca do proxy.

**2. ✅ RESOLVIDO — Sem Xpra ninguém servia o cliente HTML.**
O bundle vinha do `--html=` do próprio xpra, ou seja **do servidor Linux**; `?xpra=0` desligava só o
host no navegador, mas a página ainda tinha vindo do xpra. Existia um shell que *tolerava* a ausência
de X11 depois de carregado por ele — não um modo sem-X11 de ponta a ponta. Hoje
`/<serverId>/proxy/vssh-desktop/` é servido pelo portal (`services/vssh-shell.ts`), com
`window.VSSH_NO_XPRA` injetado, e **sem custar canal SSH**: sem `id -u`, sem porta, sem túnel.

> A lacuna que sobrou dessa dupla é operacional, não de arquitetura: existem agora **dois caminhos de
> deploy do mesmo bundle** (host via `vssh-update-client`, ou o deploy do portal).
> `GET /api/shell/config` expõe o `buildId` servido para diagnosticar antes de virar bug reportado.

**3. Existem três clipboards, e só o terceiro é lacuna.**
(a) O de **arquivos**, em `FileOps.js:44` — `{action:'copy'|'cut', paths:[]}`, compartilhado entre
gerenciador e Desktop, com evento `clipboard-change`; independe do xpra e carrega caminhos, não
conteúdo. (b) O de **texto/imagem servidor↔navegador**, só em `Client.js` (upstream xpra) —
categoria (b) acima. (c) **Nenhuma API de clipboard para vssh-apps**: um app usa
`navigator.clipboard` dentro do iframe, mas **não há caminho entre o clipboard de arquivos do shell
e um app**.

## 1.3 Dívidas do toolkit

| # | Dívida | Por que dói |
|---|---|---|
| T1 | **`LazyFile extends Blob` com `super([])`** (`lib/web/fsa-polyfill.js:52-64`) — `new Response(f)`, `FileReader`, `FormData.append`, `new Blob([f])` devolvem **0 bytes em silêncio**; `slice()` lança | É como toda biblioteca moderna lê um `File`. Bloqueia leitores de Parquet/HDF5/Zarr/DICOM, que fatiam por range — `slice()` é a operação primária deles |
| T2 | **Sem OPFS** (`navigator.storage.getDirectory`, `createSyncAccessHandle`) | DuckDB-WASM, sqlite-wasm e Pyodide dependem de OPFS. **Com uma regra que precisa vir junto** — ver [criterios.md](criterios.md#32--isso-sobrevive-à-troca-de-máquina) |
| T3 | **A tag `v1` não contém `lib/` nem `schema/`, e o README mandava fixar `@v1`** | Não é quebra silenciosa universal: `vsshapp-scramjet-wisp/.github/workflows/publish.yml` já documenta a armadilha e usa `tools_ref: main`. O problema real é que o README ensinava errado e cada repo de app redescobria sozinho. **Corrigido na Onda 0** |
| T4 | **Nenhum template exercia a ponte** — `injectScripts` estava comentado, e mesmo descomentado não funcionaria: ele só **injeta a tag**, ninguém servia o arquivo | A funcionalidade mais documentada do toolkit não tinha exemplo funcionando. **Corrigido na Onda 0** |
| T5 | **`electron-shim.js` incompleto além do declarado** | Notificar e controlar janela são operações básicas de um port. **Corrigido na Onda 0** |
| T6 | **Ponte `fs` sem `exists`/`rename`/`copy`** (o backend `vssh-app-fs` tem os três) | Força sonda `stat().catch()` — o padrão que [`../lessons/logseq-port.md`](../lessons/logseq-port.md) diz ter sido corrigido |
| T7 | Sem `.d.ts`; `capabilities()` não diz a versão do shell | `MIGRATION.md` já admite recurso do shim que exige shell talvez não implantado |
| T8 | Docs contra o código | Custo baixo, confiança alta. **Corrigido na Onda 0** |
| T9 | Zero testes de navegador; `electron-shim`/`tauri-shim` sem teste | As falhas do T1 estão documentadas mas não testadas |

## 1.4 Dívidas de plataforma

### 🔴 Teto de canais SSH: ~8 por SERVIDOR, não por usuário

O pool chaveia por `${host}:${port}:${usuário-provisionador}` (`ssh-exec.ts:116`): **uma conexão TCP
por servidor, compartilhada por todos os usuários**. O `sshd` limita a `MaxSessions` (10 por padrão),
a sessão SFTP cacheada segura um canal permanentemente, e daí o teto de 8 (`ssh-exec.ts:152-157`).

Mas o canal do `fs-watch` é **longo** (um `inotifywait -m` streamando) e **não passa pelo
limitador** — o próprio arquivo diz isso e explica por quê (`fs-watch.ts:14-19`). Consequência:
**cada usuário com um watch aberto rouba um canal do orçamento do servidor inteiro, sem ser
contabilizado**. Oito usuários com watch = zero canais para operação de arquivo, start de app ou
provisionamento.

Não é dívida futura: é o teto de escala atual, e `da6bfb5` já mostrou como ele se manifesta —
estouro de `MaxSessions` → `catch` devolvendo `false` → rajada de 409 com o app perfeitamente vivo.

Isso condiciona o desenho da [Onda 2](02-apis-de-shell.md) e é parte da justificativa da
[Onda 6](05-arquivos-de-rede.md).

### As demais

- **Sem limites de recurso** (cgroups/`systemd-run`): um treino desgovernado derruba a sessão inteira.
- **GPU não é conceito de runtime** — existe só no provisionamento (`provision-base.sh --gpu`, desde
  a [Fase 3 da limpeza](00-limpeza-de-terreno.md)). Nenhum app declara precisar de GPU, e nada
  arbitra entre dois que a queiram.
- **Uma instância por (usuário, app)**: sem múltiplas janelas nem múltiplas instâncias.
- **Supervisor nunca validado em servidor real** (`docs/refactor-backlog.md:86-104`), com
  `_eagerStartAlwaysRunningEngines` (`index.html:2111`) mantido como rede de segurança.
- **Sem descoberta entre apps**: um consumidor de `type:"engine"` fixa o `appId` no código.

## 1.4b UI do shell — duplicações medidas

Levantadas ao planejar a [Onda 0c](0c-colapso-de-variantes.md), com a contagem junto porque
"tem duplicação" sem número não move ninguém. **O que une esta lista:** cada item cobra um imposto
em *toda feature de UI nova*, não uma vez.

| Dívida | Medida | Por que ainda não foi paga |
|---|---|---|
| **Ancorar painel no botão da taskbar** | **6** implementações — `index.html` (2×), `TilingPanel.js`, `TrayArea.js`, `StartMenu.js`, `ContextMenu.js`. Duas admitem a cópia no comentário; a do `TrayArea` **não clampa** contra a borda da tela | Vira o helper `anchorPanel()`, pré-requisito da [2.2](02-apis-de-shell.md#22--centro-de-notificações-e-o-relógio). Duas ficam de fora: o Start Menu carrega classes de animação e o menu de contexto faz *flip* |
| **`/ws/events` dentro do `Client.js`** | ~55 linhas **nossas** em arquivo upstream MPL | ✅ **pago** na 2.2, como `js/EventsChannel.js`. O custo real era maior que "outra edição lá": enquanto o canal fosse método do `XpraClient`, abri-lo exigia construir um cliente Xpra — foi ele que travou a separação do bundle por perfil |
| **A fonte, declarada em todo componente** | **96** declarações de `font-family` no CSS do cliente — **14** escrevendo o nome da fonte na mão, e portanto surdas ao token. E eram DUAS fontes sem ninguém ter decidido isso: 39 no `--ds-font` (pilha do sistema) contra 14 em `'Instrument Sans'`, esta baixada do **Google Fonts** por um `@import` no topo do `launchpad.css` | ✅ **pago** na 2.2. A causa não era desleixo: o `body` não declarava fonte, e **controles de formulário não herdam `font-family`** — então todo `<button>` novo saía na fonte do sistema. Duas regras (`body` + `button, input, select, textarea { font-family: inherit }`) e componente que não declara passa a estar certo por omissão. A fonte agora é servida pelo próprio ambiente (41 KB, variável, licença junto) |
| **`vsshHost.captureKeyboard()`** | **22 chamadas em 14 arquivos** — toda janela, diálogo e menu precisa alternar no foco | **Não é conserto mecânico.** A semântica diverge (`_onFocus`→`false`, `_onDefocus`→`true`, o menu de contexto alterna em volta do show/hide), e o ganho de runtime é **zero**: `capture_keyboard` nasce `false` e no host standalone o método é vazio. Içar para a classe base é **redesenho de foco de janela**, e a regressão só aparece no perfil Xpra. Volta quando alguém redesenhar isso de propósito |
| **Cálculo de `serverId`** | **11 cópias** contra **1** uso do helper `VsshHost.serverSlug()`, que existe para isso | Barato, e vale na véspera da [Onda 7](06-portabilidade.md), que mexe em path. Duas não são mecânicas (um ServiceWorker, onde o host nem carrega) |
| **A regra MPL aponta para o arquivo errado** | `MenuCustom.js` tem **245 de 379 linhas nossas** (é onde mora a taskbar) e não é protegido; o `Client.js`, protegido, já tem **4 ramos nossos** de `UI_MODE` | Dá falsa segurança onde já divergimos e desencoraja mexer onde o código é nosso. Corrigido na [Onda 0c](0c-colapso-de-variantes.md), junto com o split `MenuCustom.js` → `js/Taskbar.js` |
| **Chaves que o código finge sincronizar** | `searchEngine` e `shortcuts` são gravadas pelo cliente e **descartadas** pelo backend (`ALLOWED_KEYS`), com 200 e sem log | Duas linhas. Sintoma: funciona a semana toda numa máquina e some na outra |

### Três bugs vivos achados no mesmo levantamento

1. **`_do_migrate` põe o shell headless em loop.** Ele chama `connect()` sem consultar
   `VsshHost.xpraDisabled()`, e o `migrate` é broadcast para **todos**. Todo drain de pod manda o
   perfil sem Xpra reconectar num endpoint Xpra que não existe, com overlay de desconexão.
   *(**Não determinado**: se o `remove_windows()`/`clear_timers()` que roda antes derruba janelas do
   shell.)*
2. **"Diminuir Fonte" sem ícone.** `ContextMenu.js` mapeia para `#ico-minus`, que não existe entre os
   43 símbolos do sprite. No tema padrão, hoje, renderiza um SVG vazio em dois menus.
3. **Vazamento no Alt+Tab.** `toggle_window_preview` registra 4 listeners jQuery **antes** do early
   return; no standalone a lista está sempre vazia, então são 4 por pressionada, nunca removidos.

Os três entram na [Onda 0c](0c-colapso-de-variantes.md), que é onde o código já vai estar aberto.

### Peso morto servido ao navegador

Duas réguas diferentes, e a segunda só ficou visível depois que a primeira foi aplicada.

**Régua 1 — referência zero: ninguém chama.** `js/lib/aurora/{aac,flac,mp3}.js` = **401.838 B nunca
referenciados**; `design-system.html` = 1854 linhas públicas com zero referências, **já divergidas**
do `design-tokens.css` real; três overlays órfãos do upstream, um deles se apresentando como *"Xpra
HTML5 Client / Version 19"*; `simple-keyboard` = 296 KB carregados em toda sessão e nunca
instanciados ([00-limpeza-de-terreno.md](00-limpeza-de-terreno.md)). Tudo isto já foi removido ou
está orçado.

**Régua 2 — referenciado, mas só pelo ramo Xpra.** Esta a régua 1 não alcança por construção: o
código É chamado, só que de dentro de um caminho que o perfil sem X11 nunca percorre. Foi medido
depois de um usuário estranhar, no console do perfil **sem** Xpra, linhas como
`audio codec MediaSource supported`, `offscreen canvas is available` e `initializing clipboard`.

#### O que foi medido (números reproduzidos por um segundo par de olhos)

| Medida | Valor |
|---|---|
| Tags `<script src>` no `index.html` | **87**, todas entre as linhas 18 e 160 — ou seja, **inteiramente dentro do `<head>`** (`</head>` na 205, `<body>` na 207) |
| Delas com `defer`, `async` ou `type=module` | **0**. Os 11 `type="application/javascript"` são script clássico e bloqueiam igual |
| JS avaliado antes da primeira tag do `<body>` | **3.387.562 B** (3,39 MB) |
| Stack Xpra estrito — wire, decode, áudio, janela X11 | **1.063.226 B**, 18 das 87 tags = **31,4%** |
| Idem, contando o que só o caminho Xpra chama (slick, detect-zoom, StreamSaver + ponyfill, Notifications, throttle-debounce) | ~1,38 MB, ~41% — a fronteira é discutível, o núcleo de 31,4% não |
| Guarda de perfil possível nessa camada | **nenhuma.** `VsshHost.xpraDisabled()` só é consultada em `index.html:60`, quando 22 scripts já executaram — e não impede os 65 seguintes. A checagem de capability vive **abaixo** do parser HTML |

O portal serve com `etag:true, no-cache` (`vssh-shell.ts:63-65`), então em reload morno são 18
revalidações 304 de corpo ~zero: **o byte é custo de carga fria**. O custo de *parse* é por carga e
**não foi medido** — não há navegador no ambiente de medição, e inflar isso seria repetir o erro que
esta seção existe para evitar.

#### E não é só baixar: o perfil sem Xpra **constrói** o cliente Xpra

`index.html:739` faz `new XpraClient("screen")` sem guarda nenhuma — **846 linhas antes** do único
`if (VsshHost.xpraDisabled())` do boot, que fica na `:1585` e só pula o `connect()`. Consequências
medidas, todas com o log do usuário como testemunha:

- **`new AudioContext()` no construtor** (`Client.js:279`), num perfil sem stream de áudio;
- **16 sondagens de codec** no boot — 12 `MediaSource.isTypeSupported()` e 4 `AV.Decoder.find()` —
  cujo resultado só é lido para montar o pacote `hello`, que nunca é enviado;
- **um `OffscreenCanvas` 256×256** instanciado e descartado só para testar capacidade de um worker
  de decode que este perfil nunca cria;
- **a tabela de 40 handlers de pacote** montada para um protocolo que não abre;
- **`init_clipboard()` roda mesmo com `clipboardServer: false`** (`index.html:1618`, depois do ramo):
  registra listeners e acende o **prompt de permissão de clipboard do navegador** no primeiro
  clique — para um botão que `applyHostCapabilities()` acabou de esconder. É a única linha desta
  lista que o usuário **vê**.

#### O que caiu ao ser refutado, e é a parte mais útil

- **Worker não sobe.** Os 3 sítios de `new Worker` ficam atrás de `initialize_workers()`, que só
  `connect()` chama — **0 de 3** neste perfil. A suspeita de "threads de decode ociosas" não procede.
- **Os `setInterval` do Xpra não armam.** O ping de 5 s vive dentro do handler de `hello`; o de info
  de 1 s só é alcançável pelo host xpra. **Exatamente um** timer recorrente fica vivo num desktop
  ocioso, e ele não é do Xpra: é o heartbeat do `/ws/events`, que sustenta o lease da sessão.
- **O laço de `requestAnimationFrame` que mede fps não rodava para sempre** — e a correção dessa
  refutação virou bug, o que a torna a mais instrutiva das três. Ele se rearma enquanto
  `vrefresh < 0`, e quem fechava isso era o `init_client()`: se os primeiros quadros deram ≥ 30 fps,
  `vrefresh` recebia o valor medido e o laço parava. **Mas o conserto do desperdício tornou o
  `init_client()` exclusivo do Xpra** — e com ele foi embora quem fechava o laço. Resultado
  observado no console do usuário, no primeiro teste depois da mudança: `animation_cb` a cada
  quadro, `vrefresh -1`, sem fim. Hoje o laço **não é armado** no perfil sem Xpra, que é a resposta
  certa: o único destino do número é um campo do `hello` do protocolo.

  **A lição é sobre a forma da correção, não sobre o fps:** pôr uma guarda de perfil não só evita
  trabalho — ela também deixa de rodar coisas que outra parte do código esperava que tivessem
  rodado. Toda guarda nova pede a pergunta "o que este bloco fechava?". Nenhum teste estático pega
  isso; quem pegou foi abrir o desktop e ler o console.

#### Dois efeitos que não são desperdício, são bug

Estes valem item, não linha de dívida — e nenhum dos dois foi refutado ainda:

1. **Estado de janela é escrito e nunca lido neste perfil.** `WindowStateManager.save()` é chamado de
   6 pontos do `VsshWindow` (abrir, mover, minimizar, maximizar, fixar, navegar), nos dois perfis;
   `restoreAll()` tem **um único chamador**, `index.html:1558`, dentro de `client.on_connect` — que
   sem Xpra nunca dispara. O shell grava no servidor a cada gesto e nunca reabre nada.
2. **O deep link `?officeShare=` nunca abre o editor sem Xpra**, e o token **continua na URL e no
   histórico** — o tratamento inteiro (inclusive o `history.replaceState` que limparia a URL) mora
   dentro do mesmo `on_connect`.

#### ✅ Resolvido: um index por modo, sem um segundo arquivo

A objeção ao "bundle por perfil" era real — dois arquivos são duas coisas para manter certas, e a
Onda 0c acabou de estabelecer que variante nova é o que se está **tirando**. O que a desarma é uma
assimetria que já existia: **no perfil x11 quem serve a página é o processo xpra do usuário
(`--html=`), lendo o diretório cru.** O arquivo em disco *é* o do Xpra; o portal é o único que
transforma. Então não há dois arquivos — há um arquivo e duas renderizações:

- as tags exclusivas do Xpra ganharam `data-xpra` no `index.html`;
- `stripXpraTags()` (`src/services/vssh-shell.ts`) as remove ao servir `/proxy/vssh-desktop/`, ao
  lado do `injectNoXpra()` que já existia. Se o marcador parar de casar, **falha alto** em vez de
  servir o bundle inteiro em silêncio — que seria o modo caro: o desktop continua funcionando, só
  pesado, e ninguém percebe.

**Medido depois:** 23 tags e **1.369.332 B (40,4%)** saem do perfil sem Xpra; ficam 65 tags e
2.020.159 B. Os maiores que saem: `aurora.js` (332.523), `brotli_decode.js` (206.386),
`web-streams-ponyfill.es6.js` (194.390), `Client.js` (187.090), `jsmpeg.js` (125.282).

**O que destravou isso não foi a remoção, foi a costura** — enquanto o boot construísse um
`XpraClient`, tirar a tag do `Client.js` era `ReferenceError` garantido:

1. **`vsshHost.decodeIcon` no lugar de `client.xdg_image`** nos 3 sítios de Start Menu e Launchpad.
   O host já tinha o gêmeo agnóstico de perfil; ninguém tinha trocado.
2. **O `/ws/events` virou `js/EventsChannel.js`** — era o último laço obrigatório, porque abrir o
   canal exigia construir o cliente. Ver [02-apis-de-shell](02-apis-de-shell.md#pré-requisitos-que-valem-antes-de-começar).
3. **`client` passou a ser `null` no perfil sem Xpra**, e cada bloco que fala com o transporte
   carrega a guarda. É o que apaga, de uma vez, o `AudioContext`, as 16 sondagens de codec, o
   `OffscreenCanvas`, a tabela de 40 handlers, os 5 `init_*` de subsistema e o prompt de permissão
   de clipboard.
4. **A sequência de "shell pronto" saiu de dentro do `client.on_connect`** e virou `_shellReady()`,
   chamada pelos dois ramos — o que conserta os dois **bugs** listados acima: a restauração de
   janelas passa a rodar no perfil sem Xpra, e o `?officeShare=` passa a abrir o editor e a limpar
   o token da URL.

**O que impede isso de virar o próximo boot quebrado** é um teste que monta o conjunto de nomes que
existem *naquele perfil* — só os arquivos que sobrevivem — e confere o JS do shell contra ele
(`tests/unit/client-undefined-refs.test.js`). Ele já pegou dois casos na primeira execução:
`Utilities.js` usava `hmac` como fallback de `crypto.subtle` (por isso `hmac.js`, 7.496 B, **não** é
marcado), e `vssh-host.js` lia `VsshHostXpra` como nome nu em vez de `window.VsshHostXpra`.

**Fica de fora:** as folhas de CSS não são marcadas. A única exclusiva do Xpra é `slick.css`, com
1.554 B — menos que o custo de manter o marcador em dois lugares.

#### Tag removida não é trabalho removido

O console do perfil sem Xpra, depois de tudo isso, ainda abria assim:

```
network got default settings: Object
[Violation] Permissions policy violation: unload is not allowed in this document.
using blocked-hosts = xpra.org,www.xpra.org  from default settings
modo standalone: conexão Xpra desabilitada
```

O `data-xpra` alcança o que está **em tag** — e o boot não está em tag nenhuma: são ~1.400 linhas de
`<script>` inline no próprio `index.html`, que rodam iguais nos dois perfis. Medir 40,4% de JS a
menos escondeu isso, porque a medida era de **bytes baixados**, não de **trabalho feito**. Dois casos
saíram do mesmo log:

1. **O `unload`** — ver [2.2](02-apis-de-shell.md#achado-de-passagem-o-unload-do-shell-não-roda-mais).
   A guarda estava dentro do handler; quem viola a política é o registro.
2. **O boot inteiro esperava um arquivo de configuração do Xpra.** `load_default_settings()` faz um
   XHR de `./default-settings.txt` e só chama `init_page()` no callback — os três, `onload`,
   `onerror` e `onabort`. O arquivo se apresenta como `# Xpra HTML5 default settings` e traz
   `blocked-hosts`, `min-quality` e `min-speed`. Contados os leitores: **52** chamadas de
   `get*param` nesta página, **50 dentro de `init_client()`**, que o perfil sem Xpra não chama. Das
   duas restantes, `touchaction` não está no arquivo e `blocked-hosts` só é lido no ramo `else if`
   que exige `client`. Ou seja: **o shell sem Xpra bloqueava o próprio boot numa ida à rede cujo
   único valor efetivamente lido alimentava um caminho que não pode executar.** Agora
   `VsshHost.xpraDisabled()` chama `init_page()` direto. Parâmetro de URL continua valendo nos dois
   perfis — quem os lê é `Utilities.getparam`, que não depende do arquivo.

**A regra que fica:** *depois de cortar o que se baixa, medir o que se executa.* São perguntas
diferentes, e a segunda não tem atalho — abre-se o console do perfil e lê-se o boot inteiro, linha
por linha, perguntando de cada uma "isto serve a quem está sem Xpra?".

#### ✅ Resolvido: duas camadas de cache com políticas contrárias

Sintoma relatado: **no perfil sem Xpra, F5 não mostrava a build nova — só reabrir mostrava.** No
perfil Xpra, F5 funcionava. A assimetria é a resposta.

`vssh-client/sw.js` serve `index.html`, `js/**` e `css/**` **cache-first, sem revalidar**, e só liga
quando alguém substitui o placeholder de build id. Havia dois substituidores, e eles não eram
equivalentes:

| Perfil | Quem substituía | Quando o id mudava |
|---|---|---|
| Xpra | `sed` em `publish-customclient.sh` | só ao publicar/instalar um customclient |
| sem Xpra | o portal, ao servir (`vssh-shell.ts`) | **todo deploy** — é hash do conteúdo |

Como o servidor de teste roda um customclient não publicado pelo CI, lá o placeholder ficava intacto
e o SW era **inerte**: sempre fresco. No portal ele era real, e aí o atraso aparecia — **de
exatamente um load, e estrutural**: quem atende um F5 é o SW **antigo**, que já respondeu todo o JS
e CSS do cache antes de o SW novo instalar, ativar e limpá-lo. Como `skipWaiting()`+`claim()` correm
no meio da carga, dava até para terminar com assets de duas builds na mesma página.

**O que torna isso mais que um bug:** o portal já servia os assets com `Cache-Control: no-cache` +
ETag, *exatamente* para que um deploy não sirva arquivo velho. Duas camadas com políticas contrárias,
e vence sempre a que está na frente — o Service Worker fica **antes** do cache HTTP, então a política
honesta da camada de baixo era decorativa. Um invariante que só vale se ninguém o contradisser acima
não é um invariante.

O cache foi desligado nos dois perfis (o `sed` do tarball saiu junto — lá era pior: o id era o sha do
**tarball**, então nenhum deploy do portal invalidava nada). Quem cacheia agora é o navegador, com
revalidação condicional: 304 barato em HTTP/2. Custo da migração: **uma última carga velha** para
quem já tem cache populado — o `activate` do SW novo apaga tudo e a carga seguinte é limpa.

**Se algum dia valer religar**, o que falta é versionar a URL do asset (`js/x.js?b=<buildId>`,
injetado por quem serve o HTML): chave nova por build, cache-first nunca acerta entrada velha, e o
atraso de um load some. Religar sem isso traz o sintoma de volta. Está escrito no cabeçalho do
`sw.js`, junto do código que ficou dormente.

`tests/unit/sw-cache.test.js` mede isso **executando** o `sw.js` num escopo de service worker falso —
o `install` não pode abrir cache, o `fetch` de `js/**` tem de vir da rede, e o passthrough de
download do StreamSaver (a parte viva do arquivo) tem de continuar respondendo. A primeira versão do
teste passava com o cache religado, porque o `caches` falso não tinha estado; a mutação mostrou, e o
falso ganhou estado.

### ⚠ O que NÃO é dívida, e por que está escrito aqui

**"No perfil sem Xpra os proxies de janela poderiam ser desligados."** Foi investigado e **não
procede**. Os proxies declaram `pointer-events: auto` **inline**, então desligá-los pelo ancestral
não faria nada; o `#screen` **não** fica vazio no standalone (tem um proxy por janela e um por ícone
de desktop); e o menu de contexto do desktop e o upload por arraste no papel de parede vivem nesses
listeners. Além disso, a proposta **adiciona uma variante** — dois caminhos de hit-test com ordem de
evento diferente —, que é o oposto do que a Onda 0c persegue.

O incômodo real por trás da ideia (clicar uma vez numa janela desfocada não age no conteúdo) existe
nos **dois** perfis, então o conserto certo é no próprio proxy: depois do `focus()`, desligar
`pointerEvents` e re-despachar em vez de comer o `mousedown`. É **pesquisa**, não item orçado —
eventos sintéticos não reproduzem foco e seleção nativos com fidelidade.

Fica registrado para não ser reproposto como "ganho barato".

## 1.5 Questões em aberto

Decisões a tomar, não tarefas a executar.

**`SharedArrayBuffer`.** Necessário para WASM multi-thread (DuckDB-WASM, Pyodide com threads); exige
**cross-origin isolation** (COOP `same-origin` + COEP `require-corp`), o que interage diretamente com
o modelo de iframe do app e com o proxy. **Precisa ser decidido antes**, não depois — habilitar
depois quebra o que já estiver embutido sem CORP.

**Terminal persistente.** O embutido não persiste: `terminal.ts` abre um `ssh.shell()` novo por
conexão e faz `dispose()` no close, e não há `dtach`/`tmux`/`screen` em lugar nenhum do repositório.
`terminal-latch` foi o experimento nessa direção e **não se firmou**. A
[Onda 1](01-sessao-sem-xpra.md) abre um caminho novo — uma sessão dona de recursos pode ser dona de
um `dtach` — a avaliar quando o fundamento existir.

> A afirmação contrária aparecia em **quatro** docs do `vssh-sso`, e o `smoke-checklist.md` mandava
> validar a persistência — um teste manual que sempre falharia. Corrigido na
> [Fase 1 da limpeza](00-limpeza-de-terreno.md).

**Extensão de navegador.** MV2 é **deliberado e viável**: é o que a torna possível em Edge, Brave e
Firefox; só o Chrome removeu. O Scramjet se provou o caminho certo, e a pergunta não é "migrar para
MV3" — é **se ainda vale manter a extensão**.

**Isolamento de apps.** O iframe é mesma origem e sem `sandbox` (`VsshAppWindow.js:63`), e `_appFs`
valida o grant **no cliente**. Fora de escopo por decisão, com o pressuposto "todo app é escrito
internamente". Uma correção importante sobre a conclusão anterior: **origem separada nunca seria a
fronteira**, porque o **backend do próprio app já roda como o usuário Linux com acesso POSIX a
tudo**. Uma fronteira real exigiria isolar o **processo** — backend como outro usuário Linux ou em
container. Isso é mudança de modelo, não um degrau; um gate HTTP só faria sentido **depois**, como
higiene.
