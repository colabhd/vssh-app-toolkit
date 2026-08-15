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
//      (ver a injeção de scripts no backend deste app). Se ele não existir, a lib não está sendo
//      SERVIDA — quase sempre por ter sido vendorizada fora da raiz do frontend.
//   3. **Ausência não é erro.** Shell e apps são publicados à parte, então um app novo pode rodar
//      contra um shell antigo. Toda peça pergunta antes de usar, e diz o que falta em vez de
//      estourar um `undefined` que leva junto tudo que vinha depois.

// Este arquivo é INJETADO pelo backend deste app, e não é uma `<script src>`
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
        'Confira, no backend deste app, o `mounts` e a lista de scripts injetados — e se as libs do '
        + 'toolkit foram mesmo instaladas (é de dentro delas que o shim vem). Tudo que depende da '
        + 'ponte está desligado nesta página.');
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

  // O cofre tem três verbos e NÃO tem `get`. Não é esquecimento: o valor chega ao app pelo
  // AMBIENTE (`process.env.HELLO_SEGREDO`), e um cofre que devolvesse o que guardou seria uma porta
  // a mais sem servir para nada. `list` devolve só os NOMES.
  $('segredo-listar').addEventListener('click', async () => {
    if (!window.vssh?.secrets) return escrever('runtimeout', 'sem ponte com o desktop (dev local).');
    const nomes = await vssh.secrets.list();
    escrever('runtimeout', nomes === null
      ? 'fora do desktop não há cofre — e isso devolve `null`, não uma lista vazia: '
        + '"não há onde perguntar" e "não há nada guardado" pedem coisas diferentes de quem lê.'
      : nomes.length
        ? `guardados para este app: ${nomes.join(', ')}\n(só os nomes — o valor não sai do seu servidor)`
        : 'nada guardado ainda para este app.');
  });

  $('segredo-apagar').addEventListener('click', async () => {
    if (!window.vssh?.secrets) return escrever('runtimeout', 'sem ponte com o desktop (dev local).');
    const r = await vssh.secrets.remove('HELLO_SEGREDO');
    escrever('runtimeout', r === null
      ? 'cofre indisponível fora do desktop.'
      : `apagado. Restam: ${r.names.length ? r.names.join(', ') : '(nenhum)'}\n`
        + (r.requerReinicio
          ? 'O processo continua com o valor ANTIGO na memória até reiniciar — apagar do cofre não '
            + 'apaga do ambiente de um processo que já subiu.'
          : ''));
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
    // Os dois eventos que provam que o backend fala sem ser perguntado: o clique na BANDEJA e o
    // clique na AÇÃO de uma notificação chegam ao processo, não a esta página — e é por aqui que
    // esta página fica sabendo. Com a janela fechada, o backend teria recebido igual.
    src.addEventListener('bandeja', (m) => escrever('tray-back',
      `o backend recebeu um clique na bandeja: ${m.data}`));
    src.addEventListener('acao', (m) => escrever('live',
      `o backend recebeu a ação da notificação: ${m.data}\n`
      + 'Repare: esta janela não pediu nada. O clique foi do sino para o processo, e de lá para cá.'));
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

  // ── O armazém PRIVADO do app, servido pelo próprio backend ───────────────────
  //
  // Isto não passa pelo shim: são rotas HTTP que o `vssh-app-toolkit/fs` publica sob `api/privado/`,
  // confinadas a uma raiz dentro do VSSH_APP_DATA_DIR. Por isso funciona igual fora do desktop —
  // e por isso NÃO serve para os arquivos do usuário, que são a peça da File System Access.
  // O contrato é um RPC JSON num POST só: `{ op, …parâmetros }`. Um verbo HTTP por operação
  // pareceria mais REST e diria menos — `unlink` aqui MOVE para a reciclagem em vez de apagar, e
  // chamá-lo de `DELETE` prometeria uma coisa que a lib deliberadamente não faz.
  const privado = async (rotulo, corpo) => {
    try {
      const r = await fetch('api/privado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const d = await r.json();
      escrever('privado', `${rotulo} → HTTP ${r.status}\n${JSON.stringify(d, null, 2)}`
        + (d.ok === false
          ? `\n\nO erro vem CLASSIFICADO (${d.error?.code}): um caminho que não existe é 404, e `
            + 'não um 500 dizendo que o servidor quebrou. É a diferença entre "o app pediu o que '
            + 'não há" e "o app está com defeito" — e só a segunda merece alguém acordado.'
          : ''));
    } catch (e) { falhar('privado', e); }
  };

  $('priv-escrever').addEventListener('click', () => privado('write-file nota.txt',
    { op: 'write-file', path: 'nota.txt', content: `gravado em ${new Date().toISOString()}\n` }));

  $('priv-listar').addEventListener('click', () => privado('readdir .', { op: 'readdir', path: '.' }));
  $('priv-ler').addEventListener('click', () => privado('read-file nota.txt',
    { op: 'read-file', path: 'nota.txt' }));

  // Clique duas vezes: a segunda responde o erro classificado de "não está lá". E repare no
  // `recycled` da primeira — `unlink` MOVE para a reciclagem; a lib não apaga nada de verdade.
  $('priv-apagar').addEventListener('click', () => privado('unlink nota.txt',
    { op: 'unlink', path: 'nota.txt' }));

  // A notificação de backend COM ação. O clique não volta para esta página: ele vai para o backend,
  // como POST — porque quando alguém clicar, a janela pode não existir mais. O backend difunde o
  // resultado pelo SSE, e é assim que a linha abaixo muda sem esta página ter pedido nada.
  $('avisar-backend-acao').addEventListener('click', async () => {
    const r = await fetch('api/avisar-com-acao', { method: 'POST' }).then((x) => x.json());
    escrever('live', `notificado com a ação "${r.acao}".\n`
      + 'Abra o sino e clique no botão da notificação: quem recebe é o BACKEND, na rota que o '
      + 'journal carregou em `onAction`. Esta janela fica sabendo pelo SSE — assine-o acima.');
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

  // ── Falar com outro app, sem ponte nossa ────────────────────────────────────
  //
  // `BroadcastChannel` é do navegador, e por isso este bloco fica FORA do `if (vssh)`: ele funciona
  // no `npm run dev` igual, e é o único mecanismo de conversa entre apps que o ambiente oferece —
  // de propósito. Shell e apps compartilham uma origem só, então a mensagem alcança as duas
  // janelas deste app, o shell, e qualquer outro vssh-app aberto.
  const canal = new BroadcastChannel('hello-world:exemplo');
  let recebidas = 0;
  canal.onmessage = (e) => {
    recebidas++;
    escrever('canalout', `recebi (${recebidas}): ${JSON.stringify(e.data)}\n`
      + 'veio de outra janela ou de outro app — nunca do backend, que não fala este canal.');
  };
  $('canal').addEventListener('click', () => {
    // A própria janela NÃO recebe o que ela mesma manda: é regra do BroadcastChannel, e quem
    // esperar o eco vai achar que o canal está quebrado. Abra o painel para ver chegando.
    canal.postMessage({ de: 'janela principal', em: new Date().toISOString() });
    escrever('canalout', 'mandei. Quem recebe é a OUTRA janela (abra o painel) ou outro app — '
      + 'quem envia não recebe o próprio eco, e isso é regra do navegador, não defeito.');
  });
  window.addEventListener('pagehide', () => canal.close());

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

    // Os cinco diálogos. Repare no que se faz com a RESPOSTA: `prompt` e `password` devolvem
    // `null` quando a pessoa desiste, e `null` não é string vazia — quem trata os dois igual grava
    // um valor em branco por cima do que já estava lá.
    $('dialog-alert').addEventListener('click', async () => {
      await vssh.dialog.alert('Um recado, sem pergunta nenhuma.', 'Hello World');
      escrever('bridge', 'alert: fechou. Ele não devolve valor — só interrompe.');
    });

    $('dialog-error').addEventListener('click', async () => {
      await vssh.dialog.error('Não consegui abrir o índice.', 'Hello World');
      escrever('bridge', 'error: o mesmo que o alert, com a cor de erro. É TOM, não gravidade — '
        + 'para algo que a pessoa vá querer reencontrar, use notify.');
    });

    $('confirm').addEventListener('click', async () => {
      const ok = await vssh.dialog.confirm('Isto veio do desktop, não do navegador. Confirma?');
      escrever('bridge', 'confirm devolveu: ' + ok);
    });

    $('dialog-prompt').addEventListener('click', async () => {
      const v = await vssh.dialog.prompt('Como você quer chamar isto?', 'sem título');
      escrever('bridge', v === null
        ? 'prompt devolveu null: a pessoa DESISTIU. Não é o mesmo que texto vazio.'
        : `prompt devolveu: ${JSON.stringify(v)}`);
    });

    $('dialog-password').addEventListener('click', async () => {
      const v = await vssh.dialog.password('Digite uma senha qualquer (nada é guardado).');
      escrever('bridge', v === null
        ? 'password devolveu null: desistiu.'
        : `password devolveu ${v.length} caractere(s) — e a galeria não mostra o valor, `
          + 'porque um app que ecoa uma senha põe a senha no log de alguém.');
    });

    // ── Menu de contexto ───────────────────────────────────────────────────────
    //
    // Só DADOS atravessam: nem HTML, nem função. O shell devolve o `id` do escolhido (ou o
    // `label`, se o item não tiver id) e `null` quando fecharam sem escolher — e `null` aqui é
    // resposta, não erro.
    let marcado = true;
    const abrirMenu = async (ev) => {
      ev.preventDefault();
      // Coordenadas do SEU viewport: quem soma a posição da janela é o shell. Passar coordenada de
      // tela abriria o menu longe do ponteiro, e a distância cresce com a janela mais para a direita.
      const escolha = await vssh.contextMenu(ev.clientX, ev.clientY, [
        { header: 'Uma peça da galeria' },
        { id: 'copiar', label: 'Copiar', icon: 'copy' },
        { id: 'marcar', label: 'Marcado', checked: marcado },
        { id: 'inerte', label: 'Indisponível agora', disabled: true },
        { separator: true },
        {
          label: 'Mais',
          submenu: [
            { id: 'sub-a', label: 'Item de submenu' },
            // Um nível só: o shell IGNORA submenu dentro de submenu, então o que estivesse aqui
            // dentro simplesmente não apareceria — sem erro nenhum.
            { id: 'sub-b', label: 'Outro' },
          ],
        },
        { separator: true },
        { id: 'apagar', label: 'Apagar', icon: 'trash', danger: true },
      ]);
      if (escolha === 'marcar') marcado = !marcado;
      escrever('menuout', escolha === null
        ? 'fechou sem escolher — `null`, que é resposta e não erro'
        : `escolheu: ${escolha}${escolha === 'marcar' ? ` (agora ${marcado ? 'marcado' : 'desmarcado'})` : ''}`);
    };
    $('menu').addEventListener('contextmenu', abrirMenu);
    $('menu').addEventListener('click', abrirMenu);

    // ── Controles da janela ────────────────────────────────────────────────────
    //
    // O app PEDE; quem decide é o ambiente. Minimizar sem volta deixaria a peça sem saída — daí o
    // `restore` no relógio, que é o mesmo cuidado de não abrir um diálogo sem botão de fechar.
    $('win-min').addEventListener('click', () => {
      escrever('janela', 'minimizada — volta em 2 s');
      vssh.window.minimize();
      setTimeout(() => { vssh.window.restore(); escrever('janela', 'restaurada pelo relógio'); }, 2000);
    });
    $('win-max').addEventListener('click', () => {
      vssh.window.maximize();
      escrever('janela', 'maximizada. Não existe setSize/setPosition: depois do manifesto, o '
        + 'tamanho é do usuário.');
    });
    $('win-restore').addEventListener('click', () => {
      vssh.window.restore();
      escrever('janela', 'restaurada');
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

    // A MESMA rota, devagar de propósito: 80 s é mais que o TTL de 60 s com que o portal descarta
    // uma atividade que parou de renovar o carimbo. É a única forma de VER a renovação funcionando
    // — numa tarefa de seis segundos, um backend que esqueceu o `keepLiveAlive()` parece correto.
    $('live-backend-lento').addEventListener('click', async () => {
      const r = await fetch('api/tarefa-longa?lento=1', { method: 'POST' }).then(x => x.json());
      escrever('live', `o backend começou ${r.total} passos de ${r.intervalo / 1000}s `
        + `(${r.duracaoMs / 1000}s no total).\nO TTL do portal é ~60s: se a barra atravessar, a `
        + `renovação está ligada; se sumir no meio, falta keepLiveAlive() no backend.`);
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

    // ── A bandeja pela lib do BACKEND ──────────────────────────────────────────
    //
    // A mesma bandeja, pelo outro caminho — o do app SEM janela. Aqui a página só dispara: quem
    // escreve o `tray.json` é o processo, e o clique volta como POST no backend dele. É por isso
    // que o texto abaixo chega pelo SSE, e não como resposta desta requisição.
    $('tray-backend').addEventListener('click', async () => {
      const r = await fetch('api/bandeja', { method: 'POST' }).then((x) => x.json());
      escrever('tray-back', r.ok
        ? 'o BACKEND pôs o ícone. Clique nele: a resposta chega pelo SSE, porque quem recebe o '
          + 'clique é o processo — esta janela nem precisa estar aberta.'
        : `a lib não conseguiu escrever: ${r.motivo}`);
    });

    $('tray-backend-off').addEventListener('click', async () => {
      await fetch('api/bandeja', { method: 'DELETE' });
      escrever('tray-back', 'removido pelo backend');
    });

    // ── Seletores ──────────────────────────────────────────────────────────────
    //
    // Os três devolvem caminho ABSOLUTO no servidor, ou `null`. E o `null` do cancelamento é
    // indistinguível do `null` de "fora do desktop" de propósito: nos dois casos não há caminho, e
    // o app não deve seguir como se houvesse.
    $('pick-file').addEventListener('click', async () => {
      const p = await vssh.pickFile({ title: 'Escolha um arquivo', filter: 'Texto (*.txt *.md)' });
      escrever('picks', p ? `pickFile → ${p}` : 'pickFile → null (cancelado, ou fora do desktop)');
    });

    $('pick-save').addEventListener('click', async () => {
      // `name` só faz sentido aqui: é o nome que aparece PREENCHIDO na caixa de salvar.
      const p = await vssh.pickSave({ title: 'Onde salvar?', name: 'exemplo.txt' });
      escrever('picks', p
        ? `pickSave → ${p}\n(o arquivo NÃO foi criado: o seletor devolve um caminho, quem escreve é você)`
        : 'pickSave → null (cancelado)');
    });

    $('pick-dir').addEventListener('click', async () => {
      const p = await vssh.pickDirectory({ title: 'Escolha uma pasta' });
      escrever('picks', p ? `pickDirectory → ${p}` : 'pickDirectory → null (cancelado)');
    });

    // ── Abrir no ambiente ──────────────────────────────────────────────────────

    $('abrir-arquivo').addEventListener('click', async () => {
      const p = await vssh.pickFile({ title: 'Escolha um arquivo para abrir no visualizador' });
      if (!p) return escrever('abrir', 'cancelado no seletor');
      vssh.openFile(p);
      escrever('abrir', `pedi para abrir ${p}\nQuem escolhe o visualizador é o ambiente, pela `
        + 'extensão: PDF e vídeo no navegador do desktop, texto no editor, planilha no editor de '
        + 'office. O app não decide, e não fica sabendo — não há resposta para esperar.');
    });

    $('abrir-pasta').addEventListener('click', async () => {
      const p = await vssh.pickDirectory({ title: 'Escolha uma pasta' });
      if (!p) return escrever('abrir', 'cancelado no seletor');
      vssh.openFolder(p);
      escrever('abrir', `abri ${p} no gerenciador de arquivos do ambiente`);
    });

    $('abrir-com').addEventListener('click', async () => {
      const p = await vssh.pickFile({ title: 'Escolha um arquivo' });
      if (!p) return escrever('abrir', 'cancelado no seletor');
      const escolhido = await vssh.openWith(p);
      escrever('abrir', escolhido
        ? `o usuário escolheu abrir com: ${escolhido}`
        : 'fechou sem escolher — `null`, e não um erro');
    });

    $('abrir-url').addEventListener('click', async () => {
      await vssh.openUrl('https://example.org/');
      escrever('abrir', 'abri no navegador DO AMBIENTE.\n'
        + 'Repare no que isso significa: aquele navegador resolve a rede a partir do servidor '
        + 'Linux. Um `http://localhost:3000` ali é o loopback DO SERVIDOR, não o da sua máquina — '
        + 'e é assim que se alcança um serviço que só escuta lá dentro. Só http/https: o ambiente '
        + 'recusa o resto, porque um esquema arbitrário abriria o que o app quisesse na máquina '
        + 'de quem olha.');
    });

    // O link comum ao lado NÃO tem handler, e é esse o ponto: o shim intercepta `window.open` e o
    // clique em `target="_blank"`. O app não escreve uma linha e mesmo assim o link não escapa
    // para uma aba do navegador hospedeiro, onde ele estaria fora do ambiente.
    $('link-alvo').addEventListener('click', () => {
      escrever('abrir', 'este é um `<a target="_blank">` sem código nenhum: quem o desviou para o '
        + 'navegador do ambiente foi o shim. É API sem chamada — o que um app portado ganha sem '
        + 'trocar uma linha.');
    });

    // ── Área de transferência ──────────────────────────────────────────────────

    $('clip-ler').addEventListener('click', async () => {
      const c = await vssh.clipboard.files();
      escrever('clip', c
        ? `${c.action}: ${c.paths.length} caminho(s)\n${c.paths.join('\n')}`
        : 'não há arquivo no clipboard do desktop (copie um no gerenciador de arquivos e tente '
          + 'de novo). `null` é "não havia", não uma falha.');
    });

    $('clip-por').addEventListener('click', async () => {
      const p = await vssh.pickFile({ title: 'Escolha o arquivo a copiar' });
      if (!p) return escrever('clip', 'cancelado no seletor');
      const ok = await vssh.clipboard.setFiles(p);
      escrever('clip', ok
        ? `copiado: ${p}\nAgora cole no gerenciador de arquivos — é o MESMO clipboard.`
        : 'o ambiente recusou (shell mais antigo que este app)');
    });

    // O clipboard muda POR FORA do app — quem copia um arquivo é o gerenciador de arquivos, e o
    // app não tem como saber sozinho. Este ouvinte não tem botão de propósito: ele já está ligado
    // desde que a página abriu, e é assim que se escreve um "colar" que sabe se há o que colar.
    // Cancelar importa: o ouvinte vive no documento.
    const pararClipboard = vssh.clipboard.onChange((c) => {
      escrever('clip', c
        ? `o clipboard MUDOU por fora: ${c.paths.length} caminho(s)\n${c.paths.join('\n')}`
        : 'o clipboard de arquivos foi esvaziado por fora');
    });
    window.addEventListener('pagehide', () => pararClipboard());

    $('clip-img-ler').addEventListener('click', async () => {
      try {
        const blob = await vssh.clipboard.readImage();
        escrever('clip', blob
          ? `imagem no clipboard: ${blob.type}, ${blob.size} bytes`
          : 'não havia imagem — `null`, e isso não é erro');
      } catch (e) {
        // O motivo NOMEADO é o que separa "faltou o gesto" de "o navegador recusou". Sem ele, os
        // dois viram "falhou ao ler o clipboard", e só um deles é conserto de quem escreve o app.
        escrever('clip', `recusado (${e.reason || 'sem motivo'}): ${e.message}\n` + ({
          'no-user-activation': 'o navegador exige um GESTO recente. Chame no clique, não depois '
            + 'de um await longo — este é o único dos quatro que se conserta no seu código.',
          denied: 'a permissão de clipboard foi negada ao site. É decisão do usuário, no navegador.',
          unsupported: 'este navegador não lê imagem do clipboard. Não há contorno.',
        }[e.reason] || ''));
      }
    });

    $('clip-img-por').addEventListener('click', async () => {
      // Uma imagem de mentira, desenhada agora: o template não carrega binário só para demonstrar.
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 90;
      const g = cv.getContext('2d');
      g.fillStyle = '#4f8cff'; g.fillRect(0, 0, 160, 90);
      g.fillStyle = '#fff'; g.font = '16px system-ui'; g.fillText('hello vssh', 24, 50);
      const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
      try {
        const ok = await vssh.clipboard.writeImage(blob);
        escrever('clip', ok ? 'imagem copiada — cole em qualquer lugar' : 'o ambiente recusou');
      } catch (e) {
        escrever('clip', `recusado (${e.reason || 'sem motivo'}): ${e.message}`);
      }
    });

    // ── Arraste de arquivo, nas duas direções ──────────────────────────────────
    //
    // O contrato é UM tipo MIME com caminhos absolutos, um por linha. Publicá-lo é o que faz as
    // três direções (ambiente→app, app→ambiente, app→app) caírem de uma coisa só.
    escrever('mime', vssh.ARQUIVOS_MIME);

    let soltos = [];
    const zonaDeSoltura = $('solte');
    // `onArquivosSoltos` cuida do `preventDefault` no `dragover` — sem ele o navegador entende que
    // o alvo RECUSA a soltura e o `drop` nunca acontece, sem erro nenhum. É a armadilha inteira.
    const desligar = vssh.onArquivosSoltos((info) => {
      soltos = info.caminhos;
      zonaDeSoltura.classList.remove('sobre');
      escrever('arrastar', `${info.caminhos.length} caminho(s), soltos em (${info.x}, ${info.y}):\n`
        + info.caminhos.join('\n')
        + '\n\nSão caminhos NO SERVIDOR — não `File` do navegador. Para ler o conteúdo, '
        + '`vssh.fs.read()` ou a File System Access; o arraste entrega o endereço, não os bytes.');
    }, { alvo: zonaDeSoltura });
    zonaDeSoltura.addEventListener('dragover', () => zonaDeSoltura.classList.add('sobre'));
    zonaDeSoltura.addEventListener('dragleave', () => zonaDeSoltura.classList.remove('sobre'));
    window.addEventListener('pagehide', () => desligar());

    // A direção de saída: o app escreve o mesmo tipo e AVISA o ambiente, porque todo alvo de
    // soltura do desktop abre o portão num estado do documento dele. `arrastarArquivos` faz as
    // duas coisas, e o fim do gesto é avisado sozinho.
    $('arraste').addEventListener('dragstart', (ev) => {
      const caminhos = soltos.length ? soltos : ['/etc/hostname'];
      const ok = vssh.arrastarArquivos(ev.dataTransfer, caminhos);
      escrever('arrastar', ok
        ? `arrastando ${caminhos.length} caminho(s) para fora:\n${caminhos.join('\n')}\n`
          + 'Solte numa pasta do gerenciador de arquivos, ou noutro vssh-app.'
        : 'nenhum caminho absoluto para arrastar — o ambiente só aceita caminho absoluto.');
    });

    // ── Voltar no lugar certo ──────────────────────────────────────────────────

    $('rota-lembrar').addEventListener('click', () => {
      vssh.lembrarRota('?painel=1');
      escrever('rota', 'lembrado: "?painel=1".\nSe a sessão for restaurada, esta janela reabre no '
        + 'PAINEL em vez desta página — sem código de restauração nenhum do seu lado. É um '
        + 'ponteiro, não um armazém: cabem 512 caracteres, e o que não couber num endereço vai '
        + 'para o backend do seu app.');
    });

    $('rota-limpar').addEventListener('click', () => {
      vssh.lembrarRota('');
      escrever('rota', 'esquecido — a janela volta a abrir na página inicial.');
    });

    // "Abra assim": o arquivo com que o app foi aberto, a pasta de um "Abrir Terminal Aqui", ou a
    // ROTA de um item da jump list quando a janela JÁ estava aberta. Com o app fechado a rota entra
    // na URL; com ele aberto, chega por aqui — e sem tratar isto, o item da jump list funciona só
    // na primeira abertura, que é o defeito mais difícil de reparar (funciona uma vez).
    vssh.onOpenContext((ctx) => {
      escrever('rota', `abriram este app com um contexto:\n${JSON.stringify(ctx, null, 2)}\n\n`
        + (ctx.rota ? `veio uma ROTA ("${ctx.rota}") — clique num item da jump list (botão direito `
            + 'no ícone do app). Quem navega é o app: o ambiente não sabe se ir a "/novo" é trocar '
            + 'de tela, abrir um painel ou criar um documento.'
          : ctx.path ? `veio um CAMINHO (${ctx.tipo || 'tipo não informado'}). É o que chega quando `
            + 'alguém abre um arquivo ".hello" com este app, ou pede "abrir aqui" numa pasta.'
          : ''));
      // Um app de verdade NAVEGARIA aqui (seu roteador, sua troca de tela). Esta galeria é de uma
      // página só, então ela faz o que cabe e é honesto: leva a rota pedida até onde ela é
      // visível. Inventar uma navegação de mentira ensinaria um padrão que não existe.
      if (ctx.rota) $('c-runtime').scrollIntoView({ behavior: 'smooth' });
    });
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
    const botoesDeCaminho = ['fs-exists', 'fs-stat', 'fs-read', 'fs-bytes', 'fs-copy', 'fs-rename',
                             'fs-watch'];

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

    $('fs-stat').addEventListener('click', async () => {
      try {
        const s = await vssh.fs.stat(alvo);
        escrever('fs', `stat(${alvo}):\n${JSON.stringify(s, null, 2)}\n\n`
          + `mtime é epoch em MILISSEGUNDOS: ${new Date(s.mtime).toLocaleString()}`);
      } catch (e) { falhar('fs', e); }
    });

    // As duas leituras, e a diferença não é estilo: texto-encodar bytes os CORROMPE. Um PNG lido
    // como texto volta maior e quebrado, e o defeito só aparece na hora de gravar de volta.
    $('fs-read').addEventListener('click', async () => {
      try {
        const t = await vssh.fs.read(alvo);
        escrever('fs', `read(${alvo}) → ${t.length} caracteres\n\n${t.slice(0, 600)}`
          + (t.length > 600 ? '\n… (cortado na exibição)' : ''));
      } catch (e) { falhar('fs', e); }
    });

    $('fs-bytes').addEventListener('click', async () => {
      try {
        const b = await vssh.fs.readBytes(alvo);
        const hex = [...b.slice(0, 16)].map((n) => n.toString(16).padStart(2, '0')).join(' ');
        escrever('fs', `readBytes(${alvo}) → ${b.length} bytes\nprimeiros 16: ${hex}\n\n`
          + 'Para binário é ESTE o caminho: `read()` devolve texto, e texto-encodar bytes os '
          + 'corrompe em silêncio — o arquivo só volta errado quando alguém o grava de volta.');
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

    // ── A outra metade do vssh.fs: escrever ────────────────────────────────────
    //
    // O ciclo inteiro numa pasta que ele mesmo cria e apaga: nada do que o usuário já tinha é
    // tocado, e a demonstração pode ser repetida sem deixar sujeira.
    let base = null;

    $('fs-dir').addEventListener('click', async () => {
      base = await vssh.pickDirectory({ title: 'Uma pasta onde o exemplo pode criar e apagar' });
      if (!base) return escrever('fs-escrita', 'cancelado no seletor');
      ['fs-ciclo', 'fs-url'].forEach((id) => { $(id).disabled = false; });
      escrever('fs-escrita', `pasta de trabalho: ${base}`);
    });

    $('fs-ciclo').addEventListener('click', async () => {
      const pasta = `${base}/vssh-galeria-exemplo`;
      const txt = `${pasta}/nota.txt`;
      const bin = `${pasta}/quatro-bytes.bin`;
      try {
        escrever('fs-escrita', 'mkdir…');
        await vssh.fs.mkdir(pasta);
        await vssh.fs.write(txt, `escrito pela galeria em ${new Date().toISOString()}\n`);
        // `writeBytes` aceita `Uint8Array`: o que vai é byte, não a representação textual dele.
        await vssh.fs.writeBytes(bin, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        const l = await vssh.fs.list(pasta);
        const linhas = l.items.map((e) => {
          // Duas grafias para a mesma coisa chegam de respostas diferentes, e tratar só uma faz
          // toda pasta parecer arquivo em metade dos caminhos.
          const dir = e.type === 'directory' || e.isDirectory === true;
          return `  ${dir ? 'd' : '-'} ${e.name}${e.size != null ? ` (${e.size} bytes)` : ''}`;
        });
        await vssh.fs.delete(bin);
        const depois = await vssh.fs.list(pasta);
        escrever('fs-escrita', [
          `mkdir  ${pasta}`,
          `write  ${txt}`,
          `writeB ${bin}  (4 bytes crus)`,
          `list   ${l.items.length} entrada(s):`, ...linhas,
          `delete ${bin}`,
          `list   sobrou ${depois.items.length}: ${depois.items.map((e) => e.name).join(', ')}`,
          '',
          `A pasta ${pasta} ficou — apague-a com o gerenciador de arquivos quando quiser. Um `
          + 'exemplo que apaga a própria pasta esconderia justamente o que se quer conferir.',
        ].join('\n'));
      } catch (e) { falhar('fs-escrita', e); }
    });

    // `urlFor` é SÍNCRONA de propósito: é o que permite pôr o caminho direto num `src`, no lugar
    // de `URL.createObjectURL`. Ela suporta `Range`, então serve para vídeo grande sem baixar tudo.
    $('fs-url').addEventListener('click', async () => {
      const p = await vssh.pickFile({ title: 'Escolha uma imagem', filter: 'Imagens (*.png *.jpg *.jpeg *.gif *.webp)' });
      if (!p) return escrever('fs-escrita', 'cancelado no seletor');
      const url = vssh.fs.urlFor(p);
      $('fs-imagem').innerHTML = '';
      const img = document.createElement('img');
      img.alt = p;
      img.src = url;
      img.onerror = () => escrever('fs-escrita', `a URL respondeu erro para ${p} — o arquivo é mesmo uma imagem?`);
      $('fs-imagem').appendChild(img);
      escrever('fs-escrita', `urlFor(${p}) →\n${url}\n\n`
        + 'Síncrona: dá para usar direto num `src`, e é isso que a torna substituta do '
        + '`URL.createObjectURL` num app portado. Suporta Range, então um vídeo grande toca sem '
        + 'baixar o arquivo inteiro antes.');
    });

    // ── Permissão: três respostas, e a terceira decide o oposto da segunda ─────
    $('fs-grants').addEventListener('click', async () => {
      const caminhos = vssh.fs.grantedPaths();
      const alvoDoTeste = alvo || base || caminhos[0] || '/etc/hostname';
      const r = await vssh.fs.isGranted(alvoDoTeste, { mode: 'readwrite' });
      escrever('grants', [
        `isGranted(${alvoDoTeste}) → ${JSON.stringify(r)}`,
        r === true ? '  → pode tocar: siga.'
          : r === false ? '  → NÃO tem permissão: abra um seletor e deixe o usuário conceder.'
          : '  → NÃO SEI (shell antigo, erro ou timeout). Tratar isto como `false` faz o app '
            + 'desistir num servidor onde ele funcionaria; a ação certa aqui é TENTAR.',
        '',
        `grantedPaths() → ${caminhos.length} caminho(s)`,
        ...caminhos.map((c) => `  ${c}`),
        '',
        'Síncrona porque o espelho já está em memória, alimentado pelo shell. E a lista inclui o '
        + 'que foi concedido em OUTRA sessão e em outra máquina: o grant mora no usuário, não '
        + 'neste navegador.',
      ].join('\n'));
    });

    // ── OPFS ───────────────────────────────────────────────────────────────────
    //
    // O armazenamento privado do navegador é por ORIGEM, e todo vssh-app vive na mesma. O shim
    // confina cada app numa raiz `vssh-app-<id>` — sem isso, este app abriria o `cache.db` do
    // vizinho, e o pior caso não é ler: é gravar.
    const opfs = () => navigator.storage.getDirectory();

    // O namespace só existe quando dá para identificar o app pela URL — ou seja, sob o proxy do
    // portal. Rodando o backend solto na sua máquina, a raiz é a da origem, sem
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
          + 'NÃO controla este app. Atualize as libs do toolkit para a v4, fixe a versão no lock do '
          + 'seu runtime e reinstale.' + meu);
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
