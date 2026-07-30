# Notas de plataforma: o que portar o Logseq ensinou

Escrito para o `vssh-app-toolkit`, a partir de um port real levado até rodar num servidor. Duas
peças deste repo estão prontas para virar código compartilhado, uma decisão de plataforma foi
respondida com dado concreto, e o resto são armadilhas que custaram rodadas de depuração.

---

## 1. Duas peças prontas para promover

### `backend/vssh-app-fs/`

Filesystem do servidor exposto ao frontend por HTTP. Doze operações, confinamento à raiz, assets
binários com `Range`, checagem do `X-Vssh-App-Token`, classificação de errno. Contrato de wire e
modelo de segurança em `backend/vssh-app-fs/README.md`.

Não é específico de notas: um editor, um file browser e a ponte `open-file` do app do recoll querem
a mesma coisa. Escrita sem menção ao Logseq, sem variável de ambiente e sem dependência npm — o que
é específico do app (allowlist de extensão, ignore list, política de recycle) entra por config.
Critério para promover: um segundo app usá-la sem editar nada lá dentro.

### `backend/static-spa.js`

Servir uma SPA construída sob `/proxy/app/<id>/`: content-type, `Last-Modified` + 304, injeção de
script de boot gerado em runtime, confinamento de caminho e **prefixos alias** (seção 4). Todo port
de web app precisa disso, e todo mundo erra igual na primeira vez.

### Uma terceira, se o template do toolkit for revisto

**Log estruturado em `$VSSH_APP_DATA_DIR` desde a primeira linha de código.** Ver seção 7 — foi o
que mais rendeu nesta sessão, e é barato o suficiente para nascer com o template.

---

## 2. Uma camada de IPC compatível com Electron não vale o esforço

A pergunta era se o VSSH deveria oferecer um `window.apis`/`ipcRenderer` genérico ligado ao processo
backend do app, para facilitar o port de apps Electron.

**O transporte é a parte barata.** No Logseq, todo o IPC do renderer passa por uma função
(`src/main/electron/ipc.cljs`):

```clojure
(defn ipc [& args]
  (when (util/electron?)
    (p/let [result (js/window.apis.doAction (bean/->js args))]
      result)))
```

Reimplementar isso sobre HTTP são ~150 linhas. **O caro são os handlers do outro lado**: 98
`defmethod handle` em `src/electron/electron/handler.cljs` — filesystem, índice FTS em SQLite,
persistência do datascript, git, plugins, updater, proxy do sistema, controles de janela. Nada disso
é genérico: uma camada de IPC entrega o cano e zero dos handlers.

**E, neste caso, ligar o caminho Electron seria regressão.** `frontend.util/electron?` é detectado
por User-Agent, e ativá-lo troca três implementações que já funcionam no navegador por IPC a
implementar no servidor:

| | modo web (de graça) | modo Electron (a implementar) |
|---|---|---|
| Busca full-text | dentro do navegador | `search-blocks`, `rebuild-indice`, `transact-blocks`, `truncate-indice` → índice FTS server-side |
| Persistência do DB | IndexedDB | `saveGraph`, `getSerializedGraph`, `readGraphTxIdInfo`, `deleteGraph` |
| URL de asset | relativa, o navegador resolve | protocolo `assets://`, que não existe fora do Electron |

Isso vale para toda app dual-target (Electron + web), que é justamente a classe que faz sentido
virar um vssh-app. Para app Electron-*only*, o renderer normalmente usa `require('fs')` direto ou
um preload com API bespoke via `contextBridge` — coisas que compat de `ipcRenderer` não cobre — e aí
o escape hatch honesto é rodar o Electron real como janela X11 no Xpra.

**Quando reconsiderar:** 3+ apps Electron-only que precisem ser portados e para os quais
X11-no-Xpra seja inaceitável. Nesse caso, escopar no 20% barato — `ipcRenderer`/`contextBridge`,
`shell.openExternal` → `xdg-open`, `dialog.*` → `vssh-psdialog`, `clipboard`, notificação →
`notify-send` — e vender como ergonomia, não como viabilizador de port.

---

## 3. A camada de compat que valeria: polyfill da File System Access API

Se o VSSH for oferecer *uma* camada de compatibilidade, a aposta melhor é um polyfill de
`showDirectoryPicker()` que devolva um handle servido pelo backend do app.

Vantagens sobre o IPC do Electron:

- É API do W3C: shape estável, sem perseguir release de terceiro.
- Uma implementação atende uma classe inteira de apps que abrem pasta local — Logseq web, VS Code
  for Web, Excalidraw, tldraw, editores em geral — **sem fork do app**.
- Já existe backend para ela: `vssh-app-fs` é exatamente o que o polyfill chamaria.

A ressalva conhecida, e o motivo de este app não ter ido por esse caminho: o Logseq persiste os
handles no IndexedDB (`frontend.idb` + `idb-keyval`), e objeto com métodos não sobrevive a
structured clone. Cobrir isso exige serializar o handle para um registro simples e reidratar na
leitura — factível, mas é um truque a mais numa peça que ainda não existe, contra 4 patches pequenos
num fork que já sabemos onde costurar. Para apps que **não** persistem handle, o polyfill é limpo.

---

## 4. Armadilhas de port de web app

**Asset path absoluto e CDN de terceiro.** O `shadow-cljs.edn` do Logseq tem
`:release {:asset-path "https://asset.logseq.com/static/js"}`. Sem consertar, o release carrega JS de
um CDN externo — quebra em servidor sem internet, e é dependência de rede que ninguém pediu.

Uma lição de método aqui: a primeira tentativa passou o asset-path por `--config-merge` na CLI do
shadow-cljs, e não pegou — o build inteiro (3,5 min de compilação) só para descobrir no check final.
Trocado por patch direto no arquivo, que é explícito e verificável em segundos. **Para um valor que
precisa estar certo, patch no arquivo bate override na linha de comando.**

**Um bundle pode assumir dois prefixos ao mesmo tempo.** O `index.html` que o Logseq publica
referencia `./js/main.js`, mas `frontend.util/JS_ROOT` hardcoda `./static/js` para tudo que é
carregado em runtime (shepherd, katex). As duas coisas coexistem no upstream porque o dev-server
monta o mesmo diretório em duas raízes: `:dev-http {3001 ["static" "."]}`. Quem serve **uma** raiz em
produção quebra só nos caminhos dinâmicos — a página inicial carrega inteira, o app parece funcionar,
e o 404 só aparece quando alguém abre a feature que usa aquele script.

O sinal a procurar antes de portar: **mais de uma raiz montada no dev-server do projeto**. Se houver,
o servidor do app precisa reproduzir isso (`aliasPrefixes` em `static-spa.js`) ou o bundle precisa
ser reorganizado. Preferir o alias a um patch no fork: cobre qualquer referência ao prefixo, não só
a que você encontrou.

**Caminho relativo só funciona porque o roteamento é por fragmento.** O Logseq chama `rfe/start!`
com `{:use-fragment true}`, então o path do documento nunca muda. Um app com roteamento HTML5
precisaria de `<base>` calculado pela profundidade da requisição, ou de fallback de SPA no backend.

**Patch que aplica limpo não é patch que faz efeito.** Este repo teve um patch em
`public/index.html` que passava na verificação de aplicação e não mudava nada no artefato: o
`gulp build` publica `resources/**` em `static/`, então o `index.html` do bundle vem de outro
arquivo. Verificar que o patch aplica é barato e **não substitui verificar o resultado**.

Corolário: **conferir que os arquivos referenciados existem vale mais que conferir a forma das
URLs.** Este repo checava caminho absoluto e domínio de CDN, e mesmo assim publicou um bundle com
referência pendurada. Hoje o build resolve cada `src`/`href` do index e o prefixo do `JS_ROOT`
contra o diretório instalado.

**`.gitignore` versus o `git add -A` do `vssh-app-publish`.** O publish faz `cp -a` da fonte,
`git add -A` e um commit efêmero **na cópia** antes do `git archive`. Corta nos dois sentidos:

- Artefato construído em CI entra no tarball sem entrar no histórico — desde que **não** esteja no
  `.gitignore` no momento da publicação. Este repo mantém o bundle ignorado para segurança local e o
  CI remove a linha antes de publicar.
- Qualquer coisa não-ignorada que esteja na árvore vai junto. O sparse checkout do toolkit
  (`_tools/`) precisa estar no `.gitignore`, e o clone do upstream precisa ficar fora do repo —
  senão o `cp -a` copia gigabytes a cada publicação.

**Healthcheck e token.** O `healthcheckPath` é pollado pelo lifecycle direto na porta, sem passar
pelo proxy, então não carrega `X-Vssh-App-Token`. Um app que exija o token em todas as rotas precisa
isentar essa uma, ou o healthcheck nunca passa e o clique de "abrir app" fica pendurado até o teto
de ~15s.

---

## 5. Contrato de erro: 500 tem que significar "não sei"

O mapa de erro deste app começou com três entradas (`ENOENT`, `EACCES`, `EINVAL`) e tudo o mais
caindo em 500. Resultado: um `EISDIR` — gravar por cima de um diretório, ou seja, **pedido inválido
do cliente** — apareceu como defeito do servidor e mandou investigar o lado errado.

A regra que ficou: a lista do que o servidor **sabe** classificar tem que ser honesta, senão o 500
perde o significado. Hoje: errno de caminho e permissão → 4xx; `ENOSPC`/`EIO`/bug → 500; e `stack`
só é logado no que cai em 500, porque nos classificados a pilha é sempre a mesma.

**Sondagem como fluxo de controle merece resposta, não erro.** `stat` num caminho ausente responde
com erro, e está certo — é a resposta certa para "me dê os metadados". Mas quem só quer saber se o
arquivo existe usa esse erro como fluxo de controle, e aí toda sondagem de rotina vira ruído nos dois
lados: linha vermelha no console e linha de falha no log. O Logseq sonda em pelo menos quatro
lugares (journal do dia, `graphs-txid.edn`, `persist-var`, antes de cada gravação). A resposta foi
uma op `exists` que devolve `200 {"exists": bool}`, e `expected: true` no log para o ENOENT que
sobra.

---

## 6. Não encadeie trabalho do app na cadeia de boot da aplicação hospedeira

O bug mais caro da sessão, em tempo de diagnóstico, foi este — e é totalmente generalizável.

O patch de abertura automática do grafo pendurou uma chamada dentro do `p/let` de boot do Logseq:

```clojure
_ (restore-and-setup! repos)
_ (vssh-handler/maybe-open-server-graph! repos)   ;; <- dentro da cadeia
```

Só que `(state/set-db-restoring! false)` mora no `p/finally` dessa cadeia, e
`components/theme.cljs` mantém o título da janela em `(t :loading)` enquanto `db-restoring?` for
true. Resultado: a janela ficava presa em "Carregando..." para sempre. Passei duas rodadas
atribuindo isso ao portal antes de o comportamento descrito pelo usuário ("abre Logseq, depois vira
Carregando") localizar a origem.

**A regra: ao patchar a inicialização de uma aplicação hospedeira, pendure o seu trabalho depois
que a cadeia liquidar, não dentro dela** — e com `p/catch` próprio, senão a sua falha vira mensagem
de erro sobre o trabalho *dela*. Encadear dentro acopla o seu código a um estado que a UI da
hospedeira observa, e o sintoma aparece num lugar que não tem relação nenhuma com o que você mexeu.

---

## 7. Diagnóstico: o log do app vale mais que a pilha do console

O achado mais reutilizável da sessão.

Fiz **duas** atribuições erradas lendo frames minificados do bundle de release:

1. Os 404 de sondagem seriam do `mkdir-if-not-exists` — eram de `file-exists?` e de um `stat` cru
   do `persist-var`.
2. O título travado seria do portal — era do meu próprio patch.

As duas foram resolvidas em **uma linha** pelo log do backend, que nomeia op e caminho:

```json
{"event":"op-failed","op":"stat","path":".../logseq/graphs-txid.edn","code":"ENOENT"}
```

Frame minificado (`bi ← Vhb ← vjb ← fH`) suporta hipótese, não conclusão. Recomendação para o
template do toolkit: **todo app nasce com log estruturado em `$VSSH_APP_DATA_DIR`**, com uma linha
por falha contendo operação, caminho e código. Custa vinte linhas e paga na primeira depuração
remota — ainda mais porque o lifecycle do portal descarta stdout/stderr do backend, então sem log
próprio não há nada.

---

## 8. CI: os três estados do diretório de build

O script de build ramificava por `-d .git` para decidir entre reaproveitar clone e clonar. O
`actions/cache` restaura `node_modules` **sem** o `.git`, então esse terceiro estado caía no
`git clone`, que recusa diretório não-vazio. Como o cache só existe a partir do segundo run, **o
primeiro build passou e escondeu o problema** — e o run de publicação teria falhado igual.

Um script de build em CI com cache precisa tratar três estados: diretório vazio, clone completo
anterior, e só-artefato-do-cache sem `.git`. `git init` + fetch + checkout cobre os três num caminho
só. E vale exercitar a **segunda** execução, não só a primeira: estado de cache é exatamente o que
um único run verde não cobre.

Falha do serviço de cache do GitHub é aviso, não erro — o build fica frio e segue. Isso só é
verdade se o script tratar o diretório vazio, o que fecha o círculo com o parágrafo acima.

---

## 9. O watcher de mudanças externas: o que é do toolkit

Está fora do escopo deste app na v1, e quando for feito a divisão sugerida é:

| camada | onde | por quê |
|---|---|---|
| Transporte de eventos servidor→frontend (SSE ou WS sob o proxy) | **toolkit** | Todo app que empurra evento tem o mesmo problema, e "o proxy bufferiza SSE?" é pergunta sobre a plataforma |
| Observar o filesystem (`fs.watch`, debounce, filtro, coalescer) | **toolkit**, no `vssh-app-fs` | Contraparte natural das ops que já estão lá |
| Alimentar o handler de watcher da aplicação | **app** | Adaptador fino. No Logseq é especialmente barato: `frontend.fs.watcher-handler` já existe, feito para consumir eventos `file-watcher` do Electron |

**Pergunta em aberto que decide o desenho:** a SKILL garante que o proxy encaminha WebSocket, mas não
diz nada sobre bufferização de SSE — e SSE é o encaixe natural (direção única, sem handshake).
Medir isso antes de escolher.

O watcher também é o **gatilho** para uma segunda decisão que este app deixou em aberto: hoje a
gravação faz `stat` → `read-file` → compara → `write-file`, três idas e voltas com uma janela em que
uma edição externa é sobrescrita. Sem watcher, edição externa já exige Refresh manual e a janela é
teórica. Com watcher, ela deixa de ser — e aí uma escrita condicional (`ifMatches` resolvido no
servidor, uma requisição em vez de três) passa a valer o risco.

---

## 10. Depois da promoção: o que medir contra um consumidor real revelou

As seções acima foram escritas durante o port. Estas duas vieram **depois**, ao medir as peças
promovidas contra o app que as originou — e são o tipo de defeito que nenhuma revisão de código
pega, porque só aparece no perfil de uso real.

**Um default é uma decisão tomada em nome de quem ainda não chegou.** A lib de FS documentava que
allowlist de extensão e ignore list são decisão do app, e ao mesmo tempo trazia os valores do
Logseq como default. Um segundo app herdaria `logseq/bak` sem pedir. A regra: se você escreveu na
documentação que a escolha é do chamador, o valor não pode estar no default. Hoje esses valores
vivem em `presets/logseq.js`, e o default da lib é neutro.

**Uma API pode estar correta e ainda assim inutilizável, por causa do padrão de chamada.** O
`getFile()` do polyfill da FSA buscava o conteúdo do arquivo — que é o que o nome sugere. Só que o
consumidor chama `getFile()` para **todo** arquivo do diretório, recursivamente, e só depois filtra
por extensão. Num grafo de 300 arquivos isso vira ~600 requisições e o download de todos os anexos,
a cada abertura, para descartar quase tudo em seguida. A correção não foi na semântica, foi no
**momento**: `getFile()` devolve um `File` preguiçoso, com `size`/`mtime` vindos da listagem (que
já os traz), e o corpo só é buscado em `.text()`/`.arrayBuffer()`.

Corolário para qualquer camada de compatibilidade: **implementar a superfície certa não basta —
é preciso perfilar o padrão de chamada do consumidor.** Uma operação barata chamada N vezes num
laço é uma operação cara.

**E um caso onde falhar em silêncio era o pior desfecho:** a escrita do polyfill fazia
`blob.text()` antes de gravar. Para markdown funciona; para um PNG colado no editor, corrompe — e
o erro só aparece quando alguém abre a imagem, longe da causa. Hoje texto e bytes têm rotas
distintas, e há teste para as duas.

**Um objeto que finge ser um `Blob` só é um `Blob` para quem chama os métodos que ele
sobrescreveu.** Este foi o mais caro de achar, porque o sintoma não aponta para nada: imagem do
grafo simplesmente não aparecia. A causa é estrutural — `class LazyFile extends Blob` com
`super([])` cria a sequência de bytes interna **vazia**, e nenhum getter alcança esse estado. Os
métodos sobrescritos entregam o conteúdo; a plataforma não chama método nenhum:

```
await f.text() / f.arrayBuffer()   → funcionam (métodos sobrescritos)
URL.createObjectURL(f)             → blob: vazio
new Response(f) / new Blob([f])    → 0 bytes
FileReader.*, FormData.append      → 0 bytes
```

Não é questão de sobrescrever mais métodos: **preguiça e compatibilidade estrutural não coexistem
numa subclasse de `Blob`.** A saída foi interceptar `URL.createObjectURL` — que é o caminho por
onde praticamente todo app web transforma um handle em `<img src>` — e devolver uma URL HTTP do
portal em vez de um `blob:`. Três restrições ditaram o desenho: tem de ser síncrona (a assinatura
é), a URL tem de sair só do caminho (sem round-trip), e ela tem de carregar autorização sozinha,
porque um `<img src>` não passa por `fetch` e não aceita header. O que resolve as três é a mesma
origem: o app é servido pelo portal, então o cookie de sessão acompanha.

Os outros consumidores estruturais continuam sem conserto, e isso está documentado no cabeçalho do
polyfill em vez de escondido. **Falhar em silêncio era o pior desfecho**; hoje o caminho que
importa funciona e o resto é dito em voz alta.

Corolário mais amplo: **ao subclassificar um tipo da plataforma, pergunte o que a plataforma lê —
não o que ela chama.** Estado interno não é interceptável por getter, e o teste que revela isso não
é o que exercita a sua API: é o que entrega o objeto para outra parte da plataforma.
