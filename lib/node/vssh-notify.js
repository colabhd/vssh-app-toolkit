'use strict';

// vssh-notify — avisar o usuário a partir do BACKEND, sem janela aberta.
//
// Se o seu app TEM janela, não use isto: use `vssh.notify()` do shim, no frontend. É síncrono,
// as ações voltam por postMessage, e não passa por arquivo nenhum.
//
// Isto aqui é para `"type": "engine"` e `"kind": "service"` — o daemon que sincroniza, indexa
// ou faz backup, e que precisa avisar quando o desktop está FECHADO. É o caso que o centro de
// notificações existe para resolver: o backup falhou às 3h da manhã e ninguém ficou sabendo.
//
// ── O modelo ────────────────────────────────────────────────────────────────
//
// Você ACRESCENTA uma linha ao journal do usuário; o portal lê a janela do fim dele no mesmo
// tick que já coleta a bandeja e empurra pelo canal de eventos. Quem abrir o desktop depois
// recebe o atraso. Quem já viu, não vê de novo.
//
//   const { notify } = require('./vendor/vssh/node/vssh-notify.js');
//
//   notify('Backup concluído: 4,2 GB em 12 min', { title: 'Backup', level: 'success' });
//
// ── O `id`, que é a razão desta lib existir ─────────────────────────────────
//
// O portal manda uma JANELA do fim do arquivo, não um delta exato — de propósito, para
// sobreviver a truncar e rotacionar. Quem impede a mesma notificação de chegar a cada tick é
// o `id`. Errá-lo tem dois lados, e os dois são silenciosos:
//
//   id que se REPETE entre eventos diferentes  → o segundo evento nunca aparece;
//   id que MUDA para o mesmo evento            → a mesma coisa avisa várias vezes.
//
// Por isso o padrão aqui é gerar um id único por chamada — "isto é um evento novo" é o caso
// comum, e um contador do próprio processo seria o jeito clássico de errar (ele reinicia
// junto com o processo, e aí o id 1 volta a existir).
//
// Quando você QUER idempotência, passe `key`: uma chave estável do evento. Chamar duas vezes
// com a mesma `key` produz o mesmo id, e o usuário é avisado uma vez só.
//
//   notify('Disco quase cheio', { key: `disco-cheio-${new Date().toISOString().slice(0, 10)}` });
//   // roda de hora em hora, avisa uma vez por dia
//
// ── Latência e custo ────────────────────────────────────────────────────────
//
// O portal faz poll em lote, um exec por servidor a cada poucos segundos, e SÓ enquanto
// houver alguém com o desktop aberto. Escrever é barato e não custa nada quando ninguém está
// olhando — mas também não é instantâneo. Não escreva em loop apertado esperando que apareça
// mais rápido.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// O journal é do USUÁRIO, não do app: um arquivo só, com todos os apps dele dentro. É o que
// permite ao portal ler tudo num `tail` por usuário em vez de um glob por app — o mesmo
// raciocínio de custo que faz o coletor ser por servidor e não por usuário.
const JOURNAL_DIR = '.vssh-notifications';
const JOURNAL = 'journal.ndjson';

// Rotação: acima disto, o arquivo é reescrito com as últimas linhas. O portal só lê o fim,
// então crescer não o atrapalha — o problema é ocupar o disco do usuário para sempre. O teto
// de linhas mantidas é MUITO maior que a janela que o portal lê (~50), de propósito: cortar
// perto da janela arriscaria apagar algo que ainda não foi entregue.
const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 200;

const NIVEIS = ['info', 'success', 'warning', 'error'];

function _home() {
  if (process.env.HOME) return process.env.HOME;
  // Sem HOME (systemd sem `User=`, container magro): a home dá para deduzir do
  // VSSH_APP_DATA_DIR, que é `<home>/.vssh-apps/<id>/data`.
  const data = process.env.VSSH_APP_DATA_DIR;
  if (data) return path.resolve(data, '..', '..', '..');
  return null;
}

function _file() {
  const h = _home();
  return h ? path.join(h, JOURNAL_DIR, JOURNAL) : null;
}

/** `key` vira id LEGÍVEL quando dá, e hash quando não dá — um journal é lido por gente. */
function _idFrom(appId, key) {
  const limpa = String(key).replace(/[^\w.:-]+/g, '-').slice(0, 80);
  if (limpa && limpa !== '-') return `${appId}:${limpa}`;
  return `${appId}:${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16)}`;
}

/**
 * Acrescenta uma notificação ao journal do usuário. Devolve o `id` gravado, ou `null` quando
 * não havia onde escrever.
 *
 * Opções: `title`, `level` (`info`|`success`|`warning`|`error`), `key` (idempotência),
 * `actions` (`[{id,label}]`, no máximo 3), `persistent` (o aviso não some sozinho),
 * `path` (rota do SEU backend que recebe o POST quando o usuário clica numa ação),
 * `appId` (padrão: `$VSSH_APP_ID`), `at` (instante em ms; padrão: agora).
 *
 * Não lança: um app tem trabalho de verdade a fazer, e ele não pode parar porque um aviso não
 * coube no disco. Fora do VSSH (o seu `npm run dev`) devolve `null` sem barulho.
 */
function notify(body, opts = {}) {
  const file = _file();
  if (!file) return null;

  const appId = String(opts.appId || process.env.VSSH_APP_ID || 'app').slice(0, 64);
  const id = opts.key != null && opts.key !== ''
    ? _idFrom(appId, opts.key)
    // Sem `key`, cada chamada é um evento novo. Tempo + aleatório, e não um contador: contador
    // reinicia com o processo, e aí o id de ontem volta a existir — o portal o reconheceria
    // como já entregue e o aviso sumiria em silêncio.
    : `${appId}:${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

  const entrada = {
    id,
    appId,
    body: String(body ?? '').slice(0, 500),
    // `at` é do EMISSOR, não da entrega: um evento que aconteceu com o desktop fechado tem de
    // mostrar a hora em que aconteceu, não a hora em que alguém abriu o navegador.
    at: Number.isFinite(opts.at) ? opts.at : Date.now(),
  };
  if (opts.title) entrada.title = String(opts.title).slice(0, 120);
  if (NIVEIS.includes(opts.level)) entrada.level = opts.level;
  if (opts.persistent) entrada.persistent = true;
  if (Array.isArray(opts.actions) && opts.actions.length) {
    entrada.actions = opts.actions
      .filter(a => a && typeof a.id === 'string' && typeof a.label === 'string')
      .slice(0, 3)
      .map(a => ({ id: a.id, label: a.label }));
  }
  if (opts.path) entrada.onAction = { path: String(opts.path) };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Uma linha, uma escrita, modo append. `JSON.stringify` já escapa quebra de linha do
    // corpo — o que garante que uma notificação de várias linhas não vire várias entradas
    // meio quebradas, que é como um formato de linha se corrompe com dado VÁLIDO.
    fs.appendFileSync(file, JSON.stringify(entrada) + '\n', 'utf8');
    _rotacionar(file);
    return id;
  } catch (err) {
    console.warn(`[vssh-notify] não foi possível escrever ${file}: ${err.message}`);
    return null;
  }
}

/**
 * Corta o journal quando ele passa do teto, mantendo as últimas linhas.
 *
 * Reescreve por arquivo temporário + rename: o rename é atômico, então o portal nunca lê um
 * journal pela metade. Sem isso, o corte aconteceria exatamente no instante em que o poll está
 * lendo — e o sintoma seria notificação perdida de vez em quando, sem nada no log.
 */
function _rotacionar(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.size <= MAX_BYTES) return;
  try {
    const linhas = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, linhas.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // Falhar em rotacionar não pode falhar a notificação: ela já está no arquivo.
    console.warn(`[vssh-notify] rotação falhou: ${err.message}`);
  }
}

module.exports = { notify, _journalPath: _file, _internals: { MAX_BYTES, KEEP_LINES } };
