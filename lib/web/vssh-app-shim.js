'use strict';

// vssh-app-shim — o lado do app na ponte com o shell VSSH.
//
// Dá ao app diálogo, notificação, seletor de arquivo e "abrir com" sem que ele construa nada
// disso: quem já tem essa UI é o desktop, e ela é DOM puro — nada aqui passa pelo Xpra, então o
// app se comporta igual num ambiente com ou sem ele.
//
// Como entra num app portado: pelo `injectScripts` do static-spa, sem tocar no fork.
//
//   createStaticSpa({ root, injectScripts: ['vssh-app-shim.js'] })
//
// Fora do desktop (dev standalone, `window.parent === window`) nada lança: cada função degrada
// para o equivalente do navegador. É o que permite desenvolver o app fora do VSSH.

(function () {
  const inDesktop = window.parent !== window;
  const pending = new Map();
  let seq = 0;
  let caps = null;

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.vsshApp !== true || msg.type !== 'result') return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    clearTimeout(entry.timer);
    msg.ok ? entry.resolve(msg.value) : entry.reject(new Error(msg.value || 'falhou'));
  });

  // Toda chamada que espera resposta tem timeout. Sem isso, um shell que não conhece o tipo (por
  // ser mais antigo que o app) deixaria a promise pendurada para sempre, e o app trava sem erro.
  function call(type, payload = {}, { timeout = 0 } = {}) {
    if (!inDesktop) return Promise.reject(new Error('fora do desktop VSSH'));
    const requestId = ++seq;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`sem resposta do shell para '${type}'`));
          }, timeout)
        : null;
      pending.set(requestId, { resolve, reject, timer });
      window.parent.postMessage({ vsshApp: true, type, requestId, ...payload }, location.origin);
    });
  }

  function post(type, payload = {}) {
    if (!inDesktop) return false;
    window.parent.postMessage({ vsshApp: true, type, ...payload }, location.origin);
    return true;
  }

  const vssh = {
    inDesktop,

    // O que este ambiente sabe fazer. `nativeApps: false` significa que não há X11 — "abrir com"
    // só terá vssh-apps, e não há programa Linux com UI para lançar.
    async capabilities() {
      if (caps) return caps;
      if (!inDesktop) return (caps = { nativeApps: false, x11Interop: false, host: 'none' });
      caps = await call('capabilities', {}, { timeout: 5000 }).catch(() => ({ host: 'unknown' }));
      return caps;
    },

    notify(message, opts = {}) {
      if (post('notify', { message, title: opts.title, level: opts.level, timeout: opts.timeout })) return;
      console.info(`[vssh] ${opts.title ? opts.title + ': ' : ''}${message}`);
    },

    dialog: {
      alert(message, title)   { return inDesktop ? call('dialog', { variant: 'alert', message, title }) : Promise.resolve(window.alert(message)); },
      error(message, title)   { return inDesktop ? call('dialog', { variant: 'error', message, title }) : Promise.resolve(window.alert(message)); },
      confirm(message, title) { return inDesktop ? call('dialog', { variant: 'confirm', message, title }) : Promise.resolve(window.confirm(message)); },
      prompt(message, value, title) {
        return inDesktop
          ? call('dialog', { variant: 'prompt', message, value, title })
          : Promise.resolve(window.prompt(message, value ?? ''));
      },
      password(message, title) { return inDesktop ? call('dialog', { variant: 'password', message, title }) : Promise.resolve(window.prompt(message)); },
    },

    // Seletores: o gerenciador de arquivos do desktop em picker mode, com grupos de filtro.
    // Devolvem o caminho absoluto escolhido, ou null se o usuário cancelou.
    //
    // Escolher aqui é o que concede permissão ao `vssh.fs` abaixo — mesmo modelo da File System
    // Access API. Sem passar por um seletor, o app não alcança arquivo nenhum do usuário.
    pickFile(opts = {})      { return inDesktop ? call('pick', { variant: 'open', ...opts }) : Promise.resolve(null); },
    pickSave(opts = {})      { return inDesktop ? call('pick', { variant: 'save', ...opts }) : Promise.resolve(null); },
    pickDirectory(opts = {}) { return inDesktop ? call('pick', { variant: 'directory', ...opts }) : Promise.resolve(null); },

    // Abre no visualizador certo do desktop, escolhido pela extensão.
    openFile(path)   { return post('open-file', { path }) || window.open('#', '_blank'); },
    openFolder(path) { return post('open-folder', { path }); },
    // Deixa o usuário escolher COM QUE abrir. Sem X11, a lista tem só vssh-apps.
    openWith(path)   { return call('open-with', { path }); },

    // Filesystem do usuário, restrito ao que foi escolhido num seletor.
    fs: {
      list(path)      { return call('fs', { op: 'list', path }); },
      stat(path)      { return call('fs', { op: 'stat', path }); },
      read(path)      { return call('fs', { op: 'read', path }); },
      async readBytes(path) {
        const { base64 } = await call('fs', { op: 'readBytes', path });
        const bin = atob(base64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      },
      write(path, content) { return call('fs', { op: 'write', path, content }); },
      // Bytes crus. Rota separada de propósito: `write` é text/*, e texto-encodar um binário o
      // corrompe em silêncio — é o pior modo de falhar, porque só aparece ao abrir o arquivo.
      writeBytes(path, bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let bin = '';
        // Em blocos: `String.fromCharCode(...u8)` estoura a pilha em arquivos grandes.
        for (let i = 0; i < u8.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        }
        return call('fs', { op: 'writeBytes', path, base64: btoa(bin) });
      },
      mkdir(path)          { return call('fs', { op: 'mkdir', path }); },
      delete(path)         { return call('fs', { op: 'delete', path }); },
    },

    // Abas no cabeçalho da janela (precisa de `"richChrome": true` no manifest).
    tabs: {
      update(tabs, activeTabId) { return post('tabs', { tabs, activeTabId }); },
      on(handler) {
        window.addEventListener('message', (e) => {
          if (e.origin !== location.origin || e.source !== window.parent) return;
          const m = e.data;
          if (!m || m.vsshApp !== true) return;
          if (['activate-tab', 'close-tab', 'new-tab', 'restore-tabs'].includes(m.type)) handler(m);
        });
      },
    },

    // "Abra assim" — ex.: o path de "Abrir Terminal Aqui", ou o arquivo que o usuário escolheu
    // abrir com este app (ver o campo `opens` do manifest).
    onOpenContext(handler) {
      window.addEventListener('message', (e) => {
        if (e.origin !== location.origin || e.source !== window.parent) return;
        const m = e.data;
        if (m && m.vsshApp === true && m.type === 'open-context') handler(m);
      });
    },
  };

  // Nota sobre o modo fora do desktop: os seletores devolvem `null` em vez de abrir um
  // `<input type=file>`. Um File do navegador não tem caminho no servidor, e devolver algo que
  // parece um caminho mas não resolve do outro lado é pior que devolver nada — o app trata `null`
  // como "cancelou", que é um caminho que ele já precisa ter.

  window.vssh = vssh;
})();
