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
| [`templates/hello-vssh-app-node/`](templates/hello-vssh-app-node/) | Template Node: usa as libs, já nasce com log estruturado, gate de token e SSE. |
| [`docs/lessons/logseq-port.md`](docs/lessons/logseq-port.md) | O que portar um app real ensinou — a origem da maioria das regras acima. |

## Bibliotecas (`lib/`)

Nenhuma tem dependência npm e nenhuma lê variável de ambiente: quem traduz o ambiente VSSH em
config é o backend do app. São vendorizadas, não instaladas — o servidor-alvo pode não ter registry
npm acessível num exec não-interativo por SSH, e o `vssh-app-publish` empacota o que está
**versionado**.

| Peça | Para quê |
|---|---|
| `lib/node/vssh-app-fs/` | Filesystem **privado** do app por HTTP: 12 ops, confinamento à raiz com `realpath`, assets binários com `Range`, gate de `X-Vssh-App-Token` timing-safe, errno classificado (4xx x 500 honesto). |
| `lib/node/static-spa.js` | Serve uma SPA construída sob o prefixo do proxy: content-type, 304, injeção de script de boot, **prefixos alias** e fallback de SPA para roteamento HTML5. |
| `lib/node/app-log.js` | Log estruturado em `$VSSH_APP_DATA_DIR`. Vinte linhas que se pagam na primeira depuração remota. |
| `lib/node/sse.js` | Server-Sent Events com os headers que sobrevivem ao proxy e ao CDN (`X-Accel-Buffering: no` + `flushHeaders`). |

```bash
# no repo do seu app
bash /caminho/do/toolkit/scripts/vssh-app-lib-sync . --parts fs,spa,log,sse
git add backend/vendor/vssh && git commit -m "sync vssh libs"
```

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
       uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v1
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

## Versionamento (`@v1`)

Referencie o reusable por **tag** (`@v1`), não `@main` — assim uma mudança interna do toolkit não
quebra seu CI. Bumps compatíveis movem a tag `v1`; mudanças incompatíveis viram `v2`.

## Migrando de `colabhd/vssh-sso`

Antes, o script/reusable viviam no `vssh-sso` **privado**, o que exigia um PAT (`VSSH_TOOLS_TOKEN`,
`contents:read`) em cada repo de app — e repos de contas pessoais nem conseguiam usar o reusable
(GitHub proíbe `uses:` de reusable **privado** cross-owner), tendo que inlinear os passos à mão.

Para migrar:

- **Repo que usava o reusable do vssh-sso** (`uses: colabhd/vssh-sso/.../_publish-app-reusable.yml@main`):
  troque para `uses: colabhd/vssh-app-toolkit/.github/workflows/_publish-app-reusable.yml@v1` e
  **remova** o secret `tools_token`/`VSSH_TOOLS_TOKEN`.
- **Repo que inlineava os passos** (checkout do script via PAT): substitua tudo pelo bloco `uses:`
  do Quickstart acima e apague o `VSSH_TOOLS_TOKEN`.

O único secret que permanece é o `VSSH_REPO_PUBLISH_TOKEN` (token do Worker escopado ao app) — que
nunca foi um credential do GitHub.
