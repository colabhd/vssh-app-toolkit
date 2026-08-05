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

> **Estado:** ⬜ não iniciado
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

As falhas estruturais do T1 estão **documentadas mas não testadas**: os testes atuais rodam o código
de navegador num contexto `vm` com stubs manuais, que não reproduzem leituras internas da
plataforma. `electron-shim` e `tauri-shim` não têm teste nenhum.

O critério de pronto não é "existe um runner": é **o T1 falhando de verdade** neste instrumento
antes de ser consertado. Um teste que passa com o `super([])` no lugar não mede o que precisa
medir.

### T1 — `LazyFile` é um `Blob` vazio

`lib/web/fsa-polyfill.js:65` constrói `LazyFile extends Blob` com `super([])`. A sequência interna
de bytes fica vazia, e **tudo que lê o `Blob` pelo caminho da plataforma devolve 0 bytes, em
silêncio**:

| Falha | Funciona |
|---|---|
| `new Response(f)` | `.text()` |
| `new Blob([f])` | `.arrayBuffer()` |
| `FileReader.*` | `.stream()` |
| `FormData.append` | `.bytes()` |
| `f.slice()` — **lança** | `URL.createObjectURL` (interceptado) |

`slice()` é o mais grave: é a **operação primária** de qualquer leitor de Parquet, HDF5, Zarr ou
DICOM, que lê por range em vez de carregar o arquivo. Enquanto ele lançar, o arquétipo A3 está
bloqueado.

O conserto é dar respaldo real de bytes ao `LazyFile` — carregamento sob demanda com `Blob`
construído a partir do range HTTP, e `slice()` virando um range novo em vez de exceção.

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

| | O que é | Estado conferido em 2026-08-05 |
|---|---|---|
| **T6** | a ponte `fs` do shim não tem `exists`, `rename` nem `copy` — o backend `vssh-app-fs` tem os três | `lib/web/vssh-app-shim.js:369` expõe `list`/`stat`/`read`/`readBytes`/`write`/`writeBytes`/`mkdir`/`delete`/`watch`. Os três continuam fora, e é o que sobra do bloqueio de **A4** |
| **T7** | sem `.d.ts`; `capabilities()` não diz a versão do shell | a versão **existe e é servida** desde a Onda 2c — falta o shim expô-la |

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
