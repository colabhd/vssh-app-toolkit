# Onda 8 — O shell deixa de ser um fork do cliente Xpra

> **Estado:** 📋 planejada, com a medição do item 1 já feita · **Atualizado:** 2026-08-08
> **Repos:** `vssh-sso` + `vsshapp-xpra`
> **Depende da [2.7](02b-motores.md)**, que já fechou — sem o motor ter saído do `vssh-client/`,
> o item 1 não teria como existir. **Independente da [Onda 7](06-portabilidade.md)**, cujo item 2
> continua parado numa decisão de produto e não bloqueia nada aqui.

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

### 1a. O motor adota a própria dependência — `vsshapp-xpra`, e vai primeiro

`frontend/motor/arquivos.js` ganha `js/lib/jquery.js` e `js/lib/jquery-ui.js` no topo da lista, e
o pacote passa a vendorizá-los. Ele já vendoriza treze bibliotecas; estas duas são a décima quarta
e a décima quinta, e são as únicas que hoje ele pega emprestado.

**Enquanto as duas versões coexistem, carregar duas vezes tem de ser inócuo.** O motor carrega
depois do shell; jQuery redefinido sobre si mesmo com a mesma versão é idempotente, mas
`jquery-ui` registrando os widgets duas vezes não é óbvio que seja. **Isso se mede, não se
supõe** — e é o portão para publicar 1a.

`conferir-pacote.mjs` do motor passa a exigir que os dois arquivos existam e estejam na lista.

### 1b. O arraste vira nativo — `vssh-sso`

Um módulo só, `js/janela/arrastar.js`, substituindo as **duas** cópias de `_setupDragResize`
(`VsshWindow.js:638` e `VsshDialogs.js:164`) por uma. É a mesma lição de sempre: **um portão, não
dois**. O diálogo não é um caso especial — é o caso geral com `resize: false`.

O que ele precisa preservar, porque cada um já custou um defeito e está comentado no código:

- o `distance: 5` que impede arraste acidental em clique rápido (`VsshWindow.js:655`);
- o `cancel` que abre exceção para controles nativos — sem ele, `mousedown` num `<select>` cai na
  maquinaria de arraste, que dá `preventDefault()`, e o `<select>` não abre (`VsshWindow.js:416`);
- o `guard` de tela cheia que impede o canvas do Xpra de roubar o mouse durante o arraste;
- o `containment` fixado no `mousedown`, **antes** do início do arraste (`VsshWindow.js:677-683`);
- os ganchos do `TilingManager` — `onDragStart` / `onDrag` / `onDragStop` / `onResize` /
  `onResizeStop`.

**A previsão, escrita antes da medida.** Prevejo que trocar `left`/`top` por
`transform: translate3d()`, com uma escrita por `requestAnimationFrame` e as leituras de layout
tiradas do frame, elimine Layout e Paint do arraste e deixe só composição.

**Mas isso é previsão.** A [Onda 6b](05b-navegacao-de-arquivos.md) previu 874 ms de navegação e
mediu 157 — os 874 eram de outro subsistema. **Então mede-se antes de escrever o módulo**, com a
bancada CDP que a [Onda 3 (T9)](03-toolkit.md#t9--testes-de-navegador) já construiu: arraste
sintético de N frames, contando `Layout` / `Recalculate Style` / `Paint` e frames longos, com o
mesmo roteiro rodando depois. Se o número de hoje já for bom, **o item 1b encolhe para "apagar a
segunda cópia" e a onda diz isso**, como a 6b disse.

O mesmo vale para a memória: 830 KB de fonte são parse e heap, mas **quanto** é medida, não conta
de padaria. `performance.memory` do renderer, com e sem os três arquivos, antes de afirmar
qualquer coisa no texto.

### 1c. Os três arquivos saem — `vssh-sso`

`index.html:36-38` perde as três linhas; `js/lib/jquery*.js` são apagados. Os sete call sites
restantes viram DOM nativo — `.show()`/`.hide()` são `style.display`, `.mousedown()` é
`addEventListener`, e o `$(function(){})` do `MenuCustom.js` é `DOMContentLoaded`.

---

## 2. O gerenciador de arquivos se parte, como o navegador se partiu

`FileBrowserWindow.js` tem **3.562 linhas** — 2,4× o segundo maior arquivo do shell
(`BrowserWindow.js`, 1.474). O navegador já passou por isto: `js/browser/` são 19 arquivos e 4.841
linhas, e nenhum deles passa de 1.306.

**As costuras já estão marcadas.** O arquivo tem 32 cabeçalhos `// ───` que são exatamente os
módulos que faltam nascer. Os candidatos que se separam sozinhos:

| Sai para | Vem das seções (linhas de hoje) |
|---|---|
| `files/FbAbas.js` | Tab management (755), Address bar (913) |
| `files/FbNavegacao.js` | Navigation & API (984), Pré-carregar ao pairar (1202) |
| `files/FbLista.js` | Rendering (1252), Otimismo (1254), Ordem congelada (1272), Itens da lista (2012), Indicação de carregamento (2656) |
| `files/FbLateral.js` | Static: sidebar places (90), pastas de rede DO USUÁRIO (1870), Pinned folders (1916) |
| `files/FbArrastar.js` | Drag & drop (2103), Spring-loading (2175), Zonas de drop (2303) |
| `files/FbSeletor.js` | Picker mode helpers (2927), Grupos de filtro nomeados (3036) |
| `files/FbIcones.js` | Static: SVG icons (7), extension sets (59), mime-cache (130) |

**Isto vem antes dos itens 3 e 4**, que são os dois que mexem na lateral e na raiz: fazê-los depois
do corte é escrever em arquivos de 200 linhas em vez de emendar num de 3.562.

---

## 3. "Computador" morre; nasce "Acesso Rápido"

Hoje, `FileBrowserWindow.js:403` é um item de lateral com `data-path="/"` e o rótulo
**Computador**. Clicar nele lista o `/` de um Linux: `bin`, `boot`, `dev`, `etc`, `proc`, `sys`,
`usr`, `var`. Duas coisas erradas nisso, e a segunda é a que importa:

1. Não é "o computador" de ninguém — é a raiz do sistema de arquivos do host.
2. **É o único lugar do gerenciador que mostra a máquina em vez do ambiente.** A estrela-guia diz
   que o pesquisador tem os recursos *dele*, que não dependem daquela máquina; `/etc` é o oposto
   exato disso.

> No lugar entra **Acesso Rápido** — uma **tela**, não um caminho: a pasta pessoal, as pastas do
> perfil, as montagens deste servidor, as pastas de rede do usuário, as fixadas, os recentes, e o
> espaço livre. É o "Meu Computador" do XP: a primeira coisa que se vê é o que é seu, com espaço
> medido ao lado, e não uma árvore de sistema.

**Ela reusa o espaço de caminho que a [Onda 6](05-arquivos-de-rede.md) abriu.** As raízes de rede
vivem em `//rede/<id>/…`, com barra dupla, e `safePath()` normaliza `//` → `/` — de forma que um
caminho desses vazando para uma rota de shell **quebra alto** em vez de virar `/rede/...` em
silêncio. `//acesso-rapido` herda essa guarda de graça, sem um `if` novo em lugar nenhum.

O `/` continua alcançável digitando `/` na barra de endereço. Ele deixa de ser **oferecido**.

---

## 4. As pastas do administrador podem ser desligadas

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
200 e o servidor descartar em silêncio. Então: `ALLOWED_KEYS`, `DEFAULTS` (`[]`) e `SANITIZE`
(lista de strings, caminho absoluto, sem `..`, sem byte nulo, com teto), os três de uma vez.

---

## 5. O ambiente passa a se medir

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
versão que funciona: `if (el.isConnected) pintar();`. **Conserto de uma linha, e ele entra nesta
onda porque é o mesmo assunto: medida que se apresenta como viva.**

### A metade do servidor: já tem fundação

Cada vssh-app grava o PID em `~/.vssh-apps/<id>/run.pid` antes do `exec` do runtime, e o portal já
o lê (`vssh-apps.ts:150-165`). Do PID saem `/proc/<pid>/stat` (utime+stime → CPU) e
`/proc/<pid>/status` (VmRSS → memória residente). Três restrições, e as três já estão medidas ou
escritas no código:

- **Um comando, não N.** O pool de SSH tem teto de ~8 canais **por servidor**
  (`ssh-exec.ts:152-157`, citado em `vssh-apps.ts`). Uma consulta por app derrubaria o teto com
  cinco apps abertos. Um `bash -c` lê todos os `run.pid` e todos os `/proc` de uma vez.
- **CPU% precisa de duas amostras.** O portal guarda o contador anterior e divide pelo tempo
  decorrido — assim continua sendo **um** exec por tique, em vez de um exec que dorme.
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

---

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 1a | O motor vendoriza e declara o jQuery dele | `vsshapp-xpra` | — |
| — | *(publicar o motor; medir a dupla carga)* | | 1a |
| 1b | Medir o arraste; um `arrastar.js` no lugar das duas cópias | `vssh-sso` | — |
| 1c | Apagar `jquery*.js` e as três linhas do `index.html` | `vssh-sso` | **1a publicado** e 1b |
| 2 | Partir o `FileBrowserWindow.js` | `vssh-sso` | — |
| 3 | Acesso Rápido | `vssh-sso` | 2 |
| 4 | Desligar montagem do servidor | `vssh-sso` | 2 |
| 5 | Monitor de recursos (+ o `setInterval` congelado) | `vssh-sso` | — |

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
- **Não reescreve o `TilingManager`.** O arraste novo entrega os mesmos cinco ganchos.
