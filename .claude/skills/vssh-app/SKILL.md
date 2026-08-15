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
escolher arquivo, controlar a janela: [`docs/api.md`](../../../docs/api.md) é a referência completa,
com uma seção final sobre o que **não** existe. Esta SKILL cobre empacotar e instalar; aquela,
programar contra o ambiente.

**Portando um app que já existe** (web, Electron ou Tauri)? Comece por
[`docs/porting.md`](../../../docs/porting.md): tem a árvore de decisão e como medir, em minutos, o que
falta num app concreto.

## Antes de codar: checklist de decisão

- **Precisa de lógica própria no servidor, ou é só HTML/CSS/JS estático?** Mesmo estático, ainda
  precisa de um processo escutando — o proxy do portal encaminha para o endereço do app, não serve
  um diretório diretamente. Esse endereço é um **socket unix** desde a Onda 9 (ver abaixo).
- **Precisa de estado que sobreviva entre execuções** (índice, cache, arquivos gerados)? Vai em
  `VSSH_APP_DATA_DIR`. Nunca escreva em `/opt/vssh-apps/<id>/` — é root-owned e somente leitura.
- **Precisa de tempo real (WebSocket)?** O proxy encaminha WS automaticamente, sem configuração
  extra — trate como qualquer outra rota do seu backend.
- **Qual runtime?** Qualquer um que saiba bindar num **socket unix** em `$VSSH_APP_SOCKET` —
  `python3`/`node`/`binary` são os declarados no manifest, mas o mecanismo é agnóstico de
  linguagem. Um runtime que só saiba bindar porta declara `backend.transport: "tcp"` e assume o
  que isso custa (ver "Onde o backend escuta").
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
  "category": "Utility",              // a seção do Start Menu/Launchpad onde o app aparece. Use um
                                       // nome de categoria do menu freedesktop ("Development",
                                       // "Office", "Graphics", "Utility", "System"…) pra cair junto
                                       // do que faz a mesma coisa; sem declarar, o app vai pra
                                       // "Other". ⚠ **Era só informativo, e não é mais**: até a
                                       // Onda 9 o cliente jogava TODO vssh-app numa seção fixa
                                       // "Apps Integrados" e este campo não valia nada — resquício
                                       // de quando o ambiente X11 era o padrão e um vssh-app era a
                                       // exceção em destaque (não gera .desktop/XDG — ver "Como o
                                       // app aparece no menu" abaixo)
  "description": "...",
  "handles": null,                    // opcional: "terminal"|"editor"|"fileBrowser"|"ide"|
                                       // "browser" — registra este app como substituto de um
                                       // launcher embutido (ver "App padrão por categoria" abaixo).
                                       // ⚠ **`ide` chamava-se `vscode`**, e era o único valor que
                                       // nomeava um PRODUTO em vez de um papel; o nome antigo
                                       // continua aceito e é traduzido na entrada, mas declare
                                       // `ide`
  "opens": {                          // opcional: tipos de arquivo que este app sabe abrir. É o
    "extensions": ["md", "org"],       // que coloca o app no submenu "Abrir com" e o torna
    "mimeTypes": ["text/markdown"]     // elegível a padrão por tipo (Configurações →
  },                                   // Aplicativos). O arquivo escolhido chega via
                                       // `open-context` (ver seção abaixo). Generaliza `handles`,
                                       // que só cobre os 5 launchers embutidos.
  "requiredPackages": ["ffmpeg",      // opcional: pacotes Linux de que o app precisa para
    "chromium | google-chrome-stable"],// funcionar. DECLARAR é o ponto — hoje uma dependência de
                                       // sistema se esconde num installCommand opaco, e não há
                                       // como responder "este app roda neste servidor?" sem
                                       // executá-lo. Nomes no formato Debian: o publish RECUSA
                                       // qualquer coisa fora de `^[a-z0-9][a-z0-9+.-]*$`, porque
                                       // este valor chega a um gerenciador de pacotes no servidor
                                       // e um metacaractere de shell ali seria injeção.
                                       // CADA ITEM É UMA EXIGÊNCIA, e ela pode ter ALTERNATIVAS
                                       // separadas por `|` — o idioma do `Depends: a | b` do
                                       // Debian, e qualquer uma satisfaz. Use quando o que você
                                       // precisa é uma FERRAMENTA cujo pacote muda de nome com a
                                       // distro ou vem de repositório de terceiro: um motor de
                                       // impressão que declarasse só "chromium" seria recusado
                                       // num servidor com Chrome e Edge instalados, que rodaria
                                       // o app perfeitamente. A ordem é a de PREFERÊNCIA — é a
                                       // primeira que as mensagens de erro mandam instalar.
                                       // O `|` é o único metacaractere admitido, e ele nunca
                                       // atravessa como shell: quem confere separa antes.
                                       // Quem VERIFICA é o servidor: o `vssh-app-install` RECUSA
                                       // antes de copiar nada, nomeando o que falta e a linha de
                                       // `apt-get` que resolve (escape: --sem-checar-pacotes). E o
                                       // painel admin mostra, por servidor, o que falta para cada
                                       // app — inclusive os ainda NÃO instalados, que é quando a
                                       // pergunta "roda aqui?" vale mais. Num servidor sem
                                       // `dpkg-query` a resposta é "não conferido", não "falta".
  "resources": {                      // opcional: limites de recurso do PROCESSO do app. Todo
    "memoryHigh": "70%",               // vssh-app já sobe contido por um teto PADRÃO de memória e
    "memoryMax":  "85%",               // de tarefas — este bloco é para quem precisa de outro, para
    "cpuQuota":   "none",              // mais ou para menos. Aplicado por `systemd-run --user
    "tasksMax":   "25%"                // --scope` no vssh-app-run, sobre o GRUPO de processos, então
  },                                   // alcança os filhos que o app gerar (que é onde um treino
                                       // desgoverna). `"none"` desliga aquele teto de propósito —
                                       // um app que precisa de toda a máquina tem de poder dizer
                                       // isso, em vez de contornar o mecanismo por fora.
                                       // `cpuQuota` NÃO tem padrão: CPU disputada deixa lento, e o
                                       // escalonador já reparte; memória esgotada derruba a sessão.
                                       // "100%" é UM núcleo — `"2"` não é dois núcleos, é 2%, e o
                                       // publish recusa para que o engano não chegue ao servidor.
                                       // Isto contém UM app desgovernado, não a soma deles.
                                       // Num servidor sem `systemd-run` ou sem gerenciador systemd
                                       // do usuário (`loginctl enable-linger`), o app SOBE assim
                                       // mesmo, sem limite — e Configurações → Serviços diz isso,
                                       // com o motivo. Contenção que falha não pode virar app que
                                       // não sobe.
  "gpu": false,                       // opcional (padrão false): o app precisa da GPU. Declarar faz
                                       // DUAS coisas independentes.
                                       //
                                       // 1. DESCOBERTA, e ela é GENÉRICA. O ambiente consulta o
                                       //    KERNEL (/sys/class/drm + /dev/dri), não um SDK — então
                                       //    responde para NVIDIA, AMD, Intel, virtio, e para placa
                                       //    VIRTUAL, sem depender de driver proprietário. Reporta
                                       //    fabricante (id do PCI), driver, se é virtual, e se o
                                       //    processo consegue ABRIR o render node. Essa última é a
                                       //    que mais trava gente: o dispositivo existe e o usuário
                                       //    não está no grupo `render` (usermod -aG render <user>).
                                       //    O app também pode ler /sys e /dev por conta própria —
                                       //    o valor de declarar é a resposta vir uniforme, e o
                                       //    portal poder MOSTRÁ-LA.
                                       //
                                       // 2. PORTÃO, e ele é só de CUDA — a única API com variável
                                       //    padrão que o runtime respeita. Quem NÃO declara recebe
                                       //    `CUDA_VISIBLE_DEVICES=""` e não enumera dispositivo
                                       //    CUDA nenhum, que é o que deixa um app de inferência
                                       //    conviver com os vizinhos. **Convenção, não
                                       //    isolamento:** não fecha /dev/dri, e a fronteira de
                                       //    verdade exigiria cgroup de dispositivo (eBPF, root).
                                       //
                                       // Declarar num servidor sem GPU NÃO impede o app de subir —
                                       // GPU ausente costuma significar "mais lento", e quem sabe
                                       // degradar é o app. Mas o motivo fica no run.log e em
                                       // Configurações → Serviços, com quatro respostas: negada,
                                       // concedida (com o resumo), não entrega (com o motivo), e
                                       // NÃO SEI — que não é o mesmo que "não tem".
  "secrets": [                        // opcional: credenciais que o app recebe pelo AMBIENTE.
    { "name": "OPENAI_API_KEY",        // Declarar é o ponto: sem isto cada app inventa o seu,
      "description": "Chave da API.",  // normalmente um arquivo em texto plano no
      "required": true }               // VSSH_APP_DATA_DIR, e o usuário não tem onde pôr a chave.
  ],                                   //
                                       // O VALOR NUNCA VEM DAQUI — o publish RECUSA um manifesto
                                       // com `value`/`valor`/`default`, porque isso seria commitado
                                       // e distribuído a todo servidor que instalasse o app.
                                       // Quem guarda é o usuário, em Configurações → Segredos, e o
                                       // valor mora em ~/.vssh-apps/<id>/secrets.json (modo 0600)
                                       // no servidor DELE. O portal grava e esquece: não há coluna
                                       // de segredo no portal, e a tela nunca relê o valor.
                                       //
                                       // No app é `process.env.OPENAI_API_KEY` — variável de
                                       // ambiente comum. O ambiente de um processo é fixado no
                                       // start, então guardar um segredo exige REINICIAR o app.
  "provides": ["llm/v1"],             // opcional: capacidades que este app oferece a OUTROS apps,
                                       // em "nome/vN". É o que permite trocar o produtor sem tocar
                                       // no consumidor: um app de chat pede "llm/v1" e recebe o
                                       // motor instalado, seja ollama, vLLM ou outro — em vez de
                                       // fixar um appId no código. Do lado do shell:
                                       // AppLauncher.appComCapacidade("llm/v1"). A versão é
                                       // OBRIGATÓRIA: capacidade é contrato entre repositórios que
                                       // não se conhecem, e contrato sem versão só muda quebrando
                                       // alguém em silêncio. Declarar NÃO é provar — o ambiente
                                       // não verifica; quem não puder atender falha por dentro,
                                       // que é onde sabe dizer por quê.
  "minShellVersion": "4.1",           // opcional, e o padrão é NÃO declarar. Só declare se usar
                                       // algo que não existia antes — a mesma regra do `engines`
                                       // do npm. Quem confere é o PORTAL, na instalação (é ele que
                                       // sabe a versão do shell que serve); o vssh-app-install
                                       // roda offline no servidor e não tem como saber. NÃO
                                       // substitui vssh.capabilities(): um é gate de instalação,
                                       // o outro é decisão de runtime.
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
    "aoFechar": "encerrar",           // opcional, default "encerrar" — o que acontece com o
                                       // backend quando a ÚLTIMA janela deste app fecha.
                                       // "encerrar": o ambiente chama o stop. "manter": o backend
                                       // fica, porque quem o mantém vivo é o trabalho e não a
                                       // janela (dono de sessão de terceiro — um servidor de
                                       // notebooks, um build em curso).
                                       // Até a Onda 9 não havia contrato: fechar a janela não
                                       // encerrava NADA, e a conta escalava por (usuário × app já
                                       // aberto uma vez) — um app aberto em março seguia ocupando
                                       // RAM em agosto, em toda sessão daquela conta.
                                       // kind:"service" IGNORA este campo: um daemon não morre
                                       // com uma janela, por definição.
                                       // ARMADILHA: se o seu app segura processo caro que o
                                       // usuário espera encontrar de volta (terminal, build), o
                                       // valor é "manter" — o padrão vai matá-lo.
    "healthcheckPath": "/"            // opcional; endpoint que o lifecycle do portal faz poll até
                                       // responder (até 15x/1s, síncrono, bloqueando o clique de
                                       // "abrir app" do usuário) — responda rápido e sem depender
                                       // de setup pesado ou de uma ferramenta externa que o
                                       // backend envolva ainda não estar pronta.
                                       // A sondagem vai COM o header X-Vssh-App-Token, então
                                       // gatear esta rota é permitido; o que NÃO conta como
                                       // pronto é 000, 5xx e 401/403. Um 404 conta (o servidor
                                       // respondeu) — se o caminho estiver errado, o healthcheck
                                       // vira teatro sem ninguém avisar, então confira. Sirva algo
                                       // estático e trate o estado real em endpoints próprios.
  },
  "window": {
    "title": "Meu App",
    "width": 900,
    "height": 640
  }
}
```

**Campo que o schema não conhece é recusado no `vssh-app-publish`, em todo objeto do manifesto** —
inclusive na raiz, que era a última a aceitar qualquer chave. O motivo é o caso que isso deixava
passar: `requiredPackage` sem o `s` publicava limpo, e o app instalava sem verificar pacote nenhum;
`widht: 900` em `window` abria a janela no tamanho padrão sem uma linha de log. O erro nomeia o
vizinho quando há um (*"você quis dizer `requiredPackages`?"*). Se você precisa de um campo que o
schema não tem, ele entra no schema — não no manifesto.

Se o `backend.runtime` for `"node"` (ou qualquer outro com um gerenciador de pacotes real) e o app
tiver dependências de verdade, prefira **vendorizar `node_modules/` já instalado** (rodar
`npm install`/`npm ci` uma vez em dev/CI e commitar o resultado no pacote) — mesma lição do binário
Go compilado do `terminal-latch` (abaixo), só que pra dependências npm. O motivo é a regra de
empacotamento do parágrafo seguinte: **o publish leva o que está versionado**, então uma dependência
não commitada só existe no servidor se alguém a instalar lá. `installCommand` fica como rede de
segurança/rebuild (`test -d node_modules || npm ci`), guardado pelo mesmo idioma
`VSSH_APP_REBUILD` já usado pro binário Go.

> Isto **não** é porque o servidor-alvo não alcança o registry — ele alcança. Essa justificativa
> estava escrita aqui e em outros dois documentos, entrou num único commit de desenho e nunca foi
> medida; foi removida. Vendorizar continua sendo o caminho recomendado pelo motivo acima (um
> tarball auto-suficiente instala igual sempre, e não depende da rede do servidor no momento da
> instalação), mas é uma escolha de reprodutibilidade, não uma restrição de conectividade.

**O que entra no tarball:** `vssh-app-publish` empacota **o que está versionado** (quando a fonte é
um repo git, via `git archive`; senão, um `tar` que só exclui `.git`/`data`/`__pycache__`/`*.pyc`).
Ou seja: `node_modules/`/`vendor/` **commitados entram** e são servidos ao servidor; os que o
`.gitignore` do pacote ignora ficam de fora (e aí dependem do `installCommand` reconstruir no
servidor). Vendorizar = commitar; se quiser reconstruir no alvo, deixe a pasta no `.gitignore`.

### Variáveis de ambiente injetadas no processo do backend

| Variável | Descrição |
|---|---|
| `VSSH_APP_SOCKET` | **O endereço, desde a Onda 9.** Caminho de um socket unix em `~/.vssh-apps/<id>/`, diretório que já é 0700. É onde o backend **deve** bindar. |
| `VSSH_APP_PORT` | Só chega a apps que declaram `backend.transport: "tcp"`. Porta TCP em `127.0.0.1`. |
| `VSSH_APP_BASE_PATH` | Valor literal `/proxy/app/<id>/` (**sem** serverId) — é o que o processo do backend recebe (`key-provisioner.ts`, `startApp`). **NÃO** é a URL pública completa que o navegador usa: essa inclui o serverId (`/<serverId>/proxy/app/<id>/`, ver `src/proxy.ts`). Só importa se o backend emitir URLs absolutas; com `fetch()` relativo não precisa — não construa link absoluto a partir desta variável sem prefixar o serverId separadamente (você não tem como saber o serverId aqui de qualquer forma). |
| `VSSH_APP_DATA_DIR` | `~/.vssh-apps/<id>/data` — único diretório gravável garantido. |
| `VSSH_APP_ID` | O próprio `id` do manifest. |
| `VSSH_APP_TOKEN` | Opcional/defesa-em-profundidade: valor opaco gerado por instância de app rodando, injetado pelo proxy como header `X-Vssh-App-Token` em toda requisição/upgrade que ele encaminha pra esse app. Apps que concedem acesso sensível (shell, arquivos) podem checar esse header e recusar qualquer conexão que não tenha vindo pelo proxy autenticado — útil porque o socket é 0600 do dono, mas ainda alcançável por outro processo do MESMO usuário Linux (e, até a Onda 9, o endereço era uma porta de loopback — alcançável por QUALQUER conta da máquina, o que foi medido e é a razão da troca). Apps que não se importam (ex. `hello-world`) simplesmente não checam nada. |

Sem modelo de permissão além de "roda como o usuário Linux dono da sessão" — mesmo modelo de
confiança que code-server e Xpra usam para qualquer outro processo do usuário.

### Onde o backend escuta

**Esta seção dizia "Alocação de porta", e a mudança é de fundo:** o endereço de um vssh-app não é
mais ALOCADO de um recurso escasso, é **derivado da identidade** — `$HOME/.vssh-apps/<id>/app.sock`.
O portal deriva o mesmo caminho, então não há o que combinar, nem cache que possa divergir, nem
colisão entre usuários.

O motivo não é limpeza: **o loopback não tem dono.** Qualquer conta Linux da máquina alcançava a
porta do backend do vizinho, e isso foi medido — 23 portas de app escutando, 14 responderam a um
`GET /` sem token (10×200, 4×500), **12 delas de outras contas**. Um socket em diretório 0700 faz
com permissão de arquivo o que a conferência de `X-Vssh-App-Token` só promete.

Quem usa as libs não faz nada disto à mão: `escutar(server)` do `vssh-app-toolkit/listen` lê o
endereço, limpa socket órfão (só `SIGKILL` deixa um) e falha alto quando não veio endereço nenhum.

> **Um app novo não precisa mais pensar em porta.** Se o seu runtime não souber bindar socket unix,
> declare `backend.transport: "tcp"` no manifesto: aí — e só aí — o portal aloca uma porta por
> (usuário, app) e a entrega em `$VSSH_APP_PORT`. Hoje há **um** caso assim no ambiente, o xpra,
> cujo listener de WebSocket só aceita `HOST:PORT` (medido na 6.5.2).

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
    main.py                 # entrypoint — deve bindar no socket unix de $VSSH_APP_SOCKET
    requirements.txt         # opcional
```

O backend serve tanto os arquivos estáticos do frontend quanto qualquer API própria (ex:
`/api/ping`, `/api/search`) — o proxy do portal encaminha tudo sob
`/<serverId>/proxy/app/<id>/*` para o endereço do app (`$VSSH_APP_SOCKET`), WebSocket incluído.

**Use `fetch()` com URLs relativas** (`fetch('api/ping')`, não `fetch('/api/ping')`) — assim o
frontend funciona sem alterações sob o prefixo `/proxy/app/<id>/`. Só recorra a
`VSSH_APP_BASE_PATH` se o backend precisar emitir URLs absolutas (ex: links profundos em
respostas JSON).

## Não reimplemente: as bibliotecas do toolkit

Quatro problemas aparecem em todo app, e todo mundo erra do mesmo jeito na primeira vez. Já estão
resolvidos em `lib/`, **nos dois runtimes**, e elas se instalam (antes eram copiadas por um script
próprio, `vssh-app-lib-sync`, que morreu por ter deixado dois apps com libs de outra major sem
avisar):

```bash
npm i github:colabhd/vssh-app-toolkit#v4                                                # Node
pip install "https://github.com/colabhd/vssh-app-toolkit/archive/refs/tags/v4.tar.gz"   # Python
```

```js
const { createAppLog } = require('vssh-app-toolkit/log');
const { createStaticSpa } = require('vssh-app-toolkit/spa');
const { escutar } = require('vssh-app-toolkit/listen');
const { WEB_DIR, SHIMS } = require('vssh-app-toolkit/web');   // as libs de NAVEGADOR
```

```python
from vssh_app_toolkit.log import criar_log_do_app
from vssh_app_toolkit.spa import criar_spa_estatica
from vssh_app_toolkit.listen import criar_servidor
from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS       # as libs de NAVEGADOR
```

> **As libs de NAVEGADOR são as mesmas nos dois.** O shim e o polyfill rodam no navegador — o que
> muda é só quem os SERVE. Um backend Python com o `vssh` completo é uma questão de montar o
> diretório certo, e não de portar JavaScript.

No servidor, quem instala é o `installCommand` do manifesto — e ele não precisa de `git` nem de
chave SSH no alvo (medido em `node:22-slim`, sem os dois, 1 s; do lado Python é a mesma
propriedade, e por isso o endereço é o **tarball**, não `git+https://`):

```jsonc
// Node
"installCommand": "( [ \"${VSSH_APP_REBUILD:-}\" != 1 ] && test -d node_modules ) || npm ci --omit=dev"

// Python — declare `python3-pip` em requiredPackages, senão o servidor sem pip só se descobre
// quando o primeiro usuário abre o app (a segunda execução do installCommand falha, e o app não
// sobe PARA AQUELE usuário)
"installCommand": "( [ \"${VSSH_APP_REBUILD:-}\" != 1 ] && test -d vendor/py ) || python3 -m pip install --no-cache-dir --target vendor/py \"https://github.com/colabhd/vssh-app-toolkit/archive/refs/tags/v4.tar.gz\""
```

Se preferir levar o `node_modules` dentro do tarball, não o ignore no `.gitignore`: o publish
empacota o que `git add -A` pega. O `vssh-app-publish` recusa publicar um app cujas libs sejam de
outra **major**, e recusa também um app que declare a dependência sem levá-la nem instalá-la.

As mesmas nove peças existem nas duas árvores, com as mesmas garantias — uma armadilha do socket
unix não deixa de existir porque o backend é Python.

| Node | Python | Resolve |
|---|---|---|
| `app-listen.js` | `listen.py` | Bindar onde o lifecycle mandou. Limpa socket órfão **por tentativa de conexão** (nunca por "o arquivo existe", que derrubaria a instância viva), põe o modo 0600 contra o umask e falha alto quando não veio endereço nenhum. |
| `app-log.js` | `log.py` | Log estruturado em `$VSSH_APP_DATA_DIR`. **Comece por esta**, na primeira linha de código. |
| `static-spa.js` | `spa.py` | Servir uma SPA construída sob o prefixo do proxy: 304, `mounts`, prefixos alias, injeção de script de boot com **carimbo de versão** (o conserto do cache velho — ver abaixo), fallback de SPA. |
| `sse.js` | `sse.py` | Server-Sent Events com os headers que sobrevivem ao proxy e ao CDN. Sem eles os eventos chegam em lote, ou nunca — e sem erro nenhum. |
| `vssh-app-fs/` | `fs/` | Filesystem **privado** do app por HTTP: confinado a uma raiz, token-gated, errno classificado. |
| `vssh-tray.js` | `tray.py` | Ícone na bandeja para app **sem janela** (`engine`/`service`) — escrita atômica de `tray.json`, e o clique volta como POST no seu backend. App COM janela usa `vssh.tray.*` do shim, que é síncrono. |
| `vssh-notify.js` | `notify.py` | Avisar o usuário **do backend**, inclusive com o desktop fechado. Cuida do `id`, que é a chave de deduplicação de ponta a ponta e falha em silêncio nos dois sentidos quando é escrito na mão. `key` para avisar uma vez só. App COM janela usa `vssh.notify()` do shim. |
| `vssh-live.js` | `live.py` | "O que está acontecendo AGORA", com barra — e o `at` renovado, sem o qual a atividade some no meio de uma tarefa longa. |
| `web-assets.js` | `web.py` | O diretório dos `.js` que o NAVEGADOR carrega, para o `mounts` do SPA. |

Comece pelo template do seu runtime (`templates/hello-vssh-app/` para Python, `templates/hello-vssh-app-node/` para Node) — os dois já nascem com tudo isso ligado.

## Falar com o desktop: diálogo, notificação, seletor, arquivos

**Não construa essa UI.** O desktop já tem, e o app alcança por uma ponte de `postMessage` —
carregue `lib/web/vssh-app-shim.js`. São **dois passos**, e esquecer o primeiro é o erro clássico:
o navegador é quem carrega essa lib, então alguém tem de **servi-la**. Ela mora no `node_modules`,
fora da raiz da SPA; quem a põe numa URL é o `mounts`:

```js
createStaticSpa({
  root: 'frontend',
  mounts: { '/_vssh/': WEB_DIR },                    // vssh-app-toolkit/web
  injectScripts: SHIMS.map((s) => `_vssh/${s}`),     // shim primeiro, polyfill FSA depois
})
```

`injectScripts` **só injeta a tag `<script>`**; quem serve o arquivo é o `static-spa`, e ele só
serve o que está sob `root` ou sob um `mounts`. Sem o mount a tag aponta para 404 e o `vssh` nunca
existe — silenciosamente, porque a página carrega normalmente. Ver
os dois templates, que já vêm com os dois passos ligados.

> **Cache: por que a tag sai com `?v=…`.** O `static-spa` carimba cada script injetado com o hash do
> conteúdo dele e serve a URL carimbada como `immutable`. Não é otimização — é o conserto de um bug
> que custou caro: um shim atualizado e reinstalado, arquivo em disco **certo**, e o navegador
> executando o antigo. `Cache-Control: no-cache` mais `Last-Modified` só funciona se todo o caminho
> colaborar (navegador, proxy do portal, CDN); basta um elo guardar a resposta e o usuário fica com
> bytes velhos sem nenhum sinal. Conteúdo novo morando em **outra URL** não depende de ninguém
> colaborar. O `index.html` é `no-store`, então é ele que traz a URL nova.
>
> **Isso vale para os scripts que o `static-spa` injeta, não para os assets do seu bundle.** Se o seu
> `index.html` referencia `app.js` com nome fixo, ele continua no `no-cache` de sempre — hashear o
> nome dos próprios assets é trabalho do seu bundler, e todo bundler moderno já faz. Se você carimbar
> à mão (`app.js?v=<hash>`), o `static-spa` reconhece e serve como `immutable` de graça.

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

### Se o app toca som, carregar o shim é o que o põe no mixer

O desktop tem um mixer de volume na barra, com uma linha por aplicativo, e **carregar o shim é a
única coisa que o app precisa fazer** — ele multiplica o volume dos `<audio>`/`<video>` e interpõe
um `GainNode` no que vai para `ctx.destination`. O app não chama nada e obedece ao slider.

A consequência de não carregar: um app que toca por **Web Audio** fica **invisível** no mixer.
Não é esquecimento — é a regra do painel, que só lista o que consegue controlar de fato, e um
slider que não morde é pior que slider nenhum. Com `<audio>` o desktop ainda alcança por
varredura, mas quem multiplica em vez de sobrescrever é o shim.

Só de leitura, para quem desenha o próprio controle: `vssh.audio.gain()`, `.muted()`,
`.onChange(cb)`. **Não** reaja ao `onChange` escrevendo `el.volume` — isso desfaz a
multiplicação. Detalhes em [`docs/api.md`](../../../docs/api.md).

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
importa: cada watch segura um vigia vivo no servidor. Ver [`docs/api.md`](../../../docs/api.md).

**Quando usar o `vssh-app-fs` então?** Quando o app quer um store **privado**: uma raiz confinada,
com token próprio, funcionando inclusive fora do desktop. São casos diferentes, não alternativas.

## Rodar o app na sua máquina, sem servidor nenhum

O ciclo mais curto, e o que você vai usar 90% do tempo: o backend só precisa de três variáveis, e
nada no mecanismo exige um servidor VSSH para ele subir.

```bash
SOCK=/tmp/meu-app.sock
VSSH_APP_SOCKET=$SOCK VSSH_APP_ID=meu-app VSSH_APP_DATA_DIR=/tmp/meu-app-data \
  node backend/server.js          # ou python3 backend/main.py

# `--unix-socket` faz o trabalho; o host da URL existe só para ela ser válida.
curl -fsS --unix-socket $SOCK http://app/healthz
curl -fsS --unix-socket $SOCK http://app/api/ping
```

**No Windows isto não roda**, e o motivo é do sistema: o Node não tem socket unix lá
(`listen(caminho)` vira named pipe e responde `EACCES`). Use WSL ou um container — é a mesma razão
pela qual as bancadas de backend dos apps são puladas no win32 dizendo por quê.

> **Quer ver a página no navegador?** Um socket não tem URL. `socat TCP-LISTEN:8080,fork
> UNIX-CONNECT:$SOCK` dá uma porta local para isso — na SUA máquina, não no servidor, que é onde a
> porta era o problema.

Acrescente `VSSH_APP_TOKEN=segredo` para exercitar o gate de token. **O healthcheck do portal vai
COM o header `X-Vssh-App-Token`**, então você pode gatear a rota de healthcheck como qualquer
outra — não precisa isentá-la. (Isentar continua funcionando; é uma rota a menos protegida, não um
erro.)

> Isto mudou na Onda 4, e vale saber por quê: antes a sondagem ia sem header nenhum, um app com
> gate respondia `403`, e `403` não é 5xx — **contava como pronto**. O portal declarava servindo um
> app do qual nunca tinha visto uma resposta de verdade. Hoje `401`/`403` na sondagem significam
> "recusou uma requisição credenciada", e portanto **não** contam como pronto.

O que **não** funciona assim, e por isso precisa do loop com servidor abaixo: a ponte com o
desktop (`vssh.dialog`, `vssh.pickFile`, FSA). Fora do desktop o shim degrada em vez de lançar,
então a página carrega e você desenvolve o resto normalmente.

## Loop de teste local contra um servidor VSSH-SSO real

1. Copie o pacote para um caminho qualquer no servidor Linux de teste (`scp -r meu-app/ servidor:/tmp/meu-app`).
2. Instale como root: `sudo vssh-app-install /tmp/meu-app --force`.
3. Confirme que `/opt/vssh-apps/<id>/` foi criado.
4. Autenticado no portal, `GET /api/apps` deve listar o app (cache de até 60s).
5. Abra o ambiente do usuário no portal — o app aparece no Start Menu/Launchpad, na `category` que
   o manifesto declarou, sem precisar recarregar (TTL de 30s no cliente, ver AppLauncher.js).
6. Se algo falhar: você tem **dois** logs, e eles se complementam.
   - **`~/.vssh-apps/<id>/run.log`** — stdout/stderr do backend, gravado pelo lifecycle. Legível
     sem SSH: clique direito no cabeçalho da janela do app → **Ver log do backend** (ou
     `GET /api/apps/<id>/log?tail=<n>`, com teto de 5000 linhas). É rotacionado para `run.log.1` a
     cada start, então o registro da execução que morreu não se perde — e é a **execução anterior**
     que responde quando o app caiu e subiu de novo, então a janela de log mostra as duas, com
     filtro, acompanhamento ao vivo e download. Configurações → Serviços abre a mesma janela.
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
- **Não gera `.desktop`/XDG** — o app aparece no desktop via `GET /api/apps` direto (no Start
  Menu/Launchpad, na `category` que ele declarou), não via menu XDG nativo. Isso existe de propósito:
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

**Os dois são o MESMO APP, em dois runtimes.** Mesmas peças, mesmas rotas, e o
`frontend/galeria.js` byte a byte idêntico — a escolha entre eles é de **linguagem**, e mais nada.

| | `templates/hello-vssh-app/` | `templates/hello-vssh-app-node/` |
|---|---|---|
| Runtime | Python 3 | Node |
| Instala as libs com | `pip install "…/archive/refs/tags/v4.tar.gz" --target vendor/py` | `npm ci --omit=dev` |
| Já vem com | log estruturado, gate de token resistente a timing, healthcheck isento, SSE, filesystem privado, bandeja pelo backend | idem |
| E também | a **galeria**: uma peça por capacidade do ambiente — ponte, diálogos, menu de contexto, clipboard, arraste nas duas direções, FSA, `vssh.fs` inteiro, OPFS, bandeja, som, impressão, cofre, jump list, duas janelas sobre um backend só | idem |
| Use quando | o seu app é Python | o seu app é Node |

> **A galeria é para instalar, não só para ler.** Ela é a resposta a "este servidor faz isto?" —
> cada peça diz o que PROVA, e a primeira delas (*Ambiente*) mostra a versão do shim que o app
> carrega ao lado da versão do shell daquele servidor, que é o que explica quase toda ausência.
> Os `id` dos dois são distintos de propósito: dá para instalar os dois lado a lado e comparar os
> runtimes com as mãos.
>
> Ao copiar um template para um app seu, apague `frontend/galeria.js`, as peças de
> `frontend/index.html` e as rotas `api/*` que não forem suas — o que sobra é o mínimo.

**A paridade é medida, não prometida:** `tests/galeria-paridade.test.js` reprova qualquer deriva
entre os dois, e `tests/galeria-cobertura.test.js` exige que cada membro do `vssh` apareça em
alguma peça das duas galerias. Isso existe porque o contrário já aconteceu: o template Python ficou
congelado duas majors lendo `VSSH_APP_PORT`, uma variável que a v4 aposentou, e **morria com
`KeyError` antes de escutar** — ninguém percebeu porque nada media a distância entre os dois.

> **Esta tabela dizia outra coisa, e vale saber o quê.** O Python era "o mínimo absoluto, para ler
> em 2 minutos" e o Node era "qualquer coisa que vá crescer" — uma divisão por TAMANHO que fazia
> sentido enquanto todas as libs eram JavaScript. Ela custou o congelamento acima: escolher o
> Python significava abrir mão de log, de SSE, de token e da ponte, e um template que ninguém usa
> para valer é um template que ninguém atualiza.

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
um backend Node com dependências npm reais, instaladas no servidor-alvo pelo `installCommand`
(`npm ci --omit=dev`) — o caminho que a v4 generalizou para as libs do toolkit —, sem `frontend/`
nem janela, consumido por uma feature já existente do cliente
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

**⚠ E este gatilho estava incompleto — ele é acidental.** Os dois sinais acima são *a ferramenta
recusou o iframe*. Se ela **deixa** ser posta num iframe, a doutrina nunca dispara, e o port termina
em servidor + iframe sem ninguém ter decidido isso. O gatilho que faltava é o de propósito:

- **A UI original vai ficar por cima da do ambiente?** Barra de título dela dentro da janela do
  shell, seletor de arquivo dela em vez do do desktop, menu de contexto dela por cima do nosso,
  notificação dela em vez do centro de notificações — cada um desses é uma camada duplicada que o
  usuário vê. Quando a lista passa de um ou dois, **quem serve a página tem de ser você**, e a
  pergunta deixa de ser "a ferramenta aceita iframe?" e passa a ser "ela expõe um jeito de o
  hospedeiro servir a própria página?". Muitas expõem — o VS Code chama isso de *embedder*, e é o
  que o github.dev usa.

O caso trabalhado é a [Onda 9](../../../docs/roadmap/08-editor-do-ambiente.md): o code-server aceita
iframe sem reclamar, e por isso passou anos como servidor + iframe; o que decidiu a extração foi a
segunda pergunta, não a primeira.

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
  ambos pra montar as entradas do menu) filtra `type !== 'engine'` antes de listar.
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
o primeiro uso real — ver `vssh-client/index.html` (chama antes de registrar o service
worker) e `vssh-client/sw.js` (faz o `importScripts` incondicional, síncrono, no topo do
arquivo, sob `try/catch` — nunca dentro de um listener).

Importante: o proxy do portal **recusa** (409, ver `checkAppStatus` em `src/proxy.ts`) qualquer
requisição pro app enquanto o processo não estiver de fato confirmado rodando — não é só "a porta
ainda não foi alocada", é uma checagem ativa. Por isso o `ensureRunning` eager precisa ser
**esperado de verdade** antes de registrar o service worker (não uma corrida contra um teto
curto/arbitrário) — `POST /api/apps/:id/start` já tem seu próprio teto interno de ~15s no
healthcheck; um timeout externo só faz sentido como rede de segurança contra travamento de rede
(bem mais generoso que esses ~15s), não como caminho normal. Isso só adiciona espera de fato em
servidores que realmente têm um app `alwaysRunning` instalado — sem nenhum, a checagem resolve
quase instantâneo. Ver `vssh-client/index.html` pro exato ponto onde isso é esperado antes
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
(ver `vssh-client/js/FileBrowserWindow.js`); `vsshapp-recoll/static/js/utils.js`
(`openInViewer`/`openFolder`) é a implementação de referência do lado do app.

## App padrão por categoria (opt-in, via `"handles"` no manifest)

Um vssh-app pode se registrar como substituto de um dos 5 launchers embutidos do desktop:
`terminal`, `editor`, `fileBrowser`, `ide`, `browser` — basta declarar `"handles": "terminal"`
(ou o valor correspondente) no manifest. Isso NÃO troca o comportamento sozinho: o usuário escolhe
explicitamente em **Configurações → Ambiente → Abrir com** qual app usar
pra cada categoria (⚠ **este caminho dizia "Aplicativos → Apps Integrados por Categoria", e essa
tela não existe com esse nome**; persistido em `categoryHandlers`, ver `src/routes/settings.ts`); sem essa
escolha, o app embutido continua sendo o padrão mesmo que seu manifest declare `handles`.

Mecanismo (nenhum código seu além do campo no manifest): cada `*Launcher.js` nativo
(`TerminalLauncher.js`, `TextEditorLauncher.js`, `FileBrowserLauncher.js`, `VsCodeLauncher.js`,
`BrowserLauncher.js`) pergunta `AppLauncher.appDaCategoria('<categoria>')` antes de abrir a janela
embutida — se apontar pro seu app, chama `AppLauncher.open(appId)` no lugar. (Os cinco liam
`window.vsshSettings.categoryHandlers.<categoria>` cada um por si: cinco cópias da mesma pergunta, e
nenhum lugar onde respondê-la de novo — que é onde o apelido `vscode`→`ide` mora hoje.)

⚠ **A categoria `vscode` chamou-se assim e não se chama mais.** Das cinco, era a única que nomeava
um produto em vez de um papel — quem ocupa esse lugar responde por *o ambiente de desenvolvimento*,
não por *o VS Code*. Declare `ide`; `vscode` continua aceito na entrada (um manifesto já publicado
não deixa de instalar por causa de uma palavra que trocamos) e é traduzido antes de chegar ao
cliente.

### Contexto de abertura (opt-in, via `open-context`)

Ações como "Abrir Terminal Aqui" carregam contexto extra (uma pasta, um arquivo) que a janela
embutida usaria — isso só chega ao seu app se ele optar por entender. `AppLauncher.open(appId,
serverId, restoreState, openContext)` aceita um 4º parâmetro (ex.: `{ path: '/home/user/foo' }`,
mandado por `TerminalLauncher.js` hoje) que `VsshAppWindow` repassa via `postMessage` assim
que o iframe carrega (ou imediatamente, se a janela já estava aberta):

```js
// Do chrome (pai) pro app (iframe):
{ vsshApp: true, type: 'open-context', path?, tipo?, rota? }
```

`tipo` é `'arquivo'` ou `'pasta'` e acompanha o `path` quando o ambiente sabe qual dos dois é —
"abrir" significa coisas diferentes nos dois casos, e quem montou o menu sabe em que superfície o
clique caiu.

`rota` é um lugar DENTRO do seu app, e chega quando alguém clica num item da **jump list** (seção
abaixo) com a janela **já aberta**: nesse caminho não há URL nova para montar, então quem navega é
o app. É acréscimo compatível — quem não conhece o campo continua lendo só `path`, como sempre.

Cabe ao seu app decidir o que fazer com isso — não há um formato universal além de `path`, já que
o significado depende inteiramente do que seu app faz. terminal-latch (`terminal-latch/
frontend/index.html`) trata `path` mandando `cd <path>` como input assim que a sessão conecta (não
dá pra fazer isso invisível como o terminal dtach embutido faz, já que o motor já inicia a sessão
só com o nome, sem espaço pra injetar um cwd antes do shell interativo começar — trade-off aceito:
o usuário vê o `cd` sendo "digitado"). Apps que não tratam `open-context` simplesmente ignoram a
mensagem — nenhum erro.

Com o shim, isso é `vssh.onOpenContext(({ path, tipo, rota }) => { ... })`.

### A jump list do ícone (opt-in, via `contributes.contextMenu`)

O botão direito no ícone do seu app — no Launchpad e no Menu Iniciar — mostra as tarefas que ELE
declarou, como o botão direito num ícone da barra do Windows. É a superfície `icone-do-app`, e o
verbo dela é `abrirRota`:

```jsonc
"contributes": {
  "contextMenu": [
    { "id": "novo",     "superficie": "icone-do-app", "rotulo": "Novo arquivo",
      "rota": "novo",             "ordem": 12 },
    { "id": "recentes", "superficie": "icone-do-app", "rotulo": "Abrir recente",
      "rota": "docs?filtro=recentes" }
  ]
}
```

Três coisas que se aprende errado na primeira vez:

- **A `rota` não é URL.** É o pedaço que vem depois do endereço que o portal já resolveu para o seu
  app. Esquema (`https:`, `javascript:`), caminho absoluto e `..` são recusados pelo ambiente — a
  janela leva o título e o ícone do seu app, e servir outra coisa ali seria uma tela falsa com a sua
  cara.
- **Com o app fechado, a rota entra na URL; com ele aberto, chega pelo `open-context`.** Quem sabe
  se ir a `/novo` é trocar de tela, abrir um painel ou criar um documento é o app — o ambiente não
  navega por você. Sem tratar `open-context`, o item funciona só na primeira abertura.
- **A lista é ESTÁTICA, e isso é decisão.** "Abrir recente" abre a sua tela de recentes; o ambiente
  não pergunta ao seu backend quais são os arquivos recentes. O menu abre num clique direito, é
  síncrono, e o seu app pode estar desligado — subir um backend para desenhar um menu não é opção.

A `ordem` é a mesma régua do menu de arquivo (os fixos deste menu são "Abrir" em 10, "Copiar
Comando" em 200 e "Criar atalho" em 210), então um item sem `ordem` cai logo abaixo de "Abrir",
que é onde uma tarefa do app pertence.

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
