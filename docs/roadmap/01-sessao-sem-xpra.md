# Onda 1 — Sessão desacoplada do Xpra

> **Estado:** não iniciado · **Atualizado:** 2026-08-01 · **Repo:** `vssh-sso`

É o fundamento. Hoje "sessão" é sinônimo de "processo xpra", e por isso **nenhum app
`kind:"service"` sobe num ambiente sem X11** — o supervisor nasce dentro de `startXpra()`. Enquanto
isso não mudar, a categoria "daemon" do ecossistema depende de X11 para existir.

## O conceito

**Sessão de portal = `(userSub, serverId)`** — um lease mantido pelo portal, dono explícito de três
recursos que hoje não têm dono:

| Recurso | Hoje | Depois |
|---|---|---|
| Supervisor de serviços | nasce em `xpra.ts:292`, morre em `xpra.ts:328` | nasce em `ensureSession()`, morre em `endSession()` |
| Túneis SSH | `ensureSshTunnelAsync` chamado de vários lugares, sem ninguém que os feche em massa | registrados na sessão; `endSession` derruba o conjunto |
| Watchers de fs | `_supervisors` em `fs-watch.ts`, só morre quando o último assinante sai | teardown explícito no `endSession` |

A chave `sshPoolKey(cfg)::linuxUser` de `fs-watch.ts:161` já é, na prática, a chave de sessão — vale
adotá-la como forma canônica.

Arquivo novo `src/services/session.ts`: `ensureSession` / `touchSession` / `endSession` /
`sessionStats` (espelhando o idioma de `sshSlotStats()`), estado in-memory + espelho em Redis com
TTL — o TTL **é** o lease.

## Fases

Cada uma é entregável sozinha.

| Fase | O quê | Risco |
|---|---|---|
| **1.0** | Criar `session.ts`; `ensureSession` faz exatamente o que `xpra.ts:292-294` fazia; `startXpra` passa a chamá-lo. Comportamento idêntico | nulo |
| **1.1** | `ensureSession` também em `routes/apps.ts:114` e no ramo `desktop` de `proxy.ts:431`. **Já aqui um servidor sem xpra sobe serviços** | baixo — o supervisor é single-instance por lockfile |
| **1.2** | Lease + heartbeat pelo `/ws/events` (ping/pong de 30 s já existe); `endSession` derruba túneis e watchers | médio |
| **1.3** | Perfil `headless`: campo em `servers`, **portal serve o shell**. O `--profile headless` do lado do provisionamento vem da [Fase 3 da limpeza](00-limpeza-de-terreno.md#fase-3--provisionador-unificado--não-iniciada) — não duplicar | médio |
| **1.4** | Remover `xpra.ts:328-330`; `stopXpra` volta a ser só "parar o servidor X" | baixo |
| **1.5** | Validar o supervisor num servidor real e remover `_eagerStartAlwaysRunningEngines` (`index.html:2111`) | — |

## Restrições duras

**`ensureSession` não pode tocar SSH no caminho quente.** O proxy o chamaria **por requisição**.
Precisa ser in-memory, com dedup de promise em voo — senão recria exatamente a tempestade de
`MaxSessions` que `da6bfb5` acabou de consertar no `checkAppStatus` (cada execução custava até ~8
canais, contra um teto de ~8 por servidor; duas ou três chamadas concorrentes derrubavam tudo e uma
rajada inteira de assets tomava 409 com o app vivo).

**Preservar o invariante de `da6bfb5`.** A sessão vira dona dos túneis **sem** virar um segundo dono
que os mantenha vivos além da morte do backend. "Existe túnel" significa "o app está de pé" para o
proxy; um túnel órfão faz o proxy encaminhar para socket morto durante todo o poll de startup.

**Fechar o watcher no `endSession` é incidente, não higiene.** Exportar `closeSupervisor(key)` de
`fs-watch.ts`. Um navegador que morre sem `close` limpo prende um canal — e com teto de ~8 **por
servidor** ([diagnostico](diagnostico.md#-teto-de-canais-ssh-8-por-servidor-não-por-usuário)), vazar
canal derruba o servidor para todo mundo.

**Excluir o túnel `_shared` do OnlyOffice** do teardown por sessão.

## O ponto crítico: quem serve o cliente HTML

**O próprio portal, na exata mesma URL.** Em `src/proxy.ts`, no ramo `semanticService === 'desktop'`
(linha 431), antes de `getUserXpraPort`: se o servidor for `headless`, servir
`custom_xprahtml5/` estático com `<script>window.VSSH_NO_XPRA=true</script>` injetado no `<head>`.

### Por que a mesma URL, e não uma nova

A profundidade do path é contrato:

- `VsshAppWindow._appFs` usa `const base = '../../api/fs'` (linha 518). Num path mais raso, isso
  resolveria para `/api/fs` — **sem serverId, silenciosamente errado**.
- `location.pathname.split('/').filter(Boolean)[0]` é o serverId em quatro arquivos:
  `AppLauncher.js:10`, `AppGrants.js:31`, `host/vssh-host.js:121` e o próprio
  [`lib/web/vssh-app-shim.js`](../../lib/web/vssh-app-shim.js).
- `WindowStateManager` e `AppGrants` chaveiam por `location.pathname[0]` no `localStorage` — mudar o
  path **descartaria o estado de janela e todos os grants de todo mundo, em silêncio**.
- `skipsHelmet` em `src/app.ts` já cobre `/^\/[^/]+\/proxy\//`. Path novo exigiria acrescentar
  entrada àquela lista.
- `sw.js` e `scram-sw.js` registram sob `/proxy/desktop/`; mudar invalida service workers já
  instalados nos navegadores dos usuários.

**Não usar redirect para `?xpra=0`** — o query some no primeiro `location.reload()` e a sessão volta
tentando xpra.

### Drift de bundle

Passam a existir **dois caminhos de deploy do mesmo artefato**: no perfil x11 o bundle vem do host
(`vssh-update-xpra-client.sh`, com canal stable/bleeding-edge por usuário); no headless vem do deploy
do portal. Expor o `buildId` num `GET /api/shell/config` para diagnosticar antes que vire bug
reportado.

Ganho colateral: no headless o bundle é o do próprio portal, o que **elimina uma classe inteira de
drift** entre cliente e backend.

## Perfil headless no provisionamento

`servers` é `SCHEMALESS`, então do lado do portal é só um campo: `profile: 'x11' | 'headless'`
(default `'x11'`).

**O lado do provisionamento não é feito aqui** — é a [Fase 3 da
limpeza](00-limpeza-de-terreno.md#eixo-headless), onde `provision-base.sh` ganha
`--profile headless` e a lista monolítica de 44 pacotes é decomposta em grupos. Esta onda só
**consome** esse flag; duplicar o trabalho seria criar duas verdades sobre o que é "sem X11".

Um servidor headless é significativamente mais barato de provisionar — argumento por si só para nós
de compute.

> Se a impressora de rede da [Onda 2.4](02-apis-de-shell.md) for adiante, o perfil headless precisa
> instalar **CUPS** explicitamente, já que nasce pulando o stack gráfico.

## Teste decisivo

Provisionar um servidor `--headless`, abrir `/<serverId>/proxy/desktop/` e confirmar que:

1. o shell carrega;
2. um app `kind:"service"` sobe **sem nenhum processo xpra na máquina**;
3. `docs/refactor/smoke-checklist.md` passa inteiro no perfil headless.

## O que isso desbloqueia

Toda a Categoria C de [casos-de-uso.md](casos-de-uso.md#categoria-c--daemons--serviços-kind-service),
a [Onda 2](02-apis-de-shell.md) inteira, e o item 2 da [Onda 7](06-portabilidade.md) — que fica
melhor depois de existir um conceito de sessão com dono.
