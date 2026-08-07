'use strict';

// Resolução de caminho confinada a uma raiz. Toda entrada vinda do frontend passa por aqui.
//
// O modelo de ameaça não é "usuário malicioso" — o backend já roda como o próprio usuário Linux,
// então ele não tem nenhum privilégio a proteger dele mesmo. O que isto evita é (a) um bug de
// path do frontend transformar uma escrita de nota em escrita fora do grafo, e (b) um symlink
// dentro do grafo virar um caminho de escrita arbitrário para outro processo que fale com esta
// porta. Ver README, seção "Modelo de segurança".

const fs = require('node:fs');
const path = require('node:path');

class FsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}

// Erros com nome estável, para o adaptador de transporte mapear em status HTTP sem string-matching.
const ENOENT = 'ENOENT';
const EACCES = 'EACCES';
const EINVAL = 'EINVAL';
const EEXIST = 'EEXIST';

function notFound(p) {
  return new FsError(ENOENT, `não encontrado: ${p}`);
}

function outsideRoot(p) {
  return new FsError(EACCES, `caminho fora da raiz: ${p}`);
}

// `realpath` do ancestral existente mais próximo. Necessário porque queremos validar o destino de
// uma escrita cujo arquivo (e às vezes o diretório-pai) ainda não existe, e ao mesmo tempo
// resolver symlinks nos diretórios que existem.
function realpathOfNearestExisting(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return { real, missing: missing.reverse() };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        // Chegou na raiz do filesystem sem encontrar nada que exista.
        return { real: current, missing: missing.reverse() };
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root, candidate) {
  if (candidate === root) return true;
  return candidate.startsWith(root + path.sep);
}

// Resolve um caminho recebido do cliente contra a raiz do grafo.
//
// Aceita tanto caminho relativo à raiz ("pages/foo.md") quanto absoluto ("/home/x/graph/pages/foo.md"),
// porque é o que o Logseq emite: em modo web o `root-dir` do grafo é o próprio caminho absoluto do
// servidor, então as duas formas aparecem nas chamadas do protocolo Fs.
//
// Devolve { abs, rel } com `abs` já resolvido (symlinks incluídos) e garantidamente dentro da raiz.
function resolveInRoot(realRoot, input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new FsError(EINVAL, 'caminho ausente');
  }
  if (input.includes('\0')) {
    throw new FsError(EINVAL, 'caminho com byte nulo');
  }

  const joined = path.isAbsolute(input) ? path.normalize(input) : path.join(realRoot, input);

  // Rejeita antes mesmo de tocar o disco: pega o caso puramente lexical.
  if (!isWithin(realRoot, path.normalize(joined))) throw outsideRoot(input);

  const { real, missing } = realpathOfNearestExisting(joined);
  // `real` é a parte que existe, com symlinks resolvidos. Se ela escapou da raiz, um symlink
  // dentro do grafo aponta para fora — recusa.
  if (!isWithin(realRoot, real)) throw outsideRoot(input);

  const abs = missing.length ? path.join(real, ...missing) : real;
  if (!isWithin(realRoot, abs)) throw outsideRoot(input);

  const rel = abs === realRoot ? '' : path.relative(realRoot, abs);
  return { abs, rel };
}

// A raiz em si precisa existir e ser resolvida uma vez, no setup — todas as comparações depois são
// contra o caminho já real, senão um symlink no meio da raiz derruba todos os prefix checks.
function resolveRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new FsError(EINVAL, 'root ausente');
  }
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}

module.exports = { FsError, ENOENT, EACCES, EINVAL, EEXIST, resolveInRoot, resolveRoot, isWithin, notFound };
