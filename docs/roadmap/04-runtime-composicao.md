# Ondas 4 e 5 — Runtime de apps e composição do ecossistema

> **Estado:** 🟢 **Onda 4 concluída** · 🟢 **Onda 5 — os cinco itens percorridos**: contrato do
> manifesto ✅ (a peneira fechou, o erro nomeia o vizinho, e a guarda de junção mede os cinco
> consumidores) · `provides` ✅ e `minShellVersion` ✅, com o motor de navegação como primeiro
> consumidor real · mensageria ✅ (nada a construir; medida, escrita e cercada) · seção de
> Configurações por manifesto e ponto de extensão do `FileOpener` 🔵 **desenhados e não
> construídos, com o motivo escrito** — falta um produtor num, e a decisão de confiança no outro.
> A medição corrigiu **cinco** afirmações desta onda · **healthcheck ✅** (verdadeiro **e**
> assíncrono) · **`kind:"service"` com janela ✅** (medido: era um teste) · **múltiplas janelas ✅**
> (a cópia e a extra) · **`requiredPackages` ✅** (a metade que verifica) · **limites de recurso ✅**
> (e o pré-requisito que a roadmap dizia pago **não estava**) · **GPU ✅** (descoberta genérica pelo
> kernel + benchmark; o portão é só de CUDA) · **cofre de segredos ✅** (o app pede, o portal grava e
> não guarda) ·
> **Instalada e usada num servidor real**, que achou cinco defeitos que nenhuma bancada alcançava —
> [o que só apareceu ao instalar](#o-que-só-apareceu-quando-a-onda-foi-instalada). ·
> **Atualizado:** 2026-08-07 · **Repos:** `vssh-sso` + toolkit + `vssh-repo`
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

> **A ordem daqui não é a ordem de tamanho — é a de razão**, e ela já se cumpriu na primeira
> metade. O healthcheck veio primeiro: destravou A2, fechou o suspeito B de *"atualizei o app e
> nada mudou"*, e o canal por onde a resposta chega **já existia** desde a Onda 1. Depois, as duas
> coisas que decidiam se A1 precisava de mecanismo novo ou de um teste — `kind:"service"` **com**
> janela respondeu *teste*, e as múltiplas janelas responderam *janelas, não instâncias*. **A1 e A4
> ficaram sem bloqueio estrutural.** Em seguida o `requiredPackages`, que era o menor dos que
> restavam e o único que ainda travava alguém hoje.
>
> **Limites de recurso veio em seguida por ser o único item desta onda cujo modo de falha derrubava
> a sessão inteira do usuário**, e não só o app — e ele cobrou a conta de uma afirmação escrita aqui
> mesmo: a de que o grupo de processos "já estava pago". Estava, para um dos dois caminhos de
> subida.
>
> **GPU e cofre fecharam juntos, e a ordem entre eles não importou** — nenhum dos dois desbloqueia
> arquétipo sozinho, e os dois são a mesma frase: *o app declara, o ambiente decide, e o padrão é o
> seguro*. Um app que não pede GPU não a enxerga; um segredo que o usuário não guardou não existe.
> A simetria não foi buscada: ela apareceu porque a pergunta era a mesma.

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

### Múltiplas janelas — ✅ **N janelas, um backend**

O item pedia duas coisas no mesmo nome, e só uma delas era o bloqueio. **Janelas** eram o pedido de
A1 — *dois notebooks lado a lado, não abas dentro de uma janela*. **Instância** separada (porta,
token e `VSSH_APP_DATA_DIR` próprios) é outra coisa, e não é o que A1 quer: dois servidores Jupyter
sobre a mesma home são dois kernels disputando os mesmos arquivos e o dobro da memória. Duas janelas
do mesmo app são duas visões do mesmo processo, como duas abas do navegador no mesmo servidor.

Quem pede é o usuário, em **Nova janela** no menu de contexto da janela — e não o app, que continua
sem `window.open`. Fica ali porque é ali que a pessoa está quando descobre que quer a segunda:
olhando a primeira.

**O trabalho não foi abrir a segunda janela — foi que `appId` deixou de identificar uma.** Havia
cinco lugares perguntando "a janela do app X", e cada um daria uma resposta errada em silêncio:

| Onde | O que aconteceria |
|---|---|
| veredito do healthcheck | ele acontece **uma vez** — a janela não alcançada fica coberta para sempre |
| restauração de sessão | duas janelas salvas voltavam como **uma**, com a geometria da outra |
| bandeja | fechar uma apagava o ícone que a outra ainda sustenta |
| permissões de arquivo | revogar numa continuava valendo na outra — que é **não** revogar |
| mixer de volume | duas linhas com o mesmo id, cada uma desfazendo o que a outra escreveu |

Nenhum desses é a janela nova; todos são a **identidade**. `findWindow` passou a devolver a última
que teve foco (era a primeira que a varredura encontrasse), `findWindows` devolve todas, e `open()`
devolve **a janela que criou** — quem restaura precisa saber qual é a dela.

> **Um efeito colateral que valia por si.** O `open()` tinha a própria cópia do `POST /start`, não
> coalescida com a de `ensureRunning`. Como `/start` pode **matar e reiniciar** o backend, duas
> janelas pedidas ao mesmo tempo — que é o que a restauração de sessão faz — reiniciariam o app no
> meio da abertura das duas. Agora é uma chamada só, que é a verdade do modelo.

Dezoito ataques por refutação, todos vermelhos. Um deles derrubou uma guarda **minha**: medir o
sincronizador de grants por texto aprovava um `findWindows(appId).slice(0, 1)`, que sincroniza uma
janela só e mantém intacta a palavra que a guarda procurava. Virou execução do mecanismo extraído
do fonte.

> **O teste com as mãos acrescentou a metade que faltava: a janela EXTRA.** Abrir a segunda janela
> pelo menu de contexto abre uma **cópia** da mesma página — bom para ver dois pedaços de um
> documento, e incapaz de demonstrar qualquer outra coisa. `vssh.window.abrir(rota, opts)` dá o
> outro caminho: o app pede, e a `rota` decide o que vai dentro — um painel, uma prévia, um segundo
> documento. É a mesma janela do mesmo app, e continua sendo **um backend só**.
>
> `rota` é a única entrada vinda do app nessa superfície, e a janela leva o título e o ícone dele:
> esquema (`javascript:`, `data:`, `http:`), protocolo relativo, caminho absoluto e `..` são
> recusados, e o resto é concatenado à URL que o portal já resolveu. Servir conteúdo de fora ali
> seria o material de uma tela de login falsa — e é isso, e não "abrir janela", que continua não
> existindo. A galeria do template demonstra os dois casos lado a lado.

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

**B — o backend ainda subindo. ✅ Fechado pelo healthcheck assíncrono.** `startApp` mata e reinicia
o processo quando o hash do código muda; a primeira abertura depois de um reinstall pega o processo
antigo ou em reinício. Este texto dizia que o conserto era o healthcheck assíncrono e que o poll
síncrono "continua lá" — **não continua**: ele saiu, a janela abre coberta e sai da cobertura no
veredito, seja ele qual for. O que era mitigação do sintoma virou o caminho normal.

### `requiredPackages` — a metade que verifica · ✅ **CONCLUÍDO**

O campo no manifesto e a validação no publish são da
[Onda 3](03-toolkit.md#requiredpackages--o-app-declara-de-que-pacote-linux-ele-precisa). A
verificação é daqui, porque quem sabe o que existe num servidor é quem está nele:

1. **`vssh-app-install` recusa antes de copiar nada**, nomeando o que falta e a linha de `apt-get`
   que resolve. A recusa vem **antes do `installCommand`**, que roda como root e pode fazer
   qualquer coisa, e antes da cópia, que deixa o app visível no menu — recusar não é desfazer;
2. **o painel admin mostra o que falta por servidor**, inclusive para os apps **ainda não
   instalados** — que é quando *"este app roda aqui?"* vale mais. Para isso o índice do
   `vssh-repo` passou a declarar `requiredPackages`: campo acrescentado, nunca renomeado, e um
   Worker anterior a ele simplesmente não responde.

**A pergunta herdada do [registro de capabilities](#registro-de-capabilities) — recusar, avisar ou
instalar — foi respondida, e a resposta vale para os dois:** *recusar* onde a ação é irreversível
(o instalador), *avisar* onde ela é informativa (o painel), e **nunca instalar sozinho**. Instalar
seria disparar `apt-get` como root a partir de um campo de manifesto; isso é outra decisão, com
outra superfície, e não se toma de passagem. O escape existe e é explícito:
`--sem-checar-pacotes`, para quando quem opera sabe algo que o `dpkg` não sabe — um binário
compilado à mão, um pacote com outro nome. Verificação sem saída é verificação que alguém arranca.

> **Três respostas, não duas — e é a terceira que este item quase perdeu.** "Não está instalado" e
> "não consegui conferir" pedem ações opostas. Num servidor que não é Debian não há `dpkg-query`:
> se a ausência do oráculo virasse ausência dos pacotes, o instalador recusaria tudo e o painel
> pintaria de vermelho **todos** os apps de um servidor saudável. Ali o instalador avisa e segue, e
> o painel diz *"não conferido"* — que não é a mesma cor de *"ok"*.
>
> **E o `dpkg` tem mais de dois estados.** Um pacote removido sem purgar continua no banco, com
> `deinstall ok config-files` e saída zero: quem pergunta *"o dpkg conhece?"* em vez de *"está
> instalado?"* conta um binário que não existe mais. Só `install ok installed` passa — e essa
> lacuna foi achada **pela refutação**, quando o ataque que trocava a comparação exata por "houve
> alguma saída" continuou verde: o oráculo do teste só sabia dizer sim ou não.

### Limites de recurso — ✅ CONCLUÍDO

Não havia cgroup nem `systemd-run` por app. **Um treino desgovernado derrubava a sessão inteira do
usuário** — inclusive o shell, o gerenciador de arquivos e os outros apps.

Agora todo vssh-app sobe dentro de um escopo transitório (`systemd-run --user --scope`), com teto de
memória e de tarefas, declarável por app em `resources` no manifesto.

#### O pré-requisito NÃO estava pago, e essa era a parte perigosa

Este documento afirmava que a [Onda 2.7](02b-motores.md) tinha dado um grupo de processos a **todo**
vssh-app. **Estava errado, e a frase era verdadeira sobre metade.** Há dois caminhos automáticos de
subida, e só o do portal lançava com `setsid`:

| Caminho | Lançava com `setsid`? | Consequência |
|---|---|---|
| portal (`startApp`) | sim | `PGID == PID == run.pid`, e `_killAppTree` mata a árvore |
| **`vssh-app-supervisor`** (relançamento após queda) | **não** | o app herdava o grupo do supervisor |

E a falha não aparecia. A guarda de PGID do `_killAppTree` existe por um bom motivo — apps que já
estavam de pé quando o `setsid` subiu não têm a invariante — e ela faz exatamente o que deve: vendo
`PGID != PID`, desiste do sinal de grupo e manda para o PID. Ou seja, **o app relançado parava só o
processo declarado e deixava os filhos órfãos, em silêncio**. O caminho sem grupo era justamente o do
app que morreu e voltou, isto é, o desgovernado.

*Já existe* de novo: a formulação que esconde trabalho enquanto parece rigorosa. A afirmação tinha
arquivo e linha, e estava certa sobre o arquivo que citava.

#### Onde o limite é aplicado, e por que não em quem chama

No **`vssh-app-run`**. São três caminhos de subida — portal, supervisor e invocação à mão — e ele é
o único ponto por onde os três passam. Aplicar no chamador teria deixado de fora o do supervisor,
repetindo o erro do `setsid` no mesmo item que o conserta.

#### O padrão não é opcional

Um mecanismo só-por-declaração não conteria nada: **ninguém declara "vou comer toda a RAM"**. Então
há teto para quem não disser o contrário, e a escolha do que ganha padrão saiu do modo de falha:

| Recurso | Padrão | Por quê |
|---|---|---|
| `MemoryHigh` | 70%, **ou 90% do `memoryMax` declarado** | pressiona antes de matar — o primeiro sintoma de um teto apertado tem de ser lentidão, não um app morto sem explicação |
| `MemoryMax` | 85% | é o que **derruba**; o teto duro é o que impede o OOM killer de escolher a sessão no lugar |
| `TasksMax` | 25% | bomba de fork esgota PID, e aí a sessão inteira para de conseguir criar processo |
| `CPUQuota` | **nenhum** | CPU disputada deixa **lento**, não derruba, e o escalonador já reparte. Um teto padrão cobraria de todo app um preço por um sintoma que ninguém relatou |

`"none"` desliga um teto de propósito — um app que precisa da máquina inteira tem de poder dizer
isso, senão contorna o mecanismo por fora e aí ninguém sabe de nada.

> ### ⚠ Esta linha do `MemoryHigh` estava ERRADA, e o servidor real desmentiu
>
> Ela dizia "70%" e ponto. Num servidor de 77 GB rodando um app que declara
> `memoryMax: "512M"`, o resultado medido foi:
>
> ```
> memoryMax:  536870912   (512 MiB — o que o app pediu)
> memoryHigh: 58097594368 (54 GiB — 70% da máquina)
> ```
>
> **O teto de pressão ficou cem vezes ACIMA do teto duro.** A pressão nunca chega, e o app morre de
> OOM sem a fase de lentidão que esta mesma tabela prometia como *"o primeiro sintoma"*. A frase
> descrevia o oposto do que acontecia — e só no caso comum, que é o app escolher o próprio teto.
>
> Quando o autor declara o teto duro e cala sobre o de pressão, o padrão do ambiente perde o
> sentido: o que vale é a **relação** entre os dois. Agora o de pressão é derivado — 90% do que ele
> pediu —, preservando a intenção sem inventar um número. **Quem declara os dois é obedecido**: um
> ambiente que "corrige" o que o autor escreveu torna o manifesto uma sugestão.
>
> A resolução dos padrões saiu do bash para o mesmo bloco Python que lê o manifesto, porque derivar
> exige aritmética com sufixos (`512M`) e porcentagens que o shell não faz sem outro processo.

> **Isto contém UM app desgovernado, não a soma deles.** Dois apps no teto ainda somam mais que a
> máquina. É a diferença entre uma guarda e uma cota, e prometer a segunda seria mentira.

#### Contenção que falha degrada — não derruba

`systemd-run --user` precisa de um gerenciador systemd do usuário, e `loginctl enable-linger`
**falha em silêncio** em LXC sem nesting (o `infra/server/README.md` já documenta isso como
incidente conhecido). Então são três respostas, não duas:

- **contido** — com os valores aplicados;
- **não contido, com o motivo** — `systemd-run` ausente, sem barramento (*"loginctl
  enable-linger?"*), ou propriedades que este systemd recusou. O app **sobe assim mesmo**;
- **não sei** — `limits.json` ausente, que é o app que ainda não reiniciou desde a atualização.
  Pintar isso de "sem limite" seria alarme falso em massa, e a primeira coisa que alguém faria
  seria desligar o aviso. É o erro que o painel de pacotes já cometeu uma vez.

As propriedades são **ensaiadas** contra o systemd local (`systemd-run … true`) antes de se apostar
o start do app nelas. Sem o ensaio, um valor que este systemd não aceita transformaria *"app com
limite"* em *"app que não sobe"* — e **um erro que termina custa sempre mais que um erro que
aparece**. Configurações → Serviços mostra o estado, porque um app sem limite não é detalhe de
infraestrutura: é a sessão do usuário exposta, e só se conserta se alguém puder ver.

> A opção de usar unidades systemd para o **lifecycle** já foi avaliada e rejeitada em
> `vssh-sso/docs/refactor-backlog.md`. Isto é diferente: systemd só para **conter** recursos,
> mantendo o lifecycle onde está.

#### O que a refutação achou, e o que ela achou sobre si mesma

20 ataques, 20 repelidos — mas o achado maior foi no **instrumento**. A refutação do
[`requiredPackages`](#requiredpackages--a-metade-que-verifica---concluído) tinha reportado "20 de
20" sem verificar que a suíte estava **verde antes do ataque**. Não estava: no Windows, os
impostores (`dpkg-query`, `id`) eram escritos com o `mode` do `writeFileSync`, que não liga o bit de
execução que o Git Bash enxerga, e o diretório deles entrava no `PATH` em formato Windows numa lista
que o bash lê em POSIX. Os nove testes falhavam antes de medir qualquer coisa — e **um arquivo já
vermelho dá todo ataque por repelido**.

Consertados os dois (o `chmod` passa pelo bash; o `PATH` é prependido dentro dele), a suíte ficou
verde e os 20 ataques foram refeitos sobre uma linha de base de verdade. **Toda refutação daqui em
diante começa medindo o verde.** Um roteiro que só pergunta *"ficou vermelho?"* não distingue guarda
que segura de teste que já estava caído.

#### E o CI cobrou dois testes que mediam a PLATAFORMA

O caso *"sem systemd-run"* passava no Windows e falhou no runner — porque o `ubuntu-24.04` **tem**
`systemd-run`, e o `command -v` do script encontrava o real. O teste supunha o ambiente, e o
ambiente onde ele era escrito confirmava a suposição.

Não dá para simular a ausência: `systemd-run` mora em `/usr/bin` junto do `python3` de que o script
precisa, e esconder um esconde o outro. A resposta foi a mesma que `pacotes-do-app` já registrava
para o `dpkg-query` — **pular dizendo por quê**, em vez de passar por acidente.

Mas o buraco virou cobertura melhor: o ramo ***"systemd-run RECUSOU as propriedades"*** não era
medido por bancada nenhuma, e é o mais importante do item — é onde a decisão mora. Um `MemoryMax`
que aquele systemd não aceita não pode transformar *"app com limite"* em *"app que não sobe"*. Agora
há um impostor que recusa, e o caso roda **no CI** justamente por depender do socket que o Windows
não tem.

O teste de GPU tinha a mesma fragilidade em espelho — supunha que a máquina não tem `nvidia-smi`,
verdade no Windows e no runner, falso na primeira máquina com placa, que é onde o item importa.

> **A moral não é "escreva testes melhores".** É que **um teste verde na máquina de quem o escreveu
> não mediu nada além daquela máquina** — e as três camadas (Windows, CI Linux, servidor real)
> acharam defeitos *disjuntos*. Nenhuma delas era dispensável.

### GPU como conceito de runtime — ✅ CONCLUÍDO

GPU existia só no provisionamento. Não havia API de runtime, nem pedido por app, nem visibilidade
no portal — qualquer processo do usuário podia tomar a placa do app de inferência, e o sintoma era
lentidão, que ninguém liga a uma decisão de manifesto.

> **Uma frase desta seção envelheceu e foi corrigida.** Ela dizia que `vssh-provision.sh --gpu`
> "delega a config de Xorg ao `provision-base.sh --gpu`". O `provision-base.sh:72-74` já responde
> outra coisa desde a [Onda 2.7](02b-motores.md): *"a GPU continua útil sem X (CUDA), mas não há
> Xorg para configurar"*. Xorg é assunto do **motor**, não do ambiente — e é justamente por isso que
> GPU precisava virar conceito de **runtime**, e não continuar sendo um detalhe de quem monta X11.

São **duas coisas**, e a primeira versão as tinha misturado numa só — o que a tornou quase inútil.

#### A correção: descobrir e conter são perguntas diferentes

A primeira entrega só sabia perguntar ao `nvidia-smi` e só sabia **esconder**
(`CUDA_VISIBLE_DEVICES=""`). Duas consequências, e a segunda foi vista na galeria do template:

1. um servidor com **AMD**, com **Intel**, ou com GPU **virtual** (virtio, vmwgfx, bochs) era
   indistinguível de um servidor sem placa nenhuma;
2. `CUDA_VISIBLE_DEVICES=""` — o resultado de *"o ambiente escondeu"* — é **exatamente o mesmo**
   resultado de *"não há GPU aqui"*. A demonstração mostrava o padrão e não mostrava nada: *"ela
   testa a mesma coisa que não ter"*.

**A descoberta é genérica, e pergunta ao KERNEL.** `vssh-gpu-info` lê `/sys/class/drm` e `/dev/dri`
— que existem em qualquer Linux com DRM — e responde para qualquer fabricante, inclusive para placa
que não existe fisicamente:

| Pergunta | De onde vem | Por que não do SDK |
|---|---|---|
| quem é a placa | id de fabricante do PCI (`device/vendor`) | vem do barramento, não de um driver proprietário instalado |
| qual driver assumiu | `device/uevent` (`DRIVER=`), com o symlink `device/driver` de reserva | arquivo de texto é legível em qualquer lugar — e **mensurável numa bancada que não pode criar symlink** |
| é virtual? | **id do fabricante** (`0x1af4` virtio, `0x1234` QEMU, `0x15ad` VMware…), com o driver de segunda via | uma virtual serve para desenhar tela e não para computar; sem essa marca, "tem GPU e está lento" não tem explicação |
| **consigo abrir?** | `os.access` no render node | **é o modo de falha mais comum**, e não é ausência de placa: é o usuário fora do grupo `render`. Dizer "sem GPU" ali manda procurar driver quando o conserto é `usermod -aG render` |
| que pilhas existem | presença de `nvidia-smi`, `rocm-smi`, `vulkaninfo`, `clinfo`, `vainfo` | **presença, sem executar**: `vulkaninfo` num servidor sem driver custa segundos e às vezes trava |

> **O fabricante decide, e não o driver — e essa linha também foi corrigida pelo servidor real.**
> A primeira versão marcava virtual só pelo nome do driver. A virtio de teste reportou
> `DRIVER=virtio-pci` — o driver do **barramento**, não o do DRM —, que não estava na lista, e a
> placa virtual passou por física. O id do fabricante não erra: `0x1af4` é virtio venha o
> dispositivo pendurado onde vier. O driver ficou como segunda via, para o DRM virtual sob
> barramento comum (`vgem`, `vkms`, `simpledrm`).

`vssh-gpu-info` entrou no `infra/binaries.json` — **um mecanismo que não viaja é um mecanismo que
não existe**, e quem distribui os scripts de infra aos servidores é aquele manifesto. É a mesma
lição da tag `v2` do toolkit, num repositório diferente.

**O portão continua sendo só de CUDA**, e agora isso está dito em vez de implícito: é a única API com
uma variável padrão que o runtime respeita. Quem não declara `gpu: true` não enumera dispositivo
CUDA nenhum — a decisão simétrica à dos limites, *quem não pediu não pega*, que é o que deixa B3
(inferência) conviver com os vizinhos.

> **É arbitragem por convenção, não isolamento, e a diferença está no código, no schema e na tela.**
> A variável não fecha `/dev/dri`, e um processo determinado a ignorá-la alcança a placa. A
> fronteira de verdade seria controle de dispositivo no cgroup — eBPF no v2, só root, e o
> `vssh-app-run` roda como o usuário. Chamar isto de "isolamento" repetiria o `ready` que dizia
> pronto sem ter visto resposta.

**Quatro estados, não três.** *negada* (não pediu — quase todo app, e não se escreve nada, senão a
seção vira uma coluna de ruído), *concedida* (com o resumo: "AMD (amdgpu)", "virtio (virtio_gpu,
virtual)"), *pediu e este servidor não entrega* (**com o motivo** — falta placa, ou falta permissão,
que pedem ações opostas), e ***não sei*** — o servidor cuja consulta não deu para fazer. A quarta
não é a terceira: um servidor que não soube responder não é um servidor sem placa.

#### E um benchmark, porque inventário não diz se a placa serve

Descobrir não basta. `/api/gpu/benchmark` na galeria codifica o **mesmo vídeo duas vezes** — CPU
(`libx264`) e GPU (`VAAPI`, que atravessa Intel, AMD e NVIDIA pelo mesmo render node do DRM) — e o
número que vale é a **razão**: *"180 fps"* sozinho não diz nada; *"2,4× a CPU deste servidor"* diz.

Três decisões, e a última é a que importa:

- **VAAPI e não CUDA**, porque um benchmark de CUDA só roda onde já havia resposta;
- **`ffmpeg` é declarado em `requiredPackages`** pelo template — então o instalador já recusa o
  servidor onde a peça não funcionaria, e as três metades da onda se encontram numa peça só;
- **um lado que falha não vira número.** Calcular a razão com um lado ausente daria algo com cara de
  medição; `null` e o motivo são melhores que um número inventado.

A resposta mais útil que ele dá é a desagradável, e ela já veio: **a GPU do servidor de teste não
codifica vídeo.** É uma virtio, `vaInitialize` devolve `2 (resource allocation failed)`, e **nenhum
pacote resolve** — ela existe para desenhar tela, não para computar. Custou dois cliques; depois de
projetar inferência em cima, custaria a onda.

**A falha é CLASSIFICADA, porque as causas pedem ações opostas** — ffmpeg sem VAAPI, permissão, sem
motor de vídeo, driver ausente —, e o que não se reconhece devolve `null`: diagnóstico errado custa
mais que nenhum. E o diagnóstico recebe **o dispositivo**, não só o texto do erro: a mesma saída
produz *"nenhum pacote resolve, troque de servidor"* numa placa virtual e *"instale o driver"* numa
física. A primeira versão hesitava (*"se ela for física"*) tendo a resposta a uma função de
distância — o mesmo defeito de duas informações que não se encontram.

O template declara `gpu: true`, e essa decisão **mudou** depois do teste-drive: a primeira versão não
declarava, para demonstrar o padrão (quem não pede não vê). Só que o padrão se demonstra com uma
variável vazia — indistinguível de "não há placa" — enquanto o benchmark precisa da placa para
rodar. Uma galeria existe para ser exercitada; preferir a demonstração conceitual à utilizável era
preferir a explicação ao experimento.

> **Uma frase desta seção foi corrigida no lugar duas vezes.** Primeiro a de que `--gpu` "delega a
> config de Xorg", que envelheceu na 2.7. Depois a premissa inteira do item — "GPU é CUDA" —, que
> não envelheceu: **nasceu errada**, e quem a derrubou foi o teste-drive da galeria, com o
> argumento exato de que a demonstração *"testa a mesma coisa que não ter"*. Estava certo: o padrão
> escondia a placa, e o resultado de esconder é idêntico ao de não existir.

### Cofre de segredos — ✅ CONCLUÍDO

Um app que fala com banco, com S3 ou com uma API externa não tinha onde guardar credencial. Cada app
inventava o seu — normalmente um arquivo em texto plano no `VSSH_APP_DATA_DIR`.

O app **declara** (`secrets: [{name, description, required}]`), o usuário **guarda** (Configurações
→ Segredos), e o valor chega como variável de ambiente comum.

#### O portal não guarda o segredo

Ele escreve `~/.vssh-apps/<id>/secrets.json` (modo 0600) no servidor do próprio usuário e esquece.
Três razões, e a terceira decide:

1. é a estrela-guia — o segredo viaja com o **ambiente**, não com a máquina de onde se acessa;
2. o modelo de confiança já é *"roda como o usuário Linux dono da sessão"*: a credencial não fica
   menos protegida no home dele do que fica o resto do trabalho dele;
3. **o portal não vira o lugar onde estão as credenciais de todo mundo.** A medição confirmou que
   hoje ele não guarda segredo de longa vida nenhum — a chave privada só existe num *setup token*,
   com `expires_at` e `used_at`. Criar a primeira coluna de segredo permanente seria uma decisão de
   segurança grande escondida dentro de uma conveniência pequena.

#### Três coisas que a medição decidiu, e que não eram óbvias

- **Arquivo à parte do `env`, e essa é a razão de o item existir num arquivo só dele.** O `startApp`
  reescreve o `env` com `printf … > "$d/env"` a cada subida. Um segredo ali seria apagado na
  próxima vez que o usuário abrisse o app — sem erro e sem log, com a falha aparecendo depois como
  "credencial inválida" numa hora sem relação com quem a apagou.
- **JSON, e não um arquivo de shell.** A forma óbvia (`NOME='valor'` + `source`) quebra no primeiro
  segredo de verdade: uma chave privada tem quebras de linha e uma senha tem aspa mais vezes do que
  se supõe. Guardando JSON, quem gera o shell é o `shlex.quote` do Python, na mesma máquina.
- **O valor nunca vai por linha de comando.** Linha de comando aparece em `ps` para qualquer
  processo do mesmo usuário, e costuma parar no log do servidor SSH. Vai por stdin. Pelo mesmo
  motivo ele não passa pelo canal `_envDoPortal`: aquele é uma format string de `printf` com
  alfabeto de preferência (`^[A-Za-z0-9_.:,+-]{1,64}$`), onde um segredo em base64 nem caberia.

O cofre **não tem porta de leitura**: a rota devolve nomes, a tela mostra nomes, e o campo de
entrada é de senha. Ninguém precisa reler um segredo, e uma porta a menos é uma porta a menos.

#### Quem PEDE é o app — a primeira versão pôs o pedido no lugar errado

A tela de Configurações era o lugar de guardar, e isso estava errado: obrigava a pessoa a sair do
app, achar a seção e **adivinhar o nome da variável** que aquele app espera. O pedido ficava longe
do motivo.

Quem sabe que falta credencial — e sabe **na hora exata**, no clique de "conectar" — é o app. Ele
pede por `vssh.secrets.set(nome, {description})`; o **shell** mostra o campo de senha e escreve. O
app não manda o valor e não o recebe de volta: o que retorna é a lista de nomes, `cancelado: true`
quando a pessoa desistiu (desistir é resposta, não erro) e `requerReinicio: true` — porque o
ambiente de um processo é fixado no start, e sem esse aviso a frase seguinte seria *"guardei e não
funcionou"*.

O que sobra em Configurações é o que só um inventário responde, e por isso a seção se chama
**Cofre**: o que já está guardado, em que app, e o que falta. **Ela não tem "Guardar"** — só quem já
está guardado ganha botão, e os dois são manutenção (trocar uma chave vencida, apagar). Ninguém abre
um app só para substituir uma credencial; mas um "Guardar" ali convidaria de novo a preencher uma
variável cujo significado só o app conhece.

#### Dois defeitos que a instalação achou, e um deles não era do cofre

**O caminho podia terminar em `/root`.** O script usava `expanduser("~")`, e sob `sudo -u <user>` o
`$HOME` que chega depende do sudoers (`always_set_home`, `env_keep`). Num servidor que não o
reescreva, o cofre era gravado **com sucesso** em `/root/.vssh-apps/…` e ficava invisível para o app,
que lê a home de verdade. A home agora vem de `pwd.getpwuid(os.getuid())`, que não depende de
ambiente nenhum.

**E o que pareceu defeito do cofre era do relato.** Guardar o segredo, reabrir a janela, e a peça
dizer que não havia nada. Reabrir a janela **não reinicia o processo** — a janela é uma view, o
backend continua o mesmo —, e o ambiente de um processo é fixado no `exec`. Olhando só
`process.env`, *"nunca guardado"* e *"guardado depois deste processo subir"* davam a **mesma
resposta** — e a segunda é a única em que a pessoa fez tudo certo, o que a torna a mais cara: ela
conclui que o mecanismo não funciona.

São três estados, então, e o do meio é o que responde *"por que não funcionou?"*. A galeria passou a
ler também as **chaves** do `secrets.json` — só as chaves; o valor já chega pelo ambiente, e relê-lo
ensinaria o hábito errado a quem copia o template.

#### O que a refutação mudou no desenho

Um ataque continuou verde e **não era guarda fraca — era guarda infalseável**. O aviso de "cofre
ilegível" era emitido como shell (um `echo` gerado pelo Python) e passava por um `eval`; a defesa
era escapar as aspas da mensagem de erro. Não havia como construir o ataque: as mensagens do
`JSONDecodeError` não contêm aspa dupla. Ou seja, a defesa protegia contra um caso que ninguém sabia
produzir enquanto o risco estrutural continuava lá.

A resposta não foi escapar melhor: foi **a mensagem parar de ser código**. O aviso agora sai por
stderr, e o stdout avaliado carrega só linhas `export`. **Texto que nunca vira código não precisa
ser escapado** — e a guarda virou estrutural e mensurável, em vez de um escape sobre um caso
hipotético.

---

### O que só apareceu quando a onda foi INSTALADA

Os três itens fecharam com suíte verde, refutação 20/20 e bancadas rodando os scripts de verdade.
Aí a galeria foi instalada num servidor, e **cinco defeitos apareceram em três rodadas** — nenhum
deles alcançável por bancada nenhuma daqui.

| O que a bancada não podia ver | Por que |
|---|---|
| `MemoryHigh` 100× acima do `MemoryMax` | precisava de uma máquina com RAM de verdade para o `70%` virar 54 GB ao lado de um `512M` |
| GPU virtual dada como física | a virtio reporta `DRIVER=virtio-pci` — o driver do **barramento**. Nenhuma árvore de mentira minha tinha imaginado isso |
| cofre possivelmente indo para `/root` | `expanduser("~")` sob `sudo -u` depende do sudoers do servidor |
| o erro do benchmark não dizia nada | `stdio: 'ignore'` descartava o stderr — e só um ffmpeg de verdade falhando mostrou que sobrava a linha de comando |
| o diagnóstico hesitava com a resposta em mãos | *"instale o driver, se ela for física"* — numa placa que a descoberta já sabia ser virtual |

**A regra da roadmap tinha duas etapas e agora tem três.** *Conferir contra o código* achou premissas
erradas; *tentar refutar* achou guardas fracas; **instalar e usar** achou o que as duas anteriores não
tinham como achar — porque os cinco defeitos são sobre o mundo, não sobre o código.

E os cinco têm a mesma assinatura: **duas informações que existiam e não se encontravam.** O padrão
do ambiente não conhecia o teto do app. A lista de drivers virtuais não conhecia o id do fabricante.
O diagnóstico da falha não conhecia a descoberta. Não é falta de dado — é dado que não atravessa a
fronteira entre duas funções.

> **A resposta mais valiosa da onda inteira foi um "não".** O benchmark disse que a GPU daquele
> servidor não codifica vídeo, que é virtual, e que **nenhum pacote resolve**. Custou dois cliques.
> Descobrir isso depois de projetar inferência em cima teria custado a onda.

## Onda 5 — Composição do ecossistema

Hoje o ecossistema **não compõe**: cada consumidor de motor fica acoplado a um produtor específico.

### O contrato do manifesto: um schema, uma validação, uma guarda

> **Feito**, nos dois repositórios. No toolkit: a raiz, `backend` e `window` deixaram de aceitar
> campo desconhecido, e o erro passou a nomear o vizinho — 6 testes, **8/8 refutações**, suíte em
> 264. No `vssh-sso`: o schema vendorizado e a **guarda de junção** sobre os cinco consumidores — 4
> testes, **8/8 refutações**, suíte em 697. O que continua aberto é `provides` e `minShellVersion`.

Vem primeiro porque **três ondas escrevem no mesmo arquivo** e nenhuma era dona dele:

| Onda | Campos |
|---|---|
| [3](03-toolkit.md) | `requiredPackages` |
| [4](#requiredpackages--a-metade-que-verifica---concluído) | limites de recurso, `gpu: true` |
| 5 (aqui) | `provides: [...]`, `minShellVersion` / `targetShellVersion`, a seção de Configurações |

Todos precisam das mesmas três coisas: entrada no `schema/vssh-app.schema.json`, validação no
`vssh-app-publish`, e um consumidor no portal. Feito uma vez, paga pelas três; feito três vezes,
são três noções do mesmo contrato livres para divergir.

~~**E o schema hoje não segura nada:** ele é `"additionalProperties": true` na raiz — campo novo não
quebra nada, e **campo com erro de digitação também não**.~~

### O que a medição achou — e as duas frases acima estavam erradas

**"Não segura nada" era falso, e a forma do buraco importa mais que o tamanho.** Rodando o
validador de verdade contra manifestos com typo, ele **recusava 5 dos 8 lugares**: todo objeto que
já declarava `additionalProperties: false` — `resources`, `engine`, `opens`, `secrets[]` — mais os
enums. Passavam limpo exatamente os três que declaravam `true`:

| Onde | Typo | Antes | Agora |
|---|---|---|---|
| **raiz** | `requiredPackage` (sem o `s`) | publica, e o app instala **sem verificar pacote nenhum** | recusa |
| **raiz** | `gpuu`, `opns`, `secret` | publica, campo descartado em silêncio | recusa |
| **`backend`** | `healthcheckPat` | publica, o poll cai no `/` padrão | recusa |
| **`window`** | `widht: 900` | publica, e a janela abre no tamanho padrão | recusa |

O `window` é o mais barato de errar e o mais caro de perceber: o portal repassa o objeto **inteiro**
ao cliente (`window: m.window || {}`), o cliente lê quatro chaves, e a quinta viaja o caminho todo
para não ser lida por ninguém — sem uma linha de log em lugar nenhum.

**E "todo campo que o portal lê está no schema" não era a guarda que faltava: hoje isso já é
verdade.** A varredura dos cinco consumidores — a projeção de `/api/apps`, o `provisioning`, o
`vssh-app-install`, o `vssh-app-run` e o `vssh-app-supervisor` — não achou **um** campo lido que o
schema não declare. A frase descrevia um risco, não um defeito. O que sobra dela é anti-apodrecimento,
e **ela não cabe em repositório nenhum sozinha** — ver "A guarda de junção", abaixo.

> **Um manifesto escrito para um toolkit mais NOVO passa a ser recusado por um mais velho, e isso é
> o comportamento desejado.** *"Este toolkit não conhece este campo"* é a informação; a alternativa
> é publicar um app cujo campo ninguém vai ler. Custo medido: **zero** — os cinco manifestos reais
> (dois templates, `logseq`, `scramjet-wisp`, `xpra`) continuam publicando sem alteração.

**O erro passou a nomear o vizinho.** *"campo desconhecido: requiredPackage"* está correto e não
ajuda: quem publica olha para o manifesto, vê o campo escrito lá, e conclui que o schema é que está
velho. Agora sai *"(você quis dizer requiredPackages?)"* — e a distância é **Damerau**, não
Levenshtein, por um caso concreto: `widht` por `width` é o typo mais comum que existe, e a distância
simples o cobra como dois erros, deixando justamente o mais provável sem sugestão. Quando nada está
perto, a mensagem continua sendo só o nome reprovado: sugestão errada é pior que nenhuma.

**A rede que importa mais que os quatro casos:** *todo objeto do schema fecha a porta*. Fechar as
três de hoje não impede a quarta de nascer aberta — e ela nasceria exatamente onde ninguém procura.

### A guarda de junção — ✅ **feita, pela saída A**

*"Todo campo que um consumidor lê está no schema"* atravessa dois repositórios que **não se
conhecem**: o `vssh-sso` não dependia do toolkit, e não havia uma linha ligando os dois. É a mesma
forma dos defeitos que a 2c achou três vezes — os dois lados certos sozinhos, e ninguém dono do meio.

Três saídas foram pesadas, e a escolha valia mais que este item: `provides` e a seção de
Configurações declarada por manifesto têm **exatamente a mesma forma**.

| | Como | Por que não |
|---|---|---|
| **B** | o portal **deriva** a projeção do `/api/apps` do schema, em vez de listar campo a campo | acaba com a divergência em vez de detectá-la — é melhor, e mexe numa rota quente por um defeito que hoje não existe. Fica anotado para quando houver motivo |
| **C** | o schema declara, por campo, quem consome | não mede o consumidor de verdade: vira documentação com cara de teste |

**A escolhida foi a A** — vendorizar, no idioma do `vssh-app-lib-sync`: `vssh-sso/schema/` com a
procedência em `.vssh-schema-version`, e `tests/unit/contrato-do-manifesto.test.js` medindo os
**cinco** consumidores (a projeção do `/api/apps`, o provisionador, e os três scripts de
`infra/server/`, que são Python). 42 leituras extraídas, **zero fora do schema** — confirmando que
esta guarda nasce anti-apodrecimento, e não como conserto.

> **A cópia velha é o alarme, não o defeito** — e é o que torna a A barata. O toolkit ganhar um
> campo que ninguém aqui lê **não** dispara nada, e está certo: não há consumidor a proteger. Passar
> a ler esse campo com a cópia velha fica **vermelho dizendo o nome do campo**, e o conserto é
> ressincronizar. O caso perigoso — ler um campo que o schema nunca teve — é o mesmo vermelho, e
> nenhuma cópia velha o esconde: o que se mede é o nome, não a versão.

**O que ela NÃO garante, e está escrito no arquivo:** que o campo está no lugar certo da árvore.
`entrypoint` lido da raiz passaria, porque o nome existe dentro de `backend`. O defeito que ela
persegue é o outro, e é o que acontece de verdade — o campo novo que nasceu só de um lado.

> **Duas armadilhas na construção, e a segunda quase passou.** A limpeza de comentário usava
> `/\*[\s\S]*?\*\/` e **comeu 14 KB de código de verdade** — um `/*` dentro de uma string faz o
> casamento não-guloso começar no lugar errado e correr até o próximo `*/`. A extração passou a
> devolver **um** campo onde havia quatro, e teria ficado verde medindo quase nada. Virou limpeza
> ancorada em linha, onde o pior caso é local.
>
> E é por isso que cada consumidor tem um **piso** de campos. Uma regex falha devolvendo vazio —
> verde, silencioso, medindo nada. A refutação prova isso de frente: com a extração zerada **e o
> piso removido**, o arquivo inteiro passa verde. Com o piso, fica vermelho. **8/8 refutações.**

O `engine.loader`, que a [2.7](02b-motores.md) pôs em produção, **está bem declarado** — `engine` é
um dos objetos que já fechava a porta. A frase anterior dizia que ele *"só está declarado porque
alguém lembrou"*, e isso descrevia a ausência da guarda de junção, não uma fragilidade do campo.

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

~~Primeiro consumidor real sugerido: o **engine de impressão** (`print/v1`)~~ — **e o primeiro
consumidor real acabou sendo outro, que já existia.** O `print/v1` veio logo depois e **está
entregue**: `examples/print-engine` no toolkit, o diálogo de impressão resolvendo por capacidade, e
`tests/unit/print-v1.test.js` medindo a junção entre os dois repositórios. Ele destravou o item que
estava vermelho na Onda 2 desde o começo. Mas a medição tinha achado antes um consumidor **vivo
hoje**, com exatamente o acoplamento que o campo existe para desfazer:

```js
vssh-client/js/browser/ScramjetEngine.js:16
const ENGINE_APP_ID = 'scramjet-wisp'; // appId do vssh-app companion
```

Isso é melhor do que nascer com um consumidor que ainda não existe: o mecanismo estreou contra um
caso que já estava em produção, em quatro pontos de chamada.

### ✅ Como ficou

`AppLauncher` ganhou `appsComCapacidade` / `appComCapacidade` / `appPorId`, com as três decisões
herdadas do `RemoteDesktopEngines` — não filtra por *"o backend está de pé"*, não filtra por `type`,
e **declarar não é provar**. O desempate entre dois produtores é a ordem de `/api/apps`, que é
alfabética porque nasce de um `ls`: está dito que é arbitrário, e que no dia em que dois
concorrerem de verdade o desempate é **preferência do usuário**, no mesmo lugar onde `fileHandlers`
já mora. Desenhar essa tela antes desse dia seria adivinhar.

> **Duas identidades foram separadas antes de divergirem, e essa é a parte que quase passou.** O
> `'scramjet-wisp'` aparecia como *duas* coisas no mesmo arquivo: o id do **motor** no
> `BrowserEngines` — que é a chave da preferência `browserEngine` **gravada** de cada usuário — e o
> **appId** do backend. Tornar as duas dinâmicas de uma vez jogaria fora, em silêncio, a escolha de
> quem já escolheu. `ENGINE_ID` continua literal, o app é resolvido, e há teste que cai se alguém
> recolar as duas. Hoje as strings são iguais — que é exatamente por que separá-las agora é barato.

E o recuo para o nome antigo **fica, com prazo escrito**: publicar o manifesto do app e deployar o
portal são dois deploys, e sem recuo existe uma janela em que o navegador embutido não sobe. Ele
morre quando o `provides` estiver em todo servidor, e não antes.

**De quebra, o `available()` do motor parou de fazer o próprio `fetch('/api/apps')`** — era a mesma
pergunta sem o cache de 30 s do registro, e portanto uma segunda resposta possível para *"que apps
existem"*.

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

#### 🔵 O que sobrou depois de medir: nada para construir, e uma decisão para tomar

A revisão de 2026-08-08 conferiu o que **falta de fato**, e o resto do item já estava entregue por
outras ondas:

| A pergunta | Quem já responde |
|---|---|
| Seção com estado ao vivo, ações, sub-páginas, repintura por evento? | `SettingsRegistry` (Onda 2.6) — e a janela **não cita nenhuma seção pelo nome**, o que é asserção de teste |
| Um app trazer a própria seção sem o shell conhecê-lo? | `engine.loader` (Onda 2.7) — o app entrega o script, o shell carrega. É como o `xpra` e o `scramjet-wisp` já fazem |

**Ou seja: para app instalado por administrador — que é todo app que existe hoje — o item está
resolvido, por (3).** O que resta é exatamente a fronteira que o parágrafo acima nomeia, e ela não
é falta de mecanismo: é a **decisão de confiança**.

E ela não se decide sozinha, porque é a mesma pergunta da questão em aberto *"isolamento de apps"*
([diagnostico](diagnostico.md#15-questões-em-aberto)) e do limite da mensageria, logo abaixo. Os
três são o mesmo fato — **uma origem só, e um gate só: quem pode rodar `vssh-app-install`.** Um
formato declarativo para seção de terceiro construído antes dessa decisão nasceria com a pergunta
errada respondida: *como* declarar, quando o que falta é saber *se* terceiro entra.

> **Por que não construir a variante declarativa "por segurança".** Ela seria a quarta forma de
> declarar uma seção de Configurações — depois do `SettingsRegistry`, do `engine.loader` e do
> código do próprio shell —, servindo **zero** apps. É o que a Onda 2.1 chamou de botão de volume
> morto, na escala de um contrato público: uma vez publicado, ele não se reescreve numa tarde.

### Ponto de extensão no `FileOpener` — 🔵 **desenhado; falta um produtor, e é isso que falta**

~~`vssh-client/js/FileOpener.js` é um **mapa fixo** de extensão → ação.~~ **Meia frase errada.** Ele
já **não** é fixo para a pergunta *"quem abre este arquivo?"*: a primeira coisa que `open()` faz é
consultar `AppLauncher.defaultAppForFile(path)`, alimentado pelo campo `opens` do manifesto e pela
preferência do usuário. Um vssh-app se registra para uma extensão **desde a Onda 2.6**.

O que continua verdadeiro é a outra metade, e é a que o arquétipo **B4** pede: não há como um app
contribuir **miniatura, preview ou render** — coisas que não abrem uma janela, e sim entregam um
pedaço de imagem ou de HTML para uma janela que já existe.

**E o mecanismo que faltava chegou nesta onda.** Com `provides`, a forma disto deixa de ser
pergunta em aberto:

```jsonc
{ "provides": ["thumbnail/v1"], "opens": { "mimeTypes": ["application/pdf"] } }
```

— e `FileOpener`/`FileBrowserWindow` perguntam `appComCapacidade('thumbnail/v1')`, cruzando com
`opens` para saber se aquele produtor serve *aquele* arquivo.

> **Não está construído, e o motivo é o critério desta própria onda.** Não existe um produtor: nem
> engine de thumbnail, nem de OCR, nem transcodificador — nenhum instalado, nenhum em construção.
> Construir o ponto de extensão agora é escrever o contrato de um lado só, e a Onda 5 já diz, na
> seção de capabilities, que o primeiro consumidor tem de ser **caso concreto em vez de abstração
> especulativa**. O que muda em relação a antes é que **a decisão de desenho não é mais o
> bloqueio** — o bloqueio é ter o que plugar, e no dia em que houver, isto é um dia de trabalho.

### Mensageria entre apps — ✅ **medida, escrita e cercada**

`BroadcastChannel` resolve hoje, e custa quase nada — porque tudo é same-origin.

**Isso foi conferido, e não é só verdade: é frágil de um jeito específico.** O `BroadcastChannel`
não tem **uma** ocorrência em `vssh-client/` — o que funciona é o primitivo do navegador, e o que o
sustenta são duas decisões nossas, em lugares que não se parecem com mensageria:

- o backend do app é servido por **caminho relativo** na origem do portal
  (`/<serverId>/proxy/app/<id>/`), e não por subdomínio;
- o iframe da janela do app **não tem `sandbox`**, então não recebe origem opaca.

> **A garantia se perde por um atributo.** Um `sandbox="allow-scripts"` no iframe — o reflexo
> correto em quase todo outro contexto — dá ao app uma origem opaca. Aí
> `new BroadcastChannel('x')` continua funcionando, num universo separado, e a mensagem
> simplesmente não chega. **Sem erro em lugar nenhum.** É a família da colisão do `/ping` da 2c:
> os dois lados certos sozinhos, e o defeito só existindo na junção.

Então não havia o que construir, e havia três coisas a fazer: **escrever a garantia** (no
`docs/api.md` do toolkit, para quem constrói um app, e no `desktop-shell.md`, para quem mantém o
shell), **cercá-la** (`tests/unit/mensageria-entre-apps.test.js`, 3/3 refutações) e **registrar o
acoplamento com o limite junto**.

> **O limite é a metade que importa, e ele não é técnico.** É o mesmo fato que torna o isolamento
> fraco ([diagnostico](diagnostico.md#15-questões-em-aberto)): **outro app da mesma sessão escuta
> os seus canais.** O `docs/api.md` diz isso com essas palavras — *não mande por
> `BroadcastChannel` o que você não mandaria por um mural*. Se um dia houver origem separada por
> app, isto para de funcionar e a mensageria passa a atravessar o shell; o teste é onde essa troca
> fica visível, porque quem separar as origens vai vê-lo cair.
