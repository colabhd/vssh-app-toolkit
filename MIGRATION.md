# Migração — v1 → v2

As libs deste toolkit são **vendorizadas e commitadas** pelos apps (`scripts/vssh-app-lib-sync`),
não instaladas em runtime. Isso significa que nada abaixo atinge um app automaticamente: a mudança
só chega quando alguém roda o `lib-sync` de novo, deliberadamente. **Leia esta página antes de
fazê-lo.**

Escopo: dos commits `7a71abd` (tag `v1`) até `5f0361d`.

## Ordem de leitura

Se você só quer saber o que pode quebrar hoje, os quatro primeiros itens respondem por quase todo o
risco real. O resto é comportamento novo que você provavelmente quer.

---

## 1. `getFile()` devolve um `LazyFile` — e ele mente por omissão

`fsa-polyfill.js`. Antes, `getFile()` buscava os bytes e devolvia um `File` real. Agora devolve um
`Blob` cuja sequência interna de bytes está **vazia** até alguém chamar `arrayBuffer()`/`text()`.

O que quebra, **em silêncio, devolvendo 0 bytes**:

```js
new Response(file)      // 0 bytes
new Blob([file])        // 0 bytes
FileReader.readAsText() // vazio
formData.append(k, file) // 0 bytes
```

Saída: materialize antes. `new Blob([await file.arrayBuffer()])`.

Dois efeitos colaterais adicionais: `file.type` é sempre `''` (um `File` real inferia o MIME — se
seu app ramifica por tipo, ele passa a cair no default), e `slice()` **lança** se o conteúdo não foi
lido antes, coisa que um `File` real nunca fazia.

## 2. `queryPermission()` parou de responder sempre `'granted'`

`fsa-polyfill.js`. Antes era literalmente `return 'granted'`. Agora consulta o shell e pode devolver
`'prompt'`.

O impacto não é o valor em si — é que **o caminho de código "pedir permissão de novo", que nunca
executava, passa a executar**. Se ele nunca foi testado no seu app, é agora que você descobre.

Junto disso, `requestPermission()` ganhou efeito colateral: **reabre o seletor de arquivos**. Antes
era função pura. Chame-o **a partir de um gesto do usuário** — sem gesto ele devolve `'prompt'` sem
abrir nada (regra do navegador, checada via `navigator.userActivation`). Um app que trate `'prompt'`
como "tentar de novo" entra em laço sem progresso.

## 3. "Não sei" agora vale `'granted'` (era `'prompt'`)

`fsa-polyfill.js`, a mudança mais sutil do lote. Quando o shell é antigo (não conhece a mensagem
`grants`), erra, ou dá timeout, `queryPermission()` responde **`'granted'`**.

A escolha é deliberada — assumir negação num shell que simplesmente não sabe responder trancava o
app fora de arquivos que o usuário havia concedido. Mas se o seu app usava `'prompt'` nesses casos
como sinal de "reconceda", ele deixa de reconceder.

## 4. Timeout padrão: `0` → 600 000 ms

`vssh-app-shim.js`. Toda promise de `dialog`, `pick*`, `open-with`, `fs.*` e `context-menu` que
antes ficava **pendurada para sempre** agora **rejeita** em 10 min com
`Error("sem resposta do shell para '<type>'")`.

Isso é uma melhoria, mas muda o que seu código vê: onde havia silêncio, passa a haver rejeição.
Chamadas sem `.catch()` viram unhandled rejections. `contextMenu` foi de 120 s para 600 s.

---

## 5. `isGranted()` virou tri-estado

`vssh-app-shim.js`. Assinatura: `boolean` → **`boolean | null`**, onde `null` = "não sei" (erro,
timeout, ou fora do desktop — que antes devolvia `false`).

Quebra comparações estritas (`=== false`) e anotações de tipo. Aceita `{ mode }` agora.

## 6. `createWritable()` devolve um `WritableStream` real

`fsa-polyfill.js`. Era um objeto literal `{write, seek, truncate, close}`. `pipeTo()` passou a
funcionar; em compensação `stream.write()` chama `getWriter()` e **trava o stream**, então misturar
`write()` e `pipeTo()` no mesmo writable falha. Aceita `{ keepExistingData }`.

## 7. Escrita binária mudou de rota — e exige o shell novo

`fsa-polyfill.js`. Antes todo chunk virava `fs.write(path, await blob.text())`, o que **corrompia
qualquer binário** (PNG, zip). Agora chunks não-string vão para `fs.writeBytes`.

Requer que o host implemente `op: 'writeBytes'`. Contra um shell antigo, falha (e, desde o item 4,
falha por timeout em vez de pendurar).

## 8. `URL.createObjectURL` é interceptado globalmente

`fsa-polyfill.js`. Para um `LazyFile` devolve uma **URL HTTP** (`/{slug}/api/fs/read?path=...`),
não um `blob:`. Código que verifica o prefixo `blob:`, ou que exige um blob URL de verdade, quebra.
`revokeObjectURL` vira no-op para tudo que não começa com `blob:`.

## 9. `readdir()` não filtra mais por `ignore`

`lib/node/vssh-app-fs/ops.js`. `applyIgnore` passou a ser **opt-in**. Quem dependia do filtro passa
a receber mais entradas — inclusive `node_modules` e `.git`.

## 10. Os defaults do Logseq saíram da lib

`lib/node/vssh-app-fs/`. `createAppFs({root})` agora usa defaults genéricos. Para o comportamento
anterior: `createAppFs({ root, ...LOGSEQ_PRESET })` (de `presets/logseq.js`).

Junto: `walk()` passou a honrar `ignore.hidden`, `unlink()` aceita `{ recycle }`, e alguns erros
foram reclassificados de 500 para 400 (`EINVAL` em `decodeURIComponent` inválido, `EISDIR` ao
escrever sobre diretório).

## 11. `document.title` é espelhado automaticamente

`vssh-app-shim.js`. Um `MutationObserver` passa a emitir `postMessage type:'title'` a cada troca.
Sem opt-out.

---

## Superfície nova (aditiva, não quebra nada)

- `vssh.fs.watch(path, cb) → Promise<stopFn>` — avisa quando um arquivo muda **por fora** do app.
  Cancelar importa: cada watch segura um vigia vivo no servidor, e o teto é de 4 caminhos por
  (servidor, usuário).
- `vssh.fs.urlFor(path)` — síncrona, devolve URL HTTP servível direto em `<img>`/`<video>`.
- `vssh.setTitle()`, `vssh.window.{minimize,maximize,restore,focus,close}`, `vssh.contextMenu()`.
- `docs/api.md` — referência completa do que existe e, na seção final, do que **não** existe.

## Reidratação de handles do IndexedDB, muito ampliada

Antes: só `IDBObjectStore.get`/`getAll`, um nível. Agora cobre também `IDBIndex` e cursores
(`openCursor`), descendo recursivamente em objetos e arrays até 4 níveis.

Efeito colateral a conhecer: quando há um handle dentro, **a identidade do objeto muda** — seu app
recebe uma cópia rasa, não o objeto que o IDB guardou. `getAllKeys` ficou deliberadamente de fora.

---

## Como atualizar

```bash
bash scripts/vssh-app-lib-sync <dir-do-app> --parts <...> --ref main
```

**Use `--ref main`, não o default.** O default é `--ref v1`, e a tag `v1` aponta para um commit
anterior à criação de `lib/` — fora de um clone, o sync falha com "lib/ não encontrado no tarball".

Depois de sincronizar, revise o diff e rode o app contra os quatro primeiros itens desta página.
`backend/vendor/vssh/.vssh-lib-version` registra de onde veio a cópia.
