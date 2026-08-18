'use strict';

// Os dois templates são O MESMO APP, em dois runtimes.
//
// ─── Por que isto precisa de um teste ────────────────────────────────────────
//
// "Equivalente" é uma promessa, e promessa envelhece sozinha. O caso concreto: o template Python
// ficou congelado na v2 enquanto o Node andou até a 4.12 — ele lia `VSSH_APP_PORT`, variável que a
// v4 aposentou, e **não subia num servidor atual**. Ninguém percebeu porque nada media a distância
// entre os dois; cada bump mexia num só, e o outro continuava verde porque não havia o que ficar
// vermelho.
//
// A distância entre eles agora tem um número, e ele é zero: mesmas peças, mesmas rotas, e o
// comportamento do frontend byte a byte. Uma peça nova num lado reprova até existir no outro.
//
// ─── O que NÃO é exigido igual ───────────────────────────────────────────────
//
// O backend, obviamente — são linguagens diferentes, e é esse o ponto de haver dois templates. E o
// nome do runtime na marcação: os dois apps podem estar instalados no MESMO servidor, lado a lado,
// e duas janelas indistinguíveis na tela seriam uma pegadinha, não uma virtude.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const NODE = path.join(TEMPLATES, 'hello-vssh-app-node');
const PY = path.join(TEMPLATES, 'hello-vssh-app');

// `\r\n` → `\n`: um checkout Windows (`core.autocrlf=true`) traz CRLF, e a comparação byte a byte
// acusaria uma diferença que não existe no repositório.
const ler = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * Todo id da marcação, seja qual for a tag.
 *
 * ⚠ Isto pedia uma TAG, e o teste percorria uma lista fixa (`section`, `button`, `pre`, `div`, `a`,
 * `code`). Um id em qualquer outra — `input`, `select`, `label`, `video`, `canvas` — não era
 * comparado entre os dois templates, então uma peça podia existir num e faltar no outro **sem
 * reprovar nada**: exatamente a deriva que este arquivo existe para impedir. A lista também
 * obrigava a lembrar de crescê-la a cada tipo de peça nova, e esquecer não dava sinal.
 */
const idsDe = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '')
  .matchAll(/<[a-z][\w-]*\b[^>]*\sid="([^"]+)"/gi)].map((m) => m[1]).sort();

test('o comportamento do frontend é o MESMO ARQUIVO', () => {
  // Byte a byte, e não "equivalente": `galeria.js` é código de NAVEGADOR, e o navegador é o mesmo
  // nos dois casos. Duas cópias que pudessem divergir seriam duas galerias medindo coisas
  // diferentes — e a que ficasse para trás mentiria sobre o ambiente sem nada acusar.
  //
  // A consequência prática, para quem for editar: nada aqui dentro pode citar o runtime. Um
  // `npm ci` ou um `backend/server.js` no texto de erro seria instrução errada para metade dos
  // leitores, e é por isso que aquelas menções foram trocadas por descrições neutras.
  const a = ler(path.join(NODE, 'frontend', 'galeria.js'));
  const b = ler(path.join(PY, 'frontend', 'galeria.js'));
  assert.equal(b, a,
    'as duas galerias divergiram: `galeria.js` tem de ser o mesmo arquivo nos dois templates');
  assert.doesNotMatch(a, /npm ci|npm i |node_modules|backend\/server\.js|backend\/main\.py/,
    'a galeria compartilhada cita um runtime específico: metade de quem ler vai seguir uma '
    + 'instrução que não vale para o app dela');
});

test('a contribuição a Configurações é o MESMO ARQUIVO', () => {
  // `configuracoes.js` roda na origem do SHELL, e não no app: ele não sabe (nem pode saber) em que
  // linguagem o backend foi escrito.
  assert.equal(ler(path.join(PY, 'configuracoes.js')), ler(path.join(NODE, 'configuracoes.js')));
});

test('a marcação tem as MESMAS peças, e só o nome do runtime difere', () => {
  const a = ler(path.join(NODE, 'frontend', 'index.html'));
  const b = ler(path.join(PY, 'frontend', 'index.html'));

  assert.deepEqual(idsDe(b), idsDe(a),
    'os elementos identificados divergiram entre os templates: uma peça existe num e não no outro');

  // A ÚNICA diferença tolerada. Normalizando o nome do runtime, os dois arquivos têm de casar —
  // uma frase explicativa a mais num deles é exatamente o tipo de deriva que este teste impede.
  const normal = (s) => s.replace(/\(Node\)|\(Python\)/g, '(RUNTIME)');
  assert.equal(normal(b), normal(a),
    'a marcação divergiu além do nome do runtime — o texto de uma peça mudou só de um lado');
});

test('os dois backends atendem exatamente as mesmas rotas', () => {
  // O frontend é o mesmo arquivo, então uma rota que exista só de um lado vira um botão que
  // responde 404 — e a peça pareceria quebrada NAQUELE servidor, que é a conclusão errada mais
  // cara que uma galeria pode induzir.
  const rotasDe = (fonte) =>
    [...fonte.matchAll(/['"](\/(?:healthz|api\/[a-z0-9/-]*))['"]/g)].map((m) => m[1]);

  const node = new Set(rotasDe(ler(path.join(NODE, 'backend', 'server.js'))));
  const py = new Set(rotasDe(ler(path.join(PY, 'backend', 'main.py'))));

  assert.ok(node.size >= 10, `só ${node.size} rotas no backend Node — o teste ficou obsoleto`);
  assert.deepEqual([...py].sort(), [...node].sort(),
    'os backends divergiram: uma rota existe num template e não no outro');
});

test('os manifestos declaram as mesmas capacidades', () => {
  const a = JSON.parse(ler(path.join(NODE, 'vssh-app.json')));
  const b = JSON.parse(ler(path.join(PY, 'vssh-app.json')));

  // O que o AMBIENTE decide por um app: se um declarasse `gpu` e o outro não, a mesma peça daria
  // respostas diferentes nos dois — e a diferença pareceria do servidor, não do manifesto.
  for (const campo of ['gpu', 'resources', 'secrets', 'opens', 'handles', 'minShellVersion']) {
    assert.deepEqual(b[campo], a[campo], `os manifestos divergem em '${campo}'`);
  }
  assert.deepEqual(b.contributes?.contextMenu, a.contributes?.contextMenu,
    'a jump list difere entre os templates');
  assert.equal(b.contributes?.settings, a.contributes?.settings);
  assert.equal(b.backend?.healthcheckPath, a.backend?.healthcheckPath);
  assert.equal(b.backend?.aoFechar, a.backend?.aoFechar);
  assert.equal(b.backend?.transport, a.backend?.transport);

  // `ffmpeg` é do benchmark e vale para os dois. O que só um deles precisa é o gerenciador de
  // pacotes do próprio runtime — e ele TEM de estar declarado, senão o instalador deixa passar um
  // servidor onde o `installCommand` falha e o app não sobe para aquele usuário.
  assert.ok(a.requiredPackages.includes('ffmpeg') && b.requiredPackages.includes('ffmpeg'));
  assert.ok(b.requiredPackages.includes('python3-pip'),
    'o template Python instala as libs com pip e não o declara: o servidor sem pip só descobre '
    + 'isso quando o primeiro usuário abre o app');

  // Ids distintos, de propósito: os dois podem estar instalados no MESMO servidor — é assim que se
  // compara um runtime com o outro com as mãos.
  assert.notEqual(b.id, a.id);
});

// As duas afirmações sobre o backend Python — que ele não lê `VSSH_APP_PORT`, e que quem abre o
// endereço é o `criar_servidor()` do toolkit — são medidas EXECUTANDO, em
// `tests/python/test_template.py`:
//
//   - o `carregar_backend()` de lá importa o `main.py` com o ambiente ZERADO (`clear=True`), então
//     uma leitura de `VSSH_APP_PORT` levanta `KeyError` e derruba o arquivo inteiro;
//   - `OEnderecoVemDoToolkit` troca o `criar_servidor` dentro do módulo do toolkit e chama o
//     `main()`: um servidor montado à mão não passa pelo dublê.
//
// Havia aqui um `doesNotMatch` e um `match` sobre o texto do `main.py` dizendo as mesmas duas
// coisas. Eles ficavam verdes com o defeito presente escrito de outro jeito (`os.getenv`,
// `environ.get`, o import com apelido) e vermelhos numa reescrita que preservava o comportamento.
