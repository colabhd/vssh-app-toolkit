# Ondas 0 e 3 — Toolkit: higiene e a FSA de verdade

> **Estado:** Onda 0 concluída · Onda 3 não iniciada · **Atualizado:** 2026-08-01 · **Repo:** toolkit

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

> A tag `v2` precisa ser criada e empurrada para que os defaults novos funcionem. É ação externa —
> feita à parte, com aval explícito.

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

## Onda 3 — A FSA de verdade, e o que o manifesto passa a declarar

> **Estado:** ⬜ não iniciado
> **Destrava:** A3 (visualizador científico), e é o principal bloqueio de A4/A5.
>
> Ganhou dois itens de contrato de manifesto — `minShellVersion` e `requiredPackages` — que não são
> da FSA, mas atravessam a mesma fronteira: **declarações que o ecossistema verifica**, em vez de
> descobertas em runtime. A metade que publica a versão é da
> [Onda 2c](02c-interludio.md#o-que-vem-junto-quase-de-graça).

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

### T9 — Testes de navegador

As falhas estruturais do T1 estão **documentadas mas não testadas**: os testes atuais rodam o código
de navegador num contexto `vm` com stubs manuais, que não reproduzem leituras internas da plataforma.
`electron-shim` e `tauri-shim` não têm teste nenhum.

### O shell tem versão, e o app pode exigi-la

A [Onda 2c](02c-interludio.md#o-que-vem-junto-quase-de-graça) publica uma versão nominal do shell
(`4.x.x`), servida em `/api/shell/config`. **Aqui entra a metade que consome:**
`minShellVersion` / `targetShellVersion` no manifesto, validação no `vssh-app-publish`, e uma
mensagem honesta quando não bate.

O ganho é o de sempre com contrato declarado: hoje um app que usa `vssh.audio` num shell que ainda
não o tem falha em runtime, com `undefined` — e o autor descobre por relato de usuário. Com a
versão declarada, ele descobre no publish.

> **Não versionar por reflexo.** Um `minShellVersion` obrigatório transformaria toda API nova em
> quebra de compatibilidade declarada, que é a burocracia sem o benefício. O padrão é **não
> declarar**, e quem declara está dizendo *"eu uso uma coisa que não existia antes"* — a mesma
> regra do `engines` do npm, pelo mesmo motivo.

### `requiredPackages` — o app diz de que pacote Linux ele precisa

Hoje, um vssh-app que depende de um binário do sistema (`ffmpeg`, `pandoc`, `texlive`, `rclone`)
tem dois caminhos, e os dois são ruins: pôr um `apt-get` no `installCommand` — que roda como root,
uma vez, sem declarar nada a ninguém — ou falhar em runtime com `command not found` no `run.log`.

Proposta: `requiredPackages: ["ffmpeg"]` no manifesto, com três consequências que valem mais que a
instalação em si:

1. **`vssh-app-install` verifica antes de instalar** e recusa com o nome do pacote que falta, em
   vez de instalar um app que não vai subir;
2. **o painel admin mostra o que falta por servidor** — é a mesma pergunta que o provisionamento já
   responde para os grupos de pacotes, agora por app;
3. **o `installCommand` para de ser o lugar onde dependência de sistema se esconde.** Hoje ele é um
   script opaco que roda duas vezes (root e por usuário) e não declara nada — o que torna
   impossível responder *"este app roda neste servidor?"* sem executá-lo.

> **Atravessa a mesma fronteira que `minShellVersion`**, e por isso os dois ficam juntos: são
> declarações do manifesto que o ecossistema **verifica**, não que ele executa. E ambas herdam a
> pergunta que o [registro de capabilities](04-runtime-composicao.md#registro-de-capabilities)
> também enfrenta: o que fazer quando a resposta é "não" — recusar, avisar, ou instalar.

### Ainda em aberto no polyfill

Não implementados e **não documentados como ausentes**: `showOpenFilePicker({multiple:true})`
(sempre devolve array de 1), descritores `types`/`accept`, `startIn`, `FileSystemHandle.move()`,
`removeEntry({recursive:true})`. E `window.FileSystemHandle` recebe um `function(){}` vazio, então
`handle instanceof FileSystemHandle` é **false** para handles reais.
