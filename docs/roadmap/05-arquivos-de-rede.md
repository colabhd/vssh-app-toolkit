# Onda 6 — Pastas de rede do usuário

> **Estado:** não iniciado · **Atualizado:** 2026-08-08 · **Repo:** `vssh-sso`
> **Independente das Ondas 1–2** — pode correr em paralelo.

> ### ⚠ Esta onda foi reescrita duas vezes no mesmo dia, e a segunda foi um erro meu de leitura
>
> **A primeira revisão** (manhã de 08-08) conferiu o texto de 01-08 contra o código e derrubou sete
> afirmações. **A segunda** — esta — conserta algo mais grave: eu tinha entendido a onda como
> *"otimizar a navegação de datasets tirando-a do SSH"*, e não é isso.
>
> O que ela é: **o usuário monta as pastas de rede DELE**, além das que o servidor oferece, num
> protocolo moderno em vez de NFS no Linux, e o ambiente fala com elas **direto** — sem o salto pelo
> host. Storage próprio, trazido por quem usa.
>
> A diferença não é de ênfase. O desenho que eu tinha escrito era "extrair um provider de
> `system.ts` para acelerar o catálogo de datasets"; o desenho certo é **"um lugar onde eu registro
> o meu armazenamento e ele aparece no gerenciador de arquivos"** — com credencial minha, escolha
> minha, e me acompanhando para outra máquina.
>
> **O que sobreviveu das duas revisões, porque foi medido e não presumido:** a seção
> [Medido: o gargalo não é o que a onda dizia](#medido-o-gargalo-não-é-o-que-a-onda-dizia). Ela
> mudou de dono — deixou de ser a justificativa desta onda e virou uma onda própria —, mas os
> números continuam valendo.

## O que se quer

Hoje, um pesquisador alcança exatamente o que está montado **no servidor Linux dele**, e o caminho
é sempre o mesmo:

```
navegador → portal → canal SSH → host Linux → cliente NFS → storage
```

Duas coisas erradas nisso, e a segunda é a desta onda:

1. **dois saltos de rede** para ler um byte que já está na rede;
2. **o que existe é o que o administrador montou.** Um pesquisador com um bucket próprio, um
   SeaweedFS do grupo dele, um WebDAV da instituição — não tem por onde trazer. E montar no host
   exige `root`, exige ticket, e prende aquele dado àquele servidor.

O que a onda entrega:

> **"Adicionar pasta de rede"**, em Configurações. Eu digo onde está o meu armazenamento, o portal
> confere que responde, e ele passa a aparecer no gerenciador de arquivos como uma raiz ao lado da
> minha home — **sem tocar no host Linux**, e me acompanhando para qualquer máquina.

É a estrela-guia aplicada ao dado: o armazenamento deixa de ser propriedade do servidor e passa a
ser do usuário.

## O protocolo: padronizar em UM, e qual

Esta é a decisão que a onda tem de tomar primeiro, porque tudo depende dela. As candidatas, e o que
cada uma custa:

| | Semântica de arquivo | Range | Ecossistema | SeaweedFS | Veredito |
|---|---|---|---|---|---|
| **WebDAV** | completa — `MOVE`, `COPY`, `MKCOL`, `PROPFIND`, `DELETE` | sim (HTTP) | universal: Nextcloud, ownCloud, SharePoint, Apache, nginx | **fala nativo** | **o padrão da onda** |
| **S3** | de objeto: sem `rename` (é copiar+apagar), sem escrita parcial, "pasta" é prefixo | sim | enorme | fala nativo | **o segundo provider**, para bucket de verdade |
| **NFS/SMB no host** | POSIX | — | — | — | é o que se está saindo |
| Filer HTTP do SeaweedFS | boa | sim | só SeaweedFS | nativo | não: amarra a onda a um produto |

**A escolha é WebDAV como padrão, e S3 como o segundo.** O motivo não é gosto — é que o consumidor
desta onda é um **gerenciador de arquivos**, e um gerenciador precisa de renomear, mover, criar
pasta e apagar. Em S3, renomear uma pasta de 10 mil objetos é 10 mil cópias e 10 mil deleções, e
qualquer UI que finja o contrário está mentindo sobre o que vai acontecer.

E o SeaweedFS de vocês fala os dois — então ele é o primeiro alvo de teste sem que a onda precise
escolher entre "o padrão" e "o que a gente tem".

> **A régua que já usamos duas vezes:** o `provides` da Onda 5 e o `RemoteDesktopEngines` da 2.7
> dizem a mesma coisa — *não se escolhe o produto, se declara a capacidade e se aceita quem a
> ofereça*. Aqui: o ambiente não conhece SeaweedFS, conhece **WebDAV**; o SeaweedFS é um servidor
> WebDAV que por acaso é o de vocês. No dia em que alguém apontar para um Nextcloud, nada muda.

## A tela: e ela já foi construída uma vez

**Não há nada a inventar aqui**, e isso é resultado da Onda 5. A seção **Dispositivos** entregou,
para impressora, exatamente a anatomia que uma pasta de rede pede:

| Impressora (feito) | Pasta de rede (esta onda) |
|---|---|
| **dois escopos que não podem virar uma lista só** — fila da máquina × impressora minha | montagem do servidor × **pasta minha**. Numa lista só, alguém remove "a pasta dela" e desmonta a de todos |
| **assistente que não guarda o que não respondeu** — sonda com `ipptool` e só então libera "Guardar" | um `PROPFIND` no endereço antes de gravar. Guardar uma URL sem conferir é guardar um texto, e o erro só aparece quando alguém precisa do dado |
| **`userPrinters`** — lista com teto, validada por módulo folha, em `/api/user/settings` | `userMounts`, mesma forma, mesmo lugar |
| *"só você vê estas, e elas acompanham você para outra máquina"* | é literalmente a mesma frase |

A única peça nova é a **credencial**, e ela também tem precedente: o **cofre de segredos** da
Onda 4 — o portal grava no servidor do usuário, com modo `0600`, e **não guarda cópia**. Uma senha
de WebDAV é a mesma classe de valor que um token de app, e tratá-la de outro jeito seria criar a
segunda noção de segredo no sistema.

> **Uma decisão que precisa ser tomada e não é técnica:** o cofre de hoje mora no **host Linux** do
> usuário (`~/.vssh-apps/<id>/secrets.json`). Uma credencial de pasta de rede que viva ali herda
> exatamente o que esta onda quer desfazer — ela para de acompanhar o usuário entre servidores.
> Guardá-la no portal, cifrada, é o que torna a montagem verdadeiramente portátil, e é uma
> mudança de modelo, não uma escolha de biblioteca.

## Quem fala com o storage: o portal, e por quê

Duas topologias possíveis, e a escolha tem consequência:

**Navegador → storage direto.** Mais rápido, tira o portal do caminho por completo. Exige CORS
configurado em cada storage que alguém registrar, e a credencial teria de chegar ao navegador — o
que a coloca no `localStorage` de toda máquina em que a pessoa sentar. **Recusada por isso.**

**Portal → storage, com redirect assinado para leitura em massa.** O portal fala WebDAV com a
credencial guardada, e a navegação (`PROPFIND`, `MKCOL`, `MOVE`) passa por ele. Para *ler bytes* —
um TIFF de 40 GB — ele devolve **302 para uma URL pré-assinada** e o navegador puxa direto do
storage. É o melhor dos dois: a credencial nunca sai do servidor, e os bytes não atravessam o
portal.

> **E este mecanismo já existe.** `POST /api/fs/file-token` emite um JWT com `{ linuxUser,
> serverId, root, exp }`, servido por `GET|HEAD /api/fs/file/:token/<path>` **sem cookie de
> sessão**, com ETag, `If-Range`, 206 e 416. O que muda é o destino: hoje ele aponta para o
> portal; com um provider que saiba assinar, aponta para o storage.

## O contrato do provider

Um provider responde por uma raiz montada. A lista **não** é a de oito operações que a versão
anterior deste arquivo dizia — são 26 no `system.ts` de hoje —, mas nem todas são do provider:

| | Operações | Quem responde |
|---|---|---|
| **do provider** | `list` `stat` `read` `write` `mkdir` `rename` `copy` `delete` `watch` | cada backend, do seu jeito |
| **do portal, sobre qualquer provider** | lixeira, jobs de transferência com progresso e cancelamento, `fetch-url`, token de acesso | é convenção nossa, não do storage |
| **em aberto** | arquivos compactados (`archive/*`) | ler um `.zip` remoto por Range é possível, e é o tipo de coisa que fica lenta sem o provider saber |

Sem essa separação escrita, a extração vira uma reescrita de 2349 linhas — que é o tamanho que
transforma uma onda paralela em uma onda que trava o repositório.

### Três armadilhas de contrato, e a terceira é a que a Onda 5 ensinou a procurar

**`watch` não existe em WebDAV nem em S3.** `vssh.fs.watch` promete algo que nem toda raiz pode
cumprir, e a resposta certa não é silêncio. A Onda 5 entregou o mecanismo: **`provides` declara, e
um endpoint responde se de fato consegue** — o `print-engine` declara `print/v1` no manifesto *e*
responde `GET /capabilities`, porque um servidor onde alguém desinstalou o chromium continua com o
manifesto declarando. **Declarar não é provar.** E valem as três respostas: *"vigiando"*, *"esta
raiz não sabe vigiar"* e *"não consegui perguntar"* — colapsar as duas últimas manda procurar
defeito onde há limitação.

> Nota medida: o `watch` de hoje é multiplexado por `(servidor, usuário)` num supervisor
> `inotifywait` cujo canal SSH é **longo e não passa pelo semáforo**. Ele é a única coisa que segura
> canal fora do orçamento — então uma raiz WebDAV, que não vigia, é a única que sai **mais barata**.

**`vssh.fs.urlFor()` é síncrono e virou contrato público.** Ele devolve URL do portal; com redirect
assinado passa a apontar para **outra origem**: funciona em `<img>`/`<video>`, quebra `fetch` que
espere mesma origem, e conta como taint em canvas. A Onda 5 entregou `minShellVersion` e a Onda 3
expôs a versão do shell ao app — então isso é mudança **versionada e anunciada**, não só
documentada em [`../api.md`](../api.md). O `fsa-polyfill` é o consumidor que prova o ponto: ele
chama `urlFor()` para fatiar por Range e já tem um caminho de baixo para quando ela falha; é esse
caminho que precisa continuar correto quando a URL mudar de origem.

**Um contrato de provider tem dois lados em arquivos que não se leem.** É a assinatura do defeito
que a Onda 2c achou três vezes e que a Onda 5 cercou com uma guarda de junção — os cinco
consumidores do manifesto medidos contra o schema, com piso por consumidor para que uma extração
quebrada não fique verde medindo vazio. **Esta onda nasce com o mesmo risco e deve nascer com a
mesma guarda.** Sem ela, um provider que não implementa `rename` é descoberto pelo usuário que
tentou renomear.

## Três consumidores com necessidades diferentes

O limite honesto do desenho, e ele precisa estar dito:

| Consumidor | Quer | Solução |
|---|---|---|
| **Navegador** (gerenciador, viewers, polyfill FSA) | HTTP com Range | **é o que esta onda entrega** |
| **Backend de um vssh-app** (kernel Jupyter, script Python, job de treino) | **POSIX**: `open()`, `seek`, `mmap` | precisa de montagem no host. Uma raiz WebDAV registrada no portal **não** aparece para o processo do app — e essa assimetria tem de estar na documentação antes de alguém descobri-la debugando |
| **App que só precisa dos bytes** | HTTP | consome o mesmo endpoint do próprio backend e **dispensa montagem** — opção que hoje não existe e que o toolkit deveria documentar |

> **A ponte entre a linha 1 e a linha 2, se algum dia valer:** `rclone mount` sabe montar WebDAV e
> S3 como FUSE, no espaço do usuário, **sem root**. Uma mesma raiz registrada poderia ser servida ao
> navegador pelo provider e ao backend do app por um FUSE — a mesma credencial, os dois consumidores.
> Registrado como caminho, não como plano: exige medir latência de metadado em uso interativo.

### A home do usuário montada por rede

Ideia registrada na [Onda 1](01-sessao-sem-xpra.md): se a home vier de armazenamento de rede,
`(servidor, usuário)` deixa de ser ao mesmo tempo *onde o usuário é* e *onde o dado dele está* — e a
sessão vira relocável entre servidores.

**Ela é a linha 2 da tabela, não a 1**, e a distinção não é detalhe: a home é o oposto do dataset —
mutável, dominada por arquivos pequenos, e o backend de **todo** vssh-app precisa de
`open()`/`seek`/`mmap` nela. Servi-la pelo provider quebraria todos de uma vez.

O que vive ali cresceu desde 01-08, e cada item é um requisito de semântica de escrita e de lock:
os lock files de janela (gravados com debounce a cada movimento), `VSSH_APP_DATA_DIR` de todo app,
o journal de notificações e o cofre de segredos — este último com modo `0600` reescrito a cada
operação, que é justamente o que uma montagem de rede trata mal.

Registrado, não planejado.

## Medido: o gargalo não é o que a onda dizia

Esta seção **mudou de dono**. Ela era a justificativa desta onda; a medição mostrou que ela é outra
onda, e que os números não têm nada a ver com armazenamento de rede.

**A premissa original era falsa.** O texto de 01-08 dizia: *"operações de metadado são conversadas
por natureza, e cada uma vai embrulhada num `exec` por SSH; num diretório com milhares de arquivos
isso é sentido como travamento"*. `GET /api/fs/list` é **UM** `exec` — um `os.scandir` + `stat` de
tudo dentro do processo remoto. Um diretório com 30 mil arquivos custa **um canal**, igual a um com
três. E o pré-carregamento do gerenciador é um de cada vez, `background`, abortado ao mover o mouse.

**E a medição, feita em 08-08 num servidor real, com diretórios sintéticos em disco local:**

| Pasta | Portal entrega | `ls -la` no servidor | **Nosso** |
|---|---|---|---|
| 100 arquivos | 226 ms | ~1 ms | ~225 ms |
| 5.000 arquivos | 822 ms | **44 ms** | **778 ms — 95%** |

Com **fila 0 e espera 0** nos dois casos: o teto de 8 canais não foi arranhado. Não é contenção
entre usuários; é a latência de cada clique, e ela é nossa.

**Os três achados, e nenhum se resolve trocando de storage:**

1. **um `python3` por listagem.** A cadeia é `ssh exec → sudo -H -u → bash -c → echo → base64 -d →
   python3 → scandir`. Cinco processos e um interpretador subindo, por pasta aberta. É o piso de
   226 ms que toda navegação paga, inclusive na home local;
2. **a listagem inteira num JSON só.** 50 mil entradas com caminho absoluto viram megabytes, que
   atravessam o canal, o portal e o `JSON.parse` do navegador;
3. **a lista do gerenciador não virtualiza.** `_patch()` cria um nó DOM por item, para todos os
   itens — 50 mil `.fm-item` com ícone, nome, tamanho e data. É a RAM que apareceu no uso.

> **E a medição achou um bug vivo**, que nenhuma leitura de código tinha achado: `stdout +=
> d.toString()` decodificava cada `Buffer` isoladamente, então um caractere multibyte partido na
> fronteira de dois chunks virava `�`. Precisa de saída maior que um chunk para acontecer — ou
> seja, **listagem de pasta grande**, com nomes em português. Corrigido com `StringDecoder`; a
> refutação usa o código anterior como ataque, e ele produz 5 vermelhos.
>
> É o argumento inteiro a favor de gerar carga em vez de raciocinar sobre ela.

**Estes três itens saíram desta onda e viraram a
[Onda 6b](05b-navegacao-de-arquivos.md).** Eles melhoram a navegação hoje,
inclusive na home local, e não dependem de nenhuma decisão de protocolo — enquanto esta onda
depende de uma que ainda não foi tomada.

## Por que isso serve à estrela-guia

O armazenamento deixa de ser propriedade do servidor. Um pesquisador registra o dado dele uma vez e
o encontra em qualquer máquina, em qualquer servidor — porque a montagem é preferência de usuário,
como a impressora de rede já é
([critério 3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)).

## Ordem sugerida

1. **Decidir o protocolo padrão.** A recomendação é WebDAV; a decisão não está tomada, e nada anda
   antes dela porque o contrato do provider tem a forma do protocolo.
2. **Decidir onde mora a credencial** — cofre no host (o que existe) ou no portal, cifrada (o que
   torna a montagem portátil de verdade). É mudança de modelo.
3. **Escrever a separação provider × portal** das 26 operações. É desenho, não código.
4. **A guarda de junção**, antes do primeiro provider — no molde da Onda 5, com piso.
5. **Um provider WebDAV só de leitura**, contra o SeaweedFS de vocês, com `watch` declarado ausente
   e respondendo honestamente. Só-leitura já serve o arquétipo A3 e não toca escrita nenhuma.
6. **A tela**, no molde de Dispositivos: dois escopos, assistente que sonda (`PROPFIND`) antes de
   guardar.
7. **A URL assinada apontando para fora** — por último, porque é a única que quebra contrato
   publicado e por isso precisa de `minShellVersion` e anúncio.
