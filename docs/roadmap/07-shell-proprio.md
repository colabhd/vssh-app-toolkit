# Onda 8 — O shell deixa de ser um fork do cliente Xpra

> **Estado:** ✅ **concluída — os cinco itens fecharam.** O jQuery saiu do shell (824 KB a menos
> em toda sessão; o JS caiu de 2,25 para 1,44 MB), o `FileBrowserWindow` foi de 3.562 para 2.827
> linhas em seis módulos, a área de trabalho ganhou 11 dos 13 verbos que lhe faltavam,
> "Computador" virou **Acesso Rápido**, a montagem do servidor pode ser **escondida**, e o
> ambiente passou a **se medir**. · **Atualizado:** 2026-08-10
>
> **1.256 testes, 0 falhas.** SEIS guardas novas, com refutação: 10/10 (o hambúrguer), 15/15 (as
> variantes que não existem), 8/8 (a medida congelada), 28/28 (a montagem escondida), 41/41 (o
> Acesso Rápido, depois do redesenho e dos quatro relatos) e 31/31 (o gerenciador de tarefas).
>
> **Repos:** `vssh-sso` + `vsshapp-xpra`
> **Depende da [2.7](02b-motores.md)**, que já fechou — sem o motor ter saído do `vssh-client/`,
> o item 1 não teria como existir. **Independente da [Onda 7](06-portabilidade.md)**, cujo item 2
> continua parado numa decisão de produto e não bloqueia nada aqui.
>
> ### O que esta onda ensinou, e é uma coisa só
>
> **Nove afirmações escritas nesta base — seis delas nesta roadmap — eram falsas, e nenhuma
> falhava.** Uma frase escrita não é uma medida, e a distância entre as duas não aparece: o
> documento continua legível, o código continua compilando, a suíte continua verde.
>
> | A afirmação | O que a medida disse |
> |---|---|
> | "nenhum `UI_MODE` bifurcando código em lugar nenhum do shell" ([0c](0c-colapso-de-variantes.md)) | 3 ramos vivos, 2 observadores mortos, 1 regra de CSS |
> | "conserto de uma linha" (item 5) | não havia `pintar()` para chamar — faltava o RECORTE |
> | "a chave nova guarda caminhos" (item 4) | esconderia a mesma pasta em TODO servidor |
> | "`//acesso-rapido` herda a guarda de graça" (item 3) | não herdava; virava `/acesso-rapido` no host |
> | "os recentes" na tela (item 3) | não existe fonte de dado nenhuma |
> | "a tela mostra o que é seu, com espaço ao lado" (item 3) | metade dela era a barra lateral repetida, e a raiz tinha sumido |
> | "o espaço livre" (item 3) | só existia `df /`, da máquina inteira |
> | "o `[data-theme]` fica de propósito" (`design-tokens.css`) | o próprio comentário se desmentia na frase seguinte |
> | "a recusa ficou depois da captura do ponteiro" (guarda do item 3) | media a ordem no texto; o ataque desistia **depois** de apagar a seleção |
>
> E três foram MINHAS, escritas dias ou horas antes: o "zero call sites de jQuery" do item 1c, o
> `.show()` traduzido como "apagar o inline" que deixou o hambúrguer três dias sem abrir, e a
> última linha da tabela — **a guarda que eu escrevi contra o defeito, e que o deixou passar**.

Cinco itens, e um assunto só: **o shell foi construído por cima do Xpra HTML5 Client, e ainda
carrega a fundação de outra casa.** A [Onda 2.7](02b-motores.md) tirou o *protocolo* do Xpra de
dentro do `vssh-client/` — 23 arquivos foram para um pacote de motor instalável. O que ficou para
trás foi a **infraestrutura**: a biblioteca sobre a qual aquele cliente foi escrito, o arquivo de
3.562 linhas que cresceu sem costura, e a raiz do gerenciador de arquivos que ainda é o `/` de um
Linux em vez de uma tela nossa.

---

## A medida, antes de qualquer item

A frase que abriu esta onda foi *"ele é altamente baseado em jQuery"*. **Metade dela é falsa, e a
metade falsa é a que mudaria o plano.** O shell quase não usa jQuery — quem usa é o motor, no
outro repositório.

| | shell (`vssh-client/`) | motor (`vsshapp-xpra`) |
|---|---|---|
| Call sites de `jQuery(` / `$(` | **9** | **134** |
| Arquivos que os contêm | 4 | 3 (`Client.js`, `Window.js`, `Notifications.js`) |
| Usa `draggable`/`resizable` | sim, em 2 lugares | sim, em 16 |
| Usa `slick` (carrossel jQuery) | não | sim — o preview do Alt+Tab |
| **Carrega `jquery.js` + `jquery-ui.js`** | **sim — 824 KB** | **não** |

A última linha é a onda inteira. **O shell carrega a biblioteca; o motor a consome.** E
`frontend/motor/arquivos.js` do motor lista treze bibliotecas vendorizadas — `rencode`, `lz4`,
`brotli_decode`, `jsmpeg`, `aurora`, `StreamSaver`, `slick`… — e **não lista o jQuery nem o
jQuery UI**, porque sempre encontrou os do shell já carregados.

É o defeito de junção de novo, e desta vez atravessando repositórios: **duas informações que
existem e não se encontram.** O shell não sabe que carrega 824 KB para um consumidor que pode nem
estar instalado; o motor não sabe que a dependência que ele nunca declarou é de outra equipe. Cada
lado, sozinho, está certo.

### Os 824 KB, em proporção

```
jquery-ui.js                535,4 KB   19.061 linhas
jquery.js                   289,1 KB   10.716 linhas
jquery-transform-draggable    5,5 KB      229 linhas
                            ─────────
                            830,0 KB   →  de 2,5 MB de JS do shell = 33%
```

### Três achados que não estavam no pedido

**1. `jquery-transform-draggable.js` é código morto.** 229 linhas, 5,5 KB, baixadas e parseadas em
toda sessão desde sempre, **e nunca executadas**. Um plugin do jQuery UI só roda quando a *opção*
homônima é passada — a regra está em `jquery-ui.js:1981`:

```js
if ( instance.options[ set[ i ][ 0 ] ] ) {
```

O arquivo registra `$.ui.plugin.add("draggable", "transform", …)`. Ninguém, em nenhum dos dois
repositórios, passa `transform: true` para um `draggable()` ou `resizable()` — zero ocorrências. É
herança do upstream: lá o `#screen` do X11 ganha `transform: scale()` e as janelas arrastam dentro
dele; as nossas não estão lá dentro.

**2. A dependência real é UMA, e tem nome.** `draggable`/`resizable`, montados em
`VsshWindow.js:638` (`_setupDragResize`) e `VsshDialogs.js:164` (uma segunda cópia, para diálogos,
sem resize). Os outros sete call sites são `.show()`, `.hide()`, dois `.destroy()`, um
`.mousedown()` em `DesktopPropertiesWindow.js:91`, e um `$(function(){})` em `MenuCustom.js:235`
que é `DOMContentLoaded` escrito de 2008. Nenhum deles justifica 824 KB.

**3. O arraste escreve `left`/`top`, não `transform`.** Por frame de `mousemove`, `_mouseDrag`
(`jquery-ui.js:2261`) chama `_generatePosition` (`:2622`, 225 linhas, com seis leituras de layout
— `scrollTop()`, `scrollLeft()`, `offset()`), depois `_convertPositionTo("absolute")`, depois
monta `_uiHash()` e dispara `_trigger("drag")` pela máquina de eventos do jQuery até o nosso
`TilingManager.onDrag` — e só então escreve:

```js
this.helper[ 0 ].style.left = this.position.left + "px";   // jquery-ui.js:2282
this.helper[ 0 ].style.top  = this.position.top  + "px";   // :2283
```

`left`/`top` em `position:absolute` (`client.css:904-910`) é **layout**, não composição. E as
leituras de layout acontecem **antes** da escrita, no mesmo frame — o padrão que força
recálculo síncrono.

---

## 1. O jQuery sai do shell

> **É a maior e a mais impactante, e o que a medição mudou foi a ORDEM, não o alvo.** O motor
> declara e carrega o jQuery dele; só depois o shell apaga os três arquivos. Invertido, todo
> ambiente que tem o Xpra instalado quebra — e o motor é um pacote versionado à parte, instalado
> por servidor, que não atualiza em sincronia com o portal.

### 1a. ✅ O motor adota a própria dependência — `vsshapp-xpra` 0.3.0

`frontend/motor/arquivos.js` ganhou `js/lib/jquery.js` e `js/lib/jquery-ui.js` no topo da lista, e
o pacote passou a vendorizá-los. Ele já vendorizava treze bibliotecas; estas duas eram as únicas
que ele pegava emprestado.

**A dupla carga era o risco, e a resposta não foi medi-la — foi evitá-la.** O plano original dizia
"carregar duas vezes tem de ser inócuo, e isso se mede". Ao procurar o modo de falha, ele apareceu
antes da medição e é grosseiro demais para se arriscar: uma segunda instância de jQuery vira
`window.jQuery`, os widgets do jQuery UI se registram nela, e os elementos que o shell já
inicializou guardam o `data('ui-draggable')` na **primeira** — invisível para a segunda. Aí
`VsshWindow.toggleMaximized()` chama `draggable('disable')` **sem `try/catch`**
(`VsshWindow.js:331-332`) e maximizar uma janela qualquer passa a lançar
`cannot call methods on draggable prior to initialization`.

Então o carregador **pula o que o ambiente já provê** — a tabela `__XPRA_JA_TENHO`, no manifesto.
Enquanto o shell provê, o motor pula; no dia em que ele parar, o motor carrega. **Não existe
janela em que duas cópias coexistam, e os dois deploys ficam independentes** — que é o que um
pacote instalado por servidor precisa ser.

E o carregador confere o jQuery **depois** da carga, com erro nomeado: sem isso, um pacote antigo
num shell já sem jQuery falharia com `ReferenceError` no primeiro clique direito, que foi
exatamente como a dívida do global `client` apareceu — em produção, uma vez.

`conferir-pacote.mjs` ganhou duas perguntas, e a segunda **executa**: os predicados de "já tenho"
rodam num `vm` nos três estados possíveis do ambiente. Refutação **12/12**, mais uma prova
positiva. Dois defeitos do próprio instrumento caíram junto — o recorte do manifesto ia do
primeiro `[` ao último `]` do arquivo (o comentário que explicava a fragilidade a demonstrou), e a
guarda de "o carregador lê a tabela" passava verde porque um **comentário** citava o nome dela.

### 1b. ✅ O arraste virou nativo — `vssh-sso`

`js/janela/arrastar.js` substituiu as **duas** cópias de `_setupDragResize`
(`VsshWindow.js:638` e `VsshDialogs.js:164`) por uma. É a mesma lição de sempre: **um portão, não
dois**. O diálogo não é um caso especial — é o caso geral com `resize: false`.

Nove call sites de jQuery no shell viraram **zero**. O que ele preserva, porque cada um já custou
um defeito e está comentado no código:

- o `distance: 5` que impede arraste acidental em clique rápido (`VsshWindow.js:655`);
- o `cancel` que abre exceção para controles nativos — sem ele, `mousedown` num `<select>` cai na
  maquinaria de arraste, que dá `preventDefault()`, e o `<select>` não abre (`VsshWindow.js:416`);
- o `guard` de tela cheia que impede o canvas do Xpra de roubar o mouse durante o arraste;
- o `containment` fixado no `mousedown`, **antes** do início do arraste (`VsshWindow.js:677-683`);
- os ganchos do `TilingManager` — `onDragStart` / `onDrag` / `onDragStop` / `onResize` /
  `onResizeStop`, com o `ui` de resize mantendo as quatro chaves que ele lê.

**A decisão que não era óbvia: o `transform` é um DELTA, commitado em `left`/`top` ao soltar.** Sem
isso, todo mundo que lê `_div.style.left` passaria a ler a posição errada — `toggleMaximized`,
`WindowStateManager`, `_syncProxy`, `applyTile`. Durante o arraste ninguém lê (o `onDrag` usa as
coordenadas do ponteiro), então o delta pode viver no `transform` até o `stop`, e aí a fonte de
verdade volta a ser uma só.

**E a bancada virou a rede de regressão dele.** O sujeito **D** passou a ser o módulo de verdade,
servido de `vssh-client/js/janela/` — porque comparar o jQuery UI com a minha *reprodução* do
substituto não prova nada sobre o produto. Na primeira corrida ele não saiu do lugar em 150
quadros: o módulo escuta `pointer*` e o arraste sintético só disparava `mouse*`. Quem pegou foi a
conferência de deslocamento; **sem ela a bancada teria publicado "0 layouts, 0 ms" para o produto.**
Depois do conserto: **0,02 layouts por quadro contra 0,99** do jQuery UI.

Guarda: `tests/unit/arraste-nativo.test.js`, 8 casos, **refutação 13/13**.

### ✅ A previsão foi medida — e ela acertou o mecanismo e errou o tamanho

> A previsão, escrita aqui antes de medir, era: *"trocar `left`/`top` por `transform: translate3d()`,
> com uma escrita por `requestAnimationFrame`, elimina Layout e Paint do arraste e deixa só
> composição."*

Medido em `vssh-sso/docs/bancadas/arraste/` — três sujeitos com a **mesma** carga nos callbacks,
contadores do CDP, varrendo quantos `mousemove` chegam por quadro:

| `mousemove`/quadro | **A** jQuery UI (`left`/`top`) | **B** nativo `transform` | **C** nativo `transform` + rAF |
|---|---|---|---|
| 1 | **1,00 layout/quadro** | 0,00 | 0,00 |
| 3 | **3,00** | 0,00 | 0,00 |
| 8 | **8,00** | 0,00 | 0,00 |

**A previsão acertou o mecanismo.** `left`/`top` custa um layout por evento tratado; `transform`
custa zero, porque `_generatePosition` LÊ geometria depois de a escrita anterior ter sujado o
layout — e leitura não se adia — enquanto o nativo não lê nada e o navegador resolve tudo num
flush por quadro.

### ⚠ E aqui eu errei duas vezes, a segunda por causa da própria bancada

Ao ver os contadores escalarem com `mousemove`/quadro, escrevi que o custo é **"proporcional ao
mouse, não à tela"** — *O(eventos)* contra *O(quadros)* — e que por isso a lentidão seria sentida
por quem tem mouse rápido. **Está errado, e o erro foi de instrumento:** eu disparava 3 e 8 eventos
sintéticos por quadro, e **o Chrome coalesce `mousemove` ao ritmo do quadro**. Por mais rápido que
o periférico reporte, o handler recebe ~1 por quadro. Aquele cenário não existe.

Quem derrubou foi a bancada à mão, num computador de verdade, na primeira corrida — `ev/quadro`
deu **0,9**:

| corrida | ev/quadro | ms/evento | do orçamento |
|---|---|---|---|
| **A** — jQuery UI | 0,94 · 0,86 | **0,40 · 0,50** | **2,3% · 2,6%** |
| **B** — nativo | 0,96 · 0,93 | 0,10 | 0,6% |
| **C** — nativo + rAF | 0,84 · 0,93 | 0,10 | 0,5% · 0,6% |

> **Então vale a primeira conclusão, e ela é a que fica: o jQuery UI NÃO é o que faz a janela
> arrastar devagar.** Ele custa 4–5× mais por evento, e isso é real — mas 4–5× de 0,1 ms. Trocá-lo
> devolve **~0,3 ms por quadro**.
>
> **Corrigido depois:** eu dizia "2% do quadro", contra um orçamento de 16,7 ms. **A tela onde isso
> foi medido é de 120 Hz**, então o orçamento é 8,33 ms e a fração é o dobro — o arraste de hoje
> custa ~**4%** do quadro, e trocá-lo devolve ~4%. Continua pequeno, continua não sendo a causa da
> lentidão; mas o painel da bancada relatava metade do custo real, e agora deriva o período da
> própria tela em vez de assumir 60 Hz.

**E a composição foi investigada, com um resultado que também precisa de ressalva.** Doze janelas
com sombra e `backdrop-filter`, na máquina de verdade: **110–119 fps contra 120** — ou seja, ~nada.
A mesma prova na bancada headless derrubava os quadros pela metade, e a diferença é que o cliente
CDP sobe o Chrome com **`--disable-gpu`**: aquilo era composição por software.

> Fica registrado porque **é o tipo de máquina onde o VSSH roda** — thin client velho, VM sem
> aceleração, sessão por RDP. Sem GPU, o `backdrop-filter` é o que paga (a `box-shadow` não custa
> nada, medido). Com GPU, não é assunto. É item para a lista de "o que degrada onde não há placa",
> não para a causa da lentidão percebida numa máquina comum.

**O item 1b não morre — muda de justificativa, e desta vez a justificativa é medida.** Ele deixa de
ser "acelerar o arraste" e passa a ser: **uma implementação em vez de duas** (`VsshWindow` e
`VsshDialogs` têm cópias do mesmo `_setupDragResize`), **zero layout por quadro**, e — a que paga
sozinha — **é o que destrava apagar 824 KB**. Vender qualquer coisa disso como conserto de lentidão
seria repetir os 874 ms da 6b, que é o erro que esta seção já cometeu duas vezes.

**B ou C: fica C**, mas por um motivo mais modesto do que eu tinha escrito. Com `mousemove`
coalescido eles empatam (0,10 ms os dois). C ganha nos casos em que o navegador *não* coalesce —
`pointerrawupdate`, touch, e o `getCoalescedEvents()` de quem quiser precisão — e não perde em
nenhum. É a escolha segura, não a vitoriosa.

**As durações em milissegundos ficam de fora do texto.** Os contadores são exatos e lineares; as
durações não escalam de forma estável entre corridas, porque o headless não pinta e o relógio inclui
o screencast. A bancada as imprime com essa ressalva; a roadmap não as cita.

**E o que a bancada NÃO alcança continua em aberto**, com suspeitos nomeados: N janelas com sombra e
`backdrop-filter`, o `_syncProxy()`, o `_reassignZIndices()`, o `containmentFor()` a cada
`mousedown`, e o canvas do Xpra por baixo. Isso exige o shell com sessão — a terceira camada.

Sobre a memória, a conta continua sendo conta e não medida: 830 KB de fonte são parse e heap, mas
**quanto** exige `performance.memory` com e sem os três arquivos. Isso ainda não foi medido, e o
texto não vai afirmar número nenhum antes disso.

### 1c. ✅ Os três arquivos saíram — `vssh-sso`

`index.html` perdeu as três linhas e `js/lib/` ficou só com o `hmac.js`. **O JS do shell caiu de
2,25 para 1,44 MB — 36% —, e isso em toda sessão**, inclusive nas de ambiente sem motor X11 nenhum
instalado, que é onde esse peso nunca teve o que fazer.

> **⚠ E o "zero call sites" que este documento afirmou depois do 1b estava errado.** Eram **nove**,
> e estavam nos `<script>` **inline do `index.html`**: `$("#upload")`, `$("div.window canvas").css()`,
> o dropdown da taskbar inteiro e um `$(document).ready`. A guarda que eu tinha escrito varria só os
> arquivos `.js` — e **uma varredura que escolhe onde olhar responde sobre onde olhou, não sobre o
> shell.** Quem pegou foi o `client-undefined-refs`, que é guarda de outro assunto, e só depois de a
> biblioteca sumir.

E **duas guardas minhas mediam texto em vez de estrutura**, as duas repelidas só depois de
consertadas: a de junção casava `"js/lib/jquery-ui.js"` em qualquer ponto do manifesto do motor — e
esse nome aparece lá **duas** vezes, no array e na tabela `__XPRA_JA_TENHO`, então tirá-lo do array
deixava verde. E a de ordem de carga procurava a string `js/janela/arrastar.js`, que **o comentário
que eu escrevi no `index.html` explicando a remoção contém** — ela achava o comentário, no topo do
arquivo, e passava para qualquer ordem.

Guarda final: 10 casos, **refutação 16/16**, e a de junção **rodou de verdade** (achou o pacote do
motor irmão e conferiu o manifesto dele).

### ⚠ E o hambúrguer da barra de tarefas ficou quebrado por três dias, por minha conta

Reportado por você: *"o taskbar-menu-btn ainda não está abrindo nada"*. Eram **duas** traduções
minhas na mesma mão, e cada uma parece uma equivalência sem ser:

```
$dd.is(":visible")  →  dd.offsetParent !== null
$dd.show()          →  dd.style.display = ''
```

As duas dependem de um fato que mora no **CSS** e que o JS não tem como ver:

- `#taskbar-xpra-dropdown { display: none }` — a folha declara o **repouso** escondido. Apagar o
  inline não mostra: devolve a decisão para a regra, que continua `none`. O `.show()` do jQuery
  escrevia um valor explícito exatamente por causa desse caso. Ler `.show()` como *"apagar o
  inline"* só está certo quando foi o próprio JS que escondeu antes — que é a situação dos **outros
  seis** `display = ''` do shell, e é por isso que eles estão certos e este não estava.
- `#taskbar-xpra-dropdown { position: fixed }` — o CSSOM manda `offsetParent` devolver `null` para
  elemento fixed, **sempre**. `aberto()` respondia "fechado" com o menu na tela.

**Nem o JS nem o CSS, lidos sozinhos, contêm o defeito.** Cada arquivo fecha nas suas próprias
contas. É a mesma forma dos defeitos do item 2 — duas informações que existem e não se encontram —,
só que atravessando a fronteira folha↔script em vez de janela↔janela. E o modo de falha é o pior:
**nenhum erro no console**, porque as duas linhas são JavaScript perfeitamente válido.

A guarda nova (`mostrar-o-que-o-css-esconde.test.js`) lê **os dois lados**, que é a única leitura
capaz de ver isto: monta do CSS o conjunto de ids cuja regra de repouso é `display:none` (e o de
`position:fixed`), resolve no JS a ligação `const X = getElementById('Y')` e pergunta sobre `X` —
**não** sobre o texto do id. Renomear a variável, mover o bloco ou trocar o id não a deixa verde por
engano; é o ataque *"o mesmo defeito com a variável renomeada"*, e ela pega. **Refutação 10/10**,
com os dois defeitos originais restaurados literalmente entre os ataques.

De brinde, a varredura de `display:none` acusou **47 linhas de CSS morto** — o `#desktop-ctx`, menu
de contexto artesanal do desktop substituído pelo `ContextMenu.js`, sem uma referência sequer no
shell. Saiu junto.

---

## 2. ✅ O gerenciador de arquivos se parte — mas não como o navegador se partiu

`FileBrowserWindow.js` tinha **3.562 linhas** — 2,4× o segundo maior arquivo do shell
(`BrowserWindow.js`, 1.474). O navegador já passou por isto: `js/browser/` são 19 arquivos e 4.841
linhas, e nenhum deles passa de 1.306.

### ⚠ A divisão que eu tinha escrito aqui estava errada, e a medida a desmentiu

Eu tinha listado sete arquivos (`FbAbas`, `FbNavegacao`, `FbLista`, `FbLateral`, `FbArrastar`,
`FbSeletor`, `FbIcones`) mapeados a partir dos 32 cabeçalhos `// ───`. **O critério era o assunto
do cabeçalho, e assunto não é costura.**

Medi as 33 seções por **quanto cada uma fala com `this`**, que é o que decide se um pedaço sai
inteiro ou sai puxando meia classe junto. A ordem que saiu não se parece com a tabela acima:
`Constructor` tem densidade 0,937 e `DOM building` 0,512 — são o coração, não módulos. E as de
densidade **zero** eram as tabelas estáticas, que eu tinha jogado num `FbIcones` no fim da lista.

### E ao mexer nelas apareceu o motivo de verdade, que não é o tamanho

O tamanho é o sintoma. O que estava errado é que **outras janelas alcançavam para dentro** do
gerenciador de arquivos — seis chamadas, de quatro arquivos, para responder perguntas que não têm
nada a ver com navegar em pastas:

| Quem alcançava | O que buscava |
|---|---|
| `Desktop.js:84` | `FileBrowserWindow._loadMimeCache()` |
| `Desktop.js:43` | `FileBrowserWindow._loadAppRegistry()` |
| `ArchiveWindow.js:333` | `FileBrowserWindow._SVG.folder()` |
| `OfficeEditorWindow.js:144` | `FileBrowserWindow._SVG[key]` |
| `FileContextMenu.js:73` | `FileBrowserWindow._buildOpenWithItems(path)` |
| `VsshAppWindow.js:563` | `FileBrowserWindow._buildOpenWithItems(path)` |

O ícone da área de trabalho dependia de o gerenciador de arquivos estar carregado. E o
`ArchiveWindow` ia além: **enxertava um método estático nele, de fora** — com o comentário *"permite
que ArchiveWindow obtenha ícones sem duplicar a lógica"*. É a afirmação mais afiada possível de que
a lógica não era dele.

**O critério do corte passou a ser esse**: sai o que outra janela precisa, não o que é grande.

### ✅ Primeiro corte — `js/arquivos/tipos.js` (184 linhas)

Os desenhos de ícone, os conjuntos de extensão (que continuam **apelidos do `FileOpener`**, a
definição única), o `EXT_MIME` e o cache de MIME. Saíram junto uma **cópia byte a byte** da tabela
de ícones que morava no `Desktop.js` e o enxerto do `ArchiveWindow`.

O comentário que já estava no `Desktop.js` contava que uma cópia local **dos conjuntos** tinha
divergido e fazia o mesmo `.html` abrir num lugar ali e noutro no gerenciador. Os conjuntos foram
unificados na época; **os ícones ficaram** — a mesma duplicata, no mesmo arquivo, sobrevivendo ao
conserto da irmã dela.

### ✅ Segundo corte — e ele achou que o primeiro não tinha terminado

Unificar a tabela **não unifica quem a consulta.** Depois que os desenhos vieram para o
`tipos.js`, o mapeamento extensão→ícone continuou existindo em **três** cópias — e a terceira era o
`iconePorExtensao` que eu mesmo tinha criado no corte anterior, herdado verbatim do enxerto, com o
defeito junto.

Só a do gerenciador de arquivos passava pelos `FileOpener.OFFICE_GROUPS`. Medido sobre as **108
extensões conhecidas: 29 desenhavam ícone diferente conforme o lugar.**

| | no gerenciador | na área de trabalho e dentro do `.zip` |
|---|---|---|
| `odt` `doc` `rtf` `epub` `ott` `dotx` `fodt` `mht` `fb2` | ícone de documento | folha em branco |
| `ods` `xls` `csv` `tsv` `xlsm` `xlt` `xltx` `ots` `fods` | ícone de planilha | folha em branco |
| `odp` `ppt` `pps` `ppsx` `pot` `potx` `otp` `fodp` | ícone de apresentação | folha em branco |
| `djvu` `xps` `oxps` | ícone de PDF | folha em branco |

Um `.odt` na área de trabalho era uma folha em branco; o **mesmo** `.odt` no gerenciador era o ícone
azul de documento.

**Nenhuma guarda de texto acharia isso** — as três cópias liam a mesma tabela, pelo nome certo, do
módulo certo. O que divergia era a pergunta, não o endereço. Por isso a guarda nova **executa** os
módulos reais e compara o resultado sobre o universo inteiro de extensões.

Havia ainda uma quarta e uma quinta cópia dos quatro testes de família (`OfficeEditorWindow.js:128`
e o `abrir-com`). A do `OfficeEditorWindow` **parecia** a mesma decisão e não era: ela testa antes
do `CODE`, então para ela um `.txt` é documento — medido, discordam em 4 das 37 extensões, e são
exatamente as 4 que têm de discordar. Virou `grupoDoDocumento`, chamada pelas duas em ordens
diferentes, com a diferença escrita. A do `abrir-com` testava os grupos em outra ordem e devolvia
outros nomes, o que a fazia parecer diferente; **os quatro grupos são disjuntos** (medido: 0 das 37
extensões cai em mais de um), então era cópia mesmo.

### ✅ `js/arquivos/abrir-com.js` (197 linhas)

`_buildOpenWithItems`, `_appsForExt` e `_loadAppRegistry` eram três `static` que **nunca tocaram em
`this`** — o único pedaço que precisava da janela já vinha por parâmetro (`focusFn`), anos antes de
alguém reparar no que isso significava. Com eles saem os três últimos alcances de fora.

`FileBrowserWindow.js`: **3.562 → 3.286 linhas.** O ganho em linhas é modesto e não é o ponto —
o que saiu foi acoplamento entre janelas e cinco duplicatas de uma decisão.

### ⚠ E aqui a medida teve de mudar de pergunta, porque o critério acabou

Com o "Abrir com" fora, **ninguém mais alcança dentro do `FileBrowserWindow`** — o critério dos dois
primeiros cortes se esgotou. E a densidade de `this` não serve de substituto: ela ordena por
**facilidade**, não por valor. Um corte fácil que não fecha contrato nenhum só troca um arquivo
grande por dois arquivos acoplados.

O que decide agora é a **superfície**: quantos membros distintos cada pedaço toca, e quantos são só
dele. E a primeira coisa que isso mostrou foi que **a maior seção do arquivo era o pior candidato**:

| seção | linhas | contrato |
|---|---|---|
| `Ordem congelada` | 598 | **30 itens** |
| `DOM building` | 358 | **51 itens** |
| `Navigation & API` | 215 | 19 itens |

Seção com contrato de 30 não é uma costura ruim — **é um cabeçalho que está mentindo.** Descendo a
método e agrupando por membro privado compartilhado, `Ordem congelada` guardava **cinco máquinas
independentes**, e quatro nada tinham a ver com ordem congelada.

### ✅ Terceiro corte — `js/arquivos/lateral.js` (360 linhas)

Uma dessas cinco era a barra lateral, e ela estava espalhada por **quatro seções**: `Ordem
congelada` (os lugares, a lixeira, as montagens), `As pastas de rede DO USUÁRIO`, `Pinned folders` e
a tabela `Static: sidebar places`. 251 linhas que sempre foram uma coisa só e que nenhum cabeçalho
nomeava. Sai agora porque **os itens 3 e 4 vão editá-la**.

Do lado de fora a barra precisa de sete ganchos, e eles chegam por parâmetro justamente para que
esteja escrito o que ela sabe da janela — e para que crescer essa lista seja visível.

**Duas guardas tiveram de ir atrás do código, e as duas ficaram vermelhas antes disso:**

- `raiz-no-gerenciador` lia só o `FileBrowserWindow.js`. Agora procura por **símbolo** entre os
  arquivos, e falha se ele sumir de todos — ou se aparecer em dois. Duas correções dela valem por
  si: o `corpoDe` fatiava até `\n  }`, que é medir **indentação**; e o padrão precisava exigir `{`
  no fim, senão casava com a **chamada** `desenharRaizes();`, que aparece antes da declaração.
- `fs-list-payload` usava o `FileBrowserWindow` como cobaia do *stripper* de comentários e exigia
  30.000 caracteres de diferença. O arquivo emagreceu 599 linhas e o caso ficou vermelho **sem que
  nada do que ele mede tivesse mudado**: ele dependia de um arquivo específico continuar gordo.
  Agora mede o shell inteiro (~43.000 caracteres, em dez arquivos).

### ✅ Quarto corte — `js/arquivos/trilha.js` (142 linhas), e o que NÃO foi cortado

Medido por superfície, o que sobrava eram quatro máquinas:

| máquina | linhas | contrato | saiu? |
|---|---|---|---|
| a lista virtual | 203 | 10 | **não** |
| a trilha | 94 | 7 (3 são contêineres dela) | **sim** |
| as zonas de drop | 75 | 6 | **não** |
| a seleção | 107 | 9 | **não** |

**Nem toda máquina medível merece virar arquivo.** A trilha sai porque o item 3 mexe nela — "Acesso
Rápido" precisa de ramo próprio na trilha, exatamente como a pasta de rede já tem. As outras três
têm **um cliente só**, e módulo com oito retornos de chamada e um cliente é indireção, não
separação. Quando o desktop precisar da seleção (item da lista abaixo), aí serão dois clientes e o
corte se paga.

E um achado do próprio corte: `_renderBread` tinha **três saídas** e cada uma repetia o par
`btnUp`/`btnBack` no fim. Esquecer uma deixa o "subir" aceso apontando para fora do espaço de nomes,
e o sintoma é o botão não fazer nada — que ninguém liga a *"a trilha ganhou um caminho novo"*.

**Mais dois cabeçalhos que mentiam.** `Zonas de drop` guardava nove máquinas, entre elas a **seleção
inteira**, que não tem nada a ver com soltar arquivo. E `Rendering` estava vazio havia tempos,
seguido direto por `Otimismo` — não foi esta onda que o esvaziou, foi esta que reparou.

### O saldo, e o que ele não alcança

`FileBrowserWindow.js`: **3.562 → 2.916 linhas (−18%)**, com 935 linhas em quatro módulos.

**E não vai chegar aos 1.306 do maior arquivo de `js/browser/` por extração.** Somando tudo que
ainda se separa (lista virtual, seleção, zonas de drop = ~385 linhas), sobrariam ~2.500 — porque
`DOM building` (358, contrato de 51), `Navigation & API` (215, contrato de 19), o construtor e a
fiação **são a janela**, não módulos escondidos nela. Escrevi "como o navegador se partiu" no
começo deste item; a medida diz que essa parte da frase não se sustenta, e é melhor dizer isso do
que continuar cortando para alcançar um número.

**Isto vem antes dos itens 3 e 4**, que são os dois que mexem na lateral e na raiz.

### ✅ E a área de trabalho deixou de ser só um lugar onde ícones aparecem

Com os módulos de pé, dá para medir o que a área de trabalho **não** faz e o gerenciador de
arquivos já faz. A cada verbo, a pergunta é feita ao código dos dois:

Medido verbo a verbo, faltavam **dez**. Nada disso é ícone bonito: era a área de trabalho **não se
comportando como um lugar onde há arquivos.** Apagar cinco ícones exigia cinco cliques direitos, e
`Ctrl+Z` não desfazia.

| Verbo | antes | agora |
|---|---|---|
| Seleção múltipla (Ctrl / Shift) | **não** — `_selected` era um elemento só | ✅ |
| Seleção por laço | não | ✅ |
| Teclado: `Delete`, `F2`, `Enter`, setas, `Ctrl+A/C/X/V/Z`, type-ahead | **nenhuma tecla** | ✅ |
| Arrastar um item para fora | não | ✅ |
| Receber arquivo solto no fundo (mover para `~/Desktop`) | não — só a lixeira aceitava | ✅ |
| Propriedades por `Alt+↵` | não | ✅ |
| Novo arquivo | não (só Nova pasta) | ✅ |
| Desfazer / refazer pelo teclado | não | ✅ |
| Renomear no lugar | não — abre diálogo | **continua abrindo diálogo** |
| Receber upload do computador | não | **de propósito, não** |

O upload arrastado para o fundo **não** foi feito, e a razão é de produto: o handler global do
`index.html` já trata isso como *file-transfer* da sessão X11. Interceptá-lo aqui mudaria, sem
aviso, o destino de um gesto que as pessoas já usam.

### Os dois cortes que eu tinha deixado de fora se pagaram aqui

É a regra que esta onda inteira usou: **sai o que mais de um lugar precisa.** No item 2 a seleção
foi medida (107 linhas, contrato de 9) e **deixada onde estava**, porque tinha um cliente só. Aqui
apareceu o segundo.

- **`js/arquivos/selecao.js`** — a regra do clique com modificador, das setas, do laço e do
  type-ahead. **Pura de propósito**: as duas telas são muito diferentes por baixo (50 mil itens
  virtualizados com abas de um lado, doze ícones e um proxy de escala do outro) e nada disso entra
  no módulo. Tudo que custou defeito se prova com listas de cinco strings, sem navegador.
- **`js/arquivos/lixeira.js`** — soltar dentro e esvaziar. Eram **14 de 25** linhas idênticas no
  primeiro e **6 de 6** no segundo.

### ⚠ Dois defeitos que a extração achou, e o primeiro não é "agora está melhor"

**1. `Shift+seta` no gerenciador de arquivos só selecionava DOIS itens — sempre.** O código tinha só
a âncora e calculava a posição atual a partir dela, então `Shift+↓` cinco vezes a partir do segundo
item dava os mesmos dois nas cinco. É o gesto normal de *"selecionar deste até aqui"* pelo teclado,
e **ele nunca funcionou**. A correção é o par **âncora** (ponto fixo) + **foco** (cursor), que é o
que todo gerenciador tem. Achado ao escrever o teste do módulo: o teste dizia o que o gesto *deve*
fazer, e o código respondeu outra coisa.

**2. As duas telas preenchem em sentidos opostos.** O gerenciador preenche por linha, então `↑↓`
cruzam a faixa; a área de trabalho é `flex-direction: column; wrap` (como o Windows), então quem
cruza é `←→`. Tratar as duas igual faz a seta pular o ícone vizinho — o tipo de coisa que se sente e
não se explica. O módulo recebe o **eixo**, e não um número de colunas.

### ⚠ E uma falha da própria suíte, que é o achado mais desconfortável

Um `paths.join('\n')` virou uma quebra de linha **dentro** do literal — código que navegador nenhum
carrega. **A suíte inteira, 1.126 casos, passou verde.** Nenhum deles fazia o *parse* dos arquivos
do cliente: eles leem o texto, procuram padrões e afirmam coisas sobre ele, e um arquivo que não
compila casa com padrão igual a um que compila.

No produto o `<script>` morreria e **tudo que vem depois dele no `index.html` deixaria de existir** —
a tela apareceria pela metade, sem erro que aponte para a causa. Agora há `shell-compila.test.js`,
que compila cada arquivo num `vm`; ele também recusa **byte NUL**, que foi o outro que passou batido
nesta mesma sessão.

### O que sobrou de cópia

`_openTerminal` **diverge sem ninguém ver**: o da área de trabalho cai num `qterminal --workdir`
fixo, enquanto o do gerenciador sonda nove emuladores (`$TERMINAL`, `x-terminal-emulator`, `xterm`,
`konsole`…) e escapa o caminho com aspas simples. Hoje **não morde** — o `TerminalLauncher` está
sempre carregado e atende os dois antes do fallback —, então é defeito **latente**, não vivo. Digo
isso porque medi, não porque suponho.

---

## 3. ✅ "Computador" morreu; nasceu o "Acesso Rápido"

`FileBrowserWindow.js:403` era um item de lateral com `data-path="/"` e o rótulo
**Computador**. Clicar nele lista o `/` de um Linux: `bin`, `boot`, `dev`, `etc`, `proc`, `sys`,
`usr`, `var`. Duas coisas erradas nisso, e a segunda é a que importa:

1. Não é "o computador" de ninguém — é a raiz do sistema de arquivos do host.
2. **É o único lugar do gerenciador que mostra a máquina em vez do ambiente.** A estrela-guia diz
   que o pesquisador tem os recursos *dele*, que não dependem daquela máquina; `/etc` é o oposto
   exato disso.

> No lugar entra **Acesso Rápido** — uma **tela**, não um caminho: **a raiz do servidor**, as
> montagens deste servidor, e as pastas de rede do usuário, cada uma com o espaço livre ao lado.
> É o "Meu Computador" do XP: onde as coisas cabem, e não uma árvore de sistema.

### ⚠ E a primeira versão desta tela estava errada — o relato foi direto

> *"O acesso rápido ficou meio ruim, não tem como acessar a raiz do servidor, ali as pastas
> ficaram redundantes com o painel lateral. Eu queria era algo meio ali a raiz e as pastas de
> rede."*

Eu tinha desenhado quatro grupos: **as pastas do perfil**, as montagens, as pastas de rede e **as
fixadas**. Três coisas erradas, e as três procedem:

1. **A raiz sumiu sem substituto.** Escrevi abaixo que ela *"deixa de ser OFERECIDA e continua
   alcançável digitando `/` na barra de endereço"* — o que é verdade e não basta. **Trocar um
   atalho visível por um comando que só quem já sabe descobre não é remover uma pegadinha: é
   remover uma função.**
2. **Metade da tela era a barra lateral outra vez.** "As suas pastas" e "Fixadas" mostravam
   exatamente o que fica a dez centímetros dali, à esquerda, o tempo todo. Duas cópias do mesmo,
   na mesma janela, ao mesmo tempo — e eu ainda tinha escrito uma guarda para garantir que as
   duas listas não divergissem, o que trata o sintoma da duplicação como se fosse a solução dela.
3. **O que faltava era o resto.** A raiz e as pastas de rede.

**E o meu argumento para matar o "Computador" não sobrevive a esta forma.** Eu escrevi que ele
*"era o único lugar do gerenciador que mostrava a MÁQUINA em vez do AMBIENTE"*. O que mostra a
máquina é **despejar `/etc` na tela** — que era o que o item antigo fazia, abrindo `/` direto. A
raiz numa lista, com o espaço livre ao lado, ao lado das montagens e das pastas de rede, não é a
máquina: **é onde as coisas cabem.** É exatamente o "Meu Computador" que o parágrafo acima dizia
querer, e eu o tinha construído sem a parte do computador.

A divisão passa a ser por **onde a coisa mora**:

| | |
|---|---|
| **barra lateral** | Início, Desktop, Downloads, Documentos, … e as fixadas |
| **esta tela** | a raiz do servidor, as montagens de `/media`, as pastas de rede |

### ⚠ E um segundo relato, com o mesmo sintoma e outra causa

> *"Quando eu atualizei a página e ele restaurou a janela e estava no acesso rápido, ele apareceu
> «pasta vazia»."*

Duas causas, e a segunda é a pior:

- **`_setState('empty')` quando o modelo saía vazio** — e no desenho antigo ele **saía** ao
  restaurar: `_homeDir` ainda era `null` (a descoberta é assíncrona) e as montagens ainda não
  tinham chegado, então os quatro grupos nasciam vazios. A raiz sempre presente mata isso, mas o
  estado errado continuava alcançável — e *"Pasta vazia"* é a pior frase possível para *"ainda não
  sei"*, porque descreve uma pasta que não existe.
- **`t.items = []` numa aba que o resto da janela trata como LISTA.** `_patch` reconstrói o grid a
  partir de `t.items` — **apagando a tela** e mostrando o vazio no lugar —, e `_softReload` pede
  `t.path` ao servidor, que recusa `//acesso-rapido` com razão. `_flushPatches` chama `_patch`
  **direto**, ao fim de um arraste, sem passar por `_render`: soltar um arquivo na tela a apagaria.

A aba passou a **declarar o que é** (`telaVirtual`), e os três funis perguntam — `_patch`,
`_softReload` e `_updateStatus`. Um `if` por chamador seria a vigésima chance de esquecer um, e o
esquecido apareceria como a tela sumindo depois de um gesto, sem nada ligando uma coisa à outra.
É a mesma forma do `t.isTrash`, que a lixeira já tinha por este exato motivo.

**Ela reusa o espaço de caminho que a [Onda 6](05-arquivos-de-rede.md) abriu.** As raízes de rede
vivem em `//rede/<id>/…`, com barra dupla.

O `/` continua alcançável digitando `/` na barra de endereço — **e agora também é a primeira
linha desta tela**, com ícone próprio e o espaço livre medido. O que morreu foi o atalho que o
abria DIRETO, despejando `bin`, `boot`, `dev`, `etc`, `proc`, `sys`, `usr`, `var` na cara de quem
clicou esperando ver os próprios discos.

### ⚠ E um terceiro e um quarto relato — e é a mesma causa de fundo dos dois anteriores

> *"Quando eu clico ali na raiz do servidor não acontece nada."*
> *"Além disso, quando eu clico em acesso rápido, ele buga as outras pastas."*

**O laço de seleção comia o clique.** Ele é armado **uma vez por aba**, sobre `.fb-body`, e o
`ignorar` dele lista `.fm-item` — mas os itens da tela são `.fb-ar-item`. Pressionar sobre a raiz
**começava um retângulo de seleção**, e ao soltar o laço engolia o clique seguinte, que é o
conserto escrito no item 1c para o hambúrguer. Bastava **um pixel** de movimento entre apertar e
soltar; parado, o clique passava — e é por isso que o defeito parecia intermitente.

`ignorar` não resolveria: é um seletor de **elemento**, e a área vazia da tela não casa seletor
nenhum. A pergunta certa não era qual elemento — era **se a área ainda é uma lista**. O laço ganhou
um gancho `ativo`, e a janela responde `() => !t.telaVirtual`.

**E a grade era emprestada e nunca devolvida.** `t.telaVirtual = true` estava num lugar e
`t.gridEl.className = 'fb-grid fb-ar'` noutro, e só a primeira era desfeita ao sair: a grade seguia
com o layout da tela (`display:block`, padding) em **toda pasta visitada depois**. Reescrever a
`className` inteira ainda apagava junto o `fb-grid--list` que o `_patch` gerencia. Emprestar um
elemento e devolvê-lo são **a mesma decisão**, e separá-las em duas linhas distantes é criar a
chance de fazer metade — viraram `_marcarTela(t, ehTela)`, e a guarda exige que não exista uma
segunda atribuição por fora.

**É o terceiro defeito da mesma família nesta tela**, e agora dá para nomear a família: eu construí
uma coisa que **não é uma lista** dentro de uma janela cujos gestos, classes e funis todos presumem
lista. Cada presunção apareceu separada — `_patch`, `_softReload`, `_updateStatus`, a `className`,
e agora o laço — e a resposta foi a mesma cada vez: **a aba declara o que é, e quem tem gesto
pergunta.** O que muda com o quarto caso é o alcance: não é só o que a janela *desenha*, é o que ela
*escuta*.

### ⚠ E a guarda que eu escrevi para isso deixou o ataque passar

A primeira versão da guarda perguntava se `podeLacar()` aparece **antes de `setPointerCapture`** no
texto do arquivo. Um dos 41 ataques passou por ela inteiro: mover a recusa para depois de
`aoMudar(new Set())` mantém a ordem no texto — e mesmo assim **apaga a seleção da tela** antes de
desistir. A recusa vale para o gesto inteiro, não para a captura.

**Guarda de ordem responde sobre onde a linha está; a pergunta era o que o gesto faz.** Foi para a
bancada de `laco-preso.test.js`, que já tinha o DOM de mentira: aperta o ponteiro numa área
desligada e cobra rastro nenhum — seleção intacta, sem captura, sem ouvinte, sem caixa, e o `click`
seguinte passando inteiro.

É o **quarto** defeito de instrumento desta onda, e o terceiro da mesma forma: medir o que é fácil
de alcançar em vez do que se quer saber.

### ⚠ "Herda essa guarda de graça, sem um `if` novo" — não herdava

Esta seção dizia que `safePath()` normaliza `//` → `/`, de forma que um caminho virtual vazando
para uma rota **quebra alto** em vez de virar `/rede/...` em silêncio. **As duas metades estão
erradas, e a segunda é a que importa.**

`safePath()` recusava **um prefixo**, `//rede/`, com um `throw` explícito. `//acesso-rapido` não
começa com ele: passava direto, normalizava para `/acesso-rapido` — um caminho POSIX
perfeitamente válido — e a pessoa leria *"não encontrado"*. Exatamente o silêncio que a frase
prometia evitar. (E a normalização `//` → `/` nunca foi o que "quebra alto": ela produz um caminho
válido que não existe, e isso é indistinguível de um erro de digitação. Quem quebra alto é o
`throw`.)

**E a primeira generalização que eu tentei estava errada.** Recusar todo `//` parece a regra limpa
e não é: barra dupla acontece por **acidente**, em concatenação — `home + '/' + rel` quando `home`
termina em barra. O `raiz-so-leitura.test.js` guardava isso desde a Onda 6, com o sintoma escrito
(*"o gerenciador parou de abrir uma pasta"*), e ficou vermelho no minuto seguinte.

A regra certa não é sintática, é de **registro**: cada espaço virtual se declara por NOME em
`ESPACOS_VIRTUAIS`, e o portão pergunta à lista. `//home/ana` continua virando `/home/ana`;
`//acesso-rapido` é recusado, com uma mensagem própria — *"isto não é um lugar"* e *"ainda não
funciona aqui"* são respostas diferentes para quem lê. **Espaço novo é uma linha, e já nasce
coberto** — que é o que esta seção dizia, agora sendo verdade em vez de suposição.

### ⚠ Duas das sete coisas prometidas nesta tela não tinham fonte de dado

A descrição acima lista *"a pasta pessoal, as pastas do perfil, as montagens deste servidor, as
pastas de rede do usuário, as fixadas, os recentes, e o espaço livre"*. Medidas as sete:

- **Os recentes não existem.** Não há histórico persistido em lugar nenhum deste sistema — nem
  chave de preferência, nem rota, nem tabela. Zero ocorrências. Construí-lo é uma chave nova, com
  escopo por servidor (caminho é de um filesystem) e teto: **um item próprio, não um detalhe desta
  tela.** Ficou de fora, e não está fingido.
- **O espaço livre só existia para `/`**, da máquina inteira, dentro de `/api/system/info`. Por
  montagem, não existia — e é justamente o número que faz esta tela ser o "Meu Computador" do XP em
  vez da barra lateral repetida no meio da janela: **num ambiente remoto o disco é de outra
  pessoa**, e a pergunta que se faz olhando a tela é "ainda dá para eu gravar aqui". Foi
  construído: rota `/fs/df`, **um exec para N caminhos**.

Medida que não vem simplesmente não aparece — sem barra, sem número. **Zero seria mentira, e é
"disco cheio" o que a pessoa leria.**

### As duas decisões que a medição forçou

**A tela não passa pela lista virtualizada.** A virtualização do gerenciador depende de célula de
tamanho **uniforme** — a posição de qualquer índice é aritmética, sem observador —, e cabeçalho de
grupo com barra de capacidade quebra essa aritmética. São poucas dezenas de linhas, sem nada a
virtualizar. É o que esta seção já dizia sem saber: *"uma **tela**, não um caminho"*.

**`/fs/df` se declara `lado: 'aberto'`** no contrato de raiz. `df` mede um **filesystem**, e uma
raiz remota não é um: perguntar quanto cabe numa raiz WebDAV pelo `df` mediria o disco de quem
hospeda o cache — número certo sobre a coisa errada, pior que número nenhum. A guarda de contagem
do [contrato](05-arquivos-de-rede.md) ficou vermelha no minuto em que a rota nasceu e cobrou a
linha lá.

### O que saiu de graça

A trilha tinha um `if` para a lixeira. O segundo lugar virtual é a véspera do terceiro que alguém
esquece, então virou lista: `virtuais: [{path, rotulo}]`. E a tela lê `LateralDeArquivos.LUGARES`
— a **mesma** lista da barra, não uma cópia — e passa as montagens por `FsList.visiveis`, de forma
que o interruptor do item 4 vale aqui também. Sem isso, seria a única tela onde esconder não
funciona.

**Guarda:** `acesso-rapido.test.js`, 30 casos, mais 1 na bancada de `laco-preso.test.js`;
**refutação 41/41** — e os **seis** defeitos relatados entram como ataque, cada um com o nome do
que se via na tela.

---

## 4. ✅ As pastas do administrador podem ser desligadas

`FsList.montagensDoServidor()` (`FsList.js:100-113`) lista os diretórios de `/media`, com o
desembrulho de `/media/<usuario>/`. **Não há registro nenhum por trás disso** — a identidade de uma
montagem de servidor é o caminho dela, e mais nada. Então a chave nova guarda caminhos.

> O administrador **propõe**; o usuário **dispõe**. A montagem do servidor não é do usuário para
> apagar — é dele para **esconder**. Quem tem quatro compartilhamentos do laboratório e usa um não
> deve ver os outros três em toda janela de arquivos que abrir.

Onde o controle mora: **Configurações → Pastas de rede**, no grupo *"Pastas deste servidor"* — que
hoje é a lista sem botão Remover (Onda 6, item 7). Ela ganha um interruptor por linha. Um botão
"Remover" ali seria mentira: na próxima listagem de `/media` a pasta volta.

**A chave precisa entrar no schema, senão a tela mente.** `src/utils/settings-schema.ts:24-30` já
carrega o comentário do defeito que isso causa — chave fora de `ALLOWED_KEYS` faz o `PUT` responder
200 e o servidor descartar em silêncio. Então: `ALLOWED_KEYS`, `DEFAULTS` e `SANITIZE`, os três de
uma vez.

### ⚠ "A chave nova guarda caminhos" — e isso estaria errado

O parágrafo acima diz que *"a identidade de uma montagem de servidor é o caminho dela, e mais
nada"*. É verdade **dentro de um servidor**, e a chave não vive dentro de um: as Configurações são
do **usuário** e viajam entre servidores. `/media/dados` é um caminho de **um** filesystem — uma
lista só de caminhos esconderia a pasta do laboratório **e a de casa**, e a pessoa veria uma
montagem sumir num servidor onde nunca mexeu.

O `AppGrants` já teve e já corrigiu exatamente este erro na [Onda 7](06-portabilidade.md), com o
motivo escrito no arquivo dele: *"caminho é de um filesystem específico, e sem esse nível um grant
de `/home/ana/dados` no servidor A valeria no servidor B"*. Mesmo formato — `{ serverId:
[caminhos] }` —, mesma leitura de servidor, e a mesma poda de servidor vazio **nas duas pontas**:
se só uma podasse, o corpo encolheria no servidor e reapareceria no próximo GET.

### Onde o filtro fica, e por que não é onde parece

`FsList.montagensDoServidor()` continua devolvendo **tudo**. O filtro é aplicado na barra lateral,
**ao desenhar** — não ao buscar. Duas consequências, e as duas são o item:

- a seção de Configurações precisa das montagens **todas**, porque é ela quem oferece o
  interruptor. Se ela filtrasse, a pasta escondida sumiria da única tela onde dá para reexibi-la;
- filtrar ao desenhar faz mexer no interruptor **redesenhar** a barra, sem uma ida a `/media`.

E não há evento novo: `FsList.ocultarMontagem` grava em `VsshSettings`, e quem precisa saber assina
a chave — que é o que o `FileBrowserWindow` já fazia com `userMounts`. Um `CustomEvent` próprio
seria um segundo mecanismo de aviso ao lado de um que existe, e o segundo é sempre o que alguém
esquece de disparar.

### O interruptor virou primitivo

`SettingsWindow.interruptor(marcado, aoMudar)`, oferecido pelo contexto das seções. Sem isso, a
lista dinâmica montaria o `.ds-switch` na mão — duas noções do mesmo controle, e a primeira vez que
a folha mudasse uma delas ficaria para trás.

**Guarda:** `montagem-que-o-usuario-esconde.test.js`, 10 casos, **refutação 28/28**.

### ⚠ E um byte NUL entrou de novo — a guarda estava olhando o outro diretório

Um escape mal montado num script de edição gravou um NUL literal em `settings-schema.ts`. O arquivo
compila, `tsc` passa, `eslint` passa, os 1.200 testes passam — e o `grep` passa a tratar o fonte
como **binário**, de forma que as varreduras que sustentam metade desta suíte param de enxergá-lo
sem avisar ninguém.

A guarda de NUL existia desde o primeiro caso, na mesma onda. Ela olhava **só o `vssh-client/`**,
porque foi lá que o primeiro caiu. **Guarda que escolhe onde olhar responde sobre onde olhou** — a
mesma lição que o item 1c já tinha registrado, repetida. Agora ela varre o repositório inteiro:
cliente, servidor, testes e ferramentas.

---

## 5. ✅ O ambiente passou a se medir

> Um gerenciador de tarefas do VSSH: quanto **os nossos** vssh-apps e o shell consomem — não a
> máquina inteira, que é o que "Sobre → Recursos" já mostra.

### O achado que veio junto: "Recursos" está congelado

`secoes-sistema.js:780`:

```js
// 30 s: uso de memória e disco mudam devagar, e cada tique é um comando no servidor.
const t = setInterval(() => { if (!el.isConnected) return; }, 30000);
```

O corpo do intervalo tem **uma instrução, e é um `return`**. Ele dispara a cada 30 s e não faz
nada. O painel mostra o primeiro `fetch` para sempre — e o comentário acima descreve um custo que
não é pago porque o trabalho não acontece. Duas linhas acima no mesmo arquivo (`:437`) está a
versão que funciona: `if (el.isConnected) pintar();`.

#### ⚠ "Conserto de uma linha" — não era

**Não existia `pintar()` para chamar.** O `fetch` inteiro estava solto no construtor da seção, e o
tique não tinha o que invocar. O que faltava era o **recorte** — o mesmo que a seção vizinha já
tinha, e é por isso que a dela funciona há meses. Entrou junto uma trava de pedido em voo: o tique
é de 30 s e a medida vem de um exec por SSH; sem ela, um servidor lento faria dois pedidos se
atropelarem e o painel piscar entre respostas fora de ordem.

**Medida congelada é pior que medida ausente.** A ausente ninguém acredita: o painel estaria vazio
e a pergunta apareceria sozinha. A congelada é indistinguível de medida **estável** — 6,1 GiB
parados por uma hora pode ser um servidor tranquilo. Só se descobre comparando com outra fonte, e
ninguém compara o que não tem motivo para duvidar.

**Guarda:** `medida-que-parece-viva.test.js` — todo corpo de `setInterval`/`setTimeout` do shell,
achado por contagem de chaves, tem de ter **efeito**. A primeira versão perguntava *"chama alguma
coisa?"* e acusou cinco `setTimeout` legítimos que só soltam uma trava (`_arrastando = false`):
atribuição é trabalho, e a pergunta certa é mais larga. **Refutação 8/8.**

### A metade do servidor: já tem fundação

Cada vssh-app grava o PID em `~/.vssh-apps/<id>/run.pid` antes do `exec` do runtime, e o portal já
o lê (`vssh-apps.ts:150-165`). Do PID saem `/proc/<pid>/stat` (utime+stime → CPU) e
`/proc/<pid>/status` (VmRSS → memória residente). Três restrições, e as três já estão medidas ou
escritas no código:

- **Um comando, não N.** O pool de SSH tem teto de ~8 canais **por servidor**
  (`ssh-exec.ts:152-157`, citado em `vssh-apps.ts`). Uma consulta por app derrubaria o teto com
  cinco apps abertos. Um `bash -c` lê todos os `run.pid` e todos os `/proc` de uma vez.
- **CPU% precisa de duas amostras.** O contador anterior fica no **cliente**, e não no portal: é
  o cliente que faz o polling, e ele já tem a resposta passada em mãos. Guardá-lo no servidor
  exigiria um mapa por (usuário, servidor, app) com política de expiração, para poupar exatamente
  nada — o custo do primeiro tique é mostrar um traço em vez de um percentual, uma vez.
  > E há um terceiro jeito de errar isso, que não estava previsto aqui: **presumir 100 jiffies/s**.
  > Jiffy não é constante do universo, é configuração de kernel — num kernel de 250 o percentual
  > sai 2,5× errado, e errado de um jeito **plausível**, que é o pior: ninguém desconfia de "40% de
  > CPU". O `getconf CLK_TCK` vem no mesmo exec.
- **O teto ao lado do uso.** A [Onda 4](04-runtime-composicao.md#limites-de-recurso---concluído) já
  põe cada app num `systemd-run --user --scope` com `resources` do manifesto. Mostrar uso *sem* o
  limite é a metade que engana — e foi exatamente ali que apareceu um `MemoryHigh` cem vezes acima
  do `MemoryMax`, que só uma máquina com RAM de verdade mostrou.

### A metade do navegador: NÃO é o que o pedido supõe, e isso é medida

O pedido diz *"uso de memória frontend no navegador se for possível"*. **Medido: por app, não é.**

- `performance.measureUserAgentSpecificMemory()` exige **isolamento cross-origin**. Não há
  `Cross-Origin-Opener-Policy` nem `Cross-Origin-Embedder-Policy` em lugar nenhum de `src/` ou de
  `vssh-client/` — zero ocorrências. A API não existe neste documento.
- Os vssh-apps são iframes de **mesma origem** (`VsshAppWindow.js:79`, servidos pelo proxy do
  portal). Mesma origem significa mesmo processo de renderização: qualquer número de heap é o
  total do renderer, **não** a fatia de um app.

Então o que a tela mostra do lado do navegador é outra coisa, e ela precisa se chamar pelo nome:
**por janela** — nós DOM, listeners registrados, iframes vivos, tempo desde a última atividade — e
**um** número de heap, do shell inteiro, rotulado como do shell inteiro. Isso responde *"qual
janela está vazando"*, que é a pergunta que se faz na prática. Não responde *"quanto o app X pesa
no navegador"*, e a tela não vai fingir que responde.

> Ligar o isolamento cross-origin é uma pergunta separada, e cara: COEP obriga **todo** recurso
> embutido a se declarar, e o motor de navegação embute a web de terceiros por procuração. Fica
> como medição própria, não como pressuposto desta onda.

### O que a construção obrigou a consertar

**O parse foi para `src/utils/uso-de-apps.ts`, módulo folha.** Importar `vssh-apps.ts` num teste
levanta a pilha inteira de SSH e Redis e o processo nunca termina — foi por isso que
`limites-de-recurso.test.js` mede aquele arquivo **lendo o texto**. Guarda que mede texto é o que
sobra quando a regra mora atrás dessa parede, e a regra aqui é pura.

**O comando remoto não tem sequência de escape nenhuma, e isso é deliberado:** `grep -z` em vez de
`tr "\0" "\n"`. Escape mal montado já gravou um byte NUL literal nesta base duas vezes nesta onda,
e o modo de falha é silencioso em todas as camadas.

### ⚠ E a própria bancada de refutação tinha o defeito que ela procura

Ela escrevia a mutação, rodava, e restaurava **depois**. Morreu num `timeout` no meio, e a fonte
ficou mutada — num arquivo novo, ainda não versionado, então nem `git checkout` o traria de volta.
A mutação virou "código", e o teste seguinte ficou vermelho **acusando o produto de um defeito da
bancada**.

Agora: tudo que será tocado é copiado **antes** da primeira mutação, a restauração vive num
`finally`, e há outra em `process.on('exit')` e nos sinais. É a mesma ideia dos três consertos —
**a restauração não pode depender de o caminho feliz acontecer.**

**Guarda:** `medir-o-ambiente.test.js`, 15 casos, **refutação 31/31**. Um ataque sobreviveu à
primeira versão — `limites` aceitando array, porque `typeof [] === 'object'` — e virou conserto na
fonte.

---

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 1a | ✅ O motor vendoriza e declara o jQuery dele — **0.3.0** | `vsshapp-xpra` | — |
| — | **publicar o motor 0.3.0 nos servidores** | | 1a |
| 1b | ✅ **feito** — `js/janela/arrastar.js`, e o shell tem **zero** call sites de jQuery | `vssh-sso` | — |
| 1c | ✅ **feito** — os três arquivos apagados; o JS do shell caiu **2,25 → 1,44 MB (−36%)** | `vssh-sso` | — |
| 2 | ✅ **feito** — seis módulos, 3.562 → 2.827 linhas, e a área de trabalho com 11 dos 13 verbos | `vssh-sso` | — |
| 3 | ✅ **feito** — Acesso Rápido, `/fs/df`, e o registro de espaços virtuais | `vssh-sso` | 2 |
| 4 | ✅ **feito** — `montagensOcultas` por servidor, e o interruptor virou primitivo | `vssh-sso` | 2 |
| 5 | ✅ **feito** — `/api/apps/usage`, o painel de janelas, e o `setInterval` descongelado | `vssh-sso` | — |

**A única dependência dura é 1a → 1c**, e ela atravessa repositórios. As colunas 1, 2 e 5 correm em
paralelo. 1b pode acontecer antes de 1a: reescrever o arraste do shell não mexe no do motor, que
tem o dele em `Window.js`.

## Verificação

As redes que já existem cobrem a maior parte do risco desta onda, e não por acaso — elas nasceram
de uma remoção que subiu verde e não abria: `client-undefined-refs`, `client-dom-ids`,
`client-css-classes`, `client-assets`, `sprite-icons`. **Apagar por símbolo, nunca por intervalo.**

O que falta, e o que esta onda precisa construir:

- **A guarda de junção dos dois repositórios.** É o defeito central desta onda, então ela é o teste
  central: *se o shell não carrega mais o jQuery, o `arquivos.js` do motor tem de listá-lo*. Uma
  afirmação, medindo o par — não duas afirmações, cada uma medindo o seu lado e as duas verdes com
  o ambiente quebrado.
- **Um portão de ausência**: zero `jQuery(` no `vssh-client/`, zero `<script>` dos três arquivos no
  `index.html`, e os arquivos inexistentes.
- **A medida do arraste, antes e depois**, com a bancada CDP da T9 — e o número no texto, não o
  adjetivo.
- **Refutação de cada guarda nova**: mutar a fonte de verdade, rodar o teste filtrado, restaurar,
  com linha de base verde antes. Guarda que não vira vermelha ao quebrar o produto não mede nada.

## O que esta onda NÃO faz

- **Não toca no item 2 da [Onda 7](06-portabilidade.md)** — handoff, espelho ou escopos separados
  continua parado numa decisão de produto, e o item 3 atrás dela.
- **Não muda o protocolo do Xpra nem o motor além do `arquivos.js`.** O item 1a é uma linha de
  declaração e dois arquivos vendorizados; os 134 call sites do motor ficam onde estão. Eles são
  problema de quem mantém o motor, e o motor pode não estar instalado.
- **Não liga isolamento cross-origin.**
- **Não constrói os "recentes"** do Acesso Rápido. Não há fonte de dado, e criá-la é uma chave de
  preferência nova com escopo por servidor e teto — item próprio, não detalhe de tela.
- **Não tira os 16 seletores `[data-theme="tuff"] .algo`** que sobraram em quatro folhas. Eles não
  são mortos (o atributo *é* `tuff`), mas qualificam num valor constante. Tirar o qualificador
  baixa a especificidade de (0,2,0) para (0,1,0), e `.taskbar-icon-btn`, `.tb-dd-item` e
  `.vssh-fallback-option` **têm regra concorrente sem ele**, hoje vencida por especificidade. Sem
  teste visual nesta suíte, seria trocar uma mentira por um risco de regressão silenciosa — a
  guarda trava o número, que só pode encolher.
- **Não faz renomeação inline nem soltar-para-enviar na área de trabalho** — os dois verbos que
  faltam dos treze. O segundo tem dono: o handler global do `index.html` já reivindica esse gesto
  para a transferência de arquivo do Xpra.
- **Não reescreve o `TilingManager`.** O arraste novo entrega os mesmos cinco ganchos.
