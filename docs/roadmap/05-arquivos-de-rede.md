# Onda 6 — Camada de arquivos de rede

> **Estado:** não iniciado · **Atualizado:** 2026-08-08 · **Repo:** `vssh-sso`
> **Independente das Ondas 1–2** — pode correr em paralelo.

> ### ⚠ Esta onda foi escrita antes de metade do sistema existir
>
> O texto original é de 2026-08-01, **antes** das Ondas 2.6, 2.7, 2c, 4 e 5. Ele descrevia um portal
> que não existe mais. A revisão de 08-08 conferiu cada afirmação contra o código, como o
> [README manda fazer antes de executar uma onda](README.md#antes-de-executar-uma-onda-confira-as-afirmações-dela-contra-o-código)
> — e **sete delas estavam erradas ou vencidas**. Elas estão corrigidas no lugar, dizendo que
> estavam erradas, porque o histórico do erro vale mais que a aparência de acerto.
>
> O resumo, para quem não vai ler o resto: **o desenho continua certo e o tamanho estava errado**.
> A extração é maior do que se dizia, o mecanismo de URL assinada já existe, o gargalo já tem
> instrumento de medida, e a tela que faltava agora tem casa e precedente.

## O problema, com número

Hoje o caminho de um dataset de rede é:

```
navegador → portal → canal SSH → host Linux → cliente NFS → storage
```

Dois saltos de rede, e o do meio disputa um orçamento de **~8 canais concorrentes para o servidor
inteiro** ([diagnostico](diagnostico.md#-teto-de-canais-ssh-8-por-servidor-não-por-usuário)).

NFS piora o caso: operações de metadado (`readdir`, `stat`) são conversadas por natureza, e cada uma
vai embrulhada num `exec` por SSH. Num diretório de dataset com milhares de arquivos, isso é sentido
como travamento — e, sob contenção, como os 409 de `da6bfb5`.

**Tirar a navegação de dados do SSH não é só latência: é devolver canais ao orçamento** que hoje
limita quantos pesquisadores cabem num servidor.

### ⚠ Corrigido: o gargalo continua real, mas deixou de ser invisível — e o primeiro passo é MEDI-LO

Quando isto foi escrito, o teto de ~8 era uma constante do `sshd` que ninguém no portal enxergava.
Não é mais. O `services/ssh-exec.ts` hoje tem um **semáforo explícito** por conexão
(`SSH_MAX_CONCURRENT_CHANNELS`, padrão 8), com **duas prioridades** — `interactive` (listar, `stat`,
criar) na frente de `background` (gravar lock de janela, poll de job) —, uma **segunda fila** só para
streams longos (`acquireReadSlot`, teto por usuário e abortável), e `sshSlotStats()` publicando
fila, `inFlight` e espera mais antiga.

E a [Onda 2.7](02b-motores.md) tirou o desktop inteiro desse orçamento: abrir o ambiente deixou de
gastar canal.

Isso muda o primeiro passo da onda, e a mudança é de método, não de detalhe. **A frase "isso é
sentido como travamento" era hipótese quando foi escrita e continua sendo até alguém olhar
`sshSlotStats()` num servidor com uso real.** Se a fila `interactive` estiver curta e a espera mais
antiga em dezenas de milissegundos, a justificativa desta onda muda de "o SSH está estrangulando a
navegação" para "o salto extra custa latência", que é uma onda menor e com outra prioridade.

Sondar antes de implementar já mudou três itens da Onda 3 e três afirmações da Onda 5. Aqui é
barato: a rota de estatística já existe.

## O desenho: providers por ponto de montagem

Extrair de `src/routes/system.ts` um contrato de provider e rotear por prefixo de montagem:

| Provider | Serve | Toca o host Linux? |
|---|---|---|
| `ssh` | home do usuário e tudo que precisa do host | sim (é o de hoje) |
| `s3` / `webdav` / `http-index` | datasets de rede | **não** |

### ⚠ Corrigido: a lista de operações estava curta por um fator de três

O texto original dizia *"`list`, `stat`, `read` com Range, `write`, `mkdir`, `rename`, `copy`,
`delete`"* — oito operações. **São 29 rotas `/fs/*` em 26 operações distintas**, num arquivo de
2349 linhas:

| Grupo | Operações |
|---|---|
| Leitura e travessia | `list` `stat` `read` `open` `watch` |
| Escrita | `write` `mkdir` `rename` `copy` `delete` `upload` |
| Trabalho longo | `transfer` `jobs/:id` `jobs/:id/cancel` `fetch-url` |
| Lixeira | `trash` `trash/list` `trash/restore` `trash/delete` `trash/empty` `purge` |
| Arquivos compactados | `archive/list` `archive/extract` `archive/create` `archive/delete-entries` |
| Acesso sem sessão | `file-token` `file/:token/*` |

Um contrato de oito operações deixaria **dois terços da superfície de fora**, e a pergunta que o
desenho precisa responder não é "quais operações o provider tem" e sim **"o que é do provider e o
que é do portal"**:

- **do provider**, porque cada backend responde diferente: `list`, `stat`, `read`, `write`, `mkdir`,
  `rename`, `copy`, `delete`, `watch`;
- **do portal, sobre qualquer provider**: a lixeira (é convenção nossa, não do storage), os jobs de
  transferência com progresso e cancelamento, o `fetch-url`, e o token de acesso sem sessão;
- **em aberto**: os arquivos compactados. Ler um `.zip` remoto por Range é possível e é exatamente o
  tipo de coisa que fica lenta sem o provider saber.

Sem essa separação escrita, a extração vira uma reescrita de 2349 linhas — que é o tamanho que
transforma uma onda paralela em uma onda que trava o repositório.

## As duas otimizações que são o ganho real

### ⚠ Corrigido: a URL assinada não é para construir. Ela existe, e falta apontá-la para outro lugar

O texto dizia que `GET /api/fs/read` passaria a devolver 302 para uma URL pré-assinada, como se o
mecanismo fosse novo. **`POST /api/fs/file-token` já emite exatamente isso**: um JWT com
`{ linuxUser, serverId, root, exp }`, TTL próprio, servido por `GET|HEAD /api/fs/file/:token/<path>`
**sem cookie de sessão** — com ETag, `If-Range`, 206, 416 e `Accept-Ranges`.

O que falta não é assinar: é a URL **apontar para outra origem** quando o provider souber emitir uma.
E isso reduz o item, mas move o risco para o outro lado — ver a armadilha do `urlFor()` abaixo, que
deixou de ser hipotética por causa disto.

**Cache de metadado em Redis.** Datasets de pesquisa são majoritariamente imutáveis, então
`readdir`/`stat` cacheiam muito bem — ao contrário da home do usuário.

## As montagens são uma preferência, e a tela delas já tem precedente

As montagens são declaradas por servidor/usuário e alimentadas pelo catálogo que o
`dataset-management` já publica (`indices.json` em `bases.colabh.org`), hoje consumido pelo Recoll.

> **O consumo do catálogo mudou de forma, e o novo é o molde certo para as montagens.** Ele já foi
> injetado como `--start-env=RECOLL_EXTRA_DBS` — uma constante de 300 linhas
> (`utils/recoll-dbs.js`) despejada no ambiente da sessão X11, igual para todo mundo. Isso morreu
> com o caminho antigo do desktop na [Onda 2.7](02b-motores.md). Hoje a seleção é **preferência de
> usuário**, guardada em `recoll_user_active` e servida por `routes/recoll.ts`, com a distinção que
> importa preservada: `null` = *"nunca escolhi"* (liga tudo) é diferente de `[]` = *"desliguei
> tudo"*. Montagem por servidor/usuário tem exatamente a mesma forma, e o mesmo par de estados.

**E a tela deixou de ser um problema em aberto.** Quando isto foi escrito, não havia onde pôr uma
lista de montagens: a janela de Configurações eram seis abas fixas num `innerHTML`. A
[Onda 2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito) trocou isso por um
registro, e a **seção Dispositivos** entregou, por acidente feliz, o molde exato de que esta onda
precisa:

- **dois escopos que não podem virar uma lista só.** Fila de impressão *da máquina* (todo mundo vê,
  só o admin mexe) × impressora *minha* (preferência, me acompanha para outra máquina). Montagem tem
  o mesmo par, com o mesmo risco: numa lista só, alguém remove "a montagem dela" e desmonta a de
  todos;
- **um assistente que não guarda o que não respondeu.** O de impressora sonda o endereço com
  `ipptool` e só libera o "Guardar" depois da resposta. Uma montagem tem a mesma armadilha e é
  pior: um endereço S3 guardado sem verificação vira um dataset vazio que a pessoa só descobre no
  meio de um treino;
- **`userPrinters` é o precedente de forma**: lista curta, com teto, validada por um módulo folha e
  gravada em `/api/user/settings`. Uma lista de montagens é a mesma coisa com outro validador.

Isso não é reuso de código — é reuso de decisão. As três já foram tomadas e testadas.

## Três armadilhas de contrato que precisam ser declaradas

### `watch` é dependente de provider — e agora existe o mecanismo certo para dizer isso

Não há inotify em S3 nem em WebDAV. `vssh.fs.watch` promete algo que nem todo caminho pode cumprir.

> **Corrigido: "capability opcional por montagem" era um conceito sem mecanismo quando foi escrito,
> e virou um mecanismo com nome.** A [Onda 5](04-runtime-composicao.md#registro-de-capabilities)
> entregou `provides: "nome/vN"` e a resolução por capacidade — e, com ela, a lição que importa
> aqui: **declarar não é provar.** O `print-engine` declara `print/v1` no manifesto *e* responde
> `GET /capabilities` dizendo se consegue de fato, porque um servidor onde alguém desinstalou o
> chromium continua com o manifesto declarando. Uma montagem que declara `watch` e não entrega tem
> a mesma forma de mentira.
>
> E a régua das **três respostas** vale inteira: "vigiando", "esta montagem não sabe vigiar" e "não
> consegui perguntar" são três, não duas — colapsar as duas últimas manda a pessoa procurar defeito
> onde há limitação, que é o erro que a seção de pacotes e a de GPU já cometeram uma vez cada.

**E o `watch` de hoje tem um custo que o texto original não sabia:** ele é multiplexado por
`(servidor, usuário)` num supervisor `inotifywait`, cujo canal SSH é **longo e não passa pelo
semáforo**. Ou seja, o watch já é a única coisa que segura canal fora do orçamento. Um provider sem
inotify não é só uma degradação de funcionalidade — é o único caso em que ele fica **mais barato**.

### `vssh.fs.urlFor()` é síncrono, e agora é contrato PÚBLICO

Ele devolve URL do portal. Com redirect assinado ela passa a apontar para **outra origem**: funciona
em `<img>`/`<video>`, mas quebra `fetch` que espere mesma origem e conta como taint em canvas.

> **Corrigido: isto deixou de ser "documentar antes" e passou a ser "versionar".** Quando foi
> escrito, o toolkit não tinha como um app dizer de que shell ele precisa. Tem: a
> [Onda 5](04-runtime-composicao.md#registro-de-capabilities) entregou `minShellVersion`, e a
> [Onda 3](03-toolkit.md#t6-e-t7--as-duas-dívidas-que-não-tinham-onda) entregou a versão do shell
> exposta ao app. Mudar o que `urlFor()` devolve é mudança de comportamento em API publicada, para
> gente de fora do repositório — então ela **é versionada e anunciada**, não só documentada em
> [`../api.md`](../api.md).
>
> O `fsa-polyfill` é o consumidor que prova o ponto: ele chama `fs.urlFor()` para fatiar por Range e
> **já tem um caminho de baixo** para quando ela não existe ou a rede falha. Esse caminho de baixo é
> o que precisa continuar correto quando a URL passa a ser de outra origem.

### A terceira, que é a que a Onda 5 ensinou a procurar

Um contrato de provider tem **dois lados em arquivos que não se leem**: quem implementa e quem
consome. É a assinatura exata do defeito que a Onda 2c achou três vezes e que a Onda 5 acabou
cercando com uma guarda de junção — os cinco consumidores do manifesto medidos contra o schema, com
piso mínimo por consumidor para que uma extração quebrada não fique verde medindo vazio.

**Esta onda nasce com o mesmo risco e deve nascer com a mesma guarda:** a lista de operações do
contrato, medida contra cada provider e contra cada chamador, com piso. Sem isso, um provider que
não implementa `rename` é descoberto pelo usuário que tentou renomear.

## Três consumidores com necessidades diferentes

> Corrigido: a tabela se chamava "Dois consumidores" e tinha três linhas desde o começo.

Este é o limite honesto do desenho, e precisa estar dito:

| Consumidor | Quer | Solução |
|---|---|---|
| **Navegador** (gerenciador, viewers, polyfill FSA) | HTTP com Range | VFS do portal — estritamente melhor que hoje |
| **Backend de um vssh-app** (kernel Jupyter, script Python, job de treino) | **POSIX**: `open()`, `seek`, `mmap` | montagem no host — o VFS não substitui. Caminho: avaliar `mountpoint-s3`/`rclone mount` no lugar do NFS, que costumam ganhar em dataset imutável dominado por leitura |
| **App que só precisa dos bytes** | HTTP | consome o mesmo endpoint do próprio backend e **dispensa montagem** — opção que hoje não existe e que o toolkit deveria documentar |

### A home do usuário montada por rede — e por que ela é a linha do meio

Ideia registrada na [Onda 1](01-sessao-sem-xpra.md): se a home vier de armazenamento de rede,
`(servidor, usuário)` deixa de ser ao mesmo tempo *onde o usuário é* e *onde o dado dele está* — e a
sessão vira relocável entre servidores. É a estrela-guia levada ao limite: o ambiente quase
serverless.

**Ela pertence à linha de montagem POSIX da tabela acima, não à do VFS.** A distinção não é
detalhe: a home é o oposto do dataset — mutável, dominada por arquivos pequenos, e o backend de
**todo** vssh-app precisa de `open()`/`seek`/`mmap` nela. Servir a home pelo VFS do portal quebraria
todos eles de uma vez. O caminho é o mesmo do dataset POSIX (`rclone mount` e similares), com um
requisito extra que o dataset não tem: **semântica de escrita e de lock que aguente uso
interativo**.

A lista do que vive ali cresceu desde que isto foi escrito, e cada item é um requisito: os lock
files de estado de janela (`~/.vssh/psd/*.lock`, gravados com debounce a cada movimento),
`VSSH_APP_DATA_DIR` de todo app, o **journal de notificações** e o **cofre de segredos** — este
último com modo `0600` reescrito a cada operação, que é justamente o tipo de coisa que uma montagem
de rede trata mal.

Registrado, não planejado: exige medir latência de metadado em uso interativo antes de virar
proposta.

## Por que isso serve à estrela-guia

Navegar e ler dados deixa de exigir o host Linux — mais uma capacidade que passa a funcionar sem
sessão. E como as montagens são declaradas no servidor, **elas seguem o pesquisador entre máquinas
de graça** ([critério 3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)).

## Ordem sugerida, depois da revisão

1. **Medir** `sshSlotStats()` num servidor com uso real. É o passo que decide se esta onda é grande
   ou pequena, e ele custa uma requisição.
2. **Escrever a separação** provider × portal das 26 operações. É desenho, não código, e é o que
   impede a extração de virar reescrita.
3. **A guarda de junção**, antes do primeiro provider — no molde da Onda 5, com piso.
4. **Um provider de leitura só** (`http-index` ou `s3`), com `watch` declarado como ausente e
   respondendo honestamente. Um provider que só lê já serve o arquétipo A3 e não toca escrita
   nenhuma.
5. **A tela**, no molde da seção Dispositivos: dois escopos, assistente que sonda antes de guardar.
6. **A URL assinada apontando para fora** — por último, porque é a única que quebra contrato
   publicado e por isso precisa de `minShellVersion` e anúncio.
