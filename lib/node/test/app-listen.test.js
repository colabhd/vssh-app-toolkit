'use strict';

// Onde o backend de um vssh-app escuta — e, sobretudo, o que acontece quando ele MORREU mal.
//
// ── Por que estes testes pulam no Windows, e por que isso não é preguiça ──
//
// Node no Windows não tem socket unix: `listen(caminho)` cria um NAMED PIPE, e um caminho de
// arquivo comum devolve EACCES. Metade da matriz de CI deste repo é Windows (ver o `//test` do
// package.json), então um teste que não pula ali vira vermelho permanente por plataforma, e um
// vermelho que ninguém pode consertar é um vermelho que todo mundo aprende a ignorar. Quem prova
// esta lib é a perna Linux, que é também a única parecida com o servidor-alvo.
//
// ── O caso que dá o assunto ao arquivo ──
//
// Com TCP, um processo que morre devolve a porta ao kernel. Com socket unix, o ARQUIVO fica. O
// `bind()` seguinte falha com EADDRINUSE contra um inode que ninguém atende, e o app fica morto até
// alguém apagar um arquivo à mão — sem erro que aponte para cá.
//
// E o teste disso precisa de cuidado: um `server.close()` LIMPO já apaga o socket sozinho (medido
// abaixo). Quem testa a limpeza fechando o servidor está medindo o caminho que não tem problema, e
// concluiria que a limpeza funciona sem nunca ter produzido um órfão. Só `SIGKILL` produz um.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { escutar, enderecoDoAmbiente, limparSocketOrfao } = require('../app-listen.js');

const semSocketUnix = process.platform === 'win32'
  ? { skip: 'node no Windows não tem socket unix — listen(caminho) vira named pipe' }
  : {};

function tmpSock() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-listen-'));
  return { dir: d, sock: path.join(d, 'app.sock') };
}
const limpa = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

/** GET / pelo socket, que é exatamente o que o proxy do portal faz (`target: {socketPath}`). */
function getPeloSocket(socketPath) {
  return new Promise((ok, erro) => {
    const req = http.request({ socketPath, path: '/' }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => ok({ status: res.statusCode, corpo }));
    });
    req.on('error', erro);
    req.end();
  });
}

// ─── o endereço, antes de escutar ─────────────────────────────────────────────

test('sem endereço nenhum, falha alto e diz o que definir', () => {
  assert.throws(() => enderecoDoAmbiente({}), (err) => {
    assert.equal(err.code, 'VSSH_APP_SEM_ENDERECO');
    assert.match(err.message, /VSSH_APP_SOCKET/);
    return true;
  });
});

test('só VSSH_APP_PORT não é "faltou variável" — é servidor velho, e o erro diz isso', () => {
  // Os dois casos caem no mesmo lugar do código e têm consertos DIFERENTES: um é `export` esquecido
  // rodando à mão, o outro é um `vssh-app-run` velho demais num servidor de verdade. Um erro que não
  // distingue os dois manda quem depura procurar no app o que está no provisionamento.
  assert.throws(() => enderecoDoAmbiente({ VSSH_APP_PORT: '45999' }), (err) => {
    assert.equal(err.code, 'VSSH_APP_SERVIDOR_ANTIGO');
    assert.match(err.message, /vssh-app-run/, 'não nomeia a peça do servidor que está velha');
    assert.match(err.message, /minShellVersion/, 'não aponta o portão que deveria ter recusado antes');
    return true;
  });
});

test('o socket ganha mesmo com a porta presente — não há fallback para TCP', () => {
  // A v3 tinha esse fallback e ele saiu na v4: funcionava, avisava num log que ninguém lê, e
  // deixava a porta exposta enquanto isso. Quem protege a compatibilidade agora é o `minShellVersion`.
  const alvo = enderecoDoAmbiente({ VSSH_APP_SOCKET: '/tmp/x.sock', VSSH_APP_PORT: '45999' });
  assert.deepEqual(alvo, { transporte: 'socket', caminho: '/tmp/x.sock' });
});

// ─── escutar de verdade ───────────────────────────────────────────────────────

test('escuta em socket unix, com modo 0600, e fala HTTP por ele', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  try {
    const r = await escutar(srv, { env: { VSSH_APP_SOCKET: sock } });
    assert.equal(r.transporte, 'socket');
    assert.equal(r.endereco, sock);
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600,
      'o modo veio do umask em vez de ser fixado — num diretório traversável isso é a porta aberta de volta');
    assert.deepEqual(await getPeloSocket(sock), { status: 200, corpo: 'ok' });
  } finally {
    await new Promise((ok) => srv.close(ok));
    limpa(dir);
  }
});

test('um socket VIVO não é apagado pela limpeza', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  const srv = http.createServer();
  try {
    await escutar(srv, { env: { VSSH_APP_SOCKET: sock } });
    assert.equal(await limparSocketOrfao(sock), 'vivo');
    assert.ok(fs.existsSync(sock), 'a limpeza apagou o socket de quem está atendendo AGORA');
  } finally {
    await new Promise((ok) => srv.close(ok));
    limpa(dir);
  }
});

test('a segunda instância no mesmo endereço é recusada, e com código próprio', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  const primeiro = http.createServer();
  const segundo = http.createServer();
  try {
    await escutar(primeiro, { env: { VSSH_APP_SOCKET: sock } });
    await assert.rejects(
      () => escutar(segundo, { env: { VSSH_APP_SOCKET: sock } }),
      (err) => {
        // Código, e não texto: quem chama decide sair com 0 (é o contrato do lifecycle) e não pode
        // ter de casar mensagem para isso.
        assert.equal(err.code, 'VSSH_APP_JA_ESCUTANDO');
        return true;
      }
    );
  } finally {
    // OS DOIS, e `segundo` é o que importa: no caminho em que ele NÃO deveria ter subido — que é
    // exatamente o que a refutação provoca — ele fica escutando, segura o event loop, e o runner
    // não termina nunca. O teste travava em vez de falhar, e um teste que trava é pior que um
    // vermelho: ninguém sabe se está lento ou quebrado, e nenhum CI distingue os dois.
    await Promise.all([primeiro, segundo].map((s) =>
      new Promise((ok) => { try { s.close(ok); } catch { ok(); } })
    ));
    limpa(dir);
  }
});

// ─── o órfão, que é o assunto ─────────────────────────────────────────────────

test('fechar LIMPO já apaga o socket — por isso este não é o teste do órfão', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  const srv = http.createServer();
  await escutar(srv, { env: { VSSH_APP_SOCKET: sock } });
  await new Promise((ok) => srv.close(ok));
  assert.equal(fs.existsSync(sock), false,
    'se um dia isto virar true, o teste do órfão abaixo passou a medir duas coisas ao mesmo tempo');
  limpa(dir);
});

test('depois de SIGKILL o arquivo sobrevive, trava o bind, e a limpeza destrava', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  try {
    const filho = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      net.createServer().listen(process.argv[1], () => console.log('up'));
      setInterval(() => {}, 1000);
    `, sock], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((ok) => filho.stdout.once('data', ok));

    filho.kill('SIGKILL');
    await new Promise((ok) => filho.once('exit', ok));
    assert.ok(fs.existsSync(sock), 'o arquivo NÃO sobreviveu ao SIGKILL — o órfão deixou de existir');

    // A trava, medida e não suposta: é ela que justifica a limpeza existir.
    const cru = net.createServer();
    const erro = await new Promise((ok) => {
      cru.once('error', (e) => ok(e.code));
      cru.listen(sock, () => ok('SUBIU'));
    });
    cru.close();
    assert.equal(erro, 'EADDRINUSE', 'bindar por cima do órfão deveria falhar — se não falha, a limpeza é decoração');

    assert.equal(await limparSocketOrfao(sock), 'removido');

    const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('ok2'); });
    const r = await escutar(srv, { env: { VSSH_APP_SOCKET: sock } });
    assert.equal(r.transporte, 'socket');
    assert.deepEqual(await getPeloSocket(sock), { status: 200, corpo: 'ok2' });
    await new Promise((ok) => srv.close(ok));
  } finally {
    limpa(dir);
  }
});

test('escutar() sozinho já limpa o órfão — o app não precisa saber que ele existe', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  try {
    const filho = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      net.createServer().listen(process.argv[1], () => console.log('up'));
      setInterval(() => {}, 1000);
    `, sock], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((ok) => filho.stdout.once('data', ok));
    filho.kill('SIGKILL');
    await new Promise((ok) => filho.once('exit', ok));

    const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
    const r = await escutar(srv, { env: { VSSH_APP_SOCKET: sock } });
    assert.equal(r.transporte, 'socket');
    await new Promise((ok) => srv.close(ok));
  } finally {
    limpa(dir);
  }
});

test('limparSocketOrfao num caminho que não existe é um não-evento', semSocketUnix, async () => {
  const { dir, sock } = tmpSock();
  assert.equal(await limparSocketOrfao(sock), 'inexistente');
  limpa(dir);
});
