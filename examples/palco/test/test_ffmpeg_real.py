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


def _caixas(dados):
    """As caixas de topo de um MP4, como `(nome, tamanho, deslocamento)`."""
    fora = []
    i = 0
    while i + 8 <= len(dados):
        n = struct.unpack(">I", dados[i:i + 4])[0]
        fora.append((dados[i + 4:i + 8].decode("latin1", "replace"), n, i))
        if n < 8:
            break
        i += n
    return fora


def caixas_de(dados):
    """Os nomes das caixas de topo de um MP4, contados."""
    fora = {}
    for nome, _, _ in _caixas(dados):
        fora[nome] = fora.get(nome, 0) + 1
    return fora


def _ate_o_primeiro_fragmento(dados):
    """Quantos bytes têm de chegar antes de o primeiro quadro poder ser desenhado.

    É onde termina o par `moof`+`mdat` inicial: antes disso o demuxer tem cabeçalho e nenhuma
    amostra completa. É a medida que corresponde ao que a pessoa sente.
    """
    cx = _caixas(dados)
    i = next(k for k, (n, _, _) in enumerate(cx) if n == "moof")
    _, tam, desloc = cx[i + 1]
    return desloc + tam


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

        # ⚠ A refutação tira `-frag_duration` TAMBÉM, e a correção veio de o teste falhar: ele
        # sozinho já é um gatilho de fragmentação, então com ele no argv o ffmpeg não recusa mais
        # nada e a medição não mediria o que diz medir. Quem pede um cano tem de pedir explicitamente
        # — por qualquer um dos dois caminhos —, e é essa a propriedade sob teste.
        argv = argv_de_fluxo(d, self.arquivo)
        i = argv.index("-frag_duration")
        sem_flags = [a for k, a in enumerate(argv)
                     if k not in (i, i + 1) and a != "-movflags" and not a.startswith("+frag_keyframe")]
        vazio, erro, codigo = self._canalizar(sem_flags)
        self.assertNotEqual(codigo, 0, "sem pedido nenhum de fragmentação o ffmpeg tinha de recusar")
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

    def test_o_AAC_em_ADTS_so_entra_no_MP4_com_o_FILTRO(self):
        """O defeito de verdade, com um arquivo de verdade — e a refutação junto.

        Um `.avi` real derrubou o cano e o log do servidor nomeou a causa: *"Malformed AAC bitstream
        detected: use the audio bitstream filter 'aac_adtstoasc'"*, status 255, **depois de já ter
        escrito 24 KB**. Era o suficiente para o navegador desenhar um quadro.

        ⚠ **O `.ts` aqui não é substituto arbitrário do `.avi`: é o caso que ainda falha.** As
        versões novas do ffmpeg inserem o filtro sozinhas em alguns containers, e no meu AVI local
        (8.1.1) a linha SEM o filtro passa. É exatamente a armadilha que fez o defeito chegar
        publicado: funciona na máquina de quem escreve e falha na de quem instala. O MPEG-TS ainda
        recusa nas duas, então é ele que consegue medir a diferença.
        """
        origem = os.path.join(self.dir, "adts.ts")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-c:a", "aac",
            "-y", origem,
        ], check=True, capture_output=True)

        d = decidir(sondar_arquivo(origem), MAGRO)
        self.assertEqual((d.audio, d.codec_audio), ("copiar", "aac"),
                         "a decisão precisa levar o codec para midia.py poder escolher o filtro")

        argv = argv_de_fluxo(d, origem)
        self.assertIn("-bsf:a", argv)
        dados, erro, codigo = self._canalizar(argv)
        self.assertEqual(codigo, 0, erro)
        self.assertGreater(len(dados), 1000)

        # A refutação: a MESMA linha sem o filtro. Ela tem de falhar — e falhar DEPOIS de escrever
        # alguns bytes, que é a metade do defeito que o torna difícil de ler na tela.
        sem = [a for a in argv if a not in ("-bsf:a", "aac_adtstoasc")]
        parcial, erro, codigo = self._canalizar(sem)
        self.assertNotEqual(codigo, 0, "sem o filtro o ffmpeg tinha de recusar este AAC")
        self.assertIn("aac_adtstoasc", erro)
        self.assertGreater(len(parcial), 0,
                           "e escrever bytes antes de recusar — é por isso que o vídeo 'quase' toca")

    def test_o_filtro_e_INOCUO_onde_o_AAC_ja_esta_certo(self):
        # ⚠ A outra metade da regra. Se o filtro estragasse o AAC que já vem de um MKV, o conserto
        # teria trocado um container quebrado por todos os outros. Medido: a saída é a mesma.
        origem = os.path.join(self.dir, "aac.mkv")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-c:a", "aac",
            "-y", origem,
        ], check=True, capture_output=True)

        argv = argv_de_fluxo(decidir(sondar_arquivo(origem), MAGRO), origem)
        com, erro, codigo = self._canalizar(argv)
        self.assertEqual(codigo, 0, erro)
        sem, _, _ = self._canalizar([a for a in argv if a not in ("-bsf:a", "aac_adtstoasc")])
        self.assertEqual(com, sem, "o filtro mudou os bytes de um AAC que já estava em ASC")

    def test_o_filtro_do_AAC_NAO_vaza_para_outro_codec(self):
        # Medido: `-bsf:a aac_adtstoasc` sobre MP3 mata o ffmpeg com EINVAL e zero byte. A guarda é
        # a condição por codec em `midia.py`; aqui se mede que a consequência é real.
        origem = os.path.join(self.dir, "mp3.avi")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "libmp3lame",
            "-y", origem,
        ], check=True, capture_output=True)

        # ⚠ Um perfil que TOCA mp3, e não o `MAGRO`: com o magro a decisão recodifica o áudio, e o
        # caso sob medida — *copiar* um codec que não é AAC — nem chegaria a acontecer. Foi assim
        # que a primeira versão deste teste passou medindo outra coisa.
        toca_mp3 = Perfil(containers={"mp4"}, video={"h264"}, audio={"aac", "mp3"})
        d = decidir(sondar_arquivo(origem), toca_mp3)
        self.assertEqual((d.audio, d.codec_audio), ("copiar", "mp3"))

        argv = argv_de_fluxo(d, origem)
        self.assertNotIn("-bsf:a", argv, "o filtro do AAC vazou para um arquivo com MP3")
        dados, erro, codigo = self._canalizar(argv)
        self.assertEqual(codigo, 0, erro)

        i = argv.index("-movflags")
        quebrado, _, codigo = self._canalizar(argv[:i] + ["-bsf:a", "aac_adtstoasc"] + argv[i:])
        self.assertNotEqual(codigo, 0, "aplicar o filtro sobre MP3 tinha de matar o ffmpeg")
        self.assertEqual(len(quebrado), 0)

    def test_o_fragmento_tem_TETO_DE_TEMPO_e_nao_o_tamanho_do_GOP(self):
        """A reprodução aos trancos, medida em bytes de espera.

        O player não desenha nada antes de o fragmento FECHAR. Com `frag_keyframe` sozinho o
        fragmento tem o tamanho do GOP — num encode de acervo, oito segundos —, e o resultado é
        tocar um pedaço, parar, tocar outro. Foi o que se viu depois de o `.avi` finalmente abrir.

        ⚠ A medida é **onde termina o primeiro par `moof`+`mdat`**, e não o número de fragmentos:
        é literalmente quantos bytes têm de chegar antes do primeiro quadro aparecer.
        """
        origem = os.path.join(self.dir, "gop-longo.avi")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=12",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
            # ⚠ `-g 250` não é exagero de teste: é o padrão do x264 e o que há em quase todo arquivo
            # de acervo. Um GOP curto esconderia o defeito exatamente como ele se escondeu de mim.
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "250", "-c:a", "aac",
            "-y", origem,
        ], check=True, capture_output=True)

        argv = argv_de_fluxo(decidir(sondar_arquivo(origem), MAGRO), origem)
        self.assertIn("-frag_duration", argv)

        com, erro, codigo = self._canalizar(argv)
        self.assertEqual(codigo, 0, erro)
        sem, _, codigo = self._canalizar(
            [a for a in argv if a not in ("-frag_duration", argv[argv.index("-frag_duration") + 1])])
        self.assertEqual(codigo, 0)

        espera_com = _ate_o_primeiro_fragmento(com)
        espera_sem = _ate_o_primeiro_fragmento(sem)
        self.assertLess(espera_com * 3, espera_sem,
                        f"o teto de tempo não encurtou a espera ({espera_com} contra {espera_sem} "
                        "bytes até o primeiro quadro poder ser desenhado)")
        # E o preço tem de continuar sendo só cabeçalho: se isto disparar, o teto ficou curto demais.
        self.assertLess(len(com), len(sem) * 1.02, "fragmentar assim custou mais que 2% de bytes")

    def test_fragmentar_mais_NAO_estraga_os_timestamps(self):
        # ⚠ A outra metade: cortar fragmento fora de keyframe é legítimo, mas se produzisse tempo
        # torto o conserto teria trocado travamento por dessincronia — que é pior, porque a pessoa
        # não sabe dizer o que está errado.
        d = decidir(sondar_arquivo(self.arquivo), MAGRO)
        dados, erro, codigo = self._canalizar(argv_de_fluxo(d, self.arquivo))
        self.assertEqual(codigo, 0, erro)
        saida = os.path.join(self.dir, "fragmentado.mp4")
        with open(saida, "wb") as fh:
            fh.write(dados)
        pacotes = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=dts_time",
             "-print_format", "json", saida], capture_output=True, check=True).stdout)["packets"]
        dts = [float(p["dts_time"]) for p in pacotes]
        self.assertGreater(len(dts), 10)
        fora = [(a, b) for a, b in zip(dts, dts[1:]) if b <= a]
        self.assertEqual(fora, [], "os timestamps saíram fora de ordem depois de fragmentar")

    def test_a_sonda_e_GUARDADA_e_o_ARQUIVO_MUDADO_a_invalida(self):
        """A sonda era refeita duas vezes por abertura e mais uma a cada busca — processo novo
        sempre, por uma resposta que não muda. Aqui se mede que ela é guardada **e**, o que importa
        mais, que a memória tem por onde ser desfeita.

        ⚠ A invalidação não é zelo: um arquivo que ainda está sendo copiado ou baixado muda de
        duração enquanto se olha para ele. Uma memória por CAMINHO serviria a duração antiga para
        sempre — linha do tempo mentindo e busca caindo no lugar errado, sem nada indicando o
        motivo. Por isso a chave leva `mtime` e tamanho.
        """
        copia = os.path.join(self.dir, "guardada.mkv")
        shutil.copyfile(self.arquivo, copia)

        primeira = sondar_arquivo(copia)
        segunda = sondar_arquivo(copia)
        self.assertIs(segunda, primeira, "a segunda sonda do MESMO arquivo rodou o ffprobe de novo")

        # Mexer no arquivo tem de descartar o que estava guardado. `+1s` porque a resolução do
        # mtime não é infinita, e um teste que escreve e lê no mesmo instante mediria sorte.
        st = os.stat(copia)
        os.utime(copia, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        terceira = sondar_arquivo(copia)
        self.assertIsNot(terceira, primeira,
                         "o arquivo mudou e a sonda velha continuou valendo — é assim que a duração "
                         "de um download em andamento fica congelada para sempre")
        self.assertEqual(terceira.duracao, primeira.duracao)   # mesmo conteúdo, mesma resposta

    def test_uma_sonda_que_FALHOU_nao_fica_guardada(self):
        """⚠ Guardar a falha marcaria o arquivo como "desconhecido" até o processo reiniciar, e
        quem está usando não teria como desfazer isso a não ser fechando o app. Um `ffprobe` que
        estourou o prazo porque o disco estava ocupado é temporário; o efeito não pode ser.

        ⚠ **Duas versões deste teste não mediam nada**, e as duas razões valem mais que o teste:

        1. A primeira usava um arquivo INEXISTENTE. Sem arquivo não há `stat`, sem `stat` não há
           chave, e sem chave nada seria guardado de qualquer maneira — passava com a memória certa
           e com a errada. O caso que separa as duas é o arquivo que existe e cuja sonda falhou.
        2. A segunda conferia `container`, que **vem da extensão do nome** e não do `ffprobe`: uma
           sonda vazia de um `.mkv` continua respondendo `matroska`. O que só uma sonda bem-sucedida
           produz é `duracao` — e é nela que a diferença aparece.
        """
        copia = os.path.join(self.dir, "prazo.mkv")
        shutil.copyfile(self.arquivo, copia)

        vazia = sondar_arquivo(copia, tempo_limite=0.001)   # não dá tempo nem de o ffprobe abrir
        self.assertIsNone(vazia.duracao, "o prazo curto tinha de derrubar a sonda")
        self.assertEqual(decidir(vazia, MAGRO).modo, "desconhecido")

        # Mesmo arquivo, mesma chave, prazo normal: tem de sondar de novo.
        agora = sondar_arquivo(copia)
        self.assertIsNotNone(agora.duracao,
                             "a sonda vazia ficou guardada, e o arquivo seguiu 'desconhecido' mesmo "
                             "com o ffprobe voltando a funcionar")

    def test_a_legenda_embutida_vira_VTT(self):
        s = sondar_arquivo(self.arquivo)
        dados, erro, codigo = self._canalizar(argv_de_legenda(self.arquivo, s.legendas[0].indice))
        self.assertEqual(codigo, 0, erro)
        texto = dados.decode("utf-8", "replace")
        self.assertTrue(texto.startswith("WEBVTT"), f"não é VTT: {texto[:40]!r}")
        self.assertIn("uma legenda", texto)


if __name__ == "__main__":
    unittest.main()
