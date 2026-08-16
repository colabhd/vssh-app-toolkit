# A biblioteca de UI (Tuff)

A estética do ambiente, do lado do app. Um `<link>` e a janela do seu app passa a se parecer com as
outras janelas do desktop — mesma paleta, mesma tipografia, mesma scrollbar, mesmos ícones.

> **O catálogo abre com duplo clique.** [`componentes.html`](componentes.html) tem todos os
> componentes numa página só, sem servidor e sem build. Julgar aparência se faz olhando.

## Por que isto existe

Um vssh-app roda num `<iframe>` same-origin, e **o shell não injeta nada nele**: nem folha, nem
token, nem fonte. Herança de aparência não existe — é preciso trazer.

Enquanto não havia por onde, quem quis se parecer com o ambiente pagou à mão. O `vsshapp-recoll` tem
259 linhas recriando a paleta sob um prefixo privado, e a ponte de JavaScript que ele escreveu junto
**já apodreceu**: ela escuta uma mensagem (`{type:'vssh-theme'}`) que foi removida do shell e cita um
caminho que não existe mais. Nada acusou.

Do outro lado, o [critério 3.3](roadmap/criterios.md#33--está-belo) é condição de pronto para todo
vssh-app — *"a promessa é que o usuário esqueça que está num navegador"*.

## Ligando

```js
// Node
const { WEB_DIR, SHIMS, ESTILOS, SCRIPTS } = require('vssh-app-toolkit/web');
createStaticSpa({
  root: BUNDLE,
  mounts: { '/_vssh/': WEB_DIR },
  injectStyles: ESTILOS.map((f) => `_vssh/${f}`),                       // ← as folhas
  injectScripts: [...SHIMS, ...SCRIPTS].map((s) => `_vssh/${s}`),       // ← shim + ícones + gaveta
});
```

```python
# Python
from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS, ESTILOS, SCRIPTS
criar_spa_estatica(
    root=BUNDLE,
    mounts={"/_vssh/": DIRETORIO_WEB},
    inject_styles=[f"_vssh/{f}" for f in ESTILOS],
    inject_scripts=[f"_vssh/{s}" for s in SHIMS + SCRIPTS],
)
```

**As listas são separadas de `SHIMS` de propósito.** Todo app escreve `injectScripts: SHIMS.map(…)`
sem pensar; uma folha de estilo ali dentro reestilizaria os apps já publicados no próximo
`npm i` — inclusive um que serve conteúdo de terceiros. **Adotar a aparência do ambiente é ato
explícito do seu backend.**

`injectStyles` emite `<link>` **antes** dos `<script>`, com o mesmo carimbo de conteúdo
(`?v=<hash>`). Um `<link>` escrito à mão no seu HTML também funciona — só perde o carimbo, e para
CSS o sintoma de bytes velhos é pior que para script: uma folha antiga de cache não parece cache,
parece decisão de design.

| Lista | O que traz | Quando |
|---|---|---|
| `ESTILOS` | tokens, base (reset, scrollbar, foco) e os componentes | quase sempre |
| `SCRIPTS` | os ícones (o sprite) e a gaveta de navegação | quase sempre |
| `ESTILOS_MIDIA` · `SCRIPTS_MIDIA` | trilha, volume, chrome que some, grade virtualizada, visor | só quem tem mídia |

Quem quer só os tokens — um app com identidade visual própria que ainda assim quer acompanhar a cor
do ambiente — injeta `tuff/tuff-tokens.css` sozinho.

## O que ela NÃO tem, e nunca vai ter

**Diálogo, menu de contexto, aviso, bandeja e seletor de arquivo.** Essas superfícies são do
**desktop**, e o app as pede:

| Em vez de desenhar | Peça |
|---|---|
| um modal | `vssh.dialog.alert / confirm / prompt / password / error` |
| um menu de contexto | `vssh.contextMenu(itens)` |
| um "toast" | `vssh.toast(texto)` |
| um aviso persistente | `vssh.notify({ … })` |
| um seletor de arquivo | `vssh.pickFile / pickSave / pickDirectory` |

Não é economia: um modal desenhado dentro do app fica **preso no iframe**. Ele não cobre a janela,
não sobrevive a tela cheia e não aparece por cima do resto do ambiente. E delegar é o que faz o seu
menu se parecer com o resto do ambiente em vez de ser um `<div>` que alguém estilizou —
ver [`api.md`](api.md#menu-de-contexto).

`tests/tuff-vocabulario.test.js` recusa as marcas dessas peças dentro da biblioteca.

## Os tokens

Duas camadas, como no shell: `--tuff-*` é a base bruta, `--ds-*` é o que os componentes leem.
**Escreva `--ds-*`.**

```css
.minha-peca {
  background: var(--ds-bg2);
  color: var(--ds-text);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: var(--ds-gap-md) var(--ds-gap-lg);
}
```

Os principais: `--ds-bg` `--ds-bg2` `--ds-bg3` `--ds-bg-input` `--ds-bg-hover` · `--ds-border`
`--ds-border-focus` · `--ds-text` `--ds-text-dim` `--ds-text-mid` · `--ds-accent` `--ds-accent-h`
`--ds-accent-bg` `--ds-on-accent` `--ds-sel` · `--ds-green` `--ds-warn` `--ds-danger` ·
`--ds-radius-*` `--ds-gap-*` `--ds-shadow-*` `--ds-dur` `--ds-ease`.

**Sem glassmorfismo.** `--ds-blur` vale `none`, e isso é decisão de produto do ambiente, não omissão.

## Os componentes

Todos com prefixo `tuff-`. O catálogo mostra cada um.

| | |
|---|---|
| Superfície | `.tuff-painel` `.tuff-sec` `.tuff-sec-titulo` `.tuff-sec-desc` `.tuff-divisor` |
| Ação | `.tuff-btn` `--primario` `--perigo` `--icone` · `.tuff-acoes` `--direita` |
| Entrada | `.tuff-rotulo` `.tuff-campo` `.tuff-select` `.tuff-busca` `.tuff-switch` `.tuff-seg` |
| Configuração | `.tuff-grupo` `.tuff-linha` `.tuff-linha-titulo` `.tuff-linha-desc` `.tuff-linha-ctrl` |
| Estado | `.tuff-pill` `--ok` `--aviso` `--erro` `--ocupado` · `.tuff-tag` `.tuff-tecla` `.tuff-dica` |
| Espera | `.tuff-spinner` · `.tuff-progresso` `--alerta` `--indeterminado` |
| Dados | `.tuff-lista` `.tuff-item` `.tuff-kv` `--mono` · `.tuff-vazio` |
| Estrutura | `.tuff-barra` `.tuff-gaveta` `.tuff-detalhe` · `[data-tuff-dica]` (tooltip) |

Três regras que vêm da tabela do critério 3.3 e que a biblioteca já cumpre por você: **nunca
controle nativo** (o `<select>` tem caixa e seta próprias, e a lista aberta também é estilizada — em
Windows ela herdaria o fundo branco do sistema), **scrollbar do tema** (6px, polegar em
`--ds-border`) e **hierarquia** entre rótulo e valor.

### Botão que liga e desliga

Use `aria-pressed`, e o realce sai de graça — o mesmo de `.tuff-gaveta-item--ativo`, que é como o
ambiente diz "este aqui está valendo".

```html
<button class="tuff-btn tuff-btn--icone" aria-pressed="true" aria-label="Repetir: só esta">…</button>
```

> ⚠ Isto não existia até um app precisar. **Um alternador sem estado visível não parece um botão
> feio: ele faz a interface fazer coisas que ninguém pediu**, sem nada na tela explicando por quê. E
> `aria-pressed` não é enfeite de acessibilidade aqui — é o próprio seletor, então o leitor de tela
> e o olho não têm como divergir.
>
> Para **três** estados (repetir: desligado / a fila toda / só esta), cor não basta: troque também o
> glifo — `ico-repeat` e `ico-repeat-one` existem para isso.

## Os ícones

87 símbolos, 16×16, traço único, `currentColor`. O sprite é injetado no seu documento por
`tuff-icones.js`.

```html
<svg class="tuff-ico"><use href="#ico-folder"></use></svg>
<button class="tuff-btn tuff-btn--icone" aria-label="Recarregar">
  <svg class="tuff-ico"><use href="#ico-refresh"></use></svg>
</button>
```

Tamanhos: `.tuff-ico` (16), `--sm` (14), `--lg` (20). A cor vem do texto ao redor — um ícone dentro
de um `.tuff-btn--perigo` fica vermelho sem você pedir.

```js
TuffIcones.nomes()      // a lista inteira
TuffIcones.tem('play')  // existe?
TuffIcones.svg('play')  // a marcação, como string
```

> ⚠ **Botão sem texto precisa de `aria-label`.** O nome dele não está em lugar nenhum da tela.
>
> ⚠ **Um `<use href>` que não resolve não lança — só não desenha.** No shell, um ícone inexistente
> ficou como um quadrado vazio em dois menus por meses, sem uma linha no console. Por isso
> `TuffIcones.svg()` avisa, e há um teste que recusa referência fantasma.

## As peças de mídia

Opt-in. Para quem tem player, visualizador de imagens ou grade de miniaturas.

```js
TuffMidia.player(raiz, video)   // liga trilha, timecode, volume e o chrome que some
TuffMidia.grade(el, { total, largura, altura, montar, aoSelecionar, aoAbrir })   // VIRTUALIZADA
TuffMidia.visor(el)             // zoom no ponteiro, arraste, duplo-clique alterna
TuffMidia.tempo(segundos)       // '12:04'
```

**A grade é o motivo de isto existir.** Uma pasta de fotos tem dezenas de milhares de arquivos, e um
`<img>` por arquivo trava a aba na abertura sem se recuperar — um defeito que você só encontra no
diretório de outra pessoa. Ela mantém no DOM só o que está visível: medido, 10 000 itens em menos de
200 elementos.

`montar(i, no)` preenche uma célula. ⚠ **Não escreva em `no.style` ali**: a grade já pôs `width`,
`height` e `transform` no nó antes de chamar, e sobrescrevê-los empilha todas as células na origem.
Ponha o seu conteúdo num elemento dentro do nó.

`aoAbrir(i)` dispara com **duplo-clique e com Enter** — os dois, e é intencional: uma grade em que
só o teclado abre é uma grade que o mouse não usa, e o contrário deixa quem navega por teclado sem
saída.

### O chrome e o transporte são peças diferentes

| | |
|---|---|
| `.tuff-chrome` | fica **sobre** o vídeo e **some sozinho** depois de 2,5 s sem ponteiro |
| `.tuff-transporte` | fica embaixo da janela inteira e **não some** |

O transporte é o que faz um app parecer um player de desktop em vez de uma página com vídeo dentro:
a pessoa vai à biblioteca e a música não parou, então a barra também não pode sumir. Ele tem **dois
andares**, e cada um responde uma pergunta:

```html
<div class="tuff-transporte">
  <div class="tuff-transporte-tempo">      <!-- onde estou no tempo -->
    <span class="tuff-tempo">12:04</span>
    <div class="tuff-trilha">…</div>
    <span class="tuff-tempo">41:37</span>
  </div>
  <div class="tuff-transporte-controles">  <!-- o que eu faço -->
    <div class="tuff-transporte-inicio">…o que está tocando…</div>
    <div class="tuff-transporte-meio">…anterior, tocar, parar, próximo…</div>
    <div class="tuff-transporte-fim">…repetir, ajustes, volume, tela cheia…</div>
  </div>
</div>
```

O meio é `1fr auto 1fr`, e não flex, para o aglomerado ficar no **centro óptico da janela** e
continuar lá com um nome de faixa curto ou comprido — com flex, o botão que a pessoa procura sem
olhar muda de lugar a cada vídeo.

**O chrome nunca some com o foco do teclado dentro dele**, nem com o vídeo pausado. Sumir ali deixa
quem navega por teclado com o foco num botão que saiu da tela.

## A cor que o usuário escolheu

É a única coisa da aparência do ambiente que muda em runtime, e ela **não atravessa sozinha**.
`tuff-tokens.css` já traz o padrão; para acompanhar a escolha da pessoa:

```js
const t = vssh.aparencia.tokens();          // os quatro tokens, ou `null`
if (t) for (const [k, v] of Object.entries(t)) {
  document.documentElement.style.setProperty(k, v);
}
vssh.aparencia.onChange((t) => { /* repintar */ });
```

`null` quer dizer *"não há a quem perguntar"* — aba solta, ou outra origem — e a leitura certa é
**não sobrescrever nada**: o CSS já trouxe o padrão certo. Ver [`api.md`](api.md#aparência).

## Sobrescrevendo

A biblioteca inteira mora em `@layer vssh`, e o seu CSS **não**. Regra fora de camada sempre vence
regra em camada, seja qual for a ordem no arquivo — então basta escrever:

```css
.tuff-btn { border-radius: 0; }   /* sem `!important`, e sem disputa de especificidade */
```

A hierarquia, do mais fraco para o mais forte:

```
padrão da biblioteca  <  escolha do app  <  escolha do ambiente
(@layer vssh)            (o seu CSS)        (inline, do vssh.aparencia)
```

Isso é deliberado: a folha injetada entra **depois** do seu CSS no `<head>`, e sem a camada ela
ganharia todo empate — a biblioteca viraria camisa de força.

## Fora do ambiente

Tudo funciona numa aba solta: a paleta é estática, a fonte viaja no pacote, e a única coisa que
depende do shell (a cor escolhida) cai no padrão. É a mesma régua do `vssh-app-shim`: **ausência não
é erro**.

## Escuro, e só

O Tuff é escuro. Não há modo claro, e o tema alternativo que existiu (`neon`) foi removido do
ambiente — prometer um modo que não existe seria pior que não prometer nada.
