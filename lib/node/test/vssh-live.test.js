// vssh-live — a atividade em curso de um app SEM janela.
//
// O que estes testes protegem:
//
//  1. O `at`. Um arquivo chamado `live` sobrevive a um `kill -9`, e o portal o descarta depois
//     de ~60 s sem renovação. Se `setLive` esquecer de carimbar o instante, a atividade some
//     sozinha um minuto depois de aparecer — e o sintoma (uma barra que desiste no meio) não
//     aponta para cá.
//
//  2. A ESCRITA ATÔMICA. O portal faz poll; sem `tmp` + `rename` ele lê o arquivo pela metade e
//     descarta como JSON inválido. O sintoma é a barra piscando sob atualização frequente, que é
//     exatamente quando ela importa.
//
//  3. AS DUAS SAÍDAS DO `clear`. Sem `registrar`, a atividade some e não deixa rastro — é o caso
//     da indisponibilidade resolvida. Com `registrar`, o fim vira UMA notificação no journal. A
//     ordem entre registrar e apagar é a diferença entre "some sem contar como terminou" e "fica
//     até o TTL", e só a segunda é recuperável.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setLive, clearLive, _liveFilePath } = require('../vssh-live.js');

/** Roda `fn` com uma HOME de mentira e devolve o que ficou no disco. */
function comHome(fn, appId = 'meu-app') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-live-'));
  const antes = { HOME: process.env.HOME, ID: process.env.VSSH_APP_ID };
  process.env.HOME = home;
  process.env.VSSH_APP_ID = appId;
  try {
    const retorno = fn();
    const dir = path.join(home, '.vssh-notifications', 'live');
    const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const itens = {};
    for (const nome of arquivos) {
      try { itens[nome] = JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8')); } catch { itens[nome] = null; }
    }
    const j = path.join(home, '.vssh-notifications', 'journal.ndjson');
    const journal = fs.existsSync(j)
      ? fs.readFileSync(j, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      : [];
    return { retorno, arquivos, itens, journal };
  } finally {
    antes.HOME === undefined ? delete process.env.HOME : (process.env.HOME = antes.HOME);
    antes.ID === undefined ? delete process.env.VSSH_APP_ID : (process.env.VSSH_APP_ID = antes.ID);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a atividade vira um arquivo por chave, com o instante carimbado', () => {
  const r = comHome(() => setLive('sync', {
    titulo: 'Sincronizando', formato: 'progresso', progresso: { feito: 3, total: 12 },
  }));
  assert.equal(r.retorno, true);
  assert.deepEqual(r.arquivos, ['sync.json']);

  const item = r.itens['sync.json'];
  assert.equal(item.titulo, 'Sincronizando');
  assert.deepEqual(item.progresso, { feito: 3, total: 12 });
  // Sem `at`, o portal descarta o arquivo: uma atividade sem prazo de validade é uma que mente
  // depois que o processo morre.
  assert.ok(Number.isFinite(item.at), '`at` não foi carimbado');
  assert.ok(Math.abs(Date.now() - item.at) < 5000, '`at` precisa ser o instante da escrita');
});

test('a mesma chave substitui no lugar — relatar progresso não empilha arquivos', () => {
  const r = comHome(() => {
    for (let i = 1; i <= 12; i++) setLive('sync', { titulo: 'Sincronizando', progresso: { feito: i, total: 12 } });
  });
  assert.deepEqual(r.arquivos, ['sync.json']);
  assert.deepEqual(r.itens['sync.json'].progresso, { feito: 12, total: 12 });
});

test('chaves diferentes são atividades diferentes', () => {
  const r = comHome(() => {
    setLive('sync', { titulo: 'Sincronizando' });
    setLive('indexar', { titulo: 'Indexando' });
  });
  assert.deepEqual(r.arquivos.sort(), ['indexar.json', 'sync.json']);
});

test('chave torta não vira arquivo — o nome atravessa até virar caminho no servidor', () => {
  // `..` é o caso que importa: o nome sai de um `basename "$f" .json` do lado de lá, e a
  // validação nos dois lados é a mesma. Recusar aqui evita escrever o arquivo, e não só ignorá-lo.
  for (const ruim of ['../fuga', 'com espaço', 'a'.repeat(65), '', null, 42, 'barra/no/meio']) {
    const r = comHome(() => setLive(ruim, { titulo: 'x' }));
    assert.equal(r.retorno, false, String(ruim));
    assert.deepEqual(r.arquivos, [], String(ruim));
  }
});

test('não sobra arquivo temporário — a escrita é atômica', () => {
  // `tmp` + `rename`. Sem isso o poll do portal lê pela metade; e um `.tmp` esquecido no
  // diretório ainda conta para o teto de 32 arquivos que o coletor aplica.
  const r = comHome(() => setLive('sync', { titulo: 'x' }));
  assert.deepEqual(r.arquivos, ['sync.json'], `sobrou lixo: ${JSON.stringify(r.arquivos)}`);
});

test('clear sem `registrar` some e não deixa rastro nenhum', () => {
  // A indisponibilidade resolvida: "o disco voltou" não é um fato que alguém precise reler.
  const r = comHome(() => {
    setLive('disco', { titulo: 'Disco quase cheio', level: 'warning' });
    return clearLive('disco');
  });
  assert.equal(r.retorno, true);
  assert.deepEqual(r.arquivos, []);
  assert.deepEqual(r.journal, [], 'encerrar em silêncio não pode inventar notificação');
});

test('clear com `registrar` deixa UMA notificação no journal, e o arquivo some', () => {
  const r = comHome(() => {
    setLive('sync', { titulo: 'Sincronizando', progresso: { feito: 550, total: 550 } });
    return clearLive('sync', { registrar: { titulo: 'Sincronização concluída', texto: '550 arquivos', level: 'success' } });
  });
  assert.equal(r.retorno, true);
  assert.deepEqual(r.arquivos, [], 'a atividade ficou na tela depois de encerrada');
  assert.equal(r.journal.length, 1);
  assert.equal(r.journal[0].title, 'Sincronização concluída');
  assert.equal(r.journal[0].body, '550 arquivos');
  assert.equal(r.journal[0].level, 'success');
});

test('encerrar duas vezes a mesma atividade não duplica a notificação', () => {
  // Acontece de verdade: o `clearLiveOnExit` e o fim normal do trabalho podem encerrar a mesma
  // chave. A `key` estável do journal é o que faz o portal fundir as duas numa linha só.
  const r = comHome(() => {
    setLive('sync', { titulo: 'Sincronizando' });
    clearLive('sync', { registrar: { titulo: 'Pronto', texto: 'ok' } });
    setLive('sync', { titulo: 'Sincronizando de novo' });
    clearLive('sync', { registrar: { titulo: 'Pronto', texto: 'ok' } });
  });
  assert.equal(r.journal.length, 2, 'as duas linhas existem no arquivo append-only');
  assert.equal(r.journal[0].id, r.journal[1].id,
    'com a mesma `key`, o id é o mesmo — é ele que faz o portal entregar uma vez só');
});

test('clear de chave que nunca existiu não lança nem inventa nada', () => {
  const r = comHome(() => clearLive('nunca-existiu'));
  assert.equal(r.retorno, true);
  assert.deepEqual(r.journal, []);
});

test('fora do VSSH, escrever não lança — só devolve false', () => {
  // Um app rodando no `npm run dev` da pessoa não tem `HOME` de servidor nem barra de tarefas.
  // Atividade é enfeite do ambiente: um app não pode morrer por não conseguir mostrar uma barra.
  const antes = process.env.HOME;
  delete process.env.HOME;
  try {
    assert.doesNotThrow(() => setLive('sync', { titulo: 'x' }));
    assert.equal(setLive('sync', { titulo: 'x' }), false);
    assert.equal(clearLive('sync'), false);
    assert.equal(_liveFilePath('sync'), null);
  } finally { if (antes !== undefined) process.env.HOME = antes; }
});
