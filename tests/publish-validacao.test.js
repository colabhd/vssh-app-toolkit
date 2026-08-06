'use strict';

// O que o `vssh-app-publish` recusa — medido rodando o validador de verdade.
//
// O bloco de validação do publish é Python embutido num heredoc, e por isso nunca teve teste: a
// suíte é Node. Extraí-lo e executá-lo com o `python3` que o próprio script exige custa vinte
// linhas, e o que ele guarda vale bem mais que isso.
//
// **`requiredPackages` não é um campo como os outros.** O valor dele chega a um gerenciador de
// pacotes rodando no servidor do usuário. Um nome com metacaractere de shell é injeção, e o gate
// de publicação é onde isso se recusa — depois já é tarde, e o portal teria de desconfiar de um
// manifesto que passou por aqui.
//
// Sem `python3` os testes se PULAM, pelo mesmo motivo do runner de navegador: falha por ausência
// de ambiente é ruído. O CI tem python3 (o publish não roda sem ele), e quem desenvolve, se não
// tiver, não fica com a suíte vermelha por isso.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'vssh-app-publish');
const SCHEMA = path.join(ROOT, 'schema', 'vssh-app.schema.json');

/** O primeiro `python3`/`python` que responde `--version`, ou `null`. */
function acharPython() {
  for (const exe of [process.env.VSSH_TEST_PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const v = execFileSync(exe, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/^Python 3\./.test(v.trim())) return exe;
    } catch { /* próximo */ }
  }
  return null;
}
const PY = acharPython();
const seNaoTem = { skip: PY ? false : 'sem python3 — defina VSSH_TEST_PYTHON para apontar um' };

/**
 * O bloco Python do publish, recortado do heredoc.
 *
 * O recorte é pelos delimitadores REAIS do heredoc, e não por um número de linha: um script que
 * cresce moveria as linhas, e o teste passaria a medir outro pedaço sem nada avisar.
 */
function validador() {
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\r/g, '');
  const linhas = src.split('\n');
  const inicio = linhas.findIndex((l) => l.includes("python3 <<'PYEOF'"));
  const fim = linhas.findIndex((l, i) => i > inicio && l === 'PYEOF');
  assert.ok(inicio > 0 && fim > inicio, 'não achei o heredoc do validador no vssh-app-publish');
  return linhas.slice(inicio + 1, fim).join('\n');
}

/** Roda o validador sobre um manifesto e devolve a saída (`ID=…` ou `ERROR=…`). */
function validar(manifesto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-pub-'));
  try {
    const py = path.join(dir, 'valida.py');
    const mf = path.join(dir, 'vssh-app.json');
    fs.writeFileSync(py, validador());
    fs.writeFileSync(mf, JSON.stringify(manifesto));
    return execFileSync(PY, [py], {
      encoding: 'utf8',
      env: { ...process.env, VSSH_MANIFEST_PATH: mf, VSSH_SCHEMA_PATH: SCHEMA, VSSH_VERSION_OVERRIDE: '' },
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = { id: 'x', version: '1.0.0', backend: { runtime: 'node', entrypoint: 'b.js' } };

test('um manifesto sadio passa', seNaoTem, () => {
  assert.match(validar(BASE), /^ID=x$/m);
  assert.match(validar({ ...BASE, requiredPackages: ['ffmpeg', 'libreoffice-calc', 'g++'] }), /^ID=x$/m);
});

test('requiredPackages recusa nome com metacaractere de shell', seNaoTem, () => {
  // O caso que motiva a checagem existir: este valor iria para um `apt-get install` no servidor.
  for (const veneno of ['ffmpeg; rm -rf /', 'ffmpeg && curl evil', '$(id)', '../../etc/passwd', 'a b']) {
    const saida = validar({ ...BASE, requiredPackages: [veneno] });
    assert.match(saida, /^ERROR=pacote_invalido:/m, `passou: ${veneno}`);
    // O erro NOMEIA o valor reprovado. "pacote inválido" sozinho manda quem publica conferir a
    // lista inteira à mão.
    assert.ok(saida.includes(veneno), `o erro não diz qual valor foi recusado: ${saida}`);
  }
});

test('requiredPackages aceita o que é nome de pacote Debian de verdade', seNaoTem, () => {
  for (const bom of ['ffmpeg', 'g++', 'libreoffice-calc', 'python3.11', 'lib32z1', 'texlive-latex-extra']) {
    assert.match(validar({ ...BASE, requiredPackages: [bom] }), /^ID=x$/m, `recusou: ${bom}`);
  }
});

test('requiredPackages tem de ser lista', seNaoTem, () => {
  assert.match(validar({ ...BASE, requiredPackages: 'ffmpeg' }), /^ERROR=requiredPackages_nao_e_lista$/m);
  assert.match(validar({ ...BASE, requiredPackages: [42] }), /^ERROR=pacote_invalido:/m);
});

test('as recusas que já existiam continuam recusando', seNaoTem, () => {
  // Uma rede nova não pode afrouxar as antigas — é o mesmo arquivo, e um `sys.exit(0)` no lugar
  // errado desligaria as de baixo sem sinal nenhum.
  assert.match(validar({ ...BASE, id: 'Maiuscula' }), /^ERROR=id_invalido$/m);
  assert.match(validar({ ...BASE, version: '' }), /^ERROR=version_ausente$/m);
  assert.match(validar({ ...BASE, backend: { runtime: 'ruby', entrypoint: 'b.rb' } }), /^ERROR=runtime_invalido$/m);
  assert.match(validar({ ...BASE, backend: { runtime: 'node' } }), /^ERROR=entrypoint_ausente$/m);
});

test('o schema é a fonte da verdade, e conhece o campo novo', seNaoTem, () => {
  // O campo tem DUAS conferências: a explícita no Python (com mensagem própria) e a do schema.
  // Se um dia a explícita sair, o schema ainda recusa — e é isso que este teste garante.
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const campo = schema.properties.requiredPackages;
  assert.equal(campo.type, 'array');
  assert.equal(campo.items.type, 'string');
  assert.match('ffmpeg', new RegExp(campo.items.pattern));
  assert.doesNotMatch('ffmpeg; rm -rf /', new RegExp(campo.items.pattern));
});
