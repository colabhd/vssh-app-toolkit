'use strict';

// tauri-shim — `@tauri-apps/api` sobre o shell VSSH.
//
// Por que Tauri é um caso melhor que Electron, e a diferença é estrutural: a superfície de
// `@tauri-apps/api` é FIXA, estreita e documentada (fs, dialog, shell, notification, path, os,
// event, clipboard). Um shim genérico cobre a maior parte dos apps. No Electron, o que o renderer
// consome são handlers `ipcMain.handle` escritos sob medida por aquele app — não há superfície
// comum para cobrir.
//
// O limite honesto: `invoke()` de comando Rust customizado (`#[tauri::command]`) NÃO tem tradução
// genérica. Se o app depende disso, aquela lógica precisa virar backend próprio do vssh-app — é o
// mesmo caso dos handlers bespoke do Electron, e nenhum shim resolve.
//
// Uso: carregue depois do `vssh-app-shim.js`. Apps que fazem `import { readTextFile } from
// '@tauri-apps/api/fs'` precisam que o bundler resolva para estes objetos — configure um alias no
// build (ex.: `resolve.alias` do Vite) apontando para os globais `window.__TAURI__.*`.

(function () {
  if (!window.vssh) {
    console.warn('[tauri-shim] vssh-app-shim.js precisa ser carregado antes.');
    return;
  }

  const notImplemented = (what) => () => {
    throw new Error(
      `[tauri-shim] ${what} não tem equivalente no VSSH. ` +
      'Se o app depende disso, essa lógica precisa virar backend próprio do vssh-app.'
    );
  };

  // ── fs ────────────────────────────────────────────────────────────────────
  // Restrito ao que o usuário escolheu num seletor (ver os grants em vssh-app-shim). Um app Tauri
  // costuma abrir uma pasta antes de ler qualquer coisa, então isso se encaixa naturalmente.
  const fs = {
    readTextFile:  (p) => window.vssh.fs.read(p),
    readBinaryFile: (p) => window.vssh.fs.readBytes(p),
    writeTextFile: (p, contents) =>
      typeof p === 'object'
        ? window.vssh.fs.write(p.path, p.contents)
        : window.vssh.fs.write(p, contents),
    writeFile: (p, contents) =>
      typeof p === 'object'
        ? window.vssh.fs.write(p.path, p.contents)
        : window.vssh.fs.write(p, contents),
    async readDir(p) {
      const { items = [] } = await window.vssh.fs.list(p);
      return items.map((it) => ({
        path: `${String(p).replace(/\/+$/, '')}/${it.name}`,
        name: it.name,
        children: (it.type === 'directory' || it.isDirectory) ? [] : undefined,
      }));
    },
    createDir: (p) => window.vssh.fs.mkdir(p),
    removeFile: (p) => window.vssh.fs.delete(p),
    removeDir:  (p) => window.vssh.fs.delete(p),
    async exists(p) {
      try { await window.vssh.fs.stat(p); return true; } catch { return false; }
    },
  };

  // ── dialog ────────────────────────────────────────────────────────────────
  const dialog = {
    async open(opts = {}) {
      return opts.directory
        ? window.vssh.pickDirectory({ title: opts.title })
        : window.vssh.pickFile({ title: opts.title });
    },
    save: (opts = {}) => window.vssh.pickSave({ title: opts.title, name: opts.defaultPath }),
    message: (msg, opts = {}) => window.vssh.dialog.alert(msg, typeof opts === 'string' ? opts : opts.title),
    ask:     (msg, opts = {}) => window.vssh.dialog.confirm(msg, typeof opts === 'string' ? opts : opts.title),
    confirm: (msg, opts = {}) => window.vssh.dialog.confirm(msg, typeof opts === 'string' ? opts : opts.title),
  };

  // ── shell ─────────────────────────────────────────────────────────────────
  const shell = {
    // Um path do servidor abre no visualizador do desktop; uma URL abre numa aba.
    open(target) {
      if (/^https?:\/\//i.test(target)) { window.open(target, '_blank', 'noopener'); return Promise.resolve(); }
      window.vssh.openFile(target);
      return Promise.resolve();
    },
    Command: notImplemented('shell.Command (executar processo arbitrário)'),
  };

  // ── notification ──────────────────────────────────────────────────────────
  const notification = {
    isPermissionGranted: async () => true,
    requestPermission:   async () => 'granted',
    sendNotification(arg) {
      const o = typeof arg === 'string' ? { body: arg } : (arg || {});
      // `sendNotification({ title })` sem corpo é uso legítimo da API do Tauri, e passar `''`
      // como mensagem produzia um toast EM BRANCO — um retângulo sem texto, sem erro nenhum.
      // Quando só há título, ele vira a mensagem; o campo `title` do toast é para quando os dois
      // existem. É o mesmo tratamento que o `electron-shim` já dava, e a divergência entre os dois
      // shims irmãos era o defeito.
      window.vssh.notify(o.body || o.title || '', { title: o.body ? o.title : undefined });
    },
  };

  // ── path ──────────────────────────────────────────────────────────────────
  // Puramente string: não precisa de nada do servidor.
  const sep = '/';
  const path = {
    sep,
    delimiter: ':',
    join:    async (...parts) => parts.filter(Boolean).join(sep).replace(/\/{2,}/g, sep),
    dirname: async (p) => String(p).replace(/\/+$/, '').split(sep).slice(0, -1).join(sep) || sep,
    basename: async (p, ext) => {
      const b = String(p).replace(/\/+$/, '').split(sep).pop() || '';
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    extname: async (p) => {
      const b = String(p).split(sep).pop() || '';
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i + 1) : '';
    },
    isAbsolute: async (p) => String(p).startsWith(sep),
    // Diretórios "conhecidos" dependem do usuário no servidor, e o shim não os conhece sem uma
    // ida ao portal. Um app que precise disso deve pedir a pasta ao usuário — que é o modelo que
    // o resto deste shim já segue.
    appDir:      notImplemented('path.appDir'),
    appDataDir:  notImplemented('path.appDataDir'),
    homeDir:     notImplemented('path.homeDir'),
  };

  const api = {
    fs, dialog, shell, notification, path,
    invoke: notImplemented('invoke() de comando Rust customizado'),
    event: {
      // Eventos entre janelas nativas não existem aqui: há uma janela só.
      listen: async () => () => {},
      emit:   async () => {},
    },
  };

  window.__TAURI__ = Object.assign(window.__TAURI__ || {}, api);
  window.__TAURI_INVOKE__ = api.invoke;
})();
