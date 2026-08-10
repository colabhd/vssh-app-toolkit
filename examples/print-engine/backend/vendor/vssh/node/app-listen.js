'use strict';

// app-listen — onde o backend de um vssh-app escuta, num lugar só.
//
// Por que isto existe: até a Onda 9 todo vssh-app fazia `server.listen(PORT, '127.0.0.1')`, e essa
// porta é alcançável por QUALQUER outra conta Linux da máquina — o loopback é compartilhado por
// definição. Não era hipótese: medindo de uma conta comum em `ipprivm01`, das 23 portas de app em
// escuta, **14 responderam a um GET sem token** (10 com 200 e 4 com 500), e 12 delas pertenciam a
// outras contas. O `X-Vssh-App-Token` existe para isso, mas conferi-lo sempre foi opcional, e
// "opcional" com um terminal ou um editor do outro lado é execução de código alcançável por quem
// não deveria.
//
// Um socket unix em `~/.vssh-apps/<id>/` — diretório que o `vssh-app-run` já cria 0700 — resolve por
// permissão de arquivo o que a conferência de token só prometia. E resolve de graça um segundo
// problema, que era de orquestração: um caminho de socket é DERIVADO da identidade (usuário, appId),
// então não precisa ser alocado, descoberto, cacheado nem reconciliado, ao contrário de um número de
// porta escasso.
//
// ── Por que um helper, e não uma linha em cada app ──
//
// Porque são três armadilhas, e todo mundo erra as três na primeira vez:
//
//  1. **O arquivo de socket sobrevive ao processo.** Com TCP, morrer libera a porta; com socket
//     unix, o inode fica no disco e o `bind()` seguinte falha com EADDRINUSE. Quem não limpa fica
//     morto até alguém apagar um arquivo à mão.
//  2. **O modo do arquivo vem do umask**, e um umask frouxo (0022) cria o socket 0755 — que é
//     conectável por qualquer um se o diretório algum dia deixar de ser 0700. Duas defesas, não uma.
//  3. **`listen(path)` e `listen(port, host)` têm assinaturas diferentes**, e escrever `if` em cada
//     app é o começo de N implementações que divergem. Um portão, não N `if`s.
//
// ── Um endereço só: VSSH_APP_SOCKET ──
//
// A v3 desta lib aceitava `VSSH_APP_PORT` como alternativa, para um app novo sobreviver num servidor
// com `vssh-app-run` velho. **Isso saiu na v4, e a razão é que era um band-aid que contava o
// problema tarde:** o fallback funcionava, escrevia um aviso num `run.log` que ninguém lê, e deixava
// a porta exposta enquanto isso. Quem protege essa compatibilidade agora é o `minShellVersion` do
// manifesto, conferido pelo PORTAL — um PORTÃO na instalação, onde o erro é barato e tem
// alguém olhando, em vez de um fallback em runtime.
//
// Um runtime que de fato não sabe bindar socket unix (o xpra é o caso, medido: o listener de
// WebSocket dele só aceita `HOST:PORT`) declara `backend.transport: "tcp"` no manifesto e **não usa
// esta lib** — ele lê `$VSSH_APP_PORT` por conta própria. Não há um caso em que quem chama
// `escutar()` queira TCP, e é por isso que o ramo não existe mais em vez de existir desligado.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/**
 * O endereço que este processo deve usar, lido do ambiente. Exportado à parte porque um app às
 * vezes precisa DIZER onde está (log de boot, healthcheck próprio) sem escutar de novo.
 *
 * @returns {{transporte: 'socket', caminho: string}}
 */
function enderecoDoAmbiente(env = process.env) {
  const sock = (env.VSSH_APP_SOCKET || '').trim();
  if (sock) return { transporte: 'socket', caminho: sock };

  // A mensagem distingue os dois jeitos de chegar aqui, porque o conserto é diferente em cada um.
  // Um `VSSH_APP_PORT` presente e sozinho não é "faltou variável": é um servidor cujo `vssh-app-run`
  // é anterior à Onda 9, e dizer isso pelo nome poupa quem for depurar de procurar no app.
  if ((env.VSSH_APP_PORT || '').trim()) {
    const err = new Error(
      'Veio VSSH_APP_PORT, mas não VSSH_APP_SOCKET: este servidor tem um `vssh-app-run` anterior à ' +
      'Onda 9. Desde a v4 do toolkit o endereço de um app é um socket unix, e esta lib não binda ' +
      'porta. Atualize o provisionamento do servidor — o `minShellVersion` do manifesto existe para o ' +
      'PORTAL recusar esta combinação antes de ela chegar aqui.'
    );
    err.code = 'VSSH_APP_SERVIDOR_ANTIGO';
    throw err;
  }

  const err = new Error(
    'VSSH_APP_SOCKET não veio do lifecycle. Rodando à mão? Defina: ' +
    'VSSH_APP_SOCKET=/tmp/meu-app.sock'
  );
  err.code = 'VSSH_APP_SEM_ENDERECO';
  throw err;
}

/**
 * Remove um socket órfão — arquivo que existe e que ninguém atende.
 *
 * NUNCA remove um socket VIVO: a checagem é uma tentativa de conexão, não um `existsSync`. Apagar
 * pelo simples fato de o arquivo existir derrubaria a instância que está atendendo agora, e o
 * sintoma (o app "reinicia sozinho" quando alguém o abre duas vezes) não aponta para cá.
 *
 * @returns {Promise<'inexistente'|'vivo'|'removido'>}
 */
function limparSocketOrfao(caminho) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(caminho)) return resolve('inexistente');

    const probe = net.connect(caminho);
    const encerra = (r) => { probe.destroy(); resolve(r); };
    probe.setTimeout(2000);
    probe.on('connect', () => encerra('vivo'));
    probe.on('timeout', () => encerra('vivo'));   // alguém aceitou e travou: não é órfão
    probe.on('error', () => {
      probe.destroy();
      try {
        fs.unlinkSync(caminho);
        resolve('removido');
      } catch (err) {
        if (err.code === 'ENOENT') return resolve('inexistente');
        reject(err);
      }
    });
  });
}

/**
 * Põe o servidor a escutar no endereço que o ambiente mandou.
 *
 * @param {import('node:http').Server|import('node:net').Server} server
 * @param {{env?: NodeJS.ProcessEnv, modo?: number}} [opts] `modo` é a permissão do socket (0o600).
 * @returns {Promise<{transporte: string, endereco: string}>} resolve quando está aceitando conexão
 */
async function escutar(server, opts = {}) {
  const env = opts.env || process.env;
  const modo = opts.modo === undefined ? 0o600 : opts.modo;
  const alvo = enderecoDoAmbiente(env);

  fs.mkdirSync(path.dirname(alvo.caminho), { recursive: true, mode: 0o700 });
  const estado = await limparSocketOrfao(alvo.caminho);
  if (estado === 'vivo') {
    // Não é erro de programação e não deve virar stack trace: significa que o app já está de pé.
    // Quem chamou decide se sai com 0 (é o que o lifecycle espera) ou reclama.
    const err = new Error(`Já há um backend atendendo em ${alvo.caminho}.`);
    err.code = 'VSSH_APP_JA_ESCUTANDO';
    throw err;
  }

  await new Promise((ok, erro) => {
    server.once('error', erro);
    server.listen(alvo.caminho, ok);
  });
  // Depois do listen, porque antes dele o arquivo não existe. O diretório 0700 já basta; isto é a
  // segunda defesa, para o dia em que o diretório mudar de modo por outra razão.
  try { fs.chmodSync(alvo.caminho, modo); } catch { /* o diretório já protege */ }

  return { transporte: 'socket', endereco: alvo.caminho };
}

module.exports = { escutar, enderecoDoAmbiente, limparSocketOrfao };
