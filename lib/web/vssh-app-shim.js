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
    if (!msg || msg.vsshApp !== true) return;
    // O shell empurra os grants no load e a cada mudança — inclusive os de sessões anteriores,
    // que é o que faz um app com handle persistido voltar funcionando. Ver `grants` abaixo.
    if (msg.type === 'grants') return void adoptGrants(msg.paths);
    if (msg.type !== 'result') return;
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

  // ── Grants espelhados localmente ──────────────────────────────────────────
  //
  // Quem impõe a permissão é o shell, que valida toda op de `fs`. Este espelho existe só para
  // `urlFor()`, que precisa responder SÍNCRONO (ver abaixo) e portanto não pode perguntar ao pai.
  //
  // O espelho é alimentado por duas vias: o retorno de um seletor (escolher É consentir) e o
  // push `grants` do shell, que inclui o que o usuário concedeu em SESSÕES ANTERIORES. A segunda
  // via é o que permite a um app que persistiu o handle no IndexedDB voltar funcionando — sem
  // ela, o handle sobreviveria ao reload e a permissão não, e o app seria negado na primeira
  // operação. Persistência de handle sem persistência de grant é a assimetria.
  //
  // Seja honesto sobre o que isso é: o app roda em iframe de MESMA ORIGEM que o portal, então o
  // JS dele já alcança `/api/*` com o cookie de sessão, com ou sem este shim. A tabela de grants
  // — aqui e no shell — serve para manter o app dentro do que o usuário escolheu e para transformar
  // erro de programação em mensagem clara. Ela não é uma fronteira de segurança contra um app
  // hostil; a fronteira é o app ser instalado por um admin.
  const grants = new Set();
  const remember = (p) => { if (typeof p === 'string' && p.startsWith('/')) grants.add(p.replace(/\/+$/, '')); };
  // Substitui, não acumula: o shell é a fonte da verdade, e uma revogação lá precisa apagar aqui.
  const adoptGrants = (paths) => {
    if (!Array.isArray(paths)) return;
    grants.clear();
    for (const p of paths) remember(p);
  };
  const granted = (p) => {
    const abs = String(p || '');
    if (!abs.startsWith('/') || abs.includes('..')) return false;
    for (const g of grants) if (abs === g || abs.startsWith(g + '/')) return true;
    return false;
  };

  function pick(variant, opts) {
    if (!inDesktop) return Promise.resolve(null);
    return call('pick', { variant, ...opts }).then((p) => { remember(p); return p; });
  }

  // O serverId é o primeiro segmento do path — o app é servido em
  // `/<serverId>/proxy/app/<id>/`. Disponível de imediato, sem handshake.
  const serverSlug = location.pathname.split('/').filter(Boolean)[0] || '';

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
    pickFile(opts = {})      { return pick('open', opts); },
    pickSave(opts = {})      { return pick('save', opts); },
    pickDirectory(opts = {}) { return pick('directory', opts); },

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

      // URL HTTP para o conteúdo de um arquivo, para usar direto em `<img src>`, `<video>`,
      // `<embed>` ou `fetch`. **Síncrona de propósito**: é o que permite substituir
      // `URL.createObjectURL(file)`, que é síncrona por assinatura e cujo retorno os apps enfiam
      // direto no `src`. Qualquer coisa que precise de round-trip antes de devolver a URL não
      // serve ali.
      //
      // Autoriza-se sozinha: o app é servido na mesma origem do portal, então o cookie de sessão
      // acompanha a requisição do `<img>` — que não passa por `fetch` e portanto não aceitaria
      // header nenhum. A rota também suporta Range, que é o que faz vídeo e PDF grande abrirem.
      // Pergunta ao shell, que é quem decide. De propósito NÃO lê o espelho local: o espelho
      // chega por mensagem e pode não ter chegado ainda, e um "não" falso aqui faz o app pedir
      // ao usuário uma permissão que ele já deu.
      isGranted(path) {
        if (!inDesktop) return Promise.resolve(false);
        return call('grants', { path }, { timeout: 5000 }).then((v) => !!v).catch(() => false);
      },

      urlFor(path) {
        const abs = String(path || '');
        if (!granted(abs)) {
          console.warn(
            `[vssh] urlFor('${abs}'): caminho fora do que o usuário escolheu num seletor. ` +
            'A URL é devolvida assim mesmo, mas o servidor pode recusar.'
          );
        }
        return `/${serverSlug}/api/fs/read?path=${encodeURIComponent(abs)}`;
      },
    },

    // Título da janela. Você raramente precisa chamar isto: o shim observa `document.title` e
    // repassa sozinho (ver o fim do arquivo), então um app portado que já faz
    // `document.title = ...` funciona sem uma linha de código nova.
    setTitle(title) { return post('title', { title: String(title ?? '') }); },

    // A janela é do shell, então o app pede em vez de fazer. É a contraparte do `BrowserWindow`
    // do Electron; não há `setSize` porque o tamanho inicial é do manifest (`window.width/height`)
    // e depois é do usuário — uma janela que se redimensiona sozinha briga com quem a arrastou.
    window: {
      minimize() { return post('window', { op: 'minimize' }); },
      maximize() { return post('window', { op: 'maximize' }); },
      restore()  { return post('window', { op: 'restore'  }); },
      focus()    { return post('window', { op: 'focus'    }); },
      close()    { return post('window', { op: 'close'    }); },
    },

    // Menu de contexto do desktop, com os itens que VOCÊ descreve — em vez de o app desenhar um
    // menu que não se parece com o resto do ambiente.
    //
    //   el.addEventListener('contextmenu', async (e) => {
    //     e.preventDefault();
    //     const id = await vssh.contextMenu(e.clientX, e.clientY, [
    //       { id: 'rename', label: 'Renomear', icon: 'edit' },
    //       { separator: true },
    //       { id: 'del', label: 'Excluir', icon: 'delete', danger: true },
    //     ]);
    //     if (id) run(id);
    //   });
    //
    // Devolve o `id` do item escolhido, ou `null` se o usuário fechou sem escolher. Só dados
    // atravessam: rótulo, ícone, `id` — nunca função, nunca HTML. As coordenadas são as do seu
    // próprio viewport; o shell soma a posição da janela.
    contextMenu(x, y, items) {
      if (!inDesktop) return Promise.resolve(null);
      return call('context-menu', { x, y, items }, { timeout: 120000 });
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

  // ── Título: espelhar `document.title` sem o app pedir ─────────────────────
  //
  // O shell lia o título uma vez, no `load` do iframe. Todo web app que abre um documento troca
  // `document.title` DEPOIS disso, e a janela ficava com o título congelado no HTML servido.
  //
  // Observar em vez de exigir `vssh.setTitle()` é deliberado: é a diferença entre um port que
  // funciona sem editar o app e um que precisa de patch. O mesmo código que dá o título à aba do
  // navegador dá o título à janela do desktop.
  if (inDesktop && typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    let last = document.title;
    const sync = () => {
      if (document.title === last) return;
      last = document.title;
      post('title', { title: last });
    };
    const observe = () => {
      const el = document.querySelector('title');
      if (el) new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
      // `document.title = x` sem `<title>` no HTML cria o elemento; observar o head pega esse caso
      // e também o app que substitui o elemento inteiro.
      if (document.head) new MutationObserver(sync).observe(document.head, { childList: true });
      sync();
    };
    if (document.head) observe();
    else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }

  // Puxa os grants já na carga do script, sem esperar o push do shell no `load` do iframe: o
  // `urlFor()` é síncrono e um app pode montar um `<img src>` antes daquele evento. As duas vias
  // convergem para a mesma lista; a corrida, se sobrar, custa um aviso no console e nada mais.
  if (inDesktop) call('grants', {}, { timeout: 5000 }).then(adoptGrants).catch(() => {});
})();
