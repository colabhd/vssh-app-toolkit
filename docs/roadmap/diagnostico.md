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
> está vivo"** — é exatamente o que a [Onda 1](01-sessao-sem-xpra.md) pode quebrar ao fazer a sessão
> dona dos túneis.

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
| **Quem serve o shell HTML** | o próprio xpra (`--html=`), proxiado em `/<serverId>/proxy/desktop/` | **ninguém** |
| **Supervisor de `kind:"service"`** | lançado em `startXpra()` | **não sobe** |
| **System tray** | protocolo xpra (`#taskbar-tray`) | **vazio** |
| **Notificação/diálogo vindo do backend** | `vssh-psdialogd` (hijack D-Bus) | **inexistente** |
| **API de clipboard para apps** | inexistente | inexistente — lacuna nos dois modos |
| **Impressão** | já desligada (`--printing=no`) | só `window.print()`, que imprime **no cliente** |

### Três achados verificados no código

Nenhum deles aparece em `vssh-sso/docs/refactor-backlog.md`.

**1. O supervisor de serviços é filho da sessão Xpra.**
`src/services/provisioning/xpra.ts:292` lança `vssh-app-supervisor` dentro de `startXpra()`;
`stopXpra()` o mata (linhas 328-330). Sem Xpra não existe hook de início de sessão — logo **nenhum
app `kind:"service"` sobe**. Toda a categoria "daemon" depende hoje de X11 para existir. É o gargalo
estrutural do objetivo.

**2. Sem Xpra ninguém serve o cliente HTML.**
O desktop vive em `/<serverId>/proxy/desktop/` (`src/proxy.ts:431`), que resolve `getUserXpraPort()`
e proxia para o HTTP server do próprio xpra, cujo conteúdo vem do `--html=${htmlPath}`
(`xpra.ts:220`) — o bundle mora **no servidor Linux**, em `/usr/share/xpra/custom-www*`. `?xpra=0`
desliga só o host no navegador; a página ainda veio do xpra. Existe um shell que **tolera** a
ausência de X11 depois de carregado por ele — não um modo sem-X11 de ponta a ponta.

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
- **GPU não é conceito de runtime** — existe só no provisionamento (`lxc-create-nvidia.sh`).
- **Uma instância por (usuário, app)**: sem múltiplas janelas nem múltiplas instâncias.
- **Supervisor nunca validado em servidor real** (`docs/refactor-backlog.md:86-104`), com
  `_eagerStartAlwaysRunningEngines` (`index.html:2111`) mantido como rede de segurança.
- **Sem descoberta entre apps**: um consumidor de `type:"engine"` fixa o `appId` no código.

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
