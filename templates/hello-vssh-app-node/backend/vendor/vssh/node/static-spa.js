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

function scriptTags(sources) {
  // Sem `defer`: precisa executar antes dos scripts diferidos do bundle, que já esperam o parse.
  // `src` vem do app, não do usuário — mas interpolar em HTML sem escapar é o tipo de coisa que
  // envelhece mal, então quebramos aspas duplas.
  return sources.map((src) => `<script src="${String(src).replace(/"/g, '&quot;')}"></script>`).join('\n');
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
 * @param {string[]} [options.injectScripts] srcs injetados antes de </head> no index
 * @param {Record<string,string>} [options.aliasPrefixes] prefixo → substituição, tentado quando o
 *   caminho pedido não existe (ver "Prefixos alias" no topo deste arquivo)
 * @param {boolean} [options.spaFallback] serve o index em rota desconhecida (roteamento HTML5)
 * @param {string} [options.missingBundleHint] linha extra na resposta de bundle ausente, para o
 *   app dizer como reconstruí-lo (ex.: 'Rode scripts/build.sh antes de subir o backend.')
 * @param {(event: object) => void} [options.onWarn]
 */
function createStaticSpa(options) {
  const root = path.resolve(options.root);
  const indexFile = options.indexFile || 'index.html';
  const injectScripts = options.injectScripts || [];
  const aliasPrefixes = Object.entries(options.aliasPrefixes || {});
  const spaFallback = !!options.spaFallback;
  const missingBundleHint = options.missingBundleHint || '';
  const onWarn = options.onWarn || (() => {});

  let indexCache = null;

  async function loadIndex() {
    const indexPath = path.join(root, indexFile);
    const stat = await fsp.stat(indexPath);
    if (indexCache && indexCache.mtimeMs === stat.mtimeMs) return indexCache.body;

    let html = await fsp.readFile(indexPath, 'utf8');
    if (injectScripts.length) {
      const tags = scriptTags(injectScripts);
      if (html.includes('</head>')) html = html.replace('</head>', `${tags}\n</head>`);
      else html = tags + html;
    }
    indexCache = { mtimeMs: stat.mtimeMs, body: Buffer.from(html, 'utf8') };
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

    const lastModified = stat.mtime.toUTCString();
    const ims = req.headers['if-modified-since'];
    if (ims && ims === lastModified) {
      res.writeHead(304, { 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(target),
      'Content-Length': stat.size,
      'Last-Modified': lastModified,
      // Bundle sem hash no nome (main.js, style.css) faria cache longo servir versão velha depois
      // de um upgrade do app. `no-cache` revalida e o 304 acima resolve em bytes zero.
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(target).pipe(res);
    return true;
  };
}

module.exports = { createStaticSpa, contentTypeFor };
