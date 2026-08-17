"""Direto, remux, só o áudio, transcode — e quem decide não é só o servidor.

─── A correção que este arquivo existe para prender ─────────────────────────

O desenho anterior mandava o `ffprobe` escolher o modo sozinho. Está errado, e o erro é caro: quem
sabe o que consegue decodificar é o **cliente**, e isso varia por máquina, por sistema e por versão
do navegador. Medido em Chrome 151 headless, `hvc1` é `False` tanto em `MediaSource.isTypeSupported`
quanto em `VideoDecoder.isConfigSupported`; num Chrome de mesa com decodificação por hardware o
mesmo `hvc1` costuma ser `True`. Uma tabela fixa no servidor transcodificaria a 180% de CPU para
metade das máquinas — e serviria vídeo pior do que o original para elas.

Então: o `ffprobe` responde **o que o arquivo é**, o perfil responde **o que a máquina aceita**, e
do encontro sai o modo. É o modelo de *device profile* do Jellyfin, e é a única forma conhecida de
não errar para os dois lados.

O JSON aqui é gravado, e nenhum teste chama `ffprobe`. Medir a decisão não exige mídia: exige as
respostas que a mídia produz.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from decisao import PERFIL_MINIMO, Perfil, decidir, sondar  # noqa: E402


def ffprobe(formato, streams, duracao="3617.234000"):
    """Uma resposta de `ffprobe -show_format -show_streams -print_format json`."""
    return {"format": {"format_name": formato, "duration": duracao}, "streams": streams}


def video(codec, indice=0, **extra):
    s = {"index": indice, "codec_type": "video", "codec_name": codec,
         "width": 1920, "height": 1080}
    s.update(extra)
    return s


def audio(codec, indice=1, canais=2, **extra):
    s = {"index": indice, "codec_type": "audio", "codec_name": codec, "channels": canais}
    s.update(extra)
    return s


# O que um Chrome de hoje respondeu quando perguntado — a tabela medida, virada em perfil.
#
# ⚠ `containers` saiu de `video.canPlayType()`, e não de `MediaSource.isTypeSupported()`. As duas
# discordam em metade dos casos que importam, e a primeira é a pergunta do caminho direto. Foi
# medindo isto que `matroska` entrou na lista: o Chrome demuxa `.mkv` sozinho, e o remux que eu
# dava como certo para todo MKV não existe.
CHROME = Perfil(
    containers={"mp4", "webm", "matroska", "mp3", "flac", "wav", "ogg"},
    video={"h264", "vp9", "av1"},
    audio={"aac", "opus", "mp3", "flac"},
)


class TestOsQuatroModos(unittest.TestCase):
    def test_direto_nao_toca_no_servidor(self):
        # O caso que mais importa acertar, porque é o mais comum e o único de graça: o arquivo sai
        # do portal com Range nativo e o servidor não gasta um ciclo.
        s = sondar(ffprobe("mov,mp4,m4a,3gp,3g2,mj2", [video("h264"), audio("aac")]), "filme.mp4")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "direto")
        self.assertEqual((d.video, d.audio), ("copiar", "copiar"))

    def test_remux_quando_so_a_embalagem_esta_errada(self):
        # ⚠ Esta é a diferença entre 2% e 180% de CPU, e ela se perde com uma linha de código
        # descuidada: os codecs estão perfeitos, só o recipiente é que o navegador não abre.
        s = sondar(ffprobe("avi", [video("h264"), audio("aac")]), "filme.avi")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "remux")
        self.assertEqual((d.video, d.audio), ("copiar", "copiar"))

    def test_o_MKV_comum_NAO_precisa_de_remux(self):
        # ⚠ Medido, e contra o que eu supunha: `canPlayType('video/x-matroska')` é `probably` no
        # Chrome. O `.mkv` com H.264+AAC toca DIRETO. Eu havia medido só
        # `MediaSource.isTypeSupported`, que responde `false` — mas essa é a pergunta do remux, e
        # não a do caminho direto. A suposição custaria 2% de CPU por espectador, para sempre, no
        # formato mais comum de filme que existe.
        s = sondar(ffprobe("matroska,webm", [video("h264"), audio("aac")]), "filme.mkv")
        self.assertEqual(decidir(s, CHROME).modo, "direto")

    def test_so_o_audio_desmancha_o_pior_caso(self):
        # `MKV + H.264 + AC3` parecia transcode de 180%. Não é: é recipiente errado (barato) mais
        # áudio sem decodificador (barato). O VÍDEO passa intacto — que é onde estão os bytes.
        s = sondar(ffprobe("matroska,webm", [video("h264"), audio("ac3", canais=6)]), "filme.mkv")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "audio")
        self.assertEqual((d.video, d.audio), ("copiar", "recodificar"))

    def test_transcode_e_o_ultimo_recurso(self):
        s = sondar(ffprobe("matroska,webm", [video("hevc"), audio("aac")]), "filme.mkv")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "transcode")
        self.assertEqual(d.video, "recodificar")


class TestOAviComQuadrosReordenados(unittest.TestCase):
    """O defeito que só apareceu com um arquivo real na mão, e que se disfarçava de tudo menos do
    que era.

    O AVI guarda ordem de DECODIFICAÇÃO e nada mais — não tem PTS. Com B-frames a ordem de exibição
    é outra, e a informação que liga as duas mora dentro do fluxo H.264, onde só um decodificador
    chega. `-c:v copy` então escreve `pts == dts` em todo quadro e o navegador exibe fora de ordem.

    Medido em Chrome 152, o MESMO arquivo servido como MP4 comum de disco, sem cano no meio:

        copiando o vídeo       25,8% dos quadros descartados
        `-fflags +genpts`      25,8%  (produz `ctts`, mas é deslocamento, não reordenação)
        reencodando             0,0%

    ⚠ Por isso a regra não pode ser "AVI reencoda": um AVI SEM B-frames tem ordem de exibição igual
    à de decodificação, o remux está correto, e reencodar custaria 100% de CPU por nada.
    """

    def test_avi_com_B_frames_tem_de_RECODIFICAR_o_video(self):
        s = sondar(ffprobe("avi", [video("h264", has_b_frames=2), audio("aac")]), "filme.avi")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "transcode")
        self.assertEqual(d.video, "recodificar")
        self.assertIn("ordem de exibição", d.motivo)

    def test_avi_SEM_B_frames_continua_barato(self):
        # ⚠ A metade que impede o conserto de virar desperdício. Sem esta condição, todo `.avi` do
        # mundo passaria pelo x264 — inclusive os que o remux resolve por 2%.
        s = sondar(ffprobe("avi", [video("h264", has_b_frames=0), audio("aac")]), "filme.avi")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "remux")
        self.assertEqual(d.video, "copiar")

    def test_MKV_com_B_frames_nao_e_afetado(self):
        # Matroska guarda a ordem de exibição. A regra é do CONTAINER, não do B-frame.
        s = sondar(ffprobe("matroska,webm", [video("h264", has_b_frames=2), audio("aac")]),
                   "filme.mkv")
        self.assertEqual(decidir(s, CHROME).modo, "direto")

    def test_o_codec_que_a_maquina_nao_toca_vence_o_container(self):
        # Quando a máquina já não decodifica o codec a conversa acabou de qualquer jeito, e o motivo
        # que a pessoa lê tem de ser esse — não uma explicação sobre ordem de quadros.
        s = sondar(ffprobe("avi", [video("hevc", has_b_frames=2), audio("aac")]), "filme.avi")
        self.assertIn("não decodifica hevc", decidir(s, CHROME).motivo)

    def test_recodificar_o_VIDEO_nao_arrasta_o_audio_junto(self):
        # ⚠ O áudio segue a decisão dele. Antes o transcode forçava recodificar sempre, e um AAC
        # que o cliente toca perfeitamente ia para o encoder junto — CPU a mais no caso que já é o
        # mais caro de todos.
        s = sondar(ffprobe("avi", [video("h264", has_b_frames=2), audio("aac")]), "filme.avi")
        d = decidir(s, CHROME)
        self.assertEqual((d.video, d.audio), ("recodificar", "copiar"))
        self.assertEqual(d.codec_audio, "aac")   # e o filtro de ADTS continua sendo escolhido

    def test_audio_que_NAO_toca_continua_sendo_recodificado(self):
        s = sondar(ffprobe("avi", [video("h264", has_b_frames=2), audio("ac3", canais=6)]),
                   "filme.avi")
        self.assertEqual(decidir(s, CHROME).audio, "recodificar")


class TestOPerfilEQueDecide(unittest.TestCase):
    """A razão de o perfil existir, num par de casos que se contradizem."""

    ARQUIVO = ffprobe("matroska,webm", [video("hevc"), audio("aac")])

    def test_o_MESMO_arquivo_muda_de_modo_com_a_maquina(self):
        # ⚠ É o teste que reprova qualquer tabela fixa no servidor. Mesmo arquivo, mesma sonda,
        # dois clientes — e as respostas certas são opostas.
        s = sondar(self.ARQUIVO, "filme.mkv")

        sem_hevc = decidir(s, CHROME)
        com_hevc = decidir(s, Perfil(containers={"mp4"}, video={"h264", "hevc"}, audio={"aac"}))

        self.assertEqual(sem_hevc.modo, "transcode")
        self.assertEqual(com_hevc.modo, "remux",
                         "um cliente que decodifica HEVC só precisa da embalagem trocada; "
                         "transcodificar para ele queima CPU e entrega vídeo pior que o original")

    def test_sem_perfil_a_escolha_pende_para_o_LADO_SEGURO(self):
        # Um cliente que não relatou nada (versão velha do frontend, requisição de fora) recebe o
        # que todo navegador toca desde sempre. Erra para o lado de gastar CPU, e não para o lado
        # da tela preta: o primeiro custa dinheiro, o segundo parece o app quebrado.
        s = sondar(self.ARQUIVO, "filme.mkv")
        self.assertEqual(decidir(s, PERFIL_MINIMO).modo, "transcode")
        self.assertEqual(decidir(s, None).modo, "transcode")

    def test_e_o_minimo_toca_o_que_todo_mundo_toca(self):
        s = sondar(ffprobe("mov,mp4,m4a,3gp,3g2,mj2", [video("h264"), audio("aac")]), "f.mp4")
        self.assertEqual(decidir(s, PERFIL_MINIMO).modo, "direto")


class TestEscolhaDeFaixa(unittest.TestCase):
    def test_a_faixa_padrao_que_nao_toca_TIRA_o_modo_direto(self):
        # ⚠ O caso que só aparece olhando o modo direto de perto, e o defeito que ele evita é o
        # pior tipo: **no direto quem escolhe a faixa é o navegador**, porque o arquivo vai inteiro
        # e ele toca a `default`. Um MKV de filme costuma trazer AC3 em primeiro (o original) e AAC
        # em segundo (a compatível). Servido direto, o Chrome cai na AC3, que ele não decodifica —
        # e o resultado é imagem sem som. Nada falha, nada registra, e quem assiste conclui que o
        # arquivo é que está mudo.
        #
        # Existir uma faixa boa não basta: ela tem de ser a padrão. Não sendo, um `-c copy` que a
        # põe na frente custa ~2% e resolve.
        s = sondar(ffprobe("matroska,webm", [
            video("h264"),
            audio("ac3", indice=1, canais=6, disposition={"default": 1}),
            audio("aac", indice=2),
        ]), "filme.mkv")
        d = decidir(s, CHROME)
        self.assertEqual(d.modo, "remux", "serviu direto, e o navegador tocaria a faixa AC3 — mudo")
        self.assertEqual(d.audio, "copiar", "recodificar não: a faixa boa já existe no arquivo")
        self.assertEqual(d.faixa_audio, 2)

    def test_a_faixa_padrao_que_toca_mantem_o_direto(self):
        # O espelho do anterior: mesma dupla de faixas, ordem invertida. Sem esta metade, a regra
        # viraria "todo arquivo com mais de uma faixa é remuxado".
        s = sondar(ffprobe("matroska,webm", [
            video("h264"),
            audio("aac", indice=1, disposition={"default": 1}),
            audio("ac3", indice=2, canais=6),
        ]), "filme.mkv")
        d = decidir(s, CHROME)
        self.assertEqual((d.modo, d.faixa_audio), ("direto", 1))

    def test_nao_havendo_nenhuma_que_toque_recodifica_a_primeira(self):
        s = sondar(ffprobe("matroska,webm", [
            video("h264"), audio("ac3", indice=1, canais=6), audio("dts", indice=2, canais=6),
        ]), "filme.mkv")
        d = decidir(s, CHROME)
        self.assertEqual((d.modo, d.audio, d.faixa_audio), ("audio", "recodificar", 1))

    def test_video_mudo_nao_vira_problema_de_audio(self):
        s = sondar(ffprobe("mov,mp4,m4a,3gp,3g2,mj2", [video("h264")]), "captura.mp4")
        d = decidir(s, CHROME)
        self.assertEqual((d.modo, d.audio), ("direto", "nenhum"))


class TestMusica(unittest.TestCase):
    """O Palco é o player DO AMBIENTE: um álbum tem de tocar tão bem quanto um filme."""

    def test_a_capa_do_album_NAO_e_uma_faixa_de_video(self):
        # ⚠ O defeito clássico, e ele não aparece testando com filme: um MP3 com capa embutida
        # traz um stream de vídeo `mjpeg` com `attached_pic: 1`. Sem filtrar, todo arquivo de
        # música com capa vira "vídeo em MJPEG" e cai em transcode — a 100% de CPU, para tocar uma
        # música que sairia direto.
        s = sondar(ffprobe("mp3", [
            video("mjpeg", indice=0, disposition={"attached_pic": 1}),
            audio("mp3", indice=1),
        ], duracao="212.5"), "musica.mp3")
        self.assertIsNone(s.video)
        d = decidir(s, CHROME)
        self.assertEqual((d.modo, d.video), ("direto", "nenhum"))

    def test_flac_toca_direto_embora_o_MSE_recuse(self):
        # ⚠ O par que mais deixa claro por que a pergunta certa importa: `audio/flac` é `probably`
        # em `canPlayType` e `false` em `MediaSource.isTypeSupported`. Perguntando ao MSE, o
        # servidor remuxaria todo acervo sem perdas por nada.
        s = sondar(ffprobe("flac", [audio("flac", indice=0)], duracao="300"), "faixa.flac")
        d = decidir(s, CHROME)
        self.assertEqual((d.modo, d.audio), ("direto", "copiar"))

    def test_o_que_realmente_precisa_de_remux_e_o_container_antigo(self):
        # `.avi` e `.mov` o navegador diz que não abre, e nós o tomamos ao pé da letra.
        for nome, formato in (("filme.avi", "avi"), ("camera.mov", "mov,mp4,m4a,3gp,3g2,mj2")):
            s = sondar(ffprobe(formato, [video("h264"), audio("aac")]), nome)
            self.assertEqual(decidir(s, CHROME).modo, "remux", nome)


class TestFaixasParaEscOLHER(unittest.TestCase):
    """O que faz um seletor de faixa ser utilizável em vez de uma lista de números."""

    def test_idioma_e_titulo_chegam(self):
        # Sem eles a lista diz "Faixa 1, Faixa 2", e ninguém escolhe entre original e dublagem por
        # número. Os dois vêm em `tags`, que é onde o ffprobe põe metadado de stream.
        s = sondar(ffprobe("matroska,webm", [
            video("h264"),
            audio("ac3", indice=1, canais=6, tags={"language": "eng", "title": "Original 5.1"}),
            audio("aac", indice=2, tags={"language": "por", "title": "Dublado"}),
        ]), "filme.mkv")
        self.assertEqual([(f.idioma, f.titulo) for f in s.audios],
                         [("eng", "Original 5.1"), ("por", "Dublado")])

    def test_faixa_sem_tags_nao_inventa_nome(self):
        s = sondar(ffprobe("matroska,webm", [video("h264"), audio("aac")]), "filme.mkv")
        self.assertEqual((s.audios[0].idioma, s.audios[0].titulo), (None, None))

    def test_as_legendas_embutidas_aparecem(self):
        s = sondar(ffprobe("matroska,webm", [
            video("h264"), audio("aac"),
            {"index": 2, "codec_type": "subtitle", "codec_name": "subrip",
             "tags": {"language": "por"}},
        ]), "filme.mkv")
        self.assertEqual([(f.indice, f.idioma) for f in s.legendas], [(2, "por")])

    def test_legenda_de_IMAGEM_e_marcada_como_tal(self):
        # ⚠ PGS (Blu-ray) e VobSub (DVD) são BITMAPS. Converter para VTT exigiria OCR, e o
        # `ffmpeg -f webvtt` sobre elas devolve nada — sem erro, sem aviso. Sem esta marca, a
        # interface ofereceria uma faixa que, escolhida, simplesmente não aparece na tela, e quem
        # usa conclui que o player não sabe mostrar legenda.
        s = sondar(ffprobe("matroska,webm", [
            video("h264"), audio("aac"),
            {"index": 2, "codec_type": "subtitle", "codec_name": "subrip"},
            {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
            {"index": 4, "codec_type": "subtitle", "codec_name": "ass"},
        ]), "filme.mkv")
        self.assertEqual([f.e_texto for f in s.legendas], [True, False, True])


class TestSondagem(unittest.TestCase):
    def test_o_format_name_do_ffprobe_e_uma_LISTA_e_nao_um_nome(self):
        # ⚠ `matroska,webm` é o mesmo demuxer para dois containers diferentes, e `.mkv` não é
        # `.webm`: o segundo o navegador abre e o primeiro não. O `format_name` sozinho não
        # distingue os dois — quem distingue é a extensão, e ignorar isso remuxaria todo `.webm`
        # à toa ou serviria todo `.mkv` quebrado.
        streams = [video("vp9"), audio("opus")]
        self.assertEqual(sondar(ffprobe("matroska,webm", streams), "clipe.webm").container, "webm")
        self.assertEqual(sondar(ffprobe("matroska,webm", streams), "filme.mkv").container, "matroska")
        self.assertEqual(
            sondar(ffprobe("mov,mp4,m4a,3gp,3g2,mj2", streams), "filme.mp4").container, "mp4")

    def test_e_o_webm_de_verdade_sai_direto(self):
        s = sondar(ffprobe("matroska,webm", [video("vp9"), audio("opus")]), "clipe.webm")
        self.assertEqual(decidir(s, CHROME).modo, "direto")

    def test_a_duracao_vem_do_ffprobe_porque_o_cano_nao_tem(self):
        # É ela que alimenta `opcoes.tempo` da TuffMidia. Sem ela a trilha fica sem tamanho no
        # exato modo (remux) em que o `<video>` não sabe responder.
        s = sondar(ffprobe("matroska,webm", [video("h264"), audio("aac")]), "filme.mkv")
        self.assertAlmostEqual(s.duracao, 3617.234, places=3)

    def test_um_ffprobe_torto_nao_derruba_o_player(self):
        # Arquivo corrompido, extensão mentindo, `ffprobe` sem streams. A resposta honesta é uma
        # sonda vazia e um modo que não promete nada — e não uma exceção subindo pelo handler.
        for bruto in ({}, {"format": {}}, {"streams": []}, {"streams": [{"codec_type": "data"}]}):
            s = sondar(bruto, "misterio.bin")
            self.assertIsNone(s.video)
            self.assertEqual(s.audios, [])
            self.assertEqual(decidir(s, CHROME).modo, "desconhecido", repr(bruto))


if __name__ == "__main__":
    unittest.main()
