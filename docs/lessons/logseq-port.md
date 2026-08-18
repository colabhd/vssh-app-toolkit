# Notas de plataforma: o que portar o Logseq ensinou

Escrito a partir de um port real levado até rodar num servidor. **É um artefato de investigação, e
ser histórico é o que ele é**: as armadilhas que ele cataloga continuam valendo, mas as propostas
dele não estão pendentes.

> **Estado das duas propostas da seção 1: as duas foram promovidas.** `vssh-app-fs` e `static-spa`
> são hoje `lib/node/vssh-app-fs/` e `lib/node/static-spa.js`, com par em `lib/python/`, e a
> referência viva delas é o [README](../../README.md#bibliotecas-lib). O que segue é o argumento
> que as promoveu, não um pedido.

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

| | modo web (já implementado) | modo Electron (a implementar) |
|---|---|---|
| Busca full-text | dentro do navegador | `search-blocks`, `rebuild-indice`, `transact-blocks`, `truncate-indice` → índice FTS server-side |
| Persistência do DB | IndexedDB | `saveGraph`, `getSerializedGraph`, `readGraphTxIdInfo`, `deleteGraph` |
| URL de asset | relativa, o navegador resolve | protocolo `assets://`, que não existe fora do Electron |

> **⚠ A coluna dizia "modo web (de graça)", e isso estava errado.** IndexedDB não sai de graça: pelo
> critério 2 ([`../decisoes/criterios-de-projeto.md`](../decisoes/criterios-de-projeto.md#2--isso-sobrevive-à-troca-de-máquina))
> ele é **dívida** — o grafo do usuário fica preso àquela máquina e àquele navegador. O que o modo
> web dá de graça é **não ter de implementar** os quatro handlers agora; a durabilidade continua em
> aberto e é dela que o port se lembra depois. A frase certa é "já implementado", não "de graça".

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

**Healthcheck e token — e esta lição estava errada.** Estava escrito aqui que *"o `healthcheckPath`
é pollado direto na porta, sem passar pelo proxy, então não carrega `X-Vssh-App-Token`; um app que
exija o token em todas as rotas precisa isentar essa uma"*. **Isso está errado**: a sondagem vai
**com** o header. Gatear a rota de healthcheck é permitido, e isentá-la deixou de ter motivo.

Vale registrar por que a versão antiga era pior do que "desatualizada": com a sondagem sem header,
um app com gate respondia `403`, `403` não é 5xx, e isso **contava como pronto** — o portal declarava
servindo um app do qual nunca tinha visto resposta. Hoje `401`/`403` não contam. O teto de ~15s
continua valendo, e continua sendo o motivo de o healthcheck ter de responder sem depender de setup
pesado.

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

> **Feito desde então.** `vssh.fs.watch(path, cb)` existe (ver [api.md](../api.md)), com um canal
> multiplexado por usuário no portal e `inotifywait` com fallback escolhido no servidor remoto. A
> pergunta em aberto no fim desta seção — "o proxy bufferiza SSE?" — foi respondida construindo
> `lib/node/sse.js`, que carrega os headers que sobrevivem ao proxy e ao CDN.
>
> A seção fica como registro do raciocínio, que continua valendo. Uma ressalva que só apareceu
> depois: cada watch segura um canal SSH, e o orçamento é de ~8 **por servidor** — por isso
> `cancelar` não é opcional, e por isso o desenho vai mudar para um vigia por servidor. Ver
> [`../api.md`](../api.md).

Estava fora do escopo deste app na v1, e a divisão sugerida era:

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

> **Post-scriptum — a regra acima estava larga demais.** Ao construir um instrumento que
> roda o polyfill num Chrome de verdade (`tests/browser/`), a frase *"preguiça e compatibilidade
> estrutural não coexistem numa subclasse de `Blob`"* não sobreviveu à medição. A fronteira real é
> **o relógio, não a herança**: onde cabe um `await`, cabe conserto. `Response`, `Request`, `fetch`
> e `FileReader` aceitam trabalho assíncrono e hoje funcionam; `new Blob([f])` e `FormData.append`
> leem os bytes de forma síncrona e continuam sem saída. `slice()`, que lançava, virou leitura por
> `Range` HTTP.
>
> Vale registrar por que isso demorou: a generalização foi feita **sem instrumento capaz de
> refutá-la**. Os testes rodavam num `vm` do Node — e o Node discorda do navegador exatamente aqui
> (o `undici` monta o corpo de `new Response(f)` chamando o `.stream()` público, o navegador usa o
> *get stream* interno). Uma regra escrita a partir de um instrumento cego herda a cegueira dele.

Corolário mais amplo: **ao subclassificar um tipo da plataforma, pergunte o que a plataforma lê —
não o que ela chama.** Estado interno não é interceptável por getter, e o teste que revela isso não
é o que exercita a sua API: é o que entrega o objeto para outra parte da plataforma.

**Permissão que não sobrevive a quem a consome é um handle morto.** O polyfill guarda o handle do
diretório no IndexedDB do app — foi um dos primeiros defeitos consertados, justamente para o app
reabrir o mesmo grafo depois de um reload. Mas o *grant* vivia na instância da janela e morria com
ela. Resultado: o app restaurava o handle, chamava `values()` na raiz e era negado na primeira
operação. Tudo funcionando, nada funcionando.

A assimetria é o defeito, e ela não tem nada de específico do consumidor: vale para qualquer app
que a `showDirectoryPicker` sirva. **Se você deu a um objeto a capacidade de atravessar a sessão,
tudo de que ele depende precisa atravessar junto** — persistir metade é pior que não persistir
nada, porque a falha aparece longe da causa e parece um bug do app.

O que a correção decidiu, e que vale registrar: o grant persiste em `localStorage`, **não** no
backend do usuário, e isso é escolha e não atalho. O handle vive no IndexedDB — por perfil de
navegador e por origem. Espelhar o grant no servidor lhe daria alcance *maior* que o do handle: em
outro navegador o usuário teria a permissão viva e nenhum app do outro lado para consumi-la.
**Permissão não deve sobreviver a quem a consome.** E porque agora ela sobrevive à sessão, precisou
de um lugar onde o usuário a veja e a tire — permissão invisível e permanente é a pior combinação.

**`queryPermission()` respondia `granted` incondicionalmente**, e isso era uma mentira com
consequência. Quem decide é o shell; o polyfill respondia por ele. O app checava, ouvia "pode", e
era negado logo depois. Hoje a pergunta vai a quem decide, e `requestPermission()` reabre o seletor
— que é o que a API real faz, e era o caminho de volta que não existia. Corolário: **uma camada de
compatibilidade que responde no lugar da autoridade não está simplificando, está mentindo.** Se a
resposta é sempre `sim`, a função não precisava existir.

**Um `stat` é uma pergunta, e "não existe" é uma resposta.** O `getDirectoryHandle(name, {create:
true})` sonda com `stat` e cria no 404 — o caminho normal. O shell logava cada sonda como erro,
com stack trace, e abrir um grafo novo produzia sete delas antes de qualquer coisa dar errado de
verdade. É a mesma lição que o backend deste app já tinha aprendido (§7: sondagens ENOENT ganharam
`expected: true`), reaprendida do outro lado da ponte. **Logar sondagem e falha do mesmo jeito não
deixa o log mais completo — faz o erro de verdade desaparecer no meio.**

**"Não" e "não sei" pedem ações opostas — colapsar as duas escolhe a errada.** O `isGranted` do
shim devolvia `false` para três coisas diferentes: o shell disse não, o shell respondeu erro, e o
shell não respondeu nada (por ser mais antigo que o app e não conhecer a mensagem). Uma manda
desistir; a outra manda seguir. E o colapso escolhe a ação errada **exatamente quando o canal está
com problema**, que é quando importa.

O sintoma não apontava para a causa: o app entrava no caminho de reconceder permissão e o grafo não
carregava, **enquanto as operações de arquivo funcionavam normalmente** — porque `fs` o shell
implementa e `grants` não. Custou três versões do app.

A regra geral: **shell e apps são deployados à parte, então versão dessincronizada é a regra, não a
exceção.** Toda pergunta que atravessa essa fronteira precisa de uma resposta para "não obtive
resposta", distinta de "a resposta é não". E a resposta certa a ela, aqui, foi a mesma que já valia
para o caso simétrico: um shell sem `grants` é o mesmo caso que um shim sem `isGranted` — em nenhum
dos dois há a quem perguntar, e os dois respondem `'granted'`. Antes, um dava `'granted'` e o outro
`'prompt'`, e nada no código dizia por quê.

**Um comentário que descreve o que o código deveria fazer é pior que nenhum.** Acima da função
`call()` estava escrito "toda chamada que espera resposta tem timeout" — e o parâmetro tinha
`timeout = 0`, que não criava timer nenhum. Quem leu o comentário parou de procurar ali. A promise
de um `pick` contra um shell mudo não resolvia, não rejeitava e não deixava rastro no console: o
pior modo de falha que existe, porque não dá o que procurar.

**Cobrir o caminho que o primeiro consumidor usa não é cobertura, é sorte.** A reidratação de
handle envelopava `IDBObjectStore.get` e `getAll`. O Logseq lê da raiz com `get`, então funcionava
— mas `IDBIndex`, cursores e handle aninhado dentro de um objeto voltavam crus, sem métodos, e o
app concluiria que a pasta está vazia. Exatamente o modo de falha que o envelope existe para
evitar, num caminho que ninguém tinha visitado. O corolário para camada de compatibilidade:
**enquanto o mecanismo tem furo, a documentação precisa dizer onde** — "não suportado" e "não
testado" são coisas diferentes, e o silêncio faz as duas parecerem iguais.

**Estado interno é do realm em que nasceu.** Ao descer em objetos para achar handle aninhado, a
primeira versão testava `Object.getPrototypeOf(v) === Object.prototype`. Objeto vindo de outro
documento — iframe, worker — tem OUTRO `Object.prototype`, e era descartado como se não fosse um
objeto simples. `Object.prototype.toString.call(v)` responde a mesma pergunta sem essa
sensibilidade. Vale a mesma regra do `Blob` preguiçoso: ao mexer com tipos da plataforma, pergunte
de onde o valor veio, não só o que ele parece.

**`$!` de um pipeline em background é o ÚLTIMO comando, não um líder.** No watcher remoto,
`inotifywait | emit &` deixava `$!` apontando para o `emit`; o `inotifywait` era **irmão** dele, não
filho. Matar por pid ou por `pkill -P` derrubava metade, e o vigia continuava emitindo depois do
`unwatch` — em silêncio, porque nada falhava. A saída é `set -m`, que põe cada job em seu próprio
grupo de processos, e `kill -- -PGID`. Só apareceu porque o script foi **executado** num teste, não
só lido: `bash -n` passava nas duas versões.
