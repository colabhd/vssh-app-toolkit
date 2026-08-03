// vssh-notify — a lib existe por causa do `id`, e é isso que estes testes medem.
//
// O portal manda uma JANELA do fim do journal, não um delta exato — de propósito, para
// sobreviver a truncar e rotacionar o arquivo. Quem impede a mesma notificação de chegar a
// cada tick é o `id`, e errá-lo falha SILENCIOSAMENTE dos dois lados:
//
//   id que se repete entre eventos diferentes → o segundo evento nunca aparece;
//   id que muda para o mesmo evento           → a mesma coisa avisa várias vezes.
//
// Nenhum dos dois dá erro em lugar nenhum. É por isso que gerar o id não pode ser tarefa de
// quem escreve o app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { notify, _journalPath, _internals } = require('../vssh-notify.js');

/** Roda `fn` com uma HOME de mentira, e devolve as linhas do journal como objetos. */
function comHome(fn, appId = 'meu-app') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-notify-'));
  const antes = { HOME: process.env.HOME, ID: process.env.VSSH_APP_ID, DATA: process.env.VSSH_APP_DATA_DIR };
  process.env.HOME = home;
  process.env.VSSH_APP_ID = appId;
  delete process.env.VSSH_APP_DATA_DIR;
  try {
    const r = fn();
    const f = path.join(home, '.vssh-notifications', 'journal.ndjson');
    const existe = fs.existsSync(f);
    const linhas = existe ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()) : [];
    // O tamanho é lido AQUI: quem chama só recebe o resultado depois que a home temporária já
    // foi apagada, então um `existsSync` lá fora sempre daria falso. Foi o que aconteceu.
    return { retorno: r, linhas, itens: linhas.map(l => JSON.parse(l)), bytes: existe ? fs.statSync(f).size : 0 };
  } finally {
    antes.HOME === undefined ? delete process.env.HOME : (process.env.HOME = antes.HOME);
    antes.ID === undefined ? delete process.env.VSSH_APP_ID : (process.env.VSSH_APP_ID = antes.ID);
    if (antes.DATA !== undefined) process.env.VSSH_APP_DATA_DIR = antes.DATA;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('sem `key`, cada chamada é um evento novo — e o id nunca repete', () => {
  const { itens } = comHome(() => { for (let i = 0; i < 50; i++) notify(`evento ${i}`); });
  assert.equal(itens.length, 50);
  assert.equal(new Set(itens.map(n => n.id)).size, 50, 'id repetido = evento que nunca aparece');
});

test('com `key`, o mesmo evento produz o mesmo id — avisa uma vez só', () => {
  // O caso real: uma verificação de disco que roda de hora em hora e deve avisar uma vez por
  // dia. Sem `key` seriam 24 avisos idênticos; com id na mão, seria fácil errar.
  const { itens } = comHome(() => {
    notify('Disco quase cheio', { key: 'disco-2026-08-03' });
    notify('Disco quase cheio', { key: 'disco-2026-08-03' });
  });
  assert.equal(itens[0].id, itens[1].id);
  assert.match(itens[0].id, /^meu-app:disco-2026-08-03$/, 'id legível: um journal é lido por gente');
});

test('`key` com caractere estranho vira id utilizável, não um id quebrado', () => {
  const { itens } = comHome(() => {
    notify('a', { key: '/etc/passwd e um espaço' });
    notify('b', { key: '///' });                    // não sobra nada legível
  });
  assert.match(itens[0].id, /^meu-app:[\w.:-]+$/);
  assert.match(itens[1].id, /^meu-app:[0-9a-f]{16}$/, 'sem nada legível, cai no hash — mas continua estável');
  assert.notEqual(itens[0].id, itens[1].id);
});

test('corpo com quebra de linha continua sendo UMA entrada', () => {
  // É como um formato de linha se corrompe com dado VÁLIDO: uma notificação de várias linhas
  // viraria várias entradas meio quebradas, e o portal descartaria as sobras em silêncio.
  const { linhas, itens } = comHome(() => notify('linha um\nlinha dois\nlinha três'));
  assert.equal(linhas.length, 1);
  assert.equal(itens[0].body, 'linha um\nlinha dois\nlinha três');
});

test('o que é opcional não polui a linha', () => {
  const { itens } = comHome(() => notify('só o corpo'));
  assert.deepEqual(Object.keys(itens[0]).sort(), ['appId', 'at', 'body', 'id']);
});

test('ações e persistent atravessam, com o teto do contrato', () => {
  const { itens } = comHome(() => notify('Backup falhou', {
    title: 'Backup', level: 'error', persistent: true, path: 'api/notificacao',
    actions: [
      { id: 'retry', label: 'Tentar' },
      { id: 'ignore', label: 'Ignorar' },
      { id: 'later', label: 'Depois' },
      { id: 'excedente', label: 'não cabe' },
      { id: 'sem-label' },
    ],
  }));
  const n = itens[0];
  assert.equal(n.level, 'error');
  assert.equal(n.persistent, true);
  assert.deepEqual(n.onAction, { path: 'api/notificacao' });
  assert.deepEqual(n.actions.map(a => a.id), ['retry', 'ignore', 'later'], 'teto de 3, e só o que tem id+label');
});

test('nível inventado não atravessa — o shell tem uma lista fechada', () => {
  const { itens } = comHome(() => notify('x', { level: 'catastrófico' }));
  assert.equal(itens[0].level, undefined, 'melhor omitir e cair no padrão do shell que inventar');
});

test('`at` é do emissor, não da entrega', () => {
  // Um evento que aconteceu com o desktop fechado tem de mostrar a hora em que aconteceu. Sem
  // `at` na linha, o shell usaria a hora em que alguém abriu o navegador.
  const { itens } = comHome(() => notify('x', { at: 1754150400000 }));
  assert.equal(itens[0].at, 1754150400000);
  const agora = comHome(() => notify('y'));
  assert.ok(Number.isFinite(agora.itens[0].at) && agora.itens[0].at > 0);
});

test('o journal não cresce sem limite, e o corte nunca leva o que é recente', () => {
  // O teto é de BYTES; `KEEP_LINES` é o alvo do corte, não um teto de linhas — depois de
  // rotacionar, o arquivo volta a crescer até o teto de novo. Medir linhas aqui mediria a
  // coisa errada, e foi o que a primeira versão deste teste fez.
  //
  // A folga também é o ponto: o portal lê ~50 linhas do fim, e cortar perto disso arriscaria
  // apagar algo que ainda não foi entregue.
  assert.ok(_internals.KEEP_LINES >= 200, 'a folga sobre a janela que o portal lê é deliberada');

  const { itens, bytes } = comHome(() => {
    const gordo = 'x'.repeat(400);
    for (let i = 0; i < 900; i++) notify(`${i} ${gordo}`);
  });
  assert.ok(bytes <= _internals.MAX_BYTES, `journal com ${bytes} B passou do teto`);
  // Rotação que apaga tudo é pior que journal grande: o aviso some antes de ser entregue.
  assert.ok(itens.length > _internals.KEEP_LINES / 2, `sobraram só ${itens.length} linhas`);
  // O corte guarda o FIM: o que sai é o velho, nunca o recém-escrito.
  assert.equal(itens[itens.length - 1].body.split(' ')[0], '899');
  // E toda linha sobrevivente continua sendo JSON — um corte no meio de uma linha seria pior
  // que não cortar.
  for (const n of itens) assert.equal(typeof n.id, 'string');
});

test('fora do VSSH devolve null, sem lançar e sem escrever nada', () => {
  // Bandeja e notificação são coisas do ambiente. Um app não pode morrer no `npm run dev` de
  // quem o escreve porque não existe uma home de VSSH ali.
  const antes = { HOME: process.env.HOME, DATA: process.env.VSSH_APP_DATA_DIR };
  delete process.env.HOME;
  delete process.env.VSSH_APP_DATA_DIR;
  try {
    assert.equal(_journalPath(), null);
    assert.equal(notify('ninguém vai ver'), null);
  } finally {
    if (antes.HOME !== undefined) process.env.HOME = antes.HOME;
    if (antes.DATA !== undefined) process.env.VSSH_APP_DATA_DIR = antes.DATA;
  }
});

test('sem HOME, a home sai do VSSH_APP_DATA_DIR', () => {
  // systemd sem `User=`, container magro: HOME pode não existir. O caminho de dados sempre
  // existe, e ele é `<home>/.vssh-apps/<id>/data`.
  const antes = { HOME: process.env.HOME, DATA: process.env.VSSH_APP_DATA_DIR };
  delete process.env.HOME;
  process.env.VSSH_APP_DATA_DIR = path.join(path.sep, 'casa', 'ana', '.vssh-apps', 'x', 'data');
  try {
    const p = _journalPath();
    // O que de fato pode dar errado é contar níveis a menos e enfiar o journal DENTRO do
    // diretório do app — onde o portal não olha, e onde ele seria privado de um app só.
    assert.ok(!p.includes('.vssh-apps'), `journal foi parar dentro do app: ${p}`);
    assert.ok(p.endsWith(path.join('casa', 'ana', '.vssh-notifications', 'journal.ndjson')), p);
  } finally {
    if (antes.HOME !== undefined) process.env.HOME = antes.HOME;
    antes.DATA === undefined ? delete process.env.VSSH_APP_DATA_DIR : (process.env.VSSH_APP_DATA_DIR = antes.DATA);
  }
});
