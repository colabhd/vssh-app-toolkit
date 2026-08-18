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

  // As classes NATIVAS, guardadas antes de substituirmos os globais lá embaixo.
  //
  // Elas continuam em uso mesmo depois da troca, e é fácil não perceber por quê: o **OPFS** é
  // nativo (ver a seção no fim deste arquivo), então `navigator.storage.getDirectory()` devolve
  // handles nativos. Sem guardar as classes aqui, `opfsDir instanceof FileSystemDirectoryHandle`
  // passaria a ser `false` — trocaríamos um `instanceof` quebrado por outro.
  const NATIVO = {
    handle:    window.FileSystemHandle,
    arquivo:   window.FileSystemFileHandle,
    diretorio: window.FileSystemDirectoryHandle,
  };

  const marcaDe = (x) => (x && typeof x === 'object' ? x.__vsshHandle : null);
  const ehNativo = (x, Classe) =>
    typeof Classe === 'function' && x != null && Object.prototype.isPrototypeOf.call(Classe.prototype, x);

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
  // ⚠️ O LIMITE ESTRUTURAL, e o que foi feito com ele. Um objeto que finge ser um `Blob` só é um
  // `Blob` para quem chama os métodos que ele sobrescreve: `super([])` deixa a sequência de bytes
  // interna VAZIA, e nenhum getter alcança esse estado. Quem lê pelo caminho da plataforma —
  // `Response`, `FileReader`, o construtor de `Blob` — não passa por método nenhum nosso.
  //
  // Isso foi MEDIDO num Chrome de verdade (`lib/web/test/fsa-polyfill.browser.test.js`), e a
  // medição achou um modo de falha pior do que "vem vazio": `new Blob([f])` devolve **`size` 13
  // com conteúdo vazio**. Quem confere `blob.size > 0` antes de usar passa na conferência e
  // recebe nada. Um `FormData` sobe `filename="nota.md"` com zero bytes, sem erro nenhum.
  //
  // Vale registrar por que o Node não servia para achar isso: o `undici` monta o corpo de
  // `new Response(f)` chamando o método `.stream()` **público**, enquanto o navegador segue o
  // Fetch, que usa o *get stream* INTERNO e nunca olha para o método. Um conserto apoiado em
  // `stream()` fica verde no Node com o navegador ainda quebrado.
  //
  // O que cada caminho faz hoje:
  //
  //     await f.text() / f.arrayBuffer() / f.bytes()  → métodos sobrescritos
  //     f.slice(a, b)                                 → FAIXA nova, lida por Range HTTP
  //     URL.createObjectURL(f)                        → URL do portal          ← interceptado
  //     new Response(f) / new Request(…, {body: f})    → corpo vira f.stream()  ← interceptado
  //     fetch(url, { body: f })                       → Blob real, carregado   ← interceptado
  //     FileReader.readAs*                            → carrega e despacha     ← interceptado
  //     new Blob([f]) · FormData.append               → 0 bytes, com AVISO     ← sem conserto
  //
  // Os dois últimos são síncronos e leem a sequência interna na hora: não há onde encaixar um
  // `await`. Eles ganham um aviso preciso no console em vez do silêncio — e passam a funcionar
  // sozinhos se o conteúdo já tiver sido lido antes, porque aí os bytes existem.
  class LazyFile extends Blob {
    /**
     * `faixa` só é passada por `slice()`: `{ inicio, tipo }`, com `meta.size` sendo o TAMANHO DA
     * FAIXA. Um LazyFile de faixa lê por Range HTTP; um de arquivo inteiro segue pelo
     * `fs.readBytes` de sempre, que é o caminho já testado da ponte.
     */
    constructor(path, name, meta, faixa) {
      super([]);
      this._path = path;
      this._name = name;
      this._size = Number(meta?.size) || 0;
      this._mtime = meta?.mtime ? Number(meta.mtime) : Date.now();
      this._bytes = null;
      this._inicio = faixa ? Number(faixa.inicio) || 0 : 0;
      this._ehFaixa = !!faixa;
      this._tipo = (faixa && faixa.tipo) || '';
    }
    get name()         { return this._name; }
    get size()         { return this._size; }
    get lastModified() { return this._mtime; }
    get type()         { return this._tipo; }

    async _load() {
      if (!this._bytes) {
        this._bytes = this._ehFaixa
          ? await lerFaixa(this._path, this._inicio, this._size)
          : await fs.readBytes(this._path);
      }
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

    // Fatiar é a OPERAÇÃO PRIMÁRIA de todo leitor de Parquet, HDF5, Zarr e DICOM: eles leem por
    // faixa em vez de carregar o arquivo. Enquanto isto lançava, o arquétipo A3 estava bloqueado
    // — e lançava exatamente no uso correto da API, o de quem não quer baixar tudo.
    slice(inicio, fim, tipo) {
      const [a, b] = faixaNormalizada(inicio, fim, this._size);
      // Conteúdo já em mãos: devolver um `Blob` REAL é estritamente melhor que um preguiçoso —
      // ele funciona em todos os caminhos da plataforma, inclusive os dois sem conserto.
      if (this._bytes) return new Blob([this._bytes.subarray(a, b)], { type: tipo });
      return new LazyFile(this._path, this._name, { size: b - a, mtime: this._mtime },
        { inicio: this._inicio + a, tipo });
    }
  }

  // Normalização do `slice`, como a especificação do Blob manda: índice negativo conta do fim, e
  // uma faixa invertida é vazia em vez de erro. Sem isto, `f.slice(-4)` leria a faixa errada.
  function faixaNormalizada(inicio, fim, tamanho) {
    const corta = (v, padrao) => {
      if (v === undefined || v === null) return padrao;
      v = Math.trunc(Number(v)) || 0;
      return v < 0 ? Math.max(tamanho + v, 0) : Math.min(v, tamanho);
    };
    const a = corta(inicio, 0);
    const b = corta(fim, tamanho);
    return [a, Math.max(a, b)];
  }

  /**
   * Lê uma faixa de bytes. Prefere um `Range` HTTP sobre a URL que o shell já serve — é o que
   * torna útil abrir um arquivo de 2 GB para ler 64 KB dele.
   *
   * Duas defesas, e as duas já custaram caro em outros lugares deste repositório:
   *
   *  1. **Um servidor pode IGNORAR o `Range` e responder 200 com o arquivo inteiro.** Confiar no
   *     pedido em vez de conferir a resposta entregaria os bytes errados, silenciosamente. Só o
   *     `206` autoriza usar o corpo como se fosse a faixa.
   *  2. Sem `urlFor`, ou com a rede falhando, o caminho de baixo lê tudo pela ponte e fatia
   *     aqui: mais caro, mas correto. Preferir o barato não pode virar "ou o barato, ou nada".
   */
  async function lerFaixa(caminho, inicio, tamanho) {
    const url = typeof fs.urlFor === 'function' ? fs.urlFor(caminho) : null;
    if (url && typeof fetch === 'function') {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${inicio}-${inicio + tamanho - 1}` } });
        if (r.ok) {
          const buf = new Uint8Array(await r.arrayBuffer());
          if (r.status === 206 && buf.length === tamanho) return buf;
          // 200 = o `Range` foi ignorado e veio o recurso inteiro; fatiamos aqui. Mas só se o
          // corpo for grande o bastante para conter a faixa — um corpo curto demais não é o
          // arquivo (uma página de erro, um redirecionamento resolvido em HTML), e fatiá-lo
          // devolveria lixo com cara de conteúdo. Nesse caso o caminho de baixo responde.
          if (r.status === 200 && buf.length >= inicio + tamanho) return buf.subarray(inicio, inicio + tamanho);
        }
      } catch { /* rede fora: o caminho de baixo ainda responde */ }
    }
    const tudo = await fs.readBytes(caminho);
    return tudo.subarray(inicio, inicio + tamanho);
  }

  /**
   * A base comum dos dois handles — e ela existe por um motivo que só um navegador de verdade
   * revela.
   *
   * O Chrome **já tem** `FileSystemHandle`, e este arquivo preservava a nativa
   * (`window.FileSystemHandle || function(){}`). Como os nossos handles não descendiam dela, o
   * resultado era assimétrico e difícil de suspeitar:
   *
   *     h instanceof FileSystemDirectoryHandle  → true    (essa nós substituímos)
   *     h instanceof FileSystemHandle           → FALSE   (essa era a nativa)
   *
   * A checagem da classe concreta passava e a da classe BASE falhava — e `instanceof
   * FileSystemHandle` é justamente o idioma de "isto é um handle, tanto faz qual". Substituir a
   * base pela nossa não quebra nada aqui dentro: dentro do desktop não existe handle nativo,
   * porque os três `show*Picker` são deste arquivo e nunca abrem o seletor do navegador.
   */
  class VsshHandle {
    // `instanceof` tem de responder "sim" para as DUAS procedências: os nossos handles, que falam
    // com o filesystem do usuário pelo shell, e os NATIVOS do OPFS, que o navegador entrega
    // direto. Um app não distingue os dois — para ele os dois são handles da mesma API — e um
    // `if (h instanceof FileSystemDirectoryHandle)` que reprova metade deles é pior que inútil.
    //
    // Isto vai nas NOSSAS classes, e não numa remendagem das nativas: são nossas, e dizer o que
    // elas aceitam é prerrogativa delas.
    static [Symbol.hasInstance](x) { return !!marcaDe(x) || ehNativo(x, NATIVO.handle); }

    get _path() { return this.__vsshHandle.path; }

    async queryPermission(d = {})   { return queryPermission(this, d); }
    async requestPermission(d = {}) { return requestPermission(this, d); }
    async isSameEntry(other)  { return other?.__vsshHandle?.path === this._path; }

    /**
     * `move(novoNome)` · `move(pastaDestino)` · `move(pastaDestino, novoNome)` — as três formas da
     * especificação. Move **e** renomeia, porque no filesystem é a mesma operação.
     *
     * O handle se atualiza no lugar, como manda a especificação: depois de mover, ele aponta para
     * o novo caminho. Um handle que continuasse apontando para o caminho velho seria um handle
     * morto que parece vivo — o app leria e receberia "não encontrado" sem entender por quê.
     */
    async move(destino, novoNome) {
      const pasta = destino && destino.__vsshHandle && destino.__vsshHandle.kind === 'directory'
        ? destino : null;
      const nome = pasta ? String(novoNome ?? this.name) : String(destino ?? this.name);
      const paiAtual = this._path.slice(0, this._path.lastIndexOf('/')) || '';
      const novo = join(pasta ? pasta._path : paiAtual, nome);
      await fs.rename(this._path, novo);
      this.__vsshHandle.path = novo;
      this.name = nome;
    }

    /** Apaga o que este handle aponta. Diretório com conteúdo exige `{ recursive: true }`. */
    async remove(opts = {}) {
      await apagar(this._path, !!opts.recursive);
    }
  }

  /**
   * O `/api/fs/delete` do portal é `rm -rf` incondicional, e a especificação da FSA **não é**:
   * apagar um diretório com conteúdo sem `{ recursive: true }` tem de lançar
   * `InvalidModificationError`.
   *
   * Sem esta conferência, `removeEntry('pasta')` apagava a pasta inteira em silêncio — a única
   * divergência deste polyfill que **perde dado do usuário**, e sem erro nenhum para ligar uma
   * coisa à outra.
   *
   * A janela entre conferir e apagar é inerente (a especificação tem a mesma), e é estreita: quem
   * escreve ali no meio é outro processo, não o app.
   *
   * A conferência é um `list`, e **não** um `stat` seguido de `list`. A primeira versão perguntava
   * ao `stat` se era diretório e só então listava — o que fazia a guarda depender do FORMATO da
   * resposta do stat (`isDirectory`). Um shell cujo stat não trouxesse o campo devolveria
   * `undefined`, a guarda se consideraria inaplicável, e o `rm -rf` passaria: uma proteção que
   * falha ABERTO por causa de um campo ausente. Listar direto não pergunta nada a ninguém —
   * arquivo não lista, e diretório vazio lista vazio.
   */
  async function apagar(caminho, recursive) {
    if (!recursive) {
      const { items = [] } = await fs.list(caminho).catch(() => ({ items: [] }));
      if (items.length) {
        const err = new Error(
          `'${basename(caminho)}' não está vazio: passe { recursive: true } para apagar o conteúdo.`);
        err.name = 'InvalidModificationError';
        throw err;
      }
    }
    await fs.delete(caminho);
  }

  class VsshFileHandle extends VsshHandle {
    static [Symbol.hasInstance](x) {
      return marcaDe(x)?.kind === 'file' || ehNativo(x, NATIVO.arquivo);
    }
    constructor(path, meta) {
      super();
      this.kind = 'file';
      this.name = basename(path);
      this._meta = meta || null;   // {size, mtime} quando veio de uma listagem
      this.__vsshHandle = { v: 1, kind: 'file', path };
    }

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
  }

  class VsshDirectoryHandle extends VsshHandle {
    static [Symbol.hasInstance](x) {
      return marcaDe(x)?.kind === 'directory' || ehNativo(x, NATIVO.diretorio);
    }
    constructor(path) {
      super();
      this.kind = 'directory';
      this.name = basename(path);
      this.__vsshHandle = { v: 1, kind: 'directory', path };
    }

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

    async removeEntry(name, opts = {}) {
      await apagar(join(this._path, name), !!opts.recursive);
    }

    async resolve(possible) {
      const p = possible?.__vsshHandle?.path;
      if (!p || !p.startsWith(this._path + '/')) return null;
      return p.slice(this._path.length + 1).split('/');
    }
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
  // ── "não" e "não sei" pedem ações opostas ─────────────────────────────────
  //
  // `ask()` tem TRÊS respostas: `true`, `false` e `null` (não obtive resposta — shell antigo que
  // não conhece a mensagem `grants`, erro, ou timeout). Tratar `null` como `false` mandava o app
  // reconceder uma permissão que ele possivelmente já tinha, e o grafo não carregava **enquanto
  // as operações de arquivo funcionavam normalmente** — porque `fs` o shell implementa e `grants`
  // não. Sintoma que não aponta para a causa; custou três versões do primeiro app portado.
  //
  // A regra que unifica os dois casos: **um shell sem `grants` é o mesmo caso que um shim sem
  // `isGranted`** — em nenhum dos dois há a quem perguntar. Os dois respondem 'granted', que é o
  // comportamento anterior a este arquivo existir e o único que não incomoda o usuário à toa.
  async function ask(handle, mode) {
    if (typeof fs.isGranted !== 'function') return null;
    const v = await fs.isGranted(handle._path, { mode });
    return typeof v === 'boolean' ? v : null;
  }

  // `mode` (`'read'` | `'readwrite'`) é aceito e repassado. Hoje o shell não distingue: todo grant
  // dele é readwrite. Isso torna 'granted' para um pedido `{mode:'read'}` **correto** — readwrite
  // satisfaz read — e é por isso que ignorar o campo não é uma mentira, só uma simplificação que
  // vale enquanto durar. O parâmetro existe para o dia em que o shell tiver grants por modo.
  async function queryPermission(handle, descriptor = {}) {
    const v = await ask(handle, descriptor.mode);
    if (v === null) return 'granted';
    return v ? 'granted' : 'prompt';
  }

  async function requestPermission(handle, descriptor = {}) {
    const v = await ask(handle, descriptor.mode);
    if (v === null) return 'granted';   // não há a quem perguntar; não abra seletor no escuro
    if (v) return 'granted';

    // Abrir seletor exige gesto do usuário — não é regra nossa, é do navegador. Sem isto,
    // `requestPermission` chamado no meio do boot (o Logseq faz, ao restaurar o grafo) disparava
    // um seletor que ninguém pediu, num momento em que ninguém está olhando.
    if (typeof navigator !== 'undefined' && navigator.userActivation &&
        !navigator.userActivation.isActive) {
      return 'prompt';
    }

    const opts = { title: `Escolha novamente: ${handle.name}` };
    if (handle.kind === 'directory') await window.vssh.pickDirectory(opts);
    else await window.vssh.pickFile(opts);

    // Escolher OUTRO caminho não concede este. O handle continua apontando para onde apontava,
    // e dizer 'granted' aqui só adiaria a mesma negação para a primeira operação.
    const after = await ask(handle, descriptor.mode);
    if (after === null) return 'granted';
    return after ? 'granted' : 'denied';
  }

  // Reidrata um valor lido do IndexedDB. Desce em objeto simples e array porque **o handle nem
  // sempre é o valor guardado** — apps guardam `{ handle, lastOpened }` e afins, e um envelope
  // aninhado voltava cru, sem métodos: o app lia de volta um objeto morto e concluía que a pasta
  // estava vazia. É exatamente o modo de falha que o envelope existe para evitar.
  //
  // A profundidade é limitada, e o limite é duas coisas ao mesmo tempo: teto de custo e proteção
  // contra ciclo (structured clone permite referência circular, e uma recursão ingênua trava).
  // Map/Set/typed array/Blob ficam de fora — não são onde apps guardam handle, e descer neles
  // custaria reconstruí-los.
  const REHYDRATE_MAX_DEPTH = 4;

  function rehydrate(v, depth = 0) {
    if (!v || typeof v !== 'object') return v;

    const h = v.__vsshHandle;
    if (h && h.path) return h.kind === 'directory' ? new VsshDirectoryHandle(h.path) : new VsshFileHandle(h.path);

    if (depth >= REHYDRATE_MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((it) => rehydrate(it, depth + 1));

    // Comparar com `Object.prototype` seria sensível a realm: um objeto vindo de outro documento
    // (iframe, worker) tem OUTRO `Object.prototype` e seria descartado como se não fosse simples.
    // A marca de tipo não tem esse problema. Não vale se preocupar com instância de classe: o
    // structured clone que trouxe este valor já as achatou em objeto simples — o que este teste
    // realmente exclui é objeto de plataforma (Map, Set, Date, Blob, typed array), onde descer
    // custaria reconstruí-los e não há handle para achar.
    if (Object.prototype.toString.call(v) !== '[object Object]') return v;

    let changed = false;
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = rehydrate(v[k], depth + 1);
      if (out[k] !== v[k]) changed = true;
    }
    // Devolver o original quando nada mudou preserva identidade para o caso comum (a esmagadora
    // maioria dos objetos lidos do IndexedDB não tem handle nenhum dentro).
    return changed ? out : v;
  }

  // ── A API pública ──────────────────────────────────────────────────────────
  //
  // Os descritores dos seletores eram IGNORADOS em silêncio — `types`, `startIn` e `multiple`
  // entravam e não saíam em lugar nenhum. Um app que declara "só .md" via seletor mostrando a
  // home inteira, e a pessoa culpa o próprio filtro. Aqui os que têm tradução são traduzidos, e
  // os que não têm **avisam**.

  /**
   * `types` da FSA → a string de filtro do seletor do desktop.
   *
   *     [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
   *       → "Markdown (*.md *.markdown)"
   *
   * O formato do outro lado é o do Qt/KDE: grupos separados por `;;`, cada um `Nome (padrões)`.
   * Sem `description`, o shell monta o rótulo a partir dos próprios padrões.
   */
  function filtroDeTypes(types) {
    if (!Array.isArray(types) || !types.length) return undefined;
    const grupos = [];
    for (const t of types) {
      const exts = [];
      for (const lista of Object.values(t?.accept || {})) {
        for (const e of (Array.isArray(lista) ? lista : [lista])) {
          const s = String(e || '').trim();
          if (s) exts.push(s.startsWith('.') ? `*${s}` : `*.${s}`);
        }
      }
      if (!exts.length) continue;
      const padroes = exts.join(' ');
      grupos.push(t.description ? `${t.description} (${padroes})` : padroes);
    }
    return grupos.length ? grupos.join(';;') : undefined;
  }

  /**
   * `startIn` aceita um handle **ou** um nome bem-conhecido (`'documents'`, `'downloads'`…).
   * Handle nós resolvemos — é só o caminho dele. Nome bem-conhecido dependeria de o shell saber os
   * diretórios XDG do usuário, e ele não sabe; avisar é melhor que abrir noutro lugar calado.
   */
  function dirDeStartIn(startIn) {
    if (!startIn) return undefined;
    const h = startIn.__vsshHandle;
    if (h && h.path) return h.kind === 'directory' ? h.path : h.path.slice(0, h.path.lastIndexOf('/')) || '/';
    if (typeof startIn === 'string') {
      console.warn(
        `[fsa-polyfill] startIn: '${startIn}' é um diretório bem-conhecido, e o shell ainda não os ` +
        'resolve — o seletor abre no lugar de sempre. Passe um handle para escolher onde abrir.');
    }
    return undefined;
  }

  window.showDirectoryPicker = async function (opts = {}) {
    const path = await window.vssh.pickDirectory({
      title: opts.title || 'Escolher pasta',
      dir: dirDeStartIn(opts.startIn),
    });
    if (!path) throw abortError();
    return new VsshDirectoryHandle(path);
  };

  // ── Reabrir, sem seletor, o que já foi concedido ──────────────────────────
  //
  // **A terceira resposta da permissão**: um app pode ter a permissão e
  // não ter o handle. Não é `granted` (ele não tem por onde ler) nem `denied` (ninguém negou nada)
  // — é *"a escolha já foi feita, e a prova dela não veio com você para esta máquina"*.
  //
  // Acontece o tempo todo desde que o grant passou a morar no servidor: os caminhos concedidos
  // atravessam o computador, o IndexedDB do app não. Sem esta função, o app trataria a máquina
  // nova como uma primeira vez e pediria a pasta de novo — com a permissão já viva do outro lado.
  //
  // Não abre seletor, e isso é o padrão sendo respeitado, não contornado: **escolher é consentir**,
  // e a pessoa escolheu. O que falta aqui não é consentimento, é um objeto.
  //
  // O `kind` sai de um `stat`, e não do formato do caminho: um grant é uma string, e adivinhar
  // "termina sem ponto, logo é pasta" erraria em `/home/ana/dados.2024` e em qualquer arquivo sem
  // extensão. O que não existe mais **some da lista** em vez de virar um handle morto — a pasta
  // pode ter sido apagada no servidor desde a concessão.
  fs.grantedHandles = async function () {
    const caminhos = typeof fs.grantedPaths === 'function' ? fs.grantedPaths() : [];
    const out = [];
    for (const p of caminhos) {
      let meta;
      try { meta = await fs.stat(p); } catch { continue; }   // sumiu do servidor: não é handle
      if (!meta) continue;
      const ehDir = meta.type === 'directory' || meta.isDirectory === true || meta.kind === 'directory';
      out.push(ehDir ? new VsshDirectoryHandle(p) : new VsshFileHandle(p, meta));
    }
    return out;
  };

  window.showOpenFilePicker = async function (opts = {}) {
    if (opts.multiple) {
      // Devolver um array de um só, calado, é a pior versão disto: o app recebe a forma certa com
      // o conteúdo errado e segue como se o usuário tivesse escolhido um arquivo.
      console.warn(
        '[fsa-polyfill] showOpenFilePicker({multiple:true}): o seletor do desktop é de escolha ' +
        'ÚNICA, e você vai receber um array de um item. Chame de novo para cada arquivo, ou peça ' +
        'uma pasta com showDirectoryPicker().');
    }
    const path = await window.vssh.pickFile({
      title: opts.title || 'Abrir arquivo',
      filter: filtroDeTypes(opts.types),
      dir: dirDeStartIn(opts.startIn),
    });
    if (!path) throw abortError();
    return [new VsshFileHandle(path)];
  };

  window.showSaveFilePicker = async function (opts = {}) {
    const path = await window.vssh.pickSave({
      title: opts.title || 'Salvar arquivo',
      name: opts.suggestedName,
      filter: filtroDeTypes(opts.types),
      dir: dirDeStartIn(opts.startIn),
    });
    if (!path) throw abortError();
    return new VsshFileHandle(path);
  };

  // A base é a NOSSA, e não a nativa que o Chrome traz. Ver o comentário de `VsshHandle`: com a
  // nativa preservada, `h instanceof FileSystemHandle` era `false` para todo handle real.
  window.FileSystemHandle = VsshHandle;
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

  // ── Os caminhos que leem o File POR DENTRO ─────────────────────────────────
  //
  // Nenhum destes passa por um método nosso: `new Response(f)` e o construtor de `Blob` leem a
  // sequência de bytes interna, e o `FileReader` tem implementação própria. Com respaldo vazio
  // todos devolvem 0 bytes **sem erro** — um upload que sobe um arquivo em branco, uma imagem que
  // não aparece, e nenhum sintoma que aponte para cá.
  //
  // A divisão é dada pelo relógio, não pelo gosto: **onde cabe um `await`, dá para consertar.**
  // `Response`, `Request` e `fetch` aceitam corpo assíncrono; o `FileReader` é assíncrono por
  // natureza. `new Blob([f])` e `FormData.append` são síncronos e leem na hora — esses só podem
  // ficar barulhentos.
  //
  // Todo envelope é passa-adiante para o que não for nosso: um app que nunca tocou na FSA não
  // deve notar diferença nenhuma.

  const ehPreguicosoSemBytes = (v) => v instanceof LazyFile && !v._bytes;

  function avisar(onde) {
    console.warn(
      `[fsa-polyfill] ${onde} lê os bytes de forma síncrona e este File ainda não foi carregado — ` +
      'o resultado sai VAZIO. Faça `await file.arrayBuffer()` (ou `.text()`) antes, ou use ' +
      '`new Blob([await file.arrayBuffer()])`.');
  }

  // `Response`/`Request`: trocar o corpo por `f.stream()` mantém a preguiça — a leitura só
  // acontece quando alguém consumir o corpo. `duplex: 'half'` é exigência do Chrome para corpo em
  // stream no `Request`, e omiti-lo faz o construtor lançar.
  function enveloparCorpo(Classe, ehRequest) {
    if (typeof Classe !== 'function') return Classe;
    return new Proxy(Classe, {
      construct(alvo, args, novoAlvo) {
        const iCorpo = ehRequest ? 1 : 0;
        const corpo = ehRequest ? args[1] && args[1].body : args[0];
        if (corpo instanceof LazyFile) {
          if (ehRequest) args[1] = Object.assign({}, args[1], { body: corpo.stream(), duplex: 'half' });
          else args[iCorpo] = corpo.stream();
        }
        return Reflect.construct(alvo, args, novoAlvo);
      },
    });
  }
  if (typeof Response === 'function') window.Response = enveloparCorpo(Response, false);
  if (typeof Request  === 'function') window.Request  = enveloparCorpo(Request, true);

  // `fetch` é assíncrono do começo ao fim, então aqui dá para fazer o melhor possível: carregar e
  // mandar um `Blob` REAL. Não é o mesmo que o envelope acima — o `fetch` interno do navegador
  // não usa o `window.Request` que remendamos, então sem isto `fetch(url, {body: f})` subiria
  // vazio mesmo com o `Request` envelopado.
  if (typeof fetch === 'function') {
    const origFetch = fetch.bind(window);
    window.fetch = async function (entrada, init) {
      if (init && init.body instanceof LazyFile) {
        const f = init.body;
        init = Object.assign({}, init, { body: new Blob([await f.bytes()], { type: f.type }) });
      }
      return origFetch(entrada, init);
    };
  }

  // `FileReader`: assíncrono por contrato, então o conserto é honesto — carrega e despacha os
  // mesmos eventos que a implementação nativa despacharia, na mesma ordem.
  if (typeof FileReader === 'function') {
    const LEITURAS = {
      readAsText:        (b, ab, enc) => new TextDecoder(enc || 'utf-8').decode(ab),
      readAsArrayBuffer: (b, ab) => ab,
      readAsBinaryString: (b, ab) => Array.from(new Uint8Array(ab), (c) => String.fromCharCode(c)).join(''),
      readAsDataURL:     (b, ab) => {
        let s = '';
        for (const c of new Uint8Array(ab)) s += String.fromCharCode(c);
        return `data:${b.type || 'application/octet-stream'};base64,${btoa(s)}`;
      },
    };
    for (const [metodo, converter] of Object.entries(LEITURAS)) {
      const orig = FileReader.prototype[metodo];
      if (typeof orig !== 'function') continue;
      FileReader.prototype[metodo] = function (blob, extra) {
        if (!(blob instanceof LazyFile)) return orig.call(this, blob, extra);
        const leitor = this;
        // `readyState` e `result` são getters do protótipo nativo; definir na instância é o que
        // permite ao app ler `fr.result` de dentro do `onload`, como ele faria com o nativo.
        const definir = (chave, valor) => Object.defineProperty(leitor, chave, { value: valor, configurable: true });
        definir('readyState', 1 /* LOADING */);
        leitor.dispatchEvent(new ProgressEvent('loadstart'));
        blob.arrayBuffer().then(
          (ab) => {
            definir('result', converter(blob, ab, extra));
            definir('readyState', 2 /* DONE */);
            leitor.dispatchEvent(new ProgressEvent('load'));
            leitor.dispatchEvent(new ProgressEvent('loadend'));
          },
          (e) => {
            definir('error', e);
            definir('readyState', 2);
            leitor.dispatchEvent(new ProgressEvent('error'));
            leitor.dispatchEvent(new ProgressEvent('loadend'));
          });
      };
    }
  }

  // ── Os dois sem conserto: barulho no lugar do silêncio ─────────────────────
  //
  // Quando o conteúdo já foi lido, os dois passam a funcionar de graça — é só trocar o objeto
  // preguiçoso por um `Blob` real. Quando não foi, não há `await` onde encaixar, e o que resta é
  // dizer em voz alta o que acabou de acontecer.

  const BlobOriginal = Blob;
  window.Blob = new Proxy(BlobOriginal, {
    construct(alvo, args, novoAlvo) {
      const partes = args[0];
      if (Array.isArray(partes) && partes.some((p) => p instanceof LazyFile)) {
        args = args.slice();
        args[0] = partes.map((p) => {
          if (!(p instanceof LazyFile)) return p;
          if (p._bytes) return p._bytes;
          avisar('new Blob([file])');
          return p;
        });
      }
      return Reflect.construct(alvo, args, novoAlvo);
    },
  });

  if (typeof FormData === 'function') {
    for (const metodo of ['append', 'set']) {
      const orig = FormData.prototype[metodo];
      if (typeof orig !== 'function') continue;
      FormData.prototype[metodo] = function (nome, valor, nomeDoArquivo) {
        if (valor instanceof LazyFile) {
          if (valor._bytes) {
            valor = new File([valor._bytes], nomeDoArquivo || valor.name, {
              type: valor.type, lastModified: valor.lastModified,
            });
          } else {
            avisar(`FormData.${metodo}()`);
          }
        }
        return nomeDoArquivo === undefined
          ? orig.call(this, nome, valor)
          : orig.call(this, nome, valor, nomeDoArquivo);
      };
    }
  }

  // ── OPFS: o "private" do nome não cobre o caso daqui ───────────────────────
  //
  // `navigator.storage.getDirectory()` **já funciona** — é nativo, e nada aqui precisa
  // implementá-lo. É o que DuckDB-WASM, sqlite-wasm e Pyodide usam para cache local, e é a
  // fundação de metade das ferramentas de dados client-side.
  //
  // O problema é outro, e foi medido num Chrome de verdade
  // (`lib/web/test/fsa-polyfill.browser.test.js`): **OPFS é privado por ORIGEM**, e todos os
  // vssh-apps são servidos pela origem do portal — `/<serverId>/proxy/app/<appId>/`. Então:
  //
  //     app A:  getDirectory() → escreve 'cache.db'
  //     app B:  getDirectory() → LÊ 'cache.db', e pode sobrescrevê-lo
  //
  // O "Origin Private File System" é privado de outros SITES, não de outros APPS. Quem escreve um
  // vssh-app assume a segunda coisa — é o nome que promete isso — e recebe a primeira: o banco
  // sqlite de um app, o cache de pacotes do Pyodide de outro, e nenhum aviso.
  //
  // O conserto é dar a cada app a sua raiz: um subdiretório com o id do app. O handle devolvido é
  // NATIVO — um subdiretório de verdade —, então `createSyncAccessHandle` e o resto continuam
  // funcionando sem nada nosso no caminho.
  //
  // ⚠️ **A regra que sai junto:** [OPFS é cache, nunca a verdade]. O padrão natural do
  // `sqlite-wasm` é usar OPFS como armazenamento primário, e isso perde tudo ao trocar de máquina
  // sem erro nenhum. A verdade vai para o ambiente remoto; OPFS é aceleração reconstruível. Ver
  // docs/api.md.

  /** O id do app, do path que o portal serve: `/<serverId>/proxy/app/<appId>/`. */
  function idDoApp() {
    const seg = location.pathname.split('/').filter(Boolean);
    const i = seg.indexOf('app');
    return (i > 0 && seg[i - 1] === 'proxy' && seg[i + 1]) ? seg[i + 1] : null;
  }

  if (navigator?.storage?.getDirectory) {
    const appId = idDoApp();
    if (appId) {
      const raizReal = navigator.storage.getDirectory.bind(navigator.storage);
      // Só quando dá para identificar o app. Fora do proxy — `npm run dev`, um teste, uma página
      // solta — não há outro app com quem colidir, e inventar um nome de pasta ali esconderia o
      // armazenamento de quem estava desenvolvendo contra ele.
      navigator.storage.getDirectory = async function () {
        const raiz = await raizReal();
        return raiz.getDirectoryHandle(`vssh-app-${appId}`, { create: true });
      };
    }
  }

  // ── Persistência em IndexedDB ──────────────────────────────────────────────
  //
  // Um handle é objeto com métodos, e structured clone descarta métodos. Sem este envelope, o
  // app guarda o handle, recarrega a página, lê de volta um objeto morto e conclui que a pasta
  // está vazia. `__vsshHandle` é plain data e sobrevive ao clone; aqui só reconstruímos a classe
  // na leitura, para o app receber de volta algo que responde às mesmas chamadas.
  const rawResult = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result').get;

  // Envelopa um método que devolve IDBRequest, reidratando o `result`. Antes isto existia duas
  // vezes, copiado, e só sobre `IDBObjectStore` — o que fazia a cobertura ser questão de sorte:
  // o primeiro app portado usava `get` na raiz e funcionava; qualquer app que guardasse handle
  // num índice leria de volta um objeto morto.
  function hookRequest(proto, method) {
    const orig = proto?.[method];
    if (typeof orig !== 'function') return;   // navegador sem o método: nada a envelopar
    proto[method] = function (...args) {
      const req = orig.apply(this, args);
      let cached;
      Object.defineProperty(req, 'result', {
        configurable: true,
        get() {
          if (cached === undefined) cached = rehydrate(rawResult.call(this));
          return cached;
        },
      });
      return req;
    };
  }

  // `getAllKeys` fica de fora DE PROPÓSITO: chave é chave, não handle. Está documentado em
  // docs/api.md, para não virar mais um caso de "não suportado" indistinguível de "não testado".
  for (const proto of [
    typeof IDBObjectStore !== 'undefined' ? IDBObjectStore.prototype : null,
    typeof IDBIndex !== 'undefined' ? IDBIndex.prototype : null,
  ]) {
    if (!proto) continue;
    hookRequest(proto, 'get');
    hookRequest(proto, 'getAll');
  }

  // Cursores precisam de outro tratamento: o `result` da requisição é o CURSOR, não o valor, e o
  // `value` dele muda a cada `continue()`. Então o getter vai na instância do cursor e não pode
  // cachear — cachear devolveria o primeiro registro para sempre.
  const cursorValue = typeof IDBCursorWithValue !== 'undefined'
    ? Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value')?.get
    : null;

  function hookCursor(proto, method) {
    const orig = proto?.[method];
    if (typeof orig !== 'function' || !cursorValue) return;
    proto[method] = function (...args) {
      const req = orig.apply(this, args);
      Object.defineProperty(req, 'result', {
        configurable: true,
        get() {
          const cursor = rawResult.call(this);
          if (!cursor || cursor.__vsshValueHooked) return cursor;
          cursor.__vsshValueHooked = true;
          Object.defineProperty(cursor, 'value', {
            configurable: true,
            get() { return rehydrate(cursorValue.call(this)); },
          });
          return cursor;
        },
      });
      return req;
    };
  }

  for (const proto of [
    typeof IDBObjectStore !== 'undefined' ? IDBObjectStore.prototype : null,
    typeof IDBIndex !== 'undefined' ? IDBIndex.prototype : null,
  ]) {
    if (!proto) continue;
    hookCursor(proto, 'openCursor');
  }
})();
