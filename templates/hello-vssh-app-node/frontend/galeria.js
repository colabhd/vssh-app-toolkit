'use strict';

// A galeria — uma peça por capacidade do ambiente.
//
// Este arquivo é o par de `index.html` e existe separado dele por um motivo prático: a marcação
// diz o que cada peça PROVA, e o código mostra o idioma que você vai copiar. Misturar os dois num
// arquivo só fazia a explicação sumir dentro do script.
//
// Três coisas valem para tudo aqui embaixo:
//
//   1. **URLs relativas, sempre.** O app é servido sob `/<serverId>/proxy/app/<id>/`, então uma
//      barra no começo aponta para a raiz do portal, não para o app.
//   2. **`vssh` não é `import`.** Ele vem do shim, injetado pelo `static-spa` antes do `</head>`
//      (ver `injectScripts` em backend/server.js). Se ele não existir, a lib não está sendo
//      SERVIDA — quase sempre por ter sido vendorizada fora da raiz do frontend.
//   3. **Ausência não é erro.** Shell e apps são publicados à parte, então um app novo pode rodar
//      contra um shell antigo. Toda peça pergunta antes de usar, e diz o que falta em vez de
//      estourar um `undefined` que leva junto tudo que vinha depois.

// Este arquivo é INJETADO (ver `injectScripts` em backend/server.js), e não uma `<script src>`
// escrita no HTML. A diferença é o CARIMBO: o static-spa põe o hash do CONTEÚDO na URL do que
// injeta, então conteúdo novo mora noutra URL e nenhum cache do caminho pode servir o velho no
// lugar. Uma tag comum dependeria de revalidação por Last-Modified — o elo fraco que produz
// "atualizei o app e nada mudou".
//
// O preço é que ele roda antes do `</head>`, com o `<body>` ainda inexistente: daí a espera pelo
// DOM. Sem ela, todo `getElementById` devolveria null e a página ficaria inerte, sem um erro.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', montarGaleria, { once: true });
} else {
  montarGaleria();
}

function montarGaleria() {
  // ── O painel: a MESMA página servindo outra coisa ──────────────────────────
  //
  // A janela extra abre `?painel=1`, e é aqui que ela deixa de ser uma cópia. Um app real teria
  // uma rota própria (ou o roteador da SPA dele); num template de um arquivo, um parâmetro basta
  // para o ponto: o que muda entre as duas janelas é a VISÃO, não o processo — o contador abaixo
  // é o mesmo do backend, e mexer nele daqui mexe na janela grande.
  if (new URLSearchParams(location.search).has('painel')) return montarPainel();

  const $ = (id) => document.getElementById(id);
  const escrever = (id, texto) => { $(id).textContent = texto; };
  const falhar = (id, err) => { $(id).textContent = 'erro: ' + (err?.message || err); };

  // ── Ambiente ─────────────────────────────────────────────────────────────────
  //
  // A primeira peça, e a que responde "por que aquilo ali não funciona". `libVersion` é síncrona (é
  // um literal dentro do shim vendorizado NESTE app); `capabilities()` pergunta ao shell, e é ela
  // que traz a versão DELE. As duas juntas são o diagnóstico: se divergirem muito, o app está
  // pedindo coisas que o shell daquele servidor ainda não sabe fazer.
  (async () => {
    if (typeof vssh === 'undefined') {
      escrever('ambiente',
        'vssh AUSENTE: o shim não foi servido.\n' +
        'Confira, em backend/server.js, o `mounts` e o `injectScripts` — e se o `npm ci` rodou '
        + '(o shim vem de node_modules/vssh-app-toolkit). Tudo que depende da ponte está desligado nesta página.');
      return;
    }

    const linhas = [
      `dentro do desktop: ${vssh.inDesktop}`,
      `lib do app (vendorizada): ${vssh.libVersion || 'desconhecida'}`,
    ];
    try {
      const cap = await vssh.capabilities();
      // Fora do desktop não há shell nenhum — dizer "shell antigo" ali seria diagnosticar um
      // problema que não existe. `shellVersion: null` tem duas causas e elas pedem ações opostas.
      linhas.push(vssh.inDesktop
        ? `shell do servidor: ${cap.shellVersion || 'não informada — shell anterior à Onda 3'}`
        : 'shell do servidor: nenhum — esta página está fora do desktop');
      linhas.push(`host: ${cap.host} · apps nativos: ${cap.nativeApps} · interop X11: ${cap.x11Interop}`);
    } catch (e) {
      linhas.push('capabilities() falhou: ' + e.message);
    }
    linhas.push(`File System Access: ${typeof showDirectoryPicker === 'function' ? 'disponível' : 'ausente (polyfill não injetado?)'}`);
    escrever('ambiente', linhas.join('\n'));
  })();

  // ── Backend próprio ──────────────────────────────────────────────────────────

  // ── O que o ambiente decidiu por este app ───────────────────────────────────
  //
  // Lida no boot, e não só no clique: as três respostas valem para ESTA execução do processo, e a
  // mais comum delas ("o segredo ainda não chegou porque o app não reiniciou") só faz sentido se
  // estiver na tela antes de alguém procurar por ela.
  async function lerRuntime() {
    escrever('runtimeout', 'lendo...');
    try {
      const r = await fetch('api/runtime');
      const d = await r.json();
      const linhas = [
        `limite  ${d.limites?.contido === true ? `APLICADO — memory.max=${d.limites.memoryMax}`
          : d.limites?.contido === false ? `NÃO aplicado (memory.max=${d.limites.memoryMax || '—'})`
          : `não sei — ${d.limites?.motivo || 'sem resposta'}`}`,
        d.limites?.memoryCurrent ? `        usando agora: ${d.limites.memoryCurrent} bytes` : null,
        `GPU     ${!d.gpu?.sei ? `não sei — ${d.gpu?.motivo || 'sem resposta'}` : d.gpu.resumo}`,
        d.gpu?.sei && d.gpu.dispositivos.length
          ? d.gpu.dispositivos.map((g) =>
              `        ${g.card}: ${g.fabricante} ${g.vendor || ''} driver=${g.driver || '—'}` +
              `${g.virtual ? ' (virtual)' : ''} acesso=${g.acesso}`).join('\n')
          : null,
        // Reportado ao LADO do inventário de propósito. Sozinha, a string vazia é ambígua: ela é o
        // mesmo valor para "o ambiente escondeu de mim" e para "não há placa nenhuma".
        `CUDA    CUDA_VISIBLE_DEVICES=${JSON.stringify(d.gpu?.cudaVisibleDevices)}` +
          `${d.gpu?.cudaVisibleDevices === '' ? ' — escondida deste app (ele não pediu gpu)' : ''}`,
        `cofre   ${d.segredo?.definido
          ? `HELLO_SEGREDO chegou (${d.segredo.tamanho} caracteres, sha256 ${d.segredo.sha256}…)`
          : d.segredo?.leitura}`,
        // O caso do meio merece destaque, porque é o que parece defeito e não é: guardado no cofre
        // e ausente do ambiente significa só que o processo é mais velho que o segredo.
        d.segredo?.noCofre ? '        ↑ o cofre TEM o valor; falta este processo reiniciar' : null,
        '',
        JSON.stringify(d, null, 2),
      ].filter((l) => l !== null);
      escrever('runtimeout', linhas.join('\n'));
    } catch (e) { falhar('runtimeout', e); }
  }
  $('runtime').addEventListener('click', lerRuntime);
  lerRuntime();

  // O benchmark. Botão desabilitado enquanto roda: ele leva segundos e queima CPU, e dois cliques
  // seguidos mediriam um contra o outro.
  $('bench').addEventListener('click', async (ev) => {
    const b = ev.currentTarget; const antes = b.textContent;
    b.disabled = true; b.textContent = 'medindo…';
    escrever('runtimeout', 'codificando o mesmo vídeo em CPU e em GPU…');
    try {
      const r = await fetch('api/gpu/benchmark', { method: 'POST' });
      const d = await r.json();
      escrever('runtimeout', d.rodou
        ? [
            d.leitura,
            '',
            `cpu   ${d.cpu.ok ? `${d.cpu.ms} ms · ${d.cpu.fps} fps` : `falhou: ${d.cpu.erro}`}`,
            `gpu   ${d.gpu.ok ? `${d.gpu.ms} ms · ${d.gpu.fps} fps` : `falhou: ${d.gpu.erro}`}`,
            `nó    ${d.renderNode || '—'}`,
            // O que a placa DIZ que sabe fazer, quando o encode falhou e o `vainfo` existe. É a
            // resposta à pergunta seguinte — "então ela serve para quê?" — em vez de um beco.
            d.capacidades?.tem
              ? `\nvainfo (codifica: ${d.capacidades.codifica ? 'sim' : 'NÃO'}):\n` +
                d.capacidades.entrypoints.map((l) => `      ${l}`).join('\n')
              : d.capacidades ? `\nvainfo não respondeu: ${d.capacidades.motivo}` : null,
          ].filter((l) => l !== null).join('\n')
        : `não deu para medir — ${d.motivo}`);
    } catch (e) { falhar('runtimeout', e); }
    b.disabled = false; b.textContent = antes;
  });

  // O segredo, pedido DE DENTRO DO APP. É a correção de desenho: quem sabe que falta credencial —
  // e sabe na hora em que falta — é o app, não a tela de Configurações. O valor não passa por aqui.
  $('segredo').addEventListener('click', async () => {
    if (!window.vssh?.secrets) return escrever('runtimeout', 'sem ponte com o desktop (dev local).');
    escrever('runtimeout', 'pedindo o segredo ao desktop…');
    try {
      const r = await vssh.secrets.set('HELLO_SEGREDO', {
        description: 'Qualquer texto. Serve para demonstrar o cofre: ele vai para o SEU servidor e ' +
                     'volta para este app como variável de ambiente.',
      });
      if (r === null) return escrever('runtimeout', 'cofre indisponível fora do desktop.');
      if (r.cancelado) return escrever('runtimeout', 'você cancelou — e cancelar é resposta, não erro.');
      escrever('runtimeout',
        `guardado. Agora em ${r.names.length} segredo(s): ${r.names.join(', ')}\n\n` +
        (r.requerReinicio
          ? 'REINICIE o app para recebê-lo: o ambiente de um processo é fixado no start.'
          : ''));
    } catch (e) { falhar('runtimeout', e); }
  });

  $('ping').addEventListener('click', async () => {
    escrever('out', 'chamando...');
    try {
      const r = await fetch('api/ping');
      escrever('out', JSON.stringify(await r.json(), null, 2));
    } catch (e) { falhar('out', e); }
  });

  // ── SSE, e a difusão que faz a peça das duas janelas funcionar ───────────────

  $('sub').addEventListener('click', (e) => {
    e.target.disabled = true;
    const src = new EventSource('api/events');
    src.addEventListener('tick', (m) => escrever('events', m.data));
    // O mesmo stream carrega o estado compartilhado: quem incrementa é uma janela, e a difusão
    // alcança todas. É por isso que o contador muda na janela em que você NÃO clicou.
    src.addEventListener('estado', (m) => mostrarEstado(JSON.parse(m.data)));
    src.onerror = () => {
      escrever('events', 'conexão SSE caiu');
      src.close();
      e.target.disabled = false;
    };
  });

  // ── Duas janelas, um backend ─────────────────────────────────────────────────

  function mostrarEstado(s) {
    escrever('estado',
      `contador: ${s.contador}\njanelas conectadas (SSE): ${s.conexoes}\nbackend subiu em: ${s.subiuEm}`);
  }

  $('somar').addEventListener('click', async () => {
    try {
      const r = await fetch('api/estado/incrementar', { method: 'POST' });
      mostrarEstado(await r.json());
    } catch (e) { falhar('estado', e); }
  });

  $('reler').addEventListener('click', async () => {
    try {
      const r = await fetch('api/estado');
      mostrarEstado(await r.json());
    } catch (e) { falhar('estado', e); }
  });

  // A janela EXTRA — o app pedindo, e escolhendo o que vai dentro. Fica aqui, e não no bloco da
  // ponte lá embaixo, porque é desta peça que ela fala; o `vssh` ausente é tratado na hora do
  // clique, com a explicação no lugar onde a pessoa está olhando.
  $('extra').addEventListener('click', async () => {
    if (typeof vssh === 'undefined') {
      escrever('estado', 'sem o shim não há a quem pedir a janela — veja a peça "Ambiente".');
      return;
    }
    const ok = await vssh.window.abrir('?painel=1', {
      title: 'Painel — Hello World', width: 380, height: 330,
    });
    escrever('estado', ok
      ? 'painel aberto: outra janela, do MESMO backend. Some 1 aqui e olhe lá — e vice-versa.'
      : 'este shell ainda não sabe abrir janela extra (é anterior a esta capacidade). '
        + 'O menu de contexto da janela → "Nova janela" abre uma CÓPIA, que é o que existe nele.');
  });

  // ── Daqui para baixo tudo depende da ponte ───────────────────────────────────

  if (typeof vssh === 'undefined') {
    escrever('bridge', 'sem o shim não há ponte — veja a peça "Ambiente".');
  } else {

    escrever('bridge', vssh.inDesktop
      ? 'dentro do desktop VSSH — diálogos e avisos são os do shell'
      : 'fora do desktop — o shim degrada para alert/confirm do navegador');

    // O aviso efêmero: some em segundos e NÃO entra no histórico. A `chave` faz o segundo
    // clique reescrever o primeiro em vez de empilhar um aviso novo.
    $('toast').addEventListener('click', () => {
      vssh.toast('Copiado', { chave: 'exemplo' });
      escrever('bridge', 'toast: aparece e some. Olhe o sino — não há nada lá.');
    });

    // O FATO: fica no sino até ser lido, com o id deste app como dono.
    $('notify').addEventListener('click', () => {
      vssh.notify('Round-trip concluído', { title: 'Hello World', level: 'success' });
      escrever('bridge', 'notify: abra o sino — está lá, e continua lá amanhã.');
    });

    // `prioridade: 'alta'` = não some sozinho, porque pede resposta. A ação é DADO (id +
    // rótulo); a resposta volta como `notify-action`, tratada mais abaixo.
    $('notify-acao').addEventListener('click', () => {
      vssh.notify('Não consegui falar com o servidor de índices.', {
        title: 'Hello World', level: 'error', prioridade: 'alta',
        chave: 'indice:falhou',
        actions: [{ id: 'retry', label: 'Tentar de novo' }],
      });
      escrever('bridge', 'notify de prioridade alta: não some sozinho, e pode ser respondido depois.');
    });

    $('confirm').addEventListener('click', async () => {
      const ok = await vssh.dialog.confirm('Isto veio do desktop, não do navegador. Confirma?');
      escrever('bridge', 'confirm devolveu: ' + ok);
    });

    // ── O que está acontecendo agora ────────────────────────────────────────────
    //
    // O ciclo inteiro num só lugar: `set` a cada passo (a mesma chave reescreve no lugar), e
    // `clear` no fim. Com `registrar`, o fim vira UMA notificação; sem, a atividade só some —
    // que é o certo para uma condição que deixou de valer e não é um fato a guardar.

    let _liveTimer = null;

    const pararLive = (registrar) => {
      clearInterval(_liveTimer);
      _liveTimer = null;
      vssh.live.clear('exemplo', registrar ? { registrar } : undefined);
    };

    $('live-ir').addEventListener('click', () => {
      if (_liveTimer) return;
      const total = 10;
      let feito = 0;
      const passo = () => {
        feito++;
        vssh.live.set('exemplo', {
          titulo: 'Processando',
          texto: `item ${feito}`,
          formato: 'progresso',
          progresso: { feito, total },
        });
        escrever('live', `${feito} de ${total} — olhe a bandeja e o painel do sino`);
        if (feito >= total) {
          pararLive({ titulo: 'Processamento concluído', texto: `${total} itens`, level: 'success' });
          escrever('live', 'acabou: a atividade sumiu, e deixou UMA notificação no sino');
        }
      };
      passo();
      _liveTimer = setInterval(passo, 700);
    });

    $('live-parar').addEventListener('click', () => {
      pararLive(null);
      escrever('live', 'desisti: a atividade sumiu SEM deixar rastro nenhum');
    });

    // O MESMO ciclo, do outro lado: quem escreve é o backend, por arquivo, e funciona com esta
    // janela fechada — que é o caso que um `kind:"service"` vive.
    $('live-backend').addEventListener('click', async () => {
      const r = await fetch('api/tarefa-longa', { method: 'POST' }).then(x => x.json());
      escrever('live', `o backend começou ${r.total} passos — feche esta janela e olhe a bandeja`);
    });

    $('avisar-backend').addEventListener('click', async () => {
      const r = await fetch('api/avisar', { method: 'POST' }).then(x => x.json());
      escrever('live', `notificado com key “${r.key}” — clicar de novo hoje NÃO gera outra`);
    });

    // ── Bandeja ────────────────────────────────────────────────────────────────
    //
    // `onClick`/`onMenu` ficam aqui e não atravessam a ponte: função não serializa. O shell devolve
    // só o id do item; quem sabe o que ele significa é o app.
    let pendentes = 0;

    const mostrarNaBandeja = async () => {
      const ok = await vssh.tray.set({
        icon:    'refresh',
        tooltip: pendentes ? `Hello World — ${pendentes} pendente(s)` : 'Hello World — ocioso',
        badge:   { count: pendentes },      // count 0 remove o badge, não desenha um "0"
        menu: [
          { id: 'focus', label: 'Trazer a janela para a frente', icon: 'launch' },
          { separator: true },
          { id: 'reset', label: 'Zerar contador', icon: 'refresh', danger: true },
        ],
        onClick: () => escrever('tray', 'clique esquerdo no ícone da bandeja'),
        onMenu:  (id) => {
          escrever('tray', 'menu da bandeja: ' + id);
          if (id === 'focus') vssh.window.focus();
          if (id === 'reset') { pendentes = 0; mostrarNaBandeja(); }
        },
      });
      // `false` não é erro: é "este ambiente não tem bandeja" — fora do desktop, ou num shell mais
      // antigo que este app. Trate e siga.
      escrever('tray', ok ? `na bandeja (badge: ${pendentes})` : 'sem bandeja neste ambiente');
    };

    $('tray-on').addEventListener('click', mostrarNaBandeja);
    $('tray-bump').addEventListener('click', () => { pendentes++; mostrarNaBandeja(); });
    $('tray-off').addEventListener('click', async () => {
      await vssh.tray.remove();
      pendentes = 0;
      escrever('tray', 'removido da bandeja');
    });

    // ── Impressão ──────────────────────────────────────────────────────────────
    //
    // Duas chamadas, e a primeira dá sentido à segunda: `pickFile` é onde o usuário escolhe. `print`
    // resolve quando a tela ABRE, não quando o usuário imprime — o app não fica sabendo o que foi
    // impresso, e não precisa.
    $('print').addEventListener('click', async () => {
      const path = await vssh.pickFile({ title: 'Escolha um arquivo para imprimir' });
      if (!path) { escrever('printout', 'cancelado no seletor'); return; }
      const abriu = await vssh.print(path);
      escrever('printout', abriu
        ? `tela de impressão aberta para ${path}`
        : 'vssh.print devolveu false — fora do desktop, ou shell sem suporte a impressão');
    });

    // ── Arquivos do usuário: File System Access ────────────────────────────────
    //
    // O handle vai para o IndexedDB porque é assim que um app real reabre o mesmo grafo depois de um
    // reload. Um handle é objeto com métodos e structured clone descarta métodos — quem reidrata na
    // leitura é o polyfill, envelopando `IDBObjectStore.get`. Por isso este código é o mesmo que
    // você escreveria num navegador, sem nada de especial.
    const NOME = 'vssh-galeria.txt';
    const NOME2 = 'vssh-galeria-renomeado.txt';
    let pasta = null;
    let arquivo = NOME;

    const idb = {
      abrir: () => new Promise((ok, nao) => {
        const r = indexedDB.open('galeria', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('handles');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => nao(r.error);
      }),
      async guardar(chave, valor) {
        const db = await idb.abrir();
        return new Promise((ok, nao) => {
          const t = db.transaction('handles', 'readwrite');
          t.objectStore('handles').put(valor, chave);
          t.oncomplete = () => ok();
          t.onerror = () => nao(t.error);
        });
      },
      async ler(chave) {
        const db = await idb.abrir();
        return new Promise((ok, nao) => {
          const r = db.transaction('handles').objectStore('handles').get(chave);
          r.onsuccess = () => ok(r.result);
          r.onerror = () => nao(r.error);
        });
      },
    };

    const botoesDePasta = ['fsa-listar', 'fsa-escrever', 'fsa-ler', 'fsa-mover', 'fsa-apagar', 'fsa-permissao'];
    const habilitar = (ligado) => botoesDePasta.forEach((id) => { $(id).disabled = !ligado; });

    async function adotar(handle, origem) {
      pasta = handle;
      habilitar(true);
      // `queryPermission` responde de verdade — 'granted' ou 'prompt', consultando o shell. Não
      // presuma 'granted' só porque o handle voltou do IndexedDB: o usuário pode ter revogado.
      const estado = await pasta.queryPermission({ mode: 'readwrite' });
      escrever('fsa', `pasta: ${pasta.name} (${origem})\npermissão: ${estado}`);
    }

    $('fsa-pick').addEventListener('click', async () => {
      try {
        // Escolher É consentir — não há segunda confirmação. Quem abre o seletor é o desktop.
        const h = await showDirectoryPicker({ mode: 'readwrite' });
        await idb.guardar('pasta', h);
        await adotar(h, 'escolhida agora, e guardada no IndexedDB');
      } catch (e) {
        escrever('fsa', e?.name === 'AbortError' ? 'cancelado no seletor' : 'erro: ' + e.message);
      }
    });

    $('fsa-listar').addEventListener('click', async () => {
      try {
        const itens = [];
        for await (const [nome, h] of pasta.entries()) {
          itens.push(`${h.kind === 'directory' ? '📁' : '📄'} ${nome}`);
          if (itens.length >= 30) { itens.push('… (cortado em 30)'); break; }
        }
        escrever('fsa', `${pasta.name} — ${itens.length} entrada(s):\n` + (itens.join('\n') || '(vazia)'));
      } catch (e) { falhar('fsa', e); }
    });

    $('fsa-escrever').addEventListener('click', async () => {
      try {
        const fh = await pasta.getFileHandle(arquivo, { create: true });
        const w = await fh.createWritable();
        await w.write(`escrito pela galeria em ${new Date().toISOString()}\n`);
        await w.close();
        escrever('fsa', `${arquivo} gravado em ${pasta.name}`);
      } catch (e) { falhar('fsa', e); }
    });

    $('fsa-ler').addEventListener('click', async () => {
      try {
        const fh = await pasta.getFileHandle(arquivo);
        const f = await fh.getFile();
        escrever('fsa', `${arquivo} — ${f.size} bytes, ${new Date(f.lastModified).toLocaleString()}\n\n${await f.text()}`);
      } catch (e) { falhar('fsa', e); }
    });

    // `move()` não é do padrão original — é a parte de FileSystemHandle que o Chrome implementa e
    // que apps portados usam para renomear sem reescrever o arquivo inteiro. O handle é atualizado
    // no lugar: o mesmo objeto passa a apontar para o nome novo.
    $('fsa-mover').addEventListener('click', async () => {
      try {
        const fh = await pasta.getFileHandle(arquivo);
        const destino = arquivo === NOME ? NOME2 : NOME;
        await fh.move(destino);
        arquivo = destino;
        escrever('fsa', `renomeado para ${arquivo} — e o handle continua válido (${fh.name})`);
      } catch (e) { falhar('fsa', e); }
    });

    // `removeEntry` de uma PASTA não vazia falha sem `{ recursive: true }`, e isso é deliberado: a
    // rota de baixo é um `rm -rf`, então apagar em silêncio uma pasta cheia era perda de dado sem
    // desfazer. Aqui é arquivo, mas vale conhecer o guarda-corpo.
    $('fsa-apagar').addEventListener('click', async () => {
      try {
        await pasta.removeEntry(arquivo);
        escrever('fsa', `${arquivo} apagado`);
        arquivo = NOME;
      } catch (e) { falhar('fsa', e); }
    });

    // `requestPermission()` reabre o seletor, e por isso precisa de um GESTO do usuário — sem gesto
    // ele devolve 'prompt' sem abrir nada, que é a regra do navegador. Se a pessoa escolher outra
    // pasta, a resposta é 'denied' e o handle antigo continua fora. 'denied' é estado normal.
    $('fsa-permissao').addEventListener('click', async () => {
      try {
        const r = await pasta.requestPermission({ mode: 'readwrite' });
        escrever('fsa', `requestPermission devolveu: ${r}`);
      } catch (e) { falhar('fsa', e); }
    });

    // Reabre sozinho o que ficou de antes — é o caso real de um editor que volta no mesmo grafo.
    idb.ler('pasta')
      .then((h) => { if (h && typeof h.queryPermission === 'function') return adotar(h, 'restaurada do IndexedDB'); })
      .catch(() => {});

    // ── A ponte `vssh.fs`, por caminho ─────────────────────────────────────────

    let alvo = null;
    let pararWatch = null;
    const botoesDeCaminho = ['fs-exists', 'fs-copy', 'fs-rename', 'fs-watch'];

    $('fs-pick').addEventListener('click', async () => {
      alvo = await vssh.pickFile({ title: 'Escolha um arquivo para exercitar vssh.fs' });
      if (!alvo) { escrever('fs', 'cancelado no seletor'); return; }
      botoesDeCaminho.forEach((id) => { $(id).disabled = false; });
      escrever('fs', alvo);
    });

    $('fs-exists').addEventListener('click', async () => {
      try {
        escrever('fs', `exists(${alvo}) → ${await vssh.fs.exists(alvo)}\n` +
                       `exists(${alvo}.nao-existe) → ${await vssh.fs.exists(alvo + '.nao-existe')}`);
      } catch (e) { falhar('fs', e); }
    });

    // Origem e destino precisam AMBOS estar concedidos, e quem impõe isso é o shell. Como os dois
    // caminhos aqui moram na mesma pasta que o usuário escolheu no seletor, os dois estão dentro.
    $('fs-copy').addEventListener('click', async () => {
      try {
        await vssh.fs.copy(alvo, alvo + '.bak', { overwrite: true });
        escrever('fs', `copiado para ${alvo}.bak`);
      } catch (e) { falhar('fs', e); }
    });

    // Sem `{ overwrite: true }` um destino existente FALHA, de propósito: perder arquivo em
    // silêncio não tem desfazer.
    $('fs-rename').addEventListener('click', async () => {
      try {
        await vssh.fs.rename(alvo + '.bak', alvo + '.bak2');
        escrever('fs', `${alvo}.bak → ${alvo}.bak2`);
      } catch (e) { falhar('fs', e); }
    });

    $('fs-watch').addEventListener('click', async () => {
      if (pararWatch) {
        pararWatch(); pararWatch = null;
        $('fs-watch').textContent = 'watch';
        escrever('fs', 'watch cancelado — o vigia do servidor foi solto');
        return;
      }
      try {
        escrever('fs', `vigiando ${alvo} — altere o arquivo por fora (outro editor, um git pull)`);
        pararWatch = await vssh.fs.watch(alvo, ({ path, closed }) => {
          escrever('fs', closed ? `a assinatura de ${path} acabou` : `mudou por fora: ${path} (${new Date().toLocaleTimeString()})`);
        });
        $('fs-watch').textContent = 'parar watch';
      } catch (e) { falhar('fs', e); }
    });

    // Cancelar quando a página morre não é higiene opcional: cada watch segura um vigia vivo do
    // outro lado, e há teto por usuário.
    window.addEventListener('pagehide', () => pararWatch?.());

    // ── OPFS ───────────────────────────────────────────────────────────────────
    //
    // O armazenamento privado do navegador é por ORIGEM, e todo vssh-app vive na mesma. O shim
    // confina cada app numa raiz `vssh-app-<id>` — sem isso, este app abriria o `cache.db` do
    // vizinho, e o pior caso não é ler: é gravar.
    const opfs = () => navigator.storage.getDirectory();

    // O namespace só existe quando dá para identificar o app pela URL — ou seja, sob o proxy do
    // portal. Rodando solto (`node backend/server.js` na sua máquina) a raiz é a da origem, sem
    // nome: ali não há outro app com quem colidir, e inventar uma pasta esconderia o
    // armazenamento de quem está desenvolvendo contra ele.
    const nomeDaRaiz = (raiz) => raiz.name || '(raiz da origem — fora do proxy não há namespace)';

    $('opfs-escrever').addEventListener('click', async () => {
      try {
        const raiz = await opfs();
        const fh = await raiz.getFileHandle('anotacao.txt', { create: true });
        const w = await fh.createWritable();
        await w.write(`gravado em ${new Date().toISOString()}`);
        await w.close();
        escrever('opfs', `gravado em anotacao.txt\nraiz: ${nomeDaRaiz(raiz)}`);
      } catch (e) { falhar('opfs', e); }
    });

    $('opfs-ler').addEventListener('click', async () => {
      try {
        const raiz = await opfs();
        const f = await (await raiz.getFileHandle('anotacao.txt')).getFile();
        escrever('opfs', `raiz: ${nomeDaRaiz(raiz)}\n${await f.text()}`);
      } catch (e) { falhar('opfs', e); }
    });

    // ── Som ────────────────────────────────────────────────────────────────────
    //
    // Repare no que NÃO tem aqui: nenhuma chamada a `vssh.audio` para OBEDECER ao mixer. O app toca
    // do jeito mais banal possível e obedece ao slider assim mesmo. `vssh.audio` é só a leitura.

    // Um segundo de senoide em memória, em loop. Um arquivo de áudio no pacote seria mais simples de
    // ler, mas o template não deve carregar binário só para demonstrar.
    const tomWav = (hz = 220, taxa = 8000) => {
      const n = taxa, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
      const txt = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      txt(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); txt(8, 'WAVEfmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, taxa, true); dv.setUint32(28, taxa * 2, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      txt(36, 'data'); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(2 * Math.PI * hz * i / taxa) * 6000, true);
      return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    };

    let el = null;
    $('som-media').addEventListener('click', (e) => {
      if (el) { el.pause(); el.remove(); el = null; e.target.textContent = 'tocar um <audio>'; relatarSom(); return; }
      el = new Audio(tomWav(220));
      el.loop = true;
      el.volume = 0.5;          // "metade do MEU volume máximo"
      document.body.appendChild(el);
      el.play();
      e.target.textContent = 'parar o <audio>';
      relatarSom();
    });

    let ctx = null, osc = null;
    $('som-wa').addEventListener('click', (e) => {
      if (osc) { osc.stop(); osc.disconnect(); osc = null; e.target.textContent = 'tocar por AudioContext'; relatarSom(); return; }
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume();
      const g = ctx.createGain();
      g.gain.value = 0.15;      // senoide crua é agressiva; isto é do APP, não do ambiente
      osc = ctx.createOscillator();
      osc.frequency.value = 330;
      osc.connect(g);
      g.connect(ctx.destination);   // ← é ESTA linha que o shim intercepta
      osc.start();
      e.target.textContent = 'parar o AudioContext';
      relatarSom();
    });

    // O ambiente MULTIPLICA: quem lê `el.volume` continua vendo o valor que o app pediu, e o que sai
    // pelo alto-falante é o produto dos dois. Se fosse sobrescrita, o próximo `el.volume = 1` do app
    // desfaria o mixer em silêncio.
    const temAudio = typeof vssh.audio !== 'undefined';
    function relatarSom() {
      const meu = el ? ` · o app pediu el.volume=${el.volume}` : '';
      if (!temAudio) {
        escrever('audio', 'este shim é anterior à Onda 2.5 e não tem vssh.audio — o mixer do desktop '
          + 'NÃO controla este app. Rode `npm i github:colabhd/vssh-app-toolkit#v4`, '
          + 'commite o lock e reinstale.' + meu);
        return;
      }
      escrever('audio', `ambiente: gain=${vssh.audio.gain().toFixed(2)} mudo=${vssh.audio.muted()}${meu}`);
    }
    if (temAudio) vssh.audio.onChange(relatarSom);
    relatarSom();
  }
}

/**
 * A janela extra: pequena, com uma coisa só, e ligada ao mesmo processo.
 *
 * Ela não usa os helpers da galeria de propósito — não há `#ping` nem `#fsa` aqui, e procurar por
 * eles devolveria null. Um app de verdade teria rota e componentes próprios; o que importa para a
 * demonstração é que esta janela mostra OUTRA COISA e mesmo assim compartilha o backend.
 */
function montarPainel() {
  document.title = 'Painel — Hello World';
  document.body.innerHTML = `
    <section style="border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:1rem;
                    display:flex;flex-direction:column;gap:.6rem">
      <h2 style="margin:0;font-size:1.05rem">Painel</h2>
      <p style="margin:0;opacity:.75;font-size:.92em">
        Esta janela é <strong>outra</strong>, não uma cópia — e o contador abaixo é o mesmo
        processo da janela grande. Some aqui e olhe lá.
      </p>
      <div style="font:600 2.4rem/1 system-ui;letter-spacing:-.02em" id="p-contador">—</div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button id="p-somar" style="font:inherit;padding:.4rem .8rem;border-radius:6px;
                border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer">somar 1</button>
        <button id="p-fechar" style="font:inherit;padding:.4rem .8rem;border-radius:6px;
                border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer">fechar</button>
      </div>
      <pre id="p-estado" style="margin:0;padding:.6rem .8rem;border-radius:6px;font-size:.85em;
           background:rgba(127,127,127,.12);white-space:pre-wrap">conectando…</pre>
    </section>`;

  const num = document.getElementById('p-contador');
  const nota = document.getElementById('p-estado');
  const pintar = (s) => {
    num.textContent = s.contador;
    nota.textContent = `janelas conectadas: ${s.conexoes}\nbackend subiu em: ${s.subiuEm}`;
  };

  // O mesmo stream da janela grande. É ele que faz o número mudar aqui quando o clique foi lá.
  const src = new EventSource('api/events');
  src.addEventListener('estado', (m) => pintar(JSON.parse(m.data)));
  src.onerror = () => { nota.textContent = 'conexão SSE caiu'; };

  document.getElementById('p-somar').addEventListener('click', async () => {
    try { pintar(await (await fetch('api/estado/incrementar', { method: 'POST' })).json()); }
    catch (e) { nota.textContent = 'erro: ' + e.message; }
  });

  // Fechar a janela é pedido ao shell — a janela é dele. Fora do desktop degrada para nada, e é
  // por isso que o botão não some: `close()` num shell ausente não lança.
  document.getElementById('p-fechar').addEventListener('click', () => {
    if (typeof vssh !== 'undefined') vssh.window.close(); else window.close();
  });
}
