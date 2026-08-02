'use strict';

// vssh-tray — ícone na bandeja do desktop para um app SEM janela.
//
// Se o seu app TEM janela, não use isto: use `vssh.tray.set()` do shim, no frontend. É
// síncrono, o clique volta como callback e não passa por arquivo nenhum.
//
// Isto aqui é para `"type": "engine"` e `"kind": "service"` — o daemon que sincroniza, indexa
// ou treina, e que não tem janela onde aparecer. Ele é o caso que a bandeja existe para
// resolver: ninguém abre Configurações para saber se o rclone está sincronizando.
//
// ── O modelo: estado por arquivo, ação por HTTP ─────────────────────────────
//
// Você ESCREVE o estado; o portal lê e desenha. O usuário clica; o portal faz um POST no SEU
// backend. Duas direções, dois mecanismos — e é assim porque a rede é assimétrica: o portal
// alcança o seu app pelo túnel, o seu app não alcança o portal.
//
//   const { setTray, clearTray } = require('./vendor/vssh/node/vssh-tray.js');
//
//   setTray({
//     icon: 'refresh',
//     tooltip: `Sincronizando ${feitos} de ${total}`,
//     badge: { count: total - feitos },
//     menu: [{ id: 'pause', label: 'Pausar' }],
//     onClick: { path: '/tray' },        // ← POST vem para cá
//   });
//
//   // no seu servidor HTTP:
//   //   POST /tray  { event: 'click' }              ← clique no ícone
//   //   POST /tray  { event: 'menu', menuId: 'pause' }  ← item do menu
//
// `clearTray()` no encerramento. Se o processo morrer sem chamar, o ícone fica até alguém
// remover o arquivo — por isso `setTray` também aceita ser chamado com o app já parado: o
// portal só reflete o que está no disco.
//
// ── Latência ───────────────────────────────────────────────────────────────
//
// O portal faz poll em lote, um exec por servidor a cada poucos segundos (padrão 5s), e só
// enquanto houver alguém com o desktop aberto. Então: escrever é barato, a mudança aparece em
// segundos, e não há custo nenhum quando ninguém está olhando. Não tente contornar isso
// escrevendo em loop apertado — não vai aparecer mais rápido, e o arquivo é reescrito à toa.

const fs = require('node:fs');
const path = require('node:path');

function _dir() {
  // VSSH_APP_DATA_DIR é `~/.vssh-apps/<id>/data`; o tray.json fica um nível acima, ao lado do
  // status.json que o supervisor já escreve — é o diretório que o coletor varre.
  const data = process.env.VSSH_APP_DATA_DIR;
  if (data) return path.dirname(data);
  const id = process.env.VSSH_APP_ID;
  if (id) return path.join(process.env.HOME || '', '.vssh-apps', id);
  return null;
}

function _file() {
  const d = _dir();
  return d ? path.join(d, 'tray.json') : null;
}

/**
 * Publica (ou atualiza) o ícone deste app na bandeja.
 *
 * Um item por app. Chamar de novo substitui — o ícone não muda de lugar, que é o que importa
 * quando o badge muda a cada segundo.
 *
 * Campos: `icon` (nome de ícone do desktop ou caminho dentro do seu pacote), `tooltip`,
 * `badge` (`{count}` | `{dot:true}` | `{text}`), `menu` (`[{id,label,icon,danger,disabled}]` ou
 * `{separator:true}`), `onClick` (`{path}`). Só dados — nunca HTML, nunca função.
 *
 * Devolve `false`, sem lançar, quando não há onde escrever (rodando fora do VSSH, no seu
 * `npm run dev`). Bandeja é enfeite do ambiente: um app não deve morrer por não ter uma.
 */
function setTray(item) {
  const file = _file();
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Escrita atômica — mesmo idioma do status.json do vssh-app-supervisor. Sem ela, o poll do
    // portal pode ler o arquivo pela metade e descartá-lo como JSON inválido; o sintoma seria
    // um ícone que pisca sob atualização frequente, que é justamente quando ele importa.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...item, updatedAt: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    // Sem `throw`: o app tem trabalho de verdade a fazer, e ele não pode parar porque o
    // ícone não coube no disco.
    console.warn(`[vssh-tray] não foi possível escrever ${file}: ${err.message}`);
    return false;
  }
}

/** Remove o ícone. Chame ao encerrar — ícone órfão mente sobre o estado do ambiente. */
function clearTray() {
  const file = _file();
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Liga `clearTray()` ao encerramento do processo. Opt-in porque instalar handler de sinal por
 * conta própria numa lib é exatamente o tipo de coisa que briga com o shutdown do app.
 */
function clearTrayOnExit() {
  const bye = () => { clearTray(); };
  process.once('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { bye(); process.exit(0); });
  }
}

module.exports = { setTray, clearTray, clearTrayOnExit, _trayFilePath: _file };
