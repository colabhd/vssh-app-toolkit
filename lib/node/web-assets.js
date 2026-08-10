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
//     const { WEB_DIR, SHIMS } = require('vssh-app-toolkit/web');
//     createStaticSpa({
//       root: BUNDLE,
//       mounts: { '/_vssh/': WEB_DIR },
//       injectScripts: SHIMS.map((s) => `_vssh/${s}`),
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

module.exports = { WEB_DIR, SHIMS };
