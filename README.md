# vssh-app-toolkit

Ferramentas **públicas** para construir e publicar **vssh-apps** do desktop remoto
VSSH-SSO (o cliente Xpra renderizado no navegador). Um vssh-app é um pacote self-contained
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
| [`scripts/vssh-app-lib-sync`](scripts/vssh-app-lib-sync) | Copia `lib/` para dentro do repo do seu app (vendorizado). |
| [`.github/workflows/_publish-app-reusable.yml`](.github/workflows/_publish-app-reusable.yml) | Reusable workflow que o CI do seu repo de app chama com um `uses:`. |
| [`templates/hello-vssh-app/`](templates/hello-vssh-app/) | Template de partida (Python 3 stdlib, zero deps). Copie e adapte. |
| [`templates/hello-vssh-app-node/`](templates/hello-vssh-app-node/) | Template Node **e galeria**: log estruturado, gate de token e SSE — e uma peça por capacidade do ambiente, para instalar num servidor e conferir com as mãos. |
| [`docs/api.md`](docs/api.md) | **Referência de API** — o que o app pode pedir ao ambiente: janela, título, diálogos, menu de contexto, seletores, arquivos, abas. E o que não existe. |
| [`docs/porting.md`](docs/porting.md) | Portar um app web/Electron/Tauri: árvore de decisão e como medir o buraco em minutos. |
| [`docs/lessons/logseq-port.md`](docs/lessons/logseq-port.md) | O que portar um app real ensinou — a origem da maioria das regras acima. |
| [`docs/roadmap/`](docs/roadmap/) | **Plano vivo do ecossistema** — diagnóstico, casos de uso, critérios de projeto e as ondas de trabalho, com estado por item. |

## Bibliotecas (`lib/`)

Nenhuma tem dependência npm e nenhuma lê variável de ambiente: quem traduz o ambiente VSSH em
config é o backend do app.

**São vendorizadas, não instaladas**, e o motivo é um só: o `vssh-app-publish` empacota o que está
**versionado** — o que não estiver commitado não chega ao servidor. Para as libs de `lib/web/` há
ainda uma razão estrutural: elas são carregadas pelo navegador por tag `<script>` e precisam ficar
sob a raiz que o `static-spa` serve, então uma cópia para lá existe de qualquer forma.

> **Uma justificativa que costumava aparecer aqui foi removida por ser falsa:** *"o servidor-alvo
> pode não ter registry npm acessível num exec não-interativo por SSH"*. Ela entrou num único
> commit de desenho, em três documentos ao mesmo tempo, e nunca foi medida — o servidor-alvo
> alcança o registry. O que é verdade e vale a mesma cautela é outra coisa, essa sim vinda de um
> caso real: dependência de **CDN externo em runtime** quebra num servidor sem internet
> (ver [`docs/lessons/logseq-port.md`](docs/lessons/logseq-port.md)).
>
> **O custo da vendorização era a cópia envelhecer em silêncio, e ele está pago.** O
> `.vssh-lib-version` carimba a versão das libs, o `vssh-app-publish` a confere e **recusa** quando
> a major diverge, e o app reporta o par shell+libs em runtime por `vssh.capabilities()`. Ver
> [Versionamento](#versionamento).

### Backend (`lib/node/`) — `require()`adas pelo seu processo

| Peça | Para quê |
|---|---|
| `lib/node/vssh-app-fs/` | Filesystem **privado** do app por HTTP: 12 ops, confinamento à raiz com `realpath`, assets binários com `Range`, gate de `X-Vssh-App-Token` timing-safe, errno classificado (4xx x 500 honesto). |
| `lib/node/static-spa.js` | Serve uma SPA construída sob o prefixo do proxy: content-type, 304, injeção de script de boot, **prefixos alias** e fallback de SPA para roteamento HTML5. |
| `lib/node/app-log.js` | Log estruturado em `$VSSH_APP_DATA_DIR`. Vinte linhas que se pagam na primeira depuração remota. |
| `lib/node/sse.js` | Server-Sent Events com os headers que sobrevivem ao proxy e ao CDN (`X-Accel-Buffering: no` + `flushHeaders`). |

### Frontend (`lib/web/`) — carregadas pelo navegador, por tag `<script>`

É a superfície inteira de API do cliente. Referência completa em [`docs/api.md`](docs/api.md).

| Peça | Para quê |
|---|---|
| `lib/web/vssh-app-shim.js` | **A ponte com o desktop**: `vssh.dialog`, `vssh.notify`, `vssh.pickFile`, `vssh.fs`, `vssh.window`, `vssh.contextMenu`, `vssh.tabs`, `vssh.capabilities`. Fora do desktop cada função **degrada** para o equivalente do navegador em vez de lançar. |
| `lib/web/vssh-app-shim.d.ts` | Os tipos da superfície acima, como **declaração global** (o shim entra por `<script>`). Basta incluir no `tsconfig.json`. Conferido contra a superfície real em runtime, nos dois sentidos — ver [`docs/api.md`](docs/api.md#typescript). |
| `lib/web/fsa-polyfill.js` | File System Access API (`showDirectoryPicker()` e cia.) sobre o `/api/fs/*` do portal — um web app que já usa FSA roda **sem fork**. Requer o shim carregado antes. ⚠ Tem limites estruturais conhecidos: veja [`docs/roadmap/03-toolkit.md`](docs/roadmap/03-toolkit.md#t1--lazyfile-é-um-blob-vazio) antes de depender dele. |
| `lib/web/electron-shim.js` | Superfície padrão do Electron (`dialog`, `shell`, `clipboard`, `Notification`, controles de janela) mapeada para o shim. Para portar um app Electron sem reescrever as chamadas. |
| `lib/web/tauri-shim.js` | Idem para a superfície padrão do Tauri (`fs`, `dialog`, `shell`, `notification`, `path`). |

### Vendorizando

**Dois destinos, e a distinção importa:** as libs de backend ficam ao lado do backend; as de
frontend precisam ficar **sob a raiz que o `static-spa` serve**, senão a tag injetada por
`injectScripts` aponta para 404.

```bash
# no repo do seu app
bash /caminho/do/toolkit/scripts/vssh-app-lib-sync . --parts fs,spa,log,sse --dest backend/vendor/vssh
bash /caminho/do/toolkit/scripts/vssh-app-lib-sync . --parts web            --dest frontend/vendor/vssh
git add backend/vendor/vssh frontend/vendor/vssh && git commit -m "sync vssh libs"
```

O template [`templates/hello-vssh-app-node/`](templates/hello-vssh-app-node/) já vem com os dois
lados ligados — copie de lá em vez de montar à mão.

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
       uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v2
       with:
         app_dir: "."
         repo_api: "https://vssh-repo.colabh.org"       # = seu VSSH_REPO_API
         version: "1.0.${{ github.run_number }}"         # auto-versiona (install é idempotente por versão)
       secrets:
         publish_token: ${{ secrets.VSSH_REPO_PUBLISH_TOKEN }}
   ```
   Push em `main` publica. **Sem `tools_token`, sem PAT.**

4. **Instale no servidor** (admin): `sudo vssh-app-install <id> --force`, ou pela aba admin
   **Repositório** → Instalar/Atualizar. O app aparece na seção "Apps Integrados" do Start
   Menu/Launchpad da sessão do usuário.

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

**Referencie por tag: `@v2`.** Uma tag, e não um branch — puxar de `main` faz a validação do seu CI
mudar debaixo de você a cada commit deste repositório, inclusive num push que você não viu. Bumps
compatíveis movem a `v2`; uma mudança incompatível cria a `v3`.

É o default em toda parte: `tools_ref` do reusable e `--ref` do `vssh-app-lib-sync`.

> **Não use `@v1`.** Ela é do toolkit **original**, anterior à criação de `lib/`, `schema/` e
> `docs/`. Um repo pinado ali publica com **validação mínima**, e o `vssh-app-lib-sync --ref v1`
> falha com "lib/ não encontrado no tarball".

### Como você fica sabendo que está desatualizado

O `vssh-app-publish` lê o `.vssh-lib-version` da sua cópia vendorizada e compara com a versão do
toolkit que está rodando:

| | |
|---|---|
| **major** diferente | **recusa publicar** — outra major carrega breaking change real |
| menor ou patch | avisa, e publica |
| sem `lib_version` | avisa: a cópia veio de um toolkit anterior ao carimbo |

No GitHub Actions esses avisos são **anotações** (`::warning::`), não linhas de log. A diferença é
deliberada e vem de um caso real: o `aviso: schema não encontrado` da tag `v1` passou meses
despercebido em repos que publicavam com validação mínima achando que validavam — porque a única
pista era uma linha no meio do log.

> **E o npm?** Publicar `lib/` como pacote npm foi **considerado e decidido contra**. O que ele
> acrescentaria é um empurrão proativo (dependabot avisando que saiu versão nova); o que custa é o
> primeiro credential da história deste repositório — e "sem nenhum PAT/GitHub App" é a razão de
> ele ser público. Além disso, o npm não removeria a vendorização: o publish empacota o que está
> **versionado**, então a cópia continuaria sendo commitada, com um passo a mais antes. O gatilho
> que reabriria a decisão é o toolkit passar a distribuir algo que **não** é vendorizado — um CLI
> que se rodaria com `npx`. Ver [`docs/roadmap/03-toolkit.md`](docs/roadmap/03-toolkit.md#a-cópia-vendorizada-não-sabe-a-idade-que-tem).

## Migrando de `colabhd/vssh-sso`

Antes, o script/reusable viviam no `vssh-sso` **privado**, o que exigia um PAT (`VSSH_TOOLS_TOKEN`,
`contents:read`) em cada repo de app — e repos de contas pessoais nem conseguiam usar o reusable
(GitHub proíbe `uses:` de reusable **privado** cross-owner), tendo que inlinear os passos à mão.

Para migrar:

- **Repo que usava o reusable do vssh-sso** (`uses: colabhd/vssh-sso/.../_publish-app-reusable.yml@main`):
  troque para `uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v2` e
  **remova** o secret `tools_token`/`VSSH_TOOLS_TOKEN`.
- **Repo que inlineava os passos** (checkout do script via PAT): substitua tudo pelo bloco `uses:`
  do Quickstart acima e apague o `VSSH_TOOLS_TOKEN`.

O único secret que permanece é o `VSSH_REPO_PUBLISH_TOKEN` (token do Worker escopado ao app) — que
nunca foi um credential do GitHub.
