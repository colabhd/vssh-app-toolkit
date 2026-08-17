"""A linha de comando do ffmpeg — onde moram os erros que não dão erro.

Dois erros de ffmpeg custam caro e nenhum deles se descobre lendo o código:

    `-ss` depois do `-i`  vira busca de SAÍDA: decodifica e joga fora tudo até o ponto. Buscar aos
                          40 min de um filme leva minutos em vez de instantes — por espectador.
    `-copyts`             mantém os timestamps absolutos. Como o frontend já soma o deslocamento
                          (`opcoes.tempo` da TuffMidia), o tempo mostrado ficaria dobrado.

Montar argv é aritmética de lista, e é assim que se mede: **nada aqui executa ffmpeg**. Quem executa
é `test_ffmpeg_real.py`, e os dois são necessários — uma linha bem formada pode gerar bytes que
ninguém toca, e foi o que aconteceu comigo aqui: eu justifiquei os `movflags` com uma alegação que
a medição desmentiu. O que ela vale está escrito lá.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from decisao import Decisao  # noqa: E402
from midia import achar_gpu, argv_de_fluxo, argv_de_legenda, argv_de_sonda, argv_de_teste_vaapi, escolher_gpu  # noqa: E402

ARQ = "/home/ana/Vídeos/o filme.mkv"

REMUX = Decisao(modo="remux", video="copiar", audio="copiar", faixa_audio=1)
SO_AUDIO = Decisao(modo="audio", video="copiar", audio="recodificar", faixa_audio=1)
TRANSCODE = Decisao(modo="transcode", video="recodificar", audio="recodificar", faixa_audio=1)


def pos(argv, item):
    return argv.index(item)


class TestOCanoTemDeTOCAR(unittest.TestCase):
    def test_os_tres_movflags_estao_la(self):
        # A forma; o VALOR de cada um está medido em `test_ffmpeg_real.py`. Em resumo do que se
        # mediu: sem `frag_keyframe` o ffmpeg recusa a saída não-buscável e não escreve byte algum,
        # e é `empty_moov` que faz aparecerem as caixas `moof` — a forma que o MSE exige, e para
        # onde a Fase 7 vai.
        argv = argv_de_fluxo(REMUX, ARQ)
        flags = argv[pos(argv, "-movflags") + 1]
        self.assertIn("frag_keyframe", flags)
        self.assertIn("empty_moov", flags)
        self.assertIn("default_base_moof", flags)

    def test_a_saida_e_um_cano_de_mp4(self):
        argv = argv_de_fluxo(REMUX, ARQ)
        self.assertEqual(argv[pos(argv, "-f") + 1], "mp4")
        self.assertEqual(argv[-1], "pipe:1")


class TestBusca(unittest.TestCase):
    def test_o_ss_vem_ANTES_do_i(self):
        # ⚠ Depois do `-i` o `-ss` vira busca de SAÍDA: o ffmpeg decodifica desde o começo e joga
        # fora tudo até o ponto pedido. Buscar aos 40 min de um filme passa de instantâneo a
        # minutos de CPU — e o servidor fica ocupado o tempo todo, por espectador.
        argv = argv_de_fluxo(REMUX, ARQ, inicio=2400)
        self.assertLess(pos(argv, "-ss"), pos(argv, "-i"),
                        "busca de saída: decodifica e descarta tudo até o ponto")
        self.assertEqual(argv[pos(argv, "-ss") + 1], "2400")

    def test_sem_busca_nao_ha_ss(self):
        # Um `-ss 0` não é inofensivo: ele faz o ffmpeg procurar um keyframe e pode cortar o
        # primeiro quadro. Não pedir é diferente de pedir zero.
        self.assertNotIn("-ss", argv_de_fluxo(REMUX, ARQ))
        self.assertNotIn("-ss", argv_de_fluxo(REMUX, ARQ, inicio=0))

    def test_NAO_usa_copyts(self):
        # ⚠ Com `-copyts` os timestamps saem absolutos. O frontend já soma o deslocamento —
        # `atual: () => base + video.currentTime` — então o tempo mostrado ficaria DOBRADO, e o
        # sintoma (a linha do tempo andando rápido demais) não aponta para a linha de comando.
        for inicio in (0, 2400):
            self.assertNotIn("-copyts", argv_de_fluxo(REMUX, ARQ, inicio=inicio))


class TestOsModos(unittest.TestCase):
    def test_remux_copia_os_dois_lados(self):
        argv = argv_de_fluxo(REMUX, ARQ)
        self.assertEqual(argv[pos(argv, "-c:v") + 1], "copy")
        self.assertEqual(argv[pos(argv, "-c:a") + 1], "copy")

    def test_so_o_audio_preserva_o_VIDEO(self):
        # A economia inteira do modo está aqui: o vídeo é onde estão os bytes, e ele passa intacto.
        argv = argv_de_fluxo(SO_AUDIO, ARQ)
        self.assertEqual(argv[pos(argv, "-c:v") + 1], "copy")
        self.assertEqual(argv[pos(argv, "-c:a") + 1], "aac")

    def test_o_audio_recodificado_vira_ESTEREO(self):
        # ⚠ 5.1 recodificado sem rebaixamento é onde nasce "não escuto o diálogo": o canal central
        # carrega a fala, e uma soma ingênua de seis canais para dois a enterra. O rebaixamento do
        # ffmpeg é o bom — pedi-lo é uma bandeira, não pedi-lo é uma reclamação.
        argv = argv_de_fluxo(SO_AUDIO, ARQ)
        self.assertEqual(argv[pos(argv, "-ac") + 1], "2")

    def test_transcode_com_GPU_usa_vaapi(self):
        argv = argv_de_fluxo(TRANSCODE, ARQ, gpu="/dev/dri/renderD128")
        self.assertEqual(argv[pos(argv, "-c:v") + 1], "h264_vaapi")
        self.assertEqual(argv[pos(argv, "-vaapi_device") + 1], "/dev/dri/renderD128")

    def test_transcode_sem_GPU_cai_na_CPU_e_e_o_ULTIMO_recurso(self):
        argv = argv_de_fluxo(TRANSCODE, ARQ)
        self.assertEqual(argv[pos(argv, "-c:v") + 1], "libx264")
        self.assertNotIn("-vaapi_device", argv)

    def test_o_modo_direto_NAO_tem_linha_de_comando(self):
        # ⚠ Devolver um argv aqui seria o pior tipo de defeito silencioso: o servidor gastaria CPU
        # remuxando um arquivo que o navegador abriria sozinho, e nada na tela mudaria.
        direto = Decisao(modo="direto", video="copiar", audio="copiar", faixa_audio=1)
        self.assertIsNone(argv_de_fluxo(direto, ARQ))
        self.assertIsNone(argv_de_fluxo(Decisao(modo="desconhecido"), ARQ))


class TestOAacQueVemEmADTS(unittest.TestCase):
    """O defeito que derrubou o primeiro `.avi` de verdade, e o log do servidor o nomeou:

        Malformed AAC bitstream detected: use the audio bitstream filter 'aac_adtstoasc'
        Error muxing a packet · Task finished with error code: -1

    Num AVI ou num MPEG-TS o AAC vem em ADTS, com um cabeçalho por quadro; o MP4 quer ASC, com a
    configuração numa caixa e os quadros crus. ⚠ E o ffmpeg escreve 24 KB ANTES de recusar — o
    bastante para o navegador desenhar um quadro e o problema parecer qualquer outra coisa.
    """

    def test_copiar_AAC_pede_o_filtro(self):
        argv = argv_de_fluxo(Decisao(modo="remux", video="copiar", audio="copiar",
                                     faixa_audio=1, codec_audio="aac"), ARQ)
        self.assertIn("-bsf:a", argv)
        self.assertEqual(argv[pos(argv, "-bsf:a") + 1], "aac_adtstoasc")

    def test_copiar_QUALQUER_OUTRO_codec_NAO_pede(self):
        # ⚠ Não é zelo: medido, `-bsf:a aac_adtstoasc` sobre MP3 mata o ffmpeg com EINVAL e zero
        # byte. Aplicá-lo "por segurança" trocaria um defeito de container por um defeito de codec.
        for codec in ("mp3", "ac3", "opus", "flac", "vorbis"):
            argv = argv_de_fluxo(Decisao(modo="remux", video="copiar", audio="copiar",
                                         faixa_audio=1, codec_audio=codec), ARQ)
            self.assertNotIn("-bsf:a", argv, f"o filtro do AAC vazou para {codec}")

    def test_RECODIFICAR_para_aac_nao_pede(self):
        # Quem recodifica produz ASC direto: o filtro ali seria sobre a entrada, que já foi
        # decodificada, e o ffmpeg recusa.
        argv = argv_de_fluxo(Decisao(modo="audio", video="copiar", audio="recodificar",
                                     faixa_audio=1, codec_audio="ac3"), ARQ)
        self.assertNotIn("-bsf:a", argv)

    def test_sem_codec_conhecido_nao_pede(self):
        # A decisão pode vir de um caminho que não soube o codec. Errar para o lado de não filtrar
        # é o certo: o pior caso é o ffmpeg reclamar alto, e não morrer com EINVAL.
        argv = argv_de_fluxo(Decisao(modo="remux", video="copiar", audio="copiar",
                                     faixa_audio=1), ARQ)
        self.assertNotIn("-bsf:a", argv)


class TestOTesteDaPLACA(unittest.TestCase):
    """⚠ Existir `/dev/dri/renderD*` NÃO prova que o VAAPI funciona, e a versão anterior desta
    função perguntava exatamente isso — com um comentário ao lado dizendo que não bastava. É o
    formato mais teimoso de dívida: o defeito escrito ao lado do código que o causa.

    O que aconteceu num servidor de verdade:

        libva: virtio_gpu_drv_video.so init failed
        Failed to initialise VAAPI connection: 2 (resource allocation failed)
        status 251, zero byte

    Uma GPU **virtual** — ela existe para desenhar tela, não para codificar vídeo, nenhum pacote
    resolve, e num ambiente virtualizado ela é o caso COMUM. Enumerar acerta onde não importa.
    """

    def test_a_linha_de_teste_SOBE_o_quadro_para_a_placa(self):
        # ⚠ Sem `format=nv12,hwupload` o `h264_vaapi` recusa a entrada, e o teste falharia por motivo
        # errado — declarando "não tem GPU" num servidor que tem. Um teste de capacidade que erra
        # para o lado do "não" desliga o recurso em silêncio.
        argv = argv_de_teste_vaapi("/dev/dri/renderD128")
        self.assertIn("hwupload", " ".join(argv))
        self.assertEqual(argv[argv.index("-vaapi_device") + 1], "/dev/dri/renderD128")
        self.assertEqual(argv[argv.index("-c:v") + 1], "h264_vaapi")

    def test_ele_CODIFICA_de_verdade_e_nao_escreve_arquivo(self):
        # `-f null -` é o que torna a medida barata: o trabalho de codificar acontece, e o resultado
        # é jogado fora. Meio segundo de vídeo, uma vez, no boot.
        self.assertEqual(argv_de_teste_vaapi("/dev/dri/renderD128")[-3:], ["-f", "null", "-"])
        self.assertIn("duration=0.5", " ".join(argv_de_teste_vaapi("/dev/dri/renderD128")))

    # ⚠ A regra é medida com o teste INJETADO, e não rodando ffmpeg: a suíte precisa reprovar uma
    # placa quebrada rodando numa máquina que não tem placa nenhuma. Foi por não fazer isso que a
    # primeira versão destes testes passou verde com a função errada — no Windows não há `/dev/dri`,
    # o laço nunca rodava, e a refutação não mordia.

    def test_o_dispositivo_que_FALHA_e_recusado(self):
        # O caso do servidor real: a virtio existe, aparece em `/dev/dri`, e não codifica.
        recusa = lambda c: (False, "libva: virtio_gpu_drv_video.so init failed")  # noqa: E731
        caminho, motivo = escolher_gpu(["/dev/dri/renderD128"], recusa)
        self.assertIsNone(caminho, "uma placa que não codifica foi anunciada como GPU")
        self.assertIn("virtio", motivo, "o motivo perdeu o que o ffmpeg disse")

    def test_o_que_CODIFICA_e_escolhido(self):
        caminho, motivo = escolher_gpu(["/dev/dri/renderD128"], lambda c: (True, "codifica"))
        self.assertEqual(caminho, "/dev/dri/renderD128")

    def test_com_varios_nodes_ele_procura_ate_achar(self):
        # ⚠ Não é hipótese: um servidor com placa integrada mais dedicada tem dois render nodes, e
        # costuma ser o SEGUNDO que codifica. Parar no primeiro desligaria o recurso onde ele existe.
        tentados = []

        def so_o_segundo(caminho):
            tentados.append(caminho)
            return (caminho.endswith("129"), "ok" if caminho.endswith("129") else "sem encoder")

        caminho, _ = escolher_gpu(["/dev/dri/renderD128", "/dev/dri/renderD129"], so_o_segundo)
        self.assertEqual(caminho, "/dev/dri/renderD129")
        self.assertEqual(len(tentados), 2)

    def test_sem_node_nenhum_a_resposta_e_None_com_MOTIVO(self):
        # ⚠ O motivo não é enfeite: sem ele o log do boot diz "sem VAAPI" e quem lê não distingue
        # "este servidor não tem placa" de "tem, e o driver está quebrado" — que pedem ações opostas.
        caminho, motivo = escolher_gpu([], lambda c: (True, "nunca chamado"))
        self.assertIsNone(caminho)
        self.assertTrue(motivo, "devolveu None sem dizer por quê")

    def test_achar_gpu_nao_LANCA_onde_nao_ha_dev_dri(self):
        # O app roda em Linux, mas a suíte roda onde quem desenvolve estiver — e um `achar_gpu` que
        # lançasse no boot mataria o processo antes de ele escutar.
        caminho, motivo = achar_gpu(tempo_limite=5)
        self.assertTrue(motivo)
        self.assertTrue(caminho is None or isinstance(caminho, str))


class TestFaixas(unittest.TestCase):
    def test_a_faixa_escolhida_e_a_MAPEADA(self):
        # Sem `-map`, o ffmpeg escolhe sozinho — e escolhe a "melhor", que costuma ser justamente
        # a de seis canais que o navegador não decodifica. Toda a escolha de faixa do `decisao.py`
        # seria perdida na última linha.
        argv = argv_de_fluxo(Decisao(modo="remux", video="copiar", audio="copiar", faixa_audio=3), ARQ)
        mapas = [argv[i + 1] for i, a in enumerate(argv) if a == "-map"]
        self.assertIn("0:3", mapas)
        self.assertIn("0:v:0", mapas)

    def test_arquivo_sem_audio_nao_mapeia_audio(self):
        mudo = Decisao(modo="remux", video="copiar", audio="nenhum", faixa_audio=None)
        argv = argv_de_fluxo(mudo, ARQ)
        mapas = [argv[i + 1] for i, a in enumerate(argv) if a == "-map"]
        self.assertEqual(mapas, ["0:v:0"])
        self.assertNotIn("-c:a", argv)


class TestSemShell(unittest.TestCase):
    def test_o_caminho_e_UM_argumento_e_nunca_uma_string_de_comando(self):
        # ⚠ O caminho vem do sistema de arquivos de quem usa, e pode conter espaço, aspas, ponto e
        # vírgula, `$(...)`. Como argv de lista isso é só um nome de arquivo; interpolado numa
        # string de shell, é execução de comando. A asserção prende a FORMA, que é o que garante
        # que ninguém "melhore" isto para uma string depois.
        veneno = "/home/ana/; rm -rf ~/.ssh; echo $(id) 'x'.mkv"
        for argv in (argv_de_fluxo(REMUX, veneno), argv_de_legenda(veneno, 2), argv_de_sonda(veneno)):
            self.assertIsInstance(argv, list)
            self.assertEqual(argv.count(veneno), 1, "o caminho tem de ser exatamente um elemento")
            self.assertTrue(all(isinstance(a, str) for a in argv))


class TestSonda(unittest.TestCase):
    def test_o_ffprobe_responde_JSON_e_so(self):
        argv = argv_de_sonda(ARQ)
        self.assertEqual(argv[0], "ffprobe")
        self.assertEqual(argv[pos(argv, "-print_format") + 1], "json")
        self.assertIn("-show_streams", argv)
        self.assertIn("-show_format", argv)


class TestLegenda(unittest.TestCase):
    def test_a_legenda_sai_em_webvtt(self):
        # O `<track>` do navegador só lê VTT. Um `.srt` embutido no MKV não serve como está, e a
        # conversão é barata — é texto.
        argv = argv_de_legenda(ARQ, 2)
        self.assertEqual(argv[pos(argv, "-f") + 1], "webvtt")
        self.assertIn("0:2", [argv[i + 1] for i, a in enumerate(argv) if a == "-map"])
        self.assertEqual(argv[-1], "pipe:1")


if __name__ == "__main__":
    unittest.main()
