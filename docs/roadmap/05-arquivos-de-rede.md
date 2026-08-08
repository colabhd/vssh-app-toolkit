# Onda 6 — Pastas de rede do usuário

> **Estado:** desenho fechado, sem trava · **Atualizado:** 2026-08-08 · **Repo:** `vssh-sso`
> **Independente das Ondas 1–2** — pode correr em paralelo.
> **Decidido:** WebDAV como padrão, S3 com suporte declaradamente limitado, credencial no portal
> cifrada. O próximo passo é código: a guarda de junção, e depois um provider WebDAV só de leitura.

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

## O protocolo: WebDAV, com S3 de suporte limitado

**O padrão da onda é WebDAV. S3 entra como segundo provider, com suporte declaradamente limitado.**

O motivo é o consumidor: quem come esta onda é um **gerenciador de arquivos**, e um gerenciador
precisa de renomear, mover, criar pasta e apagar. WebDAV tem isso na semântica; S3 não tem. E o
ambiente já falou WebDAV três vezes sem saber — o SeaweedFS do k3s, o Nextcloud e o SharePoint são
todos servidores WebDAV, então padronizar aqui não é adotar um produto, é parar de precisar
escolher.

### "Limitado" é uma palavra do contrato, não uma ressalva de rodapé

Esta é a parte que muda o desenho, e ela vem da mesma régua que a Onda 5 fixou: **declarar não é
provar, e o que não se consegue fazer se diz.**

Em S3, renomear uma pasta de 10 mil objetos é 10 mil cópias e 10 mil deleções — e uma UI que ofereça
"Renomear" ali está mentindo sobre o que vai acontecer. A resposta certa **não** é emular: é o
provider declarar `rename: false`, `escritaParcial: false`, e a tela desabilitar o que aquela raiz
não faz, **dizendo por quê**.

É literalmente o mecanismo do `watch` três parágrafos abaixo, e o mesmo do `print/v1`: três
respostas, não duas — *"faço"*, *"esta raiz não faz"* e *"não consegui perguntar"*. Colapsar as duas
últimas manda o usuário procurar defeito onde há limitação.

> **O que isso protege:** sem a declaração, o primeiro bucket S3 registrado vira um gerenciador de
> arquivos que trava por dez minutos num arrastar-e-soltar, sem nada na tela explicando. Com ela, o
> item aparece apagado e o motivo está escrito.

<details>
<summary>As candidatas, e o que cada uma custava</summary>

| | Semântica de arquivo | Range | Ecossistema | SeaweedFS | Veredito |
|---|---|---|---|---|---|
| **WebDAV** | completa — `MOVE`, `COPY`, `MKCOL`, `PROPFIND`, `DELETE` | sim (HTTP) | universal: Nextcloud, ownCloud, SharePoint, Apache, nginx | **fala nativo** | **o padrão da onda** |
| **S3** | de objeto: sem `rename` (é copiar+apagar), sem escrita parcial, "pasta" é prefixo | sim | enorme | fala nativo | **o segundo provider**, para bucket de verdade |
| **NFS/SMB no host** | POSIX | — | — | — | é o que se está saindo |
| Filer HTTP do SeaweedFS | boa | sim | só SeaweedFS | nativo | não: amarra a onda a um produto |

</details>

O SeaweedFS de vocês fala os dois — então ele é o primeiro alvo de teste sem que a onda precise
escolher entre "o padrão" e "o que a gente tem", e é a bancada onde os dois providers se comparam
contra o **mesmo** dado.

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

### A credencial mora no portal, cifrada

**Decidido.** O cofre da Onda 4 grava no **host Linux** do usuário
(`~/.vssh-apps/<id>/secrets.json`, modo `0600`, sem cópia no portal) e é um mecanismo provado — mas
uma credencial de pasta de rede que viva ali herda exatamente o acoplamento que esta onda existe
para desfazer: ela para de acompanhar o usuário entre servidores.

O argumento que decidiu não é de conforto, é de forma. A parte **não-secreta** da montagem — URL,
tipo, usuário, nome — vai para `/api/user/settings` como `userMounts`, no molde de `userPrinters`, e
acompanha a pessoa. Se o segredo ficasse no host, **as duas metades do mesmo fato teriam tempos de
vida diferentes**: a montagem apareceria numa máquina nova e não abriria. É a assinatura de junção
que este repositório já pagou cinco vezes na Onda 4 — só que desenhada de propósito.

**E o custo está aceito, não escondido.** Levantado contra o código antes da decisão: **o portal não
cifra nada em repouso hoje.** `SESSION_SECRET` só **assina** — cookie de sessão e token de arquivo —
e não há `createCipheriv` em lugar nenhum do `src/`. Então esta onda traz:

| O que entra | Por quê |
|---|---|
| a primeira criptografia em repouso do portal | e ela precisa de chave própria, **não** do `SESSION_SECRET`: uma chave que assina e cifra confunde dois tempos de vida — trocar o segredo de sessão derrubaria as montagens de todo mundo |
| uma história de rotação | escrita antes do primeiro segredo gravado, não depois — reencriptar um campo que já tem dados de produção é a migração que ninguém quer fazer com pressa |
| uma classe nova de responsabilidade | o portal passa a guardar senha de storage **de terceiros**. Isso muda o que um vazamento significa, e tem de estar dito na tela: *"esta senha fica com o portal, cifrada"* |

> **O cofre do host não morre nem vira legado.** Ele continua certo para o que ele serve: segredo
> **de app**, que é consumido por um processo naquele host. São dois cofres porque são dois tempos
> de vida — e essa frase precisa estar na documentação, senão o terceiro segredo do sistema vai
> parar no lugar errado por analogia.

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

Um provider responde por uma raiz montada. Sem esta separação escrita, a extração vira uma
reescrita de 2349 linhas — que é o tamanho que transforma uma onda paralela numa onda que trava o
repositório.

> **A contagem estava errada, e para menos.** Este documento dizia "26 operações" (e, antes disso,
> "oito"). Contadas em 08-08: são **29 rotas `/fs/*`**, que dão **27 operações distintas** — dois
> pares `GET`/`HEAD` contam uma vez cada. Mais `/desktop-files`, que é uma **trigésima** e é uma
> listagem que não se chama de listagem: roda a mesma cadeia `python3` de `/fs/list`, e passaria
> despercebida numa extração feita por prefixo de rota.

### As 27, repartidas

**Do provider — cada backend, do seu jeito (9):**

| Rota | | S3 |
|---|---|---|
| `GET /fs/list` | listar | prefixo, não pasta |
| `GET·HEAD /fs/read` | ler com Range | ok |
| `GET /fs/stat` | metadado | ok |
| `POST /fs/mkdir` | criar pasta | **não existe** — pasta é convenção de prefixo |
| `POST /fs/rename` | renomear/mover | **não existe** — é copiar + apagar, objeto a objeto |
| `POST /fs/copy` | copiar | server-side copy, com teto de tamanho |
| `DELETE /fs/delete` | apagar | ok |
| `POST /fs/write` | escrever | sem escrita **parcial** |
| `GET /fs/watch` | vigiar | **não existe**, e WebDAV também não |

**Do portal, sobre qualquer provider — convenção nossa, não do storage (14):**

`POST /fs/file-token` · `GET·HEAD /fs/file/:token/*` · `POST /fs/transfer` · `GET /fs/jobs/:id` ·
`POST /fs/jobs/:id/cancel` · `POST /fs/trash` · `GET /fs/trash/list` · `POST /fs/trash/restore` ·
`POST /fs/trash/delete` · `POST /fs/trash/empty` · `POST /fs/purge` · `POST /fs/upload` ·
`GET /fs/open` · `POST /fs/fetch-url`

Elas se apoiam nas 9 acima e não sabem qual backend está embaixo. **Duas precisam de decisão de
desenho antes da primeira linha de código:**

- **onde mora a lixeira de uma raiz remota.** Hoje ela é um diretório na home. Numa raiz WebDAV, a
  resposta que não quebra o invariante *"o undo nunca perde dado"* é uma lixeira **dentro da própria
  raiz** (`.vssh-trash/`), porque mandar para a home significa **atravessar o arquivo pela rede duas
  vezes** para apagá-lo. E em S3 a lixeira é uma cópia de verdade, não um `mv` — que é mais um item
  para a matriz de capacidade;
- **`upload` e `transfer` viram tráfego que passa pelo portal.** Hoje o arquivo vai do navegador ao
  SFTP; com uma raiz remota, ele vai navegador → portal → storage. É o mesmo salto duplo que a onda
  reclama na primeira seção, e a saída é a mesma: **URL assinada de escrita**, quando o provider
  souber emitir.

**Em aberto — 4:** `GET /fs/archive/list` · `POST /fs/archive/extract` · `POST /fs/archive/create` ·
`POST /fs/archive/delete-entries`. Ler um `.zip` remoto por Range é possível (o diretório central
está no fim do arquivo, e são duas leituras); extrair e criar exigem trazer o arquivo inteiro para
algum lugar. Ficam **fora do primeiro provider**, declaradas ausentes.

### A matriz de capacidade, que é o que "suporte limitado" quer dizer

O provider **declara** o que faz, e a tela desabilita o resto **dizendo por quê**. Três respostas,
nunca duas: *faço*, *esta raiz não faz*, *não consegui perguntar*.

```
{ list, stat, read, write, delete, copy: true,
  mkdir: false, rename: false, watch: false,
  escritaParcial: false, urlAssinada: 'leitura' }
```

É o mesmo mecanismo do `provides` da Onda 5 e do `available()` do `RemoteDesktopEngines` — e é o que
impede o desenho óbvio e errado: **emular `rename` em S3.** Emular faz um arrastar-e-soltar de uma
pasta de 10 mil objetos travar por dez minutos com a barra parada, e o usuário não tem como saber
que pediu 20 mil requisições. Recusar com o motivo na tela é mais honesto e mais rápido de escrever.

> **E a guarda de junção nasce aqui, não depois** (item 4 da ordem). Um contrato de provider tem
> dois lados em arquivos que não se leem: a matriz declarada e o que a tela desabilita. Se elas se
> desencontrarem, o botão fica aceso e o erro chega ao usuário como travamento. **Com piso por
> consumidor**, como a Onda 5 fez com o manifesto — senão uma extração quebrada fica verde medindo
> vazio.

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

**E a medição, refeita e corrigida em 08-08:** uma listagem de 5.000 arquivos custa **157 ms** — 51
ms para abrir o canal, 64 esperando o processo remoto, 42 recebendo 336 KB.

> ### ⚠ Os números que estavam aqui eram de OUTRA operação
>
> Esta seção dizia *"226 ms para 100 arquivos, 822 para 5.000, e 95% da latência é nossa"*. Nenhum
> desses números era de uma listagem: saíam de **"Operação mais longa"**, um pico sobre **tudo** que
> passa pelo limitador de canais, num painel que não dizia de quem era o número. O dono real era o
> **coletor por servidor**, que roda a cada 5 s e não é pedido por ninguém.
>
> Caíram junto o piso de 226 ms, a inclinação de 596 e a conta de "9,7 operações por segundo". A
> história inteira, com o conserto do medidor, está na
> [Onda 6b](05b-navegacao-de-arquivos.md#o-pico-que-não-dizia-de-quem-era).
>
> **E isso muda o que esta onda pode prometer.** Uma raiz WebDAV não vai "consertar a lentidão da
> navegação", porque não há lentidão a consertar — a justificativa dela é a que sempre foi: o
> armazenamento passa a ser do usuário, e não do servidor.

**Os três achados de então, e nenhum se resolvia trocando de storage** — é por isso que eles saíram
daqui:

1. **um `python3` por listagem** — e a decomposição mostrou que a cadeia inteira custa 18 ms, contra
   os 226 que este documento lhe atribuía;
2. **a listagem inteira num JSON só** — o `path` absoluto repetido era 40% do corpo, e saiu do fio;
3. **a lista do gerenciador não virtualiza** — 50 mil `.fm-item` no DOM. Este era real, apareceu no
   uso como RAM, e foi o único dos três que virou ganho medido.

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

1. ~~**Decidir o protocolo padrão.**~~ ✅ **WebDAV, com S3 de suporte limitado e declarado.**
2. ~~**Decidir onde mora a credencial.**~~ ✅ **No portal, cifrada** — com chave própria, não a de
   sessão, e a rotação escrita antes do primeiro segredo gravado.
3. ~~**Escrever a separação provider × portal.**~~ ✅ 9 do provider, 14 do portal, 4 em aberto — mais
   a matriz de capacidade e as duas decisões que ela destapou (a lixeira de uma raiz remota, e o
   `upload` voltando a ser salto duplo).
4. **A guarda de junção**, antes do primeiro provider — no molde da Onda 5, com piso.
5. **Um provider WebDAV só de leitura**, contra o SeaweedFS de vocês, com `watch` declarado ausente
   e respondendo honestamente. Só-leitura já serve o arquétipo A3 e não toca escrita nenhuma.
6. **A tela**, no molde de Dispositivos: dois escopos, assistente que sonda (`PROPFIND`) antes de
   guardar.
7. **A URL assinada apontando para fora** — por último, porque é a única que quebra contrato
   publicado e por isso precisa de `minShellVersion` e anúncio.
