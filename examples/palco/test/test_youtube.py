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
import re
import sys
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "backend"))

from dash import Ranges  # noqa: E402
from urls import analisar  # noqa: E402
from youtube import (  # noqa: E402
    CABECALHOS_REPASSADOS, Resolvedor, classificar_falha, expira_em, id_valido, itag_valido,
    legendas_de, metadados,
    resposta_de_abertura,
)


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
    # ⚠ A ORDEM dos formatos aqui é a que o YouTube devolve de verdade — medida em dois vídeos com
    # legenda, idioma por idioma, e idêntica nos dois. Ela é o teste inteiro: um duble que
    # colocasse o `vtt` primeiro aprovaria a escolha errada e não haveria como saber.
    COMO_O_YOUTUBE_MANDA = ["json3", "srv1", "srv2", "srv3", "ttml", "srt", "vtt"]

    def _faixas(self, nome=None):
        return [{"ext": e, "name": nome, "url": f"https://x/{e}"}
                for e in self.COMO_O_YOUTUBE_MANDA]

    def test_manual_antes_de_automatica(self):
        # Legenda automática de fala espontânea erra nomes próprios e pontuação. Misturadas, a
        # pessoa escolheria no escuro entre "Português" e "Português".
        info = {
            "subtitles": {"pt": self._faixas("Português")},
            "automatic_captions": {"en": self._faixas("English (auto)")},
        }
        ls = legendas_de(info, auto_em={"en"})
        self.assertEqual([x["automatica"] for x in ls], [False, True])
        self.assertEqual(ls[0]["idioma"], "pt")

    def test_o_formato_escolhido_e_VTT_e_nao_o_PRIMEIRO_que_serve(self):
        # ⚠ Este é o defeito que a medição achou, e ele não deixa erro em lugar nenhum: com
        # `ext in ("vtt", "srt")` a escolha cai no SRT, que vem antes na lista. A rota o serve como
        # `text/vtt`, o navegador não parseia nada, e a legenda liga no menu sem escrever uma
        # palavra na tela.
        ls = legendas_de({"subtitles": {"pt": self._faixas()}})
        self.assertEqual([x["ext"] for x in ls], ["vtt"])
        self.assertEqual(ls[0]["url"], "https://x/vtt")

    def test_so_SRT_disponivel_e_melhor_NAO_oferecer(self):
        # Uma legenda que aparece e não escreve nada é pior que uma que não aparece: a segunda
        # manda a pessoa procurar outra saída, a primeira a convence de que o player é quebrado.
        self.assertEqual(legendas_de({"subtitles": {"pt": [{"ext": "srt"}]}}), [])

    def test_formato_que_nao_e_texto_temporizado_fica_de_fora(self):
        # `json3`/`srv1` exigiriam conversão para chegar ao mesmo VTT que o yt-dlp entrega direto.
        info = {"subtitles": {"pt": [{"ext": "json3"}, {"ext": "srv1"}]}}
        self.assertEqual(legendas_de(info), [])

    # ── o recorte das automáticas ────────────────────────────────────────────

    def test_as_automaticas_sao_CENTO_E_CINQUENTA_E_SETE_sem_recorte(self):
        # ⚠ O número é medido, e é ele que transforma "filtro opcional" em requisito: 157 entradas
        # no menu Legenda e 157 elementos `<track>` no `<video>`, com a única que interessa perdida
        # no meio. As manuais passam todas — quem escreveu legenda de propósito escreveu poucas.
        muitas = {f"l{i}": [{"ext": "vtt"}] for i in range(157)}
        self.assertEqual(len(legendas_de({"automatic_captions": muitas}, auto_em={"pt"})), 0)
        self.assertEqual(len(legendas_de({"subtitles": muitas})), 157)

    def test_a_automatica_do_idioma_de_quem_assiste_PASSA(self):
        info = {"automatic_captions": {"pt": [{"ext": "vtt"}], "de": [{"ext": "vtt"}]}}
        self.assertEqual([x["idioma"] for x in legendas_de(info, auto_em={"pt"})], ["pt"])

    def test_pt_casa_com_ptBR_e_nao_com_pl(self):
        # ⚠ O YouTube mistura as duas grafias entre os idiomas de `automatic_captions`, e uma
        # comparação exata deixaria de fora exatamente a legenda que a pessoa pediu.
        info = {"automatic_captions": {"pt-BR": [{"ext": "vtt"}], "pl": [{"ext": "vtt"}]}}
        self.assertEqual([x["idioma"] for x in legendas_de(info, auto_em={"pt"})], ["pt-BR"])

    def test_sem_idioma_nenhum_declarado_NAO_oferece_automatica(self):
        # Sem saber o idioma de quem assiste, oferecer "alguma" seria sortear entre 157.
        info = {"automatic_captions": {"pt": [{"ext": "vtt"}]}}
        for vazio in (None, set(), {""}):
            self.assertEqual(legendas_de(info, auto_em=vazio), [])

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


class TestOQueAsRotasDECIDEM(unittest.TestCase):
    """O miolo das rotas `/api/yt/*`, sem nada de HTTP em volta.

    ⚠ Ele mora aqui e não em `main.py` por uma razão prática: `main.py` **não importa no Windows** —
    o `criar_servidor` do toolkit usa `socketserver.UnixStreamServer`, que não existe lá. Deixar a
    decisão dentro do handler a tornaria inatingível para a suíte que roda na máquina de quem
    escreve, que é onde ela precisa falhar.
    """

    def test_endereco_que_nao_e_do_youtube_devolve_nao_e_nosso(self):
        # ⚠ **Não é erro.** É "devolva este link", e quem chama devolve com
        # `vssh.openUrl(url, {destino:'navegador'})`. Sem esta saída, o deeplink põe uma tela de
        # erro na frente de alguém que só clicou num link — pior do que não existir.
        r = resposta_de_abertura(analisar("https://exemplo.org/video.mp4"))
        self.assertEqual(r["tipo"], "nao-e-nosso")

    def test_playlist_canal_e_busca_ainda_voltam_para_o_navegador(self):
        # O `urls.py` sabe analisar os três; a interface ainda não sabe mostrá-los. Enquanto não
        # souber, devolver é o único caminho honesto — e o `porque` diz o que faltou, o que torna
        # esta lista a régua de quando o roteamento pode ser LIGADO.
        for url, esperado in (
            ("https://www.youtube.com/playlist?list=PLabc123", "playlist"),
            ("https://www.youtube.com/@fulano", "canal"),
            ("https://www.youtube.com/results?search_query=gatos", "busca"),
            ("https://www.youtube.com/", "inicio"),
        ):
            alvo = analisar(url)
            self.assertIsNotNone(alvo, url)
            r = resposta_de_abertura(alvo)
            self.assertEqual(r["tipo"], "nao-e-nosso", url)
            self.assertEqual(r["porque"], esperado, url)

    def test_um_video_sem_resolucao_ainda_devolve_id_e_tempo(self):
        r = resposta_de_abertura(analisar("https://youtu.be/dQw4w9WgXcQ?t=90"))
        self.assertEqual((r["tipo"], r["id"], r["t"]), ("video", "dQw4w9WgXcQ", 90))

    def test_a_resposta_completa_carrega_o_mpd_e_as_qualidades(self):
        mundo = Mundo()
        v = mundo.resolvedor().video("aqz-KE-bpKQ")
        r = resposta_de_abertura(analisar("https://youtu.be/aqz-KE-bpKQ?t=30"), v)
        self.assertEqual(r["tipo"], "video", r)
        self.assertEqual(r["mpd"], "api/yt/mpd?v=aqz-KE-bpKQ")
        self.assertEqual(r["t"], 30)
        self.assertEqual(r["qualidades"], [144, 240, 360, 480, 720, 1080, 1440, 2160])
        self.assertTrue(r["titulo"])

    def test_a_URL_ASSINADA_da_legenda_NAO_vai_para_a_tela(self):
        # ⚠ Duas razões, e a segunda basta: ela vence junto com as outras credenciais, e a página
        # não conseguiria buscá-la de qualquer forma — `<track>` é sujeito à mesma origem e o host
        # das legendas não responde CORS. Publicá-la seria vazar uma credencial para nada.
        mundo = Mundo()
        v = mundo.resolvedor().video("v")
        v.legendas = [{"idioma": "pt", "nome": "Português", "automatica": False,
                       "url": "https://youtube.com/api/timedtext?sig=SEGREDO", "ext": "vtt"}]
        r = resposta_de_abertura(analisar("https://youtu.be/dQw4w9WgXcQ"), v)
        self.assertNotIn("SEGREDO", json.dumps(r))
        self.assertEqual(set(r["legendas"][0]), {"idioma", "nome", "automatica"})

    def test_os_ids_e_itags_sao_conferidos(self):
        # Chegam pela query. Sem conferência, `v=../../etc` viraria uma chave de cache e um pedido
        # ao yt-dlp com lixo dentro.
        for bom in ("dQw4w9WgXcQ", "aqz-KE-bpKQ"):
            self.assertTrue(id_valido(bom), bom)
        for ruim in ("", None, "curto", "tem/barra11", "a" * 12, "../../etc"):
            self.assertFalse(id_valido(ruim), repr(ruim))
        for bom in ("18", "134", "251"):
            self.assertTrue(itag_valido(bom), bom)
        for ruim in ("", None, "abc", "-1", "99999"):
            self.assertFalse(itag_valido(ruim), repr(ruim))

    def test_o_proxy_repassa_uma_lista_BRANCA_de_cabecalhos(self):
        # ⚠ Repassar a resposta do googlevideo inteira levaria `Set-Cookie` e identificadores de
        # borda do Google para dentro da sessão de quem assiste, na ORIGEM DO AMBIENTE. Nada disso
        # é preciso para tocar.
        self.assertEqual(set(CABECALHOS_REPASSADOS),
                         {"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"})
        for proibido in ("Set-Cookie", "Alt-Svc", "Server", "X-Walltime-Ms", "Report-To"):
            self.assertNotIn(proibido, CABECALHOS_REPASSADOS)
        # E `Content-Range` TEM de estar: sem ele o dash.js não sabe que recebeu um trecho, e
        # trata os 4 KB do índice como o arquivo inteiro.
        self.assertIn("Content-Range", CABECALHOS_REPASSADOS)


class TestOResolvedorPagina(unittest.TestCase):
    """O que o resolvedor PEDE ao yt-dlp para cada página."""

    def mundo_com_listar(self, quantos=30):
        chamadas = []

        def listar(url, de, ate):
            chamadas.append({"url": url, "de": de, "ate": ate})
            return {"title": "resultados", "entries": [
                {"_type": "url", "ie_key": "Youtube", "id": f"{i:011d}"[-11:],
                 "title": f"Vídeo {i}", "duration": 60,
                 "thumbnails": [{"url": "https://x/t.jpg", "height": 180}]}
                for i in range(de, de + quantos)]}

        mundo = Mundo()
        return Resolvedor(mundo.extrair, mundo.ler, listar=listar,
                          agora=lambda: mundo.t), chamadas

    def test_a_primeira_pagina_pede_de_1(self):
        r, chamadas = self.mundo_com_listar()
        lst = r.listar(analisar("https://www.youtube.com/results?search_query=gatos"))
        self.assertEqual(chamadas[0]["de"], 1)
        self.assertEqual(chamadas[0]["ate"], 30)
        self.assertEqual(chamadas[0]["url"], "ytsearch30:gatos")
        self.assertEqual(lst.de, 1)
        self.assertTrue(lst.tem_mais)

    def test_a_segunda_pagina_pede_o_INTERVALO_seguinte_e_amplia_a_busca(self):
        # ⚠ As duas metades importam: `de/ate` recortam, e o `ytsearchN` cresce. Sem a segunda, o
        # yt-dlp buscaria trinta e o recorte 31–60 devolveria nada — uma rolagem que simplesmente
        # para, sem erro.
        r, chamadas = self.mundo_com_listar()
        r.listar(analisar("https://www.youtube.com/results?search_query=gatos"), de=31)
        self.assertEqual((chamadas[0]["de"], chamadas[0]["ate"]), (31, 60))
        self.assertEqual(chamadas[0]["url"], "ytsearch60:gatos")

    def test_numa_playlist_a_URL_nao_muda_entre_paginas(self):
        r, chamadas = self.mundo_com_listar()
        alvo = analisar("https://www.youtube.com/playlist?list=PLabc123")
        r.listar(alvo, de=1)
        r.listar(alvo, de=31)
        self.assertEqual(chamadas[0]["url"], chamadas[1]["url"])
        self.assertEqual(chamadas[1]["de"], 31)

    def test_uma_pagina_incompleta_diz_que_acabou(self):
        r, _ = self.mundo_com_listar(quantos=7)
        lst = r.listar(analisar("https://www.youtube.com/results?search_query=gatos"))
        self.assertEqual(len(lst.itens), 7)
        self.assertFalse(lst.tem_mais, "a rolagem continuaria pedindo uma lista que acabou")

    def test_sem_o_injetado_de_listagem_nada_estoura(self):
        # Um `Resolvedor` montado só para resolver vídeos — o caso de um teste, ou de um caminho
        # que não precisa de listagem.
        mundo = Mundo()
        r = Resolvedor(mundo.extrair, mundo.ler, agora=lambda: mundo.t)
        self.assertIsNone(r.listar(analisar("https://www.youtube.com/results?search_query=x")))


class TestNenhumaUrlSAI_ABSOLUTA(unittest.TestCase):
    """⚠ **O portão que faltava, e a falta custou a primeira reprodução de verdade.**

    O app é servido sob `/<serverId>/proxy/app/<id>/`. Uma URL que o backend devolve começando com
    `/` **sai do prefixo** e chega num 404 do PORTAL — não do backend, o que já torna o rastro
    confuso: nada no log do app registra a requisição que falhou.

    O `mpd` saía com barra e a `miniatura` sem, no mesmo corpo de resposta. Na tela isso apareceu
    como um cartão com capa perfeita e um vídeo que não toca.

    ⚠ **E por que nada pegou:** o teste do `mpd` FIXOU o valor errado (ele afirmava
    `"/api/yt/mpd?v=…"`, com barra), e a bancada do navegador usava um duble escrito à mão com o
    valor CERTO — ou seja, ela media um contrato que o backend não cumpria. Duas verdades que
    ninguém percorria junto, que é a mesma forma do defeito da tag `v4`.

    Este teste é mecânico de propósito: vale para toda URL de toda resposta, inclusive as que ainda
    não existem.
    """

    def urls_de(self, obj, caminho="", achadas=None):
        """Todo valor que parece uma rota nossa, com o caminho até ele."""
        achadas = [] if achadas is None else achadas
        if isinstance(obj, dict):
            for k, v in obj.items():
                self.urls_de(v, f"{caminho}.{k}", achadas)
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                self.urls_de(v, f"{caminho}[{i}]", achadas)
        elif isinstance(obj, str) and "api/" in obj:
            achadas.append((caminho, obj))
        return achadas

    def test_a_resposta_de_abertura_nao_tem_URL_absoluta(self):
        mundo = Mundo()
        v = mundo.resolvedor().video("aqz-KE-bpKQ")
        corpo = resposta_de_abertura(analisar("https://youtu.be/aqz-KE-bpKQ"), v)
        achadas = self.urls_de(corpo)
        self.assertTrue(achadas, "o piso caiu: nenhuma URL encontrada no corpo")
        for onde, url in achadas:
            self.assertFalse(url.startswith("/"), f"{onde} = {url!r} sai do prefixo do app")

    def test_a_listagem_nao_tem_URL_absoluta(self):
        from listas import como_json, normalizar
        with open(os.path.join(AQUI, "dados", "yt-lista-busca.json"), encoding="utf-8") as fh:
            corpo = como_json(normalizar(json.load(fh), "busca"))
        achadas = self.urls_de(corpo)
        self.assertGreaterEqual(len(achadas), 8, "o piso caiu: a listagem perdeu as miniaturas")
        for onde, url in achadas:
            self.assertFalse(url.startswith("/"), f"{onde} = {url!r} sai do prefixo do app")

    def test_o_BaseURL_do_manifesto_tambem_e_relativo(self):
        # ⚠ Aqui o efeito seria PIOR que o do `mpd`: o manifesto carregaria e nenhum segmento
        # baixaria — na tela, um vídeo eternamente "carregando" em vez de um erro.
        import xml.etree.ElementTree as ET

        from dash import montar_mpd
        mundo = Mundo()
        v = mundo.resolvedor().video("aqz-KE-bpKQ")
        raiz = ET.fromstring(montar_mpd(v.duracao, v.trilhas, "api/yt/bytes?v=aqz&f="))
        ns = {"m": "urn:mpeg:dash:schema:mpd:2011"}
        bases = [b.text for b in raiz.findall(".//m:BaseURL", ns)]
        self.assertGreaterEqual(len(bases), 15)
        for b in bases:
            self.assertFalse(b.startswith("/"), f"{b!r} sai do prefixo do app")

    def test_o_BaseURL_RESOLVIDO_cai_na_rota_de_bytes(self):
        """⚠ **A regra que quase ninguém tem na cabeça, e ela custou a segunda tentativa.**

        Um `<BaseURL>` relativo do DASH é resolvido contra a URL do **MANIFESTO**, não contra a da
        página. O MPD é servido em `…/api/yt/mpd`, cujo diretório é `…/api/yt/` — então um
        `api/yt/bytes` vira `…/api/yt/api/yt/bytes`, e todo segmento leva 404.

        Medido em uso: o manifesto carregava, o player pedia dezoito segmentos, e todos voltavam
        com o caminho duplicado no meio.

        ⚠ E o teste tem de MEDIR A RESOLUÇÃO, não o texto: `"bytes?v=…"` e `"api/yt/bytes?v=…"` são
        os dois relativos, os dois passam em qualquer conferência de "não começa com barra", e um
        deles não funciona. Foi por isso que o portão anterior — que só olhava a barra inicial —
        aprovou o valor errado.
        """
        import xml.etree.ElementTree as ET
        from urllib.parse import urljoin

        from dash import montar_mpd

        # Exatamente onde a rota vive, com o prefixo do portal no meio.
        URL_DO_MPD = ("https://vssh.exemplo.org/servidor01/proxy/app/palco"
                      "/api/yt/mpd?v=3JyMN1ZWqQo")
        ESPERADO = "https://vssh.exemplo.org/servidor01/proxy/app/palco/api/yt/bytes"

        mundo = Mundo()
        v = mundo.resolvedor().video("3JyMN1ZWqQo")
        raiz = ET.fromstring(montar_mpd(v.duracao, v.trilhas, "bytes?v=3JyMN1ZWqQo&f="))
        ns = {"m": "urn:mpeg:dash:schema:mpd:2011"}
        bases = [b.text for b in raiz.findall(".//m:BaseURL", ns)]
        self.assertGreaterEqual(len(bases), 15, "o piso caiu: o manifesto ficou sem BaseURL")
        for b in bases:
            resolvida = urljoin(URL_DO_MPD, b)
            self.assertTrue(resolvida.startswith(ESPERADO + "?"),
                            f"{b!r} resolve para {resolvida!r}, e não para a rota de bytes")

    def test_o_MAIN_monta_o_BaseURL_com_o_valor_que_RESOLVE(self):
        # ⚠ O teste acima passa o prefixo à mão — mede o gerador, não quem o chama. Este lê a
        # linha do `main.py`, que é onde o valor de verdade é escolhido, e é onde ele estava errado.
        with open(os.path.join(AQUI, "..", "backend", "main.py"), encoding="utf-8") as fh:
            fonte = fh.read()
        chamadas = re.findall(r"montar_mpd\([^)]*?f\"([^\"]+)\"", fonte)
        self.assertEqual(len(chamadas), 1, f"esperava uma chamada a montar_mpd, achei {chamadas}")
        valor = chamadas[0]
        self.assertFalse(valor.startswith("/"),
                         f"o main.py monta o BaseURL como {valor!r} — sai do prefixo do app")
        # ⚠ E a segunda metade, que a primeira versão não tinha: relativo NÃO basta. O MPD mora em
        # `…/api/yt/mpd`, então o BaseURL é resolvido a partir de `…/api/yt/` — e repetir o
        # `api/yt/` ali duplica o caminho. As duas rotas são irmãs; o valor tem de dizer isso.
        from urllib.parse import urljoin
        resolvida = urljoin("https://h/pre/app/api/yt/mpd?v=X", valor.replace("{vid}", "X") + "134")
        self.assertEqual(resolvida, "https://h/pre/app/api/yt/bytes?v=X&f=134",
                         f"o main.py monta {valor!r}, que resolve para {resolvida!r}")


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


class TestPorQueOVideoNaoAbriu(unittest.TestCase):
    """⚠ Antes disto, TODA falha de resolução dizia "atualize o yt-dlp".

    Veio um relato de vídeos que "simplesmente não abrem", e por baixo estava DRM: o extractor
    estava perfeito, e a pessoa poderia clicar naquele botão para sempre. **Um conserto sugerido que
    não conserta é pior que nenhum** — ele gasta a única pista que havia.
    """

    # As mensagens são as MEDIDAS, contra o vídeo do relato (`Fpu5a0Bl8eY`), com o yt-dlp
    # 2026.07.04. As três primeiras vieram da mesma resolução, só trocando o cliente.
    PADRAO_EN = "ERROR: [youtube] Fpu5a0Bl8eY: This video is not available"
    PADRAO_PT = "ERROR: [youtube] Fpu5a0Bl8eY: O vídeo não está disponível"
    TV = "ERROR: [youtube] Fpu5a0Bl8eY: This video is DRM protected"

    def test_o_piso_a_frase_do_YOUTUBE_vem_traduzida(self):
        # ⚠ É a medição que proíbe classificar pelo texto do YouTube: a MESMA recusa, do MESMO
        # vídeo, chega em inglês ou em português conforme o `hl`. Uma regra sobre essa frase
        # passaria a errar no dia em que alguém usasse o app noutro idioma — e a essa altura o
        # `hl` do navegador já é o que manda.
        self.assertIn("not available", self.PADRAO_EN)
        self.assertIn("não está disponível", self.PADRAO_PT)

    def test_DRM_e_nomeado_pela_segunda_opiniao(self):
        # Os clientes padrão só dizem "indisponível"; o `tv` diz o que é. Sem juntar as duas, a
        # única resposta possível seria "não abriu".
        classe, frase, conserto = classificar_falha(self.PADRAO_PT, self.TV)
        self.assertEqual(classe, "drm")
        self.assertIn("DRM", frase)
        self.assertIn("navegador", conserto)
        # ⚠ E o que ele NÃO pode dizer: o extractor não tem nada a ver com isto.
        self.assertNotIn("yt-dlp", conserto)

    def test_sem_a_segunda_opiniao_o_DRM_e_indistinguivel(self):
        # Registra o custo de não fazer a segunda chamada: a resposta cai no genérico. É honesto —
        # mostra o que o YouTube disse — mas não nomeia a causa.
        classe, frase, _ = classificar_falha(self.PADRAO_PT, None)
        self.assertEqual(classe, "youtube")
        self.assertEqual(frase, "O vídeo não está disponível")

    def test_o_extractor_velho_ganha_o_botao_e_SO_ele(self):
        for msg in ("ERROR: [youtube] abc: Unable to extract nsig function name",
                    "ERROR: [youtube] abc: Failed to extract any player response",
                    "ERROR: [youtube] abc: Sign in to confirm you're not a bot"):
            classe, _, conserto = classificar_falha(msg, None)
            self.assertEqual(classe, "extractor", msg)
            self.assertIn("Atualizar o yt-dlp", conserto, msg)

    def test_a_recusa_do_youtube_vai_com_as_palavras_DELE(self):
        # Ele sabe por que recusou; nós não temos nada melhor a dizer. E o `ERROR: [youtube] <id>:`
        # na frente é ruído de ferramenta — mostrá-lo faria a frase parecer um defeito do app.
        classe, frase, conserto = classificar_falha(
            "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access",
            "ERROR: [youtube] dQw4w9WgXcQ: Private video")
        self.assertEqual(classe, "youtube")
        self.assertTrue(frase.startswith("Private video"), frase)
        self.assertNotIn("ERROR", frase)
        self.assertNotIn("[youtube]", frase)
        self.assertIn("navegador", conserto)

    def test_o_DRM_ganha_do_sinal_de_extractor(self):
        # ⚠ A ordem importa e é medida por este teste: as duas famílias podem aparecer na mesma
        # colheita — a segunda opinião traz uma mensagem, a primeira traz outra — e mandar a pessoa
        # atualizar o extractor por causa de um vídeo com DRM é o defeito original de volta.
        classe, _, _ = classificar_falha(
            "ERROR: Unable to extract player response", "ERROR: This video is DRM protected")
        self.assertEqual(classe, "drm")

    def test_falha_sem_texto_nenhum_ainda_diz_alguma_coisa(self):
        # Um `Exception()` vazio não pode virar um aviso em branco na tela, que afirma que não há
        # nada a dizer.
        classe, frase, conserto = classificar_falha(None, "")
        self.assertEqual(classe, "youtube")
        self.assertTrue(frase.strip())
        self.assertTrue(conserto.strip())
