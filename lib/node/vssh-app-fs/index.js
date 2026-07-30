'use strict';

// vssh-app-fs — filesystem privado de um vssh-app, exposto ao frontend por HTTP.
//
// Ver README.md para o contrato de wire e o modelo de segurança. A lib não lê nenhuma variável de
// ambiente e não tem dependência npm: quem traduz o ambiente VSSH em config é o backend do app.
//
// Quando usar esta lib e quando NÃO usar: ela serve o caso "store privado do app" — uma raiz
// confinada, com token próprio, funcionando inclusive fora do desktop. Para dar ao app acesso a
// arquivos do usuário (a home, com o picker do desktop e o modelo de permissão da File System
// Access API), o caminho é o `fsa-polyfill` de `lib/web/`, que fala com o `/api/fs/*` do portal —
// sem exigir que o app rode filesystem nenhum.

const ops = require('./ops');
const http = require('./http');
const paths = require('./paths');

module.exports = {
  createAppFs: ops.createAppFs,
  createFsHandler: http.createFsHandler,
  contentTypeFor: http.contentTypeFor,
  // Comparação de token resistente a timing. Exportada porque o gate da lib já usava isto
  // enquanto a cola do app comparava com `!==` comum — lib rigorosa não adianta se quem a monta
  // não for.
  tokenMatches: http.tokenMatches,
  FsError: paths.FsError,
  DEFAULT_CONTENT_EXTENSIONS: ops.DEFAULT_CONTENT_EXTENSIONS,
  DEFAULT_IGNORE: ops.DEFAULT_IGNORE,
  DEFAULT_RECYCLE_DIR: ops.DEFAULT_RECYCLE_DIR,
  DEFAULT_MAX_CONTENT_BYTES: ops.DEFAULT_MAX_CONTENT_BYTES,
};
