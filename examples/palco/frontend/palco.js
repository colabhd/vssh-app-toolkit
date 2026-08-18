/* Palco — o comportamento.
 *
 * ─── A decisão que organiza o arquivo inteiro ───────────────────────────────
 *
 * ⚠ **Quem sabe o que esta máquina toca é esta máquina**, e por isso a primeira coisa que o app faz
 * é se perguntar. O perfil vai junto com o caminho em `api/abrir`, e o servidor decide o modo com
 * as duas metades na mão. Um servidor decidindo sozinho, por tabela, transcodificaria a 180% de CPU
 * para metade dos clientes — e entregaria a eles vídeo pior que o original.
 *
 * Daí saem dois caminhos, e eles são MUITO diferentes:
 *
 *   direto   `vssh.fs.urlFor(caminho)` → o portal serve com Range, busca nativa, zero CPU.
 *            O backend não vê um byte.
 *   cano     `api/fluxo` → ffmpeg. Sem Content-Length, sem Range, sem busca do navegador. A régua
 *            verdadeira vem do `ffprobe` e entra na `TuffMidia` por `opcoes.tempo`; buscar é
 *            reiniciar o cano com `?t=`.
 *
 * ⚠ **Nada roda até o `DOMContentLoaded`**, e não é zelo: `criar_spa_estatica` injeta os scripts
 * antes de `</head>` e **sem `defer`** — de propósito, porque o shim precisa existir antes dos
 * scripts diferidos de qualquer bundle. O efeito é que este arquivo executa com o `<body>` ainda
 * vazio: `getElementById` devolve `null` e a primeira linha que ligar um ouvinte lança. O app
 * inteiro morre ali, e o sintoma é uma janela que aparece e não faz nada.
 */
function montarPalco() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const palco = $('palco');

  // ── O perfil desta máquina ──────────────────────────────────────────────
  //
  // ⚠ `canPlayType`, e **não** `MediaSource.isTypeSupported`. São perguntas diferentes:
  //
  //   canPlayType(t)          "eu demuxo isto sozinho?"  → o caminho DIRETO, que é `<video src>`
  //   MediaSource.isType…(t)  "eu aceito por MSE?"       → para onde um remux teria de ir
  //
  // Medido em Chrome 151, elas discordam em metade dos containers que importam: `matroska`, `flac`
  // e `ogg/opus` são "sim" na primeira e "não" na segunda. Perguntar a errada faria o servidor
  // remuxar todo `.mkv` — o formato mais comum de filme que existe — por nada.

  const CONTAINERS = {
    mp4: 'video/mp4; codecs="avc1.640028"',
    webm: 'video/webm; codecs="vp9"',
    matroska: 'video/x-matroska; codecs="avc1.640028"',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mpegts: 'video/mp2t; codecs="avc1.640028"',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    ogg: 'audio/ogg; codecs="opus"',
  };
  const VIDEO = {
    h264: 'video/mp4; codecs="avc1.640028"',
    hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    vp9: 'video/webm; codecs="vp9"',
    vp8: 'video/webm; codecs="vp8"',
    av1: 'video/mp4; codecs="av01.0.05M.08"',
    mpeg4: 'video/mp4; codecs="mp4v.20.8"',
  };
  const AUDIO = {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    opus: 'audio/webm; codecs="opus"',
    vorbis: 'audio/webm; codecs="vorbis"',
    flac: 'audio/flac',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
  };

  function sondarPerfil() {
    const v = document.createElement('video');
    // ⚠ `canPlayType` devolve `''`, `'maybe'` ou `'probably'`. `'maybe'` só conta quando NÃO demos
    // parâmetro `codecs` — ali ele é a resposta mais forte que a API sabe dar (`audio/wav` é o
    // caso). Com codecs declarados, `'maybe'` é dúvida de verdade, e a assimetria manda recusar:
    // um "não" errado custa 2% de CPU no servidor; um "sim" errado custa tela preta.
    const serve = (t) => {
      const r = v.canPlayType(t);
      return r === 'probably' || (r === 'maybe' && !t.includes('codecs'));
    };
    const lista = (mapa) => Object.keys(mapa).filter((k) => serve(mapa[k]));
    return { containers: lista(CONTAINERS), video: lista(VIDEO), audio: lista(AUDIO) };
  }

  const PERFIL = sondarPerfil();

  // ── Estado ──────────────────────────────────────────────────────────────
  let atual = null;      // a resposta de `api/abrir`
  let base = 0;          // onde o cano foi cortado: `atual()` = base + video.currentTime
  let vizinhos = [];     // os irmãos de pasta
  let indice = -1;
  // ⚠ Toda abertura ganha um número, e as respostas assíncronas dela conferem o seu antes de tocar
  // no estado. Sem isso, abrir B enquanto A ainda carrega faz a resposta de A — que chega depois —
  // sobrescrever a lista de B, e o "próximo" passa a apontar para a pasta errada.
  let geracao = 0;
  let repetir = 'nao';   // nao | lista | uma
  let aleatorio = false;
  let filtro = '';

  // ── O idioma de quem assiste ────────────────────────────────────────────
  //
  // ⚠ **Sem isto o YouTube devolve o título TRADUZIDO**, e não uma interface em inglês. O yt-dlp
  // fixa `hl: "en"` quando ninguém diz o contrário; medido buscando "receita de bolo", os mesmos
  // vídeos brasileiros voltam como "I MADE IT IN 4 MINUTES!! THE SIMPLEEST AND CHEAPEST CAKE".
  // Quem busca em português recebe uma grade em inglês macarrônico e conclui que o app procurou
  // no lugar errado.
  //
  // ⚠ E o valor vai CRU de propósito: `navigator.language` devolve `pt-BR`, que o YouTube **não
  // aceita** — quem negocia (`pt-BR` → `pt`) é o servidor, contra a lista que mora dentro do
  // yt-dlp e muda com ele. Traduzir aqui congelaria uma cópia dessa lista no navegador.
  const IDIOMA = navigator.language || '';
  const comIdioma = (rota) => (IDIOMA ? `${rota}&hl=${encodeURIComponent(IDIOMA)}` : rota);

  /**
   * Uma chamada à API do app. O corpo do ERRO viaja junto, e isso não é cortesia.
   *
   * ⚠ **A versão anterior jogava o corpo fora**, e com ele tudo que o servidor sabia dizer. Ele
   * manda `erro` e `conserto` desde sempre — "este canal não tem vídeos publicados", "este vídeo é
   * protegido por DRM", "o extractor pode estar desatualizado" —, e aqui isso virava
   * `Error('api/yt/abrir: 502')`. Quem chamava só tinha uma frase genérica para pôr na tela, e a
   * pessoa ficava com "não abriu" diante de três causas que pedem três respostas diferentes.
   *
   * ⚠ O `youtube.js` ao lado já fazia certo, e a divergência é o defeito: duas portas para a mesma
   * API, uma delas cega. Um `.json()` que falha não pode derrubar a mensagem de erro, então o corpo
   * é opcional — um 502 do portal vem em HTML.
   */
  const api = (rota, opts) => fetch(rota, opts).then(async (r) => {
    let corpo = null;
    try { corpo = await r.json(); } catch { /* nem toda resposta é JSON */ }
    if (!r.ok) {
      throw Object.assign(new Error((corpo && corpo.erro) || `${rota}: ${r.status}`),
                          { corpo: corpo || {}, status: r.status });
    }
    return corpo;
  });

  const tempoDe = (s) => (window.TuffMidia ? TuffMidia.tempo(s) : '--:--');

  // ── Onde buscar os bytes ────────────────────────────────────────────────

  const noCano = () => !!atual && atual.modo !== 'direto' && atual.modo !== 'desconhecido';

  function urlDoCano(t) {
    const p = new URLSearchParams({ caminho: atual.caminho, t: String(Math.floor(t || 0)) });
    p.set('perfil', JSON.stringify(PERFIL));
    // ⚠ Sem barra inicial. O app é servido sob `/<serverId>/proxy/app/<id>/`, e um `/api/…` sairia
    // do prefixo — chegando num 404 do portal em vez do backend.
    return `api/fluxo?${p}`;
  }

  function duracaoReal() {
    if (atual && atual.duracao) return atual.duracao;   // o ffprobe sabe; o cano não
    return video.duration;
  }
  function agoraReal() {
    return noCano() ? base + video.currentTime : video.currentTime;
  }

  function buscar(t) {
    const alvo = Math.max(0, Math.min(t, (duracaoReal() || 0)));
    if (!noCano()) { video.currentTime = alvo; return; }
    // Busca do lado do SERVIDOR: o cano não tem Range, então trocar de posição é reiniciar o
    // ffmpeg com `-ss`. O `base` é o que faz a linha do tempo continuar mostrando o tempo do
    // FILME, e não o do pedaço que está chegando.
    const tocando = !video.paused;
    base = alvo;
    mostrarPreparando(true);
    video.src = urlDoCano(alvo);
    video.load();
    if (tocando) video.play().catch(() => {});
  }

  // ── Abrir ───────────────────────────────────────────────────────────────

  function mostrarPreparando(sim, texto) {
    $('preparando').hidden = !sim;
    if (texto) $('preparando-t').textContent = texto;
  }

  /**
   * O aviso, sobre o palco.
   *
   * ⚠ Ele NÃO some sozinho, ao contrário de `.retomar`. Um aviso que expira é um aviso que quem
   * saiu da janela por dez segundos nunca leu — e a pessoa volta para um vídeo parado sem
   * explicação, que é exatamente o estado que ele existe para evitar. Sai quando o próximo arquivo
   * abre, que é o momento em que ele deixou de valer.
   */
  function avisar(texto) {
    $('aviso-t').textContent = texto || '';
    $('aviso').hidden = !texto;
  }

  /**
   * Abre um item da fila — venha ele da pasta ou de uma playlist do YouTube.
   *
   * ⚠ **A fila é UMA**, e é o que faz próximo/anterior, `ended`, repetir, aleatório e os botões da
   * central de mídia funcionarem para as duas origens sem nenhum deles saber que existem duas. Uma
   * segunda lista, só para o YouTube, seria seis lugares para as duas divergirem — e cada
   * divergência apareceria como "o próximo não anda" num dos casos.
   */
  /** `/home/ana/Vídeos/aula.mkv` → `/home/ana/Vídeos`. Serve nas duas convenções de separador (a barra do Windows entra por código, para
   *  não virar escape dentro desta própria string).  */
  function pastaDe(caminho) {
    const s = String(caminho || '');
    const corte = Math.max(s.lastIndexOf('/'), s.lastIndexOf(String.fromCharCode(92)));
    return corte > 0 ? s.slice(0, corte) : '';
  }

  function abrirVizinho(v) {
    if (!v) return undefined;
    // ⚠ A fila viaja JUNTO ao andar nela. `abrirYoutube` limpa `vizinhos` na entrada — o que é
    // certo, senão a lista do vídeo anterior sobreviveria e o "próximo" apontaria para outra
    // coisa —, e sem repassá-la aqui o segundo item da playlist seria o último: a fila teria
    // exatamente um passo de vida.
    if (v.videoId) {
      return abrirYoutube(`https://www.youtube.com/watch?v=${v.videoId}`, { fila: vizinhos });
    }
    return abrir(v.caminho);
  }

  async function abrir(caminho, opcoes) {
    const o = opcoes || {};
    const minha = ++geracao;
    avisar('');
    // ⚠ A lista some ANTES do `await`. Ela é dos vizinhos do arquivo ANTERIOR até `api/vizinhos`
    // responder, e nesse intervalo qualquer `ended` avançaria pela pasta errada — que é como uma
    // falha no primeiro quadro conseguiu pôr o vídeo anterior de volta na tela.
    vizinhos = [];
    indice = -1;
    porCentralDeMidia();   // pelo mesmo motivo de `abrirYoutube`: a fila anterior não sobrevive
    soltarDash();
    mostrarPreparando(true, 'Abrindo…');
    let r;
    try {
      r = await api('api/abrir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caminho, perfil: PERFIL }),
      });
    } catch (e) {
      if (minha !== geracao) return;
      mostrarPreparando(false);
      avisar('Não consegui abrir este arquivo.');
      return;
    }
    if (minha !== geracao) return;   // alguém abriu outra coisa enquanto isto voltava

    atual = r;
    base = 0;
    $('vazio-palco').hidden = true;
    $('agora-nome').textContent = r.nome;
    document.title = `${r.nome} — Palco`;

    if (r.modo === 'desconhecido') {
      mostrarPreparando(false);
      avisar('Não reconheci este arquivo como mídia.');
      return;
    }

    // Onde começar: a retomada, a não ser que alguém tenha pedido o início.
    const de = o.doInicio ? 0 : (r.retomarEm || 0);

    if (noCano()) {
      base = de;
      // ⚠ `preload` muda com o modo, e a diferença é grande no cano. `metadata` manda o navegador
      // pegar o cabeçalho e SUSPENDER a rede — mas um cano não tem Range, então retomar de onde
      // parou é impossível: reatar significa um ffmpeg NOVO, do zero, sobre o mesmo filme. No
      // caminho direto `metadata` continua certo, porque ali suspender é de graça e retomar é um
      // Range.
      video.preload = 'auto';
      // O cano leva um instante até o primeiro fragmento. Sem dizer isso, esses segundos parecem
      // travamento e a pessoa clica de novo — que reinicia o ffmpeg e piora.
      mostrarPreparando(true, 'Preparando o vídeo…');
      video.src = urlDoCano(de);
    } else {
      video.preload = 'metadata';
      mostrarPreparando(false);
      video.src = vssh.fs.urlFor(caminho);
      if (de) video.addEventListener('loadedmetadata', () => { video.currentTime = de; },
                                    { once: true });
    }
    video.load();
    video.play().catch(() => { /* autoplay recusado: o botão continua ali */ });

    mostrarRetomar(o.doInicio ? 0 : r.retomarEm);
    // Aqui o ambiente conseguiria adivinhar — o caminho está na URL do cano —, mas declarar custa
    // uma linha e tira a adivinhação do caminho: a pasta é um subtítulo melhor que o título da
    // janela, que repete o nome do arquivo que já está na linha de cima.
    vssh.media?.agora?.({
      titulo: r.nome,
      subtitulo: pastaDe(r.caminho),
    });
    aplicarLegendas(r);
    carregarVizinhos(caminho, minha);
    porMediaSession(r);
  }

  // ── O YouTube ───────────────────────────────────────────────────────────
  //
  // ⚠ **O dash.js é carregado SOB DEMANDA, e isso é uma decisão, não uma otimização.** São 714 KB
  // vendorizados no pacote (`vendor/PROCEDENCIA.md` diz de onde vieram e por quê). Injetá-los junto
  // com o resto faria quem abre um `.mkv` da própria pasta baixar um cliente DASH inteiro para
  // nunca usá-lo — e abrir arquivo local é o caso PRINCIPAL deste app, não o secundário.
  //
  // O `<video>` é o mesmo, e o transporte é o mesmo. Um vídeo do YouTube não é outra tela: é outra
  // fonte de bytes para o player que já existe.

  let dashPromessa = null;
  let dashPlayer = null;

  function carregarDash() {
    if (dashPromessa) return dashPromessa;
    dashPromessa = new Promise((ok, erro) => {
      const s = document.createElement('script');
      // Sem barra inicial, pelo mesmo motivo de `urlDoCano`: o app é servido sob um prefixo.
      s.src = 'vendor/dash.mediaplayer.min.js';
      s.onload = () => (window.dashjs ? ok(window.dashjs) : erro(new Error('dash.js não expôs a API')));
      s.onerror = () => erro(new Error('não consegui carregar o dash.js'));
      document.head.appendChild(s);
    }).catch((e) => { dashPromessa = null; throw e; });   // deixa a próxima tentativa acontecer
    return dashPromessa;
  }

  /**
   * Desmonta o player DASH, antes de qualquer outra fonte assumir o `<video>`.
   *
   * ⚠ **Isto é higiene, e não o conserto de um sintoma — medido.** Eu esperava que sem o `destroy`
   * o dash.js segurasse `MediaSource` e `SourceBuffer` no elemento e o arquivo local não tocasse.
   * Não é o que acontece com o dash.js 5.2: nos dois cenários que exercitei — YouTube → arquivo
   * local, e YouTube → outro YouTube — o resultado foi indistinguível com e sem ele (1,56 s contra
   * 1,57 s de reprodução, 52 quadros nos dois, zero pedidos de bytes vazando depois da troca).
   *
   * Fica porque liberar explicitamente o que a API mandou criar é o certo — o objeto carrega
   * timers, ouvintes e buffers —, e porque a próxima versão da biblioteca não deve nada à
   * tolerância desta. Mas o comentário não vai afirmar um defeito que eu não consegui demonstrar.
   */
  function soltarDash() {
    if (!dashPlayer) return;
    try { dashPlayer.destroy(); } catch { /* já caiu */ }
    dashPlayer = null;
  }

  /**
   * O endereço é uma LISTAGEM (playlist, canal, busca) ou um vídeo?
   *
   * ⚠ A pergunta é de rota, e por isso é respondida aqui e não no servidor: a diferença decide
   * qual ABA abre, e esperar uma ida ao backend para saber isso mostraria o player vazio por meio
   * segundo antes de trocar de tela. O backend continua sendo quem decide o que a URL É — este
   * reconhecimento é grosseiro de propósito, e o que ele errar cai no caminho do vídeo, que já
   * sabe devolver ao navegador o que não é dele.
   */
  function ehListagem(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) return null;
    if (u.pathname === '/playlist' && u.searchParams.get('list')) return 'playlist';
    if (u.pathname === '/results') return 'busca';
    if (/^\/(@|c\/|user\/|channel\/)/.test(u.pathname)) return 'canal';
    return null;
  }

  async function abrirYoutube(url, opcoes) {
    const o = opcoes || {};
    const minha = ++geracao;
    avisar('');
    vizinhos = [];
    indice = -1;
    // ⚠ **Declarar a fila VAZIA aqui, e não só quando uma fila chega.** Um vídeo solto do YouTube
    // nunca chama `porFila`, então a central de mídia ficava com a declaração do que tocou ANTES —
    // anterior/próximo desenhados sobre uma fila que não existe mais, e clicá-los não faz nada.
    // É o mesmo formato do defeito da lista de vizinhos atrasada: estado correto, pintura velha.
    porCentralDeMidia();
    soltarDash();
    mostrarPreparando(true, 'Consultando o YouTube…');

    let r;
    try {
      r = await api(comIdioma(`api/yt/abrir?url=${encodeURIComponent(url)}`));
    } catch (e) {
      if (minha !== geracao) return;
      mostrarPreparando(false);
      // ⚠ E aqui NÃO ficamos com o link: quem não consegue mostrar devolve. A pessoa clicou num
      // link e tem de chegar a algum lugar, mesmo que não seja aqui.
      //
      // ⚠ A frase vem do SERVIDOR, e é a diferença entre "não abriu" e "não abre aqui, e por quê".
      // Ele distingue DRM (que nenhum player nosso remonta) de extractor velho (que o botão de
      // Ferramentas conserta) do que o próprio YouTube recusou — e mandar a pessoa para o conserto
      // errado gasta a única pista que ela tinha.
      const c = e.corpo || {};
      avisar([c.erro || 'Não consegui abrir este vídeo do YouTube.', c.conserto]
        .filter(Boolean).join(' '));
      vssh.openUrl(url, { destino: 'navegador' });
      return;
    }
    if (minha !== geracao) return;

    // ⚠ `!r` faz parte da guarda, e não é paranoia: um corpo `null` é JSON válido, então o `fetch`
    // resolve, o `.json()` resolve, e a linha seguinte levanta `TypeError` sem que nada tenha
    // "falhado" — a pessoa fica com o spinner e o link some. Custou um teste que media nada.
    if (!r || r.tipo !== 'video') {
      // Playlist, canal e busca ainda não têm tela. Devolver é o caminho honesto — e é o que
      // impede o deeplink de virar beco.
      mostrarPreparando(false);
      vssh.openUrl(url, { destino: 'navegador' });
      return;
    }

    let dashjs;
    try {
      dashjs = await carregarDash();
    } catch (e) {
      if (minha !== geracao) return;
      mostrarPreparando(false);
      avisar('Não consegui carregar o player de streaming.');
      return;
    }
    if (minha !== geracao) return;

    // ⚠ A troca de aba mora AQUI, e não em quem chama. Ela tem de acontecer depois de saber que é
    // um vídeo — antes, um endereço que vai voltar ao navegador deixaria a pessoa olhando um
    // palco vazio — e tem de valer para as DUAS portas: o link roteado e o duplo-clique num
    // cartão da grade. Estava só na primeira, e abrir pela grade tocava o vídeo deixando a tela
    // na aba de busca: o som começava e não havia imagem em lugar nenhum.
    irPara('reproduzindo');

    // ⚠ `atual` finge um arquivo em modo direto de propósito. É o que faz `noCano()` responder
    // falso — e tem de responder: o DASH tem busca nativa por Range, e mandá-lo pelo caminho do
    // cano trocaria um `seek` instantâneo por um ffmpeg reiniciando do zero, que aqui nem existe.
    atual = {
      caminho: null, nome: r.titulo, duracao: r.duracao, modo: 'direto',
      temVideo: true, audios: [], legendas: [], youtube: r,
    };
    base = 0;
    $('vazio-palco').hidden = true;
    $('agora-nome').textContent = r.titulo;
    document.title = `${r.titulo} — Palco`;

    // ⚠ **A URL do manifesto vai ABSOLUTA, e é o dash.js quem obriga.** Ele resolve o `<BaseURL>`
    // contra o endereço do MANIFESTO e propaga o que recebeu: dando-lhe uma URL relativa, todo
    // segmento fica relativo também, e aí o CMCD faz `new URL(<relativa>)` a cada resposta e
    // registra `Failed to construct 'URL': Invalid URL` no console — uma linha por segmento,
    // enterrando qualquer erro de verdade que apareça no meio.
    //
    // ⚠ `document.baseURI`, e não `location.href` com um caminho qualquer: o app é servido sob
    // `/<serverId>/proxy/app/palco/`, e é essa base — a mesma que resolve todo `fetch` relativo
    // deste arquivo — que tem de valer aqui. Foi uma barra a mais que já custou uma reprodução
    // inteira (`/api/yt/mpd`) e uma barra a menos que custou outra (`api/yt/api/yt/bytes`).
    const manifesto = new URL(r.mpd, document.baseURI).href;

    dashPlayer = dashjs.MediaPlayer().create();
    // ⚠ **Sem este ouvinte a tela fica presa em "Preparando" para sempre**, e o defeito só apareceu
    // ao investigar por que uma mutação não mordia. Quem esconde a faixa no caminho normal são os
    // eventos `loadeddata`/`playing` do próprio `<video>` — e quando o dash.js falha (um MPD que
    // não carrega, um segmento recusado, um codec que a máquina não aceita) nenhum dos dois chega.
    // Nada falha visivelmente: a pessoa fica olhando um spinner que não termina.
    // ⚠ **Um erro de segmento NÃO é o fim da reprodução, e tratá-lo como fim foi um defeito
    // medido em uso:** o vídeo ficou parado um tempo, e ao voltar a pessoa recebeu
    // "A reprodução falhou". A causa mais provável é a credencial do googlevideo — ela vale 6 h e
    // o YouTube gira chaves antes disso —, e o servidor RESOLVE isso sozinho: `url_de` re-resolve
    // quando a URL está por vencer, e o proxy tenta de novo quando ela é recusada.
    //
    // O que faltava era o outro lado. O manifesto aponta para nós, então refazê-lo do mesmo ponto
    // é barato e pega exatamente esse caso: as trilhas são as mesmas, as URLs são as nossas, e o
    // backend entrega credenciais novas. Uma tentativa, e só: um erro que persiste é um erro de
    // verdade, e insistir para sempre seria um vídeo que nunca diz que não vai tocar.
    // ⚠ **`seek()` logo depois de `initialize()` LANÇA, e foi assim que um vídeo voltou sozinho
    // para o começo no meio da reprodução.** O `seek` do dash.js abre com
    // `if (!streamingInitialized) throw` — e a inicialização do streaming é assíncrona: ela espera o
    // manifesto chegar. Chamá-lo na linha seguinte é sempre cedo demais.
    //
    // Os dois efeitos foram medidos no fonte da biblioteca, e o segundo é pior que o relatado:
    //
    //   · na RETOMADA (dentro do ouvinte de erro) a exceção morre no despachante de eventos do
    //     dash.js, o `seek` não acontece, e o vídeo reinicia do zero. É o "do nada ele parou e
    //     voltou pro começo";
    //   · no caminho NORMAL a exceção rejeita `abrirYoutube` e mata tudo que vem depois — legendas,
    //     `mostrarRetomar`, `porMediaSession`, `vssh.media.agora` e a fila. Sem uma linha na tela.
    //     Só não mordia sempre porque só acontece quando há um `&t=` no link ou uma marca gravada.
    //
    // A saída é a própria API: `initialize(view, source, autoPlay, startTime)` — o quarto parâmetro
    // (`r = NaN` na assinatura de 5.2.1) desce até o `attachSource`, e é aplicado quando o stream
    // fica pronto, que é o único momento em que ele pode ser aplicado.
    const DO_COMECO = NaN;   // o que a assinatura da biblioteca usa para "não busque nada"
    let jaTentouDeNovo = false;
    dashPlayer.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      if (minha !== geracao) return;
      const msg = (e && e.error && (e.error.message || e.error.code)) || '';

      if (!jaTentouDeNovo) {
        jaTentouDeNovo = true;
        const onde = video.currentTime || r.t || 0;
        mostrarPreparando(true, 'Retomando…');
        try {
          dashPlayer.destroy();
        } catch { /* já caiu */ }
        dashPlayer = dashjs.MediaPlayer().create();
        dashPlayer.on(dashjs.MediaPlayer.events.ERROR, (e2) => {
          if (minha !== geracao) return;
          const m2 = (e2 && e2.error && (e2.error.message || e2.error.code)) || msg;
          mostrarPreparando(false);
          avisar(`A reprodução deste vídeo do YouTube falhou${m2 ? ` (${m2})` : ''}.`);
        });
        dashPlayer.initialize(video, manifesto, true, onde > 0 ? onde : DO_COMECO);
        return;
      }

      mostrarPreparando(false);
      avisar(`A reprodução deste vídeo do YouTube falhou${msg ? ` (${msg})` : ''}.`);
    });
    // ⚠ O `&t=` do link GANHA da marca, e a ordem não é arbitrária: quem compartilhou "o vídeo a
    // partir dos 4:12" está dizendo onde começar, e sobrepor isso com "onde EU parei" ignoraria o
    // pedido de quem mandou o link — sem nada na tela explicando por que ele caiu noutro lugar.
    const de = o.doInicio ? 0 : (r.t || r.retomarEm || 0);
    dashPlayer.initialize(video, manifesto, true, de > 0 ? de : DO_COMECO);

    aplicarLegendasDoYoutube(r);
    mostrarRetomar(o.doInicio || r.t ? 0 : r.retomarEm);
    porMediaSession({ nome: r.titulo, origem: r.canal });
    // ⚠ **Declarar é obrigatório aqui, e não cortesia.** A fonte deste `<video>` é um `blob:` do
    // MediaSource — não há nome de arquivo em URL nenhuma para o ambiente ler. Sem esta linha a
    // central de mídia mostrava o UUID do blob como título, com o nome de verdade caindo na linha
    // de baixo. Ver `vssh.media.agora` no shim.
    vssh.media?.agora?.({
      titulo: r.titulo,
      subtitulo: r.canal,
      capa: `api/yt/miniatura?v=${r.id}`,
    });

    // ⚠ A fila vem DEPOIS de o vídeo já estar tocando, e nunca antes: carregar uma playlist de
    // trinta itens é outra ida ao YouTube, e fazê-la primeiro adiaria a imagem por esse tempo para
    // preencher uma lista que a pessoa talvez nem abra.
    if (o.fila) {
      // Veio da grade, ou de um passo dentro da própria fila: os itens já estão na mão, e pedi-los
      // de novo seria uma consulta inteira para reconstruir o que acabou de ser exibido na tela.
      porFila(o.fila, r.id, minha);
    } else if (r.lista) {
      carregarFila(r.lista, r.id, minha);
    } else {
      // ⚠ **Um vídeo solto também tem de LIMPAR a tela da fila anterior.** `vizinhos` já foi
      // zerado na entrada, mas quem apaga as linhas da Biblioteca é `desenharTabela` — e sem
      // chamá-la aqui a lista antiga fica na tela, com uma linha marcada como "tocando" que não
      // está tocando nada. O defeito é de PINTURA sobre um estado correto, que é a variedade mais
      // difícil de enxergar: o `<video>` está certo, os botões estão certos, e a tela mente.
      porFila([], null, minha);
    }
  }

  /**
   * A fila do YouTube assume, com o vídeo atual localizado dentro dela.
   *
   * ⚠ `fila` chega SEMPRE no formato interno (`{nome, videoId}`), venha da grade, do backend ou de
   * um passo anterior na própria fila. Aceitar dois formatos aqui — `{titulo, id}` e
   * `{nome, videoId}` — seria uma linha hoje e um lugar para o campo errado passar em silêncio
   * depois; quem converte é quem conhece a origem.
   */
  function porFila(fila, videoAtual, minha) {
    if (minha !== undefined && minha !== geracao) return;
    vizinhos = fila || [];
    indice = vizinhos.findIndex((v) => v.videoId === videoAtual);
    desenharTabela();
    porCentralDeMidia();
  }

  async function carregarFila(lista, videoAtual, minha) {
    const url = `https://www.youtube.com/playlist?list=${lista}`;
    try {
      const r = await api(comIdioma(`api/yt/listar?url=${encodeURIComponent(url)}`));
      if (minha !== geracao) return;
      $('bib-pasta').textContent = r.titulo || 'Playlist';
      porFila((r.itens || []).map((i) => ({ nome: i.titulo, videoId: i.id })), videoAtual, minha);
    } catch {
      // ⚠ Silêncio de propósito, e é a mesma regra de `carregarVizinhos`: a fila é secundária, e o
      // vídeo que a pessoa pediu está tocando. Um aviso sobre a lista por cima de um vídeo que
      // funciona diria que algo quebrou quando nada do que ela pediu quebrou.
    }
  }

  function mostrarRetomar(seg) {
    const faixa = $('retomar');
    if (!seg) { faixa.hidden = true; return; }
    $('retomar-t').textContent = tempoDe(seg);
    faixa.hidden = false;
    faixa.classList.remove('retomar--saindo');
    clearTimeout(mostrarRetomar._t);
    mostrarRetomar._t = setTimeout(() => {
      faixa.classList.add('retomar--saindo');
      setTimeout(() => { faixa.hidden = true; }, 300);
    }, 6000);
  }

  $('btn-do-inicio').addEventListener('click', () => {
    $('retomar').hidden = true;
    if (!atual) return;
    if (noCano()) buscar(0); else video.currentTime = 0;
    video.play().catch(() => {});
  });

  // ── Legendas ────────────────────────────────────────────────────────────
  //
  // ⚠ Só as de TEXTO chegam aqui — o backend já filtrou PGS e VobSub, que são bitmaps e viram um
  // VTT vazio sem erro nenhum. Oferecer uma legenda que não aparece na tela ensina a pessoa a
  // concluir que o player não sabe mostrar legenda.

  function aplicarLegendas(r) {
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    for (const l of r.legendas || []) {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = l.titulo || nomeDeIdioma(l.idioma) || `Legenda ${l.indice}`;
      if (l.idioma) t.srclang = l.idioma;
      t.src = `api/legenda?caminho=${encodeURIComponent(r.caminho)}&faixa=${l.indice}`;
      video.appendChild(t);
    }
    // Nenhuma ligada por padrão: legenda é escolha, e ligar sozinho tampa a imagem de quem não
    // pediu. O menu Legenda é onde ela se liga.
    for (const t of video.textTracks) t.mode = 'disabled';
  }

  /**
   * As legendas de um vídeo do YouTube — mesmo `<track>`, mesma lista, mesmo menu.
   *
   * ⚠ **A URL não pode ser a do YouTube**, e não é uma escolha: `<track>` é sujeito à mesma origem
   * e o host das legendas não responde CORS. Ela vem pelo nosso servidor, como todo o resto.
   *
   * ⚠ E o `<track>` entra DEPOIS do `initialize` do dash.js. Ele é filho do mesmo `<video>` que o
   * dash.js está montando, e acrescentar filhos a um elemento no meio de uma troca de fonte é
   * pedir para descobrir a ordem por acidente.
   */
  function aplicarLegendasDoYoutube(r) {
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    for (const l of r.legendas || []) {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      // O `(automática)` no rótulo é o que permite decidir: legenda automática de fala espontânea
      // erra nomes próprios e pontuação, e sem a marca a escolha entre "Português" e "Português"
      // seria no escuro.
      const nome = l.nome || nomeDeIdioma(l.idioma) || l.idioma;
      t.label = l.automatica ? `${nome} (automática)` : nome;
      if (l.idioma) t.srclang = l.idioma;
      t.src = `api/yt/legenda?v=${encodeURIComponent(r.id)}`
            + `&idioma=${encodeURIComponent(l.idioma)}${l.automatica ? '&auto=1' : ''}`;
      video.appendChild(t);
    }
    for (const t of video.textTracks) t.mode = 'disabled';
  }

  // Os de TRÊS letras vêm do ffmpeg (arquivo local); os de DUAS, do YouTube. Os dois idiomas de
  // código convivem porque as duas origens convivem no mesmo menu.
  const IDIOMAS = { por: 'Português', pob: 'Português (BR)', eng: 'Inglês', spa: 'Espanhol',
                    fra: 'Francês', fre: 'Francês', deu: 'Alemão', ger: 'Alemão', ita: 'Italiano',
                    jpn: 'Japonês', kor: 'Coreano', rus: 'Russo', zho: 'Chinês', chi: 'Chinês',
                    pt: 'Português', 'pt-br': 'Português (BR)', 'pt-pt': 'Português (PT)',
                    en: 'Inglês', es: 'Espanhol', fr: 'Francês', de: 'Alemão', it: 'Italiano',
                    ja: 'Japonês', ko: 'Coreano', ru: 'Russo', zh: 'Chinês' };
  const nomeDeIdioma = (c) => (c ? (IDIOMAS[c.toLowerCase()] || c.toUpperCase()) : null);

  function rotuloDeFaixa(f) {
    // O que faz um seletor ser escolhível: idioma e título, e os canais só quando há mais de dois
    // (é o que distingue "original 5.1" de "estéreo compatível").
    const partes = [nomeDeIdioma(f.idioma), f.titulo].filter(Boolean);
    if (!partes.length) partes.push(`Faixa ${f.indice}`);
    if (f.canais > 2) partes.push(`${f.canais} canais`);
    return partes.join(' · ');
  }

  // ── O player da biblioteca ──────────────────────────────────────────────

  TuffMidia.player(palco.closest('.janela'), video, {
    tempo: { duracao: duracaoReal, atual: agoraReal, buscar },
  });

  video.addEventListener('loadeddata', () => mostrarPreparando(false));
  video.addEventListener('playing', () => mostrarPreparando(false));
  video.addEventListener('error', () => {
    mostrarPreparando(false);
    if (!atual) return;
    avisar(noCano()
      ? 'A conversão no servidor falhou. O registro do aplicativo diz o motivo.'
      : 'A reprodução falhou. Tente abrir de novo.');
    console.warn('[palco] erro de mídia', { modo: atual.modo, fonte: video.currentSrc,
                                            codigo: video.error && video.error.code });
  });

  const trocarIcone = (botao, nome) =>
    botao.querySelector('use').setAttribute('href', `#ico-${nome}`);

  video.addEventListener('play', () => trocarIcone($('btn-play'), 'pause'));
  video.addEventListener('pause', () => trocarIcone($('btn-play'), 'play'));
  video.addEventListener('volumechange', () =>
    trocarIcone($('btn-mudo'), video.muted || !video.volume ? 'volume-off' : 'volume-on'));

  // `TuffMidia.player` liga o clique de `data-tuff-play` e escreve o `aria-label`; o ícone é nosso,
  // e ele o preserva desde que o botão tenha um filho de elemento. (Antes não preservava: era
  // `textContent`, que apagava o `<svg>`. Foi este app que revelou, e o conserto subiu para a lib.)

  // ── Fim de arquivo: repetir, aleatório, próximo ──────────────────────────
  //
  // ⚠ **`ended` não quer dizer que o arquivo acabou** — quer dizer que os bytes acabaram, e no cano
  // as duas coisas se separam. Um ffmpeg que morre no primeiro quadro fecha o corpo, o navegador
  // dispara `ended`, e o avanço automático põe OUTRO vídeo tocando. Foi exatamente o que se viu com
  // um `.avi`: um quadro, e o vídeo anterior de volta. O defeito ficou invisível porque o sintoma
  // não parece falha — parece o player fazendo o que se espera dele.
  //
  // Quem desempata é a régua do `ffprobe`, que é a única coisa aqui que sabe o tamanho do filme.

  function chegouAoFim() {
    const dur = duracaoReal();
    if (!dur || !isFinite(dur)) return true;   // sem régua verdadeira, não há de que desconfiar
    // A tolerância é relativa porque o erro é: o cano termina alguns décimos antes ou depois da
    // duração do contêiner de origem, e um limite fixo reprovaria o fim legítimo de um clipe curto.
    return agoraReal() >= dur - Math.max(3, dur * 0.02);
  }

  video.addEventListener('ended', () => {
    if (!chegouAoFim()) {
      avisar(`A transmissão parou em ${tempoDe(agoraReal())}, antes do fim. `
             + 'O registro do aplicativo diz o motivo.');
      console.warn('[palco] fluxo truncado', { modo: atual && atual.modo, em: agoraReal(),
                                               duracao: duracaoReal() });
      return;
    }
    if (repetir === 'uma') { buscar(0); video.play().catch(() => {}); return; }
    if (!vizinhos.length) return;
    if (aleatorio && vizinhos.length > 1) {
      let i = indice;
      while (i === indice) i = Math.floor(Math.random() * vizinhos.length);
      return abrirVizinho(vizinhos[i]);
    }
    if (indice + 1 < vizinhos.length) return abrirVizinho(vizinhos[indice + 1]);
    if (repetir === 'lista') return abrirVizinho(vizinhos[0]);
  });

  // ── Marcar onde parou ───────────────────────────────────────────────────
  //
  // A cada 15 s e ao pausar/sair. ⚠ `visibilitychange` e não `unload`: num iframe de desktop a
  // janela fecha sem passar por `unload` de forma confiável, e a marca do último trecho some.

  /**
   * Sob que nome este vídeo é lembrado — o caminho do arquivo, ou o id do vídeo do YouTube.
   *
   * ⚠ **Isto respondia 400 quinze em quinze segundos durante toda reprodução do YouTube.** No DASH
   * `atual.caminho` é `null` — não existe arquivo —, e o `null` ia no corpo assim mesmo. O único
   * sinal era uma linha vermelha no console de quem tivesse as ferramentas do navegador abertas;
   * na tela, nada. E o efeito colateral era o recurso inteiro faltando: um vídeo longo do YouTube
   * nunca lembrava onde a pessoa parou.
   */
  function chaveDaMarca() {
    if (!atual) return null;
    if (atual.caminho) return atual.caminho;
    return atual.youtube?.id ? `yt:${atual.youtube.id}` : null;
  }

  function marcar() {
    const chave = chaveDaMarca();
    if (!chave || !video.duration) return;
    navigator.sendBeacon?.('api/marca', new Blob([JSON.stringify({
      caminho: chave, seg: Math.floor(agoraReal()), dur: duracaoReal(),
    })], { type: 'application/json' }));
  }
  setInterval(marcar, 15000);
  video.addEventListener('pause', marcar);
  document.addEventListener('visibilitychange', () => { if (document.hidden) marcar(); });

  // ── Os menus, desenhados pelo AMBIENTE ──────────────────────────────────

  async function menu(botao, itens) {
    const r = botao.getBoundingClientRect();
    const escolha = await vssh.contextMenu(r.left, r.bottom, itens);
    if (escolha) executar(escolha);
  }

  const MENUS = {
    midia: () => [
      { id: 'abrir', label: 'Abrir arquivo…', icon: 'folder' },
      { separator: true },
      { id: 'anterior', label: 'Anterior', disabled: indice <= 0 },
      { id: 'proximo', label: 'Próximo', disabled: indice < 0 || indice + 1 >= vizinhos.length },
      { separator: true },
      { id: 'fechar', label: 'Fechar', danger: true },
    ],
    reproducao: () => [
      { id: 'tocar', label: video.paused ? 'Reproduzir' : 'Pausar' },
      { id: 'parar', label: 'Parar', disabled: !atual },
      { separator: true },
      { id: 'v-10', label: 'Voltar 10 segundos' },
      { id: 'a-10', label: 'Avançar 10 segundos' },
      { separator: true },
      { header: 'Velocidade' },
      ...VELOCIDADES.map((v) => ({ id: `vel:${v}`, label: rotuloVelocidade(v),
                                   checked: video.playbackRate === v })),
      { separator: true },
      { id: 'rep', label: 'Repetir', submenu: [
        { id: 'rep:nao', label: 'Não repetir', checked: repetir === 'nao' },
        { id: 'rep:lista', label: 'Repetir a pasta', checked: repetir === 'lista' },
        { id: 'rep:uma', label: 'Repetir este', checked: repetir === 'uma' },
      ] },
      { id: 'aleat', label: 'Aleatório', checked: aleatorio },
    ],
    video: () => [
      { id: 'tela', label: 'Tela cheia', checked: !!document.fullscreenElement },
      { id: 'pip', label: 'Janela flutuante', checked: !!document.pictureInPictureElement,
        disabled: !document.pictureInPictureEnabled },
    ],
    audio: () => [
      { id: 'mudo', label: 'Mudo', checked: video.muted },
      { separator: true },
      { header: 'Faixa de áudio' },
      ...(atual && atual.audios.length
        ? atual.audios.map((f) => ({ id: `aud:${f.indice}`, label: rotuloDeFaixa(f),
                                     checked: atual.faixaDeAudio === f.indice }))
        : [{ label: 'Nenhuma', disabled: true }]),
    ],
    legenda: () => {
      const faixas = [...video.textTracks];
      return [
        { id: 'leg:-1', label: 'Sem legenda',
          checked: !faixas.some((t) => t.mode === 'showing') },
        ...(faixas.length
          ? faixas.map((t, i) => ({ id: `leg:${i}`, label: t.label, checked: t.mode === 'showing' }))
          : [{ separator: true }, { label: 'Nenhuma neste arquivo', disabled: true }]),
      ];
    },
    ferramentas: () => [
      { id: 'info', label: 'Informações do arquivo', disabled: !atual },
      // ⚠ `atual.caminho`, e não `atual`: um vídeo do YouTube não tem arquivo, e o item habilitado
      // levava um `TypeError` sobre `null.replace` — o menu fechava e nada acontecia.
      { id: 'mostrar', label: 'Mostrar no gerenciador de arquivos', disabled: !atual?.caminho },
      { separator: true },
      { id: 'esquecer', label: 'Esquecer onde parei', disabled: !atual },
      { separator: true },
      { id: 'yt-atualizar', label: 'Atualizar o yt-dlp' },
      { id: 'sobre', label: 'Sobre o Palco' },
    ],
  };

  /**
   * Baixa o yt-dlp mais novo e o põe em uso, sem reabrir o app.
   *
   * ⚠ **É o que impede o Palco de funcionar por um mês e depois parar.** O YouTube quebra extractor
   * toda semana, e o `pip install` da instalação congela a versão; sem esta saída, a única resposta
   * para "parou de abrir vídeo" seria entrar no servidor como root.
   *
   * A frase final diz a VERSÃO, e não "pronto": quando o extractor já estava atualizado, o conserto
   * é outro, e um "pronto" mandaria a pessoa procurar o defeito no lugar errado.
   */
  async function atualizarYtdlp() {
    mostrarPreparando(true, 'Atualizando o yt-dlp…');
    try {
      const r = await api('api/yt/atualizar', { method: 'POST' });
      avisar(r.mudou ? `yt-dlp atualizado: ${r.antes || 'ausente'} → ${r.versao}.`
                     : `O yt-dlp já estava na versão mais nova (${r.versao}).`);
    } catch (e) {
      avisar(`Não consegui atualizar o yt-dlp${e.corpo?.detalhe ? ` (${e.corpo.detalhe})` : ''}.`);
    } finally {
      mostrarPreparando(false);
    }
  }

  /**
   * Que versão está rodando — do app, do extractor e do idioma escolhido.
   *
   * ⚠ **Existe porque a pergunta não tinha resposta, e sem ela um app velho e um conserto que não
   * funcionou são indistinguíveis.** Foi exatamente o que aconteceu: um relato de "a thumbnail
   * ainda não aparece e a lista ainda mostra só a primeira página" descrevia com precisão o
   * comportamento de uma versão anterior à do conserto — e não havia como distinguir isso de um
   * conserto que não pegou, a não ser entrando no servidor.
   *
   * É a mesma fronteira da tag `v4`: o que roda no servidor é outro arquivo do que está no disco
   * de quem escreve, e ninguém percorre as duas pontas.
   */
  async function sobre() {
    let texto = 'Não consegui falar com o servidor do Palco.';
    try {
      const r = await fetch('healthz');
      texto = (await r.text()).trim();
    } catch { /* fica a frase de cima */ }
    // O `healthz` é texto de linhas `chave: valor`. A primeira é o `ok` que o supervisor lê, e
    // ela não diz nada a quem abriu este diálogo.
    const linhas = texto.split('\n').filter((l) => l && l !== 'ok');
    vssh.dialog.alert(linhas.join('\n') || texto, 'Sobre o Palco');
  }

  // ⚠ Sete valores, com o 1× no meio. Ciclar num botão só exigia quatro cliques para chegar ao
  // vizinho e escondia quais são as opções — velocidade é coisa que se troca dezenas de vezes numa
  // sessão de estudo, e cada troca não pode custar uma caçada.
  const VELOCIDADES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const rotuloVelocidade = (v) =>
    (v === 1 ? 'Normal (1×)' : `${String(v).replace('.', ',')}×`);

  function executar(id) {
    if (id.startsWith('vel:')) return velocidade(parseFloat(id.slice(4)));
    if (id.startsWith('rep:')) return porRepetir(id.slice(4));
    if (id.startsWith('aud:')) return trocarAudio(parseInt(id.slice(4), 10));
    if (id.startsWith('leg:')) return trocarLegenda(parseInt(id.slice(4), 10));
    // Do menu de contexto de uma linha da biblioteca: ela diz QUAL, porque o menu foi aberto sobre
    // ela e não sobre a que estava marcada.
    if (id.startsWith('arq:')) {
      const alvo = vizinhos[parseInt(id.slice(4), 10)];
      if (alvo) { abrir(alvo.caminho); irPara('reproduzindo'); }
      return undefined;
    }
    if (id.startsWith('pasta:')) {
      const alvo = vizinhos[parseInt(id.slice(6), 10)];
      if (alvo) vssh.openFolder(alvo.caminho.replace(/[^/\\]+$/, ''));
      return undefined;
    }

    const acoes = {
      abrir: escolherArquivo,
      fechar: () => vssh.window.close(),
      anterior: () => indice > 0 && abrirVizinho(vizinhos[indice - 1]),
      proximo: () => indice >= 0 && indice + 1 < vizinhos.length
                && abrirVizinho(vizinhos[indice + 1]),
      tocar: () => (video.paused ? video.play().catch(() => {}) : video.pause()),
      parar: () => { video.pause(); buscar(0); },
      'v-10': () => buscar(agoraReal() - 10),
      'a-10': () => buscar(agoraReal() + 10),
      aleat: () => porAleatorio(!aleatorio),
      mudo: () => { video.muted = !video.muted; },
      tela: telaCheia,
      pip: janelaFlutuante,
      info: informacoes,
      mostrar: () => atual && vssh.openFolder(atual.caminho.replace(/[^/\\]+$/, '')),
      esquecer: () => {
        // A MESMA chave de `marcar()`. Duas formas de nomear a mesma coisa dariam um "esquecer"
        // que apaga uma entrada que ninguém gravou, deixando a de verdade no lugar.
        const chave = chaveDaMarca();
        if (!chave) return;
        fetch(`api/marca?caminho=${encodeURIComponent(chave)}`, { method: 'DELETE' });
        $('retomar').hidden = true;
      },
      'yt-atualizar': atualizarYtdlp,
      sobre,
    };
    (acoes[id] || (() => {}))();
  }

  for (const b of document.querySelectorAll('.menubar button')) {
    b.addEventListener('click', () => menu(b, MENUS[b.dataset.menu]()));
  }

  // ── O menu de botão direito ─────────────────────────────────────────────
  //
  // ⚠ **Um programa de reprodução sem clique direito não parece um programa.** É onde a mão vai
  // primeiro num player de desktop, e o VLC, o mpv e o Windows Media Player têm todos o mesmo. Sem
  // ele, cada troca de velocidade ou de legenda custava uma viagem até a barra de menu no topo.
  //
  // Quem DESENHA continua sendo o ambiente, pelo mesmo `vssh.contextMenu` da barra de menu — então
  // o menu do Palco se parece com o do gerenciador de arquivos porque é o mesmo menu. E o conteúdo
  // depende de ONDE o clique caiu: um menu único para a janela inteira ofereceria "Mostrar no
  // gerenciador" sobre um cartão do YouTube.
  //
  // ⚠ O `preventDefault` só acontece quando temos menu para aquele alvo. Sobre um campo de texto o
  // menu do navegador (colar, selecionar tudo) é melhor que qualquer coisa que façamos aqui.

  function menuEm(x, y, itens) {
    vssh.contextMenu(x, y, itens).then((escolha) => { if (escolha) executar(escolha); });
  }

  /** O menu do palco: o que se faz com o que está tocando. */
  function menuDoPalco() {
    const faixas = [...video.textTracks];
    return [
      { id: 'tocar', label: video.paused ? 'Reproduzir' : 'Pausar', disabled: !atual },
      { id: 'v-10', label: 'Voltar 10 segundos', disabled: !atual },
      { id: 'a-10', label: 'Avançar 10 segundos', disabled: !atual },
      { separator: true },
      { id: 'anterior', label: 'Anterior', disabled: indice <= 0 },
      { id: 'proximo', label: 'Próximo',
        disabled: indice < 0 || indice + 1 >= vizinhos.length },
      { separator: true },
      { id: 'veloc', label: 'Velocidade', submenu: VELOCIDADES.map((v) => ({
        id: `vel:${v}`, label: rotuloVelocidade(v), checked: video.playbackRate === v })) },
      // ⚠ Submenu de UM nível só — o contrato de `VsshItemDeMenu` não aceita mais, e uma
      // legenda aninhada duas vezes sumiria sem erro.
      { id: 'leg', label: 'Legenda', submenu: [
        { id: 'leg:-1', label: 'Sem legenda',
          checked: !faixas.some((t) => t.mode === 'showing') },
        ...faixas.map((t, i) => ({ id: `leg:${i}`, label: t.label,
                                   checked: t.mode === 'showing' })),
      ] },
      { separator: true },
      { id: 'tela', label: 'Tela cheia', checked: !!document.fullscreenElement },
      { id: 'pip', label: 'Janela flutuante', checked: !!document.pictureInPictureElement,
        disabled: !document.pictureInPictureEnabled },
      { separator: true },
      { id: 'info', label: 'Informações do arquivo', disabled: !atual },
    ];
  }

  document.addEventListener('contextmenu', (e) => {
    // Campo de texto: o menu do navegador serve melhor, e tomar o clique dali seria tirar
    // "colar" de uma caixa de busca.
    if (e.target.closest('input, textarea, [contenteditable]')) return;

    const linha = e.target.closest('.linha-arq');
    if (linha) {
      e.preventDefault();
      // O clique direito SELECIONA antes de abrir, como em qualquer lista: sem isso o menu agiria
      // sobre a linha que estava marcada, e não sobre a que a pessoa apontou.
      const i = Number(linha.dataset.i);
      const alvo = vizinhos[i];
      if (!alvo) return;
      menuEm(e.clientX, e.clientY, [
        { id: `arq:${i}`, label: 'Reproduzir' },
        { id: `pasta:${i}`, label: 'Mostrar no gerenciador de arquivos' },
      ]);
      return;
    }

    if (e.target.closest('#palco, #transporte')) {
      e.preventDefault();
      menuEm(e.clientX, e.clientY, menuDoPalco());
    }
  });

  // ── Os controles do transporte ──────────────────────────────────────────

  $('btn-voltar10').addEventListener('click', () => buscar(agoraReal() - 10));
  $('btn-avancar10').addEventListener('click', () => buscar(agoraReal() + 10));
  $('btn-anterior').addEventListener('click', () => executar('anterior'));
  $('btn-proximo').addEventListener('click', () => executar('proximo'));
  $('btn-pip').addEventListener('click', janelaFlutuante);
  $('btn-tela').addEventListener('click', telaCheia);

  $('btn-veloc').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    vssh.contextMenu(r.left, r.top, [
      { header: 'Velocidade' },
      ...VELOCIDADES.map((v) => ({ id: String(v), label: rotuloVelocidade(v),
                                   checked: video.playbackRate === v })),
    ]).then((x) => x && velocidade(parseFloat(x)));
  });

  $('btn-ajustes').addEventListener('click', (e) => {
    // Contextual: só oferece o que este arquivo tem. Um menu com "Faixa de áudio" vazio informa
    // que o programa é complicado e não ajuda em nada.
    const itens = [];
    if (atual && atual.audios.length > 1) {
      itens.push({ header: 'Faixa de áudio' },
                 ...atual.audios.map((f) => ({ id: `aud:${f.indice}`, label: rotuloDeFaixa(f),
                                               checked: atual.faixaDeAudio === f.indice })));
    }
    const faixas = [...video.textTracks];
    if (faixas.length) {
      if (itens.length) itens.push({ separator: true });
      itens.push({ header: 'Legenda' },
                 { id: 'leg:-1', label: 'Sem legenda',
                   checked: !faixas.some((t) => t.mode === 'showing') },
                 ...faixas.map((t, i) => ({ id: `leg:${i}`, label: t.label,
                                            checked: t.mode === 'showing' })));
    }
    if (!itens.length) itens.push({ label: 'Este arquivo tem uma faixa só', disabled: true });
    const r = e.currentTarget.getBoundingClientRect();
    vssh.contextMenu(r.left, r.top, itens).then((x) => x && executar(x));
  });

  // Tri-estado, e o ícone TROCA no terceiro: cor sozinha distingue dois, não três.
  $('btn-repetir').addEventListener('click', () =>
    porRepetir({ nao: 'lista', lista: 'uma', uma: 'nao' }[repetir]));

  function porRepetir(modo) {
    repetir = modo;
    const b = $('btn-repetir');
    b.setAttribute('aria-pressed', String(modo !== 'nao'));
    trocarIcone(b, modo === 'uma' ? 'repeat-one' : 'repeat');
    b.setAttribute('aria-label',
      { nao: 'Repetir', lista: 'Repetindo a pasta', uma: 'Repetindo este' }[modo]);
    b.title = b.getAttribute('aria-label');
  }

  $('btn-aleatorio').addEventListener('click', () => porAleatorio(!aleatorio));
  function porAleatorio(v) {
    aleatorio = v;
    $('btn-aleatorio').setAttribute('aria-pressed', String(v));
  }

  function velocidade(v) {
    video.playbackRate = v;
    const b = $('btn-veloc');
    b.textContent = `${String(v).replace('.', ',')}×`;
    // Destacado só quando NÃO é o normal: um controle que grita sempre deixa de significar algo.
    b.dataset.alterada = v === 1 ? '0' : '1';
  }

  function trocarAudio(i) {
    if (!atual) return;
    // ⚠ Trocar de faixa muda o que o servidor precisa fazer, então é um `abrir` novo — e ele volta
    // para o mesmo segundo. Um `<video>` não expõe seleção de faixa de áudio em nenhum navegador
    // de forma utilizável, e fingir que expõe daria um botão que não faz nada.
    const onde = agoraReal();
    atual.faixaDeAudio = i;
    if (!noCano()) { avisar('Este arquivo toca direto: a faixa é a do arquivo.'); return; }
    base = onde;
    mostrarPreparando(true, 'Trocando a faixa de áudio…');
    video.src = `${urlDoCano(onde)}&audio=${i}`;
    video.load();
    video.play().catch(() => {});
  }

  function trocarLegenda(i) {
    [...video.textTracks].forEach((t, k) => { t.mode = k === i ? 'showing' : 'disabled'; });
  }

  async function janelaFlutuante() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { avisar('A janela flutuante não está disponível aqui.'); }
  }

  function telaCheia() {
    if (document.fullscreenElement) document.exitFullscreen();
    else palco.requestFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () =>
    trocarIcone($('btn-tela'), document.fullscreenElement ? 'fullscreen-exit' : 'maximize'));

  // ── Quantos quadros esta máquina está perdendo ──────────────────────────
  //
  // ⚠ **Isto responde à única pergunta que log de servidor nenhum responde**: "está travando?".
  // O caminho até aqui tem quatro trechos — ffmpeg, portal, rede, navegador — e os três primeiros
  // se medem no servidor. O quarto só se mede na máquina que desenha, e `getVideoPlaybackQuality`
  // é o instrumento: quadros que o decodificador entregou contra quadros que a tela não conseguiu
  // mostrar a tempo.
  //
  // É o mesmo número que o VLC põe em Ferramentas → Informações da mídia → Estatísticas, sob
  // "quadros perdidos", e pelo mesmo motivo: quando alguém diz "está travado", é a diferença entre
  // "chegou pouco" e "chegou e não coube".
  //
  // ⚠ Ele fica AQUI e não na tela. Contador de quadros na interface de quem quer assistir é ruído
  // permanente por uma informação que importa em dez minutos de uma vida — e é justamente por isso
  // que ele tem de ser fácil de achar quando esses dez minutos chegam.

  function qualidadeDaTela() {
    const q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality();
    if (!q || !q.totalVideoFrames) return null;
    const pct = (q.droppedVideoFrames / q.totalVideoFrames) * 100;
    return {
      total: q.totalVideoFrames,
      perdidos: q.droppedVideoFrames,
      texto: `Quadros: ${q.totalVideoFrames} desenhados, ${q.droppedVideoFrames} perdidos`
             + ` (${pct.toFixed(1)}%)`,
    };
  }

  async function informacoes() {
    if (!atual) return;
    // ⚠ O detalhe técnico mora AQUI, e não numa barra de estado. É onde o VLC o põe, e é o lugar
    // certo: quem quer saber vai buscar; quem só quer assistir não tropeça nele.
    const q = qualidadeDaTela();
    const linhas = [
      atual.nome,
      atual.duracao ? `Duração: ${tempoDe(atual.duracao)}` : null,
      video.videoWidth ? `Imagem: ${video.videoWidth}×${video.videoHeight}` : null,
      `Faixas de áudio: ${atual.audios.length || 'nenhuma'}`,
      atual.legendas.length ? `Legendas: ${atual.legendas.length}` : null,
      '',
      `Como está sendo servido: ${{
        direto: 'direto do seu ambiente, sem conversão',
        remux: 'reembalado no servidor (o vídeo não é recomprimido)',
        audio: 'só o áudio está sendo convertido no servidor',
        transcode: 'convertido no servidor',
      }[atual.modo] || atual.modo}`,
      atual.motivo,
      q ? '' : null,
      q ? q.texto : null,
      // A frase que transforma o número em decisão. Sem ela, "3,2%" não diz a ninguém se está bom.
      //
      // ⚠ E ela NÃO culpa a máquina, embora essa tenha sido a primeira versão. Medido: o mesmo
      // arquivo perde 25% dos quadros numa máquina que toca 720p a 60 quadros por segundo sem
      // perder um — a causa estava no arquivo, e apontar para o computador teria mandado quem lê
      // procurar no lugar errado. Um diagnóstico que nomeia o culpado errado é pior que nenhum.
      q ? (q.perdidos / q.total > 0.05
        ? 'Perder mais de 5% é o que se vê como travamento. Os bytes chegaram — o que não coube '
          + 'foi desenhar, e a causa pode ser o arquivo ou esta máquina.'
        : 'Abaixo de 5% a reprodução é considerada lisa.') : null,
    ].filter((x) => x !== null);
    await vssh.dialog.alert(linhas.join('\n'), 'Informações do arquivo');
  }

  async function escolherArquivo() {
    const p = await vssh.pickFile();
    if (p) abrir(p);
  }
  $('btn-abrir-arquivo').addEventListener('click', escolherArquivo);

  // ── Teclado ─────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // ⚠ A guarda que todo player esquece: dentro de um campo de texto, espaço é espaço e as setas
    // movem o cursor. Sem isto, filtrar a biblioteca pausa o vídeo a cada palavra.
    const alvo = e.target;
    if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const teclas = {
      ' ': () => executar('tocar'),
      k: () => executar('tocar'),
      ArrowLeft: () => buscar(agoraReal() - 10),
      ArrowRight: () => buscar(agoraReal() + 10),
      j: () => buscar(agoraReal() - 30),
      l: () => buscar(agoraReal() + 30),
      ArrowUp: () => { video.volume = Math.min(1, video.volume + 0.05); },
      ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.05); },
      m: () => { video.muted = !video.muted; },
      f: telaCheia,
      p: janelaFlutuante,
      Home: () => buscar(0),
      End: () => buscar((duracaoReal() || 0) - 1),
    };
    const fn = teclas[e.key] || teclas[e.key.toLowerCase()];
    if (!fn) return;
    e.preventDefault();
    fn();
  });

  // ── As teclas de mídia do sistema ───────────────────────────────────────
  //
  // O teclado com botão de play, o fone com botão de pausa. Sem isto o ambiente inteiro responde a
  // eles e o Palco não — e a pessoa conclui que o player é que é estranho.

  // ⚠ A central de mídia do AMBIENTE, que é outra coisa do `mediaSession` do sistema. O shell já
  // alcança este `<video>` sozinho e sabe tocar, pausar e buscar; o que ele não tem é a FILA — e
  // sem declarar, ele não desenha anterior/próximo, que é a resposta certa para quem abriu um
  // arquivo solto. Declarar de novo a cada abertura é o ponto: a pasta muda, e com ela a resposta.
  function porCentralDeMidia() {
    if (!vssh.media) return;   // shell antigo: o player continua inteiro, sem os dois botões
    vssh.media.transporte({
      anterior: indice > 0,
      proximo: indice >= 0 && indice + 1 < vizinhos.length,
    });
  }
  vssh.media?.aoAgir((acao) => executar(acao === 'anterior' ? 'anterior' : 'proximo'));

  function porMediaSession(r) {
    if (!('mediaSession' in navigator)) return;
    // O canal do YouTube quando há um; "Palco" quando o que está tocando é um arquivo da pasta e
    // não existe autoria a mostrar. Repetir "Palco" havendo o nome do canal desperdiçaria a única
    // linha secundária que a central de mídia oferece.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: r.nome, artist: r.origem || 'Palco',
    });
    const liga = (acao, fn) => {
      try { navigator.mediaSession.setActionHandler(acao, fn); } catch { /* não suportada */ }
    };
    liga('play', () => video.play());
    liga('pause', () => video.pause());
    liga('seekbackward', () => buscar(agoraReal() - 10));
    liga('seekforward', () => buscar(agoraReal() + 10));
    liga('previoustrack', () => executar('anterior'));
    liga('nexttrack', () => executar('proximo'));
  }

  // ── A Biblioteca ────────────────────────────────────────────────────────

  async function carregarVizinhos(caminho, minha) {
    try {
      const r = await api(`api/vizinhos?caminho=${encodeURIComponent(caminho)}`);
      if (minha !== undefined && minha !== geracao) return;   // é a pasta de um arquivo já trocado
      vizinhos = r.itens;
      indice = r.atual;
      $('bib-pasta').textContent = r.pasta;
      desenharTabela();
      porCentralDeMidia();
    } catch { /* a pasta pode ter sumido; o player continua tocando */ }
  }

  function desenharTabela() {
    const corpo = $('tabela-corpo');
    corpo.textContent = '';
    const busca = filtro.trim().toLowerCase();
    const vistos = vizinhos
      .map((it, i) => ({ ...it, i }))
      .filter((it) => !busca || it.nome.toLowerCase().includes(busca));

    $('bib-vazio').hidden = vizinhos.length > 0;
    $('tabela').hidden = vizinhos.length === 0;

    for (const it of vistos) {
      const linha = document.createElement('div');
      linha.className = 'linha-arq' + (it.i === indice ? ' linha-arq--tocando' : '');
      linha.setAttribute('role', 'row');
      linha.tabIndex = 0;
      linha.setAttribute('aria-selected', String(it.i === indice));
      // O ÍNDICE no DOM: é o que permite ao clique direito agir sobre a linha apontada em vez da
      // marcada. Sem ele, o menu precisaria de uma seleção — e a tabela não tem uma.
      linha.dataset.i = String(it.i);
      const ponto = it.nome.lastIndexOf('.');
      for (const [cls, txt] of [['col-n', String(it.i + 1)], ['col-nome', it.nome],
                                ['col-fmt', ponto > 0 ? it.nome.slice(ponto + 1).toUpperCase() : '']]) {
        const c = document.createElement('span');
        c.className = cls;
        c.textContent = txt;
        linha.appendChild(c);
      }
      // Duplo-clique E Enter: uma lista em que só o teclado abre é uma lista que o mouse não usa,
      // e o contrário deixa quem navega por teclado sem saída.
      const tocar = () => { abrir(it.caminho); irPara('reproduzindo'); };
      linha.addEventListener('dblclick', tocar);
      linha.addEventListener('keydown', (e) => { if (e.key === 'Enter') tocar(); });
      corpo.appendChild(linha);
    }
  }

  $('bib-busca').addEventListener('input', (e) => { filtro = e.target.value; desenharTabela(); });

  // ── As abas ─────────────────────────────────────────────────────────────

  function irPara(nome) {
    for (const b of document.querySelectorAll('.aba')) {
      const ativa = b.dataset.aba === nome;
      b.classList.toggle('aba--ativa', ativa);
      b.setAttribute('aria-selected', String(ativa));
    }
    for (const p of document.querySelectorAll('.painel')) {
      p.classList.toggle('painel--ativo', p.id === `painel-${nome}`);
    }
    // O shell devolve a janela nesta rota quando a sessão é restaurada.
    vssh.lembrarRota?.(nome === 'reproduzindo' ? '' : nome);
  }
  for (const b of document.querySelectorAll('.aba')) {
    b.addEventListener('click', () => irPara(b.dataset.aba));
  }

  // ── A porta de entrada ──────────────────────────────────────────────────
  //
  // É por aqui que o Palco recebe o arquivo que alguém mandou abrir com ele — o duplo-clique no
  // gerenciador de arquivos, o "Abrir com", e (a partir da Fase 3) o link roteado.

  vssh.onOpenContext((ctx) => {
    if (ctx.tipo === 'pasta') return;          // pasta é a Biblioteca de outro dia
    // ⚠ `tipo: 'url'` é o que o roteamento de link entrega (Fase 3). Ele já chega hoje por
    // `vssh.openUrl` de outro app; o que ainda não acontece é o Palco ser ELEITO para os hosts do
    // YouTube, e isso segue desligado de propósito — `opens.urls` só entra quando a aba cobrir
    // playlist, canal e busca, senão o link vira beco.
    if (ctx.tipo === 'url' && ctx.url) {
      // ⚠ Playlist, canal e busca vão para a ABA; vídeo vai para o player. Sem esta bifurcação o
      // Palco declararia `opens.urls` e devolveria ao navegador metade dos endereços que
      // reivindicou — que é o beco que o roteamento existe para não produzir.
      const lista = ehListagem(ctx.url);
      if (lista && yt) { yt.abrirListagem(ctx.url, lista); return; }
      // `abrirYoutube` troca de aba sozinho, e só depois de confirmar que é vídeo.
      abrirYoutube(ctx.url);
      return;
    }
    if (ctx.path) { irPara('reproduzindo'); abrir(ctx.path); return; }
    if (ctx.rota) irPara(ctx.rota);
  });

  // ── A aba do YouTube ────────────────────────────────────────────────────
  //
  // ⚠ Ela recebe o Palco por parâmetro, e não o contrário: quem toca é o player que já existe, e a
  // aba só sabe pedir. Sem essa direção seriam dois donos do mesmo `<video>` — que é exatamente o
  // desenho que faz um "app com YouTube dentro" virar dois apps colados.
  const yt = window.montarYoutube ? montarYoutube({ abrirYoutube, irPara, comIdioma }) : null;

  porRepetir('nao');
  velocidade(1);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', montarPalco, { once: true });
} else {
  montarPalco();
}
