# Migração

As libs deste toolkit são **vendorizadas e commitadas** pelos apps (`scripts/vssh-app-lib-sync`),
não instaladas em runtime. Isso significa que nada abaixo atinge um app automaticamente: a mudança
só chega quando alguém roda o `lib-sync` de novo, deliberadamente. **Leia a seção da sua major
antes de fazê-lo.**

---

# v3 → v4 — o TCP sai da lib, e um portão toma o lugar dele

A v3 durou pouco de propósito. Ela entregou o socket **e** manteve `VSSH_APP_PORT` como alternativa,
para um app novo sobreviver num servidor cujo `vssh-app-run` fosse velho. Isso era um band-aid, e o
defeito dele é de tempo: **funcionava**, escrevia um aviso num `run.log` que ninguém está lendo, e
deixava a porta exposta enquanto isso. O problema aparecia tarde, longe de quem podia consertá-lo.

Na v4 `escutar()` **só binda socket unix**. O que protege a compatibilidade agora é um portão:

```jsonc
{
  "minShellVersion": "4.1.0",          // a release em que o lifecycle passou a entregar o socket
  "backend": { "runtime": "node", "transport": "socket", … }
}
```

O **portal** confere isso antes de oferecer e de iniciar o app, contra a versão declarada em
`vssh-client/build-info.json`. Um pacote novo num portal antigo é recusado ali, com os dois números
na mensagem — em vez de subir e não receber endereço nenhum.

Quem confere é o portal, e não o `vssh-app-install`, por uma razão simples: o `install` roda no
servidor Linux, e o servidor **não sabe** a versão do portal. Uma conferência que não tem o dado é
uma conferência que se acha feita sem ter sido.

## O que muda no seu app

Se você já migrou para a v3, é uma linha no manifesto (`minShellVersion`) e um `lib-sync`. O código do
backend não muda: `escutar(server)` continua igual.

Se você ainda estava na v2, siga a seção seguinte e já declare o `minShellVersion`.

**Um detalhe do erro, que existe para poupar depuração:** `escutar()` distingue *"não veio endereço
nenhum"* de *"veio só `VSSH_APP_PORT`"*. O segundo não é variável faltando — é um servidor com
`vssh-app-run` anterior à Onda 9, e a mensagem diz isso pelo nome (`VSSH_APP_SERVIDOR_ANTIGO`), em
vez de mandar quem depura procurar no app o que está no provisionamento.

## O único TCP que sobra, e ele tem nome

`backend.transport: "tcp"` continua no schema, e hoje há **um** caso no ambiente: o **xpra**. Medido
na 6.5.2 — o listener de WebSocket dele aceita só `HOST:PORT`, e `--bind-ws=<caminho>` responde
`xpra initialization error`. Ele não usa esta lib (é `runtime: binary`, lê `$VSSH_APP_PORT` no
próprio `entrypoint.sh`), então a saída do ramo TCP daqui não o afeta.

Esse último TCP morre quando o xpra parar de servir o próprio HTML — medido também: com
`--html=off` o WebSocket continua respondendo `101`, então servir o frontend sempre foi papel nosso.

---

# v2 → v3 — o endereço deixa de ser uma porta

**Uma mudança só, e ela é do contrato, não das libs.** Até a v2, o contrato escrito no schema e na
SKILL era *"o backend deve bindar em `127.0.0.1:$VSSH_APP_PORT`"*. Desde a [Onda
9](docs/roadmap/08-editor-do-ambiente.md) o lifecycle pode mandar **`$VSSH_APP_SOCKET`** no lugar —
um socket unix em `~/.vssh-apps/<id>/`, diretório que já é 0700.

**Por que isso é major, e não minor.** Nenhuma função da v2 mudou de comportamento. O que muda é o
que chega no ambiente do processo: um app parado na v2 lê `VSSH_APP_PORT`, não acha nada, e ou morre
no boot ou binda uma porta que ninguém procura. **O sintoma é janela em branco, não erro** — e é
exatamente o modo de falha que o gate de major do `vssh-app-publish` existe para converter numa
publicação recusada, com o comando do conserto junto.

**O motivo de fundo, medido.** Numa conta comum de `ipprivm01`, das **23 portas de vssh-app** em
escuta no loopback, **14 responderam a um `GET /` sem token** — 10 com `200` e 4 com `500` —, e
**12 eram de outras contas Linux**. O loopback é compartilhado por definição; o `X-Vssh-App-Token`
existe para isso, mas conferi-lo sempre foi opcional. Permissão de arquivo faz o que a conferência
de token só prometia.

## O que fazer no seu app

```bash
vssh-app-lib-sync . --parts <as suas>,listen --dest backend/vendor/vssh
```

E no backend, troque o `listen` por `escutar()`:

```js
const { escutar } = require('./vendor/vssh/node/app-listen');

// era: server.listen(PORT, '127.0.0.1', () => { … })
escutar(server)
  .then(({ transporte, endereco }) => log('listening', { transporte, endereco }))
  .catch((err) => {
    // Já há outra instância atendendo: é o contrato do lifecycle, que sai 0 no mesmo caso.
    if (err.code === 'VSSH_APP_JA_ESCUTANDO') process.exit(0);
    process.exit(1);
  });
```

Tire também a conferência de `VSSH_APP_PORT` do boot, se você tiver uma: **exigir a porta recusa um
app perfeitamente configurado em socket**. Quem confere passa a ser o `escutar()`, e ele nomeia as
duas variáveis quando não vem nenhuma.

## As três armadilhas que o `escutar()` resolve por você

1. **O arquivo de socket sobrevive ao processo.** Com TCP, morrer devolve a porta ao kernel; com
   socket unix o inode fica, e o `bind()` seguinte falha com `EADDRINUSE` contra um arquivo que
   ninguém atende. Um `test -S` responderia "está rodando" para um app que morreu semana passada, e
   por isso a checagem é uma **tentativa de conexão** — um socket vivo nunca é apagado. Medido:
   fechar limpo já apaga o arquivo sozinho, então **só `SIGKILL` produz órfão** — que é justamente o
   caso do supervisor com `MAX_FAILS`.
2. **O modo do arquivo vem do umask**, e um umask 0022 cria o socket `0755`. O diretório 0700 já
   protege; o `chmod 0600` é a segunda defesa, para o dia em que o diretório mudar por outra razão.
3. **`listen(caminho)` e `listen(porta, host)` têm assinaturas diferentes**, e um `if` em cada app é
   o começo de N implementações que divergem.

## O TCP não foi apagado — ele passou a se anunciar

`escutar()` continua aceitando `VSSH_APP_PORT`, e é isso que torna a migração segura em **qualquer
ordem de deploy**: um app já na v3 sobe num servidor cujo `vssh-app-run` ainda é anterior à Onda 9.
Mas ele escreve no stderr dizendo que aquele servidor está atrás, porque legado silencioso é como um
ramo desses atravessa anos — ninguém sabe se ainda há alguém usando, então ninguém apaga.

Se o seu app escolheu TCP **de propósito** (`backend.transport: "tcp"` no manifesto, para um runtime
que não sabe bindar socket unix), passe `escutar(server, { tcpEsperado: true })` e o aviso silencia.
A escolha declarada não é o defeito que ele persegue.

## Nota para quem opera

`vssh-app-lib-sync` passou a puxar de **`v3`** por padrão. Um `--ref v2` continua funcionando e
continua entregando as libs antigas — o que ele não entrega é o `app-listen.js`.

---

# v1 → v2

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
bash scripts/vssh-app-lib-sync <dir-do-app> --parts fs,spa,log,sse --dest backend/vendor/vssh
bash scripts/vssh-app-lib-sync <dir-do-app> --parts web            --dest frontend/vendor/vssh
```

**Dois destinos.** As libs de `node/` são `require()`adas pelo backend; as de `web/` são carregadas
pelo navegador e precisam estar sob a raiz que o `static-spa` serve, senão a tag injetada por
`injectScripts` aponta para 404.

**O default de `--ref` passou a ser `main`.** Antes era `v1`, e a tag `v1` aponta para um commit
anterior à criação de `lib/` — fora de um clone, o sync falhava com "lib/ não encontrado no tarball".
Ver [`docs/roadmap/03-toolkit.md`](docs/roadmap/03-toolkit.md).

Depois de sincronizar, revise o diff e rode o app contra os quatro primeiros itens desta página.
`.vssh-lib-version` (em cada destino) registra de onde veio a cópia.
