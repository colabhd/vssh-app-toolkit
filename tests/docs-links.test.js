// Link relativo e ÂNCORA da documentação — os dois, e a âncora é a que faltava.
//
// O que este arquivo existe para impedir: a roadmap é o artefato que o projeto inteiro
// consulta, e ela se referencia por seção. Renomear um cabeçalho não quebra nada visível —
// o link continua abrindo o arquivo certo e para no topo, e quem clicou nem percebe que
// deveria ter caído noutro lugar.
//
// Aconteceu na Onda 2.2: o cabeçalho "O relógio — porque o ambiente não tem um" virou
// "O relógio" quando o relógio ficou pronto, e três arquivos continuaram apontando para a
// âncora antiga. O verificador de links usado até então validava só a PARTE DO ARQUIVO,
// e passou verde.
//
// ── A regra de slug do GitHub, que é onde quase toda checagem caseira erra ──
//
//   minúsculas → remove tudo que não for letra, número, espaço ou hífen (inclusive emoji,
//   acento NÃO: acento fica) → cada espaço vira UM hífen, e os hifens NÃO são colapsados.
//
// Ou seja: `### 3.1 — O nav` vira `#31--o-nav`, com dois hifens, porque o travessão sumiu
// entre dois espaços. Um checador que colapsa hífen acusa link bom e deixa passar link ruim.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function markdowns(dir, out = []) {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome.startsWith('.')) continue;
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) markdowns(p, out);
    else if (nome.endsWith('.md')) out.push(p);
  }
  return out;
}

/** A regra do GitHub, com os hifens preservados como estão. */
export function slug(titulo) {
  return titulo
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')   // \p{L} mantém acento; emoji e pontuação saem
    .replace(/ /g, '-');
}

/** Âncoras que um arquivo oferece: cabeçalhos + `<a id>` explícitos. */
function ancorasDe(src) {
  const set = new Set();
  const vistos = new Map();
  for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const base = slug(m[1]);
    // Cabeçalho repetido ganha sufixo -1, -2… no GitHub.
    const n = vistos.get(base) || 0;
    vistos.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of src.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1].toLowerCase());
  return set;
}

const ARQUIVOS = markdowns(ROOT);
const CONTEUDO = new Map(ARQUIVOS.map(p => [p, readFileSync(p, 'utf8')]));
const ANCORAS = new Map([...CONTEUDO].map(([p, s]) => [p, ancorasDe(s)]));

const LINK = /\[[^\]]*\]\(([^)\s#]*)(#[^)\s]*)?\)/g;

test('a varredura acha os arquivos da roadmap — senão ela não prova nada', () => {
  const nomes = ARQUIVOS.map(p => relative(ROOT, p).replace(/\\/g, '/'));
  assert.ok(nomes.includes('docs/roadmap/README.md'), 'a roadmap tem de estar na varredura');
  assert.ok(nomes.length >= 10, `esperava dezenas de .md, achei ${nomes.length}`);
});

test('todo link relativo aponta para um arquivo que existe', () => {
  const quebrados = [];
  for (const [p, src] of CONTEUDO) {
    for (const m of src.matchAll(LINK)) {
      const alvo = m[1];
      if (!alvo || /^(https?:|mailto:|data:|#)/.test(alvo)) continue;
      const abs = resolve(dirname(p), decodeURIComponent(alvo));
      try { statSync(abs); } catch {
        quebrados.push(`${relative(ROOT, p)} -> ${alvo}`);
      }
    }
  }
  assert.deepStrictEqual(quebrados, []);
});

test('toda âncora aponta para um cabeçalho que existe', () => {
  const quebradas = [];
  for (const [p, src] of CONTEUDO) {
    for (const m of src.matchAll(LINK)) {
      if (!m[2]) continue;
      const alvo = decodeURIComponent(m[2].slice(1)).toLowerCase();
      if (!alvo) continue;
      const arquivo = m[1] ? resolve(dirname(p), decodeURIComponent(m[1])) : p;
      const disponiveis = ANCORAS.get(arquivo);
      if (!disponiveis) continue;                 // arquivo inexistente: é o outro teste
      if (!disponiveis.has(alvo)) quebradas.push(`${relative(ROOT, p)} -> ${m[1]}#${alvo}`);
    }
  }
  assert.deepStrictEqual(quebradas, []);
});

test('o slug segue a regra do GitHub, inclusive onde ela surpreende', () => {
  // Um teste do próprio critério: sem isto, um slug errado deixaria os dois testes acima
  // verdes e errados ao mesmo tempo.
  assert.equal(slug('O relógio'), 'o-relógio', 'acento fica');
  assert.equal(slug('3.1 — O nav'), '31--o-nav', 'travessão some e deixa DOIS hifens');
  assert.equal(slug('✅ Resolvido: um index'), '-resolvido-um-index', 'emoji some e deixa o hífen');
  assert.equal(slug('2.1 — Tray — concluída'), '21--tray--concluída');
});
