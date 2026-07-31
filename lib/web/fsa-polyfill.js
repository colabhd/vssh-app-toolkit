'use strict';

// fsa-polyfill — File System Access API sobre o shell VSSH.
//
// Esta é a peça que faz um web app "que abre uma pasta local" rodar como vssh-app SEM FORK:
// Logseq web, VS Code for Web, Excalidraw, tldraw e a maioria dos editores chamam
// `showDirectoryPicker()` e trabalham a partir do handle devolvido. Se o handle funcionar, o app
// funciona.
//
// Por que sobre o shell e não sobre um filesystem do próprio app: o portal já tem uma API de
// arquivos madura, e o seletor já existe no desktop. Assim o app portado ganha FSA sem rodar
// backend de filesystem nenhum — que é justamente o que o torna barato de portar. (Para um store
// PRIVADO do app, confinado e com token próprio, o caminho é a lib `vssh-app-fs`.)
//
// Permissão: só o que o usuário escolheu num seletor fica alcançável, nesta janela. Quem impõe
// isso é o shell (tabela de grants), não este arquivo — um app malicioso reimplementando o
// protocolo não ganha nada além do que o usuário já concedeu.
//
// Requer `vssh-app-shim.js` carregado antes.

(function () {
  if (!window.vssh) {
    console.warn('[fsa-polyfill] vssh-app-shim.js precisa ser carregado antes.');
    return;
  }
  // Navegador que já tem a API de verdade e não está no desktop: não sequestrar.
  if (window.showDirectoryPicker && !window.vssh.inDesktop) return;

  const fs = window.vssh.fs;
  const basename = (p) => p.replace(/\/+$/, '').split('/').pop() || p;
  const join = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;

  // ── Handles ────────────────────────────────────────────────────────────────
  //
  // O obstáculo conhecido: apps persistem handles no IndexedDB (`idb-keyval` e afins), e
  // structured clone NÃO transporta objeto com métodos — o handle chegaria do outro lado como um
  // objeto vazio, e o app abriria o grafo do usuário como se estivesse em branco. Por isso todo
  // handle carrega uma forma serializável (`__vsshHandle`), e o wrapper de IndexedDB no fim deste
  // arquivo reidrata na leitura.

  // File preguiçoso: só busca o conteúdo quando alguém pede de verdade.
  //
  // Isto não é otimização prematura — é o que torna o polyfill utilizável. Apps que abrem uma
  // pasta chamam `getFile()` para TODO arquivo do diretório, recursivamente, e só depois filtram
  // por extensão. Com busca ansiosa, um grafo de 300 arquivos vira ~600 requisições e baixa todos
  // os anexos (PDF, imagem) a cada abertura, para descartar quase tudo em seguida.
  //
  // `size`/`lastModified` são propriedades síncronas, então precisam existir antes de qualquer
  // fetch: vêm da listagem do diretório, que já os traz. Um handle obtido fora de listagem
  // (getFileHandle direto) paga um stat — uma requisição pequena, e só nesse caso.
  //
  // ⚠️ LIMITE ESTRUTURAL, e é preciso ser explícito sobre ele: um objeto que finge ser um `Blob`
  // só é um `Blob` para quem chama os métodos que ele sobrescreve. `super([])` cria a sequência
  // de bytes interna VAZIA, e nenhum getter alcança esse estado. Então:
  //
  //     await f.text() / f.arrayBuffer()   → funcionam (métodos sobrescritos)
  //     URL.createObjectURL(f)             → blob: vazio   ← tratado abaixo
  //     new Response(f) / new Blob([f])    → 0 bytes       ← não tratável
  //     FileReader.*, FormData.append      → 0 bytes       ← não tratável
  //
  // O caminho de `URL.createObjectURL` é o que importa na prática (é como todo app transforma
  // handle em `<img src>`), e ele é interceptado no fim deste arquivo. Os demais não têm conserto
  // dentro de uma subclasse de `Blob`: preguiça e compatibilidade estrutural não coexistem aí.
  // Se um app precisar deles, o caminho é `await file.arrayBuffer()` e construir um `Blob` real.
  class LazyFile extends Blob {
    constructor(path, name, meta) {
      super([]);
      this._path = path;
      this._name = name;
      this._size = Number(meta?.size) || 0;
      this._mtime = meta?.mtime ? Number(meta.mtime) : Date.now();
      this._bytes = null;
    }
    get name()         { return this._name; }
    get size()         { return this._size; }
    get lastModified() { return this._mtime; }
    get type()         { return ''; }

    async _load() {
      if (!this._bytes) this._bytes = await fs.readBytes(this._path);
      return this._bytes;
    }
    async arrayBuffer() {
      const b = await this._load();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async text()   { return new TextDecoder().decode(await this._load()); }
    async bytes()  { return this._load(); }
    stream() {
      const self = this;
      return new ReadableStream({
        async pull(controller) {
          controller.enqueue(await self._load());
          controller.close();
        },
      });
    }
    slice(start, end, type) {
      // Fatia exige o conteúdo; quem fatia já decidiu pagar a leitura.
      const b = this._bytes;
      if (!b) throw new Error('slice() exige leitura prévia: chame text()/arrayBuffer() antes.');
      return new Blob([b.subarray(start, end)], { type });
    }
  }

  class VsshFileHandle {
    constructor(path, meta) {
      this.kind = 'file';
      this.name = basename(path);
      this._meta = meta || null;   // {size, mtime} quando veio de uma listagem
      this.__vsshHandle = { v: 1, kind: 'file', path };
    }
    get _path() { return this.__vsshHandle.path; }

    async getFile() {
      // Sem metadados conhecidos, um stat — que é barato — em vez do corpo inteiro.
      const meta = this._meta || await fs.stat(this._path).catch(() => ({}));
      return new LazyFile(this._path, this.name, meta);
    }

    // Devolve um WritableStream DE VERDADE, não um objeto parecido: apps fazem
    // `contents.pipeTo(writable)` quando têm um ReadableStream, e isso exige a classe real.
    // `write`/`seek`/`truncate` entram como propriedades próprias — é o que a especificação de
    // FileSystemWritableFileStream faz por cima de WritableStream.
    async createWritable(opts = {}) {
      const path = this._path;
      const chunks = [];
      const keep = opts.keepExistingData ? await fs.read(path).catch(() => '') : null;
      if (keep) chunks.push(keep);

      const commit = async () => {
        // Texto puro segue pela rota de texto; qualquer byte real vai pela rota binária.
        // Antes tudo virava `blob.text()`, o que corrompia um PNG em silêncio.
        const allText = chunks.every((c) => typeof c === 'string');
        if (allText) return fs.write(path, chunks.join(''));
        const buf = await new Blob(chunks).arrayBuffer();
        return fs.writeBytes(path, new Uint8Array(buf));
      };

      let writer = null;
      const stream = new WritableStream({
        write(chunk) { chunks.push(chunk); },
        close: commit,
      });

      stream.write = async (data) => {
        // A especificação aceita o dado cru ou `{type:'write', data}`.
        if (data && typeof data === 'object' && !ArrayBuffer.isView(data) &&
            !(data instanceof Blob) && !(data instanceof ArrayBuffer) && 'data' in data) {
          data = data.data;
        }
        writer = writer || stream.getWriter();
        return writer.write(data);
      };
      stream.truncate = async () => { chunks.length = 0; };
      stream.seek = async () => {
        throw new Error('[fsa-polyfill] seek() não é suportado: a escrita é sequencial.');
      };
      const origClose = stream.close?.bind(stream);
      stream.close = async () => {
        if (writer) return writer.close();          // caminho write()/close()
        if (origClose) return origClose();           // caminho pipeTo() (que já fecha sozinho)
        return commit();
      };
      return stream;
    }

    async queryPermission()   { return queryPermission(this); }
    async requestPermission() { return requestPermission(this); }
    async isSameEntry(other)  { return other?.__vsshHandle?.path === this._path; }
  }

  class VsshDirectoryHandle {
    constructor(path) {
      this.kind = 'directory';
      this.name = basename(path);
      this.__vsshHandle = { v: 1, kind: 'directory', path };
    }
    get _path() { return this.__vsshHandle.path; }

    async *entries() {
      const { items = [] } = await fs.list(this._path);
      for (const it of items) {
        const p = join(this._path, it.name);
        // size/mtime seguem junto: é o que permite ao getFile() devolver um File utilizável sem
        // nenhuma requisição. Sem isto, listar uma pasta custaria um stat por arquivo.
        yield [it.name, it.type === 'directory' || it.isDirectory
          ? new VsshDirectoryHandle(p)
          : new VsshFileHandle(p, { size: it.size, mtime: it.mtime })];
      }
    }
    async *keys()   { for await (const [n] of this.entries()) yield n; }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    [Symbol.asyncIterator]() { return this.entries(); }

    async getFileHandle(name, opts = {}) {
      const p = join(this._path, name);
      const meta = await fs.stat(p).catch(() => null);
      if (!meta) {
        if (!opts.create) throw notFound(name);
        await fs.write(p, '');
      }
      return new VsshFileHandle(p);
    }

    async getDirectoryHandle(name, opts = {}) {
      const p = join(this._path, name);
      const meta = await fs.stat(p).catch(() => null);
      if (!meta) {
        if (!opts.create) throw notFound(name);
        await fs.mkdir(p);
      }
      return new VsshDirectoryHandle(p);
    }

    async removeEntry(name) { await fs.delete(join(this._path, name)); }

    async resolve(possible) {
      const p = possible?.__vsshHandle?.path;
      if (!p || !p.startsWith(this._path + '/')) return null;
      return p.slice(this._path.length + 1).split('/');
    }

    async queryPermission()   { return queryPermission(this); }
    async requestPermission() { return requestPermission(this); }
    async isSameEntry(other)  { return other?.__vsshHandle?.path === this._path; }
  }

  function notFound(name) {
    // Os apps distinguem NotFoundError de erro genérico para decidir entre "criar" e "falhar".
    const err = new Error(`não encontrado: ${name}`);
    err.name = 'NotFoundError';
    return err;
  }

  function abortError() {
    // Cancelar um seletor é AbortError no padrão — apps tratam isso como "usuário desistiu", e
    // sem o nome certo eles mostram um erro que não aconteceu.
    const err = new Error('o usuário cancelou a seleção');
    err.name = 'AbortError';
    return err;
  }

  // ── Permissão: perguntar a quem decide, e ter um caminho de volta ──────────
  //
  // Estas duas respondiam `granted` incondicionalmente, e isso era uma mentira com consequência:
  // quem decide é o shell, e um handle restaurado do IndexedDB podia perfeitamente já não ter
  // permissão nenhuma. O app checava, ouvia "pode", e era negado na primeira operação — com um
  // stack trace no lugar de uma explicação, e sem caminho de volta.
  //
  // `requestPermission()` reabre o seletor. É o que a API real faz (mostrar o prompt), é o único
  // jeito de reconceder, e não é um pop-up surpresa: o app só chega aqui porque pediu.
  //
  // Shim antigo, sem `isGranted`: não há a quem perguntar, e responder 'prompt' faria o app pedir
  // ao usuário algo que ele talvez já tenha concedido. Aí sim o certo é o 'granted' de antes.
  async function queryPermission(handle) {
    if (typeof fs.isGranted !== 'function') return 'granted';
    return (await fs.isGranted(handle._path)) ? 'granted' : 'prompt';
  }

  async function requestPermission(handle) {
    if (typeof fs.isGranted !== 'function') return 'granted';
    if (await fs.isGranted(handle._path)) return 'granted';
    const opts = { title: `Escolha novamente: ${handle.name}` };
    if (handle.kind === 'directory') await window.vssh.pickDirectory(opts);
    else await window.vssh.pickFile(opts);
    // Escolher OUTRO caminho não concede este. O handle continua apontando para onde apontava,
    // e dizer 'granted' aqui só adiaria a mesma negação para a primeira operação.
    return (await fs.isGranted(handle._path)) ? 'granted' : 'denied';
  }

  function rehydrate(v) {
    if (!v || typeof v !== 'object') return v;
    const h = v.__vsshHandle;
    if (h && h.path) return h.kind === 'directory' ? new VsshDirectoryHandle(h.path) : new VsshFileHandle(h.path);
    return v;
  }

  // ── A API pública ──────────────────────────────────────────────────────────

  window.showDirectoryPicker = async function (opts = {}) {
    const path = await window.vssh.pickDirectory({ title: opts.title || 'Escolher pasta' });
    if (!path) throw abortError();
    return new VsshDirectoryHandle(path);
  };

  window.showOpenFilePicker = async function (opts = {}) {
    const path = await window.vssh.pickFile({ title: opts.title || 'Abrir arquivo' });
    if (!path) throw abortError();
    return [new VsshFileHandle(path)];
  };

  window.showSaveFilePicker = async function (opts = {}) {
    const path = await window.vssh.pickSave({
      title: opts.title || 'Salvar arquivo',
      name: opts.suggestedName,
    });
    if (!path) throw abortError();
    return new VsshFileHandle(path);
  };

  window.FileSystemHandle = window.FileSystemHandle || function () {};
  window.FileSystemFileHandle = VsshFileHandle;
  window.FileSystemDirectoryHandle = VsshDirectoryHandle;

  // ── URL.createObjectURL sobre um File preguiçoso ───────────────────────────
  //
  // É assim que praticamente todo app web transforma um handle em `<img src>`:
  //
  //     img.src = URL.createObjectURL(await handle.getFile());
  //
  // Com um `Blob` preguiçoso isso produz um `blob:` VAZIO — a imagem simplesmente não aparece, e
  // o sintoma não aponta para lugar nenhum. Aqui devolvemos uma URL HTTP do portal em vez de um
  // `blob:`; ela serve os mesmos bytes, com Range (vídeo e PDF grande abrem) e autorizada pelo
  // cookie de sessão, que é a única forma que um `<img>` tem de se autenticar.
  //
  // Três restrições moldaram isto: tem de ser síncrono (a assinatura é), a URL tem de sair só do
  // caminho (sem round-trip), e ela tem de carregar autorização sozinha.
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  URL.createObjectURL = function (obj) {
    if (obj instanceof LazyFile) return window.vssh.fs.urlFor(obj._path);
    return origCreateObjectURL(obj);
  };

  // `revokeObjectURL` é no-op para URL desconhecida, mas não vamos entregar uma URL http: para a
  // implementação nativa e torcer — só ignoramos o que não é `blob:`.
  URL.revokeObjectURL = function (url) {
    if (typeof url === 'string' && !url.startsWith('blob:')) return;
    return origRevokeObjectURL(url);
  };

  // ── Persistência em IndexedDB ──────────────────────────────────────────────
  //
  // Um handle é objeto com métodos, e structured clone descarta métodos. Sem este envelope, o
  // app guarda o handle, recarrega a página, lê de volta um objeto morto e conclui que a pasta
  // está vazia. `__vsshHandle` é plain data e sobrevive ao clone; aqui só reconstruímos a classe
  // na leitura, para o app receber de volta algo que responde às mesmas chamadas.
  const origGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...args) {
    const req = origGet.apply(this, args);
    let cached;
    Object.defineProperty(req, 'result', {
      configurable: true,
      get() {
        if (cached === undefined) {
          const raw = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get.call(this);
          cached = Array.isArray(raw) ? raw.map(rehydrate) : rehydrate(raw);
        }
        return cached;
      },
    });
    return req;
  };

  const origGetAll = IDBObjectStore.prototype.getAll;
  if (origGetAll) {
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = origGetAll.apply(this, args);
      let cached;
      Object.defineProperty(req, 'result', {
        configurable: true,
        get() {
          if (cached === undefined) {
            const raw = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get.call(this);
            cached = Array.isArray(raw) ? raw.map(rehydrate) : rehydrate(raw);
          }
          return cached;
        },
      });
      return req;
    };
  }
})();
