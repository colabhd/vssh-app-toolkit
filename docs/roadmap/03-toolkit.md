# Ondas 0 e 3 — Toolkit: higiene e a FSA de verdade

> **Estado:** Onda 0 concluída · Onda 3 não iniciada · **Atualizado:** 2026-08-05 · **Repo:** toolkit
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

> **A tag `v2` não foi criada, e a decisão foi contornar em vez de esperar.** O texto aqui dizia
> que ela *"precisa ser criada e empurrada para que os defaults novos funcionem"* — não precisa: o
> default virou `main` (`scripts/vssh-app-lib-sync:36`, `_publish-app-reusable.yml:43`), e o
> comentário do workflow registra o porquê: *"enquanto não existir uma tag `v2`, `main` é a única
> ref que valida de verdade"*. Criar a tag continua sendo uma boa ideia — ela dá a quem publica um
> alvo estável —, mas **não é pendência de nada**, e anunciá-la como tal fazia parecer que a Onda 0
> tinha ficado pela metade.

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

> **Estado:** 🟡 em andamento — **T9 ✅**, **T1 ✅**; próximo é o T2
> **Destrava:** **A3** (visualizador científico). *Ela não é o bloqueio de A4/A5* — a revisão de
> 2026-08-05 conferiu contra o código: A4 depende do T6 e de "uma janela por app" (Onda 4), e A5,
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

O trabalho, então, não é trocar cópia por instalação — é **fazer a cópia se declarar**:

1. o shim carrega a própria versão (`VSSH_LIB_VERSION`, gerada do `package.json`);
2. `vssh.capabilities()` devolve o par `shellVersion` + `libVersion` — junto com o **T7**, que é a
   metade simétrica disto: hoje o app não sabe em que shell roda, e o shell não sabe que libs o app
   carrega. Mesma doença, direções opostas;
3. o `vssh-app-publish` lê o `.vssh-lib-version` e **recusa, ou avisa alto**, quando a cópia
   diverge do toolkit contra o qual está publicando.

> A rota de distribuição em si — publicar `lib/` como pacote npm público e o `vssh-app-lib-sync`
> virar um passo de build que copia de `node_modules` para a raiz da SPA — **fica em aberto de
> propósito**. Ela é uma decisão de distribuição que muda o fluxo de todo repo de app existente, e
> o ganho que ela traz (`npm outdated` sabendo responder) é o mesmo dos três itens acima, por um
> caminho mais caro. Decidir depois de os três existirem é decidir com o custo real em mãos.

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

`navigator.storage.getDirectory()` e `createSyncAccessHandle` não existem no polyfill. DuckDB-WASM,
sqlite-wasm e Pyodide dependem de OPFS para cache local — é a fundação de metade das ferramentas de
dados client-side.

> **A regra sai junto com a feature:** [OPFS é cache, nunca a verdade](criterios.md#regra-para-autores-de-app-opfs-é-cache-nunca-a-verdade).
> O padrão natural de `sqlite-wasm` é usar OPFS como armazenamento primário, e isso perde tudo ao
> trocar de máquina, sem erro nenhum. Entregar T2 sem a regra é entregar uma armadilha.

### T6 e T7 — as duas dívidas que não tinham onda

O [diagnóstico](diagnostico.md#13-dívidas-do-toolkit) lista nove dívidas do toolkit. Quatro caíram
na Onda 0 (T3, T4, T5, T8), três são as de cima — e **duas não estavam em lugar nenhum**. Passam a
ser desta onda, que é a do toolkit:

| | O que é | Estado |
|---|---|---|
| **T6** | a ponte `fs` do shim não tem `exists`, `rename` nem `copy` — o backend `vssh-app-fs` tem os três | ⬜ o shim expõe `list`/`stat`/`read`/`readBytes`/`write`/`writeBytes`/`mkdir`/`delete`/`watch`. Os três continuam fora, e é o que sobra do bloqueio de **A4** |
| **T7** | `capabilities()` não diz a versão do shell | ✅ **feito** — ver abaixo |
| **T7** | sem `.d.ts` | ⬜ pendente |

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

> **Desta onda é só a metade declarativa**: o campo no manifesto e a validação no
> `vssh-app-publish`. **Quem verifica é o portal**, e por isso a outra metade — o
> `vssh-app-install` recusando antes de instalar, e o painel admin mostrando o que falta por
> servidor — está na
> [Onda 4](04-runtime-composicao.md#requiredpackages--a-metade-que-verifica). O corte não é
> burocrático: o portal já responde essa pergunta para os grupos de pacotes do provisionamento
> (`provision-base.sh --print-packages`, com fixture em `tests/unit/provision-packages.test.js`), e
> a verificação por app nasce ao lado daquilo, não aqui.

### O `minShellVersion` mudou de onda

A metade que **publica** a versão do shell já existe (Onda 2c: `shellVersion` em
`/api/shell/config`). A metade que **consome** — `minShellVersion` / `targetShellVersion` no
manifesto, validação no publish, mensagem honesta quando não bate — saiu daqui e foi para a
[Onda 5, junto com `provides`](04-runtime-composicao.md#o-contrato-do-manifesto-um-schema-uma-validação-uma-guarda).

Não por afinidade temática: **por trabalho de base.** Todo campo novo de manifesto precisa das
mesmas três coisas — entrada no `schema/vssh-app.schema.json`, validação no `vssh-app-publish` e um
consumidor no portal. Fazer isso duas vezes, em duas ondas, é fazer duas vezes a parte cara e
arriscar duas noções do mesmo contrato.

### Ainda em aberto no polyfill

Não implementados e **não documentados como ausentes**: `showOpenFilePicker({multiple:true})`
(sempre devolve array de 1), descritores `types`/`accept`, `startIn`, `FileSystemHandle.move()`,
`removeEntry({recursive:true})`. E `window.FileSystemHandle` recebe um `function(){}` vazio, então
`handle instanceof FileSystemHandle` é **false** para handles reais.
