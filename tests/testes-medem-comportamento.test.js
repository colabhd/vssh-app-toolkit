'use strict';

// ⚠ ISTO É UMA REGRA DE LINT, e não um teste.
//
// Ela não prova comportamento nenhum: varre os arquivos de teste procurando uma FORMA proibida. O
// lugar certo dela seria a configuração do ESLint — este repositório não tem ferramenta de lint, e
// não vai ter, porque "nenhuma dependência" é regra (ver CLAUDE.md). Hospedá-la na suíte é o
// compromisso, e ele está declarado aqui em vez de disfarçado.
//
// ─── O que ela impede ────────────────────────────────────────────────────────
//
// Teste que lê o fonte como TEXTO e afirma sobre ele:
//
//     assert.match(fonte, /requestAnimationFrame/);
//     assert.ok(css.includes('.minha-classe'));
//
// A doutrina inteira, com o critério de junção × guarda e a saída permitida ("não escrever teste é
// um resultado permitido"), está em `docs/testes.md`. O que este arquivo acrescenta é a única coisa
// que a prosa não consegue: **fechar a lista de exceções.**
//
// Sem ele, `docs/testes.md` seria mais um documento pedindo bom senso — e o defeito que ele existe
// para impedir é exatamente o do bom senso auto-aplicado: *"a exceção é quando não há execução
// possível"*, e quem não consegue executar sempre acha que é o seu caso.
//
// ─── Por que a lista mora aqui, e não numa varredura esperta ─────────────────
//
// Porque o detector é heurístico e sempre será: ele não sabe se `saida` veio de um `readFileSync`
// ou de um `execFileSync`. Um detector que tentasse decidir isso sozinho erraria, e o conserto de
// quem tem pressa seria afrouxar o detector — não o teste acusado. Com uma lista, o conserto de
// quem tem pressa é acrescentar uma linha AQUI, que é visível no diff e tem de ser explicada.
//
// ⚠ **Acrescentar um arquivo à lista é decisão de quem mantém o repositório, em PR SEPARADO da
// mudança que a motivou.** Junto, o revisor é perguntado sobre duas coisas ao mesmo tempo, e a que
// ele veio olhar é a outra.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

/**
 * Os arquivos que PODEM afirmar sobre texto de fonte, e a junção que cada um mede.
 *
 * Cada entrada responde à mesma pergunta — *que dois lados precisam concordar sobre um nome sem
 * nunca se encontrarem em runtime?* Uma entrada que não saiba responder isso não pertence aqui.
 */
const PODEM_LER_FONTE = new Map([
  ['tests/docs-links.test.js', 'todo link e âncora de .md ↔ o arquivo e o cabeçalho que existem'],
  ['tests/docs-e-codigo.test.js', 'o que a documentação promete ↔ o que o schema e o shim entregam'],
  ['tests/galeria-cobertura.test.js', 'a superfície do vssh em runtime ↔ as peças da galeria'],
  ['tests/galeria-paridade.test.js', 'as duas galerias, byte a byte ↔ os dois manifestos'],
  ['tests/template-galeria.test.js', 'a marcação ↔ o comportamento ↔ as rotas do template'],
  ['tests/app-contra-a-tag.test.js', 'o que os exemplos usam ↔ a lib na ref que eles fixam'],
  ['tests/tuff-icones.test.js', 'os <symbol> declarados ↔ os #ico-… citados'],
  ['tests/tuff-vocabulario.test.js', 'as classes e ganchos da biblioteca ↔ o catálogo'],
  ['tests/tuff-fidelidade.test.js', 'o valor final dos tokens ↔ os do shell'],
  ['tests/lib-version.test.js', 'as entradas de lib/web/ ↔ o force-include do pyproject.toml'],
  ['tests/workflows.test.js', 'os .yml ↔ os bytes que o YAML aceita'],
  ['lib/web/test/tipos.test.js', 'o .d.ts ↔ a superfície real ↔ a tabela da api.md'],
]);

/** Os arquivos de teste da árvore, em caminho relativo com barra normal. */
function arquivosDeTeste(dir, fora = []) {
  for (const nome of fs.readdirSync(dir)) {
    if (nome === 'node_modules' || nome === '.git' || nome === '.venv') continue;
    const p = path.join(dir, nome);
    if (fs.statSync(p).isDirectory()) arquivosDeTeste(p, fora);
    else if (nome.endsWith('.test.js')) fora.push(path.relative(RAIZ, p).replace(/\\/g, '/'));
  }
  return fora;
}

const LEITOR = /\breadFileSync\s*\(/;

// O que DESQUALIFICA um inicializador, e cada um sai da lista de falsos positivos de `docs/testes.md`:
//
//   JSON.parse(...)      → JSON parseado é DADO de configuração, não texto de fonte
//   execFileSync e cia.  → saída de comando é valor de runtime
//   new Function / vm    → o arquivo foi lido para ser EXECUTADO; a asserção olha o resultado
const NAO_E_FONTE = /JSON\.parse|execFileSync|execSync|spawnSync|new Function|runInContext/;

/**
 * As asserções cujo SUJEITO é texto vindo de arquivo.
 *
 * A busca dos nomes é um ponto fixo: `const css = semComentarios(ler(caminho))` só é reconhecido
 * depois de `ler` já ser conhecido como leitor. Sem iterar, o helper de uma linha esconde o resto.
 */
function afirmacoesSobreFonte(src) {
  const linhas = src.split('\n');
  const nomes = new Set();

  const declaracoes = [];
  for (const l of linhas) {
    for (const m of l.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/g)) {
      declaracoes.push([m[1], m[2]]);
    }
    for (const m of l.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
      declaracoes.push([m[1], l]);
    }
  }

  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const [nome, ini] of declaracoes) {
      if (nomes.has(nome) || NAO_E_FONTE.test(ini)) continue;
      const viaLeitor = LEITOR.test(ini);
      const viaHelper = [...nomes].some((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(ini));
      if (viaLeitor || viaHelper) { nomes.add(nome); mudou = true; }
    }
  }
  if (!nomes.size) return [];

  const doNome = new RegExp(`\\b(?:${[...nomes].map((n) => n.replace(/\$/g, '\\$')).join('|')})\\b`);
  const achados = [];
  linhas.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;               // comentário não é asserção
    const m = /assert\.(?:match|doesNotMatch)\s*\(\s*([^,]+),/.exec(l)
           || /assert\.(?:ok|equal|strictEqual)\s*\(\s*([A-Za-z_$][\w$.[\]()'"`\- ]*)\.includes\s*\(/.exec(l);
    if (m && doNome.test(m[1]) && !NAO_E_FONTE.test(m[1])) {
      achados.push({ linha: i + 1, texto: l.trim().slice(0, 120) });
    }
  });
  return achados;
}

test('a lista de exceções não tem entrada morta', () => {
  // Uma exceção que perca o arquivo que a justificava vira autorização sem dono — e a próxima
  // guarda se esconde atrás dela.
  const ausentes = [...PODEM_LER_FONTE.keys()].filter((rel) => !fs.existsSync(path.join(RAIZ, rel)));
  assert.deepEqual(ausentes, [],
    'estes arquivos estão na lista de exceções e não existem mais — tire-os daqui e de docs/testes.md');
});

test('o detector ainda detecta — senão o teste abaixo passa medindo nada', () => {
  // O PISO. Uma regex que para de casar devolve vazio, e vazio passa em qualquer `deepEqual([], [])`:
  // verde, silencioso, medindo nada. Os arquivos da lista TÊM afirmações sobre fonte por desenho —
  // se o detector não achar nenhuma neles, é o detector que quebrou, não a base que ficou limpa.
  const comAchados = [...PODEM_LER_FONTE.keys()].filter((rel) => {
    try { return afirmacoesSobreFonte(fs.readFileSync(path.join(RAIZ, rel), 'utf8')).length > 0; }
    catch { return false; }
  });
  assert.ok(comAchados.length >= 3,
    `o detector achou afirmações sobre fonte em só ${comAchados.length} dos arquivos da lista — `
    + 'ele parou de enxergar a forma que existe para proibir');
});

test('nenhum teste fora da lista afirma sobre texto de fonte', () => {
  const infratores = [];
  for (const rel of arquivosDeTeste(path.join(RAIZ, 'tests')).concat(arquivosDeTeste(path.join(RAIZ, 'lib')))) {
    if (PODEM_LER_FONTE.has(rel)) continue;
    if (rel === path.relative(RAIZ, __filename).replace(/\\/g, '/')) continue;
    for (const a of afirmacoesSobreFonte(fs.readFileSync(path.join(RAIZ, rel), 'utf8'))) {
      infratores.push(`${rel}:${a.linha} → ${a.texto}`);
    }
  }
  assert.deepEqual(infratores, [],
    'estas asserções leem o fonte como TEXTO e afirmam sobre ele. Elas provam que uma linha existe, '
    + 'não que o comportamento acontece — verdes quando o defeito muda de casa, vermelhas numa '
    + 'refatoração que não quebrou nada.\n\n'
    + 'Ver docs/testes.md. Em ordem: (1) CONVERTA em execução, exigindo o VALOR e não a presença; '
    + '(2) APAGUE, se não der para executar, e diga no PR o que ficou sem cobertura; '
    + '(3) NÃO invente um teste novo para substituir o que apagou.\n\n'
    + 'Se este arquivo mede uma junção que só existe no texto, ele entra na lista de exceções — em '
    + 'PR SEPARADO desta mudança.');
});
