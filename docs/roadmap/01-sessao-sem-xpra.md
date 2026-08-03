# Onda 1 — Sessão desacoplada do Xpra

> **Estado:** ✅ concluída · **Atualizado:** 2026-08-02 · **Repo:** `vssh-sso`
>
> 19 arquivos, +807/−42. Portões: `tsc`, `eslint`, **193 testes** (eram 178).

Era o fundamento. "Sessão" era sinônimo de "processo xpra": o watchdog de apps
`kind:"service"` nascia dentro do `startXpra()` e morria dentro do `stopXpra()`, então **num
servidor sem X11 nenhum daemon subia** — a categoria inteira de "serviço" dependia de X11
para existir.

Hoje a sessão é objeto de primeira classe, e o desktop tem dois caminhos.

## O que existe agora

**`src/services/session.ts`.** `ensureSession(serverId, linuxUser)` garante uma frase:
*"este par está pronto para hospedar trabalho"* — a conta Linux e o supervisor de apps, ambos
idempotentes, uma vez por sessão. Mais `touchSession`, `endSession`, `retainSession` /
`releaseSession` e `sessionStats()`, espelhando o idioma de `sshSlotStats()`.

A chave é canonicalizada como `sshPoolKey(cfg)::linuxUser` — a mesma de `fs-watch.ts`.
Canonicalizar não é preciosismo: `serverId` chega ora como nome, ora como id, e duas grafias
do mesmo servidor produziriam duas sessões para o mesmo par real.

**Dois caminhos para o desktop, no mesmo servidor.**

| Path | Quem serve | Custo da requisição |
|---|---|---|
| `/<serverId>/proxy/desktop/` | o processo xpra do usuário (`--html=`) | `id -u` por SSH no cache miss + verificação de túnel |
| `/<serverId>/proxy/vssh-desktop/` | o portal (`services/vssh-shell.ts`) | ACL e servir estático — **zero SSH** |

`servers.profile` (`x11` \| `headless`) diz **o que o servidor sabe fazer**, não qual shell o
usuário recebe. Um `x11` oferece os dois; num `headless`, `/proxy/desktop/` responde 409
apontando o outro path.

## O que a Onda 1 ensinou

**A premissa mais importante do plano era falsa, e era bug em produção.** O plano ancorava o
lease no `/ws/events` "que o shell abre nos dois modos". Não abria:
`_open_events_channel()` só era chamado de `XpraClient.connect()`, e o ramo standalone do boot
nunca chama `connect()`. Consequência real, independente desta onda: **um shell em `?xpra=0`
não recebia o sinal `migrate`** no shutdown do pod — o drain voltava a ser de horas justamente
para ele. O método não usa nada do transporte, só `location`; sempre pertenceu ao boot.

**"Tem de ser a mesma URL" era impreciso — o contrato é a PROFUNDIDADE.** A roadmap listava
cinco razões para não mudar a URL do desktop. Verificadas uma a uma contra
`/proxy/vssh-desktop/`, que tem os mesmos três segmentos: `'../../api/fs'` resolve igual, o
serverId continua sendo `pathname[0]`, o `localStorage` é chaveado pelo **serverId** e não pelo
path, e o `skipsHelmet` já casa. Só o service worker ganha um segundo escopo — um cache a mais,
não uma quebra.

O ganho de trocar query+sessão por path próprio é que **some estado**: sem query param que
evapora no reload, sem flag de sessão, sem cookie. A URL *é* a escolha, e é compartilhável.

**No headless o desktop não tem porta — e isso não é economia, é estrutura.** No Xpra a porta
por usuário existe porque quem serve o HTML é o processo xpra *daquele* usuário. Quando é o
portal que serve, ele já sabe quem é o usuário pela sessão autenticada. Sem `id -u`, sem porta,
sem túnel.

A consequência que vale mais: a restrição dura do plano era *"`ensureSession` não pode tocar
SSH no caminho quente, porque o proxy o chamaria por requisição"* — regra que alguém quebra em
seis meses. Com o desktop sem SSH, o `ensureSession` saiu do proxy **por completo** e nasce no
canal de eventos. Virou estrutural em vez de combinado.

**O desktop VSSH não tem "iniciar" — e isso o código já dizia.** `startXpra` **nunca**
provisionou usuário: quem chama `vssh-setup-user` é o `provisionKey` e o `startCodeServer`. O
"Iniciar Ambiente Remoto" já provisionava pela metade do code-server. Logo não há processo a
iniciar para o desktop servido pelo portal — há uma página e uma sessão. O que precisava de
gatilho era a conta Linux, e ela virou responsabilidade do `ensureSession`.

## Decidido diferente do plano

- **`endSession` fecha só os watchers de fs.** Túnel e supervisor sobrevivem: derrubar túnel
  embaixo de quem só perdeu rede quebra usuário ativo, e matar o supervisor mataria daemons que
  existem para sobreviver ao fechar do navegador. O watcher é o vazamento real — canal SSH
  longo que **não passa pelo limitador**, contra um teto de ~8 por **servidor**.
- **O encerramento é adiado, com refcount.** Duas abas sustentam uma sessão; recarregar fecha e
  reabre o socket em milissegundos, e encerrar na hora derrubaria o watcher de quem só apertou
  F5.
- **O `index.html` do shell é lido no boot, não sob demanda.** Um `<head>` reformatado derruba
  o processo na subida (e falha o `boot.test.js`) em vez de servir, na primeira requisição de
  um usuário, uma página que carrega, parece certa e tenta conectar num Xpra que não existe.

## Ficou pendente

- **`GET /api/keys/xpra/status` ainda chama `startXpra`** quando o status diz que já está
  rodando (`keys.ts:524-529`). GET com efeito colateral. A rota depende dele para obter porta e
  senha, e extrair um leitor puro mexe no caminho x11 que funciona — trocar um cheiro conhecido
  por um risco desconhecido não valia. O `ensureSession` deduplicado absorve o efeito de o poll
  reentrar por ali.
- **Remover `_eagerStartAlwaysRunningEngines`** (`vssh-client/index.html:2103`) — condicionado a
  validar o supervisor num servidor real, que é operação, não código.
- **Derrubar túneis no `endSession`** — reavaliar quando houver confiança no lease.
- ~~**O perfil que esta onda criou carrega e CONSTRÓI o cliente Xpra.**~~ — ✅ **resolvido depois**,
  na Onda 2. A onda 1 desacoplou o ciclo de vida da *sessão*; o que ficou de fora, de propósito, foi
  o que a *página* carrega. Medido depois de um usuário estranhar o console: um
  `new XpraClient("screen")` em `index.html:739`, 846 linhas **antes** do único
  `if (VsshHost.xpraDisabled())` do boot. Hoje o portal serve o perfil sem X11 sem as tags marcadas
  — 1.369.332 B, 40,4% do JS — e `client` é `null` ali. Ver
  [diagnostico.md § Peso morto servido ao navegador](diagnostico.md#peso-morto-servido-ao-navegador).

## Verificação pendente, no servidor

O passo 0 é o que mais informa, porque é a afirmação mais forte e a mais fácil de falsear:

0. **Com uma conta nunca provisionada nesse servidor**, abrir `/<serverId>/proxy/vssh-desktop/`
   direto, sem passar pelo card. O shell tem de carregar e o `ensureSession` tem de criar a
   conta — é o que prova que "não tem iniciar, é acessar" é verdade e não desejo.
1. Recarregar: continua igual, sem query nem estado.
2. Janelas, taskbar, Start Menu, gerenciador de arquivos, um vssh-app abrindo.
3. Um app `kind:"service"` sobe. `pgrep -u <user> xpra` não mostra sessão nenhuma.
4. `/<serverId>/proxy/desktop/` no mesmo servidor continua funcionando — é o ponto de o
   servidor não ser hard-um-modo.
5. Console em standalone: `/ws/events` conecta. Antes não conectava; é o bug consertado.
6. `docs/refactor/smoke-checklist.md` inteiro no modo novo.

**A propriedade que vale medir, não afirmar:** com o shell aberto em `vssh-desktop`, recarregar
várias vezes **não pode mover `sshSlotStats()`**. Se mover, algo no caminho novo ainda resolve
porta, túnel ou sessão por requisição — e a economia que motiva o desenho não existe.

## O que isso desbloqueia

Toda a Categoria C de [casos-de-uso.md](casos-de-uso.md#categoria-c--daemons--serviços-kind-service),
a [Onda 2](02-apis-de-shell.md) inteira, e o item 2 da [Onda 7](06-portabilidade.md).

> **Adjacência registrada.** Com a sessão virando objeto com dono em vez de processo, fica
> possível o que antes não era: **a home do usuário montada por rede**
> ([Onda 6](05-arquivos-de-rede.md)) separaria *onde o usuário é* de *onde o dado dele está*, e
> a sessão passaria a ser relocável entre servidores — o ambiente quase serverless. Não se move
> o que só existe como um PID. Ver também [devcontainers](04-runtime-composicao.md), que
> dependem do runtime da Onda 4.
