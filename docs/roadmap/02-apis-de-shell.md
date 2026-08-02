# Onda 2 — APIs de shell: tray, notificações, clipboard, impressão

> **Estado:** não iniciado · **Atualizado:** 2026-08-02 · **Repos:** `vssh-sso` + toolkit
> **Dependência da** [Onda 1](01-sessao-sem-xpra.md) **satisfeita** — a sessão existe
> (`services/session.ts`), e com ela o canal que esta onda precisava.

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

### O transporte correto: um vigia por SERVIDOR

A conexão pooled já autentica como o usuário provisionador (que tem sudo). Um **único vigia
privilegiado** observa `/home/*/.vssh-apps/*/tray.json` e `/home/*/.vssh-notifications/`, emite
linhas `{user, path}`, e o portal demultiplexa por usuário roteando para o `/ws/shell` da sessão
certa.

**Custo: 1 canal por servidor, constante**, independente do número de usuários — em vez de N.

A resolver no desenho:
- o teto de inotify do kernel (`fs.inotify.max_user_watches`) vira o limite relevante em vez do canal
  — é sysctl, não recurso escasso do portal;
- ler arquivos de outros usuários exige o mesmo cuidado que o `sudo -u` já toma hoje;
- se o vigia privilegiado for indesejável, a alternativa é **polling em lote**: um `exec` transiente
  por servidor a cada poucos segundos, custando canal só durante a chamada, ao preço de latência.

### Isto conserta dívida existente

`vssh.fs.watch` **já** segura um canal por usuário hoje. O vigia por servidor é o caminho para também
consertar isso: os watches de app passariam a ser fan-out do mesmo vigia, e
`MAX_WATCHES_PER_USER = 4` (`fs-watch.ts:54`) deixaria de proteger um recurso que não é mais escasso.

---

## 2.1 — Tray

O item que motivou esta onda. **Toda a Categoria C é inviável sem ela** — ninguém abre Configurações
para saber se o rclone está sincronizando.

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

**Arquivos:**
- novo `vssh-client/js/TrayArea.js`, **dono** do `#taskbar-tray`;
- a coexistência com o `_process_new_tray` é mais delicada que um namespace de id: os dois
  renderizadores têm modelos incompatíveis (pixmap contra dados declarativos) e o do upstream tem
  efeito colateral no menu flutuante. O caminho provável é o `TrayArea` ser dono do container e o
  X11 virar **mais uma fonte dentro dele**, não dois renderizadores dividindo um div.
  **Não reescrever o upstream MPL** — a regra de `vssh-host.js` é não aumentar o delta;
- ponte: novo `case 'tray'` no `_setupAppBridge`, caminho síncrono para apps **com** janela (sem
  arquivo nenhum);
- toolkit: `lib/node/vssh-tray.js` (escrita atômica), `vssh.tray.set/remove` no shim,
  `shell.tray` no schema;
- [`../api.md`](../api.md) perde a linha "Ícone de bandeja — sem equivalente".

---

## 2.2 — Centro de notificações

Hoje só há toasts efêmeros: sem histórico, sem persistência, sem identidade por app, sem ações.

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
seleção X para sincronizar. Declarar isso honestamente é **acrescentar `clipboardServer: false`** às
capabilities do `host-standalone` — hoje ela tem quatro chaves (`nativeApps`, `x11Interop`,
`keyboardGrab`, `sessionStats`) e nenhuma de clipboard. Melhor que construir meia-ponte. No perfil
x11 o caminho do xpra continua e a API do shell delega a ele.

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
