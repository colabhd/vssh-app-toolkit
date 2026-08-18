# vssh-app-toolkit

Ferramentas **públicas** para construir e publicar **vssh-apps** do desktop remoto
VSSH-SSO — um ambiente de desktop completo renderizado no navegador, sem nada instalado na máquina
de quem o usa. Um vssh-app é um pacote self-contained
— frontend HTML + backend próprio, em qualquer linguagem — que roda como processo no servidor Linux
do usuário e aparece como uma janela dentro do desktop. Você desenvolve **fora** do repositório do
portal e publica um tarball no repositório de artefatos (Cloudflare Worker D1/R2); um admin instala
com `vssh-app-install`.

Este repositório é público **de propósito**: assim o workflow de publicação é chamável de qualquer
repo de app (de uma org **ou** de uma conta pessoal) e o script é baixado com o `GITHUB_TOKEN`
padrão — **sem nenhum PAT/GitHub App**.

## O que tem aqui

| Caminho | O quê |
|---|---|
| [`.claude/skills/vssh-app/SKILL.md`](.claude/skills/vssh-app/SKILL.md) | **Referência de autoria** (manifest, convenção de diretório, env vars, tipos `engine`, `richChrome`, `handles`, loop de teste, instalação/upgrade). Comece por aqui. |
| [`lib/`](lib/) | **Bibliotecas compartilhadas** — o que todo app reimplementava. Ver abaixo. |
| [`scripts/vssh-app-publish`](scripts/vssh-app-publish) | Empacota + publica um app no Worker. Roda em CI e localmente. |
| [`package.json`](package.json) | Este repositório **é** o pacote npm das libs: `npm i github:colabhd/vssh-app-toolkit#v4`. Não há mais script de cópia. |
| [`.github/workflows/_publish-app-reusable.yml`](.github/workflows/_publish-app-reusable.yml) | Reusable workflow que o CI do seu repo de app chama com um `uses:`. |
| [`templates/hello-vssh-app/`](templates/hello-vssh-app/) | Template **Python** e galeria. Copie e adapte. |
| [`templates/hello-vssh-app-node/`](templates/hello-vssh-app-node/) | Template **Node** e galeria. O mesmo app, no outro runtime — [ver abaixo](#os-dois-templates-são-o-mesmo-app). |
| [`docs/api.md`](docs/api.md) | **Referência de API** — o que o app pode pedir ao ambiente: janela, título, diálogos, menu de contexto, seletores, arquivos, abas. E o que não existe. |
| [`docs/porting.md`](docs/porting.md) | Portar um app web/Electron/Tauri: árvore de decisão e como medir o buraco em minutos. |
| [`docs/lessons/logseq-port.md`](docs/lessons/logseq-port.md) | O que portar um app real ensinou — a origem da maioria das regras acima. |
| [`docs/ui.md`](docs/ui.md) | A biblioteca de UI: paleta, componentes, ícones e as peças de mídia. |
| [`docs/testes.md`](docs/testes.md) | Como se escreve teste aqui — e o que não se escreve. |
| [`docs/decisoes/`](docs/decisoes/) | As razões longas: [publicação](docs/decisoes/publicacao.md) e os [três critérios de projeto](docs/decisoes/criterios-de-projeto.md). |

## Os dois templates são o mesmo app

`templates/hello-vssh-app/` (Python) e `templates/hello-vssh-app-node/` (Node) são **o mesmo app em
dois runtimes**: mesmas peças, mesmas rotas, e o `frontend/galeria.js` byte a byte idêntico. A
escolha entre eles é de **linguagem**, e mais nada.

Isso é medido, não prometido: [`tests/galeria-paridade.test.js`](tests/galeria-paridade.test.js)
reprova qualquer deriva — peça nova num lado, rota que existe só no outro, manifesto que declara
uma capacidade a menos. E não é zelo abstrato: até a v4 o template Python ficou congelado na v2,
lendo uma variável de ambiente que já não existia, **morrendo com `KeyError` antes de escutar**.
Ninguém percebeu porque nada media a distância entre os dois.

> **A galeria é para instalar, não só para ler.** Cada peça responde "este servidor faz isto?", e a
> primeira delas (*Ambiente*) mostra a versão do shim que o app carrega ao lado da versão do shell
> daquele servidor — o que explica quase toda ausência. Instale os dois lado a lado e compare os
> runtimes com as mãos; os `id` são distintos justamente para isso.
>
> Ao copiar um deles para um app seu, apague `frontend/galeria.js`, as peças de
> `frontend/index.html` e as rotas `api/*` que não forem suas — o que sobra é o mínimo.

Uma segunda guarda,
[`tests/galeria-cobertura.test.js`](tests/galeria-cobertura.test.js), enumera a superfície real do
`vssh` em runtime e exige que **cada membro apareça em alguma peça** das duas galerias. As exceções
são nomeadas com o motivo no próprio arquivo, e uma exceção que perca a API que a justificava
reprova junto. Sem ela a galeria envelhece em silêncio, e não em tese: ela já esteve cobrindo um
terço da superfície, com as quatro APIs mais recentes do toolkit sem uma peça sequer. Nada estava
quebrado — cada bump publicou uma capacidade, documentou-a, e não havia o que pudesse ficar
vermelho.

## Bibliotecas (`lib/`)

Nenhuma tem dependência externa e nenhuma lê variável de ambiente por conta própria: quem traduz o
ambiente VSSH em config é o backend do app.

**São instaladas pelo gerenciador de pacotes do seu runtime**, e importadas por subcaminho:

```bash
npm i github:colabhd/vssh-app-toolkit#v4                                     # Node
pip install "https://github.com/colabhd/vssh-app-toolkit/archive/refs/tags/v4.tar.gz"   # Python
```

```js
const { escutar } = require('vssh-app-toolkit/listen');   // /log /spa /sse /fs /tray /notify /live /web
```
```python
from vssh_app_toolkit.listen import criar_servidor        # .log .spa .sse .fs .tray .notify .live .web
```

> **O tarball, e não `git+https://`.** Ele dispensa `git` no servidor-alvo — a mesma propriedade
> que o `npm ci` tem e que foi medida (`node:22-slim` sem git e sem ssh, 1 s). Um alvo que precise
> de `git` para instalar uma dependência é um alvo a menos onde o seu app roda.

> **Isto aqui dizia o contrário até a v4, e vale dizer por que mudou.** A regra era *"são
> vendorizadas, não instaladas"*, com o `vssh-app-lib-sync` copiando `lib/` para dentro do repo do
> app e um `.vssh-lib-version` carimbando a idade da cópia. O argumento — o publish empacota o que
> está versionado — continua verdadeiro, e **não era o problema**. O problema foi este: o script
> tinha o ref default escrito à mão (`REF="v3"`), a v4 saiu, a linha ficou para trás, e dois apps
> sincronizaram libs 3.0.0 contra um toolkit 4.0.0 sem nada avisar até o CI. Um mecanismo de
> versão feito em casa tinha a própria versão para esquecer.
>
> Com npm, "que versão é esta?" tem uma resposta só, e ela vem do `package-lock.json`. O que o
> publish continua fazendo é o portão de major — só que lendo o `package.json` que o npm
> instalou, e não um marcador que alguém precisava lembrar de atualizar.
>
> **E as libs de `lib/web/`, que o navegador carrega?** Elas ficam no `node_modules`, fora da raiz
> da SPA. Quem resolve isso é o `mounts` do `static-spa` — mesma confinação, mesmo 304, mesmo
> carimbo de conteúdo que o bundle tem. Ver [Ligando ao seu app](#ligando-ao-seu-app).

### Backend (`lib/node/` e `lib/python/`) — importadas pelo seu processo

**As duas árvores têm as mesmas nove peças, com as mesmas garantias.** Não é coincidência de
escopo: cada uma resolve uma armadilha que já mordeu, e uma armadilha do socket unix não deixa de
existir porque o backend é Python.

| Peça | `lib/node/` | `lib/python/` | Para quê |
|---|---|---|---|
| endereço | `app-listen.js` | `listen.py` | Bindar onde o lifecycle mandou: socket unix, órfão limpo **por tentativa de conexão** (nunca por `exists`, que derrubaria a instância viva), modo 0600 contra o umask, erro nomeado para "já está escutando". |
| log | `app-log.js` | `log.py` | Log estruturado em `$VSSH_APP_DATA_DIR`. Vinte linhas que se pagam na primeira depuração remota. |
| SPA | `static-spa.js` | `spa.py` | Serve uma SPA sob o prefixo do proxy: content-type, 304, `mounts`, prefixos alias, fallback de SPA, e o **carimbo de conteúdo** na URL do que é injetado. |
| SSE | `sse.js` | `sse.py` | Eventos com os cabeçalhos que sobrevivem ao proxy e ao CDN (`X-Accel-Buffering: no` + flush). Sem eles, os eventos chegam em lote — ou nunca, sem erro nenhum. |
| filesystem | `vssh-app-fs/` | `fs/` | Filesystem **privado** do app por HTTP: 12 ops, confinamento à raiz com `realpath`, binário com `Range`, gate de token resistente a timing, errno classificado (4xx × 500 honesto). |
| bandeja | `vssh-tray.js` | `tray.py` | Ícone na bandeja para app **sem janela**; escrita atômica, e o clique volta como POST no seu backend. |
| notificação | `vssh-notify.js` | `notify.py` | Avisar do backend, inclusive com o desktop fechado. Cuida do `id`, que é a chave de deduplicação de ponta a ponta. |
| atividade | `vssh-live.js` | `live.py` | "O que está acontecendo agora", com barra — e o `at` renovado, sem o qual a barra some no meio. |
| libs de navegador | `web-assets.js` | `web.py` | O diretório dos `.js` que o navegador carrega, para o `mounts` do SPA. |

> **As libs de NAVEGADOR não têm — nem precisam de — versão Python.** O shim é o mesmo arquivo,
> servido ao mesmo navegador; o que muda entre um app Node e um app Python é só **quem o serve**.
> No pacote Python eles viajam dentro do wheel, e `vssh_app_toolkit.web.DIRETORIO_WEB` aponta para
> lá. Um app Python com o `vssh` completo é, portanto, uma questão de montar o diretório certo — e
> não de portar 2.200 linhas de JavaScript.

### Frontend (`lib/web/`) — carregadas pelo navegador, por tag `<script>`

É a superfície inteira de API do cliente, e vale igual nos dois runtimes. Referência completa em
[`docs/api.md`](docs/api.md).

| Peça | Para quê |
|---|---|
| `lib/web/vssh-app-shim.js` | **A ponte com o desktop**: `vssh.dialog`, `vssh.notify`, `vssh.pickFile`, `vssh.fs`, `vssh.window`, `vssh.contextMenu`, `vssh.tabs`, `vssh.capabilities`. Fora do desktop cada função **degrada** para o equivalente do navegador em vez de lançar. |
| `lib/web/vssh-app-shim.d.ts` | Os tipos da superfície acima, como **declaração global** (o shim entra por `<script>`). Basta incluir no `tsconfig.json`. Conferido contra a superfície real em runtime, nos dois sentidos — ver [`docs/api.md`](docs/api.md#typescript). |
| `lib/web/fsa-polyfill.js` | File System Access API (`showDirectoryPicker()` e cia.) sobre o `/api/fs/*` do portal — um web app que já usa FSA roda **sem fork**. Requer o shim carregado antes. ⚠ Tem limites conhecidos, e eles estão medidos: veja [o que ele faz e o que não faz](docs/api.md#o-que-o-polyfill-faz-e-o-que-ele-não-faz) antes de depender dele. |
| `lib/web/electron-shim.js` | Superfície padrão do Electron (`dialog`, `shell`, `clipboard`, `Notification`, controles de janela) mapeada para o shim. Para portar um app Electron sem reescrever as chamadas. |
| `lib/web/tauri-shim.js` | Idem para a superfície padrão do Tauri (`fs`, `dialog`, `shell`, `notification`, `path`). |
| `lib/web/tuff/` | **A biblioteca de UI** — a estética do ambiente, do lado do app: paleta, tipografia, 19 componentes, 87 ícones, gaveta de navegação e as peças de mídia. Um app que a adota se parece com o ambiente em vez de parecer uma página web dentro de uma janela. Ver [`docs/ui.md`](docs/ui.md). |

> **Por que uma biblioteca de UI, e não só documentação.** O critério 3.3 do ecossistema
> ([`docs/decisoes/criterios-de-projeto.md`](docs/decisoes/criterios-de-projeto.md#3--está-belo)) é condição de pronto — *"a
> promessa é que o usuário esqueça que está num navegador"* — e ele **passou a alcançar todo
> vssh-app**. Mas cobrar sem entregar vocabulário é pedir que cada autor redescubra 2800 linhas de
> CSS que já existem noutro repositório: um app já pagou esse custo à mão, em 259 linhas, e a ponte
> que ele escreveu junto **apodreceu em silêncio** — ela escuta uma mensagem que o shell removeu.

### Ligando ao seu app

```js
// Node
const { createStaticSpa } = require('vssh-app-toolkit/spa');
const { WEB_DIR, SHIMS } = require('vssh-app-toolkit/web');

const spa = createStaticSpa({
  root: path.join(__dirname, '..', 'frontend'),
  mounts: { '/_vssh/': WEB_DIR },                       // as libs de navegador, do node_modules
  injectScripts: SHIMS.map((s) => `_vssh/${s}`),        // a ordem já vem certa em SHIMS
});
```

```python
# Python
from vssh_app_toolkit.spa import criar_spa_estatica
from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS

spa = criar_spa_estatica(
    root=os.path.join(AQUI, "..", "frontend"),
    mounts={"/_vssh/": DIRETORIO_WEB},                  # as libs de navegador, do pacote instalado
    inject_scripts=[f"_vssh/{s}" for s in SHIMS],       # a ordem já vem certa em SHIMS
)
```

**A parte que todo mundo esquece, e que o `mounts` existe para resolver:** as libs de `lib/web/`
são carregadas **pelo navegador**, então alguém tem de servi-las. Sem o mount, a tag `<script>` é
injetada, aponta para 404, a página carrega inteira e o `vssh` simplesmente não existe — sem erro
nenhum ligando uma coisa à outra.

**No servidor**, quem instala é o `installCommand` do manifesto:

```jsonc
// Node
"installCommand": "( [ \"${VSSH_APP_REBUILD:-}\" != 1 ] && test -d node_modules ) || npm ci --omit=dev"

// Python
"installCommand": "( [ \"${VSSH_APP_REBUILD:-}\" != 1 ] && test -d vendor/py ) || python3 -m pip install --no-cache-dir --target vendor/py \"https://github.com/colabhd/vssh-app-toolkit/archive/refs/tags/v4.tar.gz\""
```

Nos dois casos a instalação grava **dentro do pacote do app**, e não num ambiente global: é a
execução como root do `installCommand` que pode escrever em `/opt/vssh-apps/<id>/`, e o guard
(`test -d …`) impede a segunda execução — a de usuário, não-root — de tentar escrever onde não
pode. No Python, o `sys.path` do `backend/main.py` aponta para `vendor/py`; é o `node_modules` com
outro nome.

O template do seu runtime já vem com tudo isso ligado — copie de lá em vez de montar à mão.

**Precisa dar ao app acesso aos arquivos do usuário** (a home, não uma raiz privada)? Não é o
`vssh-app-fs`: é o polyfill da File System Access API, que fala com o `/api/fs/*` do portal pelo
shell — o app ganha `showDirectoryPicker()` sem rodar filesystem nenhum.

Apps de referência mais completos moram em repositórios próprios: `colabhd/vssh-psna-terminal-latch`
(terminal persistente, `richChrome`, binário Go vendorizado) e `colabhd/vsshapp-recoll` (busca Recoll).

## Quickstart

1. **Crie seu repo de app** a partir do template:
   ```bash
   cp -r templates/hello-vssh-app ~/meu-app && cd ~/meu-app
   # edite vssh-app.json (id, name, version), backend/, frontend/, icon
   git init && git add -A && git commit -m "init" && gh repo create <owner>/meu-app --public --source . --push
   ```
   (o repo do app pode ser privado ou público — tanto faz para a publicação.)

2. **Gere um token de publicação escopado** ao seu app (`app:<id>`) — **não é um PAT do GitHub**,
   é um token do Worker do repositório. Via aba admin **Repositório → Tokens** no portal, ou com o
   token mestre do Worker:
   ```bash
   curl -fsS -X POST "$VSSH_REPO_API/v1/tokens" \
     -H "Authorization: Bearer $VSSH_MASTER_TOKEN" -H "Content-Type: application/json" \
     -d '{"scope":"app:meu-app","label":"CI meu-app"}'
   # → { "token": "vsshp_..." }  (mostrado UMA vez — guarde)
   ```
   Salve como secret **`VSSH_REPO_PUBLISH_TOKEN`** no seu repo (Settings → Secrets and variables → Actions).

3. **Adicione o workflow de publicação** em `.github/workflows/publish.yml`:
   ```yaml
   name: Publish → vssh-repo
   on:
     push: { branches: [main] }
     workflow_dispatch:
   jobs:
     publish:
       uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v4
       with:
         app_dir: "."
         repo_api: "https://vssh-repo.colabh.org"       # = seu VSSH_REPO_API
         version: "1.0.${{ github.run_number }}"         # auto-versiona (install é idempotente por versão)
       secrets:
         publish_token: ${{ secrets.VSSH_REPO_PUBLISH_TOKEN }}
   ```
   Push em `main` publica. **Sem `tools_token`, sem PAT.**

4. **Instale no servidor** (admin): `sudo vssh-app-install <id> --force`, ou pela aba admin
   **Repositório** → Instalar/Atualizar. O app aparece no Start Menu/Launchpad do usuário, na
   `category` que o manifesto declarou.

## Publicar localmente (dev, sem CI)

```bash
export VSSH_REPO_API="https://vssh-repo.colabh.org"
export VSSH_REPO_PUBLISH_TOKEN="vsshp_..."
bash scripts/vssh-app-publish ~/meu-app --version 1.2.3
```

O script valida o `vssh-app.json`, empacota **o que está versionado** (via `git archive` quando é um
repo git — então `node_modules/`/`vendor/` **commitados entram** e cruft ignorado pelo `.gitignore`
fica de fora), verifica o sha256 e faz `POST /v1/publish/app`. Ver `--help`.

## Versionamento

**Referencie por tag: `@v4`.** Uma tag, e não um branch — puxar de `main` faz a validação do seu CI
(e as suas libs) mudarem debaixo de você a cada commit deste repositório, inclusive num push que
você não viu. Bumps compatíveis movem a `v4`; uma mudança incompatível cria a `v5`.

É o mesmo número nos dois lugares: `tools_ref` do reusable e o `#v4` da dependência npm.

> **Não use `@v1`.** Ela é do toolkit **original**, anterior à criação de `lib/`, `schema/` e
> `docs/`. Um repo pinado ali publica com **validação mínima**.

### Como você fica sabendo que está desatualizado

O `vssh-app-publish` lê o `package.json` que o npm instalou no seu app e compara com a versão do
toolkit que está rodando:

| | |
|---|---|
| **major** diferente | **recusa publicar** — outra major carrega breaking change real |
| menor ou patch | avisa, e publica |
| `vendor/vssh/` ainda no pacote | **recusa** — cópia da era anterior à v4, código morto competindo com as libs instaladas |
| declara a dependência, não leva `node_modules` e não tem `installCommand` com npm | **recusa** — o backend morreria no primeiro `require`, no servidor |
| instala no alvo pelo `installCommand` | avisa que a versão **não** foi conferida aqui |

No GitHub Actions esses avisos são **anotações** (`::warning::`), não linhas de log. A diferença é
deliberada e vem de um caso real: o `aviso: schema não encontrado` da tag `v1` passou meses
despercebido em repos que publicavam com validação mínima achando que validavam — porque a única
pista era uma linha no meio do log.

> **"E o npm?" — esta seção respondia "considerado e decidido contra", e a decisão foi revertida na
> v4.** O argumento antigo tinha duas pernas: (i) publicar no registry exigiria o primeiro
> credential da história deste repositório, e (ii) o npm não removeria a vendorização, porque o
> publish empacota o que está versionado.
>
> A perna (i) supunha o **registry**, e é aí que ela cai: `npm i github:colabhd/vssh-app-toolkit#v4`
> instala direto do repositório público, sem token nenhum e sem `npm publish` — medido, inclusive
> num container sem `git` e sem `ssh`. A perna (ii) era verdadeira e não sustentava a conclusão:
> continuar copiando à mão custou libs 3.0.0 publicadas contra um toolkit 4.0.0, porque o script de
> cópia tinha um número de versão próprio para esquecer. Levar o `node_modules` no tarball
> continua possível — a diferença é que agora quem faz a cópia é o npm, e quem sabe a versão é o
> lock. Ver [MIGRATION.md](MIGRATION.md) e
> [`docs/decisoes/publicacao.md`](docs/decisoes/publicacao.md#por-que-as-libs-vêm-do-npm-e-não-de-um-script-de-cópia).

## Migrando de `colabhd/vssh-sso`

Antes, o script/reusable viviam no `vssh-sso` **privado**, o que exigia um PAT (`VSSH_TOOLS_TOKEN`,
`contents:read`) em cada repo de app — e repos de contas pessoais nem conseguiam usar o reusable
(GitHub proíbe `uses:` de reusable **privado** cross-owner), tendo que inlinear os passos à mão.

Para migrar:

- **Repo que usava o reusable do vssh-sso** (`uses: colabhd/vssh-sso/.../_publish-app-reusable.yml@main`):
  troque para `uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v4` e
  **remova** o secret `tools_token`/`VSSH_TOOLS_TOKEN`.
- **Repo que inlineava os passos** (checkout do script via PAT): substitua tudo pelo bloco `uses:`
  do Quickstart acima e apague o `VSSH_TOOLS_TOKEN`.

O único secret que permanece é o `VSSH_REPO_PUBLISH_TOKEN` (token do Worker escopado ao app) — que
nunca foi um credential do GitHub.
