'use strict';

// A documentação promete o que o código entrega.
//
// ─── Por que este arquivo existe ─────────────────────────────────────────────
//
// Um doc errado não fica vermelho: fica MUDO. Ele não quebra build nenhum, não aparece em log
// nenhum, e leva quem lê à decisão errada com toda a autoridade de um documento — que é pior do que
// não existir. Os dois defeitos abaixo estavam vivos quando este arquivo foi escrito, e nenhum dos
// dois seria achado lendo:
//
//   - o README mandava chamar o reusable com `@v2` em dois lugares (o Quickstart e a seção de
//     migração — exatamente os dois de onde se COPIA) enquanto a seção de versionamento, o default
//     do próprio workflow e outros 26 pontos diziam `v4`. Quem seguisse o Quickstart publicaria
//     contra um schema de duas gerações atrás, com validação a menos, e não haveria sintoma;
//   - a `porting.md` afirmava que a jump list do ícone **não existe**, com os dois templates
//     declarando uma.
//
// ─── O que ele NÃO alcança ───────────────────────────────────────────────────
//
// Prosa. *"Isto não existe"* escrito sobre uma feature que existe é uma frase, não um nome — nenhuma
// junção a pega, e o que a pega é alguém conferir contra o código. Aqui ficam só as afirmações que
// têm FORMA: um nome de API, uma ref fixada.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const { caminhosDaSuperficie } = require('../lib/web/test/_superficie.js');

/** Todo arquivo de texto da árvore que pode conter uma promessa. */
function arquivos(dir, fora = []) {
  for (const nome of fs.readdirSync(dir)) {
    if (nome === 'node_modules' || nome === '.git' || nome === '.venv') continue;
    const p = path.join(dir, nome);
    if (fs.statSync(p).isDirectory()) arquivos(p, fora);
    else if (/\.(md|ya?ml|json)$/.test(nome)) fora.push(p);
  }
  return fora;
}

const TEXTOS = arquivos(RAIZ).concat([path.join(RAIZ, '.claude', 'skills', 'vssh-app', 'SKILL.md')]);
const rel = (p) => path.relative(RAIZ, p).replace(/\\/g, '/');

// ─── 1. A ref deste toolkit é a MESMA em todo lugar ──────────────────────────

test('todo lugar que fixa uma ref deste toolkit fixa a mesma', () => {
  // Um repo de app copia uma dessas linhas e vive com ela por meses. Duas gerações citadas na mesma
  // página não é inconsistência cosmética: metade de quem copiar publica com a validação de outra
  // era, e o `vssh-app-publish` de lá nem sabe que deveria reclamar.
  //
  // A única citação de uma geração FUTURA é deliberada, e está nomeada abaixo com o motivo: um
  // exemplo de como subir de geração precisa citar a próxima, senão ele não é exemplo de nada.
  const FUTURO_DELIBERADO = new Map([
    ['templates/hello-vssh-app-node/package.json',
     'o `//dependencies` ensina a subir de geração, e para isso precisa nomear a próxima'],
  ]);

  const PADROES = [
    /vssh-app-toolkit(?:\/[\w./-]*)?[@#]v(\d+)/g,
    /vssh-app-toolkit\/archive\/refs\/tags\/v(\d+)/g,
  ];

  const porGeracao = new Map();
  for (const p of TEXTOS) {
    const src = fs.readFileSync(p, 'utf8');
    for (const padrao of PADROES) {
      for (const m of src.matchAll(padrao)) {
        const onde = `${rel(p)}:${src.slice(0, m.index).split('\n').length}`;
        const g = `v${m[1]}`;
        if (!porGeracao.has(g)) porGeracao.set(g, []);
        porGeracao.get(g).push(onde);
      }
    }
  }

  assert.ok(porGeracao.size >= 1, 'nenhuma ref do toolkit achada — o padrão parou de casar');

  // A geração corrente é a do `package.json`, e não a mais citada: um erro copiado muitas vezes
  // ganharia a votação.
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const corrente = `v${pkg.version.split('.')[0]}`;
  assert.ok(porGeracao.has(corrente),
    `nenhum lugar fixa a geração corrente (${corrente}), que é a major do package.json`);

  const forasteiras = [];
  for (const [g, ondes] of porGeracao) {
    if (g === corrente) continue;
    for (const onde of ondes) {
      const arquivo = onde.split(':')[0];
      if (FUTURO_DELIBERADO.has(arquivo)) continue;
      forasteiras.push(`${onde} fixa ${g}, e a geração corrente é ${corrente}`);
    }
  }
  assert.deepEqual(forasteiras, [],
    'estes lugares fixam outra geração do toolkit. Quem copiar daqui publica contra um schema de '
    + 'outra era, com validação a menos, e nada avisa — o app publica e instala normalmente.');

  // A isenção some sozinha se o arquivo que a justificava sumir.
  const isencoesMortas = [...FUTURO_DELIBERADO.keys()]
    .filter((f) => !fs.existsSync(path.join(RAIZ, f)));
  assert.deepEqual(isencoesMortas, [],
    'isenção apontando para arquivo que não existe mais — vira autorização sem dono');
});

test('o default do reusable é a geração corrente', () => {
  // Quem não passa `tools_ref` recebe este valor, e é o caminho de todo repo de app que seguiu o
  // Quickstart. Ele não é citado em prosa em lugar nenhum, então o teste acima não o alcança.
  const wf = fs.readFileSync(
    path.join(RAIZ, '.github', 'workflows', '_publish-app-reusable.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const m = /tools_ref:[\s\S]*?default:\s*'v(\d+)'/.exec(wf);
  assert.ok(m, 'não achei o default de `tools_ref` no reusable');
  assert.equal(`v${m[1]}`, `v${pkg.version.split('.')[0]}`,
    'o reusable puxa uma geração e o toolkit é outra: quem não passa `tools_ref` publica com o '
    + 'script e o schema errados');
});

// ─── 2. Toda API citada na documentação existe ───────────────────────────────

/**
 * Os membros de `vssh` que o POLYFILL acrescenta — ele é o segundo contribuinte da superfície.
 *
 * Enumerados do arquivo porque não há como carregá-lo aqui sem montar um IndexedDB de mentira
 * inteiro (é o que `lib/web/test/fsa-polyfill.test.js` faz, com 90 linhas de ambiente). O que se
 * enumera é o conjunto de atribuições, e não um nome escrito à mão: acrescentar um membro ao
 * polyfill o traz para cá sozinho.
 */
function membrosDoPolyfill() {
  const src = fs.readFileSync(path.join(RAIZ, 'lib', 'web', 'fsa-polyfill.js'), 'utf8');
  return new Set([...src.matchAll(/^\s*(?:vssh\.)?fs\.([a-zA-Z]\w*)\s*=\s*(?:async\s*)?function/gm)]
    .map((m) => `fs.${m[1]}`));
}

test('todo `vssh.*` citado na documentação existe de verdade', () => {
  // Uma API documentada e inexistente é o pior tipo de erro de doc: quem segue a documentação
  // escreve a chamada, recebe `undefined is not a function`, e não tem como saber se o errado é o
  // doc, o shim ou o shell daquele servidor.
  const reais = new Set(caminhosDaSuperficie().map((x) => x.caminho));
  for (const m of membrosDoPolyfill()) reais.add(m);
  assert.ok(reais.size >= 50, `só ${reais.size} membros na superfície — a enumeração quebrou`);

  const fantasmas = [];
  for (const p of TEXTOS.filter((f) => f.endsWith('.md'))) {
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\bvssh\.([a-zA-Z]\w*(?:\.[a-zA-Z]\w*)?)\s*\(/g)) {
      const caminho = m[1];
      // `vssh.fs.list(` casa direto; `vssh.window.abrir(` também. Um membro de terceiro nível
      // (`vssh.tray.set.algo`) cairia aqui como `tray.set`, que existe — e está certo: o que se
      // mede é se o caminho citado começa numa API real.
      if (reais.has(caminho) || reais.has(caminho.split('.')[0])) continue;
      fantasmas.push(`${rel(p)} promete vssh.${caminho}()`);
    }
  }
  assert.deepEqual([...new Set(fantasmas)].sort(), [],
    'a documentação promete APIs que o `vssh` não tem. Quem seguir o doc recebe '
    + '`undefined is not a function`, e não tem como saber se o errado é o doc, o shim ou o shell.');
});

test('a superfície do polyfill é enumerável — senão o teste acima afrouxa sozinho', () => {
  // O PISO do lado do polyfill. Se a extração devolver vazio, o teste acima passa a exigir que todo
  // `vssh.fs.*` documentado esteja no SHIM — e `grantedHandles`, que é do polyfill, viraria
  // fantasma. Um piso aqui transforma "a regex quebrou" em vermelho, em vez de num falso alarme.
  const doPolyfill = membrosDoPolyfill();
  assert.ok(doPolyfill.size >= 1,
    'nenhum membro extraído do fsa-polyfill: a extração parou de casar, e o teste acima passou a '
    + 'medir uma superfície menor do que a real');
});
