'use strict';

// Tuff — o comportamento do núcleo. Hoje, a gaveta de navegação.
//
//     TuffGaveta.ligar(raiz)   → { abrir, fechar, destruir }
//
// A maior parte da biblioteca é CSS puro de propósito: switch e controle segmentado são `<input>`
// de verdade, o disclosure é `<details>`, e o que se ganha com isso — teclado, foco, estado
// anunciado a leitor de tela — vem pronto e não se quebra.
//
// A gaveta não cabe nisso, e vale dizer por quê: ela precisa **devolver o foco** para quem a abriu,
// **fechar no Esc**, e **saber em que seção a pessoa está**. As três são comportamento, e um
// `:has(input:checked)` faria a peça parecer pronta enquanto deixa as três de fora.

(function () {

  const ABERTA = 'tuff-gaveta--aberta';
  const ATIVO = 'tuff-gaveta-item--ativo';

  /**
   * Liga uma `.tuff-gaveta`.
   *
   * A marcação esperada, e tudo é opcional menos a raiz:
   *
   *     <div class="tuff-gaveta">
   *       <div class="tuff-gaveta-veu"></div>
   *       <nav class="tuff-gaveta-lateral">
   *         <button class="tuff-gaveta-item" data-alvo="id-da-secao"><span>Rótulo</span></button>
   *       </nav>
   *       <div class="tuff-gaveta-corpo"> … <section id="id-da-secao"> … </div>
   *     </div>
   *
   * O botão que abre vive fora da lateral, com `data-tuff-gaveta-abrir`.
   */
  function ligar(raiz, opcoes) {
    if (!raiz) return { abrir() {}, fechar() {}, destruir() {} };
    const o = opcoes || {};
    const lateral = raiz.querySelector('.tuff-gaveta-lateral');
    const corpo = raiz.querySelector('.tuff-gaveta-corpo');
    const veu = raiz.querySelector('.tuff-gaveta-veu');
    const botao = (o.botao || raiz.querySelector('[data-tuff-gaveta-abrir]')
      || (raiz.parentNode && raiz.parentNode.querySelector('[data-tuff-gaveta-abrir]')));
    const itens = [...raiz.querySelectorAll('.tuff-gaveta-item')];
    const desfazer = [];
    const ouvir = (alvo, tipo, fn, op) => {
      if (!alvo) return;
      alvo.addEventListener(tipo, fn, op);
      desfazer.push(() => alvo.removeEventListener(tipo, fn, op));
    };

    if (botao) {
      botao.setAttribute('aria-expanded', 'false');
      if (lateral && lateral.id) botao.setAttribute('aria-controls', lateral.id);
    }

    function abrir() {
      raiz.classList.add(ABERTA);
      if (botao) botao.setAttribute('aria-expanded', 'true');
      // O foco entra na gaveta. Sem isto, abrir por teclado não leva a lugar nenhum: o menu aparece
      // e o foco continua no botão, atrás do véu.
      const primeiro = itens.find((i) => i.offsetParent !== null) || itens[0];
      if (primeiro) primeiro.focus();
    }

    function fechar(devolverFoco) {
      if (!raiz.classList.contains(ABERTA)) return;
      raiz.classList.remove(ABERTA);
      if (botao) botao.setAttribute('aria-expanded', 'false');
      // ⚠ E o foco VOLTA para quem abriu. Fechar sem devolver joga o foco para o começo do
      // documento, e quem navega por teclado tem de refazer o caminho inteiro — o tipo de detalhe
      // que só aparece usando sem mouse.
      if (devolverFoco && botao) botao.focus();
    }

    ouvir(botao, 'click', () => {
      if (raiz.classList.contains(ABERTA)) fechar(true); else abrir();
    });
    ouvir(veu, 'click', () => fechar(true));

    // Esc no documento, e não na gaveta: o foco pode ter ido para um item, para o véu, ou para
    // lugar nenhum. Escutar só na lateral perderia os dois últimos casos.
    ouvir(document, 'keydown', (e) => {
      if (e.key === 'Escape' && raiz.classList.contains(ABERTA)) { e.preventDefault(); fechar(true); }
    });

    function marcar(alvo) {
      for (const i of itens) i.classList.toggle(ATIVO, i.dataset.alvo === alvo);
      for (const i of itens) {
        if (i.dataset.alvo === alvo) i.setAttribute('aria-current', 'true');
        else i.removeAttribute('aria-current');
      }
    }

    for (const item of itens) {
      ouvir(item, 'click', () => {
        const alvo = item.dataset.alvo && raiz.querySelector(`#${CSS.escape(item.dataset.alvo)}`);
        if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
        marcar(item.dataset.alvo);
        // Fecha só quando ela ESTÁ em modo gaveta. Persistente, ela responde "onde eu estou", e
        // fechá-la apagaria a resposta no momento em que a pessoa acabou de perguntar.
        if (raiz.classList.contains(ABERTA)) fechar(false);
      });
    }

    // ── Onde a pessoa está ────────────────────────────────────────────────────
    //
    // A lateral acompanha a ROLAGEM, e não só o clique. Sem isto ela mente depois do primeiro
    // gesto de rolar: marca a última seção clicada enquanto a tela mostra outra.
    let observador = null;
    const alvos = itens
      .map((i) => i.dataset.alvo && raiz.querySelector(`#${CSS.escape(i.dataset.alvo)}`))
      .filter(Boolean);
    if (alvos.length && typeof IntersectionObserver === 'function') {
      const visiveis = new Set();
      observador = new IntersectionObserver((entradas) => {
        for (const e of entradas) {
          if (e.isIntersecting) visiveis.add(e.target); else visiveis.delete(e.target);
        }
        // A de cima entre as visíveis, e não a primeira que o observador relatou: rolando para
        // trás, a ordem dos eventos é a inversa da ordem na tela.
        let topo = null;
        for (const alvo of alvos) if (visiveis.has(alvo)) { topo = alvo; break; }
        if (topo) marcar(topo.id);
      }, {
        root: corpo && corpo.scrollHeight > corpo.clientHeight ? corpo : null,
        // A faixa de cima: uma seção conta como "onde estou" quando chega ao terço superior, que é
        // onde os olhos estão. Com `0px` a marcação troca cedo demais e fica trocando sozinha.
        rootMargin: '0px 0px -66% 0px',
      });
      for (const alvo of alvos) observador.observe(alvo);
    }

    return {
      abrir,
      fechar: () => fechar(false),
      destruir() {
        if (observador) observador.disconnect();
        for (const f of desfazer) f();
      },
    };
  }

  window.TuffGaveta = { ligar };
})();
