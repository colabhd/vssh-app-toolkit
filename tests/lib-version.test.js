'use strict';

// A versão que as libs DECLARAM tem de ser a versão que o toolkit TEM.
//
// `lib/web/vssh-app-shim.js` carrega um `LIB_VERSION` literal, porque roda no navegador e não tem
// de onde ler o `package.json`. Um literal é exatamente o tipo de coisa que fica para trás num
// bump — e o custo desse esquecimento é pior que o normal: a versão existe para responder "que
// libs este app está carregando?" num relato de bug. Uma resposta errada é pior que nenhuma,
// porque manda quem investiga para o lugar errado com confiança.
//
// Este arquivo já amarrou três pontas: package.json → shim → `.vssh-lib-version` da cópia
// vendorizada. A terceira morreu na v4 junto com o `vssh-app-lib-sync` — e morreu por ter
// falhado: o ref default do script ficou preso na `v3`, dois apps sincronizaram libs 3.0.0 contra
// um toolkit 4.0.0, e a conta só apareceu no CI. Hoje quem responde "que versão é esta?" é o npm,
// pelo `package-lock.json` do app. O que sobra aqui é o par que ainda não tem dono automático:
// package.json → shim.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

/** O `npm` desta máquina. No Windows ele é um `.cmd`, que `execFileSync` não executa sem shell. */
function npmDoSistema() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const ROOT = path.resolve(__dirname, '..');
const { vsshCarregado } = require('../lib/web/test/_superficie.js');

test('a versão que o shim ENTREGA é o version do package.json', () => {
  // Lida do `vssh` carregado, e não recortada do fonte: o literal pode existir com o nome certo e
  // não chegar ao app (um segundo `LIB_VERSION` mais abaixo, um `capabilities()` que devolve outra
  // coisa), e é o que chega ao app que responde "que libs este aqui está carregando?".
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const entregue = vsshCarregado().libVersion;
  assert.ok(entregue, 'o `vssh` carregado não publica `libVersion`');
  assert.equal(entregue, pkg.version,
    `o shim entrega ${entregue} e o package.json diz ${pkg.version} — bumpe os dois`);
});

// ── O pacote npm ──────────────────────────────────────────────────────────────
//
// Um app instala este repositório como dependência (`npm i github:colabhd/vssh-app-toolkit#v4`) e
// importa por subcaminho (`require('vssh-app-toolkit/listen')`). Duas coisas podem apodrecer sem
// dar sinal aqui dentro, e as duas quebram o app do OUTRO lado, longe da causa:
//
//   1. um `exports` apontando para arquivo que não existe mais — o app recebe
//      ERR_PACKAGE_PATH_NOT_EXPORTED, que não parece com "faltou mover uma linha";
//   2. um `files` que deixa de fora uma pasta que o `exports` alcança — funciona no clone,
//      funciona no CI, e falha só no app instalado. É o pior dos dois.

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('todo subcaminho de exports existe em disco', () => {
  const faltando = [];
  for (const [sub, alvo] of Object.entries(PKG.exports)) {
    if (sub.includes('*')) {
      // `./web/*` → o diretório tem de existir; o arquivo é escolha de quem importa.
      const dir = path.join(ROOT, path.dirname(alvo.replace('*', 'x')));
      if (!fs.existsSync(dir)) faltando.push(`${sub} → ${dir}`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, alvo))) faltando.push(`${sub} → ${alvo}`);
  }
  assert.deepStrictEqual(faltando, [], `exports aponta para o que não existe:\n  ${faltando.join('\n  ')}`);
});

test('o `files` do pacote cobre tudo que o `exports` alcança', () => {
  // Sem isto, `npm i` entrega um pacote em que o require morre — e no clone tudo passa.
  const incluidas = new Set(PKG.files);
  const fora = [];
  for (const alvo of Object.values(PKG.exports)) {
    const raiz = alvo.replace(/^\.\//, '').split('/')[0];
    if (raiz === 'package.json') continue;      // o npm sempre empacota o package.json
    if (!incluidas.has(raiz)) fora.push(`${alvo} (a lista files não tem '${raiz}')`);
  }
  assert.deepStrictEqual(fora, [], `o pacote publicado não levaria:\n  ${fora.join('\n  ')}`);
});

test('o que o `files` NÃO leva é deliberado, e o pacote fica pequeno', () => {
  // A medida que decidiu a lista: sem `files`, o npm empacota a árvore inteira — 1,9 MB por app
  // instalado, contra ~490 KB. Se alguém acrescentar `docs` ou `templates` aqui sem querer, o
  // custo volta calado.
  for (const pesada of ['docs', 'templates', 'examples', 'tests', '.github']) {
    assert.ok(!PKG.files.includes(pesada),
      `'${pesada}' entrou no files — é ~1,4 MB de coisa que app nenhum importa`);
  }
});

// ── O pacote Python ───────────────────────────────────────────────────────────
//
// Um segundo empacotamento do MESMO repositório, e portanto um segundo lugar onde o número pode
// ficar para trás. É exatamente o defeito que o `.vssh-lib-version` cometeu na era da cópia: um
// mecanismo de versão com uma versão própria para esquecer.
//
// A pergunta "que libs este app carrega?" tem de ter UMA resposta, e não uma por runtime — senão
// um relato de bug de um app Python manda quem investiga para a versão errada, com confiança.

test('a versão do pyproject é a mesma do package.json', () => {
  const pyproject = fs.readFileSync(path.join(ROOT, 'pyproject.toml'), 'utf8');
  const m = /^version = "([^"]+)"/m.exec(pyproject);
  assert.ok(m, 'não achei o `version` no pyproject.toml');
  assert.equal(m[1], PKG.version,
    `o pyproject declara ${m[1]} e o package.json diz ${PKG.version} — bumpe os dois`);
});

test('a bancada de lib/web/ não viaja no pacote npm', () => {
  // 147 KB de `node --test` — mais que as próprias libs de navegador (156 KB) — no disco de todo
  // app instalado, para rodar num lugar onde ninguém roda teste. Entrava por `files: ["lib"]`.
  //
  // Medido pelo PACOTE, e não pela declaração que deveria produzi-lo: `npm pack --dry-run` devolve
  // a lista real de arquivos, com as regras do npm aplicadas — inclusive as que não estão no
  // `files` (o `.npmignore`, os defaults). Uma asserção sobre a linha `'!lib/web/test'` ficava
  // verde com a linha presente e sem efeito, que é o único caso interessante.
  const saida = execFileSync(npmDoSistema(), ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const empacotados = JSON.parse(saida)[0].files.map((f) => f.path.replace(/\\/g, '/'));

  assert.ok(empacotados.length >= 10,
    `só ${empacotados.length} arquivos no pacote — o \`npm pack\` mudou de formato e isto virou decoração`);

  const bancada = empacotados.filter((p) => p.startsWith('lib/web/test/'));
  assert.deepEqual(bancada, [],
    'a bancada voltou ao pacote npm: são 147 KB no node_modules de todo app, sem consumidor');

  // O lado positivo da mesma pergunta: o que o `exports` promete tem de estar DENTRO do pacote.
  // Sem isto, cortar demais no `files` passaria despercebido até o primeiro `require` de um app.
  const faltando = Object.values(PKG.exports)
    .filter((alvo) => !alvo.includes('*'))
    .map((alvo) => alvo.replace(/^\.\//, ''))
    .filter((alvo) => !empacotados.includes(alvo));
  assert.deepEqual(faltando, [],
    'o `exports` aponta para arquivos que o pacote npm não leva: funciona no clone, funciona no '
    + 'CI, e o app instalado recebe ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('toda entrada da raiz de lib/web/ chega ao pacote Python', () => {
  // As libs de navegador são os mesmos arquivos para os dois runtimes, e no Python elas viajam
  // DENTRO do wheel (o `force-include` do pyproject). Um arquivo que não entre é uma lib que existe
  // para um runtime e não para o outro — e a falha aparece como um `vssh` incompleto ou um app sem
  // estilo num servidor, sem nada apontando para um arquivo de empacotamento.
  //
  // ⚠ Este teste conferia uma lista arquivo a arquivo, e fazia isso lendo `lib/web/` **sem
  // recursão** e filtrando `.js`/`.d.ts`. Quando `lib/web/tuff/` chegou — CSS, fonte, licença —,
  // nada dali seria embarcado e este teste continuaria **verde**: ele não enxergava subdiretório
  // nem outra extensão. Uma guarda que fica verde sobre o defeito que ela existe para pegar é pior
  // que guarda nenhuma, porque some a pergunta.
  //
  // A pergunta certa não é "todo ARQUIVO está listado?" — era essa, e ela não enxergava
  // subdiretório. É "toda ENTRADA da raiz está mapeada?": um diretório mapeado cobre o que houver
  // dentro dele para sempre, e uma entrada nova na raiz reprova até ser decidida.
  const pyproject = fs.readFileSync(path.join(ROOT, 'pyproject.toml'), 'utf8');
  const bloco = pyproject.split('[tool.hatch.build.targets.wheel.force-include]')[1] || '';
  const mapeados = new Set([...bloco.matchAll(/^"lib\/web\/([^"/]+)"/gm)].map((x) => x[1]));

  const naRaiz = fs.readdirSync(path.join(ROOT, 'lib', 'web'))
    .filter((nome) => nome !== 'test');

  const faltando = naRaiz.filter((nome) => !mapeados.has(nome));
  assert.deepEqual(faltando, [],
    'estas entradas de lib/web/ não entram no pacote Python: um app Python que as pedisse receberia '
    + '404 na tag injetada, e o sintoma seria um `vssh` incompleto ou uma janela sem estilo — nada '
    + 'que aponte para um arquivo de empacotamento');

  const sobrando = [...mapeados].filter((nome) => !naRaiz.includes(nome));
  assert.deepEqual(sobrando, [],
    'o pyproject embarca entradas que não existem mais em lib/web/ — o build falha, ou entrega '
    + 'menos do que declara');
});

test('SHIMS não carrega estilo, senão todo app publicado é reestilizado sem pedir', () => {
  // A armadilha mora no idioma: TODO app faz `injectScripts: SHIMS.map((s) => `_vssh/${s}`)`. Um
  // `.css` ou um `tuff.js` acrescentado a `SHIMS` entraria na página do recoll, do logseq e do
  // scramjet-wisp no próximo `npm i` — apps com identidade visual própria, um deles servindo
  // conteúdo de terceiros. Ninguém teria pedido, e a mudança chegaria por uma lista cujo nome fala
  // de outra coisa.
  //
  // Os estilos têm lista própria, e adotá-los é ato explícito do backend do app.
  const { SHIMS } = require('../lib/node/web-assets');
  const naoJs = SHIMS.filter((s) => !s.endsWith('.js'));
  assert.deepEqual(naoJs, [],
    'SHIMS ganhou algo que não é `.js`: ele é a lista que todo app injeta sem pensar');

  const doTuff = SHIMS.filter((s) => s.includes('tuff/'));
  assert.deepEqual(doTuff, [],
    'SHIMS ganhou uma peça da biblioteca de UI: a adoção da UI é escolha do app, não consequência '
    + 'de atualizar o toolkit');
});

test('os dois runtimes listam as MESMAS libs de navegador', () => {
  // `SHIMS` e `ESTILOS` existem duas vezes — em `lib/node/web-assets.js` e em
  // `lib/python/vssh_app_toolkit/web.py` — porque são dois pacotes que se instalam separados. É a
  // mesma forma do MIME de arraste que o shim narra, e o mesmo modo de falha: uma lista que ganha
  // um arquivo e a outra não produz um app Python sem estilo (ou sem `vssh`) enquanto o Node vai
  // bem, e nada liga um sintoma ao outro.
  //
  // Lido por texto, e não importando o módulo Python: a ausência de `python3` não pode reprovar
  // quem só mexeu em JavaScript — é a régua que o `//test:py` do package.json já estabelece.
  const py = fs.readFileSync(
    path.join(ROOT, 'lib', 'python', 'vssh_app_toolkit', 'web.py'), 'utf8');
  const listaPy = (nome) => {
    const m = new RegExp(`^${nome} = \\[([^\\]]*)\\]`, 'm').exec(py);
    assert.ok(m, `não achei '${nome}' em web.py — o teste ficou obsoleto ou a lista sumiu`);
    return m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  };

  const doNode = require('../lib/node/web-assets');
  for (const nome of ['SHIMS', 'ESTILOS', 'SCRIPTS', 'ESTILOS_MIDIA', 'SCRIPTS_MIDIA']) {
    assert.deepEqual(listaPy(nome), doNode[nome],
      `${nome} divergiu entre os runtimes: um app de um dos dois carrega peças que o outro não, e `
      + 'o sintoma aparece só naquele servidor');
  }

  // Toda peça listada existe em disco. Uma entrada com o caminho errado vira 404 na tag injetada, e
  // o navegador não diz nada — a página carrega, a folha não, e o app fica sem estilo.
  const ausentes = [...doNode.ESTILOS, ...doNode.SCRIPTS,
                    ...doNode.ESTILOS_MIDIA, ...doNode.SCRIPTS_MIDIA]
    .filter((f) => !fs.existsSync(path.join(doNode.WEB_DIR, f)));
  assert.deepEqual(ausentes, [],
    'estas peças são declaradas e não existem em lib/web/: a tag injetada vira 404 silencioso');
});
