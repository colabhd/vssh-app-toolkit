// A documentação não volta a recomendar o atalho.
//
// O que este arquivo existe para impedir: um port que RODA e não INTEGRA. A `porting.md` é a única
// página que quem porta lê inteira, e ela chegou a ser uma árvore ordenada só por custo de rodar,
// terminando em "o shim resolve", sem linkar `api.md` uma única vez. O resultado previsível é um app
// que sobe, aparece num iframe e não é cidadão de nada — que é exatamente o modelo que a Onda 9
// existe para desmontar (`docs/roadmap/08-editor-do-ambiente.md`, item 7).
//
// ── Por que a guarda é de JUNÇÃO, e não uma busca por frase proibida ──
//
// A frase errada do healthcheck aparece HOJE em cinco arquivos, e vai continuar aparecendo: cada
// correção CITA o que estava escrito antes, porque a casa corrige no lugar dizendo que estava errado
// (`docs/roadmap/README.md:236`). Procurar a frase acusaria a correção junto com o defeito.
//
// Então a pergunta certa não é "a frase sumiu?", é "a frase está acompanhada do que a desmente?".
// Cada arquivo que ainda contiver o texto antigo precisa dizer, no mesmo arquivo, que isso mudou na
// Onda 4. Reverter qualquer um dos cinco para a versão antiga tira o marcador junto — e é assim que
// esta guarda fica vermelha por um defeito de verdade em vez de por uma citação.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

// Os cinco lugares onde a instrução errada viveu. O último é o que mais custava: é o arquivo de onde
// todo app novo nasce, então a frase não era lida — era COPIADA.
const ONDE_O_HEALTHCHECK_ERA_ENSINADO = [
  ['docs', 'porting.md'],
  ['docs', 'lessons', 'logseq-port.md'],
  ['schema', 'vssh-app.schema.json'],
  ['lib', 'node', 'vssh-app-fs', 'README.md'],
  ['templates', 'hello-vssh-app-node', 'backend', 'server.js'],
];

// ⚠ A primeira versão desta guarda só cobrava o marcador QUANDO o texto antigo ainda estivesse
// no arquivo — `if (!frase_antiga) return;`. A refutação mostrou que ela não media nada em três dos
// cinco: nesses, a correção reescreveu a frase em vez de citá-la, o `return` disparava, e mutar o
// arquivo deixava o teste VERDE. Era o defeito de instrumento de sempre — medir onde é fácil chegar
// em vez de medir o que se quer saber. A pergunta certa não é condicional: **todo** arquivo que fala
// do healthcheck tem de dizer, PERTO DALI, qual é a regra de hoje.

const FALA_DO_HEALTHCHECK = /healthcheck|healthz|healthcheckPath/i;
const O_MARCADOR = /Onda 4/;

// Perto = na mesma vizinhança de texto. Um "Onda 4" solto no outro extremo do arquivo, por outro
// assunto, não corrige o parágrafo do healthcheck — e passaria numa busca de arquivo inteiro.
const VIZINHANCA = 1500;

for (const partes of ONDE_O_HEALTHCHECK_ERA_ENSINADO) {
  const rel = partes.join('/');
  test(`${rel}: onde fala do healthcheck, diz que a regra mudou na Onda 4`, () => {
    const src = ler(...partes);
    const mencoes = [...src.matchAll(new RegExp(FALA_DO_HEALTHCHECK, 'gi'))].map(m => m.index);
    assert.ok(
      mencoes.length > 0,
      `${rel} não fala mais do healthcheck. Se a seção saiu de propósito, tire o arquivo da lista ` +
      `desta guarda — deixá-lo aqui mudo é a guarda medindo um arquivo que não existe mais.`
    );
    const perto = mencoes.some(i =>
      O_MARCADOR.test(src.slice(Math.max(0, i - VIZINHANCA), i + VIZINHANCA))
    );
    assert.ok(
      perto,
      `${rel} fala do healthcheck sem dizer, por perto, que a sondagem passou a ir COM o ` +
      `X-Vssh-App-Token na Onda 4. Era essa a instrução que mandava deixar uma rota aberta sem motivo.`
    );
  });
}

test('porting.md leva quem porta até a página que descreve a integração', () => {
  const src = ler('docs', 'porting.md');
  assert.match(
    src,
    /\]\(api\.md\)/,
    'porting.md não linka api.md. Era esse o buraco: quem entra pela porta do port nunca chega ' +
    'à página que diz o que o ambiente oferece.'
  );
});

test('porting.md faz as DUAS perguntas, e a segunda é sobre contribuir', () => {
  const src = ler('docs', 'porting.md');
  assert.match(src, /custo de \*\*rodar\*\*/, 'sumiu a pergunta do custo de rodar');
  assert.match(
    src,
    /O que ele contribui com o ambiente\?/,
    'sumiu a segunda pergunta. Sem ela a árvore volta a ser ordenada por custo, que é o atalho.'
  );
  assert.match(
    src,
    /custo de \*\*integrar\*\*/,
    'a segunda pergunta existe mas não está ligada a um custo próprio — é o que a fazia ser ignorada'
  );
});

test('criterios.md anuncia o mesmo número de critérios que cobra', () => {
  const src = ler('docs', 'roadmap', 'criterios.md');
  const titulo = src.match(/^#\s+(.+)$/m)?.[1] ?? '';
  assert.match(titulo, /três/i, `o título ainda anuncia menos do que o arquivo cobra: "${titulo}"`);
  assert.ok(
    /##\s*3\.3\s/.test(src),
    'o 3.3 sumiu do arquivo — se ele deixar de existir, o título tem de voltar a dizer dois'
  );
});

test('o 3.3 alcança vssh-app, que é onde ele mais importa', () => {
  const src = ler('docs', 'roadmap', 'criterios.md');
  const comoAplicar = src.slice(src.indexOf('## Como aplicar'));
  assert.ok(comoAplicar.length > 0, 'a seção "Como aplicar" sumiu');
  assert.match(
    comoAplicar,
    /todo vssh-app/i,
    'a cobrança voltou a ser por número de onda. vssh-app não é item de onda — é pacote publicado ' +
    'por fora —, então uma lista de ondas isenta exatamente as janelas que mais parecem página web.'
  );
});

test('a doutrina da extração tem o gatilho de propósito, não só o acidental', () => {
  const src = ler('.claude', 'skills', 'vssh-app', 'SKILL.md');
  const secao = src.slice(src.indexOf('## Empacotando uma ferramenta que já tem servidor'));
  assert.ok(secao.length > 0, 'a seção da doutrina sumiu da SKILL');
  assert.match(
    secao,
    /X-Frame-Options/,
    'sumiu o gatilho acidental — ele continua válido, só não basta'
  );
  assert.match(
    secao,
    /por cima da do ambiente/,
    'a doutrina voltou a disparar só quando a ferramenta RECUSA o iframe. Se ela aceitar, o port ' +
    'termina em servidor + iframe sem ninguém ter decidido isso.'
  );
});
