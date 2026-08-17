'use strict';

// O MPD que o Palco gera, tocado pelo dash.js de verdade, num Chrome de verdade.
//
// ─── A segunda metade da sondagem que o plano exigia ─────────────────────────
//
// A primeira metade ("o yt-dlp entrega os ranges?") foi medida e respondida NÃO — os campos
// `initRange`/`indexRange` não existem em formato nenhum, e por isso `backend/dash.py` os descobre
// lendo 4 KB de cada arquivo. `test_dash.py` prende esse lado em Python.
//
// Falta o outro: **o dash.js aceita um manifesto com URLs nossas?** Um MPD pode estar
// estruturalmente impecável — validado contra o esquema, com todos os atributos que o padrão pede —
// e ainda assim não tocar, porque um player real cobra coisas que o esquema não exige. É a mesma
// classe de defeito do `genpts`: passa em conferência estrutural e falha na tela.
//
// ⚠ **Nada aqui fala com o YouTube.** O `ffmpeg` produz localmente o MESMO layout que o YouTube
// serve — medido: `ftyp | moov | sidx | moof | mdat`, com o `sidx` global logo após o `moov` —, e é
// esse layout que o parser precisa entender. Um teste que baixasse do YouTube ficaria vermelho
// quando o Google mexesse em qualquer coisa, que é o oposto de um sinal.
//
// O que está sob medida, então:
//   1. o Python gera o MPD a partir de arquivos que o ffmpeg acabou de escrever;
//   2. o dash.js carrega esse MPD, pede os ranges NELE declarados, e monta os `SourceBuffer`;
//   3. o `<video>` avança o tempo e desenha quadros.
// Se qualquer um dos três falhar, o manifesto está errado — e é aqui que se descobre, não instalado.
//
// ⚠ **Duas coisas que esta bancada NÃO consegue medir, e é melhor estarem escritas do que
// descobertas de novo.** A refutação as achou como buracos, e investigá-las mostrou que são fatos
// do dash.js, não falta de cobertura — o que se prende delas se prende em `test_dash.py`:
//
//   `profiles`                    ignorado. `isoff-live` num manifesto de vídeo gravado toca igual,
//                                 com o mesmo número de requisições.
//   `mediaPresentationDuration`   ignorado para a duração do `<video>`: um valor dez vezes maior
//                                 ainda dá `v.duration` correto, porque ela sai do `sidx`.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { abrirNavegador, caminhoDoNavegador, motivoDoSkip } = require('./browser/chrome.js');

const RAIZ = path.join(__dirname, '..');
const BACKEND = path.join(RAIZ, 'examples', 'palco', 'backend');
const DASHJS = path.join(RAIZ, 'examples', 'palco', 'frontend', 'vendor', 'dash.mediaplayer.min.js');

function achar(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? cmd : null;
}
const PY = achar('python', ['-c', 'import sys']) || achar('python3', ['-c', 'import sys']);
const FFMPEG = achar('ffmpeg', ['-version']);

// Quatro razões para pular, e cada uma diz QUAL — "pulou" sem motivo é um teste que ninguém
// percebe ter parado de rodar.
const porqueNao = !caminhoDoNavegador() ? motivoDoSkip()
  : !PY ? 'sem python no PATH (o MPD é gerado pelo backend de verdade, não reimplementado aqui)'
    : !FFMPEG ? 'sem ffmpeg no PATH (é ele que produz o fMP4 com sidx)'
      : !fs.existsSync(DASHJS) ? `o dash.js não está vendorizado em ${path.relative(RAIZ, DASHJS)}`
        : null;
const seNaoTem = { skip: porqueNao || false };

// Curto de propósito: 6 s a 160x90 dá arquivos de dezenas de KB e ainda tem três fragmentos, que é
// o mínimo para o `sidx` ter uma tabela com mais de uma linha.
const DURACAO = 6;
const TRILHAS = [
  { itag: '133', tipo: 'video', args: (saida) => [
    '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${DURACAO}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an',
    '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', saida] },
  { itag: '134', tipo: 'video', args: (saida) => [
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${DURACAO}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an',
    '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', saida] },
  { itag: '140', tipo: 'audio', args: (saida) => [
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURACAO}`,
    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-vn',
    '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', saida] },
];

let dir;
let servidor;
let base;
let mpd;
let navegador;
let pedidos;

/** Chama o `dash.py` de verdade — reimplementar o gerador aqui mediria a reimplementação. */
function gerarMPD(arquivos) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(BACKEND)})
from dash import CABECALHO, escolher_formatos, montar_mpd, ranges_do_cabecalho

formatos, ranges = [], {}
for f in json.load(sys.stdin):
    with open(f["caminho"], "rb") as fh:
        r = ranges_do_cabecalho(fh.read(CABECALHO))
    if r is None:
        print("SEM RANGES:", f["format_id"], file=sys.stderr); sys.exit(2)
    ranges[f["format_id"]] = r
    formatos.append(f)
trilhas = escolher_formatos(formatos, ranges)
sys.stdout.write(montar_mpd(${DURACAO}, trilhas, "/bytes/"))
`;
  const r = spawnSync(PY, ['-c', script], { input: JSON.stringify(arquivos), encoding: 'utf8' });
  assert.equal(r.status, 0, `o gerador de MPD falhou:\n${r.stderr}`);
  return r.stdout;
}

before(async () => {
  if (porqueNao) return;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palco-dash-'));
  const arquivos = TRILHAS.map((t) => {
    const saida = path.join(dir, `${t.itag}.mp4`);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...t.args(saida)],
                        { encoding: 'utf8' });
    assert.equal(r.status, 0, `o ffmpeg falhou para ${t.itag}:\n${r.stderr}`);
    const bytes = fs.statSync(saida).size;
    return {
      caminho: saida,
      format_id: t.itag, ext: 'mp4', container: 'mp4_dash', url: `local://${t.itag}`,
      vcodec: t.tipo === 'video' ? 'avc1.42c015' : 'none',
      acodec: t.tipo === 'audio' ? 'mp4a.40.2' : 'none',
      width: t.itag === '133' ? 160 : t.itag === '134' ? 320 : null,
      height: t.itag === '133' ? 90 : t.itag === '134' ? 180 : null,
      fps: t.tipo === 'video' ? 30 : null,
      asr: t.tipo === 'audio' ? 44100 : null,
      audio_channels: t.tipo === 'audio' ? 1 : null,
      filesize: bytes,
      tbr: (bytes * 8) / DURACAO / 1000,
    };
  });

  mpd = gerarMPD(arquivos);

  // O servidor honra `Range` de verdade — é o ponto do teste. Um servidor que ignorasse o Range e
  // devolvesse 200 com o arquivo inteiro faria o dash.js "funcionar" por acidente, aprovando um
  // manifesto cujos ranges poderiam estar todos errados.
  pedidos = [];
  const http = require('node:http');
  servidor = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    pedidos.push({ caminho: u.pathname, range: req.headers.range || null });

    if (u.pathname === '/manifesto.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(mpd);
    }
    const m = u.pathname.match(/^\/bytes\/(\d+)$/);
    if (m) {
      const arq = path.join(dir, `${m[1]}.mp4`);
      if (!fs.existsSync(arq)) { res.writeHead(404); return res.end(); }
      const total = fs.statSync(arq).size;
      const faixa = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!faixa) {
        res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes',
                             'content-type': 'video/mp4' });
        return fs.createReadStream(arq).pipe(res);
      }
      const ini = Number(faixa[1]);
      const fim = faixa[2] ? Math.min(Number(faixa[2]), total - 1) : total - 1;
      res.writeHead(206, {
        'content-range': `bytes ${ini}-${fim}/${total}`,
        'content-length': fim - ini + 1,
        'accept-ranges': 'bytes',
        'content-type': 'video/mp4',
      });
      return fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
    }
    if (u.pathname === '/dash.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(fs.readFileSync(DASHJS));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>dash</title>'
                   + '<video id="v" muted playsinline></video>');
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;

  navegador = await abrirNavegador();
});

after(async () => {
  await navegador?.fechar?.();
  await new Promise((ok) => (servidor ? servidor.close(ok) : ok()));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Carrega a página, sobe o dash.js e toca até `alvoSegundos` (ou desiste).
 *
 * ⚠ Zera `pedidos` na entrada. Sem isso, os dois testes que conferem os pedidos leriam o
 * acumulado da bancada inteira — e o teste da busca RE-PEDE bytes por definição, o que faria a
 * conferência de sobreposição acusar retrabalho onde há um seek legítimo. O instantâneo tem de ser
 * o do arranque.
 */
async function tocar(alvoSegundos = 1.5) {
  pedidos.length = 0;
  const aba = await navegador.novaPagina(base + '/');
  await aba.avaliar(`new Promise((ok) => {
    const s = document.createElement('script');
    s.src = '/dash.js'; s.onload = ok; s.onerror = () => ok();
    document.head.appendChild(s);
  })`);
  return aba.avaliar(`(async () => {
    const v = document.getElementById('v');
    const erros = [];
    if (typeof dashjs === 'undefined') return { erro: 'o dash.js não carregou' };
    const p = dashjs.MediaPlayer().create();
    p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: false } } } });
    p.on(dashjs.MediaPlayer.events.ERROR, (e) => erros.push(JSON.stringify(e.error || e)));
    p.initialize(v, '/manifesto.mpd', true);

    const ate = Date.now() + 20000;
    while (Date.now() < ate) {
      if (erros.length) break;
      if (v.currentTime >= ${alvoSegundos}) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
    return {
      erros,
      tempo: v.currentTime,
      duracao: v.duration,
      prontidao: v.readyState,
      largura: v.videoWidth,
      altura: v.videoHeight,
      bufferizado: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
      desenhados: q.totalVideoFrames || 0,
      perdidos: q.droppedVideoFrames || 0,
      faixas: (p.getTracksFor && p.getTracksFor('video') || []).length,
    };
  })()`);
}

test('o piso: o ffmpeg produziu o layout do YouTube e o MPD saiu com as três trilhas', seNaoTem,
  () => {
    // ⚠ Sem este piso, um MPD vazio faria todo teste abaixo medir nada. Um `<video>` sem fonte
    // nenhuma não lança — fica parado, e "parado" é o que um teste mal escrito lê como "sem erro".
    assert.match(mpd, /^<\?xml/, 'o MPD nem começou como XML');
    const reps = [...mpd.matchAll(/<Representation id="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(reps.sort(), ['133', '134', '140']);
    assert.equal((mpd.match(/indexRange="\d+-\d+"/g) || []).length, 3,
      'faltou indexRange em alguma representação');
    for (const t of TRILHAS) {
      assert.ok(fs.statSync(path.join(dir, `${t.itag}.mp4`)).size > 5000, `${t.itag} saiu vazio`);
    }
  });

test('o dash.js aceita o manifesto e toca — vídeo e áudio', seNaoTem, async () => {
  const r = await tocar(1.5);
  assert.deepEqual(r.erros, [], 'o dash.js reclamou do manifesto');
  assert.ok(r.tempo >= 1.5, `o tempo não avançou: ${JSON.stringify(r)}`);
  assert.ok(r.desenhados > 10, `poucos quadros desenhados: ${JSON.stringify(r)}`);
  // A altura prova que o `SourceBuffer` de VÍDEO montou — um MPD só com áudio também avançaria o
  // tempo, e o teste passaria sem nunca ter desenhado um pixel.
  assert.ok(r.altura === 90 || r.altura === 180, `sem vídeo na tela: altura=${r.altura}`);
  // ⚠ A duração NÃO prova nada sobre o manifesto, e este comentário existe para ninguém
  // acrescentar uma asserção achando que prova: medido, um `mediaPresentationDuration` dez vezes
  // maior que o vídeo dá `v.duration` correto assim mesmo — o dash.js tira a duração do `sidx`,
  // não do MPD. Quem prende o valor declarado é `test_dash.py`, em Python, onde a mutação morde.
  assert.ok(r.duracao > 0, `sem duração nenhuma: ${r.duracao}`);
});

test('os ranges certos custam o mínimo: nenhum byte é pedido duas vezes', seNaoTem, () => {
  // ⚠ **Este teste nasceu de um buraco da refutação, e o buraco ensinou mais que o conserto.**
  //
  // Eu esperava que um `indexRange` errado impedisse a reprodução. Medido, não impede: o dash.js
  // pede o range declarado, não acha o `sidx` inteiro ali, e **pede de novo** com um chute maior.
  // Ele se recupera de tudo — índice deslocado por um byte, índice apontando para o `ftyp`, e até
  // `SegmentBase` nenhum. Toca em todos os casos.
  //
  // Então "tocou" não é o sinal. O que os ranges errados custam é **repetição**: 12 requisições em
  // vez de 10, com os mesmos bytes pedidos duas vezes. Num teste local isso é invisível; em
  // produção cada repetição é uma viagem do nosso servidor até o googlevideo, somada à latência de
  // quem assiste — no arranque, que é o momento em que ela mais aparece.
  //
  // Contar requisições seria frágil (a próxima versão do dash.js pode agrupar diferente). O que é
  // estável é a propriedade: **numa sequência correta os pedidos de uma trilha são disjuntos** —
  // o índice, depois a inicialização, depois os dados. Sobreposição é retrabalho, sempre.
  const porTrilha = new Map();
  for (const p of pedidos) {
    const m = p.caminho.match(/^\/bytes\/(\d+)$/);
    if (!m || !p.range) continue;
    const f = /^bytes=(\d+)-(\d*)$/.exec(p.range);
    if (!f) continue;
    const faixa = [Number(f[1]), f[2] ? Number(f[2]) : Infinity];
    if (!porTrilha.has(m[1])) porTrilha.set(m[1], []);
    porTrilha.get(m[1]).push(faixa);
  }
  assert.ok(porTrilha.size >= 2, `poucas trilhas pedidas: ${porTrilha.size}`);

  for (const [itag, faixas] of porTrilha) {
    for (let i = 0; i < faixas.length; i += 1) {
      for (let j = i + 1; j < faixas.length; j += 1) {
        const [ai, af] = faixas[i];
        const [bi, bf] = faixas[j];
        assert.ok(af < bi || bf < ai,
          `a trilha ${itag} pediu os mesmos bytes duas vezes: `
          + `${ai}-${af} e ${bi}-${bf}. Os ranges do manifesto estão errados, e o dash.js está `
          + `compensando com uma viagem a mais.`);
      }
    }
  }
});

test('ele pede os ranges que o manifesto declara, e não o arquivo inteiro', seNaoTem, () => {
  // ⚠ É a medida que separa "tocou" de "tocou pelo motivo certo". Um servidor que ignorasse o
  // Range faria o dash.js baixar tudo e funcionar por acidente — com todos os `indexRange` errados.
  const bytes = pedidos.filter((p) => p.caminho.startsWith('/bytes/'));
  assert.ok(bytes.length >= 4, `poucos pedidos de mídia: ${bytes.length}`);
  const semRange = bytes.filter((p) => !p.range);
  assert.deepEqual(semRange, [], 'houve pedido de mídia sem Range — o SegmentBase não foi usado');

  // O primeiro pedido de cada trilha tem de ser exatamente o `indexRange` do manifesto: é o `sidx`,
  // e é dele que o player tira onde estão os segmentos.
  for (const itag of ['133', '140']) {
    const rep = new RegExp(`<Representation id="${itag}"[\\s\\S]*?indexRange="(\\d+-\\d+)"`);
    const esperado = rep.exec(mpd)[1];
    const pedidoDoIndice = bytes.some((p) => p.caminho === `/bytes/${itag}`
      && p.range === `bytes=${esperado}`);
    assert.ok(pedidoDoIndice,
      `ninguém pediu o índice ${esperado} de ${itag}. Pedidos: `
      + JSON.stringify(bytes.filter((p) => p.caminho.endsWith(itag)).map((p) => p.range)));
  }
});

test('o manifesto sobrevive a uma busca — o seek usa a tabela do sidx', seNaoTem, async () => {
  // Buscar é o que exercita o `sidx` de verdade: sem a tabela, o player não sabe em que byte
  // começa o fragmento do segundo 4 e só consegue tocar do começo.
  const aba = await navegador.novaPagina(base + '/');
  await aba.avaliar(`new Promise((ok) => {
    const s = document.createElement('script'); s.src = '/dash.js';
    s.onload = ok; s.onerror = () => ok(); document.head.appendChild(s);
  })`);
  const r = await aba.avaliar(`(async () => {
    const v = document.getElementById('v');
    const erros = [];
    const p = dashjs.MediaPlayer().create();
    p.on(dashjs.MediaPlayer.events.ERROR, (e) => erros.push(JSON.stringify(e.error || e)));
    p.initialize(v, '/manifesto.mpd', true);
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    let ate = Date.now() + 15000;
    while (Date.now() < ate && v.currentTime < 0.5 && !erros.length) await espera(100);
    p.seek(4);
    ate = Date.now() + 15000;
    while (Date.now() < ate && v.currentTime < 4.3 && !erros.length) await espera(100);
    return { erros, tempo: v.currentTime, prontidao: v.readyState };
  })()`);
  assert.deepEqual(r.erros, [], 'o dash.js falhou ao buscar');
  assert.ok(r.tempo >= 4, `a busca não chegou aos 4 s: ${JSON.stringify(r)}`);
});
