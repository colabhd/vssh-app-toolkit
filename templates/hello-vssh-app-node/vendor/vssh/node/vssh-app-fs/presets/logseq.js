'use strict';

// Preset do Logseq — política de UM app, mantida fora da lib de propósito.
//
// Estes valores não são "os defaults certos": são as regras que o Logseq usa, derivadas de
// `deps/common/src/logseq/common/graph.cljs` (`allowed-formats` e `ignored-path?`). Ficaram como
// default da lib enquanto ela morava dentro do port do Logseq, e a primeira coisa que a promoção
// para o toolkit fez foi tirá-los de lá: um segundo app não deveria herdar a lista de extensões
// nem o `logseq/bak` de um primeiro.
//
// Uso:
//   const { createAppFs } = require('vssh-app-fs');
//   const { LOGSEQ_PRESET } = require('vssh-app-fs/presets/logseq');
//   const fs = createAppFs({ root: graphDir, ...LOGSEQ_PRESET });

const LOGSEQ_CONTENT_EXTENSIONS = [
  'org', 'markdown', 'md', 'edn', 'json', 'js', 'css', 'excalidraw', 'tldr',
];

const LOGSEQ_IGNORE = {
  prefixes: ['logseq/.recycle', 'logseq/bak', 'logseq/version-files'],
  exact: ['logseq/graphs-txid.edn', 'logseq/pages-metadata.edn'],
  dirNames: ['node_modules'],
  suffixes: ['.DS_Store'],
  hidden: true,
};

const LOGSEQ_RECYCLE_DIR = 'logseq/.recycle';

const LOGSEQ_PRESET = {
  contentExtensions: LOGSEQ_CONTENT_EXTENSIONS,
  ignore: LOGSEQ_IGNORE,
  recycleDir: LOGSEQ_RECYCLE_DIR,
};

module.exports = {
  LOGSEQ_PRESET,
  LOGSEQ_CONTENT_EXTENSIONS,
  LOGSEQ_IGNORE,
  LOGSEQ_RECYCLE_DIR,
};
