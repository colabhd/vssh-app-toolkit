'use strict';

// vssh-live — o que o seu app está fazendo AGORA, para quem não tem janela.
//
// Se o seu app TEM janela, não use isto: use `vssh.live.set()` do shim, no frontend. É síncrono,
// a janela dá o prazo de validade de graça (enquanto ela vive, a atividade vive) e não passa por
// arquivo nenhum.
//
// Isto aqui é para `"type": "engine"` e `"kind": "service"` — o daemon que sincroniza, indexa ou
// treina, e que precisa mostrar progresso sem ter onde desenhar.
//
// ── Três coisas diferentes, e escolher errado custa a atenção de quem usa ───
//
//   vssh-notify   um FATO que aconteceu. Vai para o histórico do sino, e fica.
//                 "Backup concluído: 4,2 GB em 12 min"
//   vssh-tray     um ÍCONE com badge. Cabe num símbolo e um número.
//   vssh-live     uma CONDIÇÃO que é verdade AGORA, com título, texto e barra.
//                 "Sincronizando 340 de 550" — e some quando acaba.
//
// A atividade **não deixa rastro**. Uma sincronização que terminou não é um fato a guardar; se
// o FIM dela for (porque falhou, ou porque o número final interessa), encerre com `registrar`, e
// aí ela vira uma notificação — uma só.
//
// ── O modelo: arquivo presente é atividade viva ─────────────────────────────
//
//   const { setLive, clearLive, keepLiveAlive } = require('./vendor/vssh/node/vssh-live.js');
//
//   const parar = keepLiveAlive();                    // renova o `at` sozinho
//   setLive('sync', {
//     titulo: 'Sincronizando',
//     texto: arquivoAtual,
//     formato: 'progresso',
//     progresso: { feito, total },
//   });
//   // ... quando acabar:
//   clearLive('sync', { registrar: { titulo: 'Sincronização concluída', texto: `${total} arquivos` } });
//   parar();
//
// ── O `at`, e por que ele é OBRIGATÓRIO ─────────────────────────────────────
//
// Um arquivo chamado `live` sobrevive a um `kill -9`. Sem prazo de validade, o primeiro processo
// que morrer no meio prega "Sincronizando 3 de 12" no painel do usuário para sempre — e o módulo
// cujo propósito inteiro é dizer o que está acontecendo agora vira o que mais engana.
//
// Por isso o portal exige `at` (epoch ms) e o descarta depois de ~60 s sem renovar. `setLive` o
// escreve a cada chamada; se a sua atividade fica minutos sem novidade (esperando rede, por
// exemplo), chame `keepLiveAlive()` uma vez e esqueça — ele renova sozinho.

const fs = require('node:fs');
const path = require('node:path');

// Renovação um pouco abaixo da metade do TTL do portal (60 s): dois tiques perdidos ainda cabem
// dentro do prazo, então uma pausa do event loop não apaga a atividade sozinha.
const RENOVA_MS = 20000;

function _dir() {
  // O journal e o `live/` são do USUÁRIO, não do app: um lugar só, com todos os apps dele
  // dentro. É o que permite ao portal ler tudo num exec por usuário.
  const home = process.env.HOME || '';
  return home ? path.join(home, '.vssh-notifications', 'live') : null;
}

/** `[a-z0-9:_-]`, até 64 — o mesmo que o coletor aceita, conferido dos dois lados. */
function _validKey(chave) {
  return typeof chave === 'string' && /^[a-z0-9:_-]{1,64}$/i.test(chave);
}

function _file(chave) {
  const d = _dir();
  return d && _validKey(chave) ? path.join(d, `${chave}.json`) : null;
}

/** As chaves vivas deste processo, para o renovador saber o que reescrever. */
const _vivas = new Map();

/**
 * Declara (ou atualiza) uma atividade.
 *
 * A mesma chave SUBSTITUI no lugar — é o ponto: relatar progresso não empilha vinte linhas no
 * painel de quem está trabalhando.
 *
 * Campos: `titulo`, `texto`, `level` (`info|success|warning|error`), `formato`
 * (`simples|progresso`), `progresso` (`{feito,total}` ou `{indeterminado:true}`), `acoes`
 * (`[{id,label}]`). Só dados — nunca HTML, nunca função.
 *
 * Devolve `false`, sem lançar, quando não há onde escrever (rodando fora do VSSH). Atividade é
 * enfeite do ambiente: um app não deve morrer por não conseguir mostrar uma barra.
 */
function setLive(chave, item) {
  const file = _file(chave);
  if (!file) return false;
  const corpo = { ...item, at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Escrita atômica, como o tray.json: sem ela o poll do portal pode ler o arquivo pela metade
    // e descartá-lo como JSON inválido — e o sintoma seria a barra piscando justamente sob
    // atualização frequente, que é quando ela importa.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(corpo), 'utf8');
    fs.renameSync(tmp, file);
    _vivas.set(chave, item);
    return true;
  } catch (err) {
    console.warn(`[vssh-live] não foi possível escrever ${file}: ${err.message}`);
    return false;
  }
}

/**
 * Encerra a atividade.
 *
 * Sem `registrar`, ela **some e não deixa rastro** — é o certo para uma indisponibilidade que foi
 * resolvida: "o disco voltou" não é um fato que alguém precise reler amanhã.
 *
 * Com `registrar: { titulo, texto, level }`, o desktop transforma o fim numa notificação, que
 * fica no histórico. Use quando o desfecho for o que interessa.
 */
function clearLive(chave, opts = {}) {
  const file = _file(chave);
  if (!file) return false;
  _vivas.delete(chave);
  try {
    // A ordem importa: a notificação PRIMEIRO, o arquivo depois.
    //
    // O coletor lê ESTADO — ele diffa presença de arquivo — e por isso não há como pedir
    // "encerre E registre" pelo próprio `live/`. Quem registra é o journal, que já existe e já é
    // o caminho por onde toda notificação de app sem janela passa; aqui só se chama o vizinho.
    //
    // Registrando antes de apagar, o pior caso de uma queda no meio é a atividade continuar na
    // tela até o TTL — que é recuperável. Na ordem inversa, o pior caso é a atividade sumir sem
    // nunca ter contado como terminou, que é perder a informação.
    if (opts.registrar) {
      const r = opts.registrar;
      try {
        const { notify } = require('./vssh-notify.js');
        notify(String(r.texto ?? r.body ?? ''), {
          title: r.titulo ?? r.title,
          level: r.level,
          // `key` estável na chave da atividade: um retry que termine de novo substitui em vez
          // de empilhar dois "concluído" para a mesma coisa.
          key: `live:${chave}`,
        });
      } catch (err) {
        console.warn(`[vssh-live] não foi possível registrar o fim de ${chave}: ${err.message}`);
      }
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mantém o `at` renovado enquanto as atividades deste processo estiverem vivas.
 *
 * Opt-in, e o temporizador é `unref`: uma lib que segura o event loop impede o seu app de
 * encerrar, e isso é pior que uma barra que expira.
 *
 * Devolve a função que para a renovação.
 */
function keepLiveAlive() {
  const t = setInterval(() => {
    for (const [chave, item] of _vivas) setLive(chave, item);
  }, RENOVA_MS);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * Liga a limpeza ao encerramento do processo. Opt-in pelo mesmo motivo do `clearTrayOnExit`:
 * instalar handler de sinal por conta própria numa lib briga com o shutdown do app.
 *
 * Vale a pena ligar: o TTL cobre o `kill -9`, mas 60 s de "sincronizando" depois de um Ctrl+C
 * limpo é um minuto de mentira que dava para não contar.
 */
function clearLiveOnExit() {
  const bye = () => { for (const chave of [..._vivas.keys()]) clearLive(chave); };
  process.once('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { bye(); process.exit(0); });
  }
}

module.exports = { setLive, clearLive, keepLiveAlive, clearLiveOnExit, _liveFilePath: _file };
