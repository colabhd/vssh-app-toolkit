"""O ffmpeg de verdade, com um arquivo de verdade — porque argv não prova saída.

`test_midia.py` mede a FORMA da linha de comando; este mede o que ela produz. Os dois são
necessários e nenhum substitui o outro: uma linha bem formada pode gerar bytes que ninguém toca, e
foi exatamente o que aconteceu comigo aqui.

⚠ **O comentário que este arquivo corrigiu.** Eu havia escrito que, sem `empty_moov`, o ffmpeg
"sai com status zero e entrega bytes que player nenhum abre". Medido, é falso nas duas metades:

    sem movflags NENHUM    ele RECUSA, alto: "muxer does not support non seekable output",
                           status 127, zero byte. Não é falha silenciosa.
    sem `empty_moov`       o cano flui igual (primeiro byte em 0,03 s nos dois casos). O que muda
                           é a estrutura: com ele saem caixas `moof`, sem ele não sai nenhuma.

Ou seja: `frag_keyframe` é o que torna o cano possível, e `empty_moov` é o que torna a saída um
fMP4 de verdade — que é o que o MSE exige, e é para lá que a Fase 7 (dash.js) vai. Manter os dois
é barato e correto; a justificativa é que estava errada.

Sem ffmpeg os testes se PULAM, pelo mesmo motivo dos de navegador: falha por ausência de ambiente é
ruído, e quem só mexeu em análise de URL não pode ficar com a suíte vermelha por isso.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from decisao import Perfil, decidir  # noqa: E402
from midia import argv_de_fluxo, argv_de_legenda, sondar_arquivo  # noqa: E402

TEM_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
PULAR = unittest.skipUnless(TEM_FFMPEG, "sem ffmpeg/ffprobe neste ambiente")

# Um cliente que não abre Matroska nem decodifica AC3 — o que força remux e recodificação de áudio.
MAGRO = Perfil(containers={"mp4"}, video={"h264"}, audio={"aac"})


def caixas_de(dados):
    """Os nomes das caixas de topo de um MP4, contados."""
    fora = {}
    i = 0
    while i + 8 <= len(dados):
        n = struct.unpack(">I", dados[i:i + 8][:4])[0]
        nome = dados[i + 4:i + 8].decode("latin1", "replace")
        fora[nome] = fora.get(nome, 0) + 1
        if n < 8:
            break
        i += n
    return fora


@unittest.skipUnless(TEM_FFMPEG, "sem ffmpeg/ffprobe neste ambiente")
class TestComArquivoDeVerdade(unittest.TestCase):
    """Um MKV com H.264 + AC3 + legenda: o caso que o Palco existe para resolver."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="palco-ffmpeg-")
        cls.arquivo = os.path.join(cls.dir, "amostra.mkv")
        legenda = os.path.join(cls.dir, "l.srt")
        with open(legenda, "w", encoding="utf-8") as fh:
            fh.write("1\n00:00:00,500 --> 00:00:02,000\numa legenda\n")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=4",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
            "-i", legenda,
            "-map", "0:v", "-map", "1:a", "-map", "2:s",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "15",
            "-c:a", "ac3", "-c:s", "srt",
            "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=Original",
            "-metadata:s:s:0", "language=por",
            "-y", cls.arquivo,
        ], check=True, capture_output=True)

    # ── A sonda ──────────────────────────────────────────────────────────────

    def test_a_sonda_le_o_arquivo_como_ele_e(self):
        s = sondar_arquivo(self.arquivo)
        self.assertEqual(s.container, "matroska")
        self.assertEqual(s.video.codec, "h264")
        self.assertEqual((s.video.largura, s.video.altura), (320, 240))
        self.assertEqual([f.codec for f in s.audios], ["ac3"])
        self.assertEqual(s.audios[0].idioma, "eng")
        self.assertEqual(s.audios[0].titulo, "Original")
        self.assertEqual([(f.codec, f.idioma) for f in s.legendas], [("subrip", "por")])
        self.assertAlmostEqual(s.duracao, 4.0, delta=0.5)

    def test_ffprobe_ausente_ou_torto_vira_sonda_vazia(self):
        # Não é hipótese: um `.mkv` truncado por download interrompido é comum. A resposta certa é
        # o modo `desconhecido`, que a interface sabe mostrar — e não uma exceção virando 500.
        quebrado = os.path.join(self.dir, "truncado.mkv")
        with open(self.arquivo, "rb") as fonte, open(quebrado, "wb") as saida:
            saida.write(fonte.read(200))
        s = sondar_arquivo(quebrado)
        self.assertEqual(decidir(s, MAGRO).modo, "desconhecido")

    # ── O cano ───────────────────────────────────────────────────────────────

    def _canalizar(self, argv):
        p = subprocess.run(argv, capture_output=True, timeout=60)
        return p.stdout, p.stderr.decode("utf-8", "replace"), p.returncode

    def test_o_cano_do_modo_AUDIO_sai_tocavel(self):
        # ⚠ O caso completo, ponta a ponta: MKV que o cliente não abre + AC3 que ele não decodifica.
        # A decisão sai de `decisao.py`, a linha sai de `midia.py`, e aqui se confere que o
        # resultado é mídia de verdade — com o VÍDEO copiado, que é a economia inteira do modo.
        d = decidir(sondar_arquivo(self.arquivo), MAGRO)
        self.assertEqual((d.modo, d.video, d.audio), ("audio", "copiar", "recodificar"))

        dados, erro, codigo = self._canalizar(argv_de_fluxo(d, self.arquivo))
        self.assertEqual(codigo, 0, erro)
        self.assertGreater(len(dados), 1000, "o cano não produziu mídia")

        saida = os.path.join(self.dir, "saida.mp4")
        with open(saida, "wb") as fh:
            fh.write(dados)
        info = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", saida],
            capture_output=True, check=True).stdout)
        codecs = sorted(s["codec_name"] for s in info["streams"])
        self.assertEqual(codecs, ["aac", "h264"], "o vídeo tinha de passar intacto e o áudio virar AAC")

    def test_a_saida_e_fMP4_de_verdade_e_os_movflags_SAO_carregantes(self):
        # ⚠ A refutação, medida em vez de afirmada. Sem `movflags` nenhum o ffmpeg RECUSA a saída
        # não-buscável e não escreve byte algum — não é falha silenciosa, é falha alta. E é o
        # `empty_moov` que faz aparecer `moof`, que é a forma que o MSE exige (e para onde a
        # Fase 7, com dash.js, vai).
        d = decidir(sondar_arquivo(self.arquivo), MAGRO)
        nosso, _, codigo = self._canalizar(argv_de_fluxo(d, self.arquivo))
        self.assertEqual(codigo, 0)
        self.assertIn("moof", caixas_de(nosso), "a saída não está fragmentada")

        sem_flags = [a for a in argv_de_fluxo(d, self.arquivo) if a != "-movflags"]
        sem_flags = [a for a in sem_flags if not a.startswith("+frag_keyframe")]
        vazio, erro, codigo = self._canalizar(sem_flags)
        self.assertNotEqual(codigo, 0, "sem os movflags o ffmpeg tinha de recusar")
        self.assertEqual(len(vazio), 0, "e não escrever byte nenhum")
        self.assertIn("non seekable", erro)

    def test_a_busca_do_lado_do_SERVIDOR_pula_de_verdade(self):
        # É o que substitui o Range num cano: o frontend troca a fonte por `?t=`, o ffmpeg recomeça
        # com `-ss`, e o que sai é mais curto. Sem isto a linha do tempo seria decoração no único
        # modo em que a busca depende de nós.
        d = decidir(sondar_arquivo(self.arquivo), MAGRO)
        inteiro, _, _ = self._canalizar(argv_de_fluxo(d, self.arquivo))
        do_meio, erro, codigo = self._canalizar(argv_de_fluxo(d, self.arquivo, inicio=2))
        self.assertEqual(codigo, 0, erro)
        self.assertLess(len(do_meio), len(inteiro) * 0.85,
                        "buscar aos 2 s de 4 s tinha de render bem menos bytes")

    def test_a_legenda_embutida_vira_VTT(self):
        s = sondar_arquivo(self.arquivo)
        dados, erro, codigo = self._canalizar(argv_de_legenda(self.arquivo, s.legendas[0].indice))
        self.assertEqual(codigo, 0, erro)
        texto = dados.decode("utf-8", "replace")
        self.assertTrue(texto.startswith("WEBVTT"), f"não é VTT: {texto[:40]!r}")
        self.assertIn("uma legenda", texto)


if __name__ == "__main__":
    unittest.main()
