/* A aba do YouTube — busca, canal e playlist na mesma grade.
 *
 * ─── Por que esta aba existe, e por que ela é PRÉ-REQUISITO ─────────────────
 *
 * ⚠ Não é um recurso a mais: é o que destrava o roteamento de link. No instante em que
 * `opens.urls` existe, TODO endereço do YouTube passa a chegar no Palco — playlist, canal, busca,
 * `/shorts`, ao vivo. Se a interface não cobre todos, a pessoa clica num link e chega num beco, e
 * o deeplink fica **pior do que não existir**. Havia um teste vetando `opens.urls` justamente até
 * este arquivo aparecer.
 *
 * ─── Uma grade para as três, e isso é decisão ───────────────────────────────
 *
 * Busca, canal e playlist são três consultas com o mesmo formato de resposta e o mesmo cartão.
 * Três telas seriam três lugares para o mesmo cartão divergir — e a diferença entre elas é o
 * cabeçalho, não o corpo.
 *
 * A grade é a `TuffMidia.grade`, virtualizada: um canal tem milhares de vídeos, e um `<img>` por
 * item trava a aba na abertura sem se recuperar. É o defeito que só se encontra no canal de outra
 * pessoa.
 *
 * ⚠ **O que se abre aqui toca no MESMO player**, com o mesmo transporte. Não há um segundo
 * `<video>` nesta aba: `aoAbrir` chama de volta o Palco, que troca a fonte e volta para
 * Reproduzindo. É a diferença entre um miniapp e dois apps colados.
 */
function montarYoutube(palco) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const grade = $('yt-grade');
  const busca = $('yt-busca');

  let itens = [];
  let gradeViva = null;
  // A consulta que produziu o que está na tela, para pedir a página seguinte dela.
  let paginaAtual = null;   // { url, de, temMais, carregando }
  // ⚠ **Os ids já vistos, e esta peça NÃO é opcional** — foi medido: pedindo 1–20 e 21–40 da mesma
  // busca, DOIS ids aparecem nas duas páginas. O ranking do YouTube não é determinístico entre
  // chamadas. Sem deduplicar, rolar mostra o mesmo vídeo duas vezes e a grade parece bugada.
  // Numa playlist a sobreposição é zero, mas a regra vale para as três: o custo é um `Set`.
  let vistos = new Set();
  // O mesmo teto do backend. Ele manda `de` na resposta, então este número só decide o PEDIDO —
  // e a resposta corrige se um dia divergirem.
  const POR_PAGINA = 30;
  // ⚠ Toda consulta ganha um número, pelo mesmo motivo que as aberturas do player: digitar uma
  // busca nova enquanto a anterior volta faria a resposta velha — que chega depois — sobrescrever
  // a grade da nova. O sintoma é uma lista que não corresponde ao que está escrito na caixa.
  let consulta = 0;
  let ultimaBusca = '';

  const api = (rota) => fetch(rota).then((r) => r.json().then((j) => {
    if (!r.ok) throw Object.assign(new Error(j.erro || r.status), { corpo: j });
    return j;
  }));

  function mostrar(qual, titulo, msg) {
    grade.hidden = qual !== 'grade';
    $('yt-carregando').hidden = qual !== 'carregando';
    $('yt-vazio').hidden = qual !== 'vazio';
    if (titulo) $('yt-vazio-titulo').textContent = titulo;
    if (msg !== undefined) $('yt-vazio-msg').textContent = msg;
  }

  const tempoDe = (s) => (window.TuffMidia ? TuffMidia.tempo(s) : '');

  /** `1 234 567` → `1,2 mi`. Um número exato de sete dígitos não decide nada e ocupa a linha. */
  function visualizacoes(n) {
    if (!n && n !== 0) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} mi de visualizações`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} mil visualizações`;
    return `${n} visualizações`;
  }

  function montarCartao(i, no) {
    const item = itens[i];
    // ⚠ Nada de `no.style` aqui: a grade já pôs `width`, `height` e `transform`, e sobrescrevê-los
    // empilha todas as células na origem. O conteúdo vai num filho.
    no.textContent = '';
    if (!item) return;

    const cartao = document.createElement('div');
    cartao.className = 'yt-cartao';

    const capa = document.createElement('div');
    capa.className = 'yt-capa';
    if (item.miniatura) {
      const img = document.createElement('img');
      // `loading="lazy"` além da virtualização: a grade mantém uma fileira de folga em cada ponta,
      // e sem isto essas imagens são baixadas para nunca serem vistas.
      img.loading = 'lazy';
      img.alt = '';
      img.src = item.miniatura;
      capa.appendChild(img);
    }
    if (item.aoVivo || item.duracao) {
      const selo = document.createElement('span');
      selo.className = item.aoVivo ? 'yt-dur ao-vivo' : 'yt-dur';
      selo.textContent = item.aoVivo ? 'AO VIVO' : tempoDe(item.duracao);
      capa.appendChild(selo);
    }

    const nome = document.createElement('div');
    nome.className = 'yt-nome';
    nome.textContent = item.titulo;
    // O `title` é o texto inteiro: o nome é cortado em duas linhas no cartão, e um vídeo cujo
    // assunto está no fim do título ficaria indistinguível dos vizinhos.
    nome.title = item.titulo;

    const canal = document.createElement('div');
    canal.className = 'yt-canal';
    const vis = visualizacoes(item.visualizacoes);
    canal.textContent = [item.canal, vis].filter(Boolean).join(' · ');

    cartao.append(capa, nome, canal);
    no.appendChild(cartao);
  }

  /**
   * Refaz a grade com `itens`.
   *
   * ⚠ **Ela é DESTRUÍDA e recriada a cada consulta, e não reaproveitada com `atualizar()`.** A
   * grade só remonta uma célula quando o índice dela muda (`if (no.__indice !== i)`) — o que é
   * exatamente o certo para rolagem, e errado aqui: buscar "gatos" e depois "cachorros" com o
   * mesmo número de resultados deixaria os cartões antigos na tela, com os títulos e as capas
   * anteriores, sobre uma lista nova. Nada falharia, e a grade estaria mentindo.
   *
   * `atualizar()` continua servindo para o caso em que ela foi feita: mais itens da MESMA lista.
   */
  /**
   * Acrescenta uma página à grade, ignorando o que já está nela.
   *
   * Devolve quantos itens NOVOS entraram — e quem chama usa isso para decidir se ainda vale pedir
   * mais: uma página inteira de repetidos significa que a lista acabou de verdade, por mais que o
   * servidor diga que "tem mais".
   */
  function acrescentar(novos) {
    let entraram = 0;
    for (const i of novos || []) {
      if (!i || !i.id || vistos.has(i.id)) continue;
      vistos.add(i.id);
      itens.push(i);
      entraram += 1;
    }
    return entraram;
  }

  function desenhar() {
    if (gradeViva) gradeViva.destruir();
    gradeViva = TuffMidia.grade(grade, {
      total: itens.length,
      largura: 210,
      // 118 de capa (16:9 sobre 210) + duas linhas de título + a linha do canal.
      altura: 190,
      montar: montarCartao,
      aoAbrir: (i) => {
        const item = itens[i];
        if (!item) return;
        // ⚠ **A lista que está na tela vira a FILA.** Abrir o quarto resultado de uma busca e
        // depois apertar "próximo" tem de dar o quinto — e não o próximo arquivo da última pasta
        // local aberta, que é o que aconteceria se a fila não viajasse junto. Os itens vão na mão
        // porque já estão aqui: pedi-los de novo seria uma consulta inteira ao YouTube para
        // reconstruir o que acabou de ser exibido.
        // A fila viaja no formato INTERNO do player — quem conhece a origem converte.
        const fila = itens.map((x) => ({ nome: x.titulo, videoId: x.id }));
        palco.abrirYoutube(`https://www.youtube.com/watch?v=${item.id}`, { fila });
      },
    });
    mostrar('grade');
  }

  async function consultar(url, opcoes) {
    const o = opcoes || {};
    const minha = ++consulta;
    mostrar('carregando');
    $('yt-titulo').textContent = o.titulo || '';
    $('yt-voltar').hidden = !o.podeVoltar;
    itens = [];
    vistos = new Set();
    paginaAtual = null;

    let r;
    try {
      r = await api(`api/yt/listar?url=${encodeURIComponent(url)}`);
    } catch (e) {
      if (minha !== consulta) return;
      // ⚠ A frase vem do servidor quando ele soube dizer o que houve — e ele distingue "este canal
      // não tem vídeos" de "não consegui consultar", porque o conserto é diferente: o primeiro é
      // uma resposta legítima do YouTube, e mandar a pessoa atualizar o yt-dlp por causa dele é
      // mandá-la resolver o problema errado.
      const corpo = e.corpo || {};
      mostrar('vazio', corpo.erro || 'Não consegui consultar o YouTube',
              corpo.conserto || 'Tente de novo, ou procure outra coisa.');
      return;
    }
    if (minha !== consulta) return;

    acrescentar(r.itens);
    paginaAtual = { url, de: r.de || 1, temMais: !!r.temMais, carregando: false };
    $('yt-titulo').textContent = o.titulo || r.titulo || '';
    if (!itens.length) {
      mostrar('vazio', 'Nada encontrado',
              r.tipo === 'busca' ? 'Tente outras palavras.' : 'Esta lista está vazia.');
      return;
    }
    desenhar();
    grade.scrollTop = 0;
  }

  /**
   * A página seguinte da consulta que está na tela.
   *
   * ⚠ **Ela cresce a grade em vez de refazê-la.** `atualizar(n)` é exatamente o caso para o qual
   * ela foi feita — mais itens da MESMA lista, com os índices existentes intactos —, e refazer aqui
   * jogaria a rolagem de volta ao topo a cada página: a pessoa rola até o fim, chegam trinta
   * cartões, e ela é devolvida ao começo. O oposto do que pediu.
   */
  async function maisUma() {
    const p = paginaAtual;
    if (!p || !p.temMais || p.carregando) return;
    p.carregando = true;
    const minha = consulta;

    let r;
    try {
      const proxima = p.de + POR_PAGINA;
      r = await api(`api/yt/listar?url=${encodeURIComponent(p.url)}&de=${proxima}`);
    } catch {
      // ⚠ Silêncio, e uma porta que não fecha: uma falha ao buscar MAIS não é uma falha do que já
      // está na tela. Trocar a grade cheia por uma mensagem de erro perderia os trinta resultados
      // que a pessoa já estava usando. `carregando` volta a falso, então rolar de novo tenta de
      // novo — que é o que alguém faz naturalmente quando nada apareceu.
      p.carregando = false;
      return;
    }
    if (minha !== consulta || paginaAtual !== p) return;   // trocaram de busca no meio

    const entraram = acrescentar(r.itens);
    p.de = r.de || (p.de + POR_PAGINA);
    // ⚠ Duas condições, e a segunda é a que importa: uma página INTEIRA de repetidos significa que
    // a lista acabou de verdade, por mais que o servidor diga que "tem mais". Sem ela, uma busca
    // que já entregou tudo ficaria pedindo a mesma página para sempre a cada rolagem — e a
    // sobreposição entre páginas de busca é medida, não hipotética.
    p.temMais = !!r.temMais && entraram > 0;
    p.carregando = false;
    if (entraram && gradeViva) gradeViva.atualizar(itens.length);
  }

  // ⚠ A `TuffMidia.grade` não tem gancho de fim de rolagem — ela virtualiza, e quem sabe que existe
  // uma página seguinte é este arquivo. Duas alturas de folga: pedir só ao tocar o fim faz a pessoa
  // esperar olhando o vazio, e é a diferença entre "rolagem infinita" e "rolagem com pausa".
  grade.addEventListener('scroll', () => {
    const faltam = grade.scrollHeight - grade.scrollTop - grade.clientHeight;
    if (faltam < grade.clientHeight * 2) maisUma();
  }, { passive: true });

  // ── A porta de entrada da aba ────────────────────────────────────────────

  function buscar(termo) {
    const t = (termo || '').trim();
    if (!t) return;
    ultimaBusca = t;
    if (busca.value !== t) busca.value = t;
    consultar(`https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`,
              { titulo: '' });
  }

  /**
   * Um endereço de listagem — playlist, canal ou busca — vindo de um LINK.
   *
   * ⚠ É a metade que torna o deeplink honesto. Sem ela, clicar numa playlist abriria o navegador,
   * e o Palco teria declarado `opens.urls` para devolver metade dos endereços que reivindicou.
   */
  function abrirListagem(url, tipo) {
    palco.irPara('youtube');
    // "Voltar à busca" só aparece quando há uma busca para a qual voltar — um botão que leva a uma
    // tela vazia é pior que nenhum botão.
    consultar(url, { podeVoltar: !!ultimaBusca });
    if (tipo === 'busca') {
      try {
        busca.value = new URL(url).searchParams.get('search_query') || '';
      } catch { /* URL torta: a caixa fica como estava */ }
    }
  }

  busca.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscar(busca.value); }
  });
  // `search` é o evento do `<input type="search">` — dispara no Enter e no "x" de limpar. Sem
  // tratá-lo, limpar a caixa deixaria na tela os resultados da busca anterior.
  busca.addEventListener('search', () => {
    if (!busca.value.trim()) mostrar('vazio', 'Procure um vídeo',
                                     'O que você abrir aqui toca no mesmo player, '
                                     + 'com o mesmo transporte.');
  });
  $('yt-voltar').addEventListener('click', () => buscar(ultimaBusca));

  return { buscar, abrirListagem };
}
