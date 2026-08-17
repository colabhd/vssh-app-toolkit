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

  const api = (rota, opts) => fetch(rota, opts).then((r) => {
    if (!r.ok) throw new Error(`${rota}: ${r.status}`);
    return r.json();
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

  async function abrir(caminho, opcoes) {
    const o = opcoes || {};
    const minha = ++geracao;
    avisar('');
    // ⚠ A lista some ANTES do `await`. Ela é dos vizinhos do arquivo ANTERIOR até `api/vizinhos`
    // responder, e nesse intervalo qualquer `ended` avançaria pela pasta errada — que é como uma
    // falha no primeiro quadro conseguiu pôr o vídeo anterior de volta na tela.
    vizinhos = [];
    indice = -1;
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
    aplicarLegendas(r);
    carregarVizinhos(caminho, minha);
    porMediaSession(r);
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

  const IDIOMAS = { por: 'Português', pob: 'Português (BR)', eng: 'Inglês', spa: 'Espanhol',
                    fra: 'Francês', fre: 'Francês', deu: 'Alemão', ger: 'Alemão', ita: 'Italiano',
                    jpn: 'Japonês', kor: 'Coreano', rus: 'Russo', zho: 'Chinês', chi: 'Chinês' };
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
      return abrir(vizinhos[i].caminho);
    }
    if (indice + 1 < vizinhos.length) return abrir(vizinhos[indice + 1].caminho);
    if (repetir === 'lista') return abrir(vizinhos[0].caminho);
  });

  // ── Marcar onde parou ───────────────────────────────────────────────────
  //
  // A cada 15 s e ao pausar/sair. ⚠ `visibilitychange` e não `unload`: num iframe de desktop a
  // janela fecha sem passar por `unload` de forma confiável, e a marca do último trecho some.

  function marcar() {
    if (!atual || !video.duration) return;
    navigator.sendBeacon?.('api/marca', new Blob([JSON.stringify({
      caminho: atual.caminho, seg: Math.floor(agoraReal()), dur: duracaoReal(),
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
      { id: 'mostrar', label: 'Mostrar no gerenciador de arquivos', disabled: !atual },
      { separator: true },
      { id: 'esquecer', label: 'Esquecer onde parei', disabled: !atual },
    ],
  };

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

    const acoes = {
      abrir: escolherArquivo,
      fechar: () => vssh.window.close(),
      anterior: () => indice > 0 && abrir(vizinhos[indice - 1].caminho),
      proximo: () => indice >= 0 && indice + 1 < vizinhos.length && abrir(vizinhos[indice + 1].caminho),
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
        if (!atual) return;
        fetch(`api/marca?caminho=${encodeURIComponent(atual.caminho)}`, { method: 'DELETE' });
        $('retomar').hidden = true;
      },
    };
    (acoes[id] || (() => {}))();
  }

  for (const b of document.querySelectorAll('.menubar button')) {
    b.addEventListener('click', () => menu(b, MENUS[b.dataset.menu]()));
  }

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

  function porMediaSession(r) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: r.nome, artist: 'Palco' });
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
    if (ctx.path) { irPara('reproduzindo'); abrir(ctx.path); return; }
    if (ctx.rota) irPara(ctx.rota);
  });

  porRepetir('nao');
  velocidade(1);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', montarPalco, { once: true });
} else {
  montarPalco();
}
