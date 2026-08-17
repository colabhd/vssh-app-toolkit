"""O MPD que geramos, medido contra o que o YouTube devolve de verdade.

─── O que este arquivo existe para impedir ──────────────────────────────────

O plano da Fase 7 afirmava que "o yt-dlp já entrega, por formato, a URL e os `initRange`/
`indexRange`". **Medido, ele não entrega nenhum dos dois** — 0 de 44 formatos, em dois vídeos de
épocas diferentes. Se eu tivesse escrito o gerador em cima da afirmação, ele produziria um MPD com
`indexRange=""` em toda representação, que é um XML bem formado e um manifesto morto: o dash.js
pede o índice, recebe o arquivo inteiro, e a aba fica em "carregando" para sempre.

O que salva a fase é que os ranges **estão no arquivo** — cada formato é `ftypdash`, fMP4 com
`sidx`. Este portão prende as duas metades: que o parser acha os ranges nos bytes certos, e que o
gerador produz um manifesto que um player aceitaria.

⚠ Nada aqui fala com a rede. As fixturas em `test/dados/yt-*.json` são `extract_info` de verdade,
com as URLs recortadas — elas expiram em 6 horas e são presas ao IP de quem pediu, então guardar a
assinatura seria guardar uma credencial morta. O que a fixture preserva é a FORMA.
"""

import json
import os
import sys
import unittest
import xml.etree.ElementTree as ET

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "backend"))

from dash import (  # noqa: E402
    CABECALHO, Ranges, caixas, e_dash_em_mp4, escolher_formatos, montar_mpd, ranges_do_cabecalho,
)

NS = {"m": "urn:mpeg:dash:schema:mpd:2011"}


def fixture(nome):
    with open(os.path.join(AQUI, "dados", f"yt-{nome}.json"), encoding="utf-8") as f:
        return json.load(f)


def caixa(tipo, corpo=b""):
    """Monta uma caixa MP4 — é assim que os cabeçalhos deste arquivo nascem, sem baixar nada."""
    return (8 + len(corpo)).to_bytes(4, "big") + tipo.encode("ascii") + corpo


# O layout que o YouTube serve, reproduzido: ftyp(28) moov(713) sidx(1508) moof mdat
CABECA_REAL = (
    caixa("ftyp", b"dash" + b"\x00" * 16)
    + caixa("moov", b"\x00" * 705)
    + caixa("sidx", b"\x00" * 1500)
    + caixa("moof", b"\x00" * 100)
)


class TestAsCaixas(unittest.TestCase):
    def test_o_layout_do_youtube_e_lido_inteiro(self):
        vistas = [(t, a, b) for t, a, b in caixas(CABECA_REAL)]
        self.assertEqual([t for t, _, _ in vistas], ["ftyp", "moov", "sidx", "moof"])
        self.assertEqual(vistas[0], ("ftyp", 0, 28))
        self.assertEqual(vistas[1], ("moov", 28, 741))
        self.assertEqual(vistas[2], ("sidx", 741, 2249))

    def test_uma_caixa_truncada_termina_o_passeio_sem_lancar(self):
        # ⚠ É o caso NORMAL, não o excepcional: lemos 4 KB de um arquivo de 18 MB, então a última
        # caixa está sempre cortada. Se isto lançasse, nenhum formato entraria no MPD.
        # 500 bytes: o `moov` declara terminar em 741, muito além do que foi lido, e o `sidx` nem
        # tem cabeçalho ainda. O passeio devolve o que dá e para.
        vistas = list(caixas(CABECA_REAL[:500]))
        self.assertEqual([t for t, _, _ in vistas], ["ftyp", "moov"])
        self.assertEqual(vistas[-1][2], 741, "o fim declarado vale mesmo além do que foi lido")

    def test_um_webm_nao_vira_caixas_inventadas(self):
        # ⚠ O defeito que esta guarda impede é silencioso: o EBML começa com `1A 45 DF A3`, que
        # lido como tamanho de 32 bits dá 440 milhões. Sem a conferência do tipo, sairia daqui um
        # `sidx` imaginário, o MPD apontaria para bytes que não existem e o player mostraria tela
        # preta — sem erro no console, sem nada no log.
        webm = b"\x1aE\xdf\xa3" + b"\x01\x00\x00\x00" * 20
        self.assertEqual(list(caixas(webm)), [])
        self.assertIsNone(ranges_do_cabecalho(webm))

    def test_lixo_nao_vira_resposta(self):
        for ruim in (b"", b"<html>404 Not Found</html>", b"\x00" * 64, None, "texto"):
            self.assertIsNone(ranges_do_cabecalho(ruim), repr(ruim)[:40])

    def test_sem_ftyp_em_primeiro_nao_e_mp4(self):
        # Quatro bytes alfanuméricos por acaso não bastam: a primeira caixa TEM de ser `ftyp`.
        sem = caixa("moov", b"\x00" * 705) + caixa("sidx", b"\x00" * 100)
        self.assertIsNone(ranges_do_cabecalho(sem))

    def test_moov_sem_sidx_nao_serve(self):
        # Um MP4 progressivo tem `moov` e não tem `sidx` — não dá para indexar, e responder um
        # range qualquer seria pior que responder nada.
        prog = caixa("ftyp", b"isom" + b"\x00" * 16) + caixa("moov", b"\x00" * 705)
        self.assertIsNone(ranges_do_cabecalho(prog))

    def test_os_ranges_saem_com_o_ultimo_byte_INCLUSIVO(self):
        # ⚠ O `Range` de HTTP e o `indexRange` do DASH são os dois inclusivos nas duas pontas.
        # Um erro de um byte aqui não quebra escandalosamente: o player recebe o `sidx` faltando o
        # último byte e falha ao interpretá-lo, o que aparece como "o vídeo não carrega".
        r = ranges_do_cabecalho(CABECA_REAL)
        self.assertEqual((r.init, r.index), ("0-740", "741-2248"))

    def test_4_KB_bastam_para_alcancar_o_tamanho_do_sidx(self):
        # Não precisamos do `sidx` inteiro — só dos 8 bytes onde ele declara o próprio tamanho.
        # Quem interpreta a tabela é o dash.js, com o range que devolvemos.
        self.assertGreaterEqual(CABECALHO, 2249, "4 KB tem de cobrir ftyp+moov+o cabeçalho do sidx")
        r = ranges_do_cabecalho(CABECA_REAL[:CABECALHO])
        self.assertEqual(r.index, "741-2248")


class TestQuemEntraNoMPD(unittest.TestCase):
    def setUp(self):
        self.info = fixture("bbb-4k")
        self.formatos = self.info["formats"]

    def test_o_piso_a_fixture_e_o_que_o_youtube_devolve(self):
        # ⚠ Sem este piso, uma fixture vazia faria todo teste abaixo medir conjunto vazio e passar.
        self.assertGreaterEqual(len(self.formatos), 30)
        self.assertTrue(any(f.get("height") == 2160 for f in self.formatos))
        self.assertTrue(any(str(f.get("acodec", "")).startswith("mp4a") for f in self.formatos))

    def test_o_yt_dlp_NAO_entrega_os_ranges_e_e_por_isso_que_este_modulo_existe(self):
        # A premissa do plano, medida. Se um dia o yt-dlp voltar a entregá-los, este teste falha —
        # e a falha é uma boa notícia: dá para apagar as leituras de 4 KB.
        com = [f for f in self.formatos if f.get("initRange") or f.get("indexRange")]
        self.assertEqual(com, [], "o yt-dlp passou a entregar os ranges; o parser virou dispensável")

    def test_o_progressivo_fica_de_fora(self):
        # Ele tem vídeo e áudio no mesmo arquivo: serve de recuo, não de trilha de MSE adaptativo.
        prog = [f for f in self.formatos
                if f.get("vcodec") != "none" and f.get("acodec") != "none"]
        self.assertTrue(prog, "a fixture perdeu o formato progressivo")
        for f in prog:
            self.assertEqual(escolher_formatos([f], {f["format_id"]: Ranges("0-1", "2-3")}), [])

    def test_o_ramo_que_barra_video_e_audio_JUNTOS_e_medido_sozinho(self):
        # ⚠ Este teste existe porque a refutação achou o buraco: o de cima passava pela defesa
        # ERRADA. O progressivo do YouTube vem com `container: None`, então `e_dash_em_mp4` já o
        # recusa e o ramo que olha "tem vídeo E áudio" nunca era exercitado — quebrá-lo deixava a
        # suíte inteira verde.
        #
        # São duas defesas de propósito, e cada uma tem de valer sozinha: o container pode passar a
        # vir preenchido num formato misto sem ninguém avisar.
        misto = {"format_id": "22", "ext": "mp4", "container": "mp4_dash",
                 "vcodec": "avc1.64001F", "acodec": "mp4a.40.2", "tbr": 1000,
                 "url": "https://exemplo/videoplayback", "width": 1280, "height": 720}
        self.assertTrue(e_dash_em_mp4(misto), "a primeira defesa não é quem deveria barrar aqui")
        self.assertEqual(escolher_formatos([misto], {"22": Ranges("0-740", "741-2248")}), [])

    def test_o_webm_fica_de_fora_e_o_mp4_ainda_cobre_144p_a_2160p(self):
        # A decisão de escopo, medida: se um dia o YouTube parar de servir MP4 nas alturas altas,
        # este teste denuncia antes de alguém reclamar que só há 480p.
        webm = [f for f in self.formatos if f.get("ext") == "webm"]
        self.assertTrue(webm, "a fixture perdeu os formatos WebM")
        self.assertFalse(any(e_dash_em_mp4(f) for f in webm))

        mp4 = [f for f in self.formatos if e_dash_em_mp4(f)]
        alturas = sorted({f["height"] for f in mp4 if f.get("height")})
        self.assertEqual(alturas, [144, 240, 360, 480, 720, 1080, 1440, 2160])
        self.assertTrue(any(f.get("acodec", "").startswith("mp4a") for f in mp4))

    def test_formato_sem_ranges_e_descartado_em_silencio(self):
        # Uma trilha a menos degrada a qualidade disponível; uma trilha mentindo quebra tudo.
        mp4 = [f for f in self.formatos if e_dash_em_mp4(f)]
        so_um = {mp4[0]["format_id"]: Ranges("0-740", "741-2248")}
        trilhas = escolher_formatos(mp4, so_um)
        self.assertEqual([t.id for t in trilhas], [mp4[0]["format_id"]])


class TestOAgrupamento(unittest.TestCase):
    """⚠ Um `AdaptationSet` promete representações intercambiáveis SEM recriar o `SourceBuffer`."""

    def trilhas(self, nome="bbb-4k"):
        fmts = [f for f in fixture(nome)["formats"] if e_dash_em_mp4(f)]
        rs = {f["format_id"]: Ranges("0-740", "741-2248") for f in fmts}
        return escolher_formatos(fmts, rs)

    def test_avc1_e_av01_NAO_dividem_conjunto(self):
        # É a promessa do AdaptationSet: se ela for quebrada, o ABR sobe de qualidade e a
        # reprodução para — porque trocar de codec exige um `SourceBuffer` novo.
        raiz = ET.fromstring(montar_mpd(635, self.trilhas(), "/api/yt/bytes?f="))
        for conj in raiz.findall(".//m:AdaptationSet", NS):
            codecs = {r.get("codecs")[:4] for r in conj.findall("m:Representation", NS)}
            self.assertEqual(len(codecs), 1, f"conjunto com codecs misturados: {codecs}")

    def test_he_aac_e_aac_lc_ficam_separados(self):
        # `mp4a.40.5` e `mp4a.40.2` diferem na taxa de amostragem do decodificador, e o YouTube os
        # oferece lado a lado. Juntá-los é o mesmo defeito, mais difícil de ver.
        raiz = ET.fromstring(montar_mpd(635, self.trilhas(), "/api/yt/bytes?f="))
        audio = [c for c in raiz.findall(".//m:AdaptationSet", NS)
                 if c.get("contentType") == "audio"]
        self.assertGreaterEqual(len(audio), 2, "os dois perfis de AAC caíram no mesmo conjunto")
        for conj in audio:
            codecs = {r.get("codecs") for r in conj.findall("m:Representation", NS)}
            self.assertEqual(len(codecs), 1)

    def test_o_video_vem_antes_do_audio(self):
        raiz = ET.fromstring(montar_mpd(635, self.trilhas(), "/api/yt/bytes?f="))
        tipos = [c.get("contentType") for c in raiz.findall(".//m:AdaptationSet", NS)]
        self.assertEqual(tipos, sorted(tipos, key=lambda t: t != "video"))

    def test_dentro_do_conjunto_a_ordem_e_da_menor_banda_para_a_maior(self):
        raiz = ET.fromstring(montar_mpd(635, self.trilhas(), "/api/yt/bytes?f="))
        for conj in raiz.findall(".//m:AdaptationSet", NS):
            bandas = [int(r.get("bandwidth")) for r in conj.findall("m:Representation", NS)]
            self.assertEqual(bandas, sorted(bandas))


class TestOManifesto(unittest.TestCase):
    def setUp(self):
        fmts = [f for f in fixture("bbb-4k")["formats"] if e_dash_em_mp4(f)]
        self.rs = {f["format_id"]: Ranges(f"0-{700 + i}", f"{701 + i}-{2200 + i}")
                   for i, f in enumerate(fmts)}
        self.trilhas = escolher_formatos(fmts, self.rs)
        self.xml = montar_mpd(635.048, self.trilhas, "/api/yt/bytes?v=aqz&f=")
        self.raiz = ET.fromstring(self.xml)

    def test_o_piso_o_manifesto_tem_o_que_medir(self):
        self.assertGreaterEqual(len(self.trilhas), 15)
        self.assertGreaterEqual(len(self.raiz.findall(".//m:Representation", NS)), 15)

    def test_o_perfil_declarado_e_o_de_video_gravado(self):
        # ⚠ `isoff-live` faria o dash.js procurar um `SegmentTemplate` que não existe aqui.
        self.assertIn("isoff-on-demand", self.raiz.get("profiles"))
        self.assertEqual(self.raiz.get("type"), "static")

    def test_a_duracao_sai_em_ISO_8601(self):
        # Um `mediaPresentationDuration="635.048"` é recusado pelo esquema — tem de ser `PT…S`.
        self.assertEqual(self.raiz.get("mediaPresentationDuration"), "PT635.048S")

    def test_toda_representacao_tem_SegmentBase_com_os_DOIS_ranges(self):
        # É a linha que o defeito original produziria vazia. Um MPD sem `indexRange` é XML bem
        # formado e manifesto morto.
        reps = self.raiz.findall(".//m:Representation", NS)
        for r in reps:
            seg = r.find("m:SegmentBase", NS)
            self.assertIsNotNone(seg, f"representação {r.get('id')} sem SegmentBase")
            self.assertRegex(seg.get("indexRange") or "", r"^\d+-\d+$")
            ini = seg.find("m:Initialization", NS)
            self.assertIsNotNone(ini)
            self.assertRegex(ini.get("range") or "", r"^\d+-\d+$")

    def test_os_ranges_sao_os_DAQUELE_formato_e_nao_os_do_primeiro(self):
        # ⚠ Um laço que reusasse os ranges da primeira trilha produziria um MPD que passa em toda
        # conferência estrutural e serve o índice errado em quinze representações de dezesseis.
        for r in self.raiz.findall(".//m:Representation", NS):
            esperado = self.rs[r.get("id")]
            self.assertEqual(r.find("m:SegmentBase", NS).get("indexRange"), esperado.index)
            self.assertEqual(
                r.find("m:SegmentBase/m:Initialization", NS).get("range"), esperado.init)

    def test_o_BaseURL_aponta_para_NOS_e_carrega_o_itag(self):
        # As duas razões estão no cabeçalho do módulo: a URL do googlevideo é presa ao IP de quem
        # pediu e não tem CORS (o preflight responde 400). Apontar para lá é um manifesto que
        # nunca carrega um byte.
        for r in self.raiz.findall(".//m:Representation", NS):
            url = r.find("m:BaseURL", NS).text
            self.assertTrue(url.startswith("/api/yt/bytes?v=aqz&f="), url)
            self.assertTrue(url.endswith(r.get("id")), url)
            self.assertNotIn("googlevideo", url)

    def test_o_video_declara_tamanho_e_o_audio_declara_amostragem(self):
        for r in self.raiz.findall(".//m:AdaptationSet[@contentType='video']/m:Representation", NS):
            self.assertTrue(r.get("width") and r.get("height"), r.get("id"))
        for c in self.raiz.findall(".//m:AdaptationSet[@contentType='audio']", NS):
            self.assertIsNotNone(c.find("m:AudioChannelConfiguration", NS))

    def test_um_video_de_2005_com_11_formatos_tambem_gera_manifesto(self):
        # O caso pequeno: 240p no máximo, dois áudios. Se o gerador exigisse alturas altas ou dois
        # codecs de vídeo, ele quebraria justamente no acervo antigo.
        fmts = [f for f in fixture("zoo-2005")["formats"] if e_dash_em_mp4(f)]
        rs = {f["format_id"]: Ranges("0-740", "741-808") for f in fmts}
        raiz = ET.fromstring(montar_mpd(19, escolher_formatos(fmts, rs), "/api/yt/bytes?f="))
        self.assertGreaterEqual(len(raiz.findall(".//m:Representation", NS)), 4)
        self.assertEqual(raiz.get("mediaPresentationDuration"), "PT19.000S")

    def test_sem_duracao_o_manifesto_ainda_sai(self):
        # Uma transmissão ao vivo, ou metadados incompletos. Melhor um MPD sem duração declarada
        # que uma exceção subindo pelo handler.
        raiz = ET.fromstring(montar_mpd(None, self.trilhas, "/f="))
        self.assertIsNone(raiz.get("mediaPresentationDuration"))
        self.assertGreaterEqual(len(raiz.findall(".//m:Representation", NS)), 15)

    def test_o_XML_e_declarado_e_bem_formado(self):
        self.assertTrue(self.xml.startswith('<?xml version="1.0" encoding="utf-8"?>'))
        self.assertIn("urn:mpeg:dash:schema:mpd:2011", self.xml)


if __name__ == "__main__":
    unittest.main()
