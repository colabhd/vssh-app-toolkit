'use strict';

// A superfície REAL do `vssh`, enumerada em runtime.
//
// Isto morava dentro de `tipos.test.js` e saiu de lá quando um segundo teste passou a precisar da
// mesma resposta (`tests/galeria-cobertura.test.js`, que confere se cada membro aparece em alguma
// peça da galeria). Duas cópias do mesmo harness divergem — e a que divergisse ficaria VERDE sobre
// uma superfície que não existe mais, que é o modo de falha exato que os dois testes existem para
// impedir.
//
// Por que em runtime, e não por regex do fonte: o shim monta a superfície com literais de objeto,
// atribuições condicionais e `Object.defineProperty`. Ler isso com expressão regular acerta hoje e
// erra no primeiro membro escrito de outro jeito — sem que nada acuse, porque o teste continuaria
// passando com uma lista menor.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..');

/**
 * Roda o shim num ambiente de mentira e devolve o `vssh` que ele publicou.
 *
 * `parent !== window` é o que faz o shim se considerar dentro do desktop — e é lá que a superfície
 * é completa. Enumerar fora do desktop mediria o modo degradado.
 */
function _carregar(win) {
  const sandbox = {
    window: win,
    document: { title: 't', head: {}, querySelector: () => null, addEventListener() {} },
    location: { pathname: '/srv1/proxy/app/x/', origin: 'https://p', search: '' },
    navigator: { clipboard: { read() {}, write() {} } },
    console: { log() {}, warn() {}, info() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0,
    Map, Set, WeakMap, btoa, atob, Promise, Object, Error,
  };
  vm.runInContext(fs.readFileSync(path.join(WEB, 'vssh-app-shim.js'), 'utf8'), vm.createContext(sandbox));
  return win.vssh;
}

/**
 * A árvore da superfície: `{ notify: null, fs: ['copy', 'delete', …], … }` — `null` para membro
 * folha, lista de chaves para objeto aninhado.
 */
function superficieReal() {
  const win = { addEventListener() {}, removeEventListener() {}, parent: { postMessage() {} },
                matchMedia: () => ({ matches: false }) };
  const vssh = _carregar(win);
  const arvore = {};
  for (const chave of Object.keys(vssh)) {
    const v = vssh[chave];
    arvore[chave] = (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort() : null;
  }
  return arvore;
}

/**
 * A mesma superfície achatada em caminhos, com o que cada um É:
 * `[{ caminho: 'fs.copy', ehFuncao: true }, { caminho: 'inDesktop', ehFuncao: false }, …]`.
 *
 * É a forma que serve a quem PROCURA usos: o que se escreve num app é `vssh.fs.copy(` para um
 * método e `vssh.inDesktop` para um valor. Exigir o parêntese de um valor acusaria uso correto;
 * não exigi-lo de um método aprovaria uma menção em comentário.
 *
 * O tipo é lido do objeto vivo, e não adivinhado pelo nome — `ARQUIVOS_MIME` é MAIÚSCULA e é
 * valor, `capabilities` é minúscula e é função.
 */
function caminhosDaSuperficie() {
  const win = { addEventListener() {}, removeEventListener() {}, parent: { postMessage() {} },
                matchMedia: () => ({ matches: false }) };
  const vssh = _carregar(win);
  const saida = [];
  for (const [chave, valor] of Object.entries(vssh)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const filho of Object.keys(valor)) {
        saida.push({ caminho: `${chave}.${filho}`, ehFuncao: typeof valor[filho] === 'function' });
      }
    } else {
      saida.push({ caminho: chave, ehFuncao: typeof valor === 'function' });
    }
  }
  return saida.sort((a, b) => a.caminho.localeCompare(b.caminho));
}

module.exports = { superficieReal, caminhosDaSuperficie };
