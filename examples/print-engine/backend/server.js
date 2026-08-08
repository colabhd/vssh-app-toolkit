'use strict';

// Motor de impressão — `provides: ["print/v1"]`.
//
// ─── O contrato, e ele é curto de propósito ────────────────────────────────
//
//   GET  /healthz          → 200 "ok". Não depende do chromium: o healthcheck do portal tem teto
//                            de 15 s e bloqueia o clique de quem abre o app. Responder aqui só
//                            depois de conferir uma ferramenta externa é como se transforma
//                            "está lento" em "não subiu".
//   GET  /capabilities     → { capability: "print/v1", ok, motivo }. É AQUI que se descobre se o
//                            chromium existe — a pergunta cara, feita quando alguém precisa da
//                            resposta, não no boot.
//   POST /render           → { origem, destino? } → { ok, caminho } | { ok:false, motivo }
//
// ─── Por que o PDF fica no SERVIDOR ────────────────────────────────────────
//
// É a mesma razão de o `lp` rodar lá: o arquivo não viaja. Um PDF de 200 páginas gerado aqui e
// devolvido pela rede desfaria justamente o destino que este motor existe para oferecer — se
// fosse para o arquivo atravessar, o navegador já imprime sozinho.
//
// O caminho devolvido é o que o ambiente abre no visualizador. Quem quiser o arquivo na máquina
// dele baixa depois, pelo gerenciador de arquivos, que é onde baixar já mora.
//
// ─── Por que chromium, e não uma biblioteca ────────────────────────────────
//
// A promessa deste destino é **fidelidade ao que a pessoa viu**. O que ela viu foi renderizado
// por um navegador; qualquer outro renderizador diverge no CSS de impressão — `@page`, quebras,
// `print-color-adjust` — e a divergência só aparece depois de imprimir. Uma biblioteca leve seria
// menor e entregaria outro arquivo.

const http = require('node:http');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.VSSH_APP_PORT) || 0;
const TOKEN = process.env.VSSH_APP_TOKEN || '';
const DATA = process.env.VSSH_APP_DATA_DIR || os.tmpdir();

/** Os nomes com que o chromium se apresenta em distro de verdade. Ordem = preferência. */
const CANDIDATOS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

let _binario = null;
function acharChromium() {
  if (_binario !== null) return _binario;
  for (const nome of CANDIDATOS) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, nome);
      try { fs.accessSync(p, fs.constants.X_OK); _binario = p; return p; } catch { /* próximo */ }
    }
  }
  _binario = '';
  return '';
}

/**
 * Extensões que o chromium abre e imprime com fidelidade.
 *
 * Fora daqui ele **abre mesmo assim** e imprime a tela de download ou de erro — um PDF de uma
 * página dizendo que não sabe abrir o arquivo. Recusar antes é a diferença entre "este tipo não
 * dá" e um arquivo inútil que parece ter dado certo.
 */
const RENDERIZAVEIS = /\.(html?|xhtml|md|txt|log|csv|svg|pdf|png|jpe?g|gif|webp)$/i;

function json(res, code, corpo) {
  const b = Buffer.from(JSON.stringify(corpo));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

/** O PDF ao lado do original: `relatorio.html` → `relatorio.pdf`. */
function destinoPadrao(origem) {
  const dir = path.dirname(origem);
  const base = path.basename(origem).replace(/\.[^.]*$/, '');
  return path.join(dir, `${base}.pdf`);
}

function renderizar(origem, destino) {
  return new Promise((resolve) => {
    const bin = acharChromium();
    if (!bin) return resolve({ ok: false, motivo: 'sem-chromium' });

    const args = [
      '--headless=new',
      '--disable-gpu',
      // O motor roda como o usuário, num servidor sem sessão gráfica. Sem isto o chromium tenta
      // um perfil em `~/.config` que pode não existir e morre sem dizer por quê.
      `--user-data-dir=${path.join(DATA, 'chrome-profile')}`,
      '--no-first-run',
      '--no-sandbox',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${destino}`,
      `file://${origem}`,
    ];
    execFile(bin, args, { timeout: 60000 }, (err, _out, stderr) => {
      if (err) {
        // O stderr do chromium é o que diz o que aconteceu. Devolver a linha de comando em vez do
        // motivo foi um defeito que a Onda 4 já pagou uma vez, no benchmark de GPU.
        const linha = String(stderr || err.message || '').trim().split('\n').filter(Boolean).pop();
        return resolve({ ok: false, motivo: 'falhou', detalhe: (linha || '').slice(0, 300) });
      }
      // O chromium sai 0 mesmo quando não escreveu nada — conferir o arquivo é o que separa
      // "renderizou" de "terminou".
      try {
        const st = fs.statSync(destino);
        if (!st.size) return resolve({ ok: false, motivo: 'vazio' });
      } catch { return resolve({ ok: false, motivo: 'vazio' }); }
      resolve({ ok: true, caminho: destino });
    });
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // O healthcheck é isento do token DE PROPÓSITO: o poll do portal não passa pelo proxy, então
  // não carrega o header. Um gate aqui faz o app nunca ficar "pronto".
  if (url.pathname === '/healthz') return res.end('ok');

  if (TOKEN && req.headers['x-vssh-app-token'] !== TOKEN) return json(res, 403, { erro: 'token' });

  if (url.pathname === '/capabilities') {
    const bin = acharChromium();
    return json(res, 200, {
      capability: 'print/v1',
      ok: !!bin,
      // Nomear o pacote é o que transforma "não funciona" em uma linha de comando para quem
      // administra. `requiredPackages` já recusa a instalação sem ele; isto cobre o servidor em
      // que alguém o removeu depois.
      motivo: bin ? null : 'chromium não encontrado neste servidor (apt-get install -y chromium)',
    });
  }

  if (url.pathname === '/render' && req.method === 'POST') {
    let bruto = '';
    for await (const p of req) {
      bruto += p;
      if (bruto.length > 64 * 1024) return json(res, 413, { ok: false, motivo: 'corpo grande demais' });
    }
    let corpo;
    try { corpo = JSON.parse(bruto || '{}'); } catch { return json(res, 400, { ok: false, motivo: 'json' }); }

    const origem = String(corpo.origem || '');
    if (!origem.startsWith('/') || origem.includes('\0')) {
      return json(res, 400, { ok: false, motivo: 'caminho-invalido' });
    }
    if (!RENDERIZAVEIS.test(origem)) return json(res, 400, { ok: false, motivo: 'tipo-nao-suportado' });
    if (!fs.existsSync(origem)) return json(res, 404, { ok: false, motivo: 'nao-encontrado' });

    const destino = corpo.destino ? String(corpo.destino) : destinoPadrao(origem);
    if (!destino.startsWith('/') || !/\.pdf$/i.test(destino)) {
      return json(res, 400, { ok: false, motivo: 'destino-invalido' });
    }

    // Nenhuma checagem de permissão aqui, e é decisão: este processo roda COMO o usuário Linux
    // dono da sessão. Ele não alcança nada que a pessoa já não alcançasse com um terminal — e uma
    // camada de permissão própria seria uma segunda noção de quem pode o quê.
    return json(res, 200, await renderizar(origem, destino));
  }

  json(res, 404, { erro: 'rota' });
});

servidor.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-engine] escutando em 127.0.0.1:${PORT}`);
});
