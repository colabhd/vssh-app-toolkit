'use strict';

// Tuff — o comportamento das peças de mídia. Opt-in, como o CSS delas.
//
// Expõe `window.TuffMidia` com quatro peças:
//
//     TuffMidia.player(raiz, video)   liga trilha, timecode, volume e o chrome que some
//     TuffMidia.grade(el, opcoes)     grade de miniaturas VIRTUALIZADA
//     TuffMidia.visor(el, opcoes)     zoom e arraste
//     TuffMidia.tempo(segundos)       o timecode, como string
//
// Sem dependência e sem build, como o resto de `lib/web/`. Nada aqui fala com o shell: são peças de
// navegador, e funcionam igual num app Node, num app Python e numa aba solta.
//
// ─── Por que estas quatro, e não um player pronto ────────────────────────────
//
// Porque o que ninguém acerta sozinho não é "um player": é a grade que não trava com trinta mil
// arquivos, o scrub que não briga com o `timeupdate`, o chrome que não some com o foco do teclado
// dentro, e o zoom que acompanha o ponteiro. O resto — que botão fica onde, o que o app faz ao
// abrir um arquivo — é do app, e um player pronto tomaria essa decisão por ele.

(function () {

  // ── Utilidades ─────────────────────────────────────────────────────────────

  const limitar = (v, min, max) => (v < min ? min : v > max ? max : v);

  /**
   * Segundos → `12:04` ou `1:02:04`.
   *
   * A hora só aparece quando existe: um `0:12:04` num clipe de dois minutos rouba largura e ensina
   * a ler um campo que nunca muda.
   */
  function tempo(segundos) {
    if (!isFinite(segundos) || segundos < 0) return '--:--';
    const s = Math.floor(segundos % 60);
    const m = Math.floor(segundos / 60) % 60;
    const h = Math.floor(segundos / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** A fração 0–1 correspondente a um ponteiro sobre um elemento horizontal. */
  function fracaoDoPonteiro(el, clientX) {
    const r = el.getBoundingClientRect();
    return r.width ? limitar((clientX - r.left) / r.width, 0, 1) : 0;
  }

  // ── A trilha ───────────────────────────────────────────────────────────────

  /**
   * Monta as camadas da trilha dentro de um contêiner vazio e devolve os controles dela.
   *
   * As camadas são criadas aqui, e não pedidas ao HTML do app, porque a ordem delas é o desenho:
   * buffer embaixo, tocado em cima, marcas por último. Um app que montasse na ordem errada teria
   * uma trilha que parece funcionar e esconde o progresso atrás do buffer.
   */
  function montarTrilha(el) {
    el.innerHTML = '';
    const trilho = document.createElement('div');
    trilho.className = 'tuff-trilha-trilho';
    const buffer = document.createElement('div');
    buffer.className = 'tuff-trilha-buffer';
    const tocado = document.createElement('div');
    tocado.className = 'tuff-trilha-tocado';
    trilho.append(buffer, tocado);
    const polegar = document.createElement('div');
    polegar.className = 'tuff-trilha-polegar';
    const previa = document.createElement('div');
    previa.className = 'tuff-trilha-previa';
    el.append(trilho, polegar, previa);

    // `role="slider"` com os três `aria-value*`: sem eles um leitor de tela anuncia "botão" e não
    // diz onde o filme está. O `tabindex` é o que põe a trilha na ordem de tabulação — sem ele, um
    // teclado não alcança o controle mais usado do player.
    el.setAttribute('role', 'slider');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', el.getAttribute('aria-label') || 'Posição');
    return { trilho, buffer, tocado, polegar, previa };
  }

  // ── O player ───────────────────────────────────────────────────────────────

  /**
   * Liga um `<video>` (ou `<audio>`) às peças que estiverem dentro de `raiz`.
   *
   * As peças são encontradas por atributo — `data-tuff-trilha`, `data-tuff-tempo`,
   * `data-tuff-play`, `data-tuff-volume`, `data-tuff-mudo`, `data-tuff-chrome` — e todas são
   * opcionais. Um app que só quer a trilha põe a trilha.
   *
   * Devolve `{ destruir() }`.
   */
  function player(raiz, video, opcoes) {
    const opts = opcoes || {};
    const achar = (attr) => raiz.querySelector(`[data-tuff-${attr}]`);
    const desfazer = [];
    const ouvir = (alvo, tipo, fn, op) => {
      alvo.addEventListener(tipo, fn, op);
      desfazer.push(() => alvo.removeEventListener(tipo, fn, op));
    };

    const elTrilha = achar('trilha');
    const elTempo = achar('tempo');
    const btPlay = achar('play');
    const elVolume = achar('volume');
    const btMudo = achar('mudo');
    const elChrome = achar('chrome');
    const capitulos = opts.capitulos || [];

    const t = elTrilha ? montarTrilha(elTrilha) : null;

    // ⚠ Enquanto o dedo está na trilha, o `timeupdate` do vídeo é IGNORADO. Sem isto os dois
    // escrevem a mesma posição em disputa: o vídeo relata onde está, o arraste diz para onde vai, e
    // o polegar pula para trás a cada quadro. É o defeito clássico de scrub feito à mão.
    let arrastando = false;

    function pintar() {
      if (!t) return;
      const dur = video.duration;
      const frac = dur ? video.currentTime / dur : 0;
      t.tocado.style.width = `${frac * 100}%`;
      t.polegar.style.left = `${frac * 100}%`;
      if (elTrilha) {
        elTrilha.setAttribute('aria-valuemin', '0');
        elTrilha.setAttribute('aria-valuemax', String(Math.floor(dur || 0)));
        elTrilha.setAttribute('aria-valuenow', String(Math.floor(video.currentTime || 0)));
        elTrilha.setAttribute('aria-valuetext', tempo(video.currentTime));
      }
      // O buffer mostrado é a faixa que CONTÉM o ponto atual, e não a última nem a maior. Um vídeo
      // em que o usuário pulou para o meio tem várias faixas; pintar a errada afirma que já baixou
      // o que não baixou, e a barra some quando ele volta.
      let ate = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
          ate = video.buffered.end(i);
          break;
        }
      }
      t.buffer.style.width = dur ? `${(ate / dur) * 100}%` : '0';
    }

    function pintarTempo() {
      if (elTempo) {
        elTempo.innerHTML = `<b>${tempo(video.currentTime)}</b> / ${tempo(video.duration)}`;
      }
    }

    function pintarCapitulos() {
      if (!t || !video.duration || !capitulos.length) return;
      for (const seg of capitulos) {
        if (seg <= 0 || seg >= video.duration) continue;
        const marca = document.createElement('div');
        marca.className = 'tuff-trilha-marca';
        marca.style.left = `${(seg / video.duration) * 100}%`;
        t.trilho.appendChild(marca);
      }
    }

    if (elTrilha) {
      const buscarPara = (clientX) => {
        if (!video.duration) return;
        video.currentTime = fracaoDoPonteiro(elTrilha, clientX) * video.duration;
        pintar(); pintarTempo();
      };

      ouvir(elTrilha, 'pointerdown', (e) => {
        arrastando = true;
        elTrilha.classList.add('tuff-trilha--arrastando');
        // A captura é o que faz o arraste sobreviver ao ponteiro saindo da trilha. Sem ela, mover
        // 3px para cima no meio do gesto solta o controle no lugar errado.
        elTrilha.setPointerCapture(e.pointerId);
        buscarPara(e.clientX);
      });
      ouvir(elTrilha, 'pointermove', (e) => {
        if (video.duration) {
          const f = fracaoDoPonteiro(elTrilha, e.clientX);
          t.previa.style.left = `${f * 100}%`;
          t.previa.textContent = tempo(f * video.duration);
        }
        if (arrastando) buscarPara(e.clientX);
      });
      const soltar = (e) => {
        if (!arrastando) return;
        arrastando = false;
        elTrilha.classList.remove('tuff-trilha--arrastando');
        try { elTrilha.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
      };
      ouvir(elTrilha, 'pointerup', soltar);
      ouvir(elTrilha, 'pointercancel', soltar);

      // Teclado. 5 s é o passo que a maioria dos players usa e a memória muscular espera; Shift dá
      // o passo fino de 1 s, para achar um quadro sem sair do teclado.
      ouvir(elTrilha, 'keydown', (e) => {
        const passo = e.shiftKey ? 1 : 5;
        let alvo = null;
        if (e.key === 'ArrowRight') alvo = video.currentTime + passo;
        else if (e.key === 'ArrowLeft') alvo = video.currentTime - passo;
        else if (e.key === 'Home') alvo = 0;
        else if (e.key === 'End') alvo = video.duration;
        if (alvo === null) return;
        e.preventDefault();
        video.currentTime = limitar(alvo, 0, video.duration || 0);
        pintar(); pintarTempo();
      });
    }

    if (btPlay) {
      ouvir(btPlay, 'click', () => { if (video.paused) video.play(); else video.pause(); });
      const rotular = () => {
        btPlay.setAttribute('aria-label', video.paused ? 'Reproduzir' : 'Pausar');
        btPlay.textContent = video.paused ? '▶' : '❚❚';
      };
      ouvir(video, 'play', rotular);
      ouvir(video, 'pause', rotular);
      rotular();
    }

    if (elVolume) {
      const trilho = elVolume.querySelector('.tuff-volume-trilha') || elVolume;
      const nivel = elVolume.querySelector('.tuff-volume-nivel');
      const pintarVolume = () => {
        if (nivel) nivel.style.width = `${(video.muted ? 0 : video.volume) * 100}%`;
        elVolume.classList.toggle('tuff-volume--mudo', !!video.muted);
      };
      const ajustar = (clientX) => {
        video.volume = fracaoDoPonteiro(trilho, clientX);
        // Mexer no volume DESLIGA o mudo. Ficar mudo enquanto a barra sobe é a interação que faz
        // todo mundo achar que o som quebrou.
        if (video.volume > 0) video.muted = false;
      };
      let ajustandoVol = false;
      ouvir(trilho, 'pointerdown', (e) => {
        ajustandoVol = true; trilho.setPointerCapture(e.pointerId); ajustar(e.clientX);
      });
      ouvir(trilho, 'pointermove', (e) => { if (ajustandoVol) ajustar(e.clientX); });
      ouvir(trilho, 'pointerup', () => { ajustandoVol = false; });
      ouvir(video, 'volumechange', pintarVolume);
      if (btMudo) ouvir(btMudo, 'click', () => { video.muted = !video.muted; });
      pintarVolume();
    }

    // ── O chrome que some ────────────────────────────────────────────────────
    //
    // ⚠ **Ele nunca some com o foco do teclado dentro dele.** Sumir ali deixaria quem navega por
    // teclado sem controle nenhum e sem caminho de volta — a pessoa está com o foco num botão que
    // deixou de existir na tela. É a regra que separa esta peça de uma armadilha, e ela não tem
    // como ser descoberta testando com o mouse.
    //
    // Também não some com o vídeo pausado: pausado, a tela é uma imagem parada, e esconder os
    // controles de uma imagem parada não protege nada.
    let cronometro = null;
    if (elChrome) {
      const OCIO = opts.ocioMs || 2500;
      const palco = achar('palco') || raiz;

      const mostrar = () => {
        elChrome.classList.remove('tuff-chrome--oculto');
        palco.classList.remove('tuff-palco--limpo');
      };
      const podeSumir = () =>
        !video.paused && !arrastando && !elChrome.contains(document.activeElement);
      const agendar = () => {
        clearTimeout(cronometro);
        mostrar();
        cronometro = setTimeout(() => {
          if (!podeSumir()) return agendar();
          elChrome.classList.add('tuff-chrome--oculto');
          palco.classList.add('tuff-palco--limpo');
        }, OCIO);
      };

      ouvir(raiz, 'pointermove', agendar);
      ouvir(raiz, 'pointerleave', () => { if (podeSumir()) agendar(); });
      ouvir(video, 'pause', mostrar);
      ouvir(video, 'play', agendar);
      // `focusin` borbulha (o `focus` não), e é o que traz o chrome de volta quando alguém chega
      // nele com Tab estando ele oculto.
      ouvir(elChrome, 'focusin', mostrar);
      agendar();
    }

    ouvir(video, 'timeupdate', () => { if (!arrastando) { pintar(); pintarTempo(); } });
    ouvir(video, 'progress', pintar);
    ouvir(video, 'loadedmetadata', () => { pintar(); pintarTempo(); pintarCapitulos(); });
    pintar(); pintarTempo(); pintarCapitulos();

    return {
      destruir() {
        clearTimeout(cronometro);
        for (const f of desfazer) f();
      },
    };
  }

  // ── A grade virtualizada ───────────────────────────────────────────────────

  /**
   * Grade de miniaturas que aguenta uma pasta de verdade.
   *
   * ⚠ **É a peça mais importante deste arquivo, e a que parece a mais dispensável.** Uma pasta de
   * fotos tem dezenas de milhares de arquivos; montar um `<img>` para cada um trava a aba na
   * abertura e não se recupera — e o autor do app só descobre isso no diretório de alguém, nunca no
   * dele. Aqui o DOM guarda só o que está visível (mais uma fileira de folga em cada ponta), e o
   * `.tuff-grade-fuso` dá ao contêiner a altura que a barra de rolagem precisa ter.
   *
   * `montar(indice, no)` é chamada toda vez que um nó é REUSADO para outro índice. Ela recebe o nó
   * já posicionado e só precisa preencher o conteúdo.
   *
   * Devolve `{ atualizar(total), selecionar(i), destruir() }`.
   */
  function grade(el, opcoes) {
    const o = opcoes || {};
    const larguraItem = o.largura || 160;
    const alturaItem = o.altura || 120;
    const espaco = o.gap != null ? o.gap : 8;
    const montar = o.montar || (() => {});
    let total = o.total || 0;
    let selecionado = -1;

    el.classList.add('tuff-grade');
    const fuso = document.createElement('div');
    fuso.className = 'tuff-grade-fuso';
    el.innerHTML = '';
    el.appendChild(fuso);

    const pool = [];        // nós vivos, reaproveitados entre rolagens
    let colunas = 1;

    function medir() {
      const largura = el.clientWidth || larguraItem;
      colunas = Math.max(1, Math.floor((largura + espaco) / (larguraItem + espaco)));
      const linhas = Math.ceil(total / colunas);
      fuso.style.height = `${Math.max(0, linhas * (alturaItem + espaco) - espaco)}px`;
    }

    function desenhar() {
      const alturaLinha = alturaItem + espaco;
      const topo = el.scrollTop;
      const visivel = el.clientHeight || alturaLinha;
      // Uma fileira de folga em cada ponta: sem ela, rolar depressa mostra o fundo por um quadro
      // antes de o nó aparecer, e o efeito é de imagem piscando.
      const primeira = Math.max(0, Math.floor(topo / alturaLinha) - 1);
      const ultima = Math.min(
        Math.ceil(total / colunas) - 1,
        Math.floor((topo + visivel) / alturaLinha) + 1);

      const precisa = Math.max(0, (ultima - primeira + 1) * colunas);
      while (pool.length < precisa) {
        const no = document.createElement('div');
        no.className = 'tuff-miniatura';
        no.setAttribute('role', 'option');
        no.tabIndex = -1;
        fuso.appendChild(no);
        pool.push(no);
      }

      let k = 0;
      for (let linha = primeira; linha <= ultima; linha++) {
        for (let col = 0; col < colunas; col++) {
          const i = linha * colunas + col;
          const no = pool[k++];
          if (!no) continue;
          if (i >= total) { no.style.display = 'none'; continue; }
          no.style.display = '';
          no.style.width = `${larguraItem}px`;
          no.style.height = `${alturaItem}px`;
          no.style.transform =
            `translate(${col * (larguraItem + espaco)}px, ${linha * alturaLinha}px)`;
          no.setAttribute('aria-selected', String(i === selecionado));
          if (no.__indice !== i) { no.__indice = i; montar(i, no); }
        }
      }
      for (; k < pool.length; k++) pool[k].style.display = 'none';
    }

    function selecionar(i, comFoco) {
      selecionado = limitar(i, 0, Math.max(0, total - 1));
      // Rolar até o item ANTES de desenhar: o nó do índice novo pode nem existir ainda.
      const linha = Math.floor(selecionado / colunas);
      const y = linha * (alturaItem + espaco);
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + alturaItem > el.scrollTop + el.clientHeight) {
        el.scrollTop = y + alturaItem - el.clientHeight;
      }
      desenhar();
      if (comFoco) {
        const no = pool.find((n) => n.__indice === selecionado && n.style.display !== 'none');
        if (no) no.focus();
      }
      if (o.aoSelecionar) o.aoSelecionar(selecionado);
    }

    const aoRolar = () => desenhar();
    el.addEventListener('scroll', aoRolar, { passive: true });

    // `ResizeObserver` e não `window.onresize`: a grade pode estar num painel que muda de largura
    // sem a janela mudar de tamanho — um divisor arrastado, uma barra lateral que abre.
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => { medir(); desenhar(); });
      ro.observe(el);
    }

    const aoClicar = (e) => {
      const no = e.target.closest('.tuff-miniatura');
      if (no && no.__indice != null) selecionar(no.__indice, true);
    };
    el.addEventListener('click', aoClicar);

    /**
     * ⚠ Abrir com DUPLO-CLIQUE, e não só com Enter.
     *
     * Isto faltava, e o buraco era grande: `aoAbrir` só estava ligado à tecla Enter, ou seja **numa
     * grade de miniaturas o mouse não abria nada**. Selecionava e parava ali. Não há gerenciador de
     * arquivos, visualizador de fotos ou grade de mídia em que duplo-clique não abra — é o gesto
     * mais estabelecido que existe para "quero este".
     *
     * O defeito era invisível pelos dois lados: quem escreveu `aoAbrir` viu o callback ser chamado
     * (pelo teclado, num teste), e quem usa com o mouse conclui que o app é que não implementou.
     * O `visor` aqui embaixo já ligava `dblclick` — a lib conhecia o idioma, a grade é que ficou
     * de fora.
     */
    const aoDuplo = (e) => {
      const no = e.target.closest('.tuff-miniatura');
      if (no && no.__indice != null && o.aoAbrir) o.aoAbrir(no.__indice);
    };
    el.addEventListener('dblclick', aoDuplo);

    // Tabulação itinerante: a grade inteira é UM ponto de parada do Tab, e as setas andam dentro
    // dela. Trinta mil paradas de Tab não é navegação, é armadilha.
    const aoTeclar = (e) => {
      const mapa = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: colunas, ArrowUp: -colunas };
      if (e.key === 'Home') { e.preventDefault(); return selecionar(0, true); }
      if (e.key === 'End') { e.preventDefault(); return selecionar(total - 1, true); }
      if (e.key === 'Enter' && o.aoAbrir && selecionado >= 0) { e.preventDefault(); return o.aoAbrir(selecionado); }
      const d = mapa[e.key];
      if (!d) return;
      e.preventDefault();
      selecionar((selecionado < 0 ? 0 : selecionado) + d, true);
    };
    el.addEventListener('keydown', aoTeclar);
    el.setAttribute('role', 'listbox');
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;

    medir(); desenhar();

    return {
      atualizar(n) { total = n; medir(); desenhar(); },
      selecionar(i) { selecionar(i, false); },
      destruir() {
        el.removeEventListener('scroll', aoRolar);
        el.removeEventListener('click', aoClicar);
        el.removeEventListener('dblclick', aoDuplo);
        el.removeEventListener('keydown', aoTeclar);
        if (ro) ro.disconnect();
      },
    };
  }

  // ── O visor ────────────────────────────────────────────────────────────────

  /**
   * Zoom e arraste sobre o primeiro filho de `el`.
   *
   * ⚠ **Sem inércia, e isto é escolha.** A promessa era ter; medindo a intenção, ela não serve a
   * este ambiente. Um visualizador aqui é ferramenta de trabalho — comparar duas regiões de uma
   * imagem científica, ler uma etiqueta —, e uma imagem que continua deslizando depois que a mão
   * parou se lê como perda de controle. O momento que existe no trackpad já vem do sistema, pela
   * roda; o que somaríamos é só no arraste com botão, onde ninguém pede.
   *
   * Devolve `{ ajustar(), cem(), destruir() }`.
   */
  function visor(el, opcoes) {
    const o = opcoes || {};
    const minEscala = o.min || 0.05;
    const maxEscala = o.max || 40;
    el.classList.add('tuff-visor');

    let conteudo = el.querySelector('.tuff-visor-conteudo');
    if (!conteudo) {
      conteudo = document.createElement('div');
      conteudo.className = 'tuff-visor-conteudo';
      while (el.firstChild) conteudo.appendChild(el.firstChild);
      el.appendChild(conteudo);
    }

    let escala = 1, x = 0, y = 0;

    const aplicar = () => {
      conteudo.style.transform = `translate(${x}px, ${y}px) scale(${escala})`;
    };
    const suave = (fn) => {
      el.classList.add('tuff-visor--suave');
      fn();
      aplicar();
      setTimeout(() => el.classList.remove('tuff-visor--suave'), 200);
    };
    const tamanho = () => {
      const alvo = conteudo.firstElementChild;
      return {
        w: (alvo && (alvo.naturalWidth || alvo.offsetWidth)) || conteudo.offsetWidth || 1,
        h: (alvo && (alvo.naturalHeight || alvo.offsetHeight)) || conteudo.offsetHeight || 1,
      };
    };

    function ajustar() {
      const { w, h } = tamanho();
      const cx = el.clientWidth, cy = el.clientHeight;
      suave(() => {
        escala = Math.min(cx / w, cy / h);
        x = (cx - w * escala) / 2;
        y = (cy - h * escala) / 2;
      });
    }
    function cem() {
      const { w, h } = tamanho();
      suave(() => {
        escala = 1;
        x = (el.clientWidth - w) / 2;
        y = (el.clientHeight - h) / 2;
      });
    }

    // Zoom NO PONTEIRO: o ponto sob o cursor tem de ficar sob o cursor. Zoom no centro obriga a
    // pessoa a arrastar de volta depois de cada passo, e é a diferença entre uma lupa e um
    // controle de escala.
    const aoRodar = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const nova = limitar(escala * (e.deltaY < 0 ? 1.12 : 1 / 1.12), minEscala, maxEscala);
      const k = nova / escala;
      x = px - (px - x) * k;
      y = py - (py - y) * k;
      escala = nova;
      aplicar();
    };
    el.addEventListener('wheel', aoRodar, { passive: false });

    let arrastando = false, px0 = 0, py0 = 0;
    const aoDescer = (e) => {
      arrastando = true;
      px0 = e.clientX - x; py0 = e.clientY - y;
      el.classList.add('tuff-visor--arrastando');
      el.setPointerCapture(e.pointerId);
    };
    const aoMover = (e) => {
      if (!arrastando) return;
      x = e.clientX - px0; y = e.clientY - py0;
      aplicar();
    };
    const aoSubir = (e) => {
      arrastando = false;
      el.classList.remove('tuff-visor--arrastando');
      try { el.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
    };
    el.addEventListener('pointerdown', aoDescer);
    el.addEventListener('pointermove', aoMover);
    el.addEventListener('pointerup', aoSubir);
    el.addEventListener('pointercancel', aoSubir);

    // Duplo-clique alterna entre "cabe na janela" e "1:1". São as duas escalas que se quer de volta
    // depois de explorar, e ter as duas num gesto só dispensa dois botões.
    const aoDuplo = () => { if (escala === 1) ajustar(); else cem(); };
    el.addEventListener('dblclick', aoDuplo);

    ajustar();

    return {
      ajustar, cem,
      destruir() {
        el.removeEventListener('wheel', aoRodar);
        el.removeEventListener('pointerdown', aoDescer);
        el.removeEventListener('pointermove', aoMover);
        el.removeEventListener('pointerup', aoSubir);
        el.removeEventListener('pointercancel', aoSubir);
        el.removeEventListener('dblclick', aoDuplo);
      },
    };
  }

  window.TuffMidia = { player, grade, visor, tempo };
})();
