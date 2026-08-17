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
  // Versão das libs do toolkit que este app está CARREGANDO — não a do toolkit que existe hoje.
  //
  // As libs são vendorizadas: o app commita uma cópia e a leva no tarball. Isso é bom para
  // reprodutibilidade e ruim para diagnóstico, porque a cópia envelhece sem dar sinal. Um relato
  // de bug que diz "não funciona" e não diz qual par shell/lib estava em jogo custa uma rodada
  // inteira de perguntas.
  //
  // Fica como literal, e não lida do `package.json`, porque isto roda no NAVEGADOR — não há de
  // onde ler. Quem impede a divergência é `tests/lib-version.test.js`, que compara este número com
  // o do `package.json` e falha quando alguém bumpa um sem o outro.
  const LIB_VERSION = '4.14.0';

  // O tipo MIME do arraste de arquivo do ambiente: caminhos absolutos, um por linha.
  //
  // ⚠ **Este valor é o MESMO literal que o shell escreve** (`FileOps.MIME`, em
  // `vssh-client/js/FileOps.js` do `vssh-sso`) — e são duas cópias porque são dois repositórios que
  // se instalam separados, sem CI cruzado e sem nenhuma linha de código atravessando. É a mesma
  // forma do `schema/vssh-app.schema.json`, que o `vssh-sso` vendoriza com marca de procedência.
  //
  // O modo de falha de uma divergência é o pior que existe: o tipo simplesmente não aparece em
  // `dataTransfer.types`, e então **nada acende, nada cai e nada loga** — dos dois lados. Por isso
  // cada repositório prende o literal na guarda dele (`tests/arraste-de-arquivo.test.js` aqui,
  // `tests/unit/arraste-para-app.test.js` lá), com o valor escrito por extenso: é o único ponto em
  // que uma comparação com uma constante vale mais que um teste de comportamento, porque o
  // comportamento de cada lado fica verde sozinho.
  const ARQUIVOS_MIME = 'application/x-vssh-files';

  /** Os caminhos que vieram num evento de arraste, ou `[]`. */
  function _caminhosDoArraste(dt) {
    if (!dt) return [];
    // `getData` é ilegível durante o `dragover` (o modo protegido do navegador) e legível no
    // `drop` — por isso a decisão de aceitar olha `types`, e só a leitura olha o conteúdo.
    const bruto = dt.getData(ARQUIVOS_MIME) || '';
    return bruto.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const inDesktop = window.parent !== window;
  const pending = new Map();
  let seq = 0;
  let caps = null;
  // Callbacks da bandeja: ficam AQUI e não atravessam a ponte, porque função não
  // serializa. O shell devolve só o `menuId`; quem sabe o que ele significa é o app.
  const _trayHandlers = { click: null, menu: null };

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.vsshApp !== true) return;
    // O shell empurra os grants no load e a cada mudança — inclusive os de sessões anteriores,
    // que é o que faz um app com handle persistido voltar funcionando. Ver `grants` abaixo.
    if (msg.type === 'grants') return void adoptGrants(msg.paths);
    // Volume vem do mixer da barra, por push: o app nunca pede, e não há requisição pendurada
    // esperando — quem mexe no slider é o usuário, a qualquer momento.
    if (msg.type === 'volume') {
      _gain = _clamp(msg.gain);
      _mudo = !!msg.muted;
      _aplicarVolume();
      return;
    }
    // Clique e menu da bandeja voltam por push, não por resposta: quem clica é o usuário,
    // minutos depois do `set`, e não há requisição pendurada esperando por isso.
    // A central de mídia do ambiente mandando "passe para a próxima". Volta por push pelo mesmo
    // motivo do `tray-event`: quem clica é o usuário, e não há requisição pendurada esperando.
    if (msg.type === 'media-acao') {
      try { _midiaHandler?.(String(msg.acao || '')); } catch (err) { console.warn('[vssh] media:', err); }
      return;
    }
    if (msg.type === 'tray-event') {
      const fn = msg.event === 'menu' ? _trayHandlers.menu : _trayHandlers.click;
      try { fn?.(msg.menuId); } catch (err) { console.warn('[vssh] tray:', err); }
      return;
    }
    if (msg.type !== 'result') return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    clearTimeout(entry.timer);
    msg.ok ? entry.resolve(msg.value) : entry.reject(new Error(msg.value || 'falhou'));
  });

  // Toda chamada que espera resposta tem timeout, e o padrão é generoso em vez de ausente. Um
  // shell que não conhece o tipo (por ser mais antigo que o app) não responde NADA — sem timer, a
  // promise fica pendurada para sempre: não resolve, não rejeita, não deixa rastro no console. É o
  // pior modo de falha que existe, porque não dá o que procurar.
  //
  // O padrão é grande de propósito. Chamadas de ritmo humano (`pick`, `dialog`, `open-with`,
  // `context-menu`) esperam uma pessoa decidir, e não dá para distinguir "usuário pensando" de
  // "shell mudo" só pelo relógio. Dez minutos está ordens de grandeza acima de qualquer escolha
  // real e ainda assim termina — que é o ponto. Quem sabe que a resposta é rápida (`capabilities`,
  // `grants`) passa um timeout curto e ganha detecção rápida.
  const HUMAN_TIMEOUT = 600000;

  function call(type, payload = {}, { timeout = HUMAN_TIMEOUT } = {}) {
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

  /**
   * Traduz a recusa do navegador ao ler/escrever clipboard num motivo que se pode consertar.
   *
   * Existe porque as três causas chegam como o MESMO `NotAllowedError`, e a diferença entre
   * elas é a diferença entre "mude uma linha" e "não dá para fazer isso". Distinguir por
   * `permissions.query` não é possível de forma síncrona no momento do erro; o que sobra é
   * olhar o estado do documento, que é justamente o que a plataforma exige.
   */
  function _motivoClipboard(err) {
    if (err && err.name === 'NotAllowedError') {
      // Sem foco no documento não há como o navegador conceder — e é o caso mais comum num
      // desktop de janelas, onde clicar na barra de título tira o foco do iframe.
      if (!document.hasFocus() || !navigator.userActivation?.isActive) return 'no-user-activation';
      return 'denied';
    }
    if (err && err.name === 'NotFoundError') return 'empty';
    return 'failed';
  }

  // ─── Áudio: o ambiente é o mixer, e o app não precisa saber ────────────────
  //
  // O desktop VSSH tem um mixer de volume na barra (Onda 2.5), e ele é o mixer DE VERDADE: um
  // vssh-app é um iframe no documento do shell, então quem faz papel de sistema operacional
  // para o áudio dele é o desktop. Nada aqui é opcional para o app — ele não chama nada, não
  // configura nada, e mesmo assim o slider dele funciona.
  //
  // Duas vias, porque `<audio>` e Web Audio não se alcançam pelo mesmo lugar:
  //
  //   MÍDIA      o shell até enxerga os elementos daqui (o iframe é mesma-origem), mas quem os
  //              trata AQUI DENTRO consegue MULTIPLICAR em vez de sobrescrever — o app continua
  //              dono do volume que ele pediu, e o ambiente vira um fator. Sem isso, o próximo
  //              `el.volume = 0.5` do app desfaria o mixer sem ninguém entender por quê.
  //   WEB AUDIO  aqui não há elemento nenhum para o shell encontrar. O único ponto de captura é
  //              `AudioNode.connect`: o que ia para `ctx.destination` passa a ir por um GainNode
  //              nosso. Sem esta via, um app que toca por AudioContext seria incontrolável — e a
  //              regra do mixer (só listar o que se controla) o esconderia da lista.
  //
  // Por isso o shim tem de carregar ANTES do app criar o contexto — o `injectScripts` do
  // static-spa põe a tag no `<head>`, que é o que garante isso.
  let _gain = 1;
  let _mudo = false;
  let _temWebAudio = false;
  const _ouvintesVol = new Set();
  const _ctxs = [];

  const _clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const _efetivo = () => (_mudo ? 0 : _gain);

  // ── Mídia: volume do app × volume do ambiente ──
  const _descVolume = typeof HTMLMediaElement !== 'undefined'
    && Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const _descMudo = typeof HTMLMediaElement !== 'undefined'
    && Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');

  function _adotarMidia(el) {
    if (!_descVolume || !_descMudo || el.__vsshAudio) return;
    let base = _descVolume.get.call(el);
    let baseMudo = _descMudo.get.call(el);
    const aplicar = () => {
      _descVolume.set.call(el, base * _efetivo());
      _descMudo.set.call(el, baseMudo || _mudo);
    };
    // O getter devolve o que o APP pediu, não o que está tocando: um player que desenha a
    // própria barrinha lendo `el.volume` continua mostrando o valor dele, e não o do ambiente.
    Object.defineProperty(el, 'volume', {
      configurable: true,
      get: () => base,
      set: (v) => { base = _clamp(v); aplicar(); },
    });
    Object.defineProperty(el, 'muted', {
      configurable: true,
      get: () => baseMudo,
      set: (v) => { baseMudo = !!v; aplicar(); },
    });
    el.__vsshAudio = aplicar;
    aplicar();
  }

  // `document` pode não existir (o shim roda em harness de teste e em worker), e a convenção
  // deste arquivo é degradar em vez de lançar — o mesmo `typeof` que o espelho de título usa.
  const _midiaDoDoc = () => (typeof document !== 'undefined' && document.querySelectorAll
    ? document.querySelectorAll('audio, video') : []);

  function _varrerMidia() {
    for (const el of _midiaDoDoc()) _adotarMidia(el);
  }

  // ── Web Audio: um GainNode entre o app e a saída ──
  let _aplicarGanhoWebAudio = () => {};
  let _webAudioInstalado = false;

  function _instalarWebAudio() {
    // Idempotente porque há DOIS chamadores: a carga do script (para o hook existir antes de o
    // app criar o contexto) e `_iniciarAudio`. Envolver `connect` duas vezes encadearia os
    // wrappers, e cada nó passaria por dois gains — o volume viraria o quadrado dele.
    if (_webAudioInstalado || typeof AudioNode === 'undefined') return;
    _webAudioInstalado = true;
    const conectar = AudioNode.prototype.connect;
    const desconectar = AudioNode.prototype.disconnect;
    const gains = new WeakMap();

    const _nosso = (ctx) => {
      let g = gains.get(ctx);
      if (!g) {
        g = ctx.createGain();
        g.gain.value = _efetivo();
        // Pelo ORIGINAL: chamar o `connect` já envolvido aqui seria recursão infinita.
        conectar.call(g, ctx.destination);
        gains.set(ctx, g);
        _ctxs.push(ctx);
      }
      return g;
    };
    const _ehSaida = (d) => d && d.context && d === d.context.destination;

    AudioNode.prototype.connect = function (destino, ...resto) {
      if (_ehSaida(destino)) {
        const g = _nosso(destino.context);
        if (this !== g) {
          if (!_temWebAudio) { _temWebAudio = true; _relatarAudio(); }
          return conectar.call(this, g, ...resto);
        }
      }
      return conectar.apply(this, arguments);
    };
    // Simétrico: sem isto, `node.disconnect(ctx.destination)` não desligaria nada, porque o
    // nó nunca esteve ligado ao destination — está ligado ao nosso gain.
    AudioNode.prototype.disconnect = function (destino, ...resto) {
      if (_ehSaida(destino)) {
        const g = gains.get(destino.context);
        if (g && this !== g) return desconectar.call(this, g, ...resto);
      }
      return desconectar.apply(this, arguments);
    };
    _aplicarGanhoWebAudio = () => {
      for (const ctx of _ctxs) {
        const g = gains.get(ctx);
        if (g) { try { g.gain.value = _efetivo(); } catch { /* contexto fechado */ } }
      }
    };
  }

  function _aplicarVolume() {
    _varrerMidia();
    for (const el of _midiaDoDoc()) el.__vsshAudio?.();
    _aplicarGanhoWebAudio();
    for (const fn of _ouvintesVol) {
      try { fn({ gain: _gain, muted: _mudo }); } catch (err) { console.warn('[vssh] audio:', err); }
    }
  }

  // O relato é o que torna o app VISÍVEL no mixer. Só fala quando há o que dizer: um app
  // silencioso a vida inteira não manda nada, e o último envio quando o som acaba é o que
  // apaga a linha do painel.
  let _tinhaAudio = false;
  function _relatarAudio() {
    if (!inDesktop) return;
    const els = _midiaDoDoc();
    const temWA = _temWebAudio && _ctxs.some((c) => c.state === 'running');
    const has = els.length > 0 || temWA;
    if (!has && !_tinhaAudio) return;
    _tinhaAudio = has;
    let tocando = temWA;
    for (const el of els) if (!el.paused && !el.ended) { tocando = true; break; }
    post('audio-state', { hasAudio: has, playing: tocando });
  }

  function _iniciarAudio() {
    _instalarWebAudio();
    _varrerMidia();
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      const mo = new MutationObserver((muts) => {
        for (const m of muts || []) {
          for (const n of m.addedNodes || []) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') { _adotarMidia(n); _relatarAudio(); }
            else if (n.querySelectorAll) {
              for (const el of n.querySelectorAll('audio, video')) { _adotarMidia(el); _relatarAudio(); }
            }
          }
        }
      });
      const alvo = document.documentElement || document.body;
      if (alvo) mo.observe(alvo, { childList: true, subtree: true });
    }
    // Eventos de mídia não borbulham; na fase de captura o document os vê assim mesmo.
    if (typeof document !== 'undefined' && document.addEventListener) {
      for (const ev of ['play', 'pause', 'ended', 'loadedmetadata']) {
        document.addEventListener(ev, _relatarAudio, true);
      }
    }
    // 3 s contra o TTL de 5 s do relato no shell: app que morre sem se despedir some sozinho.
    if (typeof setInterval === 'function') setInterval(_relatarAudio, 3000);
    _relatarAudio();
  }

  // ── A aparência do ambiente ─────────────────────────────────────────────────
  //
  // O usuário escolhe uma cor de destaque em Configurações → Ambiente, e o shell a reescreve no
  // `<html>` DELE. O app roda noutro documento, e nada disso atravessa — então uma janela que não
  // pergunte fica com a cor de fábrica enquanto o ambiente inteiro está noutra.
  //
  // ⚠ **Isto REPORTA e não escreve.** O cabeçalho deste arquivo afirma que o shim não cria nó nem
  // injeta CSS, e essa promessa continua verdadeira: quem escreve as variáveis no documento do app
  // é a biblioteca de UI (`lib/web/tuff/`). A divisão não é cerimônia — é o que permite a um app com
  // identidade visual própria (o `recoll` tem tema claro) puxar só a cor sem herdar paleta nenhuma.
  //
  // **Por que isto mora no shim e não na biblioteca:** porque o app que nunca vai usar o nosso CSS
  // também precisa, e hoje paga à mão. `vsshapp-recoll/static/js/vssh-integration.js` reimplementou
  // a leitura, a validação de hex e o observador — e **já apodreceu**: ele escuta
  // `{type:'vssh-theme'}` e cita `custom_xprahtml5/js/SettingsWindow.js`, e nenhum dos dois existe
  // mais no `vssh-sso`. Uma ponte sem dono nomeado é uma ponte que ninguém conserta.

  /**
   * Os quatro tokens que o shell reescreve, e não um.
   *
   * ⚠ `SettingsWindow._applyAccentColor` escreve `--ds-accent`, `--ds-accent-h`, `--ds-accent-bg` e
   * `--ds-sel` — e o segundo sai de `IconeDeDestaque.clara(hex)`, uma conta que mora lá. Ler só o
   * primeiro e DERIVAR os outros três traria essa fórmula para cá, numa quinta cópia entre dois
   * repositórios sem CI cruzado. Copiar os quatro não tem aritmética nenhuma do nosso lado.
   */
  const TOKENS_DE_DESTAQUE = ['--ds-accent', '--ds-accent-h', '--ds-accent-bg', '--ds-sel'];

  /** O `<html>` de quem hospeda este app, ou `null` quando não há a quem perguntar. */
  function _raizDoAmbiente() {
    try {
      if (!inDesktop) return null;
      const doc = window.parent.document;
      return (doc && doc.documentElement) || null;
    } catch {
      // Cross-origin: só ler `.document` já lança. É o caso de quem serve o app de outra origem, e
      // a resposta certa é a mesma de "não há desktop".
      return null;
    }
  }

  /**
   * Os tokens de destaque do ambiente, ou `null`.
   *
   * Lido por `getComputedStyle`, e não por `.style`: o shell só escreve o inline se houver cor
   * gravada nas preferências. Quem nunca escolheu — a maioria — tem o inline VAZIO e o valor certo
   * vindo da folha. Ler `.style` responderia `''` para essas pessoas, e o defeito seria o clássico
   * "só funciona depois de mexer nas Configurações".
   */
  function _tokensDoAmbiente() {
    const raiz = _raizDoAmbiente();
    if (!raiz) return null;
    try {
      const estilo = window.getComputedStyle(raiz);
      const fora = {};
      for (const nome of TOKENS_DE_DESTAQUE) {
        const valor = String(estilo.getPropertyValue(nome) || '').trim();
        if (valor) fora[nome] = valor;
      }
      return Object.keys(fora).length ? fora : null;
    } catch {
      return null;
    }
  }

  // Quem responde às ações da central de mídia. Um só: duas janelas do mesmo app são duas visões
  // do mesmo processo, mas cada uma tem o SEU documento e o seu shim.
  let _midiaHandler = null;

  const vssh = {
    inDesktop,

    // A versão das libs do toolkit que este app carrega. Síncrona de propósito: ela é conhecida
    // aqui dentro e não depende de ninguém — obrigar um `await` que fala com o pai para saber algo
    // que já está nesta função seria pior. Aparece também em `capabilities()`, porque é lá que
    // mora o PAR — e é o par que responde perguntas de diagnóstico.
    libVersion: LIB_VERSION,

    // O que este ambiente sabe fazer. `nativeApps: false` significa que não há X11 — "abrir com"
    // só terá vssh-apps, e não há programa Linux com UI para lançar.
    //
    // `shellVersion` e `libVersion` vêm juntos, e essa é a razão de existirem aqui: shell e apps
    // são deployados à parte, então versão dessincronizada é a regra e não a exceção. Sem o par, o
    // app sabe o que o shell FAZ mas não QUAL shell é — e quem recebe um relato de bug não sabe
    // nenhum dos dois.
    //
    // `shellVersion: null` é resposta legítima e quer dizer "shell antigo demais para se
    // declarar", não "erro". Garantir a chave é o que permite ao app escrever
    // `caps.shellVersion ?? 'desconhecida'` em vez de descobrir a ausência em produção.
    async capabilities() {
      if (caps) return caps;
      if (!inDesktop) {
        return (caps = {
          nativeApps: false, x11Interop: false, host: 'none',
          shellVersion: null, libVersion: LIB_VERSION,
        });
      }
      const resposta = await call('capabilities', {}, { timeout: 5000 }).catch(() => ({ host: 'unknown' }));
      caps = { ...resposta, shellVersion: resposta?.shellVersion ?? null, libVersion: LIB_VERSION };
      return caps;
    },

    // ── Três superfícies, três tempos de vida ────────────────────────────────
    //
    //   notify()  um FATO que aconteceu. Fica no histórico do sino até ser lido.
    //   toast()   uma frase que se lê e se esquece. Some em segundos, sem deixar rastro.
    //   live      uma CONDIÇÃO que é verdade agora. Some quando deixa de ser.
    //
    // A regra que decide: **um aviso é para o que não deixa rastro na tela.** Se a pessoa vê o
    // resultado acontecer, não há aviso nenhum. Se ela vai precisar reencontrar o que aconteceu
    // — um caminho, um id, um erro —, é `notify`.
    //
    // Isto não é preciosismo de nomenclatura: o desktop já gravou TODO aviso no histórico, e o
    // resultado foi um sino cheio de "arquivo salvo" que ninguém mais lia. Escolher errado aqui
    // custa a atenção de quem usa o seu app.

    notify(message, opts = {}) {
      if (post('notify', {
        message, title: opts.title, level: opts.level,
        prioridade: opts.prioridade, chave: opts.chave,
        actions: opts.actions, persistent: opts.persistent,
      })) return;
      console.info(`[vssh] ${opts.title ? opts.title + ': ' : ''}${message}`);
    },

    /** O aviso efêmero: "copiado", "salvo". NÃO entra no histórico. */
    toast(message, opts = {}) {
      if (post('toast', {
        message, title: opts.title, level: opts.level,
        timeout: opts.timeout, chave: opts.chave,
      })) return;
      console.info(`[vssh] ${message}`);
    },

    /**
     * O que o app está fazendo AGORA.
     *
     * `set` declara ou atualiza; a mesma chave reescreve no lugar, então relatar progresso não
     * empilha vinte linhas. `clear` encerra — e por padrão **não deixa rastro nenhum**, que é o
     * certo para uma indisponibilidade que foi resolvida. Passe `registrar` quando o fim FOR um
     * fato que vale guardar ("550 arquivos copiados").
     *
     * Fora do desktop vira log: dev local não tem barra de tarefas onde desenhar.
     */
    live: {
      set(chave, item) {
        if (post('live', { chave, item })) return;
        console.info(`[vssh:live] ${chave}`, item);
      },
      clear(chave, opts = {}) {
        if (post('live', { chave, item: null, registrar: opts.registrar })) return;
        console.info(`[vssh:live] ${chave} encerrada`);
      },
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
    //
    // ⚠ Isto já tinha um `|| window.open('#', '_blank')` no fim, e ele foi tirado: `post` só
    // devolve falso FORA do desktop, e ali o fallback abria uma aba **em branco** — um `#` não é
    // documento nenhum. A pessoa via uma aba nova sem conteúdo em vez de nada acontecer, que é
    // pior: sugere que funcionou.
    openFile(path)   { return post('open-file', { path }); },
    openFolder(path) { return post('open-folder', { path }); },

    /**
     * Abre um link no navegador DO AMBIENTE, e não numa aba de fora.
     *
     * Sem isto, um `<a target="_blank">` ou um `window.open` do app tira a pessoa do ambiente — e
     * o link some para dentro do navegador hospedeiro, onde nada do VSSH existe.
     *
     * **E o ganho maior é de alcance, não de enquadramento.** O navegador do ambiente resolve a
     * rede a partir do SERVIDOR LINUX, então `http://localhost:3000` aqui é o loopback do
     * servidor — o servidor de desenvolvimento de quem está usando. Aberto numa aba de fora, o
     * mesmo endereço apontaria para a máquina de quem lê.
     *
     * Só `http`/`https`; o ambiente recusa o resto.
     *
     * ⚠ O degrade é ESCRITO, e não herdado: `call()` **rejeita** fora do desktop, ao contrário do
     * `post()` que o `openFile` usa. Sem o `inDesktop` explícito aqui, esta função seria a única
     * do arquivo a lançar em dev standalone — o oposto do que o cabeçalho promete.
     *
     * ─── `{ destino: 'navegador' }`: "esta eu quero no navegador MESMO ASSIM" ───
     *
     * Um link pode ter dono. Um app que declare o host em `opens.urls` passa a receber os links
     * dele, e aí `openUrl` deixa de significar "abra no navegador" para significar "abra onde este
     * link pertence" — que é o certo, e é o que quase todo chamador quer.
     *
     * Sobra o caso em que o app SABE que quer o navegador: a página de ajuda do próprio serviço, a
     * política de privacidade, o "ver no site original" que existe justamente para escapar do
     * cliente customizado. Sem uma palavra para dizer isso, esse botão vira um laço — o app manda
     * o link, o ambiente o devolve para o app, e não há saída.
     *
     * ⚠ **O campo só viaja quando é pedido**, e essa é a propriedade que importa: um shell antigo,
     * que não conhece roteamento de link nenhum, recebe a mensagem byte a byte igual à de sempre e
     * abre no navegador — que é exatamente o que `destino: 'navegador'` pede. O degrade é correto
     * por construção, e não por termos lembrado dele.
     *
     * Valor desconhecido não é erro que derruba: `console.warn` e segue como se não tivesse vindo,
     * o mesmo idioma do `granted()` mais abaixo. Lançar aqui trocaria um link que abre no lugar
     * errado por um link que não abre.
     */
    openUrl(url, opcoes) {
      const alvo = String(url);
      const pedido = opcoes && opcoes.destino;
      if (pedido != null && pedido !== 'navegador') {
        console.warn(`[vssh] openUrl: destino "${pedido}" não existe; o único é 'navegador'. Ignorando.`);
      }
      if (!inDesktop) { window.open(alvo, '_blank', 'noopener'); return Promise.resolve(null); }
      return call('open-url', pedido === 'navegador' ? { url: alvo, destino: 'navegador' } : { url: alvo });
    },
    // Deixa o usuário escolher COM QUE abrir. Sem X11, a lista tem só vssh-apps.
    openWith(path)   { return call('open-with', { path }); },

    // ── Arquivo arrastado, nas duas direções ────────────────────────────────────────────────
    //
    // O contrato é UM: um tipo MIME com os caminhos absolutos, um por linha. Ele existia no
    // ambiente desde sempre — o gerenciador de arquivos e a área de trabalho já o escrevem — e era
    // constante interna do shell, então um app não tinha como saber que existe. Publicá-lo é o
    // item; as três direções caem dele:
    //
    //   ambiente → app     `onArquivosSoltos`, e mais nada: o app é servido na MESMA origem, então
    //                      o iframe recebe o próprio `drop` e lê o `dataTransfer` direto. O shell
    //                      não está no caminho.
    //   app → ambiente     `arrastarArquivos`, que escreve o mesmo tipo e AVISA o shell — todo alvo
    //                      de soltura do ambiente abre o portão num estado de módulo do documento
    //                      dele, que um gesto nascido no iframe não escreveria.
    //   app → app          cai de graça: A escreve, B lê, e ninguém no meio precisa saber.
    //
    // Fora do desktop as duas funcionam do mesmo jeito entre janelas do próprio app — o que falta
    // é só o aviso ao shell, que não existe para ser ouvido.
    ARQUIVOS_MIME,

    /**
     * Chama `cb({ caminhos, x, y, alvo })` quando arquivos do ambiente são soltos no app.
     *
     * @returns a função que desliga. Cancelar importa: o ouvinte fica no documento.
     */
    onArquivosSoltos(cb, { alvo = document } = {}) {
      // ⚠ **O `preventDefault` no `dragover` NÃO é opcional, e a falta dele não dá erro.** Sem ele
      // o navegador entende que este elemento não aceita a soltura — o `drop` simplesmente não
      // acontece, e o gesto morre com o cursor de "proibido". É o modo de falha mais caro deste
      // contrato porque não deixa nada no console.
      const nosso = (e) => [...(e.dataTransfer?.types || [])].includes(ARQUIVOS_MIME);
      const sobre = (e) => {
        if (!nosso(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      };
      const soltou = (e) => {
        if (!nosso(e)) return;
        e.preventDefault();
        const caminhos = _caminhosDoArraste(e.dataTransfer);
        if (!caminhos.length) return;
        try { cb({ caminhos, x: e.clientX, y: e.clientY, alvo: e.target }); }
        catch (err) { console.warn('[vssh] onArquivosSoltos:', err); }
      };
      alvo.addEventListener('dragover', sobre);
      alvo.addEventListener('drop', soltou);
      return () => {
        alvo.removeEventListener('dragover', sobre);
        alvo.removeEventListener('drop', soltou);
      };
    },

    /**
     * Põe caminhos do usuário num arraste que o APP inicia — chamado de dentro do `dragstart` dele.
     *
     *     el.addEventListener('dragstart', (e) => vssh.arrastarArquivos(e.dataTransfer, ['/home/u/a.md']));
     *
     * O fim do gesto é avisado sozinho, por um `dragend` de uma vez só: exigir que o app se lembre
     * seria deixar o ambiente com alvo aceso para um arraste que já acabou, e o app que esquecesse
     * quebraria o ambiente inteiro até o próximo arraste.
     */
    arrastarArquivos(dataTransfer, caminhos, { efeito = 'copyMove' } = {}) {
      const lista = (Array.isArray(caminhos) ? caminhos : [caminhos])
        .filter((p) => typeof p === 'string' && p.startsWith('/'));
      if (!lista.length) return false;
      if (dataTransfer) {
        dataTransfer.setData(ARQUIVOS_MIME, lista.join('\n'));
        dataTransfer.effectAllowed = efeito;
      }
      const fim = () => {
        document.removeEventListener('dragend', fim, true);
        post('arraste', { fase: 'fim' });
      };
      document.addEventListener('dragend', fim, true);
      post('arraste', { fase: 'inicio', caminhos: lista });
      return true;
    },

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

      // "Existe?" — e o que ela NÃO faz é o ponto. O idioma que todo mundo escreve,
      // `stat(p).then(() => true).catch(() => false)`, transforma **três** respostas em duas:
      // "não existe", "não tenho permissão" e "não consegui perguntar" saem todas como `false`.
      // O app então cria por cima de um arquivo que estava lá, ou conclui que a pasta do usuário
      // está vazia porque a rede piscou. Aqui só o 404 do servidor vira `false`; o resto lança.
      exists(path) {
        return call('fs', { op: 'exists', path }).then((r) => !!(r && r.exists));
      },

      /**
       * Renomeia — e é também o **mover**, como o `mv`. `copy` é o irmão.
       *
       * **Origem e destino precisam AMBOS estar concedidos**, e isso é imposto pelo shell, não
       * aqui: sem os dois, um `rename` levaria um arquivo do usuário para fora do que ele
       * autorizou, e um `copy` traria para dentro algo que o app não podia ler.
       *
       * Não sobrescreve: destino existente falha. `{ overwrite: true }` é a forma de dizer que
       * você quer mesmo — explícito, porque perder um arquivo em silêncio não tem desfazer.
       */
      rename(from, to, opts = {}) {
        return call('fs', { op: 'rename', from, to, policy: opts.overwrite ? 'overwrite' : 'fail' });
      },
      copy(from, to, opts = {}) {
        return call('fs', { op: 'copy', from, to, policy: opts.overwrite ? 'overwrite' : 'fail' });
      },

      // Avisa quando algo muda dentro de `path` por fora do app — outro editor, um `git pull`,
      // um upload pelo gerenciador de arquivos. É a diferença entre "meu editor e o app veem o
      // mesmo arquivo" e "tenho que lembrar de apertar Refresh".
      //
      //   const parar = await vssh.fs.watch(dir, ({ path }) => recarregar(path));
      //   // …depois
      //   parar();
      //
      // Devolve a função que cancela. **Cancele quando parar de precisar**: do outro lado, cada
      // watch segura um vigia vivo no servidor Linux, e há teto por usuário.
      //
      // NÃO está no `fsa-polyfill` de propósito: a File System Access API não tem watch, e
      // pendurar isto num handle daria cara de padrão a uma extensão nossa. Fica em `vssh.fs`,
      // que é onde o ambiente pode ser mais que o navegador.
      async watch(path, onChange) {
        if (!inDesktop) return () => {};
        const watchId = `w${++seq}`;
        const handler = (e) => {
          if (e.origin !== location.origin || e.source !== window.parent) return;
          const m = e.data;
          if (!m || m.vsshApp !== true || m.type !== 'fs-change' || m.watchId !== watchId) return;
          // `closed: true` é o shell dizendo que a assinatura acabou de vez (o EventSource
          // desistiu de reconectar). Avisar é melhor que ficar em silêncio fingindo que vigia.
          try { onChange({ path: m.path, closed: !!m.closed }); } catch {}
        };
        window.addEventListener('message', handler);
        try {
          await call('fs', { op: 'watch', path, watchId }, { timeout: 15000 });
        } catch (err) {
          window.removeEventListener('message', handler);
          throw err;
        }
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          window.removeEventListener('message', handler);
          call('fs', { op: 'unwatch', watchId }, { timeout: 15000 }).catch(() => {});
        };
      },

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
      //
      // Três respostas, não duas: `true`, `false` e **`null` = não obtive resposta**. Antes um
      // shell antigo, um `ok:false` e um timeout produziam todos `false`, e "não" e "não sei"
      // pedem ações OPOSTAS — uma manda desistir, a outra manda seguir. Colapsar as duas escolhe
      // a errada exatamente quando o canal está com problema, que é quando importa. Shell e apps
      // são deployados à parte: versão dessincronizada é a regra, não a exceção.
      isGranted(path, opts = {}) {
        // Fora do desktop não existe sistema de grants — é `null` pelo mesmo motivo, não `false`.
        if (!inDesktop) return Promise.resolve(null);
        return call('grants', { path, mode: opts.mode }, { timeout: 5000 })
          .then((v) => (typeof v === 'boolean' ? v : null))
          .catch(() => null);
      },

      /**
       * O que este app JÁ pode tocar, sem abrir seletor nenhum.
       *
       * ─── Para que serve, e por que ela não existia ────────────────────────
       *
       * A File System Access API não tem "liste os handles que eu já tenho" — cada app guarda os
       * seus, e o lugar em que ele guarda é o IndexedDB, que é **por perfil de navegador**. Num
       * computador novo o app acorda sem handle nenhum e pede a pasta de novo, mesmo quando a
       * permissão já foi concedida — porque a permissão dele viajou e o handle não.
       *
       * Esta lista é a ponte: os caminhos vêm do shell (que agora os guarda por USUÁRIO, e não por
       * navegador), e `showDirectoryPicker` deixa de ser o único jeito de obter um handle. O
       * polyfill usa isto em `grantedHandles()`.
       *
       * Síncrona de propósito: o espelho já está em memória, alimentado pelo push do shell. Um
       * `await` aqui faria a restauração do app depender de uma ida e volta que já aconteceu.
       */
      grantedPaths() { return [...grants]; },

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

    /**
     * "Se eu voltar, volte assim." A rota que o ambiente guarda e devolve na URL da janela.
     *
     * ─── Por que uma ROTA, e não um objeto de estado ────────────────────────────────────────
     *
     * Este método nasceu de um defeito medido: o editor voltava sem a pasta aberta. E o desenho
     * que estava escrito para consertá-lo pedia um **objeto opaco** que o ambiente guardaria e
     * devolveria — com teto de tamanho a definir, e uma pergunta feia junto: o que acontece quando
     * o app volta numa versão que não entende o próprio estado antigo.
     *
     * A rota responde as três de graça, e é por isso que ela venceu:
     *
     *   - o teto já existe (512), e a validação também — o ambiente recusa esquema, caminho
     *     absoluto e `..`, porque uma rota é um caminho DENTRO do app e nada mais;
     *   - a restauração não pede código nenhum do seu lado: a janela volta na URL certa e o seu
     *     app boota nela, exatamente como se a pessoa tivesse aberto aquele endereço;
     *   - e você não tem como não entender a própria rota. Ela é a URL do seu router, e rota
     *     desconhecida é um caso que ele já trata.
     *
     * ⚠ **Rota é ponteiro, não armazém.** O que não couber num endereço — conteúdo não salvo,
     * índice, cache — vai para o backend do seu app ou para o filesystem do usuário. Ver a seção
     * "OPFS é cache, nunca a verdade" na `docs/api.md`: estado que fica só no navegador é dívida
     * contra a promessa de trocar de máquina sem perder nada.
     *
     * ```js
     * // O editor reporta onde está sempre que navega:
     * addEventListener('popstate', () => vssh.lembrarRota(location.search + location.hash));
     * ```
     *
     * Vazio limpa: `lembrarRota('')` faz a janela voltar na raiz do app.
     *
     * O ambiente guarda com atraso e sem repetir, então chamar a cada tecla não custa rede.
     */
    lembrarRota(rota) { return post('rota', { rota: String(rota ?? '') }); },

    // A janela é do shell, então o app pede em vez de fazer. É a contraparte do `BrowserWindow`
    // do Electron; não há `setSize` porque o tamanho inicial é do manifest (`window.width/height`)
    // e depois é do usuário — uma janela que se redimensiona sozinha briga com quem a arrastou.
    window: {
      minimize() { return post('window', { op: 'minimize' }); },
      maximize() { return post('window', { op: 'maximize' }); },
      restore()  { return post('window', { op: 'restore'  }); },
      focus()    { return post('window', { op: 'focus'    }); },
      close()    { return post('window', { op: 'close'    }); },

      // ─── Quando o cabeçalho é do APP ──────────────────────────────────────────────────────
      //
      // Um app que declara `window.cabecalho: "app"` no manifesto desenha a própria barra de
      // título, e o ambiente não desenha a dele. É o caso do editor: a barra do VS Code passa a
      // ser a barra da janela, com os botões do ambiente dentro dela — que é o que ele sempre fez
      // no Electron.
      //
      // As três funções abaixo são o que sobra de responsabilidade do ambiente nesse arranjo, e
      // cada uma espelha um gesto que o cabeçalho padrão já trata.

      /**
       * "Me agarraram aqui" — começa o arraste da janela a partir de um ponto do SEU documento.
       *
       * ⚠ **Aqui estava escrito "não faça mais nada" e "não mande `pointermove`". Estava errado, e
       * custou duas janelas quebradas.** Enquanto o botão está apertado sobre o seu quadro, o
       * documento do ambiente não recebe evento de ponteiro NENHUM — quem tem o gesto é você, do
       * primeiro ponto ao último. Deixar o ambiente "assumir" no meio é entregar um gesto pela
       * metade, e os pontos que se perdem no caminho não avisam ninguém.
       *
       * O uso correto são os três, e o `setPointerCapture` é o que faz valer:
       *
       * ```js
       * barra.addEventListener('pointerdown', (e) => {
       *   if (e.button !== 0) return;
       *   barra.setPointerCapture(e.pointerId);   // daqui em diante os eventos são seus
       *   vssh.window.arrastar(e.clientX, e.clientY, e.screenX, e.screenY);
       * });
       * barra.addEventListener('pointermove', (e) => vssh.window.arrastarPara(e.screenX, e.screenY));
       * barra.addEventListener('pointerup',   () => vssh.window.arrastarFim());
       * ```
       *
       * O limiar que separa clique de arraste é SEU, pelo mesmo motivo. O ambiente continua dono do
       * que é dele: containment, encaixe e onde a janela para.
       *
       * ⚠ **Os pontos do meio vão em coordenada de TELA, e isso não é preciosismo.** Enquanto a
       * janela é arrastada, o seu quadro se move JUNTO com ela — o ponteiro fica quase parado
       * dentro dele, e `clientX` passa a valer `tela − posição da janela`, isto é, um número que
       * depende justamente do que a gente acabou de mudar. Isso é um laço de realimentação: com
       * mais de um `pointermove` por quadro (mouse de 240 Hz, eventos coalescidos), o ambiente
       * reconverte contra um layout de um quadro atrás e o erro entra como **tremor**. Medido numa
       * janela real. `screenX`/`screenY` não se movem com a janela, e o laço deixa de existir.
       *
       * No começo vão os dois: o `clientX/clientY` diz onde no SEU quadro você foi agarrado (é o que
       * o ambiente traduz, uma vez, com nada ainda movido), e o `screenX/screenY` fixa a referência
       * para todo o resto do gesto. Geometria continua sem atravessar em direção nenhuma.
       */
      arrastar(x, y, telaX, telaY) { return post('window', { op: 'drag-start', x, y, telaX, telaY }); },

      /**
       * Um ponto do arraste em curso, em coordenada de **tela** (`e.screenX`, `e.screenY`). Sem
       * arraste começado, o ambiente ignora.
       */
      arrastarPara(telaX, telaY) { return post('window', { op: 'drag-move', telaX, telaY }); },

      /**
       * O fim do arraste. **Obrigatório** — sem ele a janela continua seguindo o ponteiro depois
       * que o usuário solta, e é o `pointerup`/`pointercancel` que o chama.
       */
      arrastarFim() { return post('window', { op: 'drag-end' }); },

      /** O duplo-clique da barra de título. Alterna, e não maximiza — é o gesto, não a ação. */
      alternarMaximizado() { return post('window', { op: 'toggle-maximize' }); },

      /** O menu de contexto do cabeçalho (mover, maximizar, fechar, log do backend…). */
      menuDoCabecalho(x, y) { return post('window', { op: 'head-menu', x, y }); },

      /**
       * Outra janela DESTE app — e a graça está em `rota`, que decide o que vai dentro dela.
       *
       *   vssh.window.abrir('?painel=notas', { title: 'Notas', width: 380, height: 520 });
       *
       * Sem `rota`, a janela nova abre a mesma página: uma cópia, útil para ver dois pedaços do
       * mesmo documento lado a lado. Com `rota`, ela é uma janela **extra** — um painel, uma
       * prévia, um segundo documento —, e é aí que isto deixa de ser um `window.open` pobre.
       *
       * O que ela NÃO é: uma instância nova. Continua sendo o mesmo backend, o mesmo token e o
       * mesmo `VSSH_APP_DATA_DIR` — N janelas, um processo. Estado de UI que você guardar no
       * backend passa a ter mais de um cliente, e isso é sua conta.
       *
       * `rota` é um caminho DENTRO do app, relativo, como todo fetch que você escreve. URL
       * absoluta, `javascript:` e `..` são recusados pelo shell — a janela leva o título e o
       * ícone do seu app, e servir outra coisa ali seria o material de uma tela falsa.
       *
       * Devolve `false` num shell que ainda não sabe abrir janela extra (versão dessincronizada é
       * a regra) e fora do desktop cai no `window.open` do navegador, que é o equivalente honesto.
       */
      abrir(rota = '', opts = {}) {
        if (!inDesktop) return Promise.resolve(!!window.open(String(rota || ''), '_blank', 'noopener'));
        return call('window', {
          op: 'open',
          rota: String(rota || ''),
          title: opts.title,
          width: opts.width,
          height: opts.height,
        }).then((v) => v !== false).catch(() => false);
      },
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
      return call('context-menu', { x, y, items });   // ritmo humano: timeout padrão
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

    // Bandeja do sistema: um ícone do seu app ao lado do relógio, com tooltip, badge e menu.
    //
    //   await vssh.tray.set({
    //     icon: 'refresh', tooltip: 'Sincronizando 3 de 12', badge: { count: 3 },
    //     menu: [{ id: 'pause', label: 'Pausar' }, { id: 'open', label: 'Abrir pasta' }],
    //     onClick: () => vssh.window.focus(),
    //     onMenu:  (id) => id === 'pause' && pausar(),
    //   });
    //
    // Um item por app, atualizável: chamar `set` de novo troca o conteúdo sem o ícone pular de
    // lugar. `icon` é nome de ícone do desktop ou caminho dentro do seu pacote; `badge` aceita
    // `{count}`, `{dot:true}` ou `{text}`. Só dados atravessam — nunca HTML.
    //
    // **Hoje isto vale para app com JANELA.** Um `type:"engine"`/`kind:"service"` não tem iframe,
    // logo não tem esta ponte; a via por arquivo para eles ainda não existe, e dizer isso é melhor
    // que deixar você descobrir com um `set` que nunca aparece.
    //
    // Devolve `false` — em vez de rejeitar ou pendurar — quando não há bandeja do outro lado: fora
    // do desktop, ou num shell mais antigo que este shim, que simplesmente não responde. Timeout
    // curto porque a resposta é local e imediata; se demorou, não vem.
    tray: {
      set(item = {}) {
        if (!inDesktop) return Promise.resolve(false);
        const { onClick, onMenu, ...data } = item;
        _trayHandlers.click = typeof onClick === 'function' ? onClick : null;
        _trayHandlers.menu  = typeof onMenu  === 'function' ? onMenu  : null;
        return call('tray', { op: 'set', item: data }, { timeout: 5000 })
          .then(() => true).catch(() => false);
      },
      remove() {
        _trayHandlers.click = _trayHandlers.menu = null;
        if (!inDesktop) return Promise.resolve(false);
        return call('tray', { op: 'remove' }, { timeout: 5000 })
          .then(() => true).catch(() => false);
      },
    },

    /**
     * O cofre: credenciais que o app precisa e o USUÁRIO guarda.
     *
     * **Peça daqui, no momento em que a credencial falta** — no clique de "conectar", quando não
     * há token —, e não mandando a pessoa procurar Configurações. Ela não sabe o nome da variável
     * que o seu app espera; você sabe.
     *
     * **O valor não passa por aqui.** `set()` não recebe o segredo: quem digita fala com o diálogo
     * do desktop, num campo de senha, e o que volta é a lista de NOMES guardados. Não há `get()`, e
     * não é esquecimento — um cofre que devolve o que guardou é uma porta a mais, e o seu app já
     * recebe o valor pelo ambiente.
     *
     * **O ambiente de um processo é fixado no start**, então guardar não basta: o app precisa
     * REINICIAR para enxergar. `set()` devolve `requerReinicio: true` justamente para o app poder
     * oferecer isso em vez de a pessoa concluir que gravou e não funcionou.
     *
     *   const { names, cancelado, requerReinicio } =
     *     await vssh.secrets.set('OPENAI_API_KEY', { description: 'Cole a chave da sua conta.' });
     *   if (cancelado) return;                      // desistir é resposta, não erro
     *   if (requerReinicio) await vssh.dialog.alert('Reinicie o app para usar a chave.');
     *
     * Fora do desktop devolve `null` em vez de lançar: o app roda em desenvolvimento local com a
     * credencial vindo de onde o autor quiser, e a ausência de cofre não é uma falha.
     */
    secrets: {
      list() {
        if (!inDesktop) return Promise.resolve(null);
        return call('secrets', { op: 'list' }).then((r) => r?.names ?? null).catch(() => null);
      },
      set(nome, opts = {}) {
        if (!inDesktop) return Promise.resolve(null);
        // Sem timeout PRÓPRIO: o padrão do shim já é o que espera um humano de verdade e ainda
        // assim termina. Passar `0` aqui tiraria o relógio de vez, e um shell travado deixaria a
        // promessa pendurada para sempre — trocar uma espera longa por uma espera infinita.
        return call('secrets', {
          op: 'set', nome: String(nome || ''),
          title: opts.title, description: opts.description,
        });
      },
      remove(nome) {
        if (!inDesktop) return Promise.resolve(null);
        return call('secrets', { op: 'del', nome: String(nome || '') });
      },
    },

    /**
     * Pede a tela de impressão do desktop para um arquivo do SERVIDOR.
     *
     * Mesmo padrão de `dialog` e `pick`: o app pede, o shell é dono da UI, e quem escolhe o
     * destino e confirma é o usuário. O app não imprime — ele nem sabe que impressoras
     * existem.
     *
     * O destino que o desktop oferece primeiro é a fila do próprio servidor, e a razão vale
     * saber ao projetar o seu app: ali o arquivo NÃO viaja. Mandar um PDF de 200 páginas para
     * o navegador imprimir significa baixar 200 páginas antes de imprimir 200 páginas.
     *
     * Devolve `false` — em vez de lançar — fora do desktop, ou num shell que não conhece o
     * tipo. Resolve assim que a tela abre; não espera o usuário imprimir.
     */
    print(path, opts = {}) {
      if (!inDesktop) return Promise.resolve(false);
      return call('print', { path, name: opts.name }, { timeout: 5000 })
        .then(() => true).catch(() => false);
    },

    // ── Clipboard ──────────────────────────────────────────────────────────
    //
    // Duas metades, e elas não passam pelo mesmo caminho — de propósito.
    //
    // TEXTO E IMAGEM não atravessam a ponte. O iframe do app é da MESMA ORIGEM que o desktop
    // e declara `allow="clipboard-read; clipboard-write"`, então `navigator.clipboard`
    // funciona aqui dentro. Mediar pelo shell seria pior, não melhor: `write()` exige ativação
    // transitória do usuário, e ativação NÃO atravessa `postMessage` — a ponte quebraria
    // exatamente o que ela existiria para permitir. O que o shim acrescenta é o MOTIVO da
    // falha; ver `readImage` abaixo.
    //
    // ARQUIVOS atravessam, porque o clipboard de arquivos é do shell: quem guarda
    // `{action, paths}` é o gerenciador de arquivos, e não há API de navegador que o alcance.
    // É esta metade que faz "copiar no gerenciador, colar no app" existir.
    clipboard: {
      /** O que está no clipboard de arquivos do desktop: `{action, paths}` ou `null`. */
      files() {
        if (!inDesktop) return Promise.resolve(null);
        return call('clipboard', { op: 'files' }, { timeout: 5000 }).catch(() => null);
      },

      /**
       * Põe caminhos no clipboard de arquivos, como se o usuário tivesse copiado no
       * gerenciador. Sempre COPIAR: recortar move arquivo do usuário na próxima colagem, e
       * isso continua sendo do gerenciador, onde ele vê o que está fazendo.
       */
      setFiles(paths) {
        if (!inDesktop) return Promise.resolve(false);
        const lista = (Array.isArray(paths) ? paths : [paths]).filter(p => typeof p === 'string' && p);
        if (!lista.length) return Promise.resolve(false);
        return call('clipboard', { op: 'setFiles', paths: lista }, { timeout: 5000 })
          .then(() => true).catch(() => false);
      },

      /**
       * Avisa quando o clipboard de arquivos muda — inclusive por fora do app, que é o caso
       * que importa: o usuário copia no gerenciador e volta para cá. Devolve a função que
       * cancela.
       */
      onChange(fn) {
        const h = (e) => {
          if (e.origin !== location.origin || e.source !== window.parent) return;
          const m = e.data;
          if (m && m.vsshApp === true && m.type === 'clipboard-change') {
            try { fn(m.clipboard || null); } catch (err) { console.warn('[vssh] clipboard:', err); }
          }
        };
        window.addEventListener('message', h);
        return () => window.removeEventListener('message', h);
      },

      /**
       * Lê uma imagem do clipboard do sistema. Devolve um `Blob`, ou `null` se não havia
       * imagem — e **lança com motivo nomeado** quando o navegador recusa:
       *
       *   no-user-activation  chamada fora de um gesto do usuário, ou a aba não está em foco
       *   denied              o usuário negou a permissão de leitura do clipboard
       *   unsupported         navegador sem `navigator.clipboard.read`
       *
       * O motivo é o ponto. `NotAllowedError` genérico faz o autor do app abrir issue; "chame
       * de dentro do clique" faz ele consertar em dois minutos.
       */
      async readImage() {
        if (!navigator.clipboard?.read) throw Object.assign(new Error('clipboard.read indisponível'), { reason: 'unsupported' });
        let itens;
        try {
          itens = await navigator.clipboard.read();
        } catch (err) {
          throw Object.assign(new Error(err.message), { reason: _motivoClipboard(err), cause: err });
        }
        for (const it of itens) {
          const tipo = it.types.find(t => t.startsWith('image/'));
          if (tipo) return it.getType(tipo);
        }
        return null;
      },

      /** Põe uma imagem (`Blob`) no clipboard do sistema. Mesmos motivos nomeados. */
      async writeImage(blob) {
        if (!navigator.clipboard?.write) throw Object.assign(new Error('clipboard.write indisponível'), { reason: 'unsupported' });
        try {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return true;
        } catch (err) {
          throw Object.assign(new Error(err.message), { reason: _motivoClipboard(err), cause: err });
        }
      },
    },

    /**
     * O volume que o ambiente aplica a este app. **Só de leitura, e a maioria dos apps não
     * precisa disto**: o shim já multiplica a mídia e já interpõe o GainNode: um app que não
     * chame nada aqui obedece ao mixer do mesmo jeito.
     *
     * Serve a quem desenha o PRÓPRIO controle de volume e quer mostrar o estado real, e a quem
     * quer pausar o trabalho enquanto está mudo (um visualizador de espectro, por exemplo).
     *
     * O que NÃO fazer: reagir a `onChange` escrevendo `el.volume`. Isso é o que o shim já faz,
     * e escrever por cima só desfaz a multiplicação.
     */
    audio: {
      /** Ganho efetivo, de 0 a 1. Já leva o mudo em conta — mudo devolve 0. */
      gain()  { return inDesktop ? _efetivo() : 1; },
      muted() { return inDesktop ? _mudo : false; },
      /** Avisa quando o usuário mexe no mixer. Devolve a função que cancela. */
      onChange(fn) {
        if (!inDesktop) return () => {};
        _ouvintesVol.add(fn);
        return () => _ouvintesVol.delete(fn);
      },
    },

    /**
     * A aparência que o ambiente escolheu — hoje, a cor de destaque do usuário.
     *
     * Ver a seção "A aparência do ambiente" acima para o porquê de reportar em vez de escrever.
     */
    aparencia: {
      /**
       * Os tokens de destaque, ou `null` quando não há ambiente a quem perguntar.
       *
       * ⚠ `null`, e não um objeto com os padrões — de propósito. Os padrões já estão escritos no
       * CSS (`lib/web/tuff/tuff-tokens.css`), que é onde eles precisam estar para a página pintar
       * certo numa aba solta **antes** de qualquer JavaScript rodar. Devolvê-los aqui também faria
       * do hex `#0e639c` uma segunda cópia, e a próxima pessoa a trocar a cor padrão acertaria uma
       * e esqueceria a outra. `null` quer dizer "não sobrescreva nada": o CSS já acertou.
       */
      tokens() { return _tokensDoAmbiente(); },

      /**
       * Avisa quando o usuário troca a cor. Devolve a função que cancela.
       *
       * Só dispara quando o VALOR muda. O shell reescreve o `style` do `<html>` dele por outros
       * motivos (papel de parede, posição da taskbar), e cada um deles acordaria o app para repintar
       * a mesma cor — num app de mídia isso é trabalho no meio de um quadro.
       */
      onChange(fn) {
        const raiz = _raizDoAmbiente();
        if (!raiz || typeof MutationObserver !== 'function') return () => {};
        let ultimo = JSON.stringify(_tokensDoAmbiente());
        const mo = new MutationObserver(() => {
          const agora = _tokensDoAmbiente();
          const serial = JSON.stringify(agora);
          if (serial === ultimo) return;
          ultimo = serial;
          fn(agora);
        });
        try {
          // `attributeFilter` porque o shell escreve as custom properties INLINE: a mudança chega
          // como uma alteração do atributo `style`, não como um evento próprio. Não existe evento
          // próprio — foi procurado, e o `{type:'vssh-theme'}` que um app já escutou nunca existiu.
          mo.observe(raiz, { attributes: true, attributeFilter: ['style', 'data-theme'] });
        } catch {
          return () => {};
        }
        return () => mo.disconnect();
      },
    },

    // "Abra assim" — ex.: o path de "Abrir Terminal Aqui", ou o arquivo que o usuário escolheu
    // abrir com este app (ver o campo `opens` do manifest).
    // ── A central de mídia do ambiente ──────────────────────────────────────
    //
    // O shell já controla tocar, pausar e buscar sozinho: ele alcança o `<video>` deste documento
    // (mesma origem) e mexe nele direto. O que ele NÃO consegue fazer é "próxima faixa" — isso
    // depende de uma FILA, e a fila é do app.
    //
    // ⚠ Declarar é obrigatório, e é o que impede um botão morto. A regra do ambiente é "controle
    // que não morde não é desenhado": sem esta chamada, a central não desenha anterior/próximo, e
    // é a resposta certa para um app que abre um arquivo de cada vez.
    media: {
      /** `{ anterior: bool, proximo: bool }` — o que ESTE app sabe fazer agora. */
      transporte(opcoes) {
        const o = opcoes || {};
        post('media-transporte', { anterior: !!o.anterior, proximo: !!o.proximo });
      },
      /** Recebe `'anterior'` ou `'proximo'`. Um handler por janela; chamar de novo substitui. */
      aoAgir(handler) {
        _midiaHandler = typeof handler === 'function' ? handler : null;
      },
    },

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

  // ── A rede de link: o que iria virar ABA vira janela do ambiente ──────────
  //
  // `vssh.openUrl` acima é a PORTA, e ela pressupõe um app que pede. A maior parte do código que
  // abre link não pede: um `<a target="_blank">` que veio de dentro de uma biblioteca, um
  // `window.open` no fundo de um framework, um ctrl+click da pessoa em cima de um link comum.
  // Nada disso passa por `openUrl`, e tudo isso tira a pessoa do ambiente — o link some para
  // dentro do navegador hospedeiro, onde nada do VSSH existe e onde `http://localhost:3000` é a
  // máquina de quem lê, e não o servidor.
  //
  // ⚠ **Isto é rede, não porta.** Quem sabe do ambiente continua chamando `vssh.openUrl`: é
  // explícito, é `await`ável, e não depende de o clique ter uma das formas que este código
  // reconhece. A rede existe para o código que você não escreveu.
  //
  // ─── Onde ela já morou, e por que mudou de casa ────────────────────────────
  //
  // Ela era do SHELL: o `VsCodeViewerWindow` do `vssh-sso` reescrevia o `open` do iframe do editor
  // de fora. Morreu num refactor de lá, junto com o arquivo — e o defeito voltou inteiro, com o
  // roadmap dizendo por escrito que aquele gancho ficava. Aqui ela viaja com o app: a cópia vai no
  // tarball, e refactor do shell não a alcança.
  //
  // ─── Fora do desktop nada disso acontece ──────────────────────────────────
  //
  // Em dev standalone o navegador hospedeiro **é** o ambiente. Sequestrar o `window.open` ali
  // seria quebrar o único lugar em que ele já está certo.

  /**
   * A URL absoluta `http(s)` que este valor representa, ou `null` quando não é uma.
   *
   * ⚠ **O `null` é o que protege a janela auxiliar do editor.** O `auxiliaryWindowService` do VS
   * Code abre a janela flutuante com `mainWindow.open('' | 'about:blank', …)` e **escreve dentro do
   * documento que voltou**. Sequestrar aquela chamada quebraria "mover editor para nova janela" e
   * ainda mostraria um diálogo de popup bloqueado, porque ele confere o retorno. Vazio, `about:`,
   * `blob:`, `data:` e caminho relativo saem daqui como `null` e seguem para o `open` de verdade.
   *
   * A ausência de base no `new URL` é deliberada: é ela que faz uma URL relativa **não** parsear,
   * e é assim que "abrir outra rota deste app" continua sendo assunto do app.
   */
  function _urlDeAba(bruta) {
    const s = String(bruta ?? '').trim();
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  }

  /**
   * O rastro de cada desvio — e é `debug` de propósito.
   *
   * Este é o instrumento com que a PRÓXIMA fuga é nomeada: a pilha diz qual linha do app (ou do
   * editor) pediu a aba. Em `info` ele seria uma linha por clique, e ruído previsto ensina quem lê
   * a ignorar o console. Em `debug` ele não aparece até alguém ligar o nível Verbose — que é
   * exatamente quando alguém está procurando isto.
   */
  function _desvio(origem, url) {
    console.debug?.(`[vssh] ${origem} → navegador do ambiente: ${url}`, new Error('rastro').stack);
  }

  /**
   * O que `window.open` devolve quando a rede pega a chamada.
   *
   * Não é `null` por um motivo medido: o gancho antigo do shell devolvia um objeto justamente
   * porque o code-server conferia o retorno e avisava "popup bloqueado" quando ele era nulo. Um
   * aviso falso desses manda a pessoa mexer na configuração do navegador por causa de uma janela
   * que abriu — no lugar certo, que ela nem viu ainda.
   *
   * `closed` fica falso porque é a verdade: a janela do ambiente está aberta. Quem chamar `close()`
   * neste toco está falando com um alvo que não existe mais deste lado, e o único efeito honesto é
   * o próprio toco passar a se declarar fechado.
   */
  function _tocoDeJanela() {
    return {
      closed: false,
      close() { this.closed = true; },
      focus() {}, blur() {}, postMessage() {},
    };
  }

  const _ALVOS_DE_ABA = new Set(['_blank', 'blank', '_new']);

  if (inDesktop && typeof window.open === 'function') {
    const abrirDeVerdade = window.open.bind(window);
    window.open = function (url, alvo, feicoes) {
      const destino = _urlDeAba(url);
      if (!destino) return abrirDeVerdade(url, alvo, feicoes);
      _desvio('window.open', destino);
      vssh.openUrl(destino);
      return _tocoDeJanela();
    };
  }

  // ── O clique, em fase de BOLHA e só o que iria para a ação padrão ─────────
  //
  // ⚠ **Bolha, e não captura, é a decisão que importa aqui.** Em captura este ouvinte rodaria
  // ANTES do app e roubaria cliques que o app trata sozinho — um ctrl+click que a app usa para
  // seleção múltipla, por exemplo. Em bolha o handler do app roda primeiro: se ele reivindicou o
  // evento (`preventDefault`), saímos de cena. O que sobra é exatamente o que o navegador ia
  // transformar em aba, que é o que viemos buscar.
  //
  // O preço, escrito para não ser redescoberto: um handler que chama `stopPropagation()` sem
  // `preventDefault()` some daqui e a aba escapa. É raro, e é o lado certo do erro — errar para
  // menos deixa um link fugindo; errar para mais quebra o app.
  if (inDesktop && typeof document !== 'undefined' && document.addEventListener) {
    const aoClicar = (e) => {
      // Já tratado por alguém: a ação padrão não vai acontecer, e não há aba para interceptar.
      if (e.defaultPrevented) return;
      // Só o botão esquerdo (com modificador) e o do meio abrem aba. O direito abre menu.
      const meio = e.button === 1;
      if (!meio && e.button !== 0) return;

      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      // `download` diz que este link vira ARQUIVO, não navegação — mandá-lo ao navegador do
      // ambiente trocaria um download por uma janela.
      if (a.hasAttribute?.('download')) return;

      const novaAba = _ALVOS_DE_ABA.has(String(a.target || '').toLowerCase());
      if (!meio && !novaAba && !(e.ctrlKey || e.metaKey)) return;

      // `a.href` já vem absoluto do DOM. Num `<a>` de SVG ele é um objeto, não string — o `String()`
      // de dentro do `_urlDeAba` não parseia, devolve `null`, e o clique segue o caminho normal.
      const destino = _urlDeAba(a.href);
      if (!destino) return;

      e.preventDefault();
      _desvio(meio ? 'clique do meio' : (novaAba ? 'target=_blank' : 'ctrl+clique'), destino);
      vssh.openUrl(destino);
    };
    document.addEventListener('click', aoClicar);
    // `auxclick` é onde o botão do meio chega desde que os navegadores o separaram do `click`.
    document.addEventListener('auxclick', aoClicar);
  }

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

  // Áudio: o hook do `AudioNode.connect` tem de estar no lugar ANTES do app criar o contexto,
  // então isto roda na carga do script e não num evento. A varredura de mídia espera o
  // documento, mas o MutationObserver cobre tudo que nascer depois.
  if (inDesktop) {
    _instalarWebAudio();
    if (typeof document === 'undefined') { /* sem DOM não há mídia a adotar */ }
    else if (document.documentElement || !document.addEventListener) _iniciarAudio();
    else document.addEventListener('DOMContentLoaded', _iniciarAudio, { once: true });
  }

  // Puxa os grants já na carga do script, sem esperar o push do shell no `load` do iframe: o
  // `urlFor()` é síncrono e um app pode montar um `<img src>` antes daquele evento. As duas vias
  // convergem para a mesma lista; a corrida, se sobrar, custa um aviso no console e nada mais.
  if (inDesktop) call('grants', {}, { timeout: 5000 }).then(adoptGrants).catch(() => {});
})();
