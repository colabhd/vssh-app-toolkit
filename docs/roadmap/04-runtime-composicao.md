# Ondas 4 e 5 — Runtime de apps e composição do ecossistema

> **Estado:** 🟡 em andamento — **healthcheck ✅** (verdadeiro **e** assíncrono) ·
> **`kind:"service"` com janela ✅** (medido: era um teste) ·
> **Atualizado:** 2026-08-06 · **Repos:** `vssh-sso` + toolkit
>
> Revisado contra o código em 2026-08-05, junto com a [Onda 3](03-toolkit.md). O que mudou: a
> **Onda 4 começa pelo healthcheck**, que absorveu o que a
> [2c](02c-interludio.md#r3--o-que-sobrou-não-justifica-uma-vm) mediu (**`ready` hoje
> significa "alguém respondeu"**); `kind:"service"` **com janela** e a metade que verifica o
> `requiredPackages` ganharam dono aqui; e a Onda 5 passou a ter um item de **contrato do
> manifesto**, que absorveu o `minShellVersion` da Onda 3.

---

## Onda 4 — Runtime de apps

O que falta para um app ser um cidadão de primeira classe do ambiente, e não um processo solto.

> **A ordem daqui não é a ordem de tamanho — é a de razão.** O healthcheck vem primeiro: ele
> destrava A2 (que o [`casos-de-uso.md`](casos-de-uso.md) já chama de *"quase pronto"*), fecha o
> suspeito B de *"atualizei o app e nada mudou"*, e o canal por onde a resposta chega **já existe**
> desde a Onda 1. Depois vêm as duas coisas que decidem se A1 precisa de mecanismo novo ou de um
> teste — e a primeira delas, `kind:"service"` **com** janela, já respondeu **teste**. Limites de
> recurso, GPU e cofre de segredos são maiores, e nenhum deles desbloqueia um arquétipo sozinho.

### Healthcheck assíncrono — ✅ CONCLUÍDO

`POST /api/apps/:id/start` fazia poll do healthcheck até 15×1 s **de forma síncrona, bloqueando o
clique do usuário**. Streamlit, Panel e RStudio demoram a subir — o resultado era uma janela que
parecia travada.

Caminho: devolver imediatamente com estado `starting`, e a janela mostrar "carregando" até o
**`/ws/events`** avisar que subiu — o canal já é por sessão e existe **no ambiente**, com ou sem
motor X11, desde a [Onda 1](01-sessao-sem-xpra.md); não há segundo socket a criar (ver
[Onda 2.0](02-apis-de-shell.md#canal-shellnavegador-usar-o-wsevents-não-criar-um-segundo)). É o
atrito que separa A2 de "quase pronto" para "pronto".

#### ✅ Primeiro: o sinal virou verdadeiro

*"Antes de tornar o sinal assíncrono, torná-lo verdadeiro"* — feito, e era metade do item.

**O `ready` significava "alguém respondeu", não "o app está servindo".** A sondagem ia sem header
nenhum; um app que fecha a própria porta por token — defesa em profundidade que a **própria SKILL
oferece** — respondia `403`; e `403` não é 5xx, então **contava como pronto**. O portal declarava
servindo um app do qual nunca tinha visto uma resposta de verdade. O motor Xpra não cai nisso
porque serve estático; o próximo app com gate cairia.

É o pior tipo de modo de falha: **o sinal existe, é verde, e não significa nada.**

O conserto tem duas metades, e uma sem a outra seria pior que nenhuma — só o header deixaria o
`403` verde, e só a regra reprovaria apps corretos que gateiam a rota:

| | |
|---|---|
| a sondagem leva o `X-Vssh-App-Token` | o mesmo que o proxy injeta — exercita o caminho **real** do app em vez de bater na porta e ouvir o porteiro |
| `401`/`403` deixam de contar como pronto | com o header no lugar, recusar é recusar uma requisição **credenciada**, e o app não está servindo para ninguém |

**`404` continua contando como pronto**, e é decisão registrada: o servidor está de pé e
respondendo — o que está errado é o `healthcheckPath` do manifesto. Reprovar ali trocaria um sinal
fraco por um falso negativo, e quem escreveu o app leria "não subiu" sobre um app que subiu.

O `token` é parâmetro **opcional** de `_appHttpCode`, e a assimetria é intencional: os outros três
chamadores comparam com `'000'` e fazem outra pergunta — *"a porta está viva?"* —, para a qual um
`403` já é resposta. Há teste para a assimetria, para ela não virar esquecimento.

Sete ataques por refutação, todos vermelhos. E a contraparte no toolkit foi corrigida: a SKILL
mandava **isentar** o healthcheck do gate de token, o que deixou de ser necessário.

> **5xx já não contava como pronto** antes disto, e a resposta já reportava `ready`/`lastCode`
> (`routes/apps.ts:167`). A frase da 2.7 que dizia *"o poll aceita qualquer coisa que não seja
> `000`"* descrevia um poll que já tinha mudado.

#### ✅ Depois: assíncrono

Com o sinal verdadeiro, propagá-lo passou a valer a pena. Antes, um `ready` que queria dizer
"alguém respondeu" só chegaria mais rápido — e num canal onde a janela vai **confiar** nele para
sair do "carregando".

`POST /start` devolve na hora com **três estados**, e a distinção é o item inteiro:

| | |
|---|---|
| `ready` | o healthcheck confirmou, ou o app já estava rodando |
| `starting` | subimos agora; o veredito chega por `app-status` no `/ws/events` |
| `failed` | o poll rodou até o fim e o backend não respondeu |

`ready` continua no corpo com a semântica antiga, mas em `starting` ele é **`null`** — nem `true`,
que seria mentira, nem `false`, que faria o cliente avisar de um fracasso que ainda não aconteceu.
`result.ready !== false` daria `true` para `null`, e a janela abriria sem cobertura achando que o
app já serve; há teste para exatamente essa linha.

**Nenhum socket novo.** O `/ws/events` já é por sessão, autenticado, com heartbeat e reconexão
desde a [Onda 1](01-sessao-sem-xpra.md) — é a peça que dispensou o `src/ws/shell.ts` que a Onda 2
previa. A rota já chamava `ensureSession` e **descartava o resultado**; era só ele que faltava.

**A janela abre coberta.** `.ds-cobertura` é vocabulário novo do design system, e a diferença para
o `.ds-carregando` que já existia é de escopo: a linha diz que *um pedaço* está vindo e o resto da
tela funciona; a cobertura diz que *não há tela ainda*. Um app que já estava rodando **não** é
coberto — piscar espera sobre conteúdo que existe é pior que não mostrar nada.

E a cobertura sai **também quando o backend não ficou pronto**. Ela promete que algo está a
caminho; depois de o poll desistir, viraria uma promessa falsa girando para sempre — que é pior
que o iframe branco que ela veio substituir. Quem diz o que houve é o mesmo aviso de antes, dito
agora na hora em que se sabe.

**Sem sessão, o poll volta a ser síncrono.** Não há a quem avisar depois, e degradar para o
comportamento antigo é melhor que abrir a janela e nunca tirar o "carregando" dela.

A guarda é de **junção em quatro pernas** — a rota empurra `app-status`, o `EventsChannel` traduz
para `vssh-app-status`, o `AppLauncher` escuta e acha a janela, a janela remove a cobertura. Um
typo em qualquer nome não quebra nada: a mensagem chega e ninguém a atende, e a janela fica em
"Iniciando…" para sempre. Doze ataques por refutação, todos vermelhos.

> **Duas guardas existentes ficaram vermelhas com a mudança, e foram corrigidas em vez de
> afrouxadas.** Elas casavam a assinatura de `startApp` com `\([^)]*dbUser\?: any\)` — o que as
> amarrava a `dbUser` ser o **último** parâmetro e a assinatura caber numa linha. Nenhuma das duas
> coisas é a propriedade que elas protegem (o `dbUser` chegar ao app), e uma guarda que reclama de
> mudança legítima é uma guarda que alguém afrouxa.

### `kind:"service"` **com** janela — ✅ **medido; era um teste, e não um mecanismo**

`routes/apps.ts:75-81` diz que `kind` (lifecycle) é **ortogonal** a `type` (janela / sem janela), e
o launcher só filtra `type === 'engine'`. Ou seja, um app supervisionado **com** janela é
declarável hoje e aparece no menu.

O [`casos-de-uso.md`](casos-de-uso.md) chamava isso de *"combinação não suportada"* e dizia que o
*"kernel morre com a janela"* — **os dois estavam errados**, e a revisão de 2026-08-05 conferiu:
fechar a janela não para backend nenhum (`VsshAppWindow._onClose` só solta listeners do cliente; o
único `/stop` do ambiente é o botão de Configurações → Serviços).

Sobraram duas perguntas, e elas foram medidas rodando os scripts **de verdade** —
`infra/server/vssh-app-supervisor` e `vssh-app-run` — contra uma árvore de mentira
(`tests/unit/servico-com-janela.test.js`). Reimplementar a decisão em JS teria respondido sobre a
reimplementação; foi por isso que os dois scripts ganharam o único seam de que isto precisava
(`VSSH_APPS_ROOT`, sem efeito em produção).

**1. O supervisor relança — e a janela não entra na conta.** A decisão tem exatamente três
entradas: o `kind` do manifesto, a existência do EnvironmentFile e o `run.pid`. É o que "ortogonal"
quer dizer, agora medido em vez de afirmado. A guarda disso não é o caso feliz — é o **conjunto**
de entradas: o fonte não pode passar a consultar janela nem sessão.

**2. A janela reata, e quem faz isso é o EnvironmentFile.** A pergunta pressupunha uma porta na
URL, e não há nenhuma: o `src` do iframe é `/<serverId>/proxy/app/<id>/` e quem resolve a porta é o
proxy, a cada requisição. Do outro lado, `vssh-app-run` dá `source` no env **antes** do fallback
determinístico, então o processo novo sobe na mesma porta e com o mesmo token. Tirar o env do
caminho muda a porta — e é esse teste, o de refutação, que mostra que o mecanismo carrega peso.

> **A guarda que a refutação consertou.** `\bjanela\b` não vê um `JANELA_ABERTA`, porque `_` é
> caractere de palavra — e `JANELA_ABERTA` é exatamente como a variável se chamaria. Do lado do
> proxy, medir *uma menção* a `getUserAppPort` era pior: com duas resoluções no arquivo, atacar uma
> deixava a outra atestando o contrário. O que se mede agora é **toda** atribuição de `port` —
> nenhuma pode ser valor fixo, porque porta fixa no proxy **é** a porta morta da pergunta. Treze
> ataques, todos vermelhos.

**O que a medição achou e nenhum teste guarda, porque é ausência e não regra:** nada recarrega o
iframe. A porta está certa, o processo novo atende — e a página continua sendo a do processo morto,
falando com um substituto sem saber. Um serviço com estado no backend é justamente onde isso dói.

Não é bloqueio de A1 e não vira mecanismo novo agora: **o canal já existe** (`app-status` no
`/ws/events`, e a janela já sabe receber veredito desde o healthcheck acima). O que falta é alguém
**olhar** o `status.json` que o supervisor escreve — hoje só Configurações → Serviços pergunta, e
sob demanda. Isso é um poller por sessão, e pertence ao item de estado ao vivo dos Serviços, não a
esta medição.

### Múltiplas instâncias e múltiplas janelas

Uma instância por `(usuário, app)`, uma janela por app — **conferido**: `AppLauncher.findWindow`
devolve a janela existente em vez de abrir a segunda. Isso bloqueia A1 diretamente — um pesquisador
quer dois notebooks abertos lado a lado, não abas dentro de uma janela. É o **único** bloqueio de A1
que continua de pé depois da revisão (ver a seção acima).

Interage com `Window Management (getScreenDetails)` do [critério do navegador](criterios.md#31--o-navegador-já-faz-isso)
para o caso multi-monitor.

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

### `requiredPackages` — a metade que verifica

O campo no manifesto e a validação no publish são da
[Onda 3](03-toolkit.md#requiredpackages--o-app-declara-de-que-pacote-linux-ele-precisa). **A
verificação é daqui**, porque quem sabe o que existe num servidor é o portal:

1. **`vssh-app-install` recusa antes de instalar**, com o nome do pacote que falta — em vez de
   instalar um app que nunca vai subir. O instalador já falha alto por outros motivos e o motivo
   já chega à aba admin desde a [Onda 2c](02c-interludio.md#r6--a-resposta-estava-no-código-e-o-erro-morria-na-última-linha),
   então isto entra num caminho que já funciona;
2. **o painel admin mostra o que falta por servidor** — é a mesma pergunta que o provisionamento já
   responde para os grupos de pacotes (`provision-base.sh --print-packages`, com fixture em
   `tests/unit/provision-packages.test.js`), agora por app.

> **Herda a pergunta do [registro de capabilities](#registro-de-capabilities), e a resposta é uma
> só para os dois:** o que fazer quando falta — recusar, avisar, ou instalar. Decidir isso duas
> vezes é como se acaba com dois comportamentos para a mesma frustração.

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

### Cofre de segredos

Um app que fala com banco, com S3 ou com uma API externa não tem onde guardar credencial. Cada app
inventa o seu — normalmente um arquivo em texto plano no `VSSH_APP_DATA_DIR`.

---

## Onda 5 — Composição do ecossistema

Hoje o ecossistema **não compõe**: cada consumidor de motor fica acoplado a um produtor específico.

### O contrato do manifesto: um schema, uma validação, uma guarda

Vem primeiro porque **três ondas escrevem no mesmo arquivo** e nenhuma era dona dele:

| Onda | Campos |
|---|---|
| [3](03-toolkit.md) | `requiredPackages` |
| [4](#requiredpackages--a-metade-que-verifica) | limites de recurso, `gpu: true` |
| 5 (aqui) | `provides: [...]`, `minShellVersion` / `targetShellVersion`, a seção de Configurações |

Todos precisam das mesmas três coisas: entrada no `schema/vssh-app.schema.json`, validação no
`vssh-app-publish`, e um consumidor no portal. Feito uma vez, paga pelas três; feito três vezes,
são três noções do mesmo contrato livres para divergir.

**E o schema hoje não segura nada:** ele é `"additionalProperties": true` na raiz — campo novo não
quebra nada, e **campo com erro de digitação também não**. O `engine.loader`, que a
[2.7](02b-motores.md) pôs em produção, só está declarado porque alguém lembrou de declarar. A
guarda que falta é a mesma que a Onda 2c usou nos itens 8 e 9, na direção que importa aqui: **todo
campo que o portal lê está no schema.** Um campo que o portal lê e o schema não conhece é um
contrato que existe só na cabeça de quem escreveu os dois lados.

O `minShellVersion` entra aqui, e não na Onda 3, por esse motivo — ele e o `provides` são o mesmo
trabalho com nomes diferentes. A metade que **publica** a versão já existe
([Onda 2c](02c-interludio.md#o-que-veio-junto-e-são-duas-identidades)); o que falta é o campo, a
validação no publish e a mensagem quando não bate.

> **Não versionar por reflexo.** Um `minShellVersion` obrigatório transformaria toda API nova em
> quebra de compatibilidade declarada, que é a burocracia sem o benefício. O padrão é **não
> declarar**, e quem declara está dizendo *"eu uso uma coisa que não existia antes"* — a mesma
> regra do `engines` do npm, pelo mesmo motivo. E ele **não substitui** o `vssh.capabilities()`:
> um é gate de publish, o outro é decisão de runtime — o quadro está na
> [Onda 3, no T7](03-toolkit.md#t6-e-t7--as-duas-dívidas-que-não-tinham-onda).

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
