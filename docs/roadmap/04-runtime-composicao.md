# Ondas 4 e 5 — Runtime de apps e composição do ecossistema

> **Estado:** não iniciado · **Atualizado:** 2026-08-02 · **Repos:** `vssh-sso` + toolkit

---

## Onda 4 — Runtime de apps

O que falta para um app ser um cidadão de primeira classe do ambiente, e não um processo solto.

### Limites de recurso

Não há cgroup nem `systemd-run` por app. **Um treino desgovernado derruba a sessão inteira do
usuário** — inclusive o shell, o gerenciador de arquivos e os outros apps.

Caminho: `systemd-run --scope --user` com `MemoryMax`/`CPUQuota`, ou cgroup v2 direto no
`vssh-app-run`. Declarável no manifest, com default generoso.

> **Um pré-requisito silencioso já foi pago.** Conter recurso exige um **grupo de processos** —
> senão o limite alcança o processo declarado e não os filhos que ele gera, que é justamente onde
> um treino desgoverna. A [Onda 2.7](02b-motores.md) deu um a todo vssh-app ao consertar outra
> coisa: `nohup setsid vssh-app-run` no spawn e `_killAppTree` na parada, feitos porque o Xpra
> deixava órfãos os filhos de `--start=`. Com `setsid`, **PGID == PID == `run.pid`** — que é
> exatamente o identificador que um `systemd-run --scope` ou um cgroup v2 precisa receber.

> A opção de usar unidades systemd para o **lifecycle** já foi avaliada e rejeitada em
> `vssh-sso/docs/refactor-backlog.md`. Isto aqui é diferente: usar systemd só para **conter**
> recursos, mantendo o lifecycle onde está.

### GPU como conceito de runtime

Hoje GPU existe só no provisionamento (`vssh-provision.sh --gpu`, que passa o passthrough ao host e
delega a config de Xorg ao `provision-base.sh --gpu` dentro do guest). Não há API de runtime, nem
agendamento, nem pedido por app, nem visibilidade no portal.

Mínimo viável: `gpu: true` no manifest, `CUDA_VISIBLE_DEVICES` injetado no processo, e o estado
visível em Configurações. Sem isso, o arquétipo B3 (inferência) não tem como conviver com outros
consumidores da mesma placa.

### Múltiplas instâncias e múltiplas janelas

Uma instância por `(usuário, app)`, uma janela por app. Isso bloqueia A1 diretamente — um pesquisador
quer dois notebooks abertos lado a lado, não abas dentro de uma janela.

Interage com `Window Management (getScreenDetails)` do [critério do navegador](criterios.md#31--o-navegador-já-faz-isso)
para o caso multi-monitor.

### Healthcheck assíncrono

`POST /api/apps/:id/start` faz poll do healthcheck até 15×1 s **de forma síncrona, bloqueando o
clique do usuário**. Streamlit, Panel e RStudio demoram a subir — o resultado é uma janela que parece
travada.

Caminho: devolver imediatamente com estado `starting`, e a janela mostrar "carregando" até o
**`/ws/events`** avisar que subiu — o canal já é por sessão e existe **no ambiente**, com ou sem
motor X11, desde a [Onda 1](01-sessao-sem-xpra.md); não há segundo socket a criar (ver
[Onda 2.0](02-apis-de-shell.md#canal-shellnavegador-usar-o-wsevents-não-criar-um-segundo)). É o
atrito que separa A2 de "quase pronto" para "pronto".

### ~~"Atualizei o app e nada mudou" — o par de suspeitos~~ · ✅ **o suspeito A caiu; sobrou o B**

Ao publicar o `hello-world-node` com a bandeja, o app **só** funcionou depois de um `Shift+F5`. Este
texto anotou dois suspeitos e mandou medir antes de consertar. **Um deles foi resolvido — e a
correção não é a que estava escrita aqui.**

**A — validador fraco. ✅ Resolvido, por um caminho melhor que o proposto.** A proposta era `ETag`:
um validador forte no lugar do `Last-Modified` comparado por igualdade de string. O conserto que
entrou (`lib/node/static-spa.js`, `criarCarimbador`) foi outro, e a nota no fonte diz por quê:

> *A correção não é um header melhor: é **fazer o conteúdo novo morar noutra URL**. Cache nenhum
> pode servir velho no lugar de novo se as duas coisas nem são o mesmo recurso.*

`ETag` ainda depende de **todo elo do caminho colaborar** — navegador, proxy do portal, CDN. Basta
um guardar a resposta ou engolir o `If-Modified-Since` e o usuário fica com bytes velhos sem sinal
nenhum. URL carimbada com hash **do conteúdo** não tem esse elo fraco, e é o mesmo idioma que o
portal já usava para os assets do shell (`/b/<buildId>/…`, `src/utils/build-id.ts`). O hash sai dos
bytes, então muda quando — e só quando — eles mudam: reinstalar a mesma versão mantém a URL e o
cache do usuário sobrevive.

> **A ressalva que sobra, e vale para quem escreve app:** o carimbo mora na lib **vendorizada**.
> Um app que sincronizou `lib/node/` antes desta mudança continua com o mecanismo antigo até rodar
> `vssh-app-lib-sync` de novo. O sintoma que este parágrafo descreve pode reaparecer num app
> desatualizado, e a causa será a versão da lib — não o mecanismo.

**B — o backend ainda subindo. ⬜ Continua aberto.** `startApp` mata e reinicia o processo quando o
hash do código muda; a primeira abertura depois de um reinstall pode pegar o processo antigo ou em
reinício. **O conserto é o healthcheck assíncrono acima** — o poll síncrono de 15×1 s
(`vssh-apps.ts:569`) continua lá. O que mudou desde que este texto foi escrito é que a resposta
passou a reportar `ready`/`lastCode` (`routes/apps.ts:166`), então o cliente **avisa** em vez de
mostrar um iframe branco. É mitigação do sintoma, não a saída do bloqueio.

### Cofre de segredos

Um app que fala com banco, com S3 ou com uma API externa não tem onde guardar credencial. Cada app
inventa o seu — normalmente um arquivo em texto plano no `VSSH_APP_DATA_DIR`.

---

## Onda 5 — Composição do ecossistema

Hoje o ecossistema **não compõe**: cada consumidor de motor fica acoplado a um produtor específico.

### Registro de capabilities

`AppLauncher.ensureRunning(appId)` + `fetch` cru era o estado da arte, e o consumidor precisava
**fixar o `appId` no código**.

Proposta: `provides: ["llm/v1"]` no manifest, e resolução **capability → app** no `AppLauncher`. Um
app de chat pede `llm/v1` e recebe o motor que estiver instalado, seja ollama, vLLM ou outro. Isso é
o que permite trocar o produtor sem tocar em nenhum consumidor.

> #### ✅ O mecanismo já existe rodando, num caso concreto — e vale desenhar a partir dele
>
> A [Onda 2.7](02b-motores.md) pôs em produção `RemoteDesktopEngines.comCapacidade(nome)`: devolve
> **o primeiro motor registrado que oferece aquela capacidade**, e o consumidor nunca escreve um
> `id`. É literalmente a resolução que esta seção propõe, do lado do cliente. O comentário do
> registro diz o argumento melhor do que uma abstração diria:
>
> > *A pergunta certa quase nunca é "cadê o Xpra?" e sim "cadê alguém que saiba fazer isto?" — e as
> > duas só coincidem enquanto houver um motor só.*
>
> Duas lições dele que a versão com `provides:` herda:
>
> - **Capacidade é por duck-typing no ponto de uso, nunca exigida no registro.** Exigir transforma
>   *"este motor não faz isso"* em *"este motor não carrega"*. Um motor sem `layouts()` só não ganha
>   a linha de teclado — em vez de ganhá-la morta, que é o botão de volume que a 2.1 tirou da barra.
> - **`comCapacidade` não filtra por `available()`**, de propósito: quem lança um comando precisa da
>   resposta AGORA, e `available()` é assíncrona. Quem não puder atender falha por dentro, que é
>   onde sabe dizer por quê. A versão com `provides:` vai enfrentar a mesma escolha.
>
> A diferença que sobra, e é a que dá trabalho: `RemoteDesktopEngines` resolve entre motores que
> **já se registraram nesta página**; `provides:` precisa resolver entre apps **instalados no
> servidor**, o que significa índice no `/api/apps` e a decisão de subir o backend do vencedor.

Primeiro consumidor real sugerido: o **engine de impressão** (`print/v1`) da
[Onda 2.4](02-apis-de-shell.md) — nasce como caso concreto em vez de abstração especulativa. O
código dos três lugares que o esperam (`PrintDialog.js:12`, `routes/print.ts:7`,
`services/printers.ts:10`) já nomeia `provides: ["print/v1"]` e aponta para cá.

### Seção de Configurações declarada por manifesto

O terceiro consumidor do mesmo contrato de extensão, e o que fecha a analogia com a bandeja: no
Linux, um aplicativo instalado acrescenta a própria página às configurações do sistema.

A [Onda 2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito) constrói a janela nova e o
registro **interno** — motor de navegação, Serviços, teclado, `fileHandlers`, todos código do
próprio shell. O que fica para cá é a parte **declarativa**, para vssh-app de terceiro: o manifesto
declara a seção, e o shell a monta.

Por que aqui e não lá: um app de terceiro atravessa a mesma fronteira que `provides` e o
`FileOpener` plugável — contrato **versionado**, negociação por `vssh.capabilities()`, e o
tratamento de *"um shell antigo simplesmente não responde"* que os
[riscos transversais da Onda 2](02-apis-de-shell.md#riscos-transversais) já nomeiam. É um contrato
de extensão com três consumidores, não três mecanismos parecidos.

> **A restrição que a 2.6 descobriu foi resolvida — para dentro.** O texto anterior dizia que um
> registro só-dados, como o da bandeja, não sustenta uma seção com status ao vivo e ações, e
> deixava a forma em aberto. O `SettingsRegistry` respondeu: seção declara `disponivel()`,
> `estado()`, grupos de linhas com `controle.aoMudar`, `hint` que pode ser função, sub-páginas, e
> repinta quando o ambiente dispara um evento. **Funciona, e a janela não cita nenhuma seção pelo
> nome** — é asserção de teste. O que resta desta seção é só a **fronteira de terceiro**.
>
> E a 2.7 acrescentou uma **terceira saída** que este parágrafo não considerava. Além de
> (1) declarativo com campos tipados e (2) código do shell, existe (3) **o app entrega o script e o
> shell o carrega** — que é o `engine.loader` do manifesto, o primeiro campo que o shell consome
> para trazer código de um app. O ambiente conhece um campo de manifesto, não um motor.
>
> Ela é a mais poderosa e a que precisa da decisão mais explícita: o script roda **na origem do
> shell, com a confiança do shell**. Para um motor instalado por administrador isso é aceitável e
> foi aceito; para app de terceiro é outra conversa, e a resposta pode muito bem ser *"(3) não vale
> para terceiro"*. O que não pode é a diferença ficar implícita — hoje o único gate é quem pode
> rodar `vssh-app-install`.

### Ponto de extensão no `FileOpener`

`vssh-client/js/FileOpener.js` é um **mapa fixo** de extensão → ação. Não há como um engine
contribuir miniatura, preview ou render (arquétipo B4). Um engine de thumbnails, um de OCR ou um
transcodificador não têm onde se plugar.

### Mensageria entre apps

`BroadcastChannel` resolve hoje, e custa quase nada — porque tudo é same-origin.

> **Acoplamento a registrar:** é o mesmo fato que torna o isolamento fraco
> ([diagnostico](diagnostico.md#15-questões-em-aberto)). Se um dia houver origem separada por app,
> `BroadcastChannel` deixa de funcionar e a mensageria precisa passar pelo shell.
