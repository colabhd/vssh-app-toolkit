'use strict';

// Tuff — os ícones.
//
// Expõe `window.TuffIcones`, e instala o sprite no documento do app sozinho:
//
//     <svg class="tuff-ico"><use href="#ico-folder"></use></svg>
//     TuffIcones.svg('folder')            → a mesma marcação, como string
//     TuffIcones.tem('folder')            → existe?
//     TuffIcones.nomes()                  → todos, para uma galeria
//
// ─── Por que o sprite viaja aqui dentro ─────────────────────────────────────
//
// O shell tem um sprite inline no `index.html` DELE, e um app roda noutro documento — o `<use>`
// não atravessa. As alternativas foram consideradas e caem:
//
//   • `<use href="arquivo.svg#ico-x">` (referência externa) depende de CORS, tem histórico
//     irregular entre navegadores e, no caso que mais importa, **não herda `currentColor`** de
//     forma confiável — um ícone que não acompanha a cor do texto é meio ícone;
//   • uma fonte de ícones traz o problema que o `fonts.css` do shell já resolveu para a tipografia,
//     e ainda por cima renderiza texto onde deveria haver desenho.
//
// Injetar o sprite no documento do app reproduz EXATAMENTE o idioma do shell — mesmos ids, mesmo
// `<use href="#ico-…">` —, então quem conhece um conhece o outro. É o que "compilar o que já
// existe" quer dizer.
//
// ─── O modo de falha que decide tudo ────────────────────────────────────────
//
// ⚠ **Um `<use href>` que não resolve NÃO LANÇA. Ele simplesmente não desenha.** Esta não é uma
// preocupação teórica: no shell, `ContextMenu._ICON_MAP` apontava para um `ico-minus` que não
// existia, e "Diminuir Fonte" apareceu como um quadrado vazio de 14×14 em dois menus, **por
// meses**, sem uma linha no console. O `tests/unit/sprite-icons.test.js` de lá nasceu disso.
//
// Por isso `TuffIcones.svg()` **avisa no console** quando o nome não existe, e por isso
// `tests/tuff-icones.test.js` recusa qualquer `#ico-…` citado no repositório que não esteja aqui.
// Sem as duas, o desenho que falta é indistinguível do desenho que ninguém pediu.

(function () {

  /** id sem o prefixo `ico-` → o `<symbol>` inteiro. */
  const SIMBOLOS = {

  // ── Os 60 do shell, verbatim ──────────────────────────────────────────────
  //
  // ⚠ Copiados sem uma vírgula de diferença, inclusive as três espessuras de traço (1.3, 1.4
  // e 1.5) e os dois sólidos. Normalizar seria adivinhar: ícone denso costuma ser afinado de
  // propósito para o peso óptico bater, e eu não desenhei nenhum deles. A pergunta está
  // registrada em `tests/tuff-icones.test.js`, com os números.
  'folder':
    '<symbol id="ico-folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5V12.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1H7.5L6 5H3a1 1 0 0 0-1 1V8.5z"/></symbol>',
  'folder-open':
    '<symbol id="ico-folder-open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9L3.5 14h9L14 9H7.5L6 7.5H3a1 1 0 0 0-1 1V9z"/><path d="M2 9V7a1 1 0 0 1 1-1h3L7.5 7.5H13.5"/></symbol>',
  'cloud':
    '<symbol id="ico-cloud" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 12.5h6.65a2.75 2.75 0 0 0 .45-5.46A3.75 3.75 0 0 0 4.5 6.55 3 3 0 0 0 4.6 12.5z"/></symbol>',
  'lock':
    '<symbol id="ico-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7"/></symbol>',
  'file':
    '<symbol id="ico-file" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h7L14 5v9.5H4V1.5z"/><path d="M11 1.5V5H14"/></symbol>',
  'file-code':
    '<symbol id="ico-file-code" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h7L14 5v9.5H4V1.5z"/><path d="M11 1.5V5H14"/><path d="M6.5 8.5L5 10l1.5 1.5"/><path d="M9.5 8.5L11 10l-1.5 1.5"/></symbol>',
  'terminal':
    '<symbol id="ico-terminal" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L7 8 2.5 11.5"/><path d="M9.5 12h4"/></symbol>',
  'settings':
    '<symbol id="ico-settings" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5V3M8 13V14.5M1.5 8H3M13 8H14.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/></symbol>',
  'search':
    '<symbol id="ico-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M11 11L14.5 14.5"/></symbol>',
  'refresh':
    '<symbol id="ico-refresh" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 7A6 6 0 1 1 10.5 2.5"/><path d="M10.5 1V4H14"/></symbol>',
  'copy':
    '<symbol id="ico-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="8" height="9" rx="1"/><path d="M6 5V3.5A1.5 1.5 0 0 1 7.5 2H12.5A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H10"/></symbol>',
  'paste':
    '<symbol id="ico-paste" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H10.5"/><path d="M5.5 1.5H10.5V4H5.5V1.5z"/><path d="M5.5 8.5h5M5.5 11h3.5"/></symbol>',
  'trash':
    '<symbol id="ico-trash" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M5.5 4.5V3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5"/><path d="M3.5 4.5L4.5 13.5h7l1-9"/></symbol>',
  'edit':
    '<symbol id="ico-edit" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-9 9H2v-3L11 2z"/></symbol>',
  'minimize':
    '<symbol id="ico-minimize" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10"/></symbol>',
  'maximize':
    '<symbol id="ico-maximize" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="1"/></symbol>',
  'close':
    '<symbol id="ico-close" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 3L13 13M13 3L3 13"/></symbol>',
  'pin':
    '<symbol id="ico-pin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L14.5 7l-2.5 2.5-1.5-1.5L5 13H3v-2L7.5 6.5 6 5 9 1.5z"/><path d="M2 14L5.5 10.5"/></symbol>',
  'plus':
    '<symbol id="ico-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2.5V13.5M2.5 8H13.5"/></symbol>',
  'minus':
    '<symbol id="ico-minus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 8H13.5"/></symbol>',
  'check':
    '<symbol id="ico-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5L5.5 12 14 4.5"/></symbol>',
  'print':
    '<symbol id="ico-print" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.2V2.2h7v4"/><path d="M4.5 12H3.1a1.3 1.3 0 0 1-1.3-1.3V7.5a1.3 1.3 0 0 1 1.3-1.3h9.8a1.3 1.3 0 0 1 1.3 1.3v3.2a1.3 1.3 0 0 1-1.3 1.3h-1.4"/><path d="M4.5 9.9h7v3.9h-7z"/></symbol>',
  'bell':
    '<symbol id="ico-bell" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8a4.2 4.2 0 0 0-4.2 4.2c0 3.3-1.3 4.4-1.3 4.4h11c0 0-1.3-1.1-1.3-4.4A4.2 4.2 0 0 0 8 1.8z"/><path d="M6.6 12.8a1.6 1.6 0 0 0 2.8 0"/></symbol>',
  'info':
    '<symbol id="ico-info" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5V11.5M8 5V5.5"/></symbol>',
  'warning':
    '<symbol id="ico-warning" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L14.5 13.5H1.5L8 1.5z"/><path d="M8 6.5V9.5M8 11V12"/></symbol>',
  'download':
    '<symbol id="ico-download" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2V11M5 8l3 3 3-3"/><path d="M2.5 13.5h11"/></symbol>',
  'home':
    '<symbol id="ico-home" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7L8 2l5.5 5V14H10v-4H6v4H2.5V7z"/></symbol>',
  'arrow-left':
    '<symbol id="ico-arrow-left" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3L5 8l5.5 5"/></symbol>',
  'arrow-right':
    '<symbol id="ico-arrow-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3L11 8 5.5 13"/></symbol>',
  'upload':
    '<symbol id="ico-upload" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V4M5 7l3-3 3 3M2.5 13.5h11"/></symbol>',
  'external':
    '<symbol id="ico-external" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4M14 2l-6 6"/><path d="M7 4H3.5A1.5 1.5 0 0 0 2 5.5v7A1.5 1.5 0 0 0 3.5 14h7A1.5 1.5 0 0 0 12 12.5V9"/></symbol>',
  'more':
    '<symbol id="ico-more" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12" cy="8" r="1.3"/></symbol>',
  'grid':
    '<symbol id="ico-grid" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></symbol>',
  'image':
    '<symbol id="ico-image" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" opacity=".8"/><path d="M1.5 10.5l4-4 3 3 2-2.5 5 5"/></symbol>',
  'video':
    '<symbol id="ico-video" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3.5" width="10" height="9" rx="1.5"/><path d="M11.5 6.5l3.5-2v7l-3.5-2V6.5z" fill="currentColor" stroke="none" opacity=".8"/></symbol>',
  'audio':
    '<symbol id="ico-audio" viewBox="0 0 16 16" fill="currentColor"><circle cx="4.5" cy="11.5" r="2" opacity=".9"/><circle cx="11.5" cy="9.5" r="2" opacity=".9"/><path d="M6.5 11.5V4.5l7-1.5v5.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></symbol>',
  'archive':
    '<symbol id="ico-archive" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="9" rx="1.5"/><path d="M1.5 5h13M6 8h4"/><rect x="5.5" y="1.5" width="5" height="3.5" rx="1"/></symbol>',
  'pdf':
    '<symbol id="ico-pdf" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h7l3 3v9H4V2z"/><path d="M11 2v3h3"/><path d="M6.5 10h1c.6 0 1-.4 1-1s-.4-1-1-1H6v3M10 9v2M10 11h1.5" stroke-linecap="round"/></symbol>',
  'palette':
    '<symbol id="ico-palette" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><circle cx="5.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="4.5" r="1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="6" r="1" fill="currentColor" stroke="none"/><path d="M5.5 10a2.5 2.5 0 0 0 5 0c0-1.5-1-2-2.5-2s-2.5.5-2.5 2z" fill="currentColor" stroke="none" opacity=".5"/></symbol>',
  'globe':
    '<symbol id="ico-globe" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 2C6.7 3.8 6 5.8 6 8s.7 4.2 2 6"/><path d="M8 2c1.3 1.8 2 3.8 2 6s-.7 4.2-2 6"/><path d="M2.5 5.5h11M2.5 10.5h11"/></symbol>',
  'volume-off':
    '<symbol id="ico-volume-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5L5 6H2.5v4H5l3 3V3.5z"/><path d="M11 6.5l2.5 3M13.5 6.5L11 9.5"/></symbol>',
  'volume-on':
    '<symbol id="ico-volume-on" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5L5 6H2.5v4H5l3 3V3.5z"/><path d="M11 5.5c.9.8 1.5 1.8 1.5 2.5s-.6 1.7-1.5 2.5"/></symbol>',
  'volume-low':
    '<symbol id="ico-volume-low" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5L5 6H2.5v4H5l3 3V3.5z"/><path d="M10.75 6.5c.5.45.75.95.75 1.5s-.25 1.05-.75 1.5"/></symbol>',
  'monitor':
    '<symbol id="ico-monitor" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M6 14h4M8 11.5V14"/></symbol>',
  'keyboard':
    '<symbol id="ico-keyboard" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M4 7.5h.01M7 7.5h.01M10 7.5h.01M13 7.5h.01M5.5 9.5h5"/></symbol>',
  'layout':
    '<symbol id="ico-layout" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M4 7.5h1.5M7 7.5h2M10.5 7.5H12M5 9.5h6"/><circle cx="13.5" cy="3" r="1" fill="currentColor" stroke="none"/></symbol>',
  'tiling':
    '<symbol id="ico-tiling" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6.5 2.5v11"/><rect x="1.5" y="2.5" width="5" height="11" rx="1.5" fill="currentColor" stroke="none" opacity=".35"/></symbol>',
  'fullscreen':
    '<symbol id="ico-fullscreen" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></symbol>',
  'fullscreen-exit':
    '<symbol id="ico-fullscreen-exit" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"/></symbol>',
  'menu':
    '<symbol id="ico-menu" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/></symbol>',
  'chevron-down':
    '<symbol id="ico-chevron-down" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6L8 10.5 12.5 6"/></symbol>',
  'clock':
    '<symbol id="ico-clock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/></symbol>',
  'bell-off':
    '<symbol id="ico-bell-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 3.3A4 4 0 0 1 12 6c0 3 1 4 1 4H6.5"/><path d="M4 4.6C3.7 5 3.5 5.5 3.5 6c0 3-1 4-1 4h7"/><path d="M6.6 13a1.8 1.8 0 0 0 2.8 0"/><path d="M2.2 2.2l11.6 11.6"/></symbol>',
  'power':
    '<symbol id="ico-power" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v6"/><path d="M12 4.2a5.5 5.5 0 1 1-8 0"/></symbol>',
  'cpu':
    '<symbol id="ico-cpu" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14"/></symbol>',
  'shield':
    '<symbol id="ico-shield" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.75 13 3.5v4.25c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.5L8 1.75z"/></symbol>',
  'bar-bottom':
    '<symbol id="ico-bar-bottom" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="1.5" y="10.5" width="13" height="3" rx="1" fill="currentColor" stroke="none"/></symbol>',
  'bar-top':
    '<symbol id="ico-bar-top" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="1.5" y="2.5" width="13" height="3" rx="1" fill="currentColor" stroke="none"/></symbol>',
  'bar-left':
    '<symbol id="ico-bar-left" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="1.5" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" stroke="none"/></symbol>',
  'bar-right':
    '<symbol id="ico-bar-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="11" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" stroke="none"/></symbol>',

  // ── As adições, que o shell ainda não tem ─────────────────────────────────
  //
  // O que um visualizador de fotos e um player de vídeo pedem, e que não existia em lado
  // nenhum. Cada um é candidato a subir para o shell — ver a lista em `tests/tuff-icones.test.js`.
  'play':
    '<symbol id="ico-play" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 3.4v9.2l7.6-4.6z"/></symbol>',
  'pause':
    '<symbol id="ico-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5h2.3v9H5zm3.7 0H11v9H8.7z"/></symbol>',
  'stop':
    '<symbol id="ico-stop" viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx=".8"/></symbol>',
  'skip-back':
    '<symbol id="ico-skip-back" viewBox="0 0 16 16" fill="currentColor"><path d="M12.2 3.5v9L5.6 8zM3.5 3.5h1.6v9H3.5z"/></symbol>',
  'skip-forward':
    '<symbol id="ico-skip-forward" viewBox="0 0 16 16" fill="currentColor"><path d="M3.8 3.5v9L10.4 8zM10.9 3.5h1.6v9h-1.6z"/></symbol>',
  // ⚠ Os dois que faltavam, e a falta era estranha: a lib tinha `play`, `pause`, `stop`,
  // `skip-back`, `skip-forward`, `repeat`, `shuffle`, `pip`, `speed` e `subtitles` — e não tinha
  // os DOIS botões mais usados de um player depois do play. `skip-*` é "outra faixa"; estes são
  // "dez segundos atrás", que é outro gesto e o mais repetido de todos ao rever um trecho.
  // ⚠ Eram `rewind`/`forward` — duas setas duplas, o glifo de "avanço rápido". Estava errado, e
  // não por estética: os dois ÚNICOS consumidores usam este botão para pular DEZ SEGUNDOS, e avanço
  // rápido é outro gesto. Sem o número, ele também não se distingue de "próxima faixa", que é o
  // botão vizinho. O nome mudou junto: um ícone com "10" desenhado dentro não tem como significar
  // outra coisa, e chamá-lo de `forward` seria um nome que mente.
  'voltar-10':
    '<symbol id="ico-voltar-10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.1 7.4a5 5 0 1 0 1.7-3.3"/><path d="M2.3 2.6l.2 2.9 2.9-.2"/><path d="M6.4 8.1l.8-.6v4"/><rect x="8.9" y="7.5" width="2.6" height="4" rx="1.3"/></symbol>',
  'avancar-10':
    '<symbol id="ico-avancar-10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12.9 7.4a5 5 0 1 1-1.7-3.3"/><path d="M13.7 2.6l-.2 2.9-2.9-.2"/><path d="M6.4 8.1l.8-.6v4"/><rect x="8.9" y="7.5" width="2.6" height="4" rx="1.3"/></symbol>',
  // Os cinco que um player COMPLETO pede, e que nem o shell nem a primeira leva tinham. Note quem
  // NÃO está aqui: `cast`. Ele seria desenho sem consumidor — não há Chromecast neste ambiente —, e
  // um ícone que ninguém usa é a mesma dívida que uma classe CSS que não estiliza nada. Foi o erro
  // que `chevron-left`/`chevron-right` já custaram neste arquivo.
  'pip':
    '<symbol id="ico-pip" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><rect x="8" y="7.9" width="4.4" height="3.4" rx=".6"/></symbol>',
  'subtitles':
    '<symbol id="ico-subtitles" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1"/><path d="M4.4 7.3h7.2M4.4 9.9h4.4"/></symbol>',
  'speed':
    '<symbol id="ico-speed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 11.8a5.8 5.8 0 0 1 11.6 0"/><path d="M8 11.8l3-3.6"/></symbol>',
  'repeat':
    '<symbol id="ico-repeat" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 9.4V6.6a2 2 0 0 1 2-2h7.2"/><path d="M10.6 2.4l2.2 2.2-2.2 2.2"/><path d="M12.6 6.6v2.8a2 2 0 0 1-2 2H3.4"/><path d="M5.4 13.6l-2.2-2.2 2.2-2.2"/></symbol>',
  // O par do `repeat`, e ele existe por uma razão de comportamento: repetir é TRI-ESTADO
  // (desligado → tudo → uma), e três estados não cabem num glifo só com uma cor. Sem este, "repetir
  // uma" e "repetir tudo" ficariam indistinguíveis — um controle que não mostra o próprio estado é
  // um controle que mente.
  'repeat-one':
    '<symbol id="ico-repeat-one" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 9.4V6.6a2 2 0 0 1 2-2h7.2"/><path d="M10.6 2.4l2.2 2.2-2.2 2.2"/><path d="M12.6 6.6v2.8a2 2 0 0 1-2 2H3.4"/><path d="M5.4 13.6l-2.2-2.2 2.2-2.2"/><path d="M7.3 7.3l1.3-.8v3.2"/></symbol>',
  'shuffle':
    '<symbol id="ico-shuffle" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 4.4h2.1l6.6 7.2h2.2"/><path d="M2.6 11.6h2.1l6.6-7.2h2.2"/><path d="M11.3 2.4l2.2 2-2.2 2"/><path d="M11.3 9.6l2.2 2-2.2 2"/></symbol>',
  'zoom-in':
    '<symbol id="ico-zoom-in" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3.5 3.5"/><path d="M7 5.2v3.6M5.2 7h3.6"/></symbol>',
  'zoom-out':
    '<symbol id="ico-zoom-out" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3.5 3.5"/><path d="M5.2 7h3.6"/></symbol>',
  'fit':
    '<symbol id="ico-fit" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1"/><path d="M5.2 6.2h5.6v3.6H5.2z"/></symbol>',
  'rotate-left':
    '<symbol id="ico-rotate-left" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9"/><path d="M2.2 3.2v3.3h3.3"/></symbol>',
  'rotate-right':
    '<symbol id="ico-rotate-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.8 3.2v3.3h-3.3"/></symbol>',
  'crop':
    '<symbol id="ico-crop" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 1.6v9.8h9.8"/><path d="M1.6 4.6h9.8v9.8"/></symbol>',
  'eye':
    '<symbol id="ico-eye" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8S3.9 4 8 4s6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.8"/></symbol>',
  'eye-off':
    '<symbol id="ico-eye-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 4.2A6.7 6.7 0 0 1 8 4c4.1 0 6.5 4 6.5 4a12.4 12.4 0 0 1-2.1 2.5M4.2 5.4A12.3 12.3 0 0 0 1.5 8s2.4 4 6.5 4c.8 0 1.6-.15 2.3-.4"/><path d="M2 2l12 12"/></symbol>',
  'chevron-up':
    '<symbol id="ico-chevron-up" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10L8 5.5l4.5 4.5"/></symbol>',
  'star':
    '<symbol id="ico-star" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l1.8 3.75 4.05.58-2.93 2.9.7 4.15L8 11.62l-3.62 1.98.7-4.15L2.15 6.53l4.05-.58z"/></symbol>',
  'check-circle':
    '<symbol id="ico-check-circle" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.4 8.2l1.9 1.9 3.4-3.7"/></symbol>',
  'x-circle':
    '<symbol id="ico-x-circle" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8"/></symbol>',
  'help':
    '<symbol id="ico-help" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6.35 6.3a1.7 1.7 0 1 1 2.3 1.7c-.5.2-.65.6-.65 1v.25"/><path d="M8 11.7h.01"/></symbol>',
  'filter':
    '<symbol id="ico-filter" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 3.2h11.6l-4.55 5.35v4.05l-2.5 1.2V8.55z"/></symbol>',
  'list':
    '<symbol id="ico-list" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.6 4h.01M2.6 8h.01M2.6 12h.01"/></symbol>',
  'columns':
    '<symbol id="ico-columns" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.2" width="12" height="9.6" rx="1"/><path d="M8 3.2v9.6"/></symbol>',
  'tag':
    '<symbol id="ico-tag" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.9H13a1 1 0 0 1 1 1v4.5a1 1 0 0 1-.3.7l-5.6 5.6a1 1 0 0 1-1.4 0L2.3 9.3a1 1 0 0 1 0-1.4l5.5-5.6a1 1 0 0 1 .7-.4z"/><path d="M11 5h.01"/></symbol>',
  'calendar':
    '<symbol id="ico-calendar" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3.4" width="12" height="10.6" rx="1"/><path d="M2 6.6h12M5.4 1.9v3M10.6 1.9v3"/></symbol>',
  'link':
    '<symbol id="ico-link" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.7 9.3a2.9 2.9 0 0 0 4.1 0l1.9-1.9a2.9 2.9 0 1 0-4.1-4.1l-1 1"/><path d="M9.3 6.7a2.9 2.9 0 0 0-4.1 0L3.3 8.6a2.9 2.9 0 1 0 4.1 4.1l1-1"/></symbol>',
  'share':
    '<symbol id="ico-share" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11.8" cy="3.6" r="1.9"/><circle cx="4.2" cy="8" r="1.9"/><circle cx="11.8" cy="12.4" r="1.9"/><path d="M5.9 7.05l4.2-2.5M5.9 8.95l4.2 2.5"/></symbol>',
  'save':
    '<symbol id="ico-save" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.6a1 1 0 0 1 1-1h7.1L13.5 5.5v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M5.2 2.6v3.6h5.4V2.6"/><path d="M5.2 13.5V9.6h5.6v3.9"/></symbol>',
  'drag':
    '<symbol id="ico-drag" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 4h.01M9.8 4h.01M6.2 8h.01M9.8 8h.01M6.2 12h.01M9.8 12h.01"/></symbol>',
  };

  const ID_DO_SPRITE = 'tuff-sprite';

  /**
   * Põe o sprite no documento, uma vez.
   *
   * `aria-hidden` e `display:none` no contêiner: ele não é conteúdo, é uma biblioteca de formas.
   * Sem o `aria-hidden`, um leitor de tela percorre sessenta símbolos vazios antes de chegar à
   * página.
   */
  function instalar(doc) {
    const d = doc || document;
    if (!d || !d.body || d.getElementById(ID_DO_SPRITE)) return;
    const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = ID_DO_SPRITE;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('style', 'display:none');
    svg.innerHTML = Object.values(SIMBOLOS).join('');
    // No começo do `<body>`, e não no fim: um `<use>` que aponte para um símbolo ainda não
    // presente resolve sozinho quando ele chega, mas só depois de um reflow — e a primeira pintura
    // sairia com os ícones vazios.
    d.body.insertBefore(svg, d.body.firstChild);
  }

  /**
   * A marcação de um ícone, como string.
   *
   * `focusable="false"` é para o IE/Edge antigo não pôr o `<svg>` na ordem de tabulação; custa
   * nada e evita paradas de Tab invisíveis. `aria-hidden` porque um ícone é sempre acompanhado de
   * um rótulo — se ele for a única informação, quem chama tem de dar um `aria-label` ao BOTÃO, e
   * não ao desenho.
   */
  function svg(nome, classe) {
    if (!SIMBOLOS[nome]) {
      // Avisa, e devolve nada. Um `<use>` quebrado não lança e não desenha — é o defeito que
      // sobreviveu meses no shell, e ele só é achável se alguém falar.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[tuff] ícone '${nome}' não existe — use TuffIcones.nomes() para ver a lista`);
      }
      return '';
    }
    const c = classe ? `tuff-ico ${classe}` : 'tuff-ico';
    return `<svg class="${c}" aria-hidden="true" focusable="false"><use href="#ico-${nome}"></use></svg>`;
  }

  const tem = (nome) => Object.prototype.hasOwnProperty.call(SIMBOLOS, nome);
  const nomes = () => Object.keys(SIMBOLOS);

  window.TuffIcones = { instalar, svg, tem, nomes };

  // Instala sozinho: um app que carrega esta lib quer os ícones, e obrigar a chamar `instalar()`
  // só cria uma chance de esquecer — cujo sintoma é a página inteira sem ícone nenhum.
  // `&& document`, e não só o `typeof`: num sandbox de teste o global existe e vale `null`, e ali
  // `document.body` estoura no carregamento do arquivo — derrubando tudo que viesse depois.
  if (typeof document !== 'undefined' && document && document.addEventListener) {
    if (document.body) instalar(document);
    else document.addEventListener('DOMContentLoaded', () => instalar(document));
  }
})();
