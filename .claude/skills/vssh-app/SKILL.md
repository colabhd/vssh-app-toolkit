---
name: vssh-app
description: Build a vssh-app for the VSSH-SSO desktop client — a self-contained package (HTML frontend + own backend process, any language) developed outside this repo, installed on a provisioned Linux server, and opened as a window inside the browser-rendered desktop. Use when the user wants to create, package, or debug a vssh-app, or mentions vssh-app.json, vssh-app-install, or vssh-app-run.
---

# vssh-apps

Um vssh-app é um pacote self-contained — frontend HTML + backend próprio, em qualquer
linguagem — que roda como processo separado no servidor Linux do usuário e aparece como uma
janela renderizada pelo próprio navegador dentro do desktop VSSH — não é uma janela X11 real, e
não depende do Xpra: um vssh-app se comporta igual num ambiente sem ele. O backend é proxied pela
infraestrutura do portal; quem constrói o app não edita nada no repositório do vssh-sso — só
publica um pacote seguindo a convenção abaixo, e um admin instala com `vssh-app-install`.

**Como o app fala com o ambiente** — trocar o título, abrir um diálogo, montar um menu de contexto,
escolher arquivo, controlar a janela: [`docs/api.md`](../../docs/api.md) é a referência completa,
com uma seção final sobre o que **não** existe. Esta SKILL cobre empacotar e instalar; aquela,
programar contra o ambiente.

**Portando um app que já existe** (web, Electron ou Tauri)? Comece por
[`docs/porting.md`](../../docs/porting.md): tem a árvore de decisão e como medir, em minutos, o que
falta num app concreto.

## Antes de codar: checklist de decisão

- **Precisa de lógica própria no servidor, ou é só HTML/CSS/JS estático?** Mesmo estático, ainda
  precisa de um processo escutando numa porta — o proxy do portal encaminha para uma porta TCP,
  não serve um diretório diretamente.
- **Precisa de estado que sobreviva entre execuções** (índice, cache, arquivos gerados)? Vai em
  `VSSH_APP_DATA_DIR`. Nunca escreva em `/opt/vssh-apps/<id>/` — é root-owned e somente leitura.
- **Precisa de tempo real (WebSocket)?** O proxy encaminha WS automaticamente, sem configuração
  extra — trate como qualquer outra rota do seu backend.
- **Qual runtime?** Qualquer um que saiba bindar em `127.0.0.1:$VSSH_APP_PORT` — `python3`/
  `node`/`binary` são os declarados no manifest, mas o mecanismo é agnóstico de linguagem.
- **Precisa de diálogo, confirmação, notificação ou seletor de arquivo?** Não construa essa UI —
  use `lib/web/vssh-app-shim.js` do frontend (`vssh.dialog.*`, `vssh.notify`, `vssh.pickFile`).
  Isso fala com o desktop por `postMessage`, **sem passar pelo Xpra**, então funciona igual num
  ambiente sem ele. Só se o **backend** precisar avisar algo sem janela aberta é que valem o
  `vssh-psdialog`/`notify-send` a partir do processo — e esses dependem da sessão Xpra, então
  trate-os como fallback, não como caminho normal.
- **Esse app tem UI própria que o usuário abre como janela, ou é uma capability que uma feature já
  existente do desktop vai consumir por baixo (fetch/WS direto, sem iframe/janela)?** No
  segundo caso é um app `"type": "engine"` — ver seção "Apps tipo `engine`" abaixo. Não force um
  app backend-only a ter uma janela só pra "seguir o padrão"; e não invente um mecanismo de
  entrega paralelo pra um backend que uma janela nativa vai consumir — o lifecycle de instalação/
  execução (`vssh-app-install`/`-run`, alocação de porta, proxy autenticado) já serve pros dois
  casos sem alteração.

## Referência do manifest (`vssh-app.json`)

```jsonc
{
  "id": "meu-app",                    // [a-z0-9-]+, imutável — vira path/porta/sentinel
  "name": "Meu App",
  "version": "1.0.0",                 // OBRIGATÓRIO (semver) — usado pelo repositório (vssh-repo)
                                       // e pela idempotência do install por versão; bump a cada release
  "type": "app",                      // opcional, default "app" — "engine" pra apps backend-only,
                                       // sem janela nem ícone no Launchpad/Start Menu (ver seção
                                       // "Apps tipo engine" abaixo); nesse caso "icon" e "window"
                                       // não se aplicam e podem ser omitidos
  "kind": "app",                      // opcional, default "app" — eixo de LIFECYCLE, ORTOGONAL a
                                       // `type` (que é janela/sem-janela). "service" = daemon
                                       // supervisionado: sobe junto com a sessão, reinicia sozinho
                                       // em caso de queda (backoff 2^n, teto de 5 falhas) e reporta
                                       // estado em Configurações → Serviços. O `alwaysRunning: true`
                                       // legado equivale a kind:"service" e é lido por compat.
  "icon": "icon.svg",                 // caminho relativo à raiz do pacote
  "category": "Utility",              // só informativo em GET /api/apps hoje — o cliente lista
                                       // todo vssh-app numa seção única "Apps Integrados" no Start
                                       // Menu/Launchpad, sem agrupar por esse campo (não gera mais
                                       // .desktop/XDG — ver "Como o app aparece no menu" abaixo)
  "description": "...",
  "handles": null,                    // opcional: "terminal"|"editor"|"fileBrowser"|"vscode"|
                                       // "browser" — registra este app como substituto de um
                                       // launcher embutido (ver "App padrão por categoria" abaixo)
  "opens": {                          // opcional: tipos de arquivo que este app sabe abrir. É o
    "extensions": ["md", "org"],       // que coloca o app no submenu "Abrir com" e o torna
    "mimeTypes": ["text/markdown"]     // elegível a padrão por tipo (Configurações →
  },                                   // Aplicativos). O arquivo escolhido chega via
                                       // `open-context` (ver seção abaixo). Generaliza `handles`,
                                       // que só cobre os 5 launchers embutidos.
  "backend": {
    "runtime": "python3",             // "python3" | "node" | "binary"
    "entrypoint": "backend/main.py",  // relativo à raiz do pacote
    "installCommand": "",             // opcional; roda 2x — 1x como root em vssh-app-install
                                       // (deps de sistema) e 1x por usuário, não-root, no
                                       // primeiro vssh-app-run (venv/pip/etc — guardado por
                                       // marker file). Escreva de forma idempotente (ex.: `test
                                       // -x bin/algo || build-pesada`), já que roda duas vezes.
                                       // ARMADILHA: esse guard idempotente também esconde um
                                       // reinstall --force de verdade — "--force" só troca os
                                       // arquivos ao redor, não força reexecutar uma etapa cara
                                       // já concluída (ex. recompilar um binário depois de mudar
                                       // a fonte vendorizada). vssh-app-install exporta
                                       // VSSH_APP_REBUILD=1 (só nessa invocação, nunca na
                                       // per-user) — se seu guard esconde algo que precisa
                                       // rerodar num reinstall, cheque essa var: `( [
                                       // "${VSSH_APP_REBUILD:-}" != 1 ] && test -x bin/algo ) ||
                                       // build-pesada` (ver installCommand de
                                       // terminal-latch/vssh-app.json).
    "healthcheckPath": "/"            // opcional; endpoint que o lifecycle do portal faz poll até
                                       // responder (até 15x/1s, síncrono, bloqueando o clique de
                                       // "abrir app" do usuário) — responda rápido e sem depender
                                       // de setup pesado ou de uma ferramenta externa que o
                                       // backend envolva ainda não estar pronta; sirva algo
                                       // estático e trate o estado real em endpoints próprios.
  },
  "window": {
    "title": "Meu App",
    "width": 900,
    "height": 640
  }
}
```

Se o `backend.runtime` for `"node"` (ou qualquer outro com um gerenciador de pacotes real) e o app
tiver dependências de verdade, prefira **vendorizar `node_modules/` já instalado** (rodar
`npm install`/`npm ci` uma vez em dev/CI e commitar o resultado no pacote) em vez de depender de
`npm install` funcionando no servidor-alvo durante `vssh-app-install`/`vssh-app-run` — mesma
lição do binário Go compilado do `terminal-latch` (abaixo), só que pra dependências npm: o
servidor remoto pode não ter acesso à internet/registry em modo não-interativo via SSH.
`installCommand` fica como rede de segurança/rebuild (`test -d node_modules || npm ci`), guardado
pelo mesmo idioma `VSSH_APP_REBUILD` já usado pro binário Go.

**O que entra no tarball:** `vssh-app-publish` empacota **o que está versionado** (quando a fonte é
um repo git, via `git archive`; senão, um `tar` que só exclui `.git`/`data`/`__pycache__`/`*.pyc`).
Ou seja: `node_modules/`/`vendor/` **commitados entram** e são servidos ao servidor; os que o
`.gitignore` do pacote ignora ficam de fora (e aí dependem do `installCommand` reconstruir no
servidor). Vendorizar = commitar; se quiser reconstruir no alvo, deixe a pasta no `.gitignore`.

### Variáveis de ambiente injetadas no processo do backend

| Variável | Descrição |
|---|---|
| `VSSH_APP_PORT` | Porta TCP em `127.0.0.1` onde o backend **deve** bindar. |
| `VSSH_APP_BASE_PATH` | Valor literal `/proxy/app/<id>/` (**sem** serverId) — é o que o processo do backend recebe (`key-provisioner.ts`, `startApp`). **NÃO** é a URL pública completa que o navegador usa: essa inclui o serverId (`/<serverId>/proxy/app/<id>/`, ver `src/proxy.ts`). Só importa se o backend emitir URLs absolutas; com `fetch()` relativo não precisa — não construa link absoluto a partir desta variável sem prefixar o serverId separadamente (você não tem como saber o serverId aqui de qualquer forma). |
| `VSSH_APP_DATA_DIR` | `~/.vssh-apps/<id>/data` — único diretório gravável garantido. |
| `VSSH_APP_ID` | O próprio `id` do manifest. |
| `VSSH_APP_TOKEN` | Opcional/defesa-em-profundidade: valor opaco gerado por instância de app rodando, injetado pelo proxy como header `X-Vssh-App-Token` em toda requisição/upgrade que ele encaminha pra esse app. Apps que concedem acesso sensível (shell, arquivos) podem checar esse header e recusar qualquer conexão que não tenha vindo pelo proxy autenticado — útil porque a porta em si é só loopback, mas ainda alcançável por outro processo do mesmo usuário Linux. Apps que não se importam (ex. `hello-world`) simplesmente não checam nada. |

Sem modelo de permissão além de "roda como o usuário Linux dono da sessão" — mesmo modelo de
confiança que code-server e Xpra usam para qualquer outro processo do usuário.

### Alocação de porta

`VSSH_APP_PORT` é alocado automaticamente pelo portal por (usuário SSH, app id) — hash
determinístico md5(sshUser:appId) na faixa 40000-49999, verificado contra `ss -tlnp` no servidor
real e cacheado 24h no Redis (`_allocateAppPort` em `key-provisioner.ts`). Quem escreve o app
nunca escolhe nem hardcoda uma porta, e colisão entre dois usuários já é resolvida pelo
mecanismo — não é algo para se preocupar ao implementar.

### Rastreamento de processo (PID file)

O lifecycle do portal (`vssh-app-run`) grava o PID do processo final em
`~/.vssh-apps/<id>/run.pid` **antes** do `exec` que troca sua imagem pelo runtime declarado
(`python3`/`node`/`binary`). Isso importa saber porque o `cmdline` do processo muda nesse exec —
qualquer coisa que precisasse reencontrar o processo por um padrão de string no `cmdline` (o
próprio lifecycle do portal fazia isso antes) só funcionaria na janela breve antes do exec. O PID
em si não muda, então é a única forma confiável de rastrear o processo depois — não é algo que
o autor do app precisa implementar (o `run.pid` é escrito pelo próprio `vssh-app-run`), só uma
armadilha a conhecer se for ler/depurar o lifecycle.

## Convenção de diretório do pacote

```
meu-app/
  vssh-app.json
  icon.svg                # ou .png/.jpg
  frontend/
    index.html             # o backend serve isto em GET /
    ...
  backend/
    main.py                 # entrypoint — deve bindar em 127.0.0.1:$VSSH_APP_PORT
    requirements.txt         # opcional
```

O backend serve tanto os arquivos estáticos do frontend quanto qualquer API própria (ex:
`/api/ping`, `/api/search`) — o proxy do portal encaminha tudo sob
`/<serverId>/proxy/app/<id>/*` para `127.0.0.1:$VSSH_APP_PORT/*`, WebSocket incluído.

**Use `fetch()` com URLs relativas** (`fetch('api/ping')`, não `fetch('/api/ping')`) — assim o
frontend funciona sem alterações sob o prefixo `/proxy/app/<id>/`. Só recorra a
`VSSH_APP_BASE_PATH` se o backend precisar emitir URLs absolutas (ex: links profundos em
respostas JSON).

## Não reimplemente: as bibliotecas do toolkit

Quatro problemas aparecem em todo app, e todo mundo erra do mesmo jeito na primeira vez. Já estão
resolvidos em `lib/` — vendorize com `vssh-app-lib-sync` e commite o resultado (o servidor pode não
alcançar registry npm num exec por SSH, e o publish empacota o que está versionado).

```bash
# libs de backend ao lado do backend; libs de frontend sob a raiz que o static-spa serve
bash /caminho/do/toolkit/scripts/vssh-app-lib-sync . --parts fs,spa,log,sse --dest backend/vendor/vssh
bash /caminho/do/toolkit/scripts/vssh-app-lib-sync . --parts web            --dest frontend/vendor/vssh
git add backend/vendor/vssh frontend/vendor/vssh && git commit -m "sync vssh libs"
```

| Peça | Resolve |
|---|---|
| `app-log.js` | Log estruturado em `$VSSH_APP_DATA_DIR`. **Comece por esta**, na primeira linha de código. |
| `static-spa.js` | Servir uma SPA construída sob o prefixo do proxy: 304, prefixos alias, injeção de script de boot, fallback de SPA. |
| `sse.js` | Server-Sent Events com os headers que sobrevivem ao proxy e ao CDN. Sem eles os eventos chegam em lote, ou nunca — e sem erro nenhum. |
| `vssh-app-fs/` | Filesystem **privado** do app por HTTP: confinado a uma raiz, token-gated, errno classificado. |

Comece pelo `templates/hello-vssh-app-node/`, que já nasce com tudo isso ligado.

## Falar com o desktop: diálogo, notificação, seletor, arquivos

**Não construa essa UI.** O desktop já tem, e o app alcança por uma ponte de `postMessage` —
carregue `lib/web/vssh-app-shim.js`. São **dois passos**, e esquecer o primeiro é o erro clássico:
vendorize `lib/web/` sob a raiz do frontend (`--dest frontend/vendor/vssh`, acima) e só então aponte
o `injectScripts` do `static-spa` para ele — sem tocar no seu HTML:

```js
createStaticSpa({ root: 'frontend', injectScripts: ['vendor/vssh/web/vssh-app-shim.js'] })
```

`injectScripts` **só injeta a tag `<script>`**; quem serve o arquivo é o `static-spa`, e ele só serve
o que está sob `root`. Se a lib ficar em `backend/vendor/`, a tag aponta para 404 e o `vssh` nunca
existe — silenciosamente, porque a página carrega normalmente. Ver
`templates/hello-vssh-app-node/`, que já vem com os dois passos ligados.

```js
await vssh.dialog.confirm('Descartar alterações?');      // diálogo do desktop
vssh.notify('Índice reconstruído', { title: 'Busca' });   // toast
const dir  = await vssh.pickDirectory();                  // gerenciador de arquivos em picker mode
const file = await vssh.pickFile({ filter: '*.md' });     // com grupos de filtro
vssh.openFile('/home/user/doc.pdf');                      // abre no visualizador certo
await vssh.openWith('/home/user/nota.md');                // deixa o usuário escolher
```

**Nada disso passa pelo Xpra**, então o app se comporta igual com ou sem ele. Fora do desktop
(dev standalone) cada função degrada para o equivalente do navegador em vez de lançar.

### Arquivos do usuário: use a File System Access API

Para ler e gravar na home do usuário, **não** monte o `vssh-app-fs`: carregue
`lib/web/fsa-polyfill.js` e use a API padrão do W3C.

```js
const dir = await showDirectoryPicker();                  // o picker é o do desktop
for await (const [name, handle] of dir.entries()) { /* ... */ }
```

Duas consequências que importam: o app **não precisa de backend de filesystem nenhum**, e um web
app que já usa FSA (Logseq, Excalidraw, tldraw, editores em geral) roda **sem fork**.

**Permissão segue o modelo do próprio padrão:** o app alcança só o que o usuário escolheu num
seletor. Escolher É consentir — não há segunda confirmação.

O grant **sobrevive à sessão**, e isso é o par necessário da persistência de handle: o polyfill
guarda handles em IndexedDB para o app reabrir a mesma pasta depois de um reload, e um handle sem
grant é um handle morto. Duas consequências para quem escreve o app:

- `queryPermission()` responde de verdade — `'granted'` ou `'prompt'`, consultando o shell. Não
  presuma `'granted'`.
- `requestPermission()` reabre o seletor. Chame-o **a partir de um gesto do usuário** — sem gesto
  ele devolve `'prompt'` sem abrir nada, que é a regra do navegador. Se o usuário escolher outra
  pasta, a resposta é `'denied'` e o handle antigo continua fora.

O usuário revoga em **Permissões de arquivo**, no menu de contexto da janela do app. Trate
`'denied'` como um estado normal, não como erro fatal.

Para saber que um arquivo mudou **por fora** do app (outro editor, `git pull`, upload pelo
gerenciador de arquivos), use `vssh.fs.watch(path, cb)` — devolve a função que cancela, e cancelar
importa: cada watch segura um vigia vivo no servidor. Ver [`docs/api.md`](../../docs/api.md).

**Quando usar o `vssh-app-fs` então?** Quando o app quer um store **privado**: uma raiz confinada,
com token próprio, funcionando inclusive fora do desktop. São casos diferentes, não alternativas.

## Rodar o app na sua máquina, sem servidor nenhum

O ciclo mais curto, e o que você vai usar 90% do tempo: o backend só precisa de três variáveis, e
nada no mecanismo exige um servidor VSSH para ele subir.

```bash
VSSH_APP_PORT=45999 VSSH_APP_ID=meu-app VSSH_APP_DATA_DIR=/tmp/meu-app-data \
  node backend/server.js          # ou python3 backend/main.py

curl -fsS http://127.0.0.1:45999/healthz
curl -fsS http://127.0.0.1:45999/api/ping
open http://127.0.0.1:45999/
```

Acrescente `VSSH_APP_TOKEN=segredo` para exercitar o gate de token (e confirmar que o healthcheck
continua isento — é o erro que mais custa depois).

O que **não** funciona assim, e por isso precisa do loop com servidor abaixo: a ponte com o
desktop (`vssh.dialog`, `vssh.pickFile`, FSA). Fora do desktop o shim degrada em vez de lançar,
então a página carrega e você desenvolve o resto normalmente.

## Loop de teste local contra um servidor VSSH-SSO real

1. Copie o pacote para um caminho qualquer no servidor Linux de teste (`scp -r meu-app/ servidor:/tmp/meu-app`).
2. Instale como root: `sudo vssh-app-install /tmp/meu-app --force`.
3. Confirme que `/opt/vssh-apps/<id>/` foi criado.
4. Autenticado no portal, `GET /api/apps` deve listar o app (cache de até 60s).
5. Abra a sessão Xpra do usuário no portal — o app aparece na seção "Apps Integrados" do Start
   Menu/Launchpad sem precisar reconectar (cache do cliente tem TTL de 30s, ver AppLauncher.js).
6. Se algo falhar: você tem **dois** logs, e eles se complementam.
   - **`~/.vssh-apps/<id>/run.log`** — stdout/stderr do backend, gravado pelo lifecycle. Legível
     sem SSH: clique direito no cabeçalho da janela do app → **Ver log do backend** (ou
     `GET /api/apps/<id>/log?tail=300`). É rotacionado para `run.log.1` a cada start, então o
     registro da execução que morreu não se perde.
   - **`$VSSH_APP_DATA_DIR/app.log`** — o seu log, estruturado, sobrevivendo a reinício. Use
     `lib/node/app-log.js` do toolkit: são vinte linhas e uma linha por falha com operação,
     caminho e código. Frame minificado no console sustenta hipótese; isto aqui dá a resposta.

   Se o app abriu com a janela em branco, o shell também avisa: o healthcheck tem teto de ~15s e,
   quando estoura, um toast diz que o backend ainda não respondeu em vez de deixar você adivinhar.

## Empacotamento, instalação e upgrade

`vssh-app-install <diretório|tarball.tar.gz|git-url> [--force]` (roda como root no servidor):
- Copia o pacote para `/opt/vssh-apps/<id>/` (somente leitura para usuários).
- Roda `backend.installCommand` uma vez como root (dependências de sistema).
- Recusa sobrescrever um `id` já instalado sem `--force`.
- **Não gera `.desktop`/XDG** — o app aparece no desktop via `GET /api/apps` direto (seção
  "Apps Integrados" no Start Menu/Launchpad), não via menu XDG nativo. Isso existe de propósito:
  o mecanismo antigo (gerar `.desktop` em `/usr/local/share/applications`) exigia reiniciar a
  sessão Xpra inteira pro app aparecer (o cliente só relê o menu XDG no handshake da conexão) e
  vazava a entrada pra qualquer outra sessão de desktop na mesma máquina (Chrome Remote Desktop,
  VNC, etc.), mesmo o app só funcionando através do proxy autenticado do portal.

`vssh-app-run <id>` roda `backend.installCommand` **de novo**, uma segunda vez — agora não-root,
como o próprio usuário, guardado por marker file (`~/.vssh-apps/<id>/.installed`) — na primeira
vez que aquele usuário abre o app. É o ponto de setup por usuário (venv/pip, etc.), não confundir
com a execução como root acima. **Se essa segunda execução falhar, o app não sobe pra aquele
usuário** — escreva `installCommand` pra ser seguro/idempotente nas duas invocações (ex.: `test
-x bin/algo || <build/instalação pesada>` — a segunda invocação só confere e não refaz nada).

Upgrade = publicar uma `version` nova no repositório (`vssh-app-publish`) e instalar por id
(`vssh-app-install <id> --force`, ou pela aba admin Repositório), ou — em dev — rodar
`vssh-app-install <pacote> --force` de novo com uma `version` nova no manifest. O modo repositório
é idempotente por `version` (mesma versão instalada → não faz nada; versão diferente → update).
Processos de usuários já rodando a versão antiga não são reiniciados automaticamente — avise os
usuários ou peça para reabrirem o app.

## Exemplos de referência: os dois templates

**Qual copiar:**

| | `templates/hello-vssh-app/` | `templates/hello-vssh-app-node/` |
|---|---|---|
| Runtime | Python 3 stdlib | Node stdlib |
| Traz | o mínimo absoluto | libs do toolkit vendorizadas |
| Já vem com | — | log estruturado, gate de token timing-safe, healthcheck isento, SSE |
| Use quando | o app é pequeno e você quer ler tudo em 2 minutos | qualquer coisa que vá crescer |

O Python é o menor caminho até "funciona": um app mínimo completo que exercita o pipeline inteiro
— janela abre, o iframe carrega `frontend/index.html` servido pelo próprio backend, e um botão faz
um round-trip `fetch('api/ping')`. Só demonstra `do_GET`; um app com API de verdade (POST/DELETE)
precisa adicionar os handlers do método (`BaseHTTPRequestHandler` não faz isso de graça).

O Node já nasce com o que a experiência mostrou ser necessário cedo — em especial o log
estruturado, que é o que salva a primeira depuração remota.

> **Apps de referência.** Os dois templates moram neste toolkit (`templates/`). Os demais citados
> abaixo são apps reais, cada um no seu próprio repositório — caminhos como `terminal-latch/…` ou
> `vsshapp-recoll/…` são relativos à raiz de cada repo:
> - `terminal-latch/` → `colabhd/vssh-psna-terminal-latch` (terminal persistente, `richChrome`, binário Go vendorizado).
> - `vsshapp-recoll/` → `colabhd/vsshapp-recoll` (busca Recoll, ponte `open-file`).
> - `scramjet-wisp/` → app de referência do tipo `engine` (motor de reescrita web, `alwaysRunning`).

Nem todo app precisa de `frontend/` nem de framework HTTP nenhum: `terminal-latch/` é
um exemplo onde o backend (`runtime: "python3"`, WebSocket implementado à mão com a stdlib) é,
na prática, uma ponte entre o navegador e um processo motor separado, não um servidor de rotas
tradicional. Use o que fizer sentido pro que o app realmente faz — e prefira um runtime que o
próprio mecanismo vssh-app já exija (`python3`, usado por `vssh-app-install`/`vssh-app-run` pra
parsear o manifest) a instalar um novo runtime: um `nvm`/`pyenv`/`rbenv` pessoal de algum usuário
não aparece no PATH de um `exec` não-interativo via SSH, então uma app que dependa disso pode
falhar silenciosamente pra alguns usuários (achado real construindo `terminal-latch`, que
começou em Node antes de trocar por esse motivo).

`scramjet-wisp/` é a referência pro tipo `"type": "engine"` (ver seção dedicada abaixo) —
um backend Node com dependência npm real (vendorizada, não instalada via `npm install` no
servidor-alvo), sem `frontend/` nem janela, consumido por uma feature já existente do cliente
Xpra em vez de aberto pelo usuário.

## Empacotando uma ferramenta que já tem servidor/protocolo de rede próprio

Quando o valor real de uma ferramenta open-source está só numa parte dela — ex.: o motor de
multiplexação de PTY do [latch](https://github.com/unixshells/latch), não o transporte SSH/web/
relay dela — considere extrair só essa parte em vez de expor a UI/protocolo de rede original
como está:

- Se a ferramenta já fala algo simples por um canal **local** (socket unix, pipe), escreva um
  entrypoint próprio que só abre esse canal (sem os transportes de rede da ferramenta original —
  não precisa nem remover esse código, só não invocá-lo) e um backend seu que faz a ponte entre
  esse canal e o navegador. Evita reimplementar TLS/auth que o proxy do portal já resolve, e
  deixa o app livre pra falar o mesmo protocolo (JSON, binário, o que for) que outras partes do
  próprio portal já usam — ver `terminal-latch/` (motor via socket unix + backend Node
  falando o mesmo protocolo WS que o terminal dtach do portal já fala).
- **A ferramenta manda `X-Frame-Options`/`frame-ancestors` bloqueando iframe, ou tem
  autenticação própria (TLS autoassinado, chaves) que não sabe nada sobre o proxy do portal?**
  Isso é um sinal de que expor a UI dela "como está" não é o caminho certo — prefira a extração
  acima (motor puro + frontend/backend seus) a tentar contornar TLS/headers em runtime.

## Apps tipo `engine` (backend-only, sem janela)

Todo o mecanismo descrito até aqui — manifest, `vssh-app-install`/`vssh-app-run`, alocação de
porta, env vars, PID tracking, proxy autenticado por `/<serverId>/proxy/app/<id>/*` — é **agnóstico
a "esse app abre uma janela ou não"**. `POST /api/apps/:id/start`/`GET /api/apps/:id/status`
(`src/routes/apps.ts`) só garantem que o backend está de pé numa porta e devolvem `{port, url}`;
nada ali assume um `<iframe>`/`VsshAppWindow` do outro lado. Um app `"type": "engine"`
aproveita exatamente esse mesmo lifecycle, só que consumido por **outra janela ou feature já
existente do desktop** (nativa, ou até outro app) em vez de aberto pelo usuário via
Launchpad/Start Menu/`AppLauncher.open()`.

Diferenças concretas em relação a um app `"type": "app"` normal:
- **Sem `window` no manifest** (não se aplica — não existe `VsshAppWindow` pra ele).
- **Não aparece no Launchpad/Start Menu/menu de apps** — `AppLauncher.listApps()` (consumido por
  ambos pra montar a seção "Apps Integrados") filtra `type !== 'engine'` antes de listar.
  `GET /api/apps` continua devolvendo a entrada (com `type: 'engine'`) pra quem precisar
  descobri-la programaticamente — só a UI de lançar apps é que a esconde.
- **Não usa `AppLauncher.open()`** (que monta janela). Em vez disso, o consumidor chama
  `AppLauncher.ensureRunning(appId)` — mesma chamada a `POST /api/apps/:id/start` que `open()` já
  fazia internamente, só que devolve `{port, url}` sem montar nada — e fala com o backend
  diretamente por `fetch`/WebSocket relativo a essa `url` (mesmo cuidado de sempre: derive
  qualquer URL absoluta — em especial WebSocket — de `location.href`/da própria `url` devolvida,
  nunca hardcode o path, já que ele inclui o `serverId` dinâmico).
- **Não faz sentido declarar `"handles"`** — esse campo é sobre substituir um launcher embutido
  por uma janela alternativa; um `engine` não tem janela nenhuma pra oferecer como substituta.

### `"alwaysRunning": true` (opt-in) — quando o consumidor não pode esperar sob demanda

Por padrão, um `engine` só sobe quando o consumidor chama `AppLauncher.ensureRunning(appId)` —
sob demanda, na primeira vez que é efetivamente usado. Isso não serve pra todo consumidor: um
**service worker só pode chamar `importScripts()` de forma síncrona durante sua própria avaliação
inicial** (nunca depois — nem de dentro de um handler de `install`/`message`/`fetch`; navegadores
modernos bloqueiam isso ativamente). Se o seu `engine` precisa estar de pé **antes** de qualquer
handshake assíncrono ser possível (esse é o caso), declare `"alwaysRunning": true` no manifest —
`GET /api/apps` expõe esse campo, e o consumidor deve chamar `AppLauncher.ensureRunning(appId)`
de forma *eager* (o quanto antes, best-effort, sem bloquear o resto da página) em vez de esperar
o primeiro uso real — ver `custom_xprahtml5/index.html` (chama antes de registrar o service
worker) e `custom_xprahtml5/sw.js` (faz o `importScripts` incondicional, síncrono, no topo do
arquivo, sob `try/catch` — nunca dentro de um listener).

Importante: o proxy do portal **recusa** (409, ver `checkAppStatus` em `src/proxy.ts`) qualquer
requisição pro app enquanto o processo não estiver de fato confirmado rodando — não é só "a porta
ainda não foi alocada", é uma checagem ativa. Por isso o `ensureRunning` eager precisa ser
**esperado de verdade** antes de registrar o service worker (não uma corrida contra um teto
curto/arbitrário) — `POST /api/apps/:id/start` já tem seu próprio teto interno de ~15s no
healthcheck; um timeout externo só faz sentido como rede de segurança contra travamento de rede
(bem mais generoso que esses ~15s), não como caminho normal. Isso só adiciona espera de fato em
servidores que realmente têm um app `alwaysRunning` instalado — sem nenhum, a checagem resolve
quase instantâneo. Ver `custom_xprahtml5/index.html` pro exato ponto onde isso é esperado antes
de `navigator.serviceWorker.register(...)`.

Quando usar: sempre que o valor do app é uma capability de backend (um proxy, um motor de
processamento, um servidor de protocolo) que uma janela/feature **já existente** do desktop
vai orquestrar — não um programa novo que o usuário abre e interage diretamente. Ver
`scramjet-wisp/` (motor de reescrita web via `wisp-js`, consumido pelo `BrowserWindow`
nativo como um motor alternativo à extensão de navegador, `alwaysRunning: true` por causa da
restrição de `importScripts` acima) como referência completa.

## Rich chrome opcional (abas no cabeçalho + menu de contexto)

Por padrão, todo vssh-app abre num `<iframe>` genérico (`VsshAppWindow`) com um
cabeçalho simples (ícone + título + botões de janela) e um menu de contexto genérico
(minimizar/maximizar/fixar/fechar). Um app pode optar por uma tabbar de verdade no cabeçalho da
janela e itens de aba no menu de contexto, reaproveitando o mesmo mecanismo que janelas nativas
do portal (como o terminal) já usam — coloque `"richChrome": true` dentro de `"window"` no
manifest.

Como o estado real das abas vive dentro do JS do próprio app (dentro do iframe, sem acesso ao JS
do portal), a comunicação é via `postMessage` — só dados (strings `id`/`title`), nunca HTML; o
chrome do portal sempre monta os botões da aba ele mesmo:

```js
// Do app (iframe) pro chrome (pai):
window.parent.postMessage({ vsshApp: true, type: 'tabs', tabs: [{ id, title, sessionName? }], activeTabId }, location.origin);

// Do chrome (pai) pro app (iframe) — escute via window.addEventListener('message', ...)
// e filtre por e.origin === location.origin && e.source === window.parent:
{ vsshApp: true, type: 'activate-tab' | 'close-tab' | 'new-tab', tabId? }
{ vsshApp: true, type: 'restore-tabs', tabs: [{ sessionName }] | null, activeSessionName }
```

Mande uma mensagem `tabs` sempre que o conjunto de abas ou a aba ativa mudar (nova aba, aba
fechada, título mudou). Trate `new-tab`/`activate-tab`/`close-tab` chamando as mesmas funções
internas que seus próprios atalhos de teclado/UI já usam. Ver `terminal-latch/frontend/
index.html` para uma implementação completa de referência.

### Restaurar abas entre reloads (opt-in, via `sessionName`)

Se seu app tem algum identificador estável por aba que sobrevive a um reload (ex.: nome de sessão
de um multiplexador de terminal, como o terminal-latch) e você quer que `WindowStateManager`
restaure as abas certas depois de um F5, inclua esse identificador como `sessionName` em cada
entrada de `tabs`. `VsshAppWindow._getState()` já persiste `tabs`/`activeSessionName` no
lock file da janela automaticamente (sem nenhum código seu além de mandar `sessionName`), e manda
de volta uma mensagem `restore-tabs` assim que o iframe carrega (`tabs: null` quando não há nada
salvo — abertura nova). Trate essa mensagem recriando uma aba por `sessionName` recebido (nunca
reaproveite o `id` antigo, que é só bookkeeping local efêmero) e ativando a que casar com
`activeSessionName`. Apps sem `sessionName` simplesmente não têm abas restauradas — nenhum erro,
só nada é persistido.

### Limpeza no fechamento explícito da janela (opt-in, via `POST <baseUrl>close-tabs`)

Se fechar a aba/sessão de verdade (não só esquecer) importa pro seu app (de novo, caso do
terminal-latch, que mata a sessão do motor ao fechar), exponha um endpoint
`POST close-tabs` (caminho relativo à raiz do seu app) que aceite `{sessions: [string, ...]}` e
encerre cada uma. `VsshAppWindow._beforeClose()` chama esse endpoint via `fetch()` do
**documento pai** (não do iframe) assim que a janela é fechada explicitamente (X, "Fechar" no
menu) — antes de qualquer coisa ser removida da DOM, mas o iframe pode não sobreviver tempo
suficiente pra reagir a um `postMessage` nesse instante, por isso o pai fala direto com seu
backend. F5/crash não passam por aqui (o documento inteiro é descartado antes de qualquer JS
rodar) — só fechamento explícito. Apps que não implementam esse endpoint simplesmente recebem um
404 ignorado; nada quebra.

Escopo do que **não** está incluído: um menubar completo tipo "Arquivo/Editar/Exibir" (dropdowns)
não tem mecanismo genérico — só a tabbar (via `cap`) e o menu de contexto. Se seu app precisar de
mais que isso, o menu de contexto já é o lugar certo pra colocar ações extras (mesma ponte
`postMessage`, mais itens).

## Abrir um arquivo do servidor no visualizador vssh (`open-file`/`open-folder`)

Disponível a **qualquer** vssh-app (não precisa de `richChrome`): o app manda, do iframe pro
documento pai, um path absoluto de arquivo/pasta no servidor Linux, e o portal abre no
visualizador integrado certo pela extensão (PDF/vídeo/imagem no `BrowserWindow`, texto no editor,
office no `OfficeEditorWindow`, arquivo compactado no `ArchiveWindow`; pasta no gerenciador de
arquivos). Útil pra apps cujos resultados são arquivos reais — ex.: um resultado de busca do Recoll.

```js
// Do app (iframe) pro desktop (pai) — sempre com location.origin como targetOrigin:
window.parent.postMessage({ vsshApp: true, type: 'open-file',   path: '/home/user/doc.pdf' }, location.origin);
window.parent.postMessage({ vsshApp: true, type: 'open-folder', path: '/home/user/Documents' }, location.origin);
```

O **pai** (`VsshAppWindow._setupAppBridge`) roda no documento do desktop
(`/<serverId>/xpra/`), então ele mesmo monta a URL `../../api/fs/read?path=...` (com Range/206 já
pronto pra vídeo/PDF grande) — **o app nunca precisa saber o `serverId` nem construir essa URL**,
só mandar o path absoluto. O handler é filtrado por `e.source === iframe.contentWindow`, então cada
janela só trata os eventos do próprio iframe. Se o app roda fora do desktop (dev standalone,
`window.parent === window`), não há pai vssh — trate isso no seu lado (ex.: um toast). O dispatch por
extensão reaproveita `FileBrowserWindow.openPathInViewer(path)` / `FileBrowserWindow.openFolder(path)`
(ver `custom_xprahtml5/js/FileBrowserWindow.js`); `vsshapp-recoll/static/js/utils.js`
(`openInViewer`/`openFolder`) é a implementação de referência do lado do app.

## App padrão por categoria (opt-in, via `"handles"` no manifest)

Um vssh-app pode se registrar como substituto de um dos 5 launchers embutidos do desktop:
`terminal`, `editor`, `fileBrowser`, `vscode`, `browser` — basta declarar `"handles": "terminal"`
(ou o valor correspondente) no manifest. Isso NÃO troca o comportamento sozinho: o usuário escolhe
explicitamente em **Configurações → Aplicativos → Apps Integrados por Categoria** qual app usar
pra cada categoria (persistido em `categoryHandlers`, ver `src/routes/settings.ts`); sem essa
escolha, o app embutido continua sendo o padrão mesmo que seu manifest declare `handles`.

Mecanismo (nenhum código seu além do campo no manifest): cada `*Launcher.js` nativo
(`TerminalLauncher.js`, `TextEditorLauncher.js`, `FileBrowserLauncher.js`, `VsCodeLauncher.js`,
`BrowserLauncher.js`) checa `window.vsshSettings?.categoryHandlers?.<categoria>` antes de abrir a
janela embutida — se apontar pro seu app, chama `AppLauncher.open(appId)` no lugar.

### Contexto de abertura (opt-in, via `open-context`)

Ações como "Abrir Terminal Aqui" carregam contexto extra (uma pasta, um arquivo) que a janela
embutida usaria — isso só chega ao seu app se ele optar por entender. `AppLauncher.open(appId,
serverId, restoreState, openContext)` aceita um 4º parâmetro (ex.: `{ path: '/home/user/foo' }`,
mandado por `TerminalLauncher.js` hoje) que `VsshAppWindow` repassa via `postMessage` assim
que o iframe carrega (ou imediatamente, se a janela já estava aberta):

```js
// Do chrome (pai) pro app (iframe):
{ vsshApp: true, type: 'open-context', path? }
```

Cabe ao seu app decidir o que fazer com isso — não há um formato universal além de `path`, já que
o significado depende inteiramente do que seu app faz. terminal-latch (`terminal-latch/
frontend/index.html`) trata `path` mandando `cd <path>` como input assim que a sessão conecta (não
dá pra fazer isso invisível como o terminal dtach embutido faz, já que o motor já inicia a sessão
só com o nome, sem espaço pra injetar um cwd antes do shell interativo começar — trade-off aceito:
o usuário vê o `cd` sendo "digitado"). Apps que não tratam `open-context` simplesmente ignoram a
mensagem — nenhum erro.

Com o shim, isso é `vssh.onOpenContext(({ path }) => { ... })`.

## Abrir tipos de arquivo (opt-in, via `"opens"` no manifest)

`handles` cobre só os 5 launchers embutidos. Para o app aparecer quando o usuário abre **um tipo de
arquivo**, declare o que ele sabe abrir:

```jsonc
"opens": { "extensions": ["md", "org"], "mimeTypes": ["text/markdown"] }
```

O que isso liga, sem código nenhum além do campo:

- o app entra no submenu **"Abrir com"** do gerenciador de arquivos, junto (ou no lugar) dos apps
  Linux nativos;
- fica elegível como **padrão daquele tipo** em Configurações → Aplicativos; escolhido, o
  duplo-clique passa a abrir nele em vez do visualizador embutido;
- o arquivo chega ao app via `open-context` (seção acima) — é o único código que você escreve.

Por que isso importa mais do que parece: o "Abrir com" era montado exclusivamente de `.desktop`
nativos, e o `vssh-app-install` deliberadamente não gera `.desktop`. Num ambiente **sem X11 não há
`.desktop` nenhum** — então os vssh-apps passam a ser os únicos habitantes daquele menu.

## O que cabe nesse padrão

Qualquer ferramenta com uma UI própria que hoje você rodaria como um site local ou um script
com output em terminal: busca full-text sobre um índice existente, um dashboard de métricas, um
visualizador de logs, notas rápidas, um painel de administração de algum serviço do próprio
servidor. O padrão é o mesmo para todos — a diferença está só no que o `backend/main.py` (ou
equivalente) faz com a requisição.
