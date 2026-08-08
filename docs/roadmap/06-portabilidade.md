# Onda 7 — Continuidade entre máquinas

> **Estado:** parcialmente entregue pelo caminho · **Atualizado:** 2026-08-08 · **Repos:** `vssh-sso` + toolkit

A estrela-guia diz que o pesquisador pula de um computador para outro e não perde nada. Isso era
**critério** ([3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)) e não era **entrega** em
lugar nenhum. Esta onda conserta.

> ### ⚠ Revisão de 08-08: dois dos quatro itens já estão feitos
>
> O texto original é de 2026-08-01. A revisão conferiu cada item contra o código — e a conclusão é
> que **esta onda encolheu sozinha**, porque o critério 3.2 foi aplicado item a item nas ondas 2 a 5
> em vez de esperar por aqui. É o resultado que se quer de um critério: ele não vira uma onda, vira
> um hábito.
>
> | Item | Era | É |
> |---|---|---|
> | 1 · Grants e handles migram | pendente | **pendente** — e o destino ficou pronto |
> | 2 · Sessão que segue o pesquisador | decisão em aberto | **decisão em aberto** — e a peça que faltava já existe, sem nome |
> | 3 · Regra "OPFS é cache" | pendente | ✅ **feito** — saiu com a Onda 3 |
> | 4 · Artefatos nascem no ambiente | varredura pendente | ✅ **em grande parte feito** — e um dos exemplos não existia |

## 1. Grants e handles migram para o servidor

Hoje: grants em `localStorage` (`AppGrants.js`), handles do polyfill FSA em `IndexedDB`. Trocou de
máquina, o app não reabre a pasta de trabalho e as permissões somem.

**Conferido em 08-08: continua exatamente assim.** `AppGrants` lê e grava `localStorage`, com a
chave incluindo o `serverId`, e o próprio arquivo justifica a escolha por escrito — *"é o mesmo
domínio de vida do que o app guardou"*. Essa justificativa é o que esta onda derruba: o domínio de
vida certo é o do usuário, não o do navegador.

Isso ficou **barato** depois que o critério 3.2 estabeleceu que o grant de caminho remoto é
preferência, não segurança — o backend do app já roda como o usuário Linux com acesso POSIX a tudo
que o grant protegeria. Não há invariante de segurança a preservar na migração.

- `AppGrants` deixa de ser `localStorage` e passa a `/api/user/settings` (ou store equivalente),
  chaveado por usuário;
- o `fsa-polyfill` passa a reidratar de estado do servidor, com o `IndexedDB` como **cache**;
- os dois migram **juntos** — um handle sem grant é handle morto, e um grant sem handle é órfão.

> **O destino ficou pronto no caminho, e ficou mais pronto do que esta nota dizia.** Quando isto foi
> escrito, `/api/user/settings` era um store frouxo — quatro chaves gravavam e o servidor as
> descartava em silêncio por não estarem em `ALLOWED_KEYS`. A
> [Onda 2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito) fechou isso: toda
> chave passa por `ALLOWED_KEYS` + `SANITIZE`, e `VsshSettings` dá `get`/`set`/`subscribe`/`hydrate`
> com semeadura do `localStorage`.
>
> Três coisas que esta migração precisa e agora não precisa desenhar:
>
> - **o mapa ABERTO já existe, e não é mais o `fileHandlers`.** A nota original apontava
>   `plainObject`/`fileHandlers` como a forma de um mapa `caminho → grant`. Serve, mas a chave certa
>   nasceu depois: **`appSettings`** foi criada exatamente para o problema que um mapa de grants
>   tem — chave aberta (o id do app), valor apertado (teto de itens, teto de tamanho, primitivos ou
>   lista curta). Ela nasceu de uma pergunta que derrubou o desenho anterior: *"isso não faz com que
>   para cada app do mundo eu tenha que acrescentar `ALLOWED_KEYS`?"*. Fazia. Um mapa
>   `appId → [caminhos]` é literalmente a mesma forma e **não precisa de commit no portal a cada app
>   publicado**;
> - **`set('a.b', v)` manda o campo de topo INTEIRO**, de propósito, porque o merge do `PUT` é raso
>   e gravar uma folha apagava as irmãs. Um mapa de grants gravado folha a folha cairia exatamente
>   nesse buraco — e ele já está tapado;
> - **`userPrinters` é o precedente completo, ponta a ponta.** Lista de objetos, com teto de 16,
>   validada por um **módulo folha** (`utils/uri-de-impressora.ts`) para poder ser exercitada sem
>   arrastar SSH e Redis, com a tela dizendo o limite em vez de deixar o servidor descartar em
>   silêncio. É o critério 3.2 entregue uma vez inteira — *"só você vê estas, e elas acompanham você
>   para outra máquina"* está escrito na tela. Copiar essa forma é o item 1 quase todo.

**Não migra:** permissão da FSA **nativa**, que é do navegador e per-máquina por natureza. São dois
regimes na mesma API, e a documentação precisa nomear qual é qual.

> **E há um terceiro regime agora, que o texto original não podia conhecer.** A Onda 3 fez
> `queryPermission()` responder de verdade e `requestPermission()` reabrir o seletor **a partir de
> um gesto do usuário**. Um grant que veio do servidor mas cujo handle ainda não foi reidratado
> nesta máquina não é `granted` nem `denied` — é *"tenho a permissão e ainda não tenho o handle"*.
> São três respostas, e colapsar a terceira nas outras duas dá um app que ou pede permissão que já
> tem, ou tenta ler de um handle morto.

## 2. Sessão que segue o pesquisador

Estado de janela **já** está no servidor, em lock files (`~/.vssh/psd/*.lock`) — este é o pedaço que
já está do lado certo. O que falta é **reconciliação**.

`WindowStateManager.restoreAll()` roda **uma vez por carga de página**, e **duas máquinas simultâneas
hoje disputam os mesmos lock files**: as duas restauram o mesmo conjunto de janelas e as duas
escrevem por cima uma da outra.

**Isto é design, não implementação, e é pré-requisito de tudo o mais nesta onda.** As opções:

| Modelo | Comportamento |
|---|---|
| **Handoff** | a segunda máquina assume; a primeira é notificada e solta (a sessão "se muda") |
| **Espelho** | as duas veem o mesmo conjunto, com sincronização contínua (caro, e conflitos de foco/geometria) |
| **Escopos separados** | cada máquina tem seu conjunto de janelas, com o estado de app compartilhado |

O handoff é o que mais se parece com "levantar da mesa e sentar em outra", que é a metáfora da
estrela-guia. Mas a decisão não está tomada — e continua não estando depois da revisão, porque ela é
de produto e não de código.

### ⚠ A sessão da Onda 1 existe — e NÃO responde a pergunta desta onda

Uma versão anterior dizia que isto "fica melhor depois da Onda 1, que é onde nasce um conceito de
sessão com dono — sem ele não há a quem perguntar *quem está com esta sessão agora?*". A Onda 1 está
concluída, e a resposta que ela dá não é a que o handoff precisa:

A sessão é chaveada por **`(servidor, usuário Linux)`**. Duas máquinas do mesmo pesquisador abrem
dois `/ws/events` que **incrementam o refcount da MESMA sessão** — de propósito, porque o que a
sessão protege (supervisor de apps, watchers de fs) é por usuário, não por máquina.

**Conferido em 08-08, e a forma é ainda mais explícita do que o texto dizia:** `_refs` é um
`Map<string, number>`. Um número. Não há nada ali que distinga uma conexão de outra.

### ⚠ Mas a identidade por conexão não precisa ser inventada — ela já existe sem nome

Esta é a correção que mais muda o tamanho do item. O texto original tratava "identidade por conexão"
como algo a construir. **Os sockets já são objetos distintos e já estão num registro:**
`ws/events.ts` mantém `activeEventConnections: Set<AliveWebSocket>`, e `broadcastMigrate()` já
percorre esse conjunto falando com cada cliente um a um, no shutdown.

Ou seja: o portal **já sabe** quantos clientes existem e **já sabe falar com um de cada vez**. O que
falta são duas coisas pequenas, e nenhuma delas é um mecanismo novo:

1. **dar nome ao socket** — um id por conexão, gerado no upgrade;
2. **cruzar o Set com a chave de sessão** — hoje ele é global, não por `(servidor, usuário)`.

Com as duas, "quem está com esta sessão agora?" tem resposta, e o handoff é uma mensagem no canal
que já existe e que já é usada para exatamente esse gênero de aviso.

Isso não é dívida da Onda 1, que acertou ao não distinguir: derrubar recurso por máquina quebraria a
segunda aba do mesmo usuário. O refcount continua certo para o que ele protege. O que esta onda
acrescenta é uma camada **acima** dele — e ela é mais fina do que parecia.

> **Uma armadilha medida, que o desenho tem de tratar:** os lock files são gravados com **debounce**
> a cada movimento de janela. Duas máquinas ativas não colidem só no `restoreAll()` — colidem
> continuamente, a cada arraste. Qualquer modelo que não seja "handoff" precisa responder o que
> acontece com duas escritas em voo, e "a última vence" aqui significa "a janela pula na tela da
> outra pessoa".

## 3. Regra "OPFS é cache" — ✅ feito

Documentada em [`../api.md`](../api.md) e em
[criterios.md](criterios.md#regra-para-autores-de-app-opfs-é-cache-nunca-a-verdade), e saiu junto com
a [Onda 3](03-toolkit.md#t2--opfs), como o texto original previu que sairia.

A Onda 3 ainda achou uma **segunda** armadilha no caminho, que este item não previa e que era pior
que a de durabilidade: OPFS é privado por **origem**, e todos os vssh-apps são servidos pela origem
do portal — então "privado" não era privado entre apps. O T2 mudou de "implementar OPFS" para
"consertar a isolação do OPFS".

**Fica aberto só o segundo pedaço da frase original:** *"e verificada nos apps de referência"*. A
regra está escrita; nenhum app de referência a exercita hoje. É item da galeria do toolkit, não
desta onda.

## 4. Artefatos nascem no ambiente — ✅ em grande parte feito

O [limite 2 do critério do navegador](criterios.md#31--o-navegador-já-faz-isso), aplicado
sistematicamente: **destino padrão remoto**, cliente por escolha explícita.

O texto original dizia que isto era *"uma varredura, não um item único: cada lugar que hoje produz um
`Blob` e chama `URL.createObjectURL` + `<a download>` é um candidato"*. **A varredura foi feita em
08-08, e ela é pequena** — porque as ondas 2 a 5 já aplicaram a regra caso a caso:

| Caso | Estado |
|---|---|
| **Download do navegador embutido** | ✅ `DownloadHandler` pergunta, e **"Salvar no servidor" é a opção primária**. URL vai por `fetch-url` com progresso SSE; blob vai por `/fs/upload` direto para o SFTP. O caminho cliente existe e é a escolha explícita — exatamente o que este item pede |
| **PDF de impressão** | ✅ [`print/v1`](04-runtime-composicao.md#registro-de-capabilities): o PDF é gerado **no servidor**, ao lado do original, e aberto no visualizador. O arquivo não viaja |
| **Impressão em fila** | ✅ desde a Onda 2: o arquivo não viaja para imprimir |
| **Gravação de tela** | ⚠ **o exemplo estava errado: não existe.** Nenhum `getDisplayMedia` nem `MediaRecorder` no shell. Não é um item pendente — é um recurso que nunca foi construído, e citá-lo aqui dava a esta onda um tamanho que ela não tem |
| **Relatório de bug** (Configurações → Sistema) | ✅ **deletado** — não era para nascer no ambiente, era para não existir. Ver abaixo |
| **Baixar o log de um app** (`LogWindow._baixar`) | ⬜ pendente, e é pequeno — um `Blob` de texto com `<a download>` |
| **Salvar como** do editor de Office | ✅ não era candidato: `_saveAs()` é um `movefile` no servidor, e só o nome colidia com o `saveAs` do FileSaver |

> ### O relatório de bug: a terceira resposta, que esta onda não tinha
>
> Ele parecia o caso mais forte deste item — montava um `.txt` com a URL, o navegador, os motores,
> a telemetria da sessão e **`VsshSettings.all()` inteiro**, ou seja, exatamente as preferências que
> seguem o pesquisador entre máquinas, e o entregava **à máquina de onde ele está prestes a sair**.
> Um artefato sobre portabilidade nascendo no único lugar que não é portátil.
>
> **E a resposta certa não era movê-lo para o servidor. Era apagá-lo**, e isso é uma correção de
> método: este item tinha duas respostas — "nasce no cliente" e "nasce no ambiente" — e faltava a
> terceira, *"não tem por que existir"*.
>
> Ele é herança do cliente Xpra. A versão original montava um `.zip` com screenshot da sessão,
> **nunca funcionou** (`new JSZip()` e o JSZip fora do bundle, com o guard de `typeof` deixando
> passar), e só habilitava depois de um `info-response` — pacote do Xpra, portanto morto no
> ambiente sem X11. A [Onda 2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito)
> o reescreveu para um `.txt` que ao menos rodava, e **essa foi a decisão errada**: consertou a
> execução de uma coisa que não tinha assunto. O que ele produzia — URL, user-agent, id dos
> motores — quem atende um chamado já tem.
>
> Diagnóstico de verdade já existe, e mora onde o problema está: o **log do backend** de cada app
> (janela própria, `run.log` rotacionado no servidor), o **estado de cada serviço** em Serviços, e
> **Dispositivos** para hardware. Nenhum deles depende de alguém lembrar de clicar em "Gerar" antes
> de fechar a aba.
>
> **O `FileSaver.js` saiu junto** — era o único chamador —, e com ele `saveAs` saiu da lista de
> globais permitidos do `client-undefined-refs`. Essa lista tinha sete libs vendorizadas e agora
> tem zero. A guarda que ficou não mede o botão, mede o eixo: uma biblioteca cuja função é *baixar
> um Blob para a máquina do usuário* é, por definição, o oposto da estrela-guia.

**O que sobra é um item pequeno e nomeado**, não uma varredura. O restante desta linha da onda já
foi entregue por quem estava construindo outra coisa — que é o sintoma de um critério funcionando.

## Nota sobre o alcance

"Trocar de máquina" aqui significa **máquina cliente**, não servidor. Estado que vive no host Linux
do usuário está do lado certo e segue o usuário naturalmente — desde que ele volte ao mesmo servidor.

A lista do que está desse lado cresceu desde 08-01, e vale escrever porque cada item é uma coisa a
menos para esta onda migrar: lock files de janela, journal de notificações, `VSSH_APP_DATA_DIR`,
`run.log` de cada app, o cofre de segredos e as filas do CUPS.

Portabilidade **entre servidores** é outra questão, maior, e não está nesta onda — ela depende da
home montada por rede, [registrada na Onda 6](05-arquivos-de-rede.md#a-home-do-usuário-montada-por-rede)
como ideia, não como plano.

## O que sobra, depois da revisão

1. **Item 1 inteiro** — e ele agora é "copiar a forma de `userPrinters` e `appSettings`", não
   "desenhar um store".
2. **A decisão do item 2** — handoff, espelho ou escopos separados. É de produto, e nada anda antes
   dela.
3. **Depois da decisão, o id por conexão** — duas mudanças pequenas em `ws/events.ts`.
4. **Uma migalha do item 4** — o log do app. O relatório de bug já saiu, e levou o `FileSaver.js`
   junto.
