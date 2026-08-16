'use strict';

// O `.d.ts` declara exatamente a superfície que o shim expõe — nem mais, nem menos.
//
// Um arquivo de tipos que envelhece é PIOR que nenhum, e a razão é específica: ele mente para o
// compilador e para o editor ao mesmo tempo, com a autoridade de quem parece ter sido verificado.
// Nas duas direções o estrago é real e silencioso:
//
//   membro que existe e não está declarado  → o app escreve `vssh.print(…)` e o TypeScript recusa
//                                             compilar algo que funcionaria. A pessoa conclui que
//                                             a API não existe e escreve um contorno.
//   membro declarado que não existe          → o editor autocompleta, o build passa, e quebra em
//                                             produção com `undefined is not a function`.
//
// Por isso a conferência é de junção e é dupla: a superfície REAL é enumerada em runtime (não
// lida por regex do JavaScript, que erraria), e o `.d.ts` é lido do arquivo. Um teste que só
// olhasse um dos lados aprovaria os dois estados acima.
//
// O `.d.ts` é conferido pela estrutura, não por compilação: o toolkit não tem dependência npm, e
// trazer o `typescript` só para isto custaria mais do que ele mede. O que uma compilação pegaria a
// mais são os TIPOS dos argumentos; o que quebra na prática, e o que este teste pega, é membro
// faltando ou sobrando.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// A enumeração em runtime mora em `_superficie.js` desde que `tests/galeria-cobertura.test.js`
// passou a precisar da mesma resposta. Duas cópias divergem, e a que divergisse ficaria verde
// sobre uma superfície que não existe mais.
const { superficieReal } = require('./_superficie.js');

const WEB = path.join(__dirname, '..');

// ── O que o `.d.ts` declara ──────────────────────────────────────────────────

const DTS = fs.readFileSync(path.join(WEB, 'vssh-app-shim.d.ts'), 'utf8');

/** Corpo de `interface Nome { … }`, respeitando chaves aninhadas nos tipos. */
function corpoDaInterface(nome) {
  const abre = DTS.indexOf(`interface ${nome} {`);
  if (abre < 0) return null;
  let i = DTS.indexOf('{', abre);
  let profundidade = 0;
  for (let j = i; j < DTS.length; j++) {
    if (DTS[j] === '{') profundidade++;
    else if (DTS[j] === '}') {
      profundidade--;
      if (profundidade === 0) return DTS.slice(i + 1, j);
    }
  }
  return null;
}

/**
 * Membros declarados numa interface, e o tipo de cada um quando ele é um nome simples.
 *
 * A varredura é por PROFUNDIDADE: só linhas no nível de topo do corpo contam. Sem isso, os campos
 * de um tipo inline (`{ dot: true }`) entrariam como se fossem membros da interface.
 */
function membros(nome) {
  const corpo = corpoDaInterface(nome);
  if (corpo === null) return null;

  const saida = new Map();
  let profundidade = 0;
  for (const linhaBruta of corpo.split('\n')) {
    const linha = linhaBruta.trim();
    const antes = profundidade;
    for (const c of linha) {
      if (c === '{' || c === '(') profundidade++;
      else if (c === '}' || c === ')') profundidade--;
    }
    if (antes !== 0) continue;                          // dentro de um tipo inline
    if (!linha || linha.startsWith('//') || linha.startsWith('*') || linha.startsWith('/*')) continue;
    if (linha.startsWith('[')) continue;                // assinatura de índice: não é membro nomeado

    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*([(:])\s*(.*)$/.exec(linha);
    if (!m) continue;
    const [, campo, sinal, resto] = m;
    // `nome: OutroTipo;` é o que permite descer; método e tipo inline não descem.
    const tipo = sinal === ':' ? (/^([A-Za-z_$][\w$]*)\s*;/.exec(resto)?.[1] ?? null) : null;
    saida.set(campo, tipo);
  }
  return saida;
}

// ── A conferência ────────────────────────────────────────────────────────────

test('o .d.ts declara a raiz `vssh` inteira, e só ela', () => {
  const real = superficieReal();
  const declarado = membros('Vssh');
  assert.ok(declarado, 'não achei `interface Vssh` no .d.ts');

  const faltando = Object.keys(real).filter((k) => !declarado.has(k)).sort();
  const sobrando = [...declarado.keys()].filter((k) => !(k in real)).sort();

  assert.deepEqual(faltando, [],
    'o shim expõe isto e o .d.ts não declara — o TypeScript vai recusar código que funciona');
  assert.deepEqual(sobrando, [],
    'o .d.ts declara isto e o shim não expõe — o editor autocompleta algo que quebra em produção');
});

test('cada objeto aninhado do shim tem interface própria, com os mesmos membros', () => {
  const real = superficieReal();
  const raiz = membros('Vssh');
  const aninhados = Object.entries(real).filter(([, filhos]) => filhos !== null);

  // Se um dia não houver nenhum, este teste virou decoração e passaria vazio para sempre.
  assert.ok(aninhados.length >= 6, `só ${aninhados.length} objetos aninhados — a superfície mudou de forma`);

  for (const [nome, filhosReais] of aninhados) {
    const tipo = raiz.get(nome);
    assert.ok(tipo, `\`vssh.${nome}\` é um objeto, e o .d.ts o declara sem um tipo nomeado`);

    const filhosDeclarados = membros(tipo);
    assert.ok(filhosDeclarados, `o .d.ts cita o tipo \`${tipo}\` para \`vssh.${nome}\` e não o define`);

    assert.deepEqual(
      filhosReais.filter((k) => !filhosDeclarados.has(k)), [],
      `\`vssh.${nome}\` expõe membros que \`${tipo}\` não declara`);
    assert.deepEqual(
      [...filhosDeclarados.keys()].filter((k) => !filhosReais.includes(k)), [],
      `\`${tipo}\` declara membros que \`vssh.${nome}\` não tem`);
  }
});

test('o .d.ts é global, não um módulo — o shim entra por tag <script>', () => {
  // Um `export` ou `import` de topo transformaria o arquivo em módulo, e aí NADA dele seria
  // visível globalmente: o app carrega o shim por `<script>` e usa `vssh` cru. O sintoma seria
  // "os tipos não funcionam", sem nada apontando para cá.
  const semComentarios = DTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(semComentarios, /^\s*(export|import)\s/m,
    'declaração de módulo: os tipos deixariam de ser globais');
  assert.match(semComentarios, /declare const vssh: Vssh;/,
    'sem o global `vssh`, só `window.vssh` teria tipo');
  assert.match(semComentarios, /interface Window\s*\{[^}]*vssh: Vssh/,
    'sem aumentar `Window`, `window.vssh` fica sem tipo');
});

// ── O que chega em `open-context` ────────────────────────────────────────────
//
// `VsshContextoDeAbertura` é o único tipo do `.d.ts` que descreve DADO vindo do shell, e não a
// superfície que o shim expõe. Por isso a enumeração em runtime dos testes acima não o alcança:
// não existe objeto para enumerar, a mensagem só passa a existir quando o ambiente manda uma.
//
// O outro lugar onde esse contrato está escrito é a documentação — então é contra ela que dá para
// conferir. Isso exige que a `api.md` diga os campos numa TABELA e não em prosa, o que é bom por si:
// prosa descreve, tabela enumera, e só o que é enumerado pode ser conferido.
//
// ⚠ Os dois divergiam quando esta rede foi montada, e é o defeito que ela existe para pegar: a
// `api.md` documentava `tipo` e `rota`, o `.d.ts` declarava só `path`. Quem escrevesse
// `ctx.tipo === 'pasta'` em TypeScript — seguindo a documentação — recebia erro de compilação por
// um campo que chega de verdade.

const API_MD = fs.readFileSync(path.join(WEB, '..', '..', 'docs', 'api.md'), 'utf8');

/** Os nomes em crase da primeira coluna da tabela que vem logo depois de `cabecalho`. */
function camposDaTabela(cabecalho) {
  const i = API_MD.indexOf(cabecalho);
  assert.ok(i >= 0, `não achei "${cabecalho}" em docs/api.md`);

  const campos = [];
  let dentro = false;
  for (const bruta of API_MD.slice(i + cabecalho.length).split('\n')) {
    const linha = bruta.trim();
    if (!linha.startsWith('|')) {
      if (dentro) break;                      // a tabela acabou
      continue;                               // ainda não começou
    }
    dentro = true;
    // A linha de cabeçalho (`campo`) e a de separação (`---`) não têm crase, e caem fora sozinhas.
    const m = /^`([A-Za-z_$][\w$]*)`$/.exec(linha.split('|')[1].trim());
    if (m) campos.push(m[1]);
  }
  return campos;
}

test('o .d.ts e a api.md concordam sobre o que chega em `open-context`', () => {
  const documentados = camposDaTabela('#### O que chega em `open-context`');
  assert.ok(documentados.length >= 3,
    `só ${documentados.length} campo(s) na tabela — ela mudou de forma e este teste virou decoração`);

  const declarados = membros('VsshContextoDeAbertura');
  assert.ok(declarados, 'não achei `interface VsshContextoDeAbertura` no .d.ts');

  // `type` é o discriminador da mensagem, não um campo de conteúdo — por isso não entra na tabela.
  const conteudo = [...declarados.keys()].filter((k) => k !== 'type');

  assert.deepEqual(documentados.filter((k) => !declarados.has(k)), [],
    'a api.md promete campos que o .d.ts não declara — quem seguir a documentação em TypeScript '
    + 'recebe erro de compilação por um campo que o ambiente manda de verdade');
  assert.deepEqual(conteudo.filter((k) => !documentados.includes(k)), [],
    'o .d.ts declara campos que a api.md não documenta — o editor autocompleta um campo sobre o '
    + 'qual ninguém escreveu de onde vem nem quando chega');
});

test('o package.json aponta os tipos, senão ninguém os acha', () => {
  // Vendorizado, o `.d.ts` é achado por estar ao lado do `.js` — mas quem consumir o toolkit como
  // pacote depende deste campo. Declarar o caminho errado é o mesmo que não declarar.
  const pkg = JSON.parse(fs.readFileSync(path.join(WEB, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.types, 'package.json sem `types`');
  assert.ok(fs.existsSync(path.join(WEB, '..', '..', pkg.types)),
    `package.json aponta types: "${pkg.types}", que não existe`);
});
