# Onda 0c — Colapso de variantes

> **Estado:** ✅ concluída · **Atualizado:** 2026-08-02 · **Repo:** `vssh-sso`
> **Independente das Ondas 1 e 2**, mas **pré-requisito da [2.6](02-apis-de-shell.md) e da dívida
> de `design-tokens.css`** registrada na [Onda 0b](00-limpeza-de-terreno.md).
>
> **Resultado: −1850 / +323 linhas em 40 arquivos, mais 6 arquivos deletados.** Nenhum `UI_MODE`
> e nenhum `data-theme` bifurcando código em lugar nenhum do shell. Ver
> [o que ficou de fora](#o-que-ficou-de-fora-e-por-quê) no fim.

O shell tem duas variantes que ninguém usa: o tema **`neon`** e o modo de UI **`dock`**. O custo
delas não é o código parado — é que **toda adição de UI precisa ser pensada duas vezes**. É uma
indecisão passada cobrando juros em cada feature nova, e esta onda é o estalo que a resolve.

## A medida do gargalo

Acrescentar um botão à barra do sistema custa hoje **cinco decisões**:

| # | Onde | O quê |
|---|---|---|
| 1 | `index.html:272-312` **e** `:325-331` | markup em dois lugares — dock e taskbar |
| 2 | `TuffTaskbar.js:5-20` | nome do ícone no mapa Material → sprite |
| 3 | 6 implementações diferentes | ancorar o painel no botão (ver [diagnostico](diagnostico.md)) |
| 4 | `index.html:1662-1666` | `CAPABILITY_WIDGETS`, com **dois** ids por capability |
| 5 | `index.html:2037-2038` | delegação de clique do taskbar para o dock |

Depois desta onda, e do helper de ancoragem: **uma**.

E o argumento que fecha a discussão sobre "vale a pena?": **9 dos 24 arquivos CSS não têm uma linha
de neon** — incluindo `tray.css`, `tiling.css` e `launchpad.css`, os componentes mais recentes.
Quem escreve UI nova já parou de manter a variante. Removê-la **formaliza um estado de fato**.

---

## ⚠ Por que isto não é "apagar CSS"

### Neon não é uma folha paralela — é metade do contrato de tokens

`css/design-tokens.css` declara os 72 `--ds-*` em **exatamente dois** blocos:
`[data-theme="tuff"]` e `[data-theme="neon"]`. O `:root` declara tokens brutos, **nenhum `--ds-*`**.
São **955 usos**, 598 deles **sem fallback**.

E `index.html:167` copia `cfg.theme` do localStorage para o `<html>` **sem validar contra lista
nenhuma**. Então `data-theme="neon"` sem bloco neon não dá "cor errada": dá **shell ilegível**,
durante os 92 scripts síncronos do boot — e **permanente**, não flash, se `_applyTheme` sair junto.

> **O conserto já está escrito neste ecossistema.** `public/css/design-tokens.css:145` é
> `:root, html[data-theme="tuff"] {`, com comentário explicando este exato caso. O portal resolveu
> e o shell não. É copiar de casa, não inventar.

### O valor tóxico sobrevive fora do cliente

`src/routes/settings.ts:98` valida **só o nome da chave**, nunca o valor — e `:103` faz o valor
salvo vencer o default, com cache Redis de 1 h. Pior: o portal tem um rádio "Neon" **próprio**
(`public/index.html:1358`) escrevendo na mesma chave.

**Limpar só `vssh-client/` é reversível por um clique do usuário.** Esta onda é deploy coordenado de
três pontas — cliente, portal e backend — ou não é remoção.

### Os dois pontos de maior raio não estavam em nenhum inventário

- `VsshWindow.js:24-29` — `_wbtnIcon()`, na classe **base de toda janela do shell**. Decide entre
  `<svg><use>` e `<span class="mi">` para fixar/minimizar/maximizar/fechar. Mexer sem cuidado tira o
  titlebar de tudo.
- `VsshDialogs.js:219-236` — `_buildIcon`, os 8 tipos de diálogo, incluindo os que atendem prompts
  vindos do servidor.

Nenhum dos dois aparecia nas listas de "onde o neon está". Foram achados relendo com o critério
certo: *o que a coisa faz*, não que ela está lá.

### O default do cliente e o do backend discordam

`index.html:162` assume `'dock'`; `src/routes/settings.ts:28` assume `'taskbar'`. Quem semeia o
localStorage é o **portal**. Então numa aba anônima, num link salvo, ou com localStorage limpo, o
primeiro load do perfil sem Xpra cai em `mode-dock` — onde `#taskbar` é `display:none`
(`taskbar.css:3`) e o `#float_menu` só aparece pelo `init_float_menu()`, chamado dentro de
`client.on_connect`, **que nunca dispara sem Xpra**.

**É intermitente, não permanente:** o `SettingsWindow` busca `/api/user/settings` por caminho
absoluto na mesma origem, e o segundo load se corrige. Mas o primeiro é uma tela sem barra nenhuma,
no perfil que a roadmap inteira persegue.

---

## Os passos, na ordem que a investigação mediu

### Passo 0 — a rede de proteção, antes de apagar uma linha

- **`:root` de fallback** no `design-tokens.css` do shell, copiando o idioma do portal;
- **`try/catch` na IIFE de boot** (`index.html:160-172`). Ela não tem um hoje: um `JSON.parse` de
  localStorage corrompido **já mata a IIFE inteira**, levando junto as classes `mode-*`,
  `taskbar-pos-*` e o `window.UI_MODE`. É modo de falha que existe agora, independente desta onda;
- **coerção de VALOR** no `settings.ts`, para as **20** chaves de `ALLOWED_KEYS` — não só `theme`.
  `uiMode`, `taskbarPosition` e `browserEngine` têm o mesmo buraco, e o valor vira classe CSS.

### Passo 1 — coerção de `uiMode`, ainda sem apagar nada

Cliente, portal e backend passam a coagir para `'taskbar'`.

**Sozinho, sem remover uma linha, isto já elimina a tela sem chrome do standalone** — é a mudança de
maior retorno por linha do levantamento inteiro. E prepara a remoção sem exigir migração de banco no
dia do deploy.

### Passo 2 — neon sai

Achatamento dos tokens, `_wbtnIcon`/`_buildIcon`, as **11** leituras de `dataset.theme` em 9
arquivos, e o rádio do portal. Dois cuidados que precisam estar nomeados:

- **`taskbar.css:374-375` não sai.** O `content: none` de lá é o **único** freio contra o glifo
  Material aparecer por cima do SVG injetado — `css/icon.css:7` (`*[data-icon]:before`) é global e
  sem gate de tema. Sintoma se sair junto: cada botão da taskbar mostra SVG **e** glifo, ou dobra de
  largura.
- **`<symbol id="ico-minus">` entra na mesma PR.** `ContextMenu.js:24-25` mapeia `text_decrease` para
  ele, e ele **não existe** entre os 43 símbolos do sprite — hoje, no tema padrão, "Diminuir Fonte"
  já renderiza um SVG vazio em dois menus. É o único ponto onde o caminho neon era estritamente
  melhor; sem o símbolo, a remoção transforma um bug visível num bug permanente.

### Passo 3 — dock sai

Nesta ordem, e a ordem importa:

| # | O quê | Por que aqui |
|---|---|---|
| 1 | Remover **chamadas e JS** que dependem do modo | O TypeError de `VsshWindow.js:596` atinge **qualquer** janela nos dois perfis |
| 2 | Editar os **5 pontos de `Client.js`** e manter as constantes `float_menu_*` | Sem isso, ReferenceError em qualquer bandeja X11 **em modo taskbar** |
| 3 | Só então remover o **markup** `index.html:272-317` | Nunca antes do passo 2 |
| 4 | Arquivos inteiros: `js/Menu.js`, `css/menu.css`, o grosso do `menu-skin.css`, split de `MenuCustom.js` → `js/Taskbar.js` | Deleção pura por último |

> **Sim, isto edita `Client.js`, que é upstream MPL — e já há precedente nosso lá.** `git blame`
> mostra **4 ramos de `UI_MODE` escritos por nós** naquele arquivo. A regra de `vssh-host.js:9-13`
> está apontando para o alvo errado: `MenuCustom.js` tem **245 de 379 linhas nossas** (é onde mora a
> taskbar) e não é protegido, enquanto o `Client.js` protegido já divergiu. Corrigir a regra faz
> parte desta onda.

**Nunca deletar junto:**
- **`xdg_image` (`Client.js:3167-3180`)** — tem 3 chamadores de **taskbar** (`Launchpad.js:194`,
  `StartMenu.js:213`, `:290`). É a única função que decodifica `iconData`; apagar quebra os ícones
  do Launchpad e do Start Menu, que são os **substitutos** do dock;
- **`slick.js` / `css/slick.css` / `#window_preview`** — o Alt+Tab é inicializado **99 linhas antes**
  do ramo standalone, então está ligado nos dois perfis. Não é código do dock;
- **`taskbar.css:374-375`**, pelo motivo do passo 2;
- **`StartMenu.js:223-227`** e a regra `.sm-sc-icon-mat` saem **juntas ou nenhuma** — hoje o ramo é
  inalcançável só por acidente de dados (as 8 entradas têm ícone tuff). O primeiro atalho novo
  declarado só com `matIcon` nasceria invisível.

### Decisão registrada — `settings-window.css` NÃO é achatado nesta onda

É a parte mais cara e arriscada: 24 linhas de seletor presas a `.sw-content--tuff` mais 4 blocos sem
gate de tema, num arquivo de 1523 linhas onde **o diff não denuncia** — a regressão é espaçamento e
tamanho de ícone sutilmente errados na janela mais usada.

E o Settings vai ser **reescrito do zero** na [2.6](02-apis-de-shell.md). Então o 0c remove só o
**JS** (≈280 das 1700 linhas do `SettingsWindow.js` são neon+dock) e passa a emitir as classes
`--tuff` **incondicionalmente** até lá. Não cria dívida: a classe passa a estar sempre presente, o
override sempre vale.

É a única exceção que esta onda abre, e ela está aqui para não ser reaberta como esquecimento.

---

## O que mais entra, porque é aqui que cabe

**Três consertos de uma linha cada, que o levantamento achou de lambuja:**

- **guarda de perfil em `_do_migrate`** (`Client.js:2695-2718`) — ele chama `this.connect()` sem
  consultar `VsshHost.xpraDisabled()`, e o servidor faz broadcast de `migrate` para **todos**. Hoje,
  **todo drain de pod põe o shell headless em loop de reconexão Xpra**, com overlay de desconexão.
  Bug em produção, no perfil que a roadmap inteira serve.
  *(Antes de mexer: **não determinado** se o `remove_windows()`/`clear_timers()` que roda logo antes
  derruba janelas do shell.)*
- **guarda de `_minimized` em `_syncProxy`** (`VsshWindow.js:799-813`) — `focus()` itera **todas** as
  janelas, inclusive minimizadas. Corta a maior parte dos reflows sem mudar comportamento, nos dois
  perfis;
- **vazamento do Alt+Tab** — `toggle_window_preview` registra 4 listeners jQuery **antes** do early
  return; no standalone a lista está sempre vazia, então são 4 registros por pressionada, nunca
  removidos. Contornável de fora do `Client.js`.

**Deleções puras, risco zero:**

- `js/lib/aurora/{aac,flac,mp3}.js` — **401.838 B servidos e nunca referenciados**;
- os 3 overlays órfãos do upstream (`#about`, `#sessioninfo`, `#bugreport`) — zero chamadores, e o
  `#about` ainda se apresenta como *"Xpra HTML5 Client / Version 19"*. Junto vai o "Gerar Relatório",
  que chama `new JSZip()` com JSZip fora do bundle;
- `design-system.html` — 1854 linhas servidas publicamente, zero referências, e **já divergiu** do
  `design-tokens.css` real;
- `css/client.css:14` referencia `../background.jpg`, que não existe → 404 por carga.

**Não apagar nesta onda:** `qt/kvantum/VsshNeon/`. Apagar a referência em `SettingsWindow.js:667` é
reversível; o diretório não, e **não foi determinado** se algum provisionamento fora deste
repositório copia `qt/kvantum/`. Sintoma se errarmos: app Qt nativo quebrado num servidor, semanas
depois.

---

## Riscos, com o sintoma que cada um produz

| Risco | Como aparece |
|---|---|
| `index.html:167` não corrigido no mesmo commit | Fundo branco, texto sem estilo, taskbar invisível durante todo o boot — e **permanente** se `_applyTheme` sair junto |
| Valor morto no banco | A página carrega bonita e **quebra alguns ms depois**, quando o `fetch` chega. É o pior de diagnosticar |
| Rádio do portal esquecido | O bug volta com um clique, e fica **irreprodutível** para quem investigar só `vssh-client/` |
| `uiMode:'dock'` salvo, CSS já removido | Não é tela vazia: é a taskbar renderizando o markup estático **sem** as partes montadas por JS — **barra parcialmente morta** |
| Markup do dock removido antes do `Client.js` | `process_xdg_menu` lança, `_route_packet` não tem `try/catch` → **a tela de carregamento nunca sai** |
| `tests/unit/tiling-geometry.test.js:17-18` | Usa `UI_MODE:'dock'` para exercitar o caso "sem barra descontada". Removido o modo, ele passa a exercitar um estado impossível: **precisa ser reescrito, não ajustado** |

---

## O que a execução ensinou

**A remoção expôs três bugs que ninguém teria achado procurando.** Não estavam na lista de riscos:

1. **`remove_windows` limpava a lista errada.** Ele chamava só `removeWindowListItem` — a lista do
   *dock*. Enquanto o dock existia, o vazamento ficava escondido; com ele fora viraria no-op, e os
   botões da **taskbar** vazariam a cada reconexão, porque `remove_windows` roda no `migrate`. O
   upstream já chamava o par certo no `_process_lost_window`; aqui chamava metade.
2. **`float_menu_item_size` era global do `index.html`** e o `Client.js` o usa como lado do canvas
   de um ícone de bandeja X11. Apagar o markup do dock levaria o global junto — `ReferenceError` no
   primeiro ícone de bandeja, só no perfil Xpra. Virou `TRAY_ICON_SIZE`, dentro do `Client.js`.
3. **`process_xdg_menu` montava um menu que ninguém lia.** Ele construía `<li>` por categoria dentro
   do `#startmenu` do dock — e os consumidores reais, `StartMenu.populate()` e
   `Launchpad.populate()`, sempre leram `client.xdg_menu` **direto do objeto**. Eram 82 linhas
   alimentando um DOM que só o dock via.

**E a ordem do plano provou-se, mas por um motivo diferente do previsto.** O plano mandava mover os
handlers antes de apagar o markup — e a razão não era estética: `#clipboard_button` e
`#sound_button` **eram os handlers reais**, com a taskbar só disparando `.trigger('click')` neles.
Apagar o markup primeiro mataria clipboard e áudio no perfil Xpra sem uma linha no console.

## O que ficou de fora, e por quê

- **`settings-window.css` não foi achatado** — decisão registrada acima, e mantida: as classes
  `--tuff` passaram a ser emitidas incondicionalmente até a [2.6](02-apis-de-shell.md) reescrever a
  janela.
- **O split `MenuCustom.js` → `js/Taskbar.js` não foi feito.** O arquivo já é a taskbar (o bloco do
  dock saiu dele), mas o rename é churn puro num arquivo de 240 linhas, e a regra de
  `vssh-host.js:9-13` que ele deveria corrigir continua apontando para o alvo errado. Fica para
  quando alguém mexer ali de propósito.
- **`qt/kvantum/VsshNeon/` continua no repositório**, pelo motivo já escrito: apagar a referência é
  reversível, apagar o diretório não, e **não foi determinado** se algum provisionamento fora deste
  repositório o copia.
- **Duas classes ficaram sem regra CSS** (`tb-icon-tuff`, `sb-icon-tuff`) e isso é o resultado
  certo: as únicas regras delas eram `display:none` **dentro do bloco neon**, ou seja, existiam só
  para escondê-las no outro tema. Sem tema, o elemento é visível por padrão. Outras 4 classes órfãs
  encontradas na varredura **já eram órfãs antes** desta onda.

## Como verificar

Não há teste automatizado que prove "a UI continua bonita", e fingir que há seria pior que assumir.
O roteiro:

1. **`tsc`, `eslint` e as duas suítes verdes** — com `tiling-geometry.test.js` **reescrito**, não
   remendado;
2. **Um teste novo que cruza os `#ico-*` referenciados no JS contra os `<symbol id>` definidos** — é
   o que teria pego o `ico-minus` antes de virar bug de meses;
3. **Manual, nos dois perfis:** taskbar completa, botões de janela com ícone, diálogos, menu de
   contexto, Start Menu, Launchpad, bandeja, e as quatro posições de taskbar;
4. **Manual, o caso que motivou o passo 1:** abrir `/proxy/vssh-desktop/` numa **aba anônima**
   (localStorage vazio, portal nunca carregado). Antes: tela sem barra. Depois: taskbar;
5. **Manual, o caso do valor salvo:** com `theme:'neon'` e `uiMode:'dock'` gravados no banco, abrir
   o desktop. Tem de nascer tuff/taskbar, e o valor tem de ser coagido também no portal.
