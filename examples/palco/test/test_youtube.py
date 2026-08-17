"""O resolvedor, com o YouTube inteiro substituído por dois duplos.

⚠ **Nada aqui fala com a rede, e é a restrição que o plano escreveu antes do código:** "o resolvedor
recebe o extractor por injeção; os testes alimentam JSON gravado. Sem isso a suíte fica vermelha
quando o Google muda alguma coisa, que é o oposto de um sinal."

Os duplos são contadores, e é de propósito — quase todo teste aqui mede **quantas vezes** o mundo
foi chamado. O que este módulo faz de valioso não é resolver (isso o yt-dlp faz); é **não** resolver
de novo quando não precisa, e resolver de novo exatamente quando precisa. As duas metades falham em
silêncio: chamar demais só aparece na conta de latência, e chamar de menos só aparece quando o vídeo
para no meio para quem está assistindo.
"""

import json
import os
import sys
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "backend"))

from dash import Ranges  # noqa: E402
from youtube import Resolvedor, expira_em, legendas_de, metadados  # noqa: E402


def fixture(nome="bbb-4k"):
    with open(os.path.join(AQUI, "dados", f"yt-{nome}.json"), encoding="utf-8") as f:
        return json.load(f)


# Um fMP4 mínimo: ftyp(28) moov(741) sidx(2249). O mesmo layout que o YouTube serve.
def cabeca(desloca=0):
    def caixa(tipo, corpo):
        return (8 + len(corpo)).to_bytes(4, "big") + tipo.encode("ascii") + corpo
    return (caixa("ftyp", b"dash" + b"\x00" * 16)
            + caixa("moov", b"\x00" * (705 + desloca))
            + caixa("sidx", b"\x00" * 1500))


class Mundo:
    """Os dois duplos, contando tudo o que o resolvedor pediu."""

    def __init__(self, info=None, expire=None, falhar_em=(), agora=1_000_000.0):
        self.base = info or fixture()
        self.expire = expire
        self.falhar_em = set(falhar_em)
        self.t = agora
        self.extraidas = []
        self.lidas = []

    def extrair(self, url):
        self.extraidas.append(url)
        info = json.loads(json.dumps(self.base))          # cópia, para não vazar entre chamadas
        # ⚠ A URL muda a cada resolução, como no YouTube de verdade — foi medido. Se ela não
        # mudasse aqui, o teste do proxy passaria sem provar que a nova é entregue.
        exp = self.expire if self.expire is not None else self.t + 6 * 3600
        n = len(self.extraidas)
        for f in info.get("formats") or []:
            if f.get("url"):
                f["url"] = (f"https://rr{n}---sn-teste.googlevideo.com/videoplayback"
                            f"?itag={f['format_id']}&expire={int(exp)}&sig=CHAMADA{n}")
                f["http_headers"] = {"User-Agent": f"duble/{n}"}
        return info

    def ler(self, url, headers, n):
        self.lidas.append(url)
        itag = url.split("itag=")[1].split("&")[0]
        if itag in self.falhar_em:
            raise OSError(f"o servidor recusou o itag {itag}")
        return cabeca()[:n]

    def resolvedor(self, **kw):
        return Resolvedor(self.extrair, self.ler, agora=lambda: self.t, **kw)


class TestOQueAUrlDizSobreSiMesma(unittest.TestCase):
    def test_o_expire_da_url_e_a_validade(self):
        # ⚠ Melhor que qualquer TTL nosso: um TTL fixo ou expira cedo (e re-resolve à toa) ou
        # tarde (e serve uma credencial morta no meio do filme). O YouTube já diz até quando.
        u = "https://rr3---sn.googlevideo.com/videoplayback?expire=1787022652&itag=134"
        self.assertEqual(expira_em(u), 1787022652.0)

    def test_url_sem_expire_ou_torta_nao_lanca(self):
        for u in (None, "", "https://exemplo/", "https://x/?expire=amanha", 42):
            self.assertIsNone(expira_em(u), repr(u))


class TestOsMetadados(unittest.TestCase):
    def setUp(self):
        self.info = fixture()

    def test_o_piso_a_fixture_tem_o_que_extrair(self):
        self.assertTrue(self.info.get("title"))
        self.assertTrue(self.info.get("thumbnails"))

    def test_so_o_que_a_tela_precisa(self):
        m = metadados(self.info)
        self.assertEqual(m["id"], self.info["id"])
        self.assertTrue(m["titulo"])
        self.assertTrue(m["canal"])
        self.assertIsNotNone(m["duracao"])
        # ⚠ O `extract_info` de um vídeo popular passa de 100 KB só em legendas automáticas.
        # Mandá-lo inteiro custaria esse peso em toda abertura para mostrar título e canal.
        self.assertLess(len(json.dumps(m)), 2000)

    def test_a_miniatura_e_a_MAIOR(self):
        # O yt-dlp ordena da pior para a melhor. Pegar a primeira daria 120x90 num cartaz.
        self.assertEqual(metadados(self.info)["miniatura"], self.info["thumbnails"][-1]["url"])

    def test_gravacao_de_transmissao_NAO_e_ao_vivo(self):
        # ⚠ `was_live` é "foi uma transmissão"; `is_live` é "está no ar agora". Confundi-los
        # esconderia a linha do tempo de uma gravação que tem duração e busca normalíssimas.
        self.assertFalse(metadados({"was_live": True, "is_live": False})["aoVivo"])
        self.assertTrue(metadados({"is_live": True})["aoVivo"])

    def test_info_vazia_nao_lanca(self):
        for ruim in (None, {}, {"formats": []}):
            self.assertEqual(metadados(ruim)["id"], "")


class TestAsLegendas(unittest.TestCase):
    def test_manual_antes_de_automatica(self):
        # Legenda automática de fala espontânea erra nomes próprios e pontuação. Misturadas, a
        # pessoa escolheria no escuro entre "Português" e "Português".
        info = {
            "subtitles": {"pt": [{"ext": "vtt", "name": "Português"}]},
            "automatic_captions": {"en": [{"ext": "vtt", "name": "English (auto)"}]},
        }
        ls = legendas_de(info)
        self.assertEqual([x["automatica"] for x in ls], [False, True])
        self.assertEqual(ls[0]["idioma"], "pt")

    def test_formato_que_nao_e_texto_temporizado_fica_de_fora(self):
        # `json3`/`srv1` exigiriam conversão para chegar ao mesmo VTT que o yt-dlp entrega direto.
        info = {"subtitles": {"pt": [{"ext": "json3"}, {"ext": "srv1"}]}}
        self.assertEqual(legendas_de(info), [])

    def test_sem_legendas_devolve_lista_vazia_e_nao_None(self):
        self.assertEqual(legendas_de({}), [])
        self.assertEqual(legendas_de(None), [])


class TestResolverUmVideo(unittest.TestCase):
    def setUp(self):
        self.mundo = Mundo()
        self.r = self.mundo.resolvedor()

    def test_o_piso_resolve_e_produz_trilhas(self):
        v = self.r.video("aqz-KE-bpKQ")
        self.assertGreaterEqual(len(v.trilhas), 15)
        self.assertTrue(v.titulo)
        self.assertGreaterEqual(len(v.urls), 15)
        # Uma leitura de cabeçalho por formato, na primeira vez.
        self.assertEqual(len(self.mundo.lidas), len(v.urls))

    def test_o_vencedor_do_prazo_e_o_MENOR_de_todos(self):
        # ⚠ As URLs vêm de hosts diferentes (`rr3---sn-…`, `rr5---sn-…`) e nada garante que expirem
        # juntas. Usar a da primeira faria o áudio morrer enquanto o vídeo segue — imagem sem som,
        # no meio, e nada falha do nosso lado.
        from dash import e_dash_em_mp4
        mundo = Mundo()
        real = mundo.extrair

        def com_um_curto(url):
            info = real(url)
            # ⚠ Duas armadilhas aqui, as duas achadas medindo, e as duas fazem o teste medir nada.
            #
            # 1. Tem de ser um formato que ENTRA no MPD. A primeira versão encurtava `formats[3]`,
            #    que na fixture é WebM — descartado antes do `min`, então o prazo curto nunca era
            #    visto.
            # 2. E não pode ser o PRIMEIRO da lista, senão `prazos[0]` coincide com o mínimo e a
            #    diferença entre "o menor de todos" e "o primeiro que apareceu" some. A refutação
            #    pegou exatamente isso: trocar `min(prazos)` por `prazos[0]` passava verde.
            elegiveis = [f for f in info["formats"] if e_dash_em_mp4(f)]
            alvo = elegiveis[len(elegiveis) // 2]
            alvo["url"] = alvo["url"].replace(
                f"expire={int(mundo.t + 6 * 3600)}", f"expire={int(mundo.t + 60)}")
            return info

        r = Resolvedor(com_um_curto, mundo.ler, agora=lambda: mundo.t)
        self.assertEqual(r.video("v").expira, mundo.t + 60)

    def test_um_formato_que_falha_ao_ler_nao_derruba_o_video(self):
        # Uma trilha a menos degrada a qualidade disponível; uma exceção subindo daqui tiraria o
        # vídeo do ar por causa de uma altura que talvez ninguém usasse.
        mundo = Mundo(falhar_em={"160", "140"})
        v = mundo.resolvedor().video("v")
        self.assertGreaterEqual(len(v.trilhas), 10)
        self.assertNotIn("160", [t.id for t in v.trilhas])
        self.assertNotIn("140", [t.id for t in v.trilhas])


class TestOsDoisCaches(unittest.TestCase):
    """⚠ A medida central deste arquivo: o que é pedido de novo, e o que não é."""

    def setUp(self):
        self.mundo = Mundo()
        self.r = self.mundo.resolvedor()

    def test_reabrir_dentro_da_validade_nao_pede_nada(self):
        self.r.video("v")
        n_ext, n_ler = len(self.mundo.extraidas), len(self.mundo.lidas)
        for _ in range(5):
            self.r.video("v")
        self.assertEqual(len(self.mundo.extraidas), n_ext, "resolveu de novo à toa")
        self.assertEqual(len(self.mundo.lidas), n_ler)

    def test_depois_do_expire_ele_resolve_de_novo_MAS_nao_rele_os_cabecalhos(self):
        # ⚠ O achado que dá nome aos dois caches, e ele foi medido contra o YouTube de verdade:
        # resolvendo duas vezes, as URLs mudam e os ranges são idênticos. Os ranges são propriedade
        # do ARQUIVO, que é imutável; a URL é uma credencial de 6 h.
        #
        # Sem esta separação, cada expiração custaria 18 leituras de 4 KB de novo — e a segunda
        # pessoa a assistir o mesmo vídeo pagaria a conta inteira outra vez.
        v1 = self.r.video("v")
        lidas_antes = len(self.mundo.lidas)

        self.mundo.t += 6 * 3600          # a credencial venceu
        v2 = self.r.video("v")

        self.assertEqual(len(self.mundo.extraidas), 2, "não re-resolveu depois do expire")
        self.assertEqual(len(self.mundo.lidas), lidas_antes,
                         "releu os cabeçalhos — os ranges não mudam, são do arquivo")
        self.assertNotEqual(v1.urls["134"], v2.urls["134"], "a URL nova não chegou")
        self.assertEqual([(t.id, t.ranges.index) for t in v1.trilhas],
                         [(t.id, t.ranges.index) for t in v2.trilhas])

    def test_a_margem_evita_servir_uma_url_que_vence_em_trinta_segundos(self):
        # Uma URL válida por mais 30 s vence no meio do próximo fragmento, e o sintoma é o vídeo
        # parando sem erro — do nosso lado nada falhou.
        mundo = Mundo(expire=1_000_000.0 + 120)
        r = mundo.resolvedor()
        r.video("v")
        mundo.t += 1                      # ainda faltam 119 s: dentro da margem de 300
        r.video("v")
        self.assertEqual(len(mundo.extraidas), 2, "serviu uma credencial que está por vencer")

    def test_videos_diferentes_nao_compartilham_ranges(self):
        # A chave do cache é `(vid, itag)`. Se fosse só o itag, o segundo vídeo herdaria o `sidx`
        # do primeiro — mesmo tamanho de MPD, ranges de outro arquivo, e o dash.js compensando
        # com uma viagem a mais em cada trilha.
        self.r.video("a")
        lidas = len(self.mundo.lidas)
        self.r.video("b")
        self.assertGreater(len(self.mundo.lidas), lidas, "reusou os ranges de OUTRO vídeo")

    def test_forcar_ignora_o_cache(self):
        self.r.video("v")
        n = len(self.mundo.extraidas)
        self.r.video("v", forcar=True)
        self.assertEqual(len(self.mundo.extraidas), n + 1)


class TestAUrlQueOProxyPede(unittest.TestCase):
    def setUp(self):
        self.mundo = Mundo()
        self.r = self.mundo.resolvedor()

    def test_devolve_url_e_cabecalhos_do_itag(self):
        url, cab = self.r.url_de("v", "134")
        self.assertIn("itag=134", url)
        self.assertTrue(cab.get("User-Agent"))

    def test_itag_desconhecido_devolve_None_e_nao_lanca(self):
        # Chega de um MPD velho numa aba que ficou aberta, ou de alguém montando a URL à mão.
        url, cab = self.r.url_de("v", "999")
        self.assertIsNone(url)

    def test_numa_reproducao_longa_ele_renova_a_credencial_sozinho(self):
        # ⚠ É o caso que só aparece em filme de duas horas: a URL vence no meio. Sem esta
        # renovação o vídeo pararia sozinho — e do nosso lado nada teria falhado, o que é o pior
        # formato de defeito que existe.
        u1, _ = self.r.url_de("v", "134")
        self.mundo.t += 6 * 3600
        u2, _ = self.r.url_de("v", "134")
        self.assertNotEqual(u1, u2, "serviu a URL vencida")
        self.assertEqual(len(self.mundo.extraidas), 2)


class TestOMPDDoFimAoFim(unittest.TestCase):
    def test_do_extract_info_ao_manifesto_sem_tocar_na_rede(self):
        import xml.etree.ElementTree as ET

        from dash import montar_mpd
        mundo = Mundo()
        v = mundo.resolvedor().video("aqz-KE-bpKQ")
        raiz = ET.fromstring(montar_mpd(v.duracao, v.trilhas, "/api/yt/bytes?v=aqz&f="))
        ns = {"m": "urn:mpeg:dash:schema:mpd:2011"}
        reps = raiz.findall(".//m:Representation", ns)
        self.assertGreaterEqual(len(reps), 15)
        for rep in reps:
            seg = rep.find("m:SegmentBase", ns)
            self.assertEqual(seg.get("indexRange"), "741-2248")
            self.assertEqual(rep.find("m:BaseURL", ns).text.split("f=")[-1], rep.get("id"))
        # E nenhuma URL do googlevideo vazou para o manifesto — o proxy é obrigatório porque a
        # credencial é presa ao IP do servidor e o host não responde CORS.
        self.assertNotIn("googlevideo", ET.tostring(raiz, encoding="unicode"))


if __name__ == "__main__":
    unittest.main()
