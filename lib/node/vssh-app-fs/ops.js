'use strict';

// As operações de filesystem, sem nada de transporte e sem nada de app específico.
//
// Proveniência: a semântica nasceu espelhando o processo main do Electron do Logseq, que é uma
// implementação de referência madura de um protocolo de fs para editor
// (`src/electron/electron/handler.cljs`, `deps/common/src/logseq/common/graph.cljs`). Isso vale
// como origem, não como política: as listas de extensão e de ignore que eram dele saíram para
// `presets/logseq.js` na promoção para o toolkit. Onde há divergência deliberada em relação
// àquela referência, está marcado com "DIVERGE:".

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { FsError, ENOENT, EINVAL, resolveInRoot, resolveRoot, notFound } = require('./paths');

// Extensões cujo conteúdo é lido e devolvido em open-dir/get-files.
//
// Este default é genérico de propósito: texto que qualquer app provavelmente quer ler inteiro.
// O que era específico do Logseq (a `allowed-formats` de logseq/common/graph.cljs) mora agora em
// `presets/logseq.js` — a lib não deve ter política de nenhum app embutida.
const DEFAULT_CONTENT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'yml', 'yaml', 'html', 'css', 'js', 'xml',
];

// Ignorados por padrão: só o que é cruft em qualquer projeto. Regras de app entram por config.
const DEFAULT_IGNORE = {
  prefixes: [],
  exact: [],
  dirNames: ['node_modules', '.git'],
  suffixes: ['.DS_Store'],
  hidden: true, // qualquer componente de caminho começando com "." (mas não "..")
};

// Onde `unlink` deposita o que remove. Relativo à raiz.
const DEFAULT_RECYCLE_DIR = '.recycle';

const DEFAULT_MAX_CONTENT_BYTES = 16 * 1024 * 1024;

function extOf(p) {
  const ext = path.extname(p);
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase();
}

function hasHiddenComponent(rel) {
  return rel.split('/').some((seg) => seg.length > 1 && seg.startsWith('.') && seg !== '..');
}

function makeIsIgnored(ignore) {
  const cfg = { ...DEFAULT_IGNORE, ...ignore };
  isIgnored.config = cfg;   // o walk precisa da regra de ocultos separada do resto
  return isIgnored;

  function isIgnored(rel) {
    if (!rel) return false;
    const p = rel.split(path.sep).join('/');
    if (cfg.hidden && hasHiddenComponent(p)) return true;
    if (cfg.prefixes.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) return true;
    if (cfg.exact.includes(p)) return true;
    if (cfg.dirNames.some((name) => p.split('/').slice(0, -1).includes(name))) return true;
    if (cfg.suffixes.some((suffix) => p.endsWith(suffix))) return true;
    return false;
  }
}

function statToInfo(stat) {
  return {
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    // epoch ms — é o que `->db-files` põe em :file/last-modified-at.
    mtime: Math.round(stat.mtimeMs),
  };
}

/**
 * @param {object} config
 * @param {string} config.root                  raiz do grafo (criada se não existir)
 * @param {string[]} [config.contentExtensions] extensões cujo conteúdo entra em open-dir/get-files
 * @param {object} [config.ignore]              override das regras de ignore (ver DEFAULT_IGNORE)
 * @param {string} [config.recycleDir]          destino relativo do unlink (não apaga de verdade)
 * @param {number} [config.maxContentBytes]     acima disto o arquivo é listado sem conteúdo
 * @param {(event: object) => void} [config.onWarn] canal de avisos (o app decide se loga)
 */
function createAppFs(config = {}) {
  const realRoot = resolveRoot(config.root);
  const contentExtensions = new Set(
    (config.contentExtensions || DEFAULT_CONTENT_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const isIgnored = makeIsIgnored(config.ignore);
  const hiddenIgnored = isIgnored.config.hidden;
  const recycleDir = config.recycleDir || DEFAULT_RECYCLE_DIR;
  const maxContentBytes = config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const onWarn = config.onWarn || (() => {});

  const resolve = (input) => resolveInRoot(realRoot, input);

  // Caminhamento recursivo: descarta symlinks (um link para fora da raiz não vaza nem por
  // leitura), devolve só arquivos, caminhos absolutos.
  //
  // Ocultos NÃO são mais descartados aqui de forma incondicional. Antes eram, e isso fazia a
  // config mentir: `ignore.hidden = false` não tinha efeito nenhum, porque o walk já havia
  // derrubado os ocultos antes de `isIgnored` rodar. Agora quem decide é sempre a mesma regra.
  //
  // `applyIgnore` é opt-in porque as duas chamadoras querem coisas diferentes, e isso é
  // deliberado, não um descuido: `collectFiles` quer a visão filtrada (é o carregamento do
  // conteúdo), e `readdir` quer a visão crua — o Logseq a usa justamente para alcançar
  // `logseq/version-files`, que está na lista de ignore dele. Filtrar lá esconderia do consumidor
  // exatamente o que ele foi buscar.
  async function walk(startAbs, { applyIgnore = false } = {}) {
    const out = [];
    const queue = [startAbs];
    while (queue.length) {
      const dir = queue.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(realRoot, abs).split(path.sep).join('/');
        // Ocultos: sempre pela config, nunca hardcoded — é o que faz `hidden: false` funcionar.
        if (hiddenIgnored && hasHiddenComponent(rel)) continue;
        if (applyIgnore && isIgnored(rel)) continue;
        if (entry.isDirectory()) queue.push(abs);
        else out.push(abs);
      }
    }
    out.sort();
    return out;
  }

  // DIVERGE: o upstream lê qualquer tamanho. Um arquivo gigante na allowlist derrubaria o backend
  // na abertura do grafo.
  //
  // Ele é OMITIDO da listagem, não listado com conteúdo vazio: um arquivo que o Logseq não conhece
  // fica intocado, enquanto um arquivo listado como vazio é uma página vazia aos olhos dele — e o
  // primeiro save por cima apaga o conteúdo real no disco.
  function tooLarge(stat) {
    return stat.size > maxContentBytes;
  }

  // = `get-files` de common/graph.cljs: só as extensões da allowlist, ignorados fora, com conteúdo.
  async function collectFiles(dirAbs) {
    const all = await walk(dirAbs, { applyIgnore: true });
    const files = [];
    for (const abs of all) {
      if (!contentExtensions.has(extOf(abs))) continue;
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // corrida com escrita externa: só ignora
        throw err;
      }
      if (tooLarge(stat)) {
        onWarn({ event: 'file-skipped', reason: 'too-large', path: abs, size: stat.size, limit: maxContentBytes });
        continue;
      }
      const info = statToInfo(stat);
      files.push({
        path: abs,
        content: await fsp.readFile(abs, 'utf8'),
        size: info.size,
        mtime: info.mtime,
        type: info.type,
      });
    }
    return files;
  }

  async function openDir(input) {
    const { abs } = resolve(input || realRoot);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw notFound(input || realRoot);
    if (!stat.isDirectory()) throw new FsError(EINVAL, `não é diretório: ${abs}`);
    return { path: abs, files: await collectFiles(abs) };
  }

  return {
    root: realRoot,

    async stat(input) {
      const { abs } = resolve(input);
      try {
        return statToInfo(await fsp.stat(abs));
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(input);
        throw err;
      }
    },

    // "Existe?" é pergunta booleana e merece resposta booleana. `stat` responde com erro quando o
    // caminho não existe, e isso está certo — é a resposta correta para "me dê os metadados". Mas
    // quem só quer saber se existe acaba usando o erro como fluxo de controle, e aí toda sondagem
    // de rotina vira ruído de erro nos dois lados. Caminho fora da raiz continua sendo EACCES:
    // se existe ou não fora da raiz não é resposta que esta lib deva dar.
    async exists(input) {
      const { abs } = resolve(input);
      return { exists: (await fsp.stat(abs).catch(() => null)) !== null };
    },

    async readFile(input) {
      const { abs } = resolve(input);
      try {
        return { content: await fsp.readFile(abs, 'utf8') };
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(input);
        throw err;
      }
    },

    // `content` string (utf8) ou Buffer/Uint8Array (asset colado no editor).
    async writeFile(input, content) {
      const { abs } = resolve(input);

      // Gravar por cima de um diretório nunca é o que o chamador quis: significa que o caminho
      // chegou errado (vazio, resolvendo para a raiz do grafo, ou apontando para uma pasta). Sem
      // esta checagem o `fsp.writeFile` lança EISDIR, que o transporte não sabia classificar e
      // devolvia 500 — um pedido inválido do cliente aparecendo como defeito do servidor.
      const existing = await fsp.stat(abs).catch(() => null);
      if (existing && existing.isDirectory()) {
        throw new FsError(EINVAL, `destino de escrita é um diretório: ${abs}`);
      }

      // Conteúdo que não é texto nem bytes faria `Buffer.from` lançar um TypeError sem errno, que
      // também acabaria em 500. É entrada inválida, então é 400.
      const isBytes = content instanceof Uint8Array || ArrayBuffer.isView(content);
      if (typeof content !== 'string' && !isBytes) {
        throw new FsError(EINVAL, `conteúdo deve ser texto ou bytes, veio ${typeof content}`);
      }

      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const data = typeof content === 'string' ? content : Buffer.from(content);
      await fsp.writeFile(abs, data);
      const stat = await fsp.stat(abs);
      const info = statToInfo(stat);
      return { path: abs, size: info.size, mtime: info.mtime };
    },

    async mkdir(input) {
      const { abs } = resolve(input);
      try {
        await fsp.mkdir(abs);
      } catch (err) {
        // O caller do Logseq trata EEXIST como sucesso (fs/node.cljs faz exatamente isso).
        if (err.code !== 'EEXIST') throw err;
      }
      return {};
    },

    async mkdirRecur(input) {
      const { abs } = resolve(input);
      await fsp.mkdir(abs, { recursive: true });
      return {};
    },

    // Enumerador cru: todos os arquivos, recursivo, caminhos absolutos, sem filtro de extensão.
    //
    // Por padrão NÃO aplica a `ignore` — e isso é deliberado, não uma divergência esquecida em
    // relação a open-dir/get-files. Quem chama readdir costuma estar atrás justamente do que a
    // ignore esconde (o Logseq a usa para alcançar `logseq/version-files`, que está na ignore
    // dele). Passe `{ applyIgnore: true }` para a visão filtrada. A regra de ocultos vale nos
    // dois modos, porque vem da config.
    async readdir(input, { applyIgnore = false } = {}) {
      const { abs } = resolve(input || realRoot);
      return walk(abs, { applyIgnore });
    },

    // Por padrão não apaga: move para o recycle dir com o caminho relativo achatado
    // (`replace "/" "_"`), para um "desfazer exclusão" continuar possível.
    //
    // `{ recycle: false }` apaga de verdade — para app que já tem lixeira própria, ou para o que
    // é descartável por natureza (cache, temporário) e não deve inchar o recycle dir.
    async unlink(input, { recycle = true } = {}) {
      const { abs, rel } = resolve(input);
      if (!recycle) {
        try {
          await fsp.unlink(abs);
        } catch (err) {
          if (err.code === 'ENOENT') throw notFound(input);
          throw err;
        }
        return { recycled: null };
      }
      const { abs: recycleAbs } = resolve(recycleDir);
      await fsp.mkdir(recycleAbs, { recursive: true });
      const flat = rel.split(path.sep).join('/').replace(/\//g, '_');
      const dest = path.join(recycleAbs, flat);
      try {
        await fsp.rename(abs, dest);
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(input);
        if (err.code === 'EXDEV') {
          // recycle em outro device (bind mount): copia e remove.
          await fsp.copyFile(abs, dest);
          await fsp.unlink(abs);
        } else {
          throw err;
        }
      }
      return { recycled: dest };
    },

    async rename(oldInput, newInput) {
      const { abs: oldAbs } = resolve(oldInput);
      const { abs: newAbs } = resolve(newInput);
      await fsp.mkdir(path.dirname(newAbs), { recursive: true });
      try {
        await fsp.rename(oldAbs, newAbs);
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(oldInput);
        throw err;
      }
      return {};
    },

    // Sobrescreve sem confirmação — o protocolo pede isso explicitamente ("copy with overwrite").
    async copy(oldInput, newInput) {
      const { abs: oldAbs } = resolve(oldInput);
      const { abs: newAbs } = resolve(newInput);
      await fsp.mkdir(path.dirname(newAbs), { recursive: true });
      try {
        await fsp.copyFile(oldAbs, newAbs);
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(oldInput);
        throw err;
      }
      return {};
    },

    // `{path, files}` — mesma forma que :openDir/:getFiles devolvem no Electron.
    openDir,

    // O protocolo distingue os dois (`open-dir` abre um grafo novo, `get-files` recarrega), mas a
    // leitura é a mesma; quem separa os dois casos é o frontend.
    getFiles: openDir,

    // Para o transporte servir binário (imagem, PDF) sem passar por JSON.
    async openRead(input) {
      const { abs } = resolve(input);
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || stat.isDirectory()) throw notFound(input);
      const info = statToInfo(stat);
      return {
        path: abs,
        size: info.size,
        mtime: info.mtime,
        stream: (opts) => fs.createReadStream(abs, opts),
      };
    },
  };
}

module.exports = {
  createAppFs,
  DEFAULT_CONTENT_EXTENSIONS,
  DEFAULT_IGNORE,
  DEFAULT_RECYCLE_DIR,
  DEFAULT_MAX_CONTENT_BYTES,
  FsError,
  ENOENT,
  EINVAL,
};
