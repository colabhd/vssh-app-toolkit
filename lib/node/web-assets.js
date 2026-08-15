'use strict';

// Onde moram as libs que o NAVEGADOR carrega — o shim do `vssh`, o polyfill da FSA, os shims de
// Tauri/Electron.
//
// Por que isto precisa existir. As libs de `node/` são `require()`adas e o Node acha sozinho; as de
// `web/` chegam ao navegador por uma tag `<script>`, e alguém tem de SERVI-LAS sob a raiz que o
// app publica. Enquanto as libs eram copiadas para dentro do repo do app, a resposta era "estão em
// `frontend/vendor/vssh/`" — e o preço era a cópia, com um script próprio para fazê-la e um
// marcador para dizer a idade dela.
//
// Instaladas por npm, elas moram no `node_modules`, que fica FORA da raiz da SPA. A saída não é
// copiar de novo: é montar. `createStaticSpa({ mounts: { '/_vssh/': WEB_DIR } })` serve este
// diretório sob um prefixo, com o mesmo confinamento e o mesmo carimbo de versão que o bundle tem.
//
//     const { WEB_DIR, SHIMS, ESTILOS } = require('vssh-app-toolkit/web');
//     createStaticSpa({
//       root: BUNDLE,
//       mounts: { '/_vssh/': WEB_DIR },
//       injectScripts: SHIMS.map((s) => `_vssh/${s}`),
//       injectStyles: ESTILOS.map((f) => `_vssh/${f}`),
//     });
//
// A ORDEM de `SHIMS` importa e é por isso que ela é dada aqui, e não deixada para cada app
// relembrar: o `fsa-polyfill` decide o que instalar olhando o `vssh` já presente, e um app que
// carregue os dois na ordem inversa fica sem `showOpenFilePicker` — sem erro nenhum, só sem a
// função.

const path = require('node:path');

/** Diretório das libs de navegador deste pacote. */
const WEB_DIR = path.join(__dirname, '..', 'web');

/** Os dois que quase todo app quer, na ordem em que têm de ser carregados. */
const SHIMS = ['vssh-app-shim.js', 'fsa-polyfill.js'];

// ─── A biblioteca de UI ──────────────────────────────────────────────────────
//
// ⚠ **`ESTILOS` é uma lista SEPARADA, e isso é a decisão, não o layout.** Todo app escreve
// `injectScripts: SHIMS.map(...)` sem pensar — é o idioma que o README, o SKILL.md e os dois
// templates ensinam. Uma folha de estilo acrescentada a `SHIMS` entraria na página do `recoll` (que
// tem tema claro próprio), do `logseq` (que traz o CSS dele inteiro) e do `scramjet-wisp` (que serve
// conteúdo de TERCEIROS) no próximo `npm i` — sem ninguém ter pedido, e por uma lista cujo nome fala
// de outra coisa. Adotar a aparência do ambiente é ato explícito do backend do app.
//
// `tests/lib-version.test.js` guarda essa fronteira nos dois sentidos.
//
// A ordem também importa aqui: os tokens declaram as variáveis que o resto lê. Invertida, a primeira
// pintura sai com as cores do navegador — e o defeito seria intermitente, porque depende de qual
// folha o cache entrega primeiro.
const ESTILOS = ['tuff/tuff-tokens.css', 'tuff/tuff-base.css', 'tuff/tuff.css'];

// Os ícones. Script, e não folha: o sprite precisa ser INJETADO no documento do app, porque um
// `<use href="#ico-…">` só resolve dentro do próprio documento — o sprite do shell mora no
// `index.html` dele e não atravessa o iframe.
// `tuff.js` é o comportamento do núcleo — hoje, a gaveta de navegação. A ordem importa: os ícones
// primeiro, porque a gaveta costuma ter um por item, e um `<use>` que resolve depois da primeira
// pintura pisca.
const SCRIPTS = ['tuff/tuff-icones.js', 'tuff/tuff.js'];

// As peças de mídia — trilha, volume, chrome que some, grade virtualizada, visor com zoom.
//
// Listas próprias porque a maioria dos apps não tem mídia, e nesse caso isto é download e parse
// pagos por nada. Quem tem, acrescenta as duas ao `injectStyles` e ao `injectScripts`.
const ESTILOS_MIDIA = ['tuff/tuff-midia.css'];
const SCRIPTS_MIDIA = ['tuff/tuff-midia.js'];

module.exports = { WEB_DIR, SHIMS, ESTILOS, SCRIPTS, ESTILOS_MIDIA, SCRIPTS_MIDIA };
