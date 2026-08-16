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

// ─── Uma exigência não é um pacote ────────────────────────────────────────────
//
// O caso real que fez esta sintaxe existir: um motor de impressão declarava `"chromium"` e foi
// RECUSADO num servidor que tinha Chrome e Edge — dois programas que fazem exatamente o que ele
// precisa. O app exige uma FERRAMENTA; o nome do pacote que a entrega muda com a distro e com o
// repositório de onde ela vem. `|` é o idioma do `Depends: a | b` do Debian, e é o único
// metacaractere que este campo admite.

test('requiredPackages aceita ALTERNATIVAS separadas por barra', seNaoTem, () => {
  for (const bom of [
    'chromium | chromium-browser | google-chrome-stable',
    'ffmpeg|libav-tools',                      // sem espaço também
    'a | b',
  ]) {
    assert.match(validar({ ...BASE, requiredPackages: [bom] }), /^ID=x$/m, `recusou: ${bom}`);
  }
});

test('a barra é a ÚNICA exceção — o resto do alfabeto continua fechado', seNaoTem, () => {
  // Admitir um metacaractere num campo cuja defesa inteira é o alfabeto só se paga se a fresta
  // for exatamente do tamanho da sintaxe. `||` é o operador do shell, e ele não passa.
  for (const veneno of ['chromium || rm -rf /', 'a | ; id', '| chromium', 'chromium |', 'a | B']) {
    assert.match(validar({ ...BASE, requiredPackages: [veneno] }), /^ERROR=pacote_invalido:/m,
      `passou: ${veneno}`);
  }
});

test('o erro aponta QUAL alternativa está torta', seNaoTem, () => {
  // Numa exigência com quatro nomes, "pacote inválido" manda conferir os quatro à mão — e três
  // deles estão certos.
  const saida = validar({ ...BASE, requiredPackages: ['chromium | Google-Chrome | edge'] });
  assert.match(saida, /^ERROR=pacote_invalido:/m);
  assert.match(saida, /a alternativa 'Google-Chrome' não é nome de pacote/,
    'o erro não nomeia o pedaço reprovado, só a linha inteira');
});

// ─── `resources`: o mesmo motivo, não a simetria ──────────────────────────────
//
// Cada valor daqui vira um `-p Propriedade=<valor>` numa linha de comando de `systemd-run` rodando
// como o usuário no servidor. É a mesma classe de destino do `requiredPackages`, e por isso o mesmo
// gate — não porque ficaria bonito ter os dois validados.

test('resources aceita o que systemd entende', seNaoTem, () => {
  for (const bom of [
    { memoryMax: '2G' }, { memoryMax: '85%' }, { memoryHigh: '512M' }, { memoryMax: '1073741824' },
    { cpuQuota: '150%' }, { tasksMax: '512' }, { tasksMax: '25%' },
    { memoryMax: 'none', cpuQuota: 'none' },
  ]) {
    assert.match(validar({ ...BASE, resources: bom }), /^ID=x$/m, `recusou: ${JSON.stringify(bom)}`);
  }
});

test('resources recusa o que viraria injeção na linha de comando', seNaoTem, () => {
  for (const veneno of ['1G; rm -rf /', '$(id)', '`id`', '2G && curl evil', '85%; echo', '--property=X']) {
    assert.match(validar({ ...BASE, resources: { memoryMax: veneno } }),
      /^ERROR=resource_invalido:memoryMax=/m, `passou: ${veneno}`);
  }
});

test('resources recusa campo desconhecido, e diz QUAL', seNaoTem, () => {
  // Um `memoryLimit` escrito por engano seria silenciosamente ignorado, e o autor acharia que
  // declarou um teto. Recusar nomeando é a diferença entre um erro de digitação e uma surpresa
  // no servidor de outra pessoa.
  assert.match(validar({ ...BASE, resources: { memoryLimit: '2G' } }),
    /^ERROR=resource_desconhecido:'memoryLimit'$/m);
});

test('resources tem de ser objeto', seNaoTem, () => {
  assert.match(validar({ ...BASE, resources: '2G' }), /^ERROR=resources_nao_e_objeto$/m);
  assert.match(validar({ ...BASE, resources: { memoryMax: 2 } }), /^ERROR=resource_invalido:memoryMax=/m);
});

test('cpuQuota só aceita porcentagem — "2" não é dois núcleos', seNaoTem, () => {
  // O erro que alguém vai cometer: `cpuQuota: "2"` pensando em dois núcleos. O systemd leria como
  // 2%, e o app ficaria absurdamente lento por um motivo que ninguém relacionaria ao manifesto.
  assert.match(validar({ ...BASE, resources: { cpuQuota: '2' } }), /^ERROR=resource_invalido:cpuQuota=/m);
  assert.match(validar({ ...BASE, resources: { cpuQuota: '200%' } }), /^ID=x$/m);
});

// ─── `gpu` e `secrets` ────────────────────────────────────────────────────────

test('gpu é booleano e só booleano', seNaoTem, () => {
  // O servidor trata só `true` como pedido. Um `"true"` em texto rodaria SEM GPU, e o autor
  // procuraria o problema no driver — não no manifesto.
  assert.match(validar({ ...BASE, gpu: true }), /^ID=x$/m);
  assert.match(validar({ ...BASE, gpu: false }), /^ID=x$/m);
  assert.match(validar({ ...BASE, gpu: 'true' }), /^ERROR=gpu_nao_e_booleano:/m);
  assert.match(validar({ ...BASE, gpu: 1 }), /^ERROR=gpu_nao_e_booleano:/m);
});

test('secrets declara nome, e o nome vira export no shell do servidor', seNaoTem, () => {
  assert.match(validar({ ...BASE, secrets: [{ name: 'OPENAI_API_KEY', description: 'chave' }] }), /^ID=x$/m);
  for (const veneno of ['openai_key', 'A B', 'X;rm -rf /', '$(id)', '1KEY', '']) {
    assert.match(validar({ ...BASE, secrets: [{ name: veneno }] }),
      /^ERROR=secret_invalido:/m, `passou: ${veneno}`);
  }
});

test('secrets NÃO pode trazer o valor — é o erro que o campo existe para tornar impossível', seNaoTem, () => {
  // Um valor aqui seria commitado, publicado, e distribuído a todo servidor que instalasse o app.
  for (const campo of ['value', 'valor', 'default']) {
    assert.match(validar({ ...BASE, secrets: [{ name: 'TOKEN', [campo]: 'sk-abc123' }] }),
      /^ERROR=secret_com_valor:/m, `passou com ${campo}`);
  }
});

test('secrets recusa nome repetido', seNaoTem, () => {
  // Dois campos para uma variável só, e o segundo apagando o primeiro sem dizer nada.
  assert.match(validar({ ...BASE, secrets: [{ name: 'TOKEN' }, { name: 'TOKEN' }] }),
    /^ERROR=secret_duplicado:/m);
});

test('secrets tem de ser lista de objetos', seNaoTem, () => {
  assert.match(validar({ ...BASE, secrets: 'TOKEN' }), /^ERROR=secrets_nao_e_lista$/m);
  assert.match(validar({ ...BASE, secrets: ['TOKEN'] }), /^ERROR=secret_nao_e_objeto:/m);
});

test('as recusas que já existiam continuam recusando', seNaoTem, () => {
  // Uma rede nova não pode afrouxar as antigas — é o mesmo arquivo, e um `sys.exit(0)` no lugar
  // errado desligaria as de baixo sem sinal nenhum.
  assert.match(validar({ ...BASE, id: 'Maiuscula' }), /^ERROR=id_invalido$/m);
  assert.match(validar({ ...BASE, version: '' }), /^ERROR=version_ausente$/m);
  assert.match(validar({ ...BASE, backend: { runtime: 'ruby', entrypoint: 'b.rb' } }), /^ERROR=runtime_invalido$/m);
  assert.match(validar({ ...BASE, backend: { runtime: 'node' } }), /^ERROR=entrypoint_ausente$/m);
});

// ─── O campo que ninguém escreveu: o typo ─────────────────────────────────────
//
// Medido antes de consertar, e o resultado foi mais preciso do que a roadmap supunha. Os objetos
// que já declaravam `additionalProperties: false` — `resources`, `engine`, `opens`, `secrets[]` —
// recusavam o campo desconhecido. Os que declaravam `true` — a RAIZ, `backend` e `window` — deixavam
// passar limpo, e o campo era descartado em silêncio pelo lado que lê.
//
// A raiz era a pior das três porque é onde moram os campos que MUDAM comportamento: um
// `requiredPackage` sem o `s` publica, instala e não verifica pacote nenhum. E `window` era a mais
// barata de errar: o portal repassa o objeto inteiro, o cliente lê quatro chaves, e `widht: 900`
// deixa a janela no tamanho padrão sem uma linha de log em lugar nenhum.

// ─── `opens.urls`: o campo cujo VALOR vira regra de casamento ────────────────
//
// Ele não se parece com `extensions`, e a diferença é de consequência. Uma extensão errada faz o
// app não aparecer no "Abrir com"; um host errado faz o app **capturar links que não são dele** —
// e o link é o gesto em que a pessoa menos espera ser levada para outro lugar. Por isso a recusa
// mora no gate de publicação, e não só no portal: aqui é onde ainda dá para não publicar.
//
// A recusa que mais importa é a do rótulo único, e ela não é óbvia. `localhost` neste ambiente é o
// loopback DO SERVIDOR — o servidor de desenvolvimento de quem está usando. Um app que o
// reivindicasse passaria a receber todo `http://localhost:3000` de todo mundo.

test('opens.urls aceita o que é host de verdade', seNaoTem, () => {
  for (const bom of [
    'youtube.com', 'youtu.be', 'www.youtube.com', '*.youtube.com',
    'xn--80ak6aa92e.com',                 // IDN em punycode é host como qualquer outro
    'arquivo.gov.br', 'a.b',
  ]) {
    assert.match(validar({ ...BASE, opens: { urls: [bom] } }), /^ID=x$/m, `recusou: ${bom}`);
  }
});

test('opens.urls recusa o que sequestraria mais do que um site', seNaoTem, () => {
  for (const [ruim, porque] of [
    ['*',                'tomaria a internet inteira'],
    ['*.com',            'curinga sobre sufixo público'],
    ['localhost',        'aqui é o loopback DO SERVIDOR'],
    ['intranet',         'rótulo único: nome de rede interna, não site'],
    ['192.168.1.10',     'endereço não é identidade de site'],
    ['*.localhost',      'curinga sobre rótulo único'],
    ['https://youtube.com', 'esquema junto — o campo é só o host'],
    ['youtube.com/watch',   'caminho junto — quem roteia dentro do app é o app'],
    ['youtube.com:443',     'porta junto'],
    ['-youtube.com',        'rótulo não começa com hífen'],
    ['youtube.com.',        'ponto final solto'],
  ]) {
    assert.match(validar({ ...BASE, opens: { urls: [ruim] } }),
      /^ERROR=schema:opens\.urls\[0\]: /m, `passou (${porque}): ${ruim}`);
  }
});

test('opens.urls NÃO é casamento por sufixo', seNaoTem, () => {
  // `'evilyoutube.com'.endsWith('youtube.com')` é `true`, e é assim que se escreve este casamento
  // errado na primeira tentativa. Aqui os dois são hosts distintos e cada um se declara sozinho —
  // o schema não tem como impedir o engano, então ele documenta e o teste registra a intenção.
  const saida = validar({ ...BASE, opens: { urls: ['youtube.com', 'evilyoutube.com'] } });
  assert.match(saida, /^ID=x$/m, 'os dois são hosts válidos e independentes');

  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const re = new RegExp(schema.properties.opens.properties.urls.items.pattern);
  assert.ok(re.test('*.youtube.com'), 'o curinga de subdomínio precisa passar');
  assert.ok(!re.test('*.com'), 'curinga sobre sufixo público não pode passar');
});

test('a raiz recusa campo desconhecido — era por onde o typo passava', seNaoTem, () => {
  for (const [campo, valor] of [
    ['requiredPackage', ['ffmpeg']],   // o `s` que faltou: publicaria sem verificar pacote nenhum
    ['gpuu', true],
    ['opns', { extensions: ['md'] }],
    ['secret', [{ name: 'TOKEN' }]],
  ]) {
    assert.match(validar({ ...BASE, [campo]: valor }),
      /^ERROR=schema:<raiz>: campo desconhecido: /m, `passou na raiz: ${campo}`);
  }
});

test('backend e window também fecharam', seNaoTem, () => {
  assert.match(
    validar({ ...BASE, backend: { runtime: 'node', entrypoint: 'b.js', healthcheckPat: '/z' } }),
    /^ERROR=schema:backend: campo desconhecido: healthcheckPat/m);
  assert.match(validar({ ...BASE, window: { widht: 900 } }),
    /^ERROR=schema:window: campo desconhecido: widht/m);
});

test('o erro nomeia o vizinho — inclusive quando o typo é uma transposição', seNaoTem, () => {
  // "campo desconhecido: requiredPackage" está correto e não ajuda: quem publica olha para o
  // manifesto, vê o campo escrito lá, e conclui que o schema é que está velho.
  //
  // A transposição é o caso que obrigou a distância a ser Damerau: `widht` por `width` é o typo
  // mais comum que existe, e a distância de edição simples o cobra como DOIS erros — então
  // justamente o mais provável ficaria sem sugestão.
  for (const [manifesto, sugestao] of [
    [{ ...BASE, requiredPackage: [] },                                          'requiredPackages'],
    [{ ...BASE, gpuu: true },                                                   'gpu'],
    [{ ...BASE, opns: {} },                                                     'opens'],
    [{ ...BASE, window: { widht: 900 } },                                       'width'],
    [{ ...BASE, window: { hieght: 600 } },                                      'height'],
    [{ ...BASE, backend: { runtime: 'node', entrypoint: 'b.js', healthcheckPat: '/' } }, 'healthcheckPath'],
  ]) {
    assert.match(validar(manifesto), new RegExp(`você quis dizer ${sugestao}\\?`),
      `sem sugestão para ${JSON.stringify(manifesto)}`);
  }
});

test('e não inventa um vizinho quando não há', seNaoTem, () => {
  // Uma sugestão errada é pior que nenhuma: manda quem publica renomear o campo para outro que
  // também não é o que ele queria. O teto da distância é proporcional ao tamanho do nome.
  const saida = validar({ ...BASE, zzzTotalmenteOutro: 1 });
  assert.match(saida, /campo desconhecido: zzzTotalmenteOutro/);
  assert.doesNotMatch(saida, /você quis dizer/);
});

test('todo objeto do schema fecha a porta', seNaoTem, () => {
  // A rede que impede o apodrecimento, e é ela que importa mais que os casos acima: fechar as três
  // portas de hoje não impede a quarta de nascer aberta. Um objeto novo sem
  // `additionalProperties: false` reabre o buraco exatamente onde ninguém vai procurar.
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const abertos = [];
  (function anda(no, caminho) {
    if (!no || typeof no !== 'object') return;
    if (no.type === 'object' && no.properties) {
      if (no.additionalProperties !== false) abertos.push(caminho || '<raiz>');
      for (const [k, v] of Object.entries(no.properties)) anda(v, `${caminho}.${k}`.replace(/^\./, ''));
    }
    if (no.items) anda(no.items, `${caminho}[]`);
  })(schema, '');
  assert.deepEqual(abertos, [], `objeto(s) aceitando campo desconhecido: ${abertos.join(', ')}`);
});

test('os manifestos que existem de verdade continuam publicáveis', seNaoTem, () => {
  // Apertar um gate é barato de escrever e caro de errar: um campo legítimo esquecido no schema
  // transformaria esta rede em "nenhum app publica". Os templates são o que qualquer pessoa copia
  // para começar — se eles não passam, ninguém passa.
  for (const t of ['hello-vssh-app', 'hello-vssh-app-node']) {
    const mf = path.join(ROOT, 'templates', t, 'vssh-app.json');
    const saida = validar(JSON.parse(fs.readFileSync(mf, 'utf8')));
    assert.match(saida, /^ID=/m, `o template ${t} deixou de publicar: ${saida}`);
  }

  // ⚠ E os de `examples/` também, porque `publish-apps.yml:99` varre `examples/*/` a cada push em
  // main. Um manifesto que o schema recusa aqui vira job vermelho lá — e a mensagem chega no CI, e
  // não no editor de quem escreveu.
  for (const dir of fs.readdirSync(path.join(ROOT, 'examples'))) {
    const mf = path.join(ROOT, 'examples', dir, 'vssh-app.json');
    if (!fs.existsSync(mf)) continue;
    const saida = validar(JSON.parse(fs.readFileSync(mf, 'utf8')));
    assert.match(saida, /^ID=/m, `o exemplo ${dir} deixou de publicar: ${saida}`);
  }
});

// ─── `provides` e `minShellVersion`: os dois campos de CONTRATO ───────────────
//
// São diferentes de todos os outros do manifesto, e a diferença é quem lê. `requiredPackages`,
// `resources` e `secrets` descrevem o app para o ambiente que vai rodá-lo; estes dois descrevem o
// app para OUTRO app, e para uma versão de shell que ainda não existe. Um contrato entre partes
// que não se conhecem — e por isso o gate de publicação é o único lugar onde alguém revisa.

test('provides aceita capacidade com versão, e só com versão', seNaoTem, () => {
  assert.match(validar({ ...BASE, provides: ['llm/v1', 'print/v1', 'web-proxy/v12'] }), /^ID=x$/m);
  // A versão é o ponto do campo. Uma capacidade é contrato entre repositórios que não se conhecem;
  // sem versão, mudá-la é quebrar alguém em silêncio — e o erro tem de dizer o que fazer, porque
  // esquecer o `/v1` é o engano óbvio e o conserto é óbvio também.
  const saida = validar({ ...BASE, provides: ['llm'] });
  assert.match(saida, /^ERROR=capacidade_invalida:'llm'/m);
  assert.match(saida, /falta a versão \(ex\.: 'llm\/v1'\)/,
    'o erro não ensina o conserto — e este é o engano que mais vai acontecer');
});

test('provides recusa o que não é nome de capacidade', seNaoTem, () => {
  for (const ruim of ['LLM/v1', 'llm/V1', 'llm/1', '/v1', 'llm/v', 'llm//v1', 'llm v1', '']) {
    assert.match(validar({ ...BASE, provides: [ruim] }),
      /^ERROR=capacidade_invalida:/m, `passou: ${JSON.stringify(ruim)}`);
  }
  assert.match(validar({ ...BASE, provides: 'llm/v1' }), /^ERROR=provides_nao_e_lista$/m);
});

test('provides recusa a mesma capacidade duas vezes', seNaoTem, () => {
  // Não é erro de forma, é erro de sentido — e ele SOME na resolução, que trabalha com conjunto.
  // Recusar aqui é o único lugar onde alguém chega a ver.
  assert.match(validar({ ...BASE, provides: ['llm/v1', 'llm/v1'] }), /^ERROR=capacidade_duplicada:/m);
  // Mas duas VERSÕES da mesma capacidade são legítimas: é como se convive com o v1 enquanto ainda
  // há consumidor dele.
  assert.match(validar({ ...BASE, provides: ['llm/v1', 'llm/v2'] }), /^ID=x$/m);
});

test('minShellVersion aceita a forma que o shell publica, e nomeia o que recusa', seNaoTem, () => {
  for (const boa of ['4', '4.0', '4.0.0', '10.2.13']) {
    assert.match(validar({ ...BASE, minShellVersion: boa }), /^ID=x$/m, `recusou: ${boa}`);
  }
  // Os enganos vêm de outros ecossistemas e passariam como string qualquer, para só falhar no
  // servidor de outra pessoa. O erro nomeia o valor porque é ele que está errado, não o campo.
  for (const ruim of ['v4.0.0', '^4.0', '>=4', '4.0.0-beta', 'latest', '']) {
    const saida = validar({ ...BASE, minShellVersion: ruim });
    assert.match(saida, /^ERROR=minShellVersion_invalida:/m, `passou: ${JSON.stringify(ruim)}`);
    assert.ok(saida.includes(JSON.stringify(ruim).slice(1, -1)) || ruim === '',
      `o erro não diz qual valor foi recusado: ${saida}`);
  }
});

test('minShellVersion não é obrigatória, e esse é o padrão', seNaoTem, () => {
  // Um campo obrigatório transformaria toda API nova em quebra de compatibilidade declarada — a
  // burocracia sem o benefício. Quem declara está dizendo "eu uso uma coisa que não existia antes".
  assert.match(validar(BASE), /^ID=x$/m);
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  assert.ok(!(schema.required || []).includes('minShellVersion'),
    'minShellVersion virou obrigatória — todo app publicado passa a declarar contrato que não usa');
  assert.ok(!(schema.required || []).includes('provides'));
});

test('o schema é a fonte da verdade, e conhece o campo novo', seNaoTem, () => {
  // O campo tem DUAS conferências: a explícita no Python (com mensagem própria) e a do schema.
  // Se um dia a explícita sair, o schema ainda recusa — e é isso que este teste garante.
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const campo = schema.properties.requiredPackages;
  assert.equal(campo.type, 'array');
  assert.equal(campo.items.type, 'string');
  const re = new RegExp(campo.items.pattern);
  assert.match('ffmpeg', re);
  assert.doesNotMatch('ffmpeg; rm -rf /', re);
  // O schema e a conferência explícita têm de aceitar a MESMA sintaxe. Divergindo, um manifesto
  // passa num gate e é recusado no outro — e a mensagem vem do gate errado.
  assert.match('chromium | google-chrome-stable', re, 'o schema não conhece alternativas');
  assert.doesNotMatch('chromium || rm -rf /', re);
  assert.doesNotMatch('chromium |', re);
});
