'use strict';

// Primeiros testes do `electron-shim` — ele nasceu sem nenhum, e essa era a dívida T9 do roadmap.
//
// O escopo deste shim é declarado no cabeçalho dele: cobre o que é PADRÃO do Electron e recusa,
// com mensagem clara, o que é bespoke. Então metade do que se mede aqui é a recusa — e ela é
// funcionalidade de verdade, não ausência dela: um `ipcRenderer.invoke` que rejeita nomeando o
// canal diz a quem porta exatamente o que precisa virar backend. Um que devolvesse `undefined`
// deixaria o app quebrar três camadas adiante.
//
// A outra metade é a tradução de formato. O Electron devolve `{ canceled, filePaths }`, e o shell
// devolve um caminho ou `null`; quem faz essa ponte errado produz um app que "abre o seletor,
// cancela, e mesmo assim salva".

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { carregar, igual } = require('./_ambiente-falso.js');

const electron = (opcoes) => {
  const amb = carregar('electron-shim.js', opcoes);
  return { ...amb, api: amb.win.electron };
};

// ── A guarda de carregamento ─────────────────────────────────────────────────

test('sem o vssh-app-shim carregado antes, avisa e não instala nada', () => {
  const { win, avisos } = carregar('electron-shim.js', { semVssh: true });
  assert.equal(win.electron, undefined, 'instalou a API sobre um shim que não existe');
  assert.equal(win.require, undefined, 'sequestrou o require() sem ter o que devolver');
  assert.match(avisos.join('\n'), /vssh-app-shim\.js precisa ser carregado antes/);
});

test("require('electron') devolve a superfície; qualquer outro módulo recusa", () => {
  const { win, api } = electron();
  assert.equal(win.require('electron'), api);
  assert.throws(() => win.require('fs'), /require\('fs'\) não disponível/);
});

test('não atropela um require() que o app já tinha', () => {
  const { win } = carregar('electron-shim.js', {
    antes: (w) => { w.require = (m) => `o meu: ${m}`; },
  });
  // Um bundler pode ter instalado o próprio. Substituí-lo quebraria o app inteiro, e não só a
  // parte do Electron — por isso o `||` no fim do arquivo.
  assert.equal(win.require('qualquer'), 'o meu: qualquer');
});

// ── dialog: a tradução de formato ────────────────────────────────────────────

test('showOpenDialog escolhe arquivo ou pasta por `properties`', async () => {
  const { api, nomes, args } = electron();
  igual(await api.dialog.showOpenDialog({ title: 'Abrir' }),
        { canceled: false, filePaths: ['/casa/nota.md'] });
  igual(await api.dialog.showOpenDialog({ title: 'Pasta', properties: ['openDirectory'] }),
        { canceled: false, filePaths: ['/casa/pasta'] });
  igual(nomes(), ['pickFile', 'pickDirectory']);
  igual(args('pickFile'), [{ title: 'Abrir', dir: undefined }]);
});

test('showOpenDialog aceita a forma de dois argumentos do Electron', async () => {
  // `dialog.showOpenDialog(browserWindow, options)` é a assinatura mais comum em código real. Se o
  // shim lesse só o primeiro argumento, ele receberia a janela e abriria um seletor sem opção
  // nenhuma — sem erro, e com o filtro do app perdido.
  const { api, args } = electron();
  const janelaFalsa = { id: 1 };
  await api.dialog.showOpenDialog(janelaFalsa, { title: 'Escolha', properties: ['openDirectory'] });
  igual(args('pickDirectory'), [{ title: 'Escolha', dir: undefined }]);
});

test('cancelar um seletor vira `canceled: true` — não uma lista vazia calada', async () => {
  const { api } = electron({ respostas: { pickFile: null, pickSave: null } });
  igual(await api.dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
  igual(await api.dialog.showSaveDialog({}), { canceled: true, filePath: undefined });
});

test('showMessageBox: um botão vira alerta, dois ou mais viram confirmação', async () => {
  const sim = electron({ respostas: { 'dialog.confirm': true } });
  igual(await sim.api.dialog.showMessageBox({ message: 'so aviso' }), { response: 0, checkboxChecked: false });
  igual(sim.nomes(), ['dialog.alert']);

  igual(await sim.api.dialog.showMessageBox({ message: 'segue?', buttons: ['Sim', 'Não'] }),
        { response: 0, checkboxChecked: false });

  const nao = electron({ respostas: { 'dialog.confirm': false } });
  igual(await nao.api.dialog.showMessageBox({ message: 'segue?', buttons: ['Sim', 'Não'] }),
        { response: 1, checkboxChecked: false });
});

test('showMessageBox honra `defaultId`/`cancelId` — o índice do botão é o contrato', async () => {
  // No Electron `response` é o ÍNDICE do botão clicado, e a ordem dos botões é do app. Presumir
  // que o afirmativo é o índice 0 acerta em `['Sim','Não']` e erra em `['Cancelar','OK']` — onde
  // confirmar devolveria 0, que é o "Cancelar". O app então descarta o trabalho do usuário
  // achando que ele pediu isso, e não há erro em lugar nenhum.
  const { api } = electron({ respostas: { 'dialog.confirm': true } });
  igual(await api.dialog.showMessageBox({
    message: 'salvar?', buttons: ['Cancelar', 'OK'], defaultId: 1, cancelId: 0,
  }), { response: 1, checkboxChecked: false });

  const recusa = electron({ respostas: { 'dialog.confirm': false } });
  igual(await recusa.api.dialog.showMessageBox({
    message: 'salvar?', buttons: ['Cancelar', 'OK'], defaultId: 1, cancelId: 0,
  }), { response: 0, checkboxChecked: false });
});

test('showErrorBox usa o diálogo de erro, não o de alerta', () => {
  const { api, chamadas } = electron();
  api.dialog.showErrorBox('Falhou', 'o disco encheu');
  igual(chamadas, [['dialog.error', 'o disco encheu', 'Falhou']]);
});

// ── shell ────────────────────────────────────────────────────────────────────

test('showItemInFolder abre a pasta que contém o item', () => {
  const { api, chamadas } = electron();
  api.shell.showItemInFolder('/casa/docs/relatorio.pdf');
  api.shell.showItemInFolder('/raiz.txt');
  // "Revelar o item" não existe no desktop; mostrar a pasta é o que o usuário queria. O segundo
  // caso é a borda: sem ela, um arquivo na raiz abriria a pasta `''`.
  igual(chamadas, [['openFolder', '/casa/docs'], ['openFolder', '/']]);
});

test('openExternal abre em aba nova com noopener', async () => {
  const { api, janelasAbertas } = electron();
  await api.shell.openExternal('https://exemplo.org');
  igual(janelasAbertas, [{ url: 'https://exemplo.org', alvo: '_blank', feicoes: 'noopener' }]);
});

test('trashItem recusa em vez de apagar de verdade', () => {
  const { api } = electron();
  assert.throws(() => api.shell.trashItem('/casa/x'), /shell\.trashItem/);
});

// ── clipboard ────────────────────────────────────────────────────────────────

test('o clipboard de texto passa pelo navegador, e readText devolve Promise', async () => {
  const { api, chamadas } = electron();
  const lido = api.clipboard.readText();
  assert.ok(typeof lido.then === 'function',
    'no Electron isto é síncrono; aqui não dá, e é a única assinatura que este shim não esconde');
  assert.equal(await lido, 'o que ja estava la');
  await api.clipboard.writeText('novo');
  igual(chamadas, [['clipboard.readText'], ['clipboard.writeText', 'novo']]);
});

test('o clipboard de imagem recusa — o shell ainda não tem essa API', () => {
  const { api } = electron();
  assert.throws(() => api.clipboard.readImage(), /clipboard\.readImage/);
  assert.throws(() => api.clipboard.writeImage(), /clipboard\.writeImage/);
});

// ── ipcRenderer: a recusa é o produto ────────────────────────────────────────

test('ipcRenderer.invoke rejeita NOMEANDO o canal', async () => {
  const { api } = electron();
  await assert.rejects(() => api.ipcRenderer.invoke('db:query', { id: 7 }), (e) => {
    // O nome do canal é a informação inteira: é o que se procura no código do app para decidir o
    // que vira rota do backend. Uma mensagem genérica manda quem porta caçar às cegas.
    assert.match(e.message, /db:query/);
    assert.match(e.message, /backend do seu vssh-app/);
    return true;
  });
});

test('ipcRenderer.send avisa e segue; os listeners são no-op silencioso', () => {
  const { api, avisos } = electron();
  api.ipcRenderer.send('janela:pronta');
  assert.match(avisos.join('\n'), /janela:pronta/);
  // `on`/`once` não avisam de propósito: um app registra dezenas no boot, e um aviso por registro
  // afogaria o console — enquanto `send` é uma ação que o usuário disparou e que não aconteceu.
  api.ipcRenderer.on('x', () => {});
  api.ipcRenderer.removeAllListeners('x');
  assert.equal(avisos.length, 1);
});

// ── Notification ─────────────────────────────────────────────────────────────

test('dentro do desktop, Notification vira o toast do shell', () => {
  const { win, chamadas } = electron();
  new win.Notification('Índice pronto', { body: 'foram 300 arquivos' });
  new win.Notification('So o titulo');
  igual(chamadas, [
    ['notify', 'foram 300 arquivos', { title: 'Índice pronto', level: 'info' }],
    // Sem corpo, o título é a mensagem — senão o toast sai em branco.
    ['notify', 'So o titulo', { title: undefined, level: 'info' }],
  ]);
});

test('FORA do desktop, a Notification nativa não é tocada', () => {
  const { win } = carregar('electron-shim.js', {
    inDesktop: false,
    antes: (w) => { w.Notification = function Nativa() {}; w.Notification.__nativa = true; },
  });
  // No `npm run dev`, fora do desktop, a notificação do navegador é a resposta certa. Sequestrá-la
  // ali seria trocar algo que funciona por um `vssh.notify` que não tem para onde ir.
  assert.equal(win.Notification.__nativa, true);
});

test('o clique numa Notification avisa que não volta, em vez de nunca disparar', () => {
  const { win, avisos } = electron();
  const n = new win.Notification('t', { body: 'b' });
  n.addEventListener('click', () => {});
  n.onclick = () => {};
  assert.equal(avisos.filter((a) => /Notification/.test(a)).length, 2);
  assert.equal(n.onclick, null, 'o getter tem de ser honesto sobre não haver handler');
});

test('a permissão de notificação já vem concedida — o toast do shell não pergunta', async () => {
  const { win } = electron();
  assert.equal(win.Notification.permission, 'granted');
  assert.equal(await win.Notification.requestPermission(), 'granted');
});

// ── app ──────────────────────────────────────────────────────────────────────

test('app.getVersion tem três fontes, nessa ordem', () => {
  // O `version` do manifest não chega ao frontend — o proxy serve o app, não injeta metadados. As
  // duas primeiras fontes são o que o app PODE declarar; o `0.0.0` do fim passa a ser a resposta
  // de quem não declarou, e não a de quem não tinha como.
  const global = electron({ globais: {}, meta: { 'vssh-app-version': '2.0.0' } });
  global.win.__VSSH_APP_VERSION__ = '3.1.4';
  assert.equal(global.api.app.getVersion(), '3.1.4');

  const porMeta = electron({ meta: { 'vssh-app-version': '2.0.0' } });
  assert.equal(porMeta.api.app.getVersion(), '2.0.0');

  const semNada = electron();
  assert.equal(semNada.api.app.getVersion(), '0.0.0');
});

test('app.getName cai no título do documento', () => {
  assert.equal(electron({ title: 'Meu Editor' }).api.app.getName(), 'Meu Editor');
  assert.equal(electron({ title: '' }).api.app.getName(), 'vssh-app');
});

test('app.getPath recusa dizendo os dois caminhos que existem', () => {
  const { api } = electron();
  assert.throws(() => api.app.getPath('userData'), (e) => {
    assert.match(e.message, /showDirectoryPicker|VSSH_APP_DATA_DIR/);
    return true;
  });
});

test('app.quit e app.exit fecham a janela', () => {
  const { api, nomes } = electron();
  api.app.quit();
  api.app.exit();
  igual(nomes(), ['window.close', 'window.close']);
});

// ── BrowserWindow ────────────────────────────────────────────────────────────

test('os controles de janela chegam ao shell — não são mais no-op', () => {
  const { api, nomes } = electron();
  const j = api.BrowserWindow.getCurrentWindow();
  j.minimize(); j.maximize(); j.unmaximize(); j.focus(); j.close();
  igual(nomes(), ['window.minimize', 'window.maximize', 'window.restore', 'window.focus', 'window.close']);
});

test('show/hide viram a aproximação mais próxima, e isso é escolha', () => {
  const { api, nomes } = electron();
  const j = api.remote.getCurrentWindow();
  j.show();   // trazer para a frente
  j.hide();   // tirar da frente
  igual(nomes(), ['window.focus', 'window.minimize']);
});

test('setTitle escreve no document.title, que o shim espelha sozinho', () => {
  const { api, doc, chamadas } = electron();
  const j = api.BrowserWindow.getCurrentWindow();
  j.setTitle('Outro');
  assert.equal(doc.title, 'Outro');
  assert.equal(j.getTitle(), 'Outro');
  // Nada foi enviado ao shell daqui: quem repassa o título é o `vssh-app-shim`, observando o
  // `<title>`. Mandar também produziria duas mensagens para a mesma mudança.
  igual(chamadas, []);
});

test('nativeTheme lê o media query do navegador', () => {
  assert.equal(electron({ respostas: { temaEscuro: true } }).api.nativeTheme.shouldUseDarkColors, true);
  assert.equal(electron().api.nativeTheme.shouldUseDarkColors, false);
});

test('o Menu existe para não quebrar o boot, e não faz nada', () => {
  const { api } = electron();
  api.Menu.setApplicationMenu(null);
  api.Menu.buildFromTemplate([]).popup();   // um app chama isso no boot; lançar mataria a janela
});
