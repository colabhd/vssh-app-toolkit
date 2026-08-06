'use strict';

// Ambiente de mentira para os shims de compatibilidade (`electron-shim`, `tauri-shim`).
//
// Estes dois arquivos são CONSUMIDORES do `window.vssh`, não produtores — quem fala com o desktop
// por `postMessage` é o `vssh-app-shim`, que tem harness próprio. O que se mede aqui é a
// TRADUÇÃO: uma chamada na superfície do Electron ou do Tauri entra, e a pergunta é qual método
// do `vssh` saiu, com quais argumentos, e o que voltou para o app.
//
// Por isso o `vssh` daqui grava tudo em vez de simular: um shim que chama `pickFile` onde deveria
// chamar `pickDirectory` está errado mesmo que o valor devolvido pareça certo.
//
// Fica no runner de `vm`, e não no de navegador, pela mesma regra que separa os dois:
// comportamento do nosso código é `vm`; leitura que a PLATAFORMA faz sobre o que devolvemos é
// navegador (ver o cabeçalho de `fsa-polyfill.browser.test.js`).

const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

/**
 * `deepStrictEqual` que sobrevive à fronteira do `vm`.
 *
 * Um `{}` criado DENTRO do contexto tem outro `Object.prototype`, e o `deepStrictEqual` compara
 * protótipos — então ele reprova com *"same structure but not reference-equal"* em objetos que são
 * idênticos em tudo que importa. Passar `Object` no sandbox não resolve: literais usam a intrínseca
 * do contexto, não a variável.
 *
 * `structuredClone` reconstrói o valor NESTE realm, e aí a comparação estrita volta a medir
 * estrutura em vez de proveniência. Fica no harness porque é ele quem cria a fronteira — deixar
 * cada teste redescobrir isso é garantir que um deles vá afrouxar a asserção em vez de traduzir.
 */
function igual(atual, esperado, mensagem) {
  assert.deepStrictEqual(structuredClone(atual), esperado, mensagem);
}

/**
 * Monta o ambiente e roda o shim dentro dele.
 *
 * @param {string} arquivo   nome do arquivo em `lib/web/` (ex.: 'electron-shim.js')
 * @param {object} opcoes
 *   - `semVssh`      : não instala `window.vssh` — exercita a guarda de carregamento
 *   - `inDesktop`    : default `true`
 *   - `respostas`    : sobrescreve o retorno de qualquer método do `vssh` falso
 *   - `title`        : `document.title` inicial
 *   - `meta`         : mapa `name → content` para `document.querySelector('meta[name=…]')`
 *   - `globais`      : entra no sandbox como está (para casos que precisam de mais plataforma)
 */
function carregar(arquivo, opcoes = {}) {
  const {
    semVssh = false, inDesktop = true, respostas = {},
    title = 'titulo inicial', meta = {}, globais = {}, antes = null,
  } = opcoes;

  /** Toda chamada que o shim fez no `vssh`, na ordem: `['pickFile', {title:'x'}]`. */
  const chamadas = [];
  const avisos = [];
  const janelasAbertas = [];
  const areaDeTransferencia = { texto: 'o que ja estava la' };

  // `resposta(nome, padrao)` deixa o teste dizer o que o desktop responderia. O default de cada
  // método é o caso feliz — um teste que não se importa não precisa declarar nada.
  const resposta = (nome, padrao) => (nome in respostas ? respostas[nome] : padrao);
  const grava = (nome, ...args) => { chamadas.push([nome, ...args]); };

  const vssh = {
    inDesktop,
    async capabilities() { grava('capabilities'); return resposta('capabilities', { nativeApps: true, host: 'xpra' }); },
    notify(message, opts) { grava('notify', message, opts); },

    dialog: {
      alert(m, t)    { grava('dialog.alert', m, t);    return Promise.resolve(resposta('dialog.alert', undefined)); },
      error(m, t)    { grava('dialog.error', m, t);    return Promise.resolve(resposta('dialog.error', undefined)); },
      confirm(m, t)  { grava('dialog.confirm', m, t);  return Promise.resolve(resposta('dialog.confirm', true)); },
      prompt(m, v, t){ grava('dialog.prompt', m, v, t);return Promise.resolve(resposta('dialog.prompt', 'texto')); },
      password(m, t) { grava('dialog.password', m, t); return Promise.resolve(resposta('dialog.password', 'senha')); },
    },

    pickFile(o)      { grava('pickFile', o);      return Promise.resolve(resposta('pickFile', '/casa/nota.md')); },
    pickSave(o)      { grava('pickSave', o);      return Promise.resolve(resposta('pickSave', '/casa/novo.md')); },
    pickDirectory(o) { grava('pickDirectory', o); return Promise.resolve(resposta('pickDirectory', '/casa/pasta')); },

    openFile(p)   { grava('openFile', p); },
    openFolder(p) { grava('openFolder', p); },
    openWith(p)   { grava('openWith', p); return Promise.resolve(resposta('openWith', null)); },

    fs: {
      list(p)          { grava('fs.list', p);   return Promise.resolve(resposta('fs.list', { items: [] })); },
      stat(p)          { grava('fs.stat', p);   return Promise.resolve(resposta('fs.stat', { size: 3, mtime: 1 })); },
      read(p)          { grava('fs.read', p);   return Promise.resolve(resposta('fs.read', 'conteudo')); },
      readBytes(p)     { grava('fs.readBytes', p); return Promise.resolve(resposta('fs.readBytes', new Uint8Array([1, 2, 3]))); },
      write(p, c)      { grava('fs.write', p, c);      return Promise.resolve(resposta('fs.write', { ok: true })); },
      writeBytes(p, b) { grava('fs.writeBytes', p, b); return Promise.resolve(resposta('fs.writeBytes', { ok: true })); },
      mkdir(p)         { grava('fs.mkdir', p);  return Promise.resolve(resposta('fs.mkdir', { ok: true })); },
      delete(p)        { grava('fs.delete', p); return Promise.resolve(resposta('fs.delete', { ok: true })); },
    },

    window: {
      close()    { grava('window.close'); },
      minimize() { grava('window.minimize'); },
      maximize() { grava('window.maximize'); },
      restore()  { grava('window.restore'); },
      focus()    { grava('window.focus'); },
    },
  };

  const win = {
    open: (url, alvo, feicoes) => { janelasAbertas.push({ url, alvo, feicoes }); return null; },
    matchMedia: (q) => ({ matches: q.includes('dark') ? !!resposta('temaEscuro', false) : false }),
  };
  if (!semVssh) win.vssh = vssh;

  const doc = {
    title,
    querySelector: (sel) => {
      const m = /^meta\[name="([^"]+)"\]$/.exec(sel);
      if (m) return m[1] in meta ? { content: meta[m[1]] } : null;
      return null;
    },
  };

  const sandbox = {
    window: win,
    document: doc,
    navigator: {
      clipboard: {
        readText:  () => { grava('clipboard.readText'); return Promise.resolve(areaDeTransferencia.texto); },
        writeText: (t) => { grava('clipboard.writeText', t); areaDeTransferencia.texto = t; return Promise.resolve(); },
      },
    },
    console: { log() {}, info() {}, error() {}, warn: (...a) => avisos.push(a.map(String).join(' ')) },
    // O `electron-shim` deriva a Notification de `EventTarget`; o Node tem os dois.
    EventTarget, Event, Promise, Object, Error, Array, String, Number, JSON, Uint8Array,
    setTimeout, clearTimeout,
    ...globais,
  };

  // `antes` roda com o ambiente montado e o shim ainda não carregado — é o único momento em que
  // dá para simular "o app já tinha instalado parte da API por conta própria".
  if (antes) antes(win, sandbox);

  const src = require('node:fs').readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
  vm.runInContext(src, vm.createContext(sandbox));

  return {
    win, doc, vssh, chamadas, avisos, janelasAbertas, areaDeTransferencia,
    /** Só os nomes, na ordem — para asserções de "chamou o método certo". */
    nomes: () => chamadas.map((c) => c[0]),
    /** Os argumentos da primeira chamada a `nome`, ou `undefined` se não houve. */
    args: (nome) => chamadas.find((c) => c[0] === nome)?.slice(1),
  };
}

module.exports = { carregar, igual };
