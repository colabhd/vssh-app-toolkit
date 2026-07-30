'use strict';

// electron-shim — a superfície PADRÃO do Electron sobre o shell VSSH.
//
// Escopo, e por que ele é este: o caro de portar um app Electron nunca foi o transporte do IPC
// (~150 linhas sobre HTTP) — são os handlers do outro lado, escritos sob medida por aquele app.
// Uma camada de `ipcRenderer` genérica entrega o cano e ZERO dos handlers. Então este shim cobre
// o que é padrão do Electron (dialog, shell, clipboard, Notification, controles de janela) e
// recusa, com mensagem clara, o que é bespoke.
//
// O que sobra é o trabalho real do port: aquilo vira o backend do vssh-app. Ver docs/porting.md
// para medir isso em minutos num app concreto.
//
// Requer `vssh-app-shim.js`. Para acesso a arquivos, carregue também `fsa-polyfill.js`.

(function () {
  if (!window.vssh) {
    console.warn('[electron-shim] vssh-app-shim.js precisa ser carregado antes.');
    return;
  }

  function bespoke(what, hint) {
    return () => {
      throw new Error(
        `[electron-shim] ${what} não tem equivalente genérico no VSSH. ` +
        (hint || 'Essa lógica é específica do seu app: mova-a para o backend do vssh-app.')
      );
    };
  }

  // ── dialog ────────────────────────────────────────────────────────────────
  // O Electron devolve { canceled, filePaths }; mantemos essa forma para o app não precisar de if.
  const dialog = {
    async showOpenDialog(opts = {}) {
      const o = opts.properties ? opts : (arguments[1] || opts);
      const wantsDir = Array.isArray(o.properties) && o.properties.includes('openDirectory');
      const p = wantsDir
        ? await window.vssh.pickDirectory({ title: o.title, dir: o.defaultPath })
        : await window.vssh.pickFile({ title: o.title, dir: o.defaultPath });
      return { canceled: !p, filePaths: p ? [p] : [] };
    },
    async showSaveDialog(opts = {}) {
      const p = await window.vssh.pickSave({ title: opts.title, name: opts.defaultPath });
      return { canceled: !p, filePath: p || undefined };
    },
    async showMessageBox(opts = {}) {
      const o = opts.message ? opts : (arguments[1] || opts);
      const hasCancel = Array.isArray(o.buttons) && o.buttons.length > 1;
      if (!hasCancel) {
        await window.vssh.dialog.alert(o.message || '', o.title);
        return { response: 0, checkboxChecked: false };
      }
      const yes = await window.vssh.dialog.confirm(o.message || '', o.title);
      return { response: yes ? 0 : 1, checkboxChecked: false };
    },
    showErrorBox(title, content) { window.vssh.dialog.error(content || '', title); },
  };

  // ── shell ─────────────────────────────────────────────────────────────────
  const shell = {
    openExternal(url) { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },
    openPath(p)       { window.vssh.openFile(p); return Promise.resolve(''); },
    showItemInFolder(p) {
      // Sem "revelar o item": abrimos a pasta que o contém, que é o que o usuário quer ver.
      const dir = String(p).replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      window.vssh.openFolder(dir);
    },
    beep() {},
    trashItem: bespoke('shell.trashItem'),
  };

  // ── clipboard ─────────────────────────────────────────────────────────────
  // Síncrono no Electron, assíncrono no navegador. `readText()` devolve uma Promise aqui — é a
  // única incompatibilidade de assinatura que este shim não consegue esconder, e é melhor
  // documentá-la que fingir sincronia com um valor velho em cache.
  const clipboard = {
    readText:  () => navigator.clipboard.readText(),
    writeText: (t) => navigator.clipboard.writeText(String(t)),
    readImage:  bespoke('clipboard.readImage'),
    writeImage: bespoke('clipboard.writeImage'),
  };

  // ── ipcRenderer ───────────────────────────────────────────────────────────
  // Existe para dar um ERRO ÚTIL, não para funcionar: o app que chega aqui está pedindo um handler
  // que só existia no processo main dele. A mensagem nomeia o canal, que é exatamente o que se
  // precisa saber para decidir o que vai para o backend do vssh-app.
  const ipcRenderer = {
    invoke(channel) {
      return Promise.reject(new Error(
        `[electron-shim] ipcRenderer.invoke('${channel}') não tem destino: ` +
        'esse handler vivia no processo main do Electron. Implemente-o no backend do seu ' +
        "vssh-app e troque a chamada por fetch('api/...'). Ver docs/porting.md."
      ));
    },
    send(channel) {
      console.warn(`[electron-shim] ipcRenderer.send('${channel}') ignorado (sem processo main).`);
    },
    on() {}, once() {}, removeListener() {}, removeAllListeners() {},
    sendSync: bespoke('ipcRenderer.sendSync'),
  };

  // ── app / BrowserWindow ───────────────────────────────────────────────────
  const app = {
    getName:    () => document.title || 'vssh-app',
    getVersion: () => '0.0.0',
    getPath: bespoke(
      'app.getPath()',
      'Peça a pasta ao usuário (showDirectoryPicker) ou use $VSSH_APP_DATA_DIR pelo seu backend.'
    ),
    quit()  { window.close(); },
    exit()  { window.close(); },
  };

  // A janela é do shell, não do app. O pouco que faz sentido daqui é o título.
  const currentWindow = {
    setTitle(t) { document.title = String(t); },
    getTitle()  { return document.title; },
    close()     { window.close(); },
    minimize() {}, maximize() {}, unmaximize() {}, focus() {}, show() {}, hide() {},
    isMaximized: () => false,
    on() {}, once() {}, removeListener() {},
  };

  const electron = {
    dialog, shell, clipboard, ipcRenderer, app,
    remote: { app, dialog, getCurrentWindow: () => currentWindow },
    BrowserWindow: { getCurrentWindow: () => currentWindow, getFocusedWindow: () => currentWindow },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
    nativeTheme: { get shouldUseDarkColors() {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    } },
  };

  window.electron = Object.assign(window.electron || {}, electron);
  window.require = window.require || ((mod) => {
    if (mod === 'electron') return electron;
    throw new Error(`[electron-shim] require('${mod}') não disponível no navegador.`);
  });
})();
