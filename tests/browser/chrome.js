'use strict';

// Um navegador de verdade para os testes, sem dependência npm nenhuma.
//
// ── POR QUE ISTO EXISTE ────────────────────────────────────────────────────────
//
// Os testes de `lib/web/` rodam o código de navegador num contexto `vm` do Node, com os globais
// da plataforma passados à mão. Isso mede o que o nosso código faz — não o que a PLATAFORMA faz
// com ele. E a diferença não é teórica: foi medida, e o Node discorda do navegador exatamente na
// leitura mais importante do `fsa-polyfill`.
//
//     class F extends Blob { constructor(){ super([]) }  stream(){ /* devolve os bytes */ } }
//
//     new Response(f).text()   →  Node/undici: "conteudo real"   ·  navegador: ""
//     new Blob([f]).text()     →  Node/undici: ""                ·  navegador: ""
//
// O undici constrói o corpo chamando o método `.stream()` **público**; o navegador segue a
// especificação do Fetch, que usa o *get stream* INTERNO do Blob e nunca consulta o método. Ou
// seja: um conserto do T1 feito por cima de `stream()` fica verde no Node e continua quebrado no
// navegador. Provar a correção no `vm` seria provar com o mesmo instrumento que deixou o defeito
// passar.
//
// ── O QUE É, E O QUE DELIBERADAMENTE NÃO É ─────────────────────────────────────
//
// É o menor cliente de Chrome DevTools Protocol que serve: acha um Chrome/Edge já instalado, sobe
// headless numa porta efêmera, abre uma aba e avalia expressões nela. Node >= 22 traz `WebSocket`
// nativo e `fetch`, então não falta nada.
//
// NÃO é um Playwright pobre. Sem seletores, sem espera de elemento, sem rede interceptada, sem
// screenshot. O que os testes de `lib/web/` precisam é avaliar JavaScript numa plataforma real e
// ler o resultado de volta — e é só isso que está aqui. No dia em que precisarem de mais que isso,
// a conversa é sobre trocar de ferramenta, não sobre engordar esta.
//
// NÃO baixa navegador. Se não houver um instalado, `caminhoDoNavegador()` devolve `null` e os
// testes que dependem dele se marcam como pulados — em vez de falharem por ausência de ambiente,
// que é ruído e não sinal. O runner ubuntu do GitHub Actions já traz Chrome; o CI não ganha passo
// de instalação por causa disto.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// ── Achar o navegador ─────────────────────────────────────────────────────────

function candidatos() {
  const env = process.env;
  const lista = [env.VSSH_TEST_CHROME, env.CHROME_PATH].filter(Boolean);

  if (process.platform === 'win32') {
    const raizes = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of raizes) {
      lista.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      lista.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    lista.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    lista.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    lista.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    lista.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    lista.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    lista.push('/usr/bin/microsoft-edge');
  }
  return lista;
}

let cacheCaminho;

/** Caminho de um Chrome/Edge instalado, ou `null`. O resultado é memorizado. */
function caminhoDoNavegador() {
  if (cacheCaminho !== undefined) return cacheCaminho;
  cacheCaminho = candidatos().find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
  return cacheCaminho;
}

/** Mensagem de skip pronta, para `t.skip(...)`. */
function motivoDoSkip() {
  return 'nenhum Chrome/Edge encontrado — defina VSSH_TEST_CHROME para apontar um';
}

// ── O canal CDP ───────────────────────────────────────────────────────────────

class Sessao {
  constructor(ws) {
    this._ws = ws;
    this._seq = 0;
    this._pendentes = new Map();
    this._esperas = new Map();
    /** Tudo que a página escreveu no console, na ordem. */
    this.console = [];
    /** Exceções não capturadas na página. Um teste que ignora isto mede menos do que pensa. */
    this.excecoes = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.id !== undefined) {
        const p = this._pendentes.get(msg.id);
        if (!p) return;
        this._pendentes.delete(msg.id);
        if (msg.error) p.rejeitar(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else p.resolver(msg.result);
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled') {
        const texto = (msg.params.args || []).map(descrever).join(' ');
        this.console.push({ tipo: msg.params.type, texto });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.excecoes.push(textoDaExcecao(msg.params.exceptionDetails));
      }

      const espera = this._esperas.get(msg.method);
      if (espera) { this._esperas.delete(msg.method); espera(msg.params); }
    });

    // Um socket que morre no meio deixaria toda chamada em aberto pendurada até o timeout do
    // runner — sem dizer o porquê. Rejeitar explicitamente troca "o teste travou" por uma causa.
    const derrubar = () => {
      for (const p of this._pendentes.values()) p.rejeitar(new Error('conexão com o navegador caiu'));
      this._pendentes.clear();
    };
    ws.addEventListener('close', derrubar);
    ws.addEventListener('error', derrubar);
  }

  /**
   * Promessa que resolve na próxima ocorrência de um evento do protocolo. Tem de ser criada
   * ANTES do comando que a dispara — ligar o ouvinte depois é a corrida clássica.
   */
  esperarEvento(method, timeoutMs = 15000) {
    return new Promise((resolver, rejeitar) => {
      const prazo = setTimeout(() => {
        this._esperas.delete(method);
        rejeitar(new Error(`o evento ${method} não chegou em ${timeoutMs}ms`));
      }, timeoutMs);
      this._esperas.set(method, (params) => { clearTimeout(prazo); resolver(params); });
    });
  }

  enviar(method, params = {}) {
    const id = ++this._seq;
    return new Promise((resolver, rejeitar) => {
      this._pendentes.set(id, { resolver, rejeitar });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Avalia uma expressão na página e devolve o valor por cópia.
   *
   * `awaitPromise` está ligado: uma expressão `async` devolve o valor resolvido, não a promessa.
   * Uma exceção na página vira exceção aqui, com a stack da página junto — sem isso, um erro no
   * código avaliado apareceria como `undefined` e o teste falharia dizendo a coisa errada.
   */
  async avaliar(expressao) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: expressao,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,   // `requestPermission()` consulta navigator.userActivation
    });
    if (r.exceptionDetails) throw new Error(textoDaExcecao(r.exceptionDetails));
    return r.result?.value;
  }

  /** Descarta o que o console e as exceções acumularam. Útil entre etapas de um mesmo teste. */
  limparRegistros() { this.console.length = 0; this.excecoes.length = 0; }
}

function descrever(arg) {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.type;
}

function textoDaExcecao(d) {
  if (!d) return 'exceção sem detalhes';
  const desc = d.exception?.description || d.exception?.value || d.text;
  return String(desc || 'exceção').split('\n').slice(0, 6).join('\n');
}

// ── Subir e derrubar ──────────────────────────────────────────────────────────

const ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',                    // o runner do CI roda como root; sem isto o Chrome recusa subir
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--remote-debugging-port=0',       // porta efêmera: duas suítes em paralelo não brigam
];

class Navegador {
  constructor(proc, dirTemp, wsUrl) {
    this._proc = proc;
    this._dirTemp = dirTemp;
    this._wsUrl = wsUrl;
    this._sessoes = [];
  }

  /**
   * Abre uma aba nova e devolve a `Sessao` conectada a ela, com `Runtime` já habilitado.
   *
   * O default é `about:blank`, que basta para avaliar JavaScript. Quem precisar de
   * armazenamento — IndexedDB, localStorage, cookies — tem de passar uma URL de `servirOrigem()`:
   * `about:blank` é ORIGEM OPACA, e o Chrome nega o IndexedDB ali com um `SecurityError` que
   * parece defeito da biblioteca sob teste e não é.
   */
  async novaPagina(url = 'about:blank') {
    // `PUT /json/new` (o Chrome recusa POST/GET aqui desde a 111) devolve o alvo já com o
    // webSocketDebuggerUrl da aba — conectar direto nela dispensa a dança de
    // Target.attachToTarget/sessionId, que é a metade do CDP que não precisamos.
    const base = this._wsUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
    const res = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' });
    if (!res.ok) throw new Error(`não consegui abrir uma aba: HTTP ${res.status}`);
    const alvo = await res.json();

    const ws = new WebSocket(alvo.webSocketDebuggerUrl);
    await new Promise((ok, erro) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => erro(new Error('não consegui conectar na aba')), { once: true });
    });

    const s = new Sessao(ws);
    await s.enviar('Runtime.enable');
    // Navegar DEPOIS de conectar, e esperar o `load`. Criar o alvo já na URL final seria uma
    // corrida: o primeiro `avaliar()` poderia rodar no documento `about:blank` que ainda não foi
    // trocado, e o teste mediria a origem errada sem nenhum sinal disso.
    if (url !== 'about:blank') {
      await s.enviar('Page.enable');
      const carregou = s.esperarEvento('Page.loadEventFired');
      await s.enviar('Page.navigate', { url });
      await carregou;
      s.limparRegistros();
    }
    this._sessoes.push(s);
    return s;
  }

  async fechar() {
    for (const s of this._sessoes) { try { s._ws.close(); } catch { /* já caiu */ } }
    this._proc.kill();
    // Esperar a saída antes de apagar o perfil: no Windows o diretório fica travado enquanto o
    // processo vive, e o rm falharia com EBUSY.
    await new Promise((ok) => { this._proc.once('exit', ok); setTimeout(ok, 3000).unref?.(); });
    await apagarPerfil(this._dirTemp);
  }
}

/**
 * Apaga o perfil temporário, com três tentativas.
 *
 * O `exit` do processo pai não garante que os filhos dele já soltaram os arquivos, e no Windows um
 * handle ainda aberto faz o `rm` falhar. Uma tentativa só deixava um perfil de dezenas de MB no
 * TEMP a cada execução — foram nove antes de alguém reparar.
 */
async function apagarPerfil(dir) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* ainda travado */ }
    await new Promise((ok) => { setTimeout(ok, 200).unref?.(); });
  }
}

/**
 * Sobe um navegador headless. Lança se não houver nenhum instalado — quem quer pular em vez de
 * falhar deve checar `caminhoDoNavegador()` antes.
 *
 * O prazo é generoso e configurável por `VSSH_TEST_CHROME_TIMEOUT` porque a máquina onde isto mais
 * aperta é a que menos se controla: num runner compartilhado, com os arquivos de teste rodando em
 * paralelo, um Chrome frio pode levar mais que os 20 s que este número já foi.
 */
async function abrirNavegador({ timeoutMs = Number(process.env.VSSH_TEST_CHROME_TIMEOUT) || 45000 } = {}) {
  const exe = caminhoDoNavegador();
  if (!exe) throw new Error(motivoDoSkip());

  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-cdp-'));
  const proc = spawn(exe, [...ARGS, `--user-data-dir=${dirTemp}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Falhar aqui NÃO pode deixar o processo vivo. Isto já custou uma investigação: no CI o Chrome
  // não anunciou o DevTools, a promessa abaixo rejeitou, e o processo continuou de pé segurando o
  // event loop — o job não falhou, FICOU RODANDO até o teto do Actions. Um erro que não termina é
  // pior que um erro: ele não diz nem que houve erro.
  const encerrar = async () => {
    const vivo = proc.exitCode === null && proc.signalCode === null;
    try { proc.kill('SIGKILL'); } catch { /* já morreu */ }
    // Esperar a saída antes de apagar o perfil, pelo mesmo motivo de `fechar()`: no Windows o
    // diretório fica travado enquanto o processo vive, e o rm falha com EBUSY deixando lixo no
    // TEMP a cada falha. Se ele já saiu, não há o que esperar.
    if (vivo) await new Promise((ok) => { proc.once('exit', ok); setTimeout(ok, 3000).unref?.(); });
    await apagarPerfil(dirTemp);
  };

  // A porta efêmera só é conhecida por uma linha no stderr: `DevTools listening on ws://...`.
  const wsUrl = await new Promise((resolver, rejeitar) => {
    let buffer = '';
    // Quem lê a falha precisa saber QUAL binário não subiu: a lista de candidatos tem quatro
    // caminhos, e "o Chrome não subiu" sem o caminho manda a pessoa investigar o Chrome errado.
    const comContexto = (msg) => new Error(`${msg}\nbinário: ${exe}\nstderr:\n${buffer.slice(-1500) || '(vazio)'}`);
    const prazo = setTimeout(() => {
      rejeitar(comContexto(`o navegador não anunciou o DevTools em ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (pedaco) => {
      buffer += pedaco;
      const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!m) return;
      clearTimeout(prazo);
      resolver(m[1]);
    });
    proc.once('error', (e) => { clearTimeout(prazo); rejeitar(comContexto(`falha ao lançar: ${e.message}`)); });
    proc.once('exit', (code, sinal) => {
      clearTimeout(prazo);
      rejeitar(comContexto(`o navegador saiu (código ${code}, sinal ${sinal}) antes de subir`));
    });
  }).catch(async (err) => { await encerrar(); throw err; });

  return new Navegador(proc, dirTemp, wsUrl);
}

// ── Uma origem de verdade, quando o teste precisa de armazenamento ────────────

/**
 * Sobe um HTTP local que serve uma página em branco em qualquer caminho, e devolve
 * `{ url, fechar() }`.
 *
 * Existe por um motivo só, e é bom que fique escrito: `about:blank` tem ORIGEM OPACA, e o Chrome
 * recusa IndexedDB/localStorage/cookies ali. O erro que chega é um `SecurityError` lançado de
 * dentro da biblioteca sob teste — indistinguível de um defeito dela. Um servidor de dez linhas
 * troca esse falso positivo por uma origem `http://127.0.0.1:<porta>` comum.
 */
async function servirOrigem(rota) {
  const srv = http.createServer((req, res) => {
    // A rota opcional vem primeiro e pode responder o que quiser; devolver algo falso indica
    // "não é minha" e cai na página em branco. É o que permite a um teste servir a API que a
    // biblioteca sob teste chama, em vez de deixá-la bater numa página HTML e fatiar o `<!doctype`.
    if (rota && rota(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>teste</title>');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    fechar: () => new Promise((ok) => srv.close(ok)),
  };
}

module.exports = { abrirNavegador, caminhoDoNavegador, motivoDoSkip, servirOrigem };
