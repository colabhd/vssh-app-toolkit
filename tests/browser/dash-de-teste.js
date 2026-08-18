'use strict';

// Mídia DASH de verdade, produzida localmente, para as bancadas que precisam de um vídeo que TOCA.
//
// ⚠ **Nada aqui fala com o YouTube**, e o motivo é que não precisa: medido, `-movflags
// +dash+global_sidx` produz exatamente o mesmo layout que o YouTube serve — `ftyp | moov | sidx |
// moof | mdat`, com o índice global logo após o `moov`. É esse layout que `backend/dash.py` precisa
// entender, então é ele que as bancadas têm de exercitar. Um teste que baixasse do YouTube ficaria
// vermelho quando o Google mexesse em qualquer coisa, que é o oposto de um sinal.
//
// O MPD é gerado chamando o `dash.py` DE VERDADE, por subprocesso. Reimplementá-lo aqui mediria a
// reimplementação — e as duas versões divergiriam em silêncio no primeiro conserto.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const BACKEND = path.join(RAIZ, 'examples', 'palco', 'backend');

function acha(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0 ? cmd : null;
  } catch {
    return null;
  }
}

const PY = acha('python', ['-c', 'import sys']) || acha('python3', ['-c', 'import sys']);
const FFMPEG = acha('ffmpeg', ['-version']);

/** Por que não dá para montar mídia agora — ou `null` se dá. */
function motivoDoSkip() {
  if (!FFMPEG) return 'sem ffmpeg no PATH (é ele que produz o fMP4 com sidx)';
  if (!PY) return 'sem python no PATH (o MPD é gerado pelo backend de verdade, não reimplementado)';
  return null;
}

const DURACAO = 6;

const TRILHAS = [
  { itag: '133', tipo: 'video', largura: 160, altura: 90, entrada:
    ['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${DURACAO}`,
     '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an'] },
  { itag: '134', tipo: 'video', largura: 320, altura: 180, entrada:
    ['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${DURACAO}`,
     '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an'] },
  { itag: '140', tipo: 'audio', entrada:
    ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURACAO}`,
     '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-vn'] },
];

/**
 * Monta os fMP4 e o MPD.
 *
 * `baseUrl` é o prefixo que o `BaseURL` de cada representação recebe, com o itag concatenado —
 * `'bytes?f='` vira `<BaseURL>bytes?f=134</BaseURL>`.
 *
 * ⚠ **O padrão é RELATIVO de propósito, e quem chama tem de servir o MPD no caminho real.** Um
 * `<BaseURL>` do DASH é resolvido contra a URL do MANIFESTO, não contra a da página — e a primeira
 * versão desta bancada servia o MPD em `/manifesto.mpd`, na raiz, onde qualquer valor resolve
 * certo por acaso. O backend servia em `…/api/yt/mpd`, e ali o mesmo texto duplicava o caminho.
 * Mais uma vez: o duble não vinha do código.
 *
 * Devolve `{ dir, mpd, duracao, itags, servirBytes(req,res,itag), limpar() }`.
 */
function montar(baseUrl = 'bytes?f=') {
  const motivo = motivoDoSkip();
  if (motivo) throw new Error(motivo);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-teste-'));
  const formatos = TRILHAS.map((t) => {
    const saida = path.join(dir, `${t.itag}.mp4`);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...t.entrada,
      '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', saida],
    { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`o ffmpeg falhou para ${t.itag}:\n${r.stderr}`);
    const bytes = fs.statSync(saida).size;
    return {
      caminho: saida,
      format_id: t.itag, ext: 'mp4', container: 'mp4_dash', url: `local://${t.itag}`,
      vcodec: t.tipo === 'video' ? 'avc1.42c015' : 'none',
      acodec: t.tipo === 'audio' ? 'mp4a.40.2' : 'none',
      width: t.largura || null, height: t.altura || null,
      fps: t.tipo === 'video' ? 30 : null,
      asr: t.tipo === 'audio' ? 44100 : null,
      audio_channels: t.tipo === 'audio' ? 1 : null,
      filesize: bytes,
      tbr: (bytes * 8) / DURACAO / 1000,
    };
  });

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
sys.stdout.write(montar_mpd(${DURACAO}, escolher_formatos(formatos, ranges),
                            ${JSON.stringify(baseUrl)}))
`;
  const r = spawnSync(PY, ['-c', script], { input: JSON.stringify(formatos), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`o gerador de MPD falhou:\n${r.stderr}`);

  return {
    dir,
    mpd: r.stdout,
    duracao: DURACAO,
    itags: TRILHAS.map((t) => t.itag),

    /**
     * Serve um itag honrando `Range` — e honrar é o ponto: um servidor que devolvesse o arquivo
     * inteiro faria o dash.js funcionar por acidente, aprovando um manifesto cujos ranges
     * poderiam estar todos errados.
     */
    servirBytes(req, res, itag) {
      const arq = path.join(dir, `${itag}.mp4`);
      if (!fs.existsSync(arq)) { res.writeHead(404); res.end(); return; }
      const total = fs.statSync(arq).size;
      const faixa = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!faixa) {
        res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes',
                             'content-type': 'video/mp4' });
        fs.createReadStream(arq).pipe(res);
        return;
      }
      const ini = Number(faixa[1]);
      const fim = faixa[2] ? Math.min(Number(faixa[2]), total - 1) : total - 1;
      res.writeHead(206, {
        'content-range': `bytes ${ini}-${fim}/${total}`,
        'content-length': fim - ini + 1,
        'accept-ranges': 'bytes',
        'content-type': 'video/mp4',
      });
      fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
    },

    limpar() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { montar, motivoDoSkip, DURACAO };
