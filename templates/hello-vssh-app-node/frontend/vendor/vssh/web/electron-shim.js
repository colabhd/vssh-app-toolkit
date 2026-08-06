'use strict';

// electron-shim — a superfície PADRÃO do Electron sobre o shell VSSH.
//
// Escopo, e por que ele é este: o caro de portar um app Electron nunca foi o transporte do IPC
// (~150 linhas sobre HTTP) — são os handlers do outro lado, escritos sob medida por aquele app.
// Uma camada de `ipcRenderer` genérica entrega o cano e ZERO dos handlers. Então este shim cobre
// o que é padrão do Electron (dialog, shell, clipboard de texto, Notification, controles de janela)
// e recusa, com mensagem clara, o que é bespoke.
//
// Fora de escopo hoje, e cada um por um motivo diferente:
//   - clipboard de IMAGEM: o shell ainda não tem API de clipboard (ver docs/roadmap/02-apis-de-shell.md);
//   - `setSize`/`setPosition`: por desenho — a janela é do usuário depois de aberta;
//   - `ipcRenderer.invoke` de canal próprio: é o trabalho real do port, e vira o seu backend.
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
    // `response` é o ÍNDICE do botão clicado, e a ordem dos botões é do app — não nossa. Presumir
    // que o afirmativo é o índice 0 acerta em `['Sim','Não']` e ERRA em `['Cancelar','OK']`:
    // confirmar devolveria 0, que ali é o "Cancelar", e o app descartaria o trabalho do usuário
    // achando que foi ele quem pediu. Sem erro nenhum, e num diálogo que o usuário respondeu
    // corretamente.
    //
    // `defaultId`/`cancelId` são justamente como o Electron declara quais índices significam o
    // quê. Quando o app os informa, obedecemos; quando não, 0/1 continua sendo o palpite — que é
    // o certo para a ordem convencional.
    async showMessageBox(opts = {}) {
      const o = opts.message ? opts : (arguments[1] || opts);
      const hasCancel = Array.isArray(o.buttons) && o.buttons.length > 1;
      if (!hasCancel) {
        await window.vssh.dialog.alert(o.message || '', o.title);
        return { response: 0, checkboxChecked: false };
      }
      const yes = await window.vssh.dialog.confirm(o.message || '', o.title);
      // `?? ` e não `||`: `defaultId: 0` é um índice legítimo e não pode cair no default.
      const sim  = Number.isInteger(o.defaultId) ? o.defaultId : 0;
      const nao  = Number.isInteger(o.cancelId)  ? o.cancelId  : 1;
      return { response: yes ? sim : nao, checkboxChecked: false };
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

  // ── Notification ──────────────────────────────────────────────────────────
  // Um app Electron notifica pela API padrão do navegador (`new Notification(...)`), no renderer.
  // Deixar a nativa passar seria errado DENTRO do desktop por um motivo concreto: a notificação do
  // SO aparece numa área do navegador que não existe em tela cheia — que é como o desktop VSSH roda
  // na maior parte do tempo. Então lá dentro roteamos para o toast do shell.
  //
  // Fora do desktop não mexemos em nada: a nativa é a resposta certa no `npm run dev`.
  //
  // O que NÃO dá para honrar ainda: `onclick`/`'click'`. O shell não devolve um handle para a
  // notificação, então o clique não volta. Isso é ruído silencioso o suficiente para merecer um
  // aviso no console em vez de um listener que nunca dispara sem explicação.
  if (window.vssh.inDesktop) {
    class VsshNotification extends EventTarget {
      constructor(title, options = {}) {
        super();
        this.title = String(title ?? '');
        this.body = options.body ?? '';
        window.vssh.notify(this.body || this.title, {
          title: this.body ? this.title : undefined,
          level: options.vsshLevel || 'info',
        });
      }
      close() {}
      addEventListener(type, ...rest) {
        if (type === 'click') {
          console.warn('[electron-shim] clique em Notification não volta ao app: o shell não ' +
                       'devolve handle. Use um botão na própria janela para a ação.');
        }
        return super.addEventListener(type, ...rest);
      }
      set onclick(_fn) {
        console.warn('[electron-shim] Notification.onclick não dispara — ver addEventListener.');
      }
      get onclick() { return null; }
      static requestPermission() { return Promise.resolve('granted'); }
      static get permission() { return 'granted'; }   // o toast do shell não pede permissão
    }
    window.Notification = VsshNotification;
  }

  // ── app / BrowserWindow ───────────────────────────────────────────────────
  const app = {
    getName:    () => document.title || 'vssh-app',
    // O `version` do manifest não chega ao frontend — o proxy serve o app, não injeta metadados.
    // Em vez de mentir com um literal, lemos do que o app pode declarar, nesta ordem:
    //   <meta name="vssh-app-version" content="1.2.3">  ou  window.__VSSH_APP_VERSION__
    // Sem nenhum dos dois, '0.0.0' continua sendo a resposta — mas agora é a resposta de quem não
    // declarou, não a de quem não tinha como declarar.
    getVersion: () =>
      window.__VSSH_APP_VERSION__ ||
      document.querySelector('meta[name="vssh-app-version"]')?.content ||
      '0.0.0',
    getPath: bespoke(
      'app.getPath()',
      'Peça a pasta ao usuário (showDirectoryPicker) ou use $VSSH_APP_DATA_DIR pelo seu backend.'
    ),
    quit()  { window.vssh.window.close(); },
    exit()  { window.vssh.window.close(); },
  };

  // A janela é do shell, não do app — mas o app PEDE ao shell pela ponte, e isso existe desde que
  // `vssh.window.*` entrou no shim. Eram no-ops aqui só porque este arquivo é anterior a ela.
  //
  // `setSize`/`setPosition` continuam de fora, e por desenho: o tamanho inicial vem do manifest e
  // depois a janela é do usuário (ver a tabela "O que não existe" em docs/api.md).
  const currentWindow = {
    setTitle(t) { document.title = String(t); },   // o shim espelha o <title> sozinho
    getTitle()  { return document.title; },
    close()      { window.vssh.window.close(); },
    minimize()   { window.vssh.window.minimize(); },
    maximize()   { window.vssh.window.maximize(); },
    unmaximize() { window.vssh.window.restore(); },
    focus()      { window.vssh.window.focus(); },
    show()       { window.vssh.window.focus(); },     // o mais próximo: trazer para a frente
    hide()       { window.vssh.window.minimize(); },  // o mais próximo: tirar da frente
    isMaximized: () => false,   // o shell não expõe geometria de volta ao app
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
  // Devolve `window.electron`, e não o objeto local: os dois são a mesma superfície, mas eram
  // OBJETOS DIFERENTES — `Object.assign` copia para um alvo novo. Um app que substitui
  // `window.electron.dialog` (o idioma comum para mockar em teste) continuava recebendo o diálogo
  // original por `require('electron')`, e as duas metades do app passavam a discordar.
  window.require = window.require || ((mod) => {
    if (mod === 'electron') return window.electron;
    throw new Error(`[electron-shim] require('${mod}') não disponível no navegador.`);
  });
})();
