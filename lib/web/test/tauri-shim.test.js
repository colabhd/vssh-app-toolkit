'use strict';

// Primeiros testes do `tauri-shim` — ele nasceu sem nenhum, e essa era a dívida T9 do roadmap.
//
// O que se mede aqui é TRADUÇÃO, não funcionalidade: `@tauri-apps/api` entra de um lado e o
// `window.vssh` sai do outro. Um shim que chama `pickFile` onde deveria chamar `pickDirectory`
// devolve um caminho perfeitamente válido — e está errado.
//
// A parte de `path` é a exceção: ela é string pura, não fala com o servidor, e é onde um app
// portado quebra de um jeito que ninguém liga ao shim (um `dirname` errado vira "arquivo não
// encontrado" três camadas acima).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregar, igual } = require('./_ambiente-falso.js');

const tauri = (opcoes) => {
  const amb = carregar('tauri-shim.js', opcoes);
  return { ...amb, api: amb.win.__TAURI__ };
};

// ── A guarda de carregamento ─────────────────────────────────────────────────

test('sem o vssh-app-shim carregado antes, avisa e não instala nada', () => {
  const { win, avisos } = carregar('tauri-shim.js', { semVssh: true });
  assert.equal(win.__TAURI__, undefined, 'instalou a API sobre um shim que não existe');
  assert.match(avisos.join('\n'), /vssh-app-shim\.js precisa ser carregado antes/);
});

test('não atropela um __TAURI__ que já exista', () => {
  // Um app pode ter carregado partes da API por conta própria — o `Object.assign` sobre o que já
  // existe é o comportamento declarado no fim do arquivo, e substituir o objeto inteiro apagaria
  // aquilo sem erro nenhum.
  const { win } = carregar('tauri-shim.js', {
    antes: (w) => { w.__TAURI__ = { meuPedaco: 42, fs: { jaEraMeu: true } }; },
  });
  assert.equal(win.__TAURI__.meuPedaco, 42, 'o shim apagou o que o app tinha instalado');
  assert.equal(typeof win.__TAURI__.fs.readTextFile, 'function', 'o shim não instalou o próprio fs');
  assert.equal(win.__TAURI__.fs.jaEraMeu, undefined,
    'o merge é por chave de topo: um fs nosso substitui o do app inteiro, e isso é intencional');
});

// ── fs ───────────────────────────────────────────────────────────────────────

test('fs: leitura de texto e de bytes vão por rotas diferentes', async () => {
  const { api, chamadas } = tauri();
  assert.equal(await api.fs.readTextFile('/a/nota.md'), 'conteudo');
  igual(await api.fs.readBinaryFile('/a/foto.png'), new Uint8Array([1, 2, 3]));
  // A separação existe porque texto-encodar um binário o corrompe em silêncio — a mesma lição
  // que criou `writeBytes` no shim. Um shim que mandasse os dois por `read` desfaria isso.
  igual(chamadas.map((c) => c[0]), ['fs.read', 'fs.readBytes']);
});

test('fs: writeTextFile aceita as DUAS assinaturas do Tauri v1', async () => {
  const { api, chamadas } = tauri();
  await api.fs.writeTextFile('/a/x.md', 'corpo');
  await api.fs.writeTextFile({ path: '/a/y.md', contents: 'outro' });
  await api.fs.writeFile({ path: '/a/z.bin', contents: 'terceiro' });
  // `writeTextFile(path, contents)` e `writeTextFile({path, contents})` coexistem na API real, e
  // um app usa a que o exemplo dele usava. Suportar só uma quebra metade dos ports.
  igual(chamadas, [
    ['fs.write', '/a/x.md', 'corpo'],
    ['fs.write', '/a/y.md', 'outro'],
    ['fs.write', '/a/z.bin', 'terceiro'],
  ]);
});

test('fs.readDir marca diretório pelos dois nomes de campo, e monta o path', async () => {
  const { api } = tauri({
    respostas: {
      'fs.list': { items: [
        { name: 'nota.md', type: 'file' },
        { name: 'sub', type: 'directory' },
        { name: 'outra', isDirectory: true },   // a outra grafia, que o shell também usa
      ] },
    },
  });
  // A barra final tem de ser normalizada, senão sai `/graf//nota.md` — que funciona no POSIX e
  // estraga qualquer comparação de string que o app faça depois.
  const itens = await api.fs.readDir('/graf/');
  igual(itens, [
    { path: '/graf/nota.md', name: 'nota.md', children: undefined },
    { path: '/graf/sub',     name: 'sub',     children: [] },
    { path: '/graf/outra',   name: 'outra',   children: [] },
  ]);
});

test('fs.exists responde pelo stat', async () => {
  const presente = tauri();
  assert.equal(await presente.api.fs.exists('/a/x'), true);

  const ausente = tauri({ respostas: { 'fs.stat': Promise.reject(new Error('404')) } });
  assert.equal(await ausente.api.fs.exists('/a/x'), false);
});

test('fs: remover arquivo e remover diretório caem na mesma op', async () => {
  const { api, chamadas } = tauri();
  await api.fs.removeFile('/a/x.md');
  await api.fs.removeDir('/a/sub');
  await api.fs.createDir('/a/nova');
  igual(chamadas, [
    ['fs.delete', '/a/x.md'], ['fs.delete', '/a/sub'], ['fs.mkdir', '/a/nova'],
  ]);
});

// ── dialog ───────────────────────────────────────────────────────────────────

test('dialog.open escolhe entre arquivo e pasta pelo `directory`', async () => {
  const { api, nomes, args } = tauri();
  assert.equal(await api.dialog.open({ title: 'Abrir' }), '/casa/nota.md');
  assert.equal(await api.dialog.open({ directory: true, title: 'Pasta' }), '/casa/pasta');
  igual(nomes(), ['pickFile', 'pickDirectory']);
  igual(args('pickFile'), [{ title: 'Abrir' }]);
});

test('dialog: título vem como string ou como objeto, e os dois valem', async () => {
  const { api, chamadas } = tauri();
  await api.dialog.message('corpo', 'Título em string');
  await api.dialog.ask('pergunta', { title: 'Título em objeto' });
  await api.dialog.confirm('outra', 'Terceiro');
  igual(chamadas, [
    ['dialog.alert', 'corpo', 'Título em string'],
    ['dialog.confirm', 'pergunta', 'Título em objeto'],
    ['dialog.confirm', 'outra', 'Terceiro'],
  ]);
});

test('dialog.save leva o nome sugerido', async () => {
  const { api, args } = tauri();
  await api.dialog.save({ title: 'Salvar', defaultPath: 'relatorio.pdf' });
  igual(args('pickSave'), [{ title: 'Salvar', name: 'relatorio.pdf' }]);
});

// ── shell ────────────────────────────────────────────────────────────────────

test('shell.open separa URL de caminho do servidor', async () => {
  const { api, chamadas, janelasAbertas } = tauri();
  await api.shell.open('https://exemplo.org/doc');
  await api.shell.open('/casa/relatorio.pdf');
  igual(janelasAbertas, [{ url: 'https://exemplo.org/doc', alvo: '_blank', feicoes: 'noopener' }]);
  igual(chamadas, [['openFile', '/casa/relatorio.pdf']]);
});

test('shell.Command recusa com uma mensagem que diz o que fazer', () => {
  const { api } = tauri();
  assert.throws(() => api.shell.Command(), (e) => {
    // A recusa é metade do valor; a outra metade é dizer para onde a lógica vai. Sem isso, quem
    // porta descobre que não funciona e não descobre o que fazer a respeito.
    assert.match(e.message, /shell\.Command/);
    assert.match(e.message, /backend próprio do vssh-app/);
    return true;
  });
});

// ── notification ─────────────────────────────────────────────────────────────

test('sendNotification aceita string e objeto', () => {
  const { api, chamadas } = tauri();
  api.notification.sendNotification('so o corpo');
  api.notification.sendNotification({ title: 'T', body: 'B' });
  igual(chamadas, [
    ['notify', 'so o corpo', { title: undefined }],
    ['notify', 'B', { title: 'T' }],
  ]);
});

test('sendNotification só com título não pode virar um toast vazio', () => {
  // `sendNotification({ title })` sem corpo é uso legítimo da API do Tauri. Passar `''` como
  // mensagem produz um toast em branco — o usuário vê um retângulo sem texto e não há erro em
  // lugar nenhum. O `electron-shim` já resolvia isso (`this.body || this.title`); este não.
  const { api, chamadas } = tauri();
  api.notification.sendNotification({ title: 'Índice reconstruído' });
  igual(chamadas, [['notify', 'Índice reconstruído', { title: undefined }]]);
});

test('a permissão de notificação é sempre concedida — o toast do shell não pergunta', async () => {
  const { api } = tauri();
  assert.equal(await api.notification.isPermissionGranted(), true);
  assert.equal(await api.notification.requestPermission(), 'granted');
});

// ── path ─────────────────────────────────────────────────────────────────────

test('path: as operações de string batem com o `path.posix` do Node', async () => {
  const { api } = tauri();
  const p = api.path;
  assert.equal(p.sep, '/');
  assert.equal(await p.join('a', 'b', 'c.md'), 'a/b/c.md');
  assert.equal(await p.join('/a/', '/b'), '/a/b', 'barras duplicadas na junção');
  assert.equal(await p.dirname('/a/b/c.md'), '/a/b');
  assert.equal(await p.dirname('/a/b/'), '/a', 'barra final não pode virar um nível a mais');
  assert.equal(await p.dirname('/a'), '/', 'a raiz é o fundo, não uma string vazia');
  assert.equal(await p.basename('/a/b/c.md'), 'c.md');
  assert.equal(await p.basename('/a/b/c.md', '.md'), 'c');
  assert.equal(await p.basename('/a/b/'), 'b');
  assert.equal(await p.extname('/a/b/c.tar.gz'), 'gz');
  // Arquivo oculto sem extensão: o ponto inicial não é extensão. É o mesmo critério do Node, e
  // errar aqui faz um `.bashrc` ser tratado como arquivo do tipo `bashrc`.
  assert.equal(await p.extname('/casa/.bashrc'), '');
  assert.equal(await p.isAbsolute('/a'), true);
  assert.equal(await p.isAbsolute('a/b'), false);
});

test('os diretórios conhecidos recusam em vez de chutar', () => {
  const { api } = tauri();
  for (const nome of ['appDir', 'appDataDir', 'homeDir']) {
    assert.throws(() => api.path[nome](), new RegExp(`path\\.${nome}`),
      `${nome} devolveu alguma coisa — e um caminho inventado é pior que uma recusa`);
  }
});

// ── o que não tem tradução ───────────────────────────────────────────────────

test('invoke() de comando Rust recusa, e o __TAURI_INVOKE__ aponta para a mesma recusa', () => {
  const { api, win } = tauri();
  assert.throws(() => api.invoke('meu_comando'), /comando Rust customizado/);
  assert.equal(win.__TAURI_INVOKE__, api.invoke,
    'os apps chamam pelos dois nomes; só um deles recusar seria pior que nenhum');
});

test('eventos entre janelas viram no-op — há uma janela só', async () => {
  const { api } = tauri();
  const parar = await api.event.listen('algo', () => {});
  assert.equal(typeof parar, 'function', 'listen tem de devolver o cancelador, senão o app quebra ao limpar');
  await api.event.emit('algo', {});   // não lança
});
