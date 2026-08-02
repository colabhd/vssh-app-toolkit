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
| **`/ws/events` dentro do `Client.js`** | ~55 linhas **nossas** em arquivo upstream MPL | Todo item da Onda 2 que precise do canal custa outra edição lá, ou outro `CustomEvent` de contorno — como a bandeja precisou. Extrair para `js/host/vssh-events.js` |
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

`js/lib/aurora/{aac,flac,mp3}.js` = **401.838 B nunca referenciados**; `design-system.html` = 1854
linhas públicas com zero referências, **já divergidas** do `design-tokens.css` real; três overlays
órfãos do upstream, um deles se apresentando como *"Xpra HTML5 Client / Version 19"*.

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
