'use strict';

// Serve uma SPA já construída sob o prefixo de proxy de um vssh-app.
//
// Todo port de web app precisa disso, e todo mundo erra do mesmo jeito na primeira vez. Como a
// lib de FS, não sabe nada de app nenhum e não lê env var — só recebe um diretório e uma lista de
// scripts para injetar.
//
// O que NÃO está aqui de propósito: reescrever caminho absoluto (`/static/...`) para relativo.
// Isso é fato do app empacotado, resolvido em tempo de build, não em tempo de resposta —
// reescrever HTML a cada request é lento e esconde o problema real do bundle.
//
// ── Prefixos alias ───────────────────────────────────────────────────────────────────────────
// Um bundle pode assumir DOIS prefixos ao mesmo tempo para os mesmos arquivos. No Logseq o
// index.html publicado referencia `./js/main.js`, mas `frontend.util/JS_ROOT` hardcoda
// `./static/js` para tudo que é carregado dinamicamente (shepherd, katex). Upstream convive com
// isso porque o dev-server monta o mesmo diretório em duas raízes:
//
//     :dev-http {3001 ["static" "."]}      ;; shadow-cljs.edn
//
// Quem serve uma raiz só em produção quebra exatamente nos caminhos carregados dinamicamente —
// que são os que nenhum smoke test pega, porque a página inicial carrega inteira. `aliasPrefixes`
// reproduz esse comportamento sem duplicar o bundle no disco: se `/static/js/x` não existe, tenta
// `/js/x`. O caminho direto sempre tem prioridade, então o alias nunca sombreia um arquivo real.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Mapa próprio, e não o de vssh-app-fs: aquele cobre conteúdo de dados do app (imagem, PDF,
// áudio), este cobre bundle web (js, css, fonte, wasm). Duplicar um mapa pequeno é o preço de as
// duas peças serem independentes uma da outra.
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
  bin: 'application/octet-stream',
};

function contentTypeFor(p) {
  const dot = p.lastIndexOf('.');
  const ext = dot === -1 ? '' : p.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function scriptTags(sources, carimbo) {
  // Sem `defer`: precisa executar antes dos scripts diferidos do bundle, que já esperam o parse.
  // `src` vem do app, não do usuário — mas interpolar em HTML sem escapar é o tipo de coisa que
  // envelhece mal, então quebramos aspas duplas.
  return sources.map((src) => {
    const v = carimbo(src);
    const url = v ? `${src}${String(src).includes('?') ? '&' : '?'}v=${v}` : String(src);
    return `<script src="${url.replace(/"/g, '&quot;')}"></script>`;
  }).join('\n');
}

// ─── Carimbo de versão: por que ele existe, e por que header não bastava ─────
//
// O caso real que produziu isto: o `vssh-app-shim.js` foi atualizado e reinstalado no servidor,
// o arquivo em disco estava CERTO, e o navegador continuou executando o antigo — o app quebrava
// com `vssh.audio` undefined enquanto o `index.html` já era o novo.
//
// A defesa que havia era `Cache-Control: no-cache` mais revalidação por `Last-Modified`, e ela
// depende de TODO MUNDO no caminho colaborar: navegador, proxy do portal, CDN. Basta um elo
// guardar a resposta ou engolir o `If-Modified-Since` e o usuário fica com bytes velhos sem
// nenhum sinal — a página carrega, o script roda, só que é outro script.
//
// A correção não é um header melhor: é **fazer o conteúdo novo morar noutra URL**. Cache nenhum
// pode servir velho no lugar de novo se as duas coisas nem são o mesmo recurso. É exatamente o
// que o portal já faz com os assets do shell (`/b/<buildId>/...`, ver src/utils/build-id.ts) e o
// raciocínio de lá vale igual aqui: o hash sai do CONTEÚDO, não da versão do manifest nem da
// data, então ele muda quando — e só quando — os bytes mudam. Reinstalar a mesma versão mantém a
// URL, e o cache do usuário sobrevive.
//
// O `index.html` é `no-store`, então ele sempre chega fresco trazendo a URL carimbada nova. É
// esse par que fecha o ciclo: index nunca cacheado, asset cacheado para sempre.
const HASH_MAX_BYTES = 4 * 1024 * 1024;

function criarCarimbador(root, onWarn) {
  const cache = new Map();   // caminho absoluto → { mtimeMs, size, hash }

  /** Hash do conteúdo, memoizado por (mtime, tamanho). `null` = arquivo ilegível. */
  return function hashDe(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.hash;

    let hash;
    if (stat.size > HASH_MAX_BYTES) {
      // Arquivo grande (wasm, modelo, vídeo): ler tudo para carimbar custaria mais que o
      // problema resolve. mtime+tamanho é carimbo pior — muda entre instalações da mesma
      // versão, o que só custa um download a mais — mas nunca DEIXA de mudar quando o
      // conteúdo muda, que é a propriedade da qual a correção depende.
      hash = crypto.createHash('sha1')
        .update(`${stat.mtimeMs}:${stat.size}`).digest('hex').slice(0, 12);
    } else {
      try {
        hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
      } catch (err) {
        onWarn({ event: 'stamp-failed', file, message: err.message });
        return null;
      }
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  };
}

// O fallback de SPA só vale para navegação. Um `fetch('/api/x')` que erra o caminho tem de receber
// 404, não o index — senão o app tenta fazer JSON.parse de HTML e o erro aparece longe da causa.
function wantsHtml(req) {
  return (req.headers.accept || '').includes('text/html');
}

// Extensão conhecida = pedido de arquivo. Rota de SPA não costuma ter ponto no último segmento.
function looksLikeAsset(pathname) {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

/**
 * @param {object} options
 * @param {string} options.root            diretório do bundle construído
 * @param {string} [options.indexFile]     default 'index.html'
 * @param {string[]} [options.injectScripts] srcs injetados antes de </head> no index. Cada um sai
 *   com `?v=<hash do conteúdo>` e é servido como `immutable` — ver "Carimbo de versão" acima. Um
 *   src que não exista em disco sai sem carimbo, para não prometer uma versão que não há.
 * @param {Record<string,string>} [options.aliasPrefixes] prefixo → substituição, tentado quando o
 *   caminho pedido não existe (ver "Prefixos alias" no topo deste arquivo)
 * @param {boolean} [options.spaFallback] serve o index em rota desconhecida (roteamento HTML5)
 * @param {string} [options.missingBundleHint] linha extra na resposta de bundle ausente, para o
 *   app dizer como reconstruí-lo (ex.: 'Rode scripts/build.sh antes de subir o backend.')
 * @param {(event: object) => void} [options.onWarn]
 */
function createStaticSpa(options) {
  // A raiz precisa ser canonicalizada pela MESMA função que canonicaliza o alvo em `statWithin`
  // (`fsp.realpath`), senão a checagem de confinamento compara duas grafias do mesmo diretório e
  // nunca casa: TODO caminho aninhado vira 404 enquanto o index continua servindo — ele é lido
  // direto, sem passar pelo confinamento. Falha silenciosa e desconcertante.
  //
  // E tem de ser `realpathSync.native`, não `realpathSync`: no Windows só a nativa expande o nome
  // curto 8.3. Com o TEMP em `C:\Users\ARTHUR~1\...`, a versão JS devolve o caminho INALTERADO
  // enquanto `fsp.realpath` devolve `C:\Users\arthurcarrenho\...` — as duas "canônicas", nenhuma
  // igual à outra. Não é só Windows: `/tmp` no macOS é symlink para `/private/tmp`, e um deploy no
  // idioma `current -> releases/N` cai no mesmo buraco.
  //
  // O try existe porque o bundle pode não ter sido construído ainda — é o caso que
  // `missingBundleHint` atende. Aí fica o resolve lexical, e a canonicalização volta a valer no
  // próximo boot, quando o diretório existir.
  let root = path.resolve(options.root);
  try { root = fs.realpathSync.native(root); } catch { /* bundle ausente: segue lexical */ }
  const indexFile = options.indexFile || 'index.html';
  const injectScripts = options.injectScripts || [];
  const aliasPrefixes = Object.entries(options.aliasPrefixes || {});
  const spaFallback = !!options.spaFallback;
  const missingBundleHint = options.missingBundleHint || '';
  const onWarn = options.onWarn || (() => {});

  let indexCache = null;
  const hashDe = criarCarimbador(root, onWarn);
  const carimboDoSrc = (src) => hashDe(path.join(root, String(src).split('?')[0].replace(/^\/+/, '')));

  async function loadIndex() {
    const indexPath = path.join(root, indexFile);
    const stat = await fsp.stat(indexPath);
    // Os carimbos entram na CHAVE do cache, e não só no corpo: um shim atualizado sem que o
    // index mude é o caso normal (vssh-app-lib-sync mexe em `vendor/`, não em `index.html`).
    // Sem isto o processo continuaria servindo a URL carimbada antiga até alguém tocar no
    // index — e o carimbo teria virado enfeite justamente no cenário que ele existe para
    // cobrir.
    const carimbos = injectScripts.map((s) => `${s}=${carimboDoSrc(s) || ''}`).join('|');
    if (indexCache && indexCache.mtimeMs === stat.mtimeMs && indexCache.carimbos === carimbos) {
      return indexCache.body;
    }

    let html = await fsp.readFile(indexPath, 'utf8');
    if (injectScripts.length) {
      const tags = scriptTags(injectScripts, carimboDoSrc);
      if (html.includes('</head>')) html = html.replace('</head>', `${tags}\n</head>`);
      else html = tags + html;
    }
    indexCache = { mtimeMs: stat.mtimeMs, carimbos, body: Buffer.from(html, 'utf8') };
    return indexCache.body;
  }

  // Um caminho só é servido se cair dentro da raiz depois de resolvido. `pathname` vem da URL, então
  // "../" é entrada possível — e o alias reescreve caminho, o que exige checar de novo.
  //
  // A checagem lexical não basta sozinha: um symlink dentro do bundle apontando para fora passaria
  // por ela. Por isso o caminho real é revalidado depois do stat, do mesmo jeito que
  // vssh-app-fs/paths.js faz — as duas peças davam garantias diferentes sem motivo.
  async function statWithin(pathname) {
    const target = path.join(root, pathname);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) return null;
      const real = await fsp.realpath(target);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return { target, stat };
    } catch {
      return null;
    }
  }

  async function resolveTarget(pathname) {
    const direct = await statWithin(pathname);
    if (direct) return direct;
    for (const [prefix, replacement] of aliasPrefixes) {
      if (!pathname.startsWith(prefix)) continue;
      const aliased = await statWithin(replacement + pathname.slice(prefix.length));
      if (aliased) return aliased;
    }
    return null;
  }

  function sendIndex(req, res, body) {
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES.html,
      'Content-Length': body.length,
      // O index carrega o script de boot, que costuma trazer estado do usuário — nunca de cache.
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  }

  async function sendMissingBundle(res) {
    res.writeHead(500, { 'Content-Type': CONTENT_TYPES.txt });
    res.end(`Bundle não encontrado em ${root}.\n` + (missingBundleHint ? missingBundleHint + '\n' : ''));
  }

  return async function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    // `%` malformado faz decodeURIComponent lançar URIError. Isto estava fora do try e escapava do
    // handler inteiro, virando um 500 genérico no catch de quem monta as rotas.
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': CONTENT_TYPES.txt });
      res.end('Caminho inválido.\n');
      return true;
    }

    if (pathname === '/' || pathname === '/' + indexFile) {
      try {
        sendIndex(req, res, await loadIndex());
      } catch (err) {
        onWarn({ event: 'index-missing', root, message: err.message });
        await sendMissingBundle(res);
      }
      return true;
    }

    const resolved = await resolveTarget(pathname);
    if (!resolved) {
      // Fallback de SPA: roteamento HTML5 (History API) produz URLs que não são arquivo nenhum, e
      // sem isto elas viram 404 — o app abre na raiz e quebra em qualquer deep link ou F5.
      // Opt-in porque um app de roteamento por fragmento (como o Logseq) não precisa, e ligá-lo
      // sem necessidade transforma 404 de asset em HTML, que é bem mais difícil de diagnosticar.
      if (spaFallback && req.method !== 'HEAD' && wantsHtml(req) && !looksLikeAsset(pathname)) {
        try {
          sendIndex(req, res, await loadIndex());
        } catch (err) {
          onWarn({ event: 'index-missing', root, message: err.message });
          await sendMissingBundle(res);
        }
        return true;
      }
      return false; // 404 é decisão de quem compõe as rotas
    }
    const { target, stat } = resolved;

    // `?v=` CONFERIDO contra o hash de agora, e não aceito de boca. Carimbo velho — de um index
    // que sobreviveu em algum cache apesar do `no-store` — não pode ganhar `immutable`, senão
    // fixaria os bytes errados por um ano. Não bate, não é imutável: cai na revalidação de
    // sempre e o usuário recebe o arquivo certo.
    const pedido = url.searchParams?.get('v');
    const imutavel = !!pedido && pedido === hashDe(target);

    const lastModified = stat.mtime.toUTCString();
    const ims = req.headers['if-modified-since'];
    if (!imutavel && ims && ims === lastModified) {
      res.writeHead(304, { 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(target),
      'Content-Length': stat.size,
      'Last-Modified': lastModified,
      // Com carimbo válido, conteúdo novo mora em OUTRA URL — então esta pode ser cacheada para
      // sempre, e nenhum elo do caminho tem como servir velho no lugar de novo.
      //
      // Sem carimbo, é bundle de nome fixo (main.js, style.css): cache longo aí serviria versão
      // velha depois de um upgrade. `no-cache` revalida e o 304 acima resolve em bytes zero.
      'Cache-Control': imutavel ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(target).pipe(res);
    return true;
  };
}

module.exports = { createStaticSpa, contentTypeFor };
