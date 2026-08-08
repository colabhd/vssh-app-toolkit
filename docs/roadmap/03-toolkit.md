# Ondas 0 e 3 — Toolkit: higiene e a FSA de verdade

> **Estado:** Onda 0 concluída · **Onda 3 🟢 fechada** (T9, T1, T2, T6, T7, os dois shims, a metade
> declarativa do `requiredPackages` e a cópia vendorizada) · **Atualizado:** 2026-08-08 ·
> **Repo:** toolkit
>
> *(Este cabeçalho dizia "Onda 3 não iniciada" até 08-08, com a seção dela marcada como fechada
> quatro parágrafos abaixo. Cabeçalho é o que se lê primeiro, e era o único lugar do arquivo que
> ainda estava errado.)*
>
> Revisado contra o código em 2026-08-05, junto com a [Onda 4/5](04-runtime-composicao.md). T1, T2 e
> T9 continuam verdadeiros como estão escritos; a pendência da tag `v2` não é pendência; e o
> pré-requisito da versão do shell **foi entregue** na 2c. Três coisas mudaram de lugar: a onda
> **começa pelo T9**, T6 e T7 passam a ter dono aqui, e o `minShellVersion` foi para a
> [Onda 5](04-runtime-composicao.md#o-contrato-do-manifesto-um-schema-uma-validação-uma-guarda),
> junto com `provides` — os dois exigem o mesmo trabalho de base.

---

## Onda 0 — Higiene

> **Estado:** ✅ concluída

Barato, sem risco, e destrava quem escreve app hoje. Não bloqueia nem é bloqueado por nada.

| Item | O quê | Estado |
|---|---|---|
| 0.A | A roadmap vira `docs/roadmap/` — este diretório | ✅ |
| 0.1 | Versionamento: `@main` como ref que valida, defaults corrigidos | ✅ |
| 0.2 | `lib/web/` na tabela de bibliotecas do README | ✅ |
| 0.3 | Destino de dois caminhos do `vssh-app-lib-sync` | ✅ |
| 0.4 | Template Node exercendo a ponte | ✅ |
| 0.5 | `electron-shim` alinhado ao que declara | ✅ |
| 0.6 | Docs contra o código | ✅ |
| 0.7 | **Bug encontrado durante a verificação:** confinamento do `static-spa` | ✅ |

### 0.7 — O bug que a verificação encontrou

Rodar a suíte no Windows para decidir sobre a matriz do CI revelou 4 testes vermelhos em
`static-spa.test.js` — e a causa era **na lib, não no teste**.

`createStaticSpa` guardava a raiz com `path.resolve()`, mas `statWithin` canonicalizava o **alvo**
com `fsp.realpath()`. Duas grafias do mesmo diretório que nunca casam ⇒ a checagem de confinamento
recusa tudo ⇒ **todo caminho aninhado vira 404, enquanto o index continua servindo** (ele é lido
direto, sem passar pelo confinamento). Falha silenciosa: a página carrega, os assets somem.

O detalhe que fez a primeira tentativa de correção falhar: no Windows, `fs.realpathSync` **não**
expande nome curto 8.3, mas `fs.realpathSync.native` e `fsp.realpath` **expandem**. Com o TEMP em
`C:\Users\ARTHUR~1\...`, "canonicalizar os dois lados" só funciona se for com a **mesma** função.

Não é um problema só do Windows — é o que essa plataforma tornou visível. `/tmp` no macOS é symlink
para `/private/tmp`, e um deploy no idioma `current -> releases/N` cairia igual, em produção.

O irmão `vssh-app-fs/paths.js` **não** tinha o defeito: ele já usava `fs.realpathSync` dos dois
lados. Era o `static-spa` que estava fora do padrão, apesar do comentário dizer que fazia "do mesmo
jeito".

**Consequências:** o smoke do template ganhou duas asserções que provam a ponte de ponta a ponta — a
tag injetada **e** o arquivo sendo servido, que era exatamente o vão onde o T4 morava.

**O que NÃO mudou, e por quê.** A tentação era acrescentar `windows-latest` à matriz do CI. Não é o
caso: o alvo de um vssh-app é sempre Linux, e dobrar os minutos de Actions para cobrir uma plataforma
que nunca roda o código em produção não se paga. A divisão que vale é outra — **o CI garante o alvo;
quem desenvolve garante a máquina de desenvolvimento**, rodando `npm test` localmente. Foi
exatamente assim que este bug apareceu.

Isso virou comentário no `ci.yml` porque o anterior dizia "a matriz existe por um motivo concreto"
sem registrar que a redução a um SO foi **deliberada, por custo** — e a ausência dessa razão fez a
revisão concluir que era descuido e tentar desfazer. Razão não escrita é razão que se perde.

### 0.1 — Versionamento

A tag `v1` **não contém** `lib/`, `schema/` nem `docs/` — ela é do toolkit original, anterior ao
`toolkit v2`. Mas o README mandava fixar `@v1`, e o default de `REF`/`tools_ref` era `v1`. Efeito: o
`vssh-app-publish` não encontrava o schema e degradava para validação mínima, imprimindo
`aviso: schema não encontrado; validando só o mínimo`.

**Isso já era conhecido no ecossistema** — `vsshapp-scramjet-wisp/.github/workflows/publish.yml`
documenta a armadilha e usa `tools_ref: main`. O problema real não era quebra silenciosa universal: era
**o README ensinando errado**, e cada repo de app redescobrindo sozinho.

Arquivos: `README.md`, `MIGRATION.md`, `scripts/vssh-app-lib-sync`,
`.github/workflows/_publish-app-reusable.yml`.

> **A tag `v2` foi criada no fim da Onda 3**, e o `main` deixou de ser a recomendação. Vale
> registrar o caminho porque ele contradiz o que este item dizia antes.
>
> A Onda 0 concluiu que a tag *"não é pendência de nada"* — e estava certa quanto ao sintoma que
> tinha em mãos: com o default em `main`, o schema era encontrado e a validação acontecia. O que
> aquela conclusão não pesou é que **um branch move a validação do CI de quem publica sem ele
> pedir**: cada commit deste repositório muda o que o CI de terceiros executa, inclusive num push
> que ninguém do outro lado viu. Isso não é "validar menos" — é não ter alvo estável.
>
> A tag só passou a valer a pena agora porque a Onda 3 deu a ela algo para significar: com o
> `lib_version` conferido no publish, `v2` é um contrato ("estas libs, esta validação"), e não só
> um apelido de commit.

### 0.2 — `lib/web/` no README

A tabela de bibliotecas listava só as quatro de `lib/node/`. `vssh-app-shim.js`, `fsa-polyfill.js`,
`electron-shim.js` e `tauri-shim.js` — a superfície inteira de API do cliente — apareciam só em prosa.

### 0.3 — Destino do `vssh-app-lib-sync`

A receita documentada sincronizava para `./vendor/vssh` e mandava commitar `backend/vendor/vssh`. E
faltava dizer o essencial: **libs web precisam ficar sob a raiz da SPA** para o `static-spa` conseguir
servi-las. Padrão de dois destinos:

```bash
vssh-app-lib-sync . --parts fs,spa,log,sse --dest backend/vendor/vssh
vssh-app-lib-sync . --parts web            --dest frontend/vendor/vssh
```

### 0.4 — Template que exerce a ponte

`injectScripts` estava comentado no `server.js` do template Node — e **mesmo descomentado não
funcionaria**: ele só injeta a tag `<script>`, ninguém servia o arquivo. A funcionalidade mais
documentada do toolkit não tinha exemplo funcionando em lugar nenhum.

O template passa a vendorizar `lib/web/` sob `frontend/`, injetar o shim, e demonstrar
`vssh.notify` + `vssh.dialog.confirm` com o caminho de degradação fora do desktop.

> **O `fsa-polyfill.js` fica vendorizado mas NÃO é injetado por padrão**, com os limites do T1
> documentados no próprio template. Ligá-lo antes da Onda 3 seria entregar a armadilha junto com o
> exemplo.

### 0.5 — `electron-shim` alinhado ao que declara

O cabeçalho do arquivo e `porting.md` diziam que `Notification` estava coberto — não estava. E os
controles de janela eram no-op apesar de `vssh.window.*` existir desde `a5cf253`. `app.getVersion()`
devolvia `'0.0.0'` fixo.

### 0.6 — Docs contra o código

- `lib/node/vssh-app-fs/README.md` dizia que a lib "mora no `vsshapp-logseq` por enquanto" e citava
  defaults do Logseq que deixaram de existir quando ela foi promovida ao toolkit;
- o comentário de `.github/workflows/ci.yml` justificava a matriz Windows enquanto `os:` era só
  `ubuntu-latest`;
- `docs/lessons/logseq-port.md` §9 dizia que o watcher estava fora de escopo — `vssh.fs.watch`
  existe desde `28f4729`.

---

## Onda 3 — A FSA de verdade, e as dívidas do toolkit

> **Estado:** 🟢 **fechada** — T9, T1, T2, T6, T7, os dois shims sem teste, a metade declarativa do
> `requiredPackages` e a cópia vendorizada que passou a se declarar.
>
> **O que a onda mediu, e que muda o placar:** três dos itens **não eram o que estavam escritos**.
> O T2 pedia implementar OPFS — OPFS já existe, e o que faltava era isolá-lo entre apps. A lista de
> pendências do polyfill catalogava `removeEntry` como conveniência ausente — era perda de dado. E
> a justificativa de vendorizar (*"o servidor não alcança registry npm"*) nunca tinha sido medida,
> e é falsa.
>
> Nenhum dos três apareceria sem duas coisas que a onda comprou antes de consertar qualquer coisa:
> o **instrumento de navegador** (T9, feito primeiro de propósito) e o hábito de **sondar antes de
> implementar**.
> **Destrava:** **A3** (visualizador científico). *Ela não é o bloqueio de A4/A5* — a revisão de
> 2026-08-05 conferiu contra o código: A4 dependia do T6 e das várias janelas (Onda 4), e A5,
> de drag-and-drop e teclado. O clipboard, que os dois citavam, foi entregue na Onda 2. Ver as
> notas de [casos-de-uso.md](casos-de-uso.md#categoria-a--aplicações-com-janela-type-app).

### A ordem é T9, T1, T2 — e a inversão é o ponto

Esta onda começa pelo **teste**, não pelo conserto. A razão está escrita no próprio T9: os testes de
hoje rodam o código de navegador num contexto `vm` **com stubs manuais**, que não reproduzem as
leituras internas da plataforma — e é exatamente ali que o T1 vive. `new Response(f)` devolvendo
zero bytes não é um caminho que se esquece de testar: é um caminho que a instrumentação atual **não
alcança**.

Consertar o `LazyFile` primeiro seria escrever a correção e a prova dela com o mesmo instrumento que
deixou o defeito passar. É a lição que a [Onda 2c](02c-interludio.md) cobrou três vezes por
refutação, chegando antes de existir código novo desta vez: **guarda que não pode falhar ocupa o
lugar de uma que poderia.**

### T9 — Testes de navegador

> ✅ **CONCLUÍDO.** O estado fica aqui, e não no cabeçalho: título é âncora, e âncora que muda
> quebra link de fora do repositório sem avisar ninguém.

As falhas estruturais do T1 estavam **documentadas mas não testadas**: os testes rodavam o código
de navegador num contexto `vm` com stubs manuais, que não reproduzem leituras internas da
plataforma. O critério de pronto não era "existe um runner": era **o T1 falhando de verdade** neste
instrumento antes de ser consertado.

**A medição que decidiu o instrumento veio antes dele.** A pergunta era se as leituras que o T1
quebra reproduzem em Node — e a resposta separou os dois ambientes exatamente na leitura que mais
importa:

| | `new Response(f)` | `new Blob([f])` |
|---|---|---|
| Node / undici | chama o `.stream()` **público** → funciona | sequência interna → vazio |
| navegador (Fetch) | *get stream* **interno** → vazio | sequência interna → vazio |

Ou seja: consertar o T1 por cima de `stream()` deixaria o teste verde no Node com o navegador
ainda quebrado. E `FileReader` não existe no Node — não é discordância, é ausência.

**`tests/browser/chrome.js`, sem dependência npm.** Acha um Chrome/Edge já instalado, sobe headless
numa porta efêmera e fala CDP pelo `WebSocket` nativo do Node 22+. Sem navegador, os testes se
**pulam** em vez de falharem: falha por ausência de ambiente é ruído, e o runner Ubuntu do CI já
traz Chrome — nenhum passo novo de instalação.

O que ele mede que o `vm` não alcançava: `FileReader`, `FormData` de verdade, o IndexedDB do
navegador com structured clone real (a reidratação de handle era medida contra stubs escritos à
mão), e `Range` HTTP contra um servidor de verdade.

**Duas coisas que a primeira execução ensinou, e ficaram no código:**

- `about:blank` é **origem opaca** e o Chrome nega IndexedDB ali. O erro chegava como
  `SecurityError` lançado de dentro da biblioteca sob teste — indistinguível de defeito dela. Daí
  o `servirOrigem()`;
- o primeiro `slice()` por `Range` devolveu `<!doctyp` — o `fetch` batia na página em branco da
  origem, que responde 200 para qualquer caminho, e o código fatiava o HTML. Isso virou **uma
  defesa no polyfill** (só `206`, ou `200` com corpo grande o bastante para conter a faixa) e uma
  rota de `/api/fs/read` no teste. O fixture credulo mentiu antes do código.

**Os dois shims sem teste — a dívida que o T9 nomeou — foram pagos junto.** `electron-shim` e
`tauri-shim` nasceram sem uma asserção sequer; hoje são 48, num harness compartilhado
(`lib/web/test/_ambiente-falso.js`) que grava toda chamada ao `vssh`. É o que se precisa medir
neles: um shim que chama `pickFile` onde deveria chamar `pickDirectory` devolve um caminho
perfeitamente válido, e está errado.

Ficaram no runner de `vm`, não no de navegador — pela mesma regra que separa os dois: os shims são
comportamento do nosso código, não leitura que a plataforma faz sobre o que devolvemos.

**Os primeiros testes acharam três defeitos, e nenhum deles daria erro em lugar nenhum:**

| onde | o que acontecia |
|---|---|
| `tauri-shim` · `sendNotification({title})` sem corpo | passava `''` como mensagem → **toast em branco**. O `electron-shim` já tratava isso; a divergência entre os shims irmãos era o defeito |
| `electron-shim` · `showMessageBox` | `response` é o ÍNDICE do botão, e presumíamos que o afirmativo é o 0. Correto em `['Sim','Não']`, **errado em `['Cancelar','OK']`** — confirmar devolvia o "Cancelar", e o app descartava o trabalho do usuário achando que foi ele quem pediu. Agora honra `defaultId`/`cancelId` |
| `electron-shim` · `require('electron')` | devolvia um objeto **diferente** de `window.electron` (o `Object.assign` copia para um alvo novo). Um app que substitui `window.electron.dialog` — o idioma comum para mockar — continuava recebendo o original pelo `require`, e as duas metades do app discordavam |

Uma armadilha do instrumento ficou resolvida no harness, e não em cada teste: um `{}` criado
dentro do `vm` tem outro `Object.prototype`, e o `deepStrictEqual` reprova por procedência em
objetos idênticos em tudo que importa. Deixar cada arquivo redescobrir isso é garantir que um
deles afrouxe a asserção em vez de traduzir.

### A cópia vendorizada não sabe a idade que tem

Item aberto durante o T9, a partir de uma pergunta direta: *copiar em vez de instalar não deixa o
sistema mais frágil?*

A resposta separou três cópias que não compartilham justificativa — e a que falhou naquele momento
(`lib/` → `templates/*/vendor/`, **dentro do mesmo repositório**) era justamente a única já
guardada, por `tests/vendored-libs.test.js`. Ela falhou no `npm test`, com o nome do arquivo e o
comando do conserto. A guarda funcionou.

**O problema é a cópia de fora:** o `vendor/vssh/` do repositório de um app. O
`.vssh-lib-version` registra `origin` e `synced_at` e **nenhum programa lê esse arquivo** — nem o
`vssh-app-publish`, nem o `vssh-app-install`, nem o portal, nem o shim, que não sabe a própria
versão. Uma cópia de seis meses atrás é indistinguível de uma de hoje. O cabeçalho do
`vendored-libs.test.js` narra o precedente: dois arquivos atrasados, *"descobertos por acaso, meses
depois, procurando outra coisa"*.

**Uma justificativa foi removida do README, da SKILL e do `vssh-app-lib-sync` por ser falsa:** *"o
servidor-alvo pode não ter registry npm acessível num exec não-interativo por SSH"*. Ela entrou num
único commit de desenho (`53d7714`), em três lugares ao mesmo tempo, e nunca foi medida — o
servidor alcança o registry. O que sobra a favor de vendorizar é real, mas é outra coisa: o publish
empacota o que está versionado, e as libs de `lib/web/` precisam ficar sob a raiz da SPA de
qualquer forma.

O trabalho, então, não é trocar cópia por instalação — é **fazer a cópia se declarar**. Os três
passos estão feitos:

1. ✅ o shim carrega a própria versão (`LIB_VERSION`, amarrada ao `package.json` por
   `tests/lib-version.test.js`);
2. ✅ `vssh.capabilities()` devolve o par `shellVersion` + `libVersion` — junto com o **T7**, que
   é a metade simétrica disto: o app não sabia em que shell roda, e o shell não sabia que libs o
   app carrega. Mesma doença, direções opostas;
3. ✅ o `vssh-app-publish` lê o `.vssh-lib-version` do pacote e compara com a própria versão.

**A proporção do passo 3 não é arbitrária.** Divergência de **major** recusa a publicação;
o resto avisa. O major deste repositório só é bumpado quando as libs carregam breaking change real
(está escrito no `//version` do `package.json`), então publicar contra outra major é publicar
contra um contrato que mudou. Menor e patch são compatíveis por definição — recusar ali só
ensinaria a ignorar o gate, que é o defeito que a Onda 0 diagnosticou no aviso de schema faltando.

E quando o script **não sabe a própria versão** — o checkout esparso do CI traz `scripts/` e
`schema/`, e pode não trazer o `package.json` —, a conferência é pulada **e dita em voz alta**. Uma
conferência que se acha feita sem ter sido é pior que nenhuma. (O `sparse-checkout` do reusable
passou a trazer o `package.json`; um repo pinado num ref antigo continua publicando, só sem esta
conferência, e sabendo disso.)

#### O npm foi considerado e decidido CONTRA

A decisão ficou em aberto de propósito até os três passos existirem — *"decidir com o custo real em
mãos"*. Com eles em mãos, o custo virou:

| | |
|---|---|
| o que o npm acrescentaria | um empurrão **proativo**: dependabot abrindo PR quando sai versão nova, antes de você publicar |
| o que ele custaria | o **primeiro credential da história deste repositório** (`NPM_TOKEN`) — e *"sem nenhum PAT/GitHub App"* é a razão escrita de ele ser público; mais um escopo npm para manter; mais um passo de build em cada repo de app |
| o que ele **não** resolveria | a vendorização. O publish empacota o que está **versionado**, então a cópia continuaria sendo commitada — o npm acrescentaria um passo antes dela, não removeria a cópia |

O argumento original do npm era ser *"a única rota que transforma 'a cópia envelheceu' numa
pergunta que uma ferramenta responde"*. Ele era forte porque **nada** respondia. Hoje o publish
responde, e responde no momento em que importa: **recusando a publicação**. Um dependabot avisa
antes; um gate impede. Trocar um gate por um aviso, pagando um credential, não se paga.

**O gatilho que reabre a decisão**, e é bom estar escrito: o dia em que o toolkit distribuir algo
que **não** é vendorizado — um CLI que se rodaria com `npx`. Aí o npm deixa de ser burocracia e
vira o transporte natural.

**O que foi feito no lugar**, e compra o mesmo empurrão por muito menos:

1. **a tag `v2` passou a existir.** Só havia a `v1`, do toolkit original — e por isso o README
   recomendava `@main` como "correção de rota". Puxar de um branch faz a validação do CI de quem
   publica mudar debaixo dele a cada commit daqui, inclusive num push que ele não viu. `v2` é o
   default do `tools_ref` e do `--ref`;
2. **os avisos viraram anotações do Actions.** Em log corrido um aviso é uma linha entre mil, e
   isso não é hipótese: é exatamente como o `aviso: schema não encontrado` da `v1` passou meses
   despercebido em repos que publicavam com validação mínima achando que validavam. `::warning::`
   sobe para o resumo do run e para a aba de anotações do PR. Aquele aviso original foi o primeiro
   a ser convertido.

### T1 — `LazyFile` é um `Blob` vazio

> ✅ **CONCLUÍDO.** O cabeçalho fica como estava: o README do repositório aponta para esta âncora.

`LazyFile extends Blob` com `super([])` deixa a sequência interna de bytes vazia, e **tudo que lê o
`Blob` pelo caminho da plataforma devolvia 0 bytes, em silêncio**.

**A medição num Chrome de verdade achou um modo de falha pior do que estava escrito aqui.** Não é
"vem vazio": `new Blob([f])` devolvia **`size` correto com conteúdo vazio** — quem confere
`blob.size > 0` antes de usar passa na conferência e recebe nada. E um `FormData` subia
`filename="nota.md"` com zero bytes: um upload perfeitamente formado de um arquivo em branco.

**A fronteira do conserto é o relógio, não a herança.** A regra antiga — *"preguiça e
compatibilidade estrutural não coexistem numa subclasse de `Blob`"* — estava larga demais, e tinha
sido escrita sem instrumento capaz de refutá-la. Onde cabe um `await`, cabe conserto:

| caminho | antes | agora |
|---|---|---|
| `f.slice(a, b)` | **lançava** | faixa nova, lida por `Range` HTTP, sem leitura prévia |
| `new Response(f)` · `new Request` | 0 bytes | corpo vira `f.stream()` — correto **e** preguiçoso |
| `fetch(url, {body: f})` | 0 bytes | `Blob` real, carregado na hora do envio |
| `FileReader.readAs*` | 0 bytes | carrega e despacha os mesmos eventos |
| `new Blob([f])` · `FormData.append` | 0 bytes calado | 0 bytes **com aviso**, e correto se já houve leitura |

Os dois últimos leem os bytes de forma **síncrona** — não há onde encaixar a busca. Ficam como
limite conhecido, medido por teste, e deixam de ser silenciosos. Uma vez lido o arquivo, os dois
passam a funcionar sozinhos, porque aí os bytes existem.

`slice()` era o mais grave, e é o que destrava o **A3**: é a operação primária de qualquer leitor
de Parquet, HDF5, Zarr ou DICOM. Hoje fatiar 64 bytes de um arquivo de 100 kB transfere 64 bytes —
e há teste medindo os bytes que o servidor entregou, não só o resultado.

> **Uma defesa que nasceu de um fixture mentiroso:** um servidor pode **ignorar** o `Range` e
> responder 200 com o recurso inteiro. Confiar no pedido em vez de conferir a resposta entrega
> bytes errados em silêncio — foi o que aconteceu na primeira execução do teste, e o `slice()`
> devolveu `<!doctyp` com cara de conteúdo. Só `206` com o tamanho certo, ou `200` com corpo
> grande o bastante para conter a faixa, são aceitos; o resto cai na leitura pela ponte.

### T2 — OPFS

> ✅ **CONCLUÍDO** — mas não fazendo o que este item dizia.

O item dizia: *"`navigator.storage.getDirectory()` e `createSyncAccessHandle` não existem no
polyfill"*. **Não precisam existir: são nativos do navegador.** Medir antes de implementar mudou o
T2 de "implementar OPFS" para "consertar a isolação do OPFS" — e o que estava lá era pior do que
uma ausência.

**OPFS é privado por ORIGEM, e todos os vssh-apps são servidos pela origem do portal.** A sonda
montou dois apps em caminhos diferentes da mesma origem:

```
app A:  getDirectory() → escreve 'segredo.db'
app B:  getDirectory() → lê "o banco do app A", verbatim — e pode sobrescrevê-lo
```

O *"Origin Private File System"* é privado de outros **sites**, não de outros **apps**. Quem
escreve um vssh-app assume a segunda coisa — é o nome que promete isso — e recebe a primeira: o
banco sqlite de um app, o cache de pacotes do Pyodide de outro, sem aviso nenhum. Não é só
vazamento de leitura: um app pode **corromper** o banco de outro.

O conserto é dar a cada app a sua raiz — um subdiretório com o id do app, tirado do path que o
portal serve. O handle devolvido é **nativo**, um subdiretório de verdade, então
`createSyncAccessHandle` e o resto seguem funcionando sem nada nosso no caminho. Fora do proxy
(`npm run dev`) nada é isolado: não há outro app com quem colidir, e esconder o armazenamento de
quem está desenvolvendo seria pior.

**Efeito colateral que a medição forçou:** com os globais trocados pelas nossas classes (ver a
seção anterior), um handle **nativo** do OPFS deixaria de passar no `instanceof` — trocaríamos um
`instanceof` quebrado por outro. As nossas classes passaram a aceitar as duas procedências, por
`Symbol.hasInstance` **nelas**, e não por remendo nas nativas: são nossas, e dizer o que aceitam é
prerrogativa delas.

> **A regra saiu junto com a feature:** [OPFS é cache, nunca a verdade](criterios.md#regra-para-autores-de-app-opfs-é-cache-nunca-a-verdade).
> O padrão natural de `sqlite-wasm` é usar OPFS como armazenamento primário, e isso perde tudo ao
> trocar de máquina, sem erro nenhum. Entregar T2 sem a regra seria entregar uma armadilha.
>
> E o item deixou um **precedente para o critério 3.2**: toda API de armazenamento do navegador
> tem o escopo do NAVEGADOR, não o do nosso ambiente. `localStorage`, `IndexedDB` e cookies estão
> sob a mesma origem única e merecem a mesma pergunta.

Seis ataques por refutação, todos vermelhos — e **um deles achou um teste fraco meu**: a primeira
versão do "fora do proxy" conferia se o arquivo criado era visível de onde foi criado, o que é
verdade em qualquer namespace. A asserção certa não é *"o que eu criei está aqui?"*, é *"esta raiz
É a raiz de verdade?"* — comparada com a `getDirectory` original, guardada antes de o polyfill
envelopá-la.

### T6 e T7 — as duas dívidas que não tinham onda

O [diagnóstico](diagnostico.md#13-dívidas-do-toolkit) lista nove dívidas do toolkit. Quatro caíram
na Onda 0 (T3, T4, T5, T8), três são as de cima — e **duas não estavam em lugar nenhum**. Passam a
ser desta onda, que é a do toolkit:

| | O que é | Estado |
|---|---|---|
| **T6** | a ponte `fs` do shim não tem `exists`, `rename` nem `copy` | ✅ **feito** — ver abaixo |
| **T7** | `capabilities()` não diz a versão do shell | ✅ **feito** — ver abaixo |
| **T7** | sem `.d.ts` | ✅ **feito** — ver abaixo |

Nenhum dos dois bloqueia T1/T2, e é justamente por isso que sumiram: item que não bloqueia nada
sobrevive numa tabela de diagnóstico para sempre.

**O T7 é o que fecha o par com o `minShellVersion`**, e o quadro vale registrar porque construir um
e achar que o outro ficou resolvido é o erro natural aqui:

| | quando responde | o que faz com o "não" |
|---|---|---|
| `minShellVersion` | **no publish**, contra um número declarado | recusa publicar, com o nome da versão |
| `vssh.capabilities()` | **em runtime**, no ponto de uso | o app decide: degrada, esconde o botão, avisa |

A 2.7 já escolheu o idioma do lado direito (`RemoteDesktopEngines.comCapacidade`, duck-typing no
ponto de uso). O T7 é a ponte entre as duas colunas: sem ele, o app sabe *o que* o shell faz, mas
nunca *qual shell* é.

#### T6 — e a parte cara não eram as três ops

`vssh.fs` ganhou `exists`, `rename` (que é também o **mover**) e `copy`. As rotas do portal já
existiam (`/api/fs/rename`, `/api/fs/copy`, `/api/fs/stat`); o que faltava era o shell expor as ops
e o shim chamá-las. Isso é o barato.

**O caro é o gate de permissão, porque `rename` e `copy` têm DOIS caminhos e o gate conferia um.**
O modelo é o da File System Access API: o app alcança só o que o usuário escolheu num seletor. Com
um caminho conferido, a fuga existe nas duas direções — e as duas **sucedem**, sem erro nenhum:

| | o que o app conseguiria |
|---|---|
| origem concedida, destino não | **mover** o arquivo do usuário para fora da área que ele autorizou, onde some do alcance de quem concedeu |
| destino concedido, origem não | **copiar** para dentro da própria área um arquivo que não tinha permissão de ler — e depois lê à vontade, legitimamente |

O gate passou a ser uma **lista de campos por op**, com um default que falha **fechado**: uma op
nova que esqueça de se declarar cai num caminho vazio, que não é concedido. O erro de esquecer é
recusar demais, nunca permitir demais.

A guarda executa o método **de verdade** — o corpo do `_appFs` é extraído do arquivo e rodado sobre
um `this` de mentira, então o que o teste exercita é o código que vai para o navegador, e não uma
reimplementação dele. Sete ataques por refutação, todos vermelhos: voltar ao gate de um caminho,
`rename` declarar um campo só, conferir só o primeiro da lista, o default sumir (falha aberto), a
política virar `overwrite`, e as duas formas de o `exists` deixar de distinguir 404 de erro.

**`exists` foi o achado lateral, e vale por si.** O `tauri-shim` o implementava como
`stat(p).catch(() => false)` — o idioma que todo mundo escreve, e que colapsa **três** respostas em
duas: *"não existe"*, *"não tenho permissão"* e *"não consegui perguntar"* saíam todas como
`false`. O app então cria por cima de um arquivo que está lá, ou conclui que a pasta do usuário
está vazia porque a rede piscou. Agora só o 404 vira `false`; o resto sobe. E `rename`/`copy` não
sobrescrevem por padrão — `{ overwrite: true }` é opt-in, porque perder um arquivo do usuário não
tem desfazer.

#### As duas versões chegaram juntas — e era esse o ponto

`vssh.capabilities()` passa a devolver **`shellVersion` e `libVersion`**, e as duas juntas porque
nenhuma sozinha responde a pergunta que importa. Um app é vendorizado: leva uma cópia das libs no
tarball, e essa cópia envelhece independente do desktop, deployado por outra gente em outro
momento. Um relato de *"não funciona"* sem o par não diz qual combinação estava em jogo.

Isso fecha, na mesma volta, a metade do
[item da cópia vendorizada](#a-cópia-vendorizada-não-sabe-a-idade-que-tem) que dizia *"o shim
sequer sabe a própria versão"*.

| peça | onde |
|---|---|
| o shell injeta `window.__VSSH_SHELL_VERSION__` | já existia desde a 2c (`vssh-shell.ts`) |
| a resposta de `capabilities` carrega o campo | `VsshAppWindow.js` — **novo** |
| o shim garante a chave e acrescenta a sua | `vssh-app-shim.js` — **novo** |
| o marcador da cópia vendorizada carimba `lib_version=` | `vssh-app-lib-sync` — **novo** |

Três decisões que valem estar escritas:

- **`shellVersion: null` é resposta, não erro** — quer dizer "shell antigo demais para se
  declarar". O shim garante a chave justamente para o app poder escrever `?? 'desconhecida'` em
  vez de descobrir a ausência em produção;
- **o `|| null` no shell não é cosmético.** `undefined` desaparece na serialização do
  `postMessage`, e o app receberia a **chave faltando** — indistinguível de um shim velho que nem
  sabe perguntar;
- **o `LIB_VERSION` é um literal no shim**, porque aquilo roda no navegador e não tem `package.json`
  de onde ler. Quem impede a divergência é `tests/lib-version.test.js`, que amarra três pontas:
  `package.json` → literal do shim → `lib_version` do marcador. O `vssh-app-lib-sync` lê **do
  shim**, e não do `package.json`, para que o marcador e o que roda no navegador não possam
  discordar.

#### Os `.d.ts` — e a guarda que impede um arquivo de tipos de mentir

`lib/web/vssh-app-shim.d.ts` declara a superfície inteira do `vssh` como **declaração global** (o
shim entra por tag `<script>`; um `export` de topo o transformaria em módulo e nada dele ficaria
visível — com o sintoma *"os tipos não funcionam"*, sem nada apontando para a causa).

O que torna isto diferente de escrever um arquivo de tipos: **a superfície foi enumerada em
runtime, não lida de memória**. Carregar o shim num contexto e listar `Object.keys(window.vssh)`
deu os 51 membros exatos, e é contra essa lista que o arquivo é conferido — nos **dois sentidos**,
porque os dois estragos são silenciosos e opostos:

| direção | o que acontece |
|---|---|
| existe e não está declarado | o TypeScript **recusa compilar** código que funciona. A pessoa conclui que a API não existe e escreve um contorno |
| declarado e não existe | o editor autocompleta, o build passa, e quebra em produção com `undefined is not a function` |

Provado por refutação — os seis ataques deixam a suíte vermelha: membro novo no shim, membro
inventado no `.d.ts`, membro aninhado novo, membro aninhado removido da interface, o arquivo virar
módulo, e o global `vssh` sumir.

> **`electron-shim` e `tauri-shim` ficam SEM `.d.ts`, e isso é decisão, não pendência.** Um app
> portado já usa `@types/electron` ou `@tauri-apps/api`, que declaram aquelas superfícies inteiras.
> Uma segunda declaração do mesmo nome ou conflita, ou vence a de upstream — e aí passa a esconder
> o que o nosso shim **não** implementa, que é exatamente a metade que quem porta precisa enxergar.

A guarda do lado do shell é de **junção**, e o motivo é o modo de falha: um typo no nome do global
não quebra nada — `undefined || null` vira `null`, que é uma resposta *válida*. O defeito se
disfarça exatamente do estado que o campo existe para representar. Por isso o nome que o servidor
**escreve** e o nome que o cliente **lê** são medidos um contra o outro num arquivo só
(`tests/unit/versao-do-shell-chega-ao-app.test.js`), e a asserção exige a **leitura** (`window.X`),
não uma menção ao nome. Provada por refutação: typo no global, remoção do `|| null`, remoção do
campo e o nome citado só em comentário — os quatro deixam a suíte vermelha.

### `requiredPackages` — o app declara de que pacote Linux ele precisa

Hoje, um vssh-app que depende de um binário do sistema (`ffmpeg`, `pandoc`, `texlive`, `rclone`)
tem dois caminhos, e os dois são ruins: pôr um `apt-get` no `installCommand` — que roda como root,
uma vez, sem declarar nada a ninguém — ou falhar em runtime com `command not found` no `run.log`.

`requiredPackages: ["ffmpeg"]` no manifesto, com a consequência que vale mais que a instalação em
si: **o `installCommand` deixa de ser o lugar onde dependência de sistema se esconde.** Hoje ele é
um script opaco que roda duas vezes (root e por usuário) e não declara nada — o que torna
impossível responder *"este app roda neste servidor?"* sem executá-lo.

> ✅ **A metade declarativa está feita**: o campo entrou no `schema/vssh-app.schema.json` e o
> `vssh-app-publish` o valida. **Quem verifica é o portal**, e por isso a outra metade — o
> `vssh-app-install` recusando antes de instalar, e o painel admin mostrando o que falta por
> servidor — está na
> [Onda 4](04-runtime-composicao.md#requiredpackages--a-metade-que-verifica---concluído). O corte não é
> burocrático: o portal já responde essa pergunta para os grupos de pacotes do provisionamento
> (`provision-base.sh --print-packages`, com fixture em `tests/unit/provision-packages.test.js`), e
> a verificação por app nasce ao lado daquilo, não aqui.

**Este campo ganhou uma conferência que os outros não têm, e a razão é a diferença dele:** o valor
chega a um **gerenciador de pacotes rodando no servidor do usuário**. Um nome com metacaractere de
shell é injeção, e o gate de publicação é onde isso se recusa — depois já é tarde, e o portal
teria de desconfiar de um manifesto que passou por aqui. O padrão é o de nome de pacote Debian
(`^[a-z0-9][a-z0-9+.-]*$`), e o erro **nomeia o valor reprovado**: "pacote inválido" sozinho manda
quem publica conferir a lista inteira à mão.

O bloco de validação do publish é Python dentro de um heredoc, e por isso nunca teve teste — a
suíte é Node. `tests/publish-validacao.test.js` o extrai pelos delimitadores reais do heredoc (não
por número de linha, que um script crescendo invalidaria) e o roda com o `python3` que o próprio
script já exige. Sem `python3`, os testes se **pulam**, como os de navegador.

### O `minShellVersion` mudou de onda

A metade que **publica** a versão do shell já existe (Onda 2c: `shellVersion` em
`/api/shell/config`). A metade que **consome** — `minShellVersion` / `targetShellVersion` no
manifesto, validação no publish, mensagem honesta quando não bate — saiu daqui e foi para a
[Onda 5, junto com `provides`](04-runtime-composicao.md#o-contrato-do-manifesto-um-schema-uma-validação-uma-guarda).

Não por afinidade temática: **por trabalho de base.** Todo campo novo de manifesto precisa das
mesmas três coisas — entrada no `schema/vssh-app.schema.json`, validação no `vssh-app-publish` e um
consumidor no portal. Fazer isso duas vezes, em duas ondas, é fazer duas vezes a parte cara e
arriscar duas noções do mesmo contrato.

### O que estava em aberto no polyfill

> ✅ **A parte do toolkit está fechada.** O que sobrou depende do seletor do desktop e está
> nomeado no fim desta seção.

A lista antiga tinha seis itens, e destrinchá-la contra o código — com o instrumento do T9 — mudou
dois deles. **Um a favor:** `move()` e `remove()` deixaram de ser trabalho, porque o T6 entregou
`fs.rename` e `fs.delete` na ponte na mesma onda. **Um contra, e ele não era o que estava escrito:**

#### `removeEntry` não era feature faltando — era perda de dado

A lista dizia *"`removeEntry({recursive:true})` não implementado"*. O `/api/fs/delete` do portal é
**`rm -rf` incondicional**, e a especificação da FSA manda o contrário: apagar diretório com
conteúdo sem `{ recursive: true }` tem de lançar `InvalidModificationError`. Ou seja:

```js
await dir.removeEntry('pasta-cheia');    // apagava a pasta inteira, em silêncio
```

É a única divergência do polyfill que **perde dado do usuário**, e ela estava catalogada como
ausência de conveniência.

A guarda é um `list` antes do delete. A primeira versão perguntava ao `stat` se era diretório e só
então listava — e isso a fazia depender do **formato** da resposta do stat (`isDirectory`): um
shell cujo stat não trouxesse o campo devolveria `undefined`, a guarda se consideraria
inaplicável, e o `rm -rf` passaria. Uma proteção que falha **aberto** por causa de um campo
ausente. Listar direto não pergunta nada a ninguém — arquivo não lista, diretório vazio lista
vazio. *(Quem achou isso foi um fixture de teste que não devolvia o campo.)*

#### `instanceof` era assimétrico, e só um navegador de verdade mostraria

O Chrome **já tem** `FileSystemHandle`, e o polyfill preservava a nativa (`|| function(){}`). Como
os nossos handles não descendiam dela:

| | |
|---|---|
| `h instanceof FileSystemDirectoryHandle` | `true` — essa nós substituímos |
| `h instanceof FileSystemHandle` | **`false`** — essa era a nativa |

A classe concreta batia e a **base** falhava — e `instanceof FileSystemHandle` é o idioma de "isto
é um handle, tanto faz qual". A base passou a ser nossa: dentro do desktop não existe handle
nativo para quebrar, porque os três `show*Picker` são deste arquivo e o do navegador nunca abre.

#### Os descritores do seletor

`types`/`accept` viram a string de grupos que o seletor do desktop entende (formato Qt,
`Nome (padrões);;…`), e `startIn` é resolvido quando é um handle — é só o caminho dele.

#### O que sobrou, e é do shell

Duas coisas dependem do gerenciador de arquivos, não do toolkit — e **as duas deixaram de ser
caladas** nesta onda, que é a metade que era nossa:

| | por que é do shell |
|---|---|
| `showOpenFilePicker({multiple:true})` | o seletor é de escolha **única por desenho** (`_pickerMode`, um campo "Selecione um item"). Precisa de UI no gerenciador **e** de a mensagem `pick` passar a devolver lista |
| `startIn: 'documents'` | o shell teria de resolver os diretórios XDG do usuário |

Devolver um array de um item sem avisar era a pior versão do primeiro: o app recebe a **forma**
certa com o conteúdo errado e segue como se o usuário tivesse escolhido um arquivo só porque quis.

Sete ataques por refutação, todos vermelhos: `removeEntry` voltando a apagar direto, a guarda
invertida, o `list` que falha virando "tem conteúdo", a base voltando a ser a nativa, `move` sem
atualizar o handle, `types` sem virar filtro, e `multiple` voltando a ser silencioso.
