# vssh-app-fs

Expõe um diretório do servidor ao frontend de um vssh-app, por HTTP.

Nasceu dentro do `vsshapp-logseq` e **foi promovida ao `vssh-app-toolkit`** — o critério era um
segundo app usá-la sem editar nada deste diretório, e foi o que aconteceu. Continua escrita como peça
independente: nenhuma linha aqui menciona Logseq, nenhuma lê variável de ambiente, nenhuma
dependência npm.

```
index.js   API pública
ops.js     as operações, sem transporte
paths.js   resolução de caminho confinada à raiz
http.js    adaptador node:http do contrato de wire
test/      node:test, roda contra diretório temporário
```

## API

```js
const { createAppFs, createFsHandler } = require('./vssh-app-fs');

const graphFs = createAppFs({
  root: '/home/fulano/Documents/logseq', // criado se não existir; resolvido com realpath
  contentExtensions: ['md', 'org', 'edn'], // extensões cujo conteúdo entra em open-dir/get-files
  ignore: { prefixes: [], exact: [], dirNames: [], suffixes: [], hidden: true },
  recycleDir: 'logseq/.recycle',           // destino do unlink
  maxContentBytes: 16 * 1024 * 1024,
  onWarn: (event) => console.error(event),
});

const handler = createFsHandler({
  fs: graphFs,
  mountPath: '/api/fs',
  assetsPrefix: '/assets/',
  requireToken: process.env.VSSH_APP_TOKEN, // null desliga a checagem
});

// no request handler do app:
if (await handler(req, res, url)) return; // true = atendeu
```

`createAppFs` também expõe `root` (o caminho já resolvido) e `openRead(path)`, usado pelo
adaptador para servir binário sem passar por JSON.

Os defaults de `contentExtensions` e `ignore` estão em `ops.js` (`DEFAULT_CONTENT_EXTENSIONS`,
`DEFAULT_IGNORE`) e são **genéricos** desde a promoção ao toolkit. As regras específicas do Logseq
(que antes eram o default) viraram um preset — ver `presets/logseq.js` e `MIGRATION.md`. São
defaults, não política da lib: outro app passa os seus.

## Contrato de wire

### `POST <mountPath>`

Corpo JSON com `op` e os parâmetros da operação. Resposta `{"ok": true, "result": …}` em caso de
sucesso, `{"ok": false, "error": {"code": …, "message": …}}` em caso de erro.

| `op` | parâmetros | `result` |
|---|---|---|
| `exists` | `path` | `{exists: bool}` — 200 nos dois casos |
| `stat` | `path` | `{type, size, mtime}` |
| `read-file` | `path` | `{content}` |
| `write-file` | `path`, `content` | `{path, size, mtime}` |
| `mkdir` | `path` | `{}` (diretório já existente não é erro) |
| `mkdir-recur` | `path` | `{}` |
| `readdir` | `path` | `[path]` — recursivo, sem ocultos, sem filtro de extensão |
| `unlink` | `path` | `{recycled}` — move, não apaga |
| `rename` | `from`, `to` | `{}` |
| `copy` | `from`, `to` | `{}` (sobrescreve sem confirmar) |
| `open-dir` | `path` (opcional) | `{path, files: [{path, content, size, mtime, type}]}` |
| `get-files` | `path` | idem `open-dir` |

Convenções que valem para todas as ops:

- `path` pode ser relativo à raiz (`pages/a.md`) ou absoluto (`/home/x/graph/pages/a.md`). As duas
  formas aparecem porque o Logseq usa o caminho absoluto do grafo como identidade do repo.
- `mtime` é epoch em milissegundos. `type` é `"file"` ou `"directory"`.
- Arquivo acima de `maxContentBytes` é **omitido** de `open-dir`/`get-files` (continua legível por
  `read-file`). Listá-lo com conteúdo vazio seria pior: para o app ele pareceria um arquivo vazio, e
  o primeiro save por cima apagaria o conteúdo real no disco.
- `open-dir`/`get-files` devolvem **só** as extensões de `contentExtensions`, sempre com conteúdo.
  Binários (imagem, PDF) não entram aqui; são servidos por `GET <assetsPrefix>`.

### `POST <mountPath>/write-binary?path=…`

Corpo cru (não JSON), para upload de asset. Mesma resposta de `write-file`.

### `GET <assetsPrefix><caminho>`

Devolve o arquivo com `Content-Type` por extensão, `Last-Modified` e `Accept-Ranges: bytes`.
Suporta um intervalo de `Range` (`bytes=a-b` e `bytes=-n`), respondendo `206`, ou `416` com
`Content-Range: bytes */<tamanho>` quando o início passa do fim do arquivo. É o que faz o pdf.js
não baixar um PDF inteiro para mostrar a primeira página.

### Códigos de erro

O corpo do erro traz `{code, message, op}`.

| `code` | HTTP | quando |
|---|---|---|
| `ENOENT` | 404 | caminho não existe |
| `EACCES`, `EPERM` | 403 | caminho fora da raiz, token ausente/inválido, permissão do filesystem |
| `EINVAL` | 400 | caminho malformado, op desconhecida, corpo grande demais, conteúdo que não é texto nem bytes, escrita sobre diretório |
| `EISDIR`, `ENOTDIR`, `ENAMETOOLONG`, `ELOOP` | 400 | o caminho pedido não pode ser o que o cliente quis |
| `EEXIST` | 409 | conflito |
| — | 405 | método errado na rota |
| resto (`ENOSPC`, `EIO`, `EMFILE`, bug) | 500 | falha do servidor |

### `exists` versus `stat`

As duas respondem sobre um caminho ausente, e a diferença é de propósito:

- `stat` pergunta "me dê os metadados". Se o caminho não existe, **não há resposta** — `ENOENT`/404
  é o certo.
- `exists` pergunta "existe?". Ausência **é** a resposta, então vem `200 {"exists": false}`.

Sem a segunda, quem só quer saber se o arquivo está lá usa o erro da primeira como fluxo de
controle, e toda sondagem de rotina vira ruído de erro nos dois lados: linha vermelha no console do
navegador e linha de falha no log do app. Foi o que aconteceu aqui — três sondagens normais por
sessão passaram por sintoma durante a depuração. Por isso o log também marca `expected: true` nas
falhas ENOENT que sobram.

Caminho fora da raiz continua sendo `EACCES` mesmo em `exists`: responder `false` já contaria que a
lib foi olhar, e `true` vazaria a existência de um arquivo que não é da conta do chamador.

A fronteira entre 400 e 500 é deliberada: **500 significa "o servidor não sabe o que aconteceu"**, e
isso só é informação útil se a lista do que ele sabe for honesta. Um errno de caminho inválido caindo
em 500 manda quem depura investigar o lado errado — foi exatamente o que aconteceu com um `EISDIR`
não mapeado. Por isso o `onWarn` anexa `stack` só ao que cai em 500: nos erros classificados a pilha
é sempre a mesma e não acrescenta nada.

## Modelo de segurança

O backend roda como o próprio usuário Linux dono da sessão — mesmo modelo de confiança do
code-server e do Xpra. Não há privilégio a proteger do usuário dele mesmo. As duas coisas que esta
lib protege são outras:

**Confinamento à raiz.** Todo caminho recebido passa por `resolveInRoot`, que resolve o ancestral
existente mais próximo com `realpath` e recusa se o resultado sair da raiz. Isso cobre `..`,
caminho absoluto de fora, e symlink dentro do grafo apontando para fora — inclusive quando o
arquivo final ainda não existe (caso de escrita). A listagem também descarta symlinks, então um
link para fora não vaza nem por leitura nem por gravação.

**Origem da requisição.** Com `requireToken`, toda rota exige `X-Vssh-App-Token` igual ao
`$VSSH_APP_TOKEN` que o portal injeta em tudo que encaminha para o app. A porta é loopback, mas
qualquer outro processo do mesmo usuário Linux alcança, e este handler dá leitura e escrita no
grafo. A comparação é feita sobre o SHA-256 dos dois lados com `timingSafeEqual`, para não vazar
prefixo coincidente pelo tempo nem quebrar com comprimentos diferentes.

**⚠ Estava escrito aqui que o healthcheck "bate direto na porta, sem passar pelo proxy, então não
tem o header", e isso está errado desde a Onda 4:** a sondagem do lifecycle vai **com** o
`X-Vssh-App-Token`. Deixar o healthcheck de fora da checagem continua sendo escolha de quem monta o
handler — e não custa nada, porque a rota só devolve `ok` —, mas **não é mais obrigatório**, e não
há motivo para isentar qualquer outra. Ver `backend/server.js`.

## Portar para outro runtime

O `python3` é o runtime que a SKILL do toolkit prefere (já é exigido pelo `vssh-app-install`, e não
depende de um `nvm` pessoal aparecer no PATH de um exec SSH não-interativo). Para portar:
`ops.js` + `paths.js` são a semântica que precisa ser reproduzida, `http.js` é só o adaptador. O
contrato de wire acima é a fronteira — um frontend que fala com a versão node fala com a versão
python sem alteração.

## Testes

No toolkit, junto do resto das libs:

```
npm test                      # = node --test "lib/**/*.test.js"
```

Vendorizada no repo de um app, aponte para onde ela foi parar:

```
node --test "backend/vendor/vssh/node/vssh-app-fs/test/*.test.js"
```

Rodam contra `mkdtemp`, sem nenhuma variável de ambiente do VSSH. Se um teste daqui precisar de
uma, a fronteira da lib vazou.

> `mkdtemp` é justamente o caso que expôs um bug de confinamento no `static-spa` irmão: no Windows o
> TEMP tem nome curto 8.3, e canonicalizar a raiz e o alvo com funções diferentes de `realpath` fazia
> as duas grafias nunca casarem. Se for portar `paths.js`, canonicalize os dois lados com a **mesma**
> função.
