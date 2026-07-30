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

    async queryPermission()   { return 'granted'; }
    async requestPermission() { return 'granted'; }
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

    async queryPermission()   { return 'granted'; }
    async requestPermission() { return 'granted'; }
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
