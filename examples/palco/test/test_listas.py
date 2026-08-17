"""As três listagens da aba, medidas contra o que o YouTube devolve de verdade.

⚠ **O defeito que este arquivo existe para impedir é silencioso e ridículo:** a URL nua de um canal
não devolve vídeos, devolve as ABAS dele. Sem `/videos`, a grade mostraria três cartões chamados
"Fulano - Videos", "Fulano - Shorts" e "Fulano - Playlists" — sem duração, sem miniatura, e nenhum
abrindo coisa alguma. Nada falharia, nada apareceria no log.

As fixturas em `test/dados/yt-lista-*.json` são `extract_info` de verdade, com `extract_flat`, e
`yt-lista-canal-abas.json` é justamente a resposta errada — guardada de propósito, porque é ela que
o portão precisa reprovar.
"""

import json
import os
import sys
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "backend"))

from listas import POR_PAGINA, como_json, normalizar, url_de_listagem  # noqa: E402
from urls import analisar  # noqa: E402


def fixture(nome):
    with open(os.path.join(AQUI, "dados", f"yt-lista-{nome}.json"), encoding="utf-8") as f:
        return json.load(f)


class TestOQuePedirAoYtDlp(unittest.TestCase):
    def test_a_busca_vira_ytsearchN_e_nao_uma_pagina_de_resultados(self):
        # ⚠ Pedir `/results?search_query=` devolveria a página do YouTube para depois raspá-la. O
        # extractor de busca aceita o número na própria chave.
        u = url_de_listagem(analisar("https://www.youtube.com/results?search_query=gatos+fofos"))
        self.assertEqual(u, f"ytsearch{POR_PAGINA}:gatos fofos")

    def test_busca_sem_termo_nao_vira_pedido(self):
        # `analisar` já devolve `inicio` nesse caso; aqui a conferência é a de que nada vaza.
        self.assertIsNone(url_de_listagem(analisar("https://www.youtube.com/results")))

    def test_a_playlist_vira_a_url_canonica(self):
        u = url_de_listagem(analisar("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123"))
        # Um vídeo COM lista é um vídeo — quem pede a fila é outra rota, com o alvo de playlist.
        self.assertIsNone(u)
        u = url_de_listagem(analisar("https://www.youtube.com/playlist?list=PLabc123"))
        self.assertEqual(u, "https://www.youtube.com/playlist?list=PLabc123")

    def test_TODA_forma_de_canal_ganha_a_aba_videos(self):
        # ⚠ A asserção que dá sentido ao arquivo. As quatro formas continuam circulando — `/user` é
        # de 2005, `/c` de 2012, `/channel` carrega o id verdadeiro e `@handle` é de 2022 —, e é
        # justamente o link antigo, de um e-mail ou de um PDF, que chega por deeplink.
        casos = {
            "https://www.youtube.com/@BlenderOfficial":
                "https://www.youtube.com/@BlenderOfficial/videos",
            "https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg":
                "https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg/videos",
            "https://www.youtube.com/c/Blender": "https://www.youtube.com/c/Blender/videos",
            "https://www.youtube.com/user/Blender": "https://www.youtube.com/c/Blender/videos",
        }
        for entrada, esperado in casos.items():
            self.assertEqual(url_de_listagem(analisar(entrada)), esperado, entrada)

    def test_um_video_ou_None_nao_vira_listagem(self):
        self.assertIsNone(url_de_listagem(analisar("https://youtu.be/dQw4w9WgXcQ")))
        self.assertIsNone(url_de_listagem(None))
        self.assertIsNone(url_de_listagem(analisar("https://exemplo.org/")))


class TestOPisoDasFixturas(unittest.TestCase):
    """Sem isto, uma fixture vazia faria todo teste abaixo medir conjunto vazio e passar."""

    def test_as_quatro_fixturas_tem_o_que_medir(self):
        for nome, minimo in (("busca", 8), ("playlist", 8), ("canal", 6), ("canal-abas", 3),
                             ("busca-com-canal", 12)):
            ents = fixture(nome)["entries"]
            self.assertGreaterEqual(len(ents), minimo, nome)
        # E a do canal-abas TEM de ser a resposta errada, senão o portão principal não mede nada.
        abas = fixture("canal-abas")["entries"]
        self.assertTrue(all(e.get("_type") == "playlist" for e in abas),
                        "a fixture das abas deixou de ser a resposta errada")


class TestNormalizar(unittest.TestCase):
    def test_a_busca_vira_cartoes_com_o_que_um_cartao_precisa(self):
        r = normalizar(fixture("busca"), "busca")
        self.assertEqual(len(r.itens), 8)
        for i in r.itens:
            self.assertTrue(i.id and i.titulo, i)
            self.assertTrue(i.canal, f"{i.titulo}: sem canal")
            self.assertTrue(i.duracao and i.duracao > 0, f"{i.titulo}: sem duração")
            self.assertTrue(i.miniatura, f"{i.titulo}: sem miniatura")

    def test_A_PAGINA_DE_ABAS_DO_CANAL_NAO_VIRA_VIDEOS(self):
        # ⚠ **O teste que este arquivo existe para ter.** Se `_type` deixar de ser conferido, as
        # três abas viram três cartões chamados "Blender - Videos", "Blender - Shorts" e
        # "Blender - Playlists" — sem duração, sem miniatura, e nenhum abrindo coisa alguma.
        r = normalizar(fixture("canal-abas"), "canal")
        self.assertEqual(r.itens, [],
                         "as abas do canal viraram cartões de vídeo: "
                         + ", ".join(i.titulo for i in r.itens))

    def test_UM_CANAL_entre_os_resultados_da_busca_NAO_vira_cartao(self):
        # ⚠ **Achado em uso, e o sintoma passou por defeito de outra coisa.** Uma busca por
        # "lofi girl" traz o CANAL entre os resultados, com `_type: 'url'` — exatamente como um
        # vídeo. Só o `ie_key` os separa: `Youtube` contra `YoutubeTab`.
        #
        # Sem a guarda, o canal virava cartão e o id dele (`UCSJ4gkVC6NrvII8umztf0Ow`, 24
        # caracteres) ia parar na URL da miniatura, que respondia 400. Na tela: um cartão sem capa
        # e sem duração, que não abre nada — e no console um 400 que parece problema do proxy.
        info = fixture("busca-com-canal")
        canais = [e for e in info["entries"] if e.get("ie_key") == "YoutubeTab"]
        self.assertTrue(canais, "a fixture perdeu o canal — o portão passou a medir nada")
        self.assertTrue(all(e.get("_type") == "url" for e in canais),
                        "o canal deixou de se parecer com um vídeo; o teste perdeu o sentido")

        r = normalizar(info, "busca")
        ids = {i.id for i in r.itens}
        for c in canais:
            self.assertNotIn(c["id"], ids, f"o canal {c['id']} virou um cartão de vídeo")
        # E os vídeos de verdade continuam lá: uma guarda que descartasse tudo também "passaria".
        self.assertEqual(len(r.itens), len(info["entries"]) - len(canais))

    def test_todo_id_que_sai_daqui_e_id_de_VIDEO(self):
        # A rede de segurança da guarda acima: se o yt-dlp renomear `YoutubeTab` um dia, o formato
        # do id continua sendo o que é. Onze caracteres de um alfabeto fechado.
        for nome in ("busca", "playlist", "canal", "busca-com-canal"):
            for i in normalizar(fixture(nome), "busca").itens:
                self.assertRegex(i.id, r"^[A-Za-z0-9_-]{11}$", f"{nome}: {i.id!r}")

    def test_CADA_uma_das_TRES_guardas_barra_sozinha(self):
        # ⚠ **Este teste existe porque a refutação achou o buraco — três vezes.** As três guardas
        # (`_type`, `ie_key` e o formato do id) são defesa em profundidade, e nas fixturas reais
        # elas COINCIDEM: o canal entre os resultados tem `YoutubeTab` E id de 24 caracteres; as
        # abas têm `_type: 'playlist'` E `YoutubeTab`. Quebrar qualquer uma deixava as outras
        # cobrindo, e a suíte inteira ficava verde.
        #
        # São três de propósito, e cada uma tem de valer sozinha: se o yt-dlp renomear `YoutubeTab`,
        # sobram o id e o `_type`; se um dia um canal tiver id de 11 caracteres, sobram os outros
        # dois. Defesa em profundidade que ninguém mede isolada é uma defesa só, com duas cópias.
        base = {"_type": "url", "title": "Parece um vídeo", "duration": 100,
                "channel": "Alguém", "thumbnails": [{"url": "https://x/t.jpg", "height": 180}]}

        # 1. `ie_key` de canal, mas id com FORMA de vídeo — só a primeira guarda pode barrar.
        so_ie_key = {**base, "id": "aaaaaaaaaaa", "ie_key": "YoutubeTab"}
        self.assertEqual(normalizar({"entries": [so_ie_key]}, "busca").itens, [],
                         "a guarda do `ie_key` não barra sozinha")

        # 2. `ie_key` de vídeo, mas id de canal — só a segunda guarda pode barrar.
        so_id = {**base, "id": "UCSJ4gkVC6NrvII8umztf0Ow", "ie_key": "Youtube"}
        self.assertEqual(normalizar({"entries": [so_id]}, "busca").itens, [],
                         "a guarda do formato do id não barra sozinha")

        # 3. `_type` de seção, com extractor e id de vídeo — só a terceira guarda pode barrar.
        #    A refutação achou este buraco depois dos outros dois: na fixture das abas do canal, o
        #    `_type: 'playlist'` vem acompanhado de `ie_key: 'YoutubeTab'`, então a guarda do
        #    extractor já as barrava e quebrar a do `_type` deixava tudo verde.
        so_tipo = {**base, "id": "aaaaaaaaaaa", "ie_key": "Youtube", "_type": "playlist"}
        self.assertEqual(normalizar({"entries": [so_tipo]}, "canal").itens, [],
                         "a guarda do `_type` não barra sozinha")

        # 4. E um vídeo de verdade continua passando: guardas que barram tudo também "passariam"
        #    nos três casos acima.
        bom = {**base, "id": "aqz-KE-bpKQ", "ie_key": "Youtube"}
        self.assertEqual(len(normalizar({"entries": [bom]}, "busca").itens), 1,
                         "as guardas ficaram tão rígidas que descartam vídeos de verdade")

    def test_a_aba_videos_do_MESMO_canal_vira_videos(self):
        # A outra metade: a guarda não pode ser tão rígida que descarte os vídeos de verdade.
        r = normalizar(fixture("canal"), "canal")
        self.assertGreaterEqual(len(r.itens), 6)
        self.assertTrue(all(i.duracao for i in r.itens))

    def test_o_titulo_do_canal_perde_o_sufixo_do_yt_dlp(self):
        # Ele devolve "Blender - Videos" ao pedir a aba. O sufixo é dele, não do canal, e um
        # cabeçalho dizendo "Blender - Videos" parece um erro de quem escreveu a tela.
        r = normalizar(fixture("canal"), "canal")
        self.assertEqual(r.titulo, "Blender")
        self.assertNotIn(" - Videos", r.titulo)

    def test_um_video_removido_dentro_da_playlist_SOME_do_cartao(self):
        # ⚠ O yt-dlp devolve a entrada com título nulo. Um cartão sem nome não é clicável nem
        # explicável; o `total` continua sendo o que o YouTube declarou, que é a verdade.
        info = fixture("playlist")
        antes = len(normalizar(info, "playlist").itens)
        info["entries"][2]["title"] = None
        info["entries"][4].pop("id", None)
        r = normalizar(info, "playlist")
        self.assertEqual(len(r.itens), antes - 2)
        self.assertEqual(r.total, info.get("playlist_count"))

    def test_a_miniatura_escolhida_e_a_do_TAMANHO_do_cartao(self):
        # ⚠ Nem a primeira nem a última. As listagens trazem de 94 px a 404 px: a primeira fica
        # borrada num cartão de 180 px, e a última é o dobro do necessário — vezes trinta cartões,
        # e por um proxy que é nosso, é banda do servidor para pixels que ninguém vê.
        info = fixture("playlist")
        e = info["entries"][0]
        alturas = sorted(t["height"] for t in e["thumbnails"] if t.get("height"))
        self.assertGreater(len(alturas), 1, "a fixture perdeu a variedade de tamanhos")
        escolhida = normalizar(info, "playlist").itens[0].miniatura
        alvo = min(alturas, key=lambda h: abs(h - 180))
        esperada = next(t["url"] for t in e["thumbnails"] if t.get("height") == alvo)
        self.assertEqual(escolhida, esperada)

    def test_gravacao_de_live_nao_e_ao_vivo(self):
        info = fixture("busca")
        info["entries"][0]["live_status"] = "was_live"
        info["entries"][1]["live_status"] = "is_live"
        r = normalizar(info, "busca")
        self.assertFalse(r.itens[0].ao_vivo)
        self.assertTrue(r.itens[1].ao_vivo)

    def test_info_torta_nao_lanca(self):
        for ruim in (None, {}, {"entries": None}, {"entries": [None, 3, "x", {}]}):
            self.assertEqual(normalizar(ruim, "busca").itens, [], repr(ruim)[:40])


class TestOQueAGradeRecebe(unittest.TestCase):
    def test_a_miniatura_vai_pelo_NOSSO_proxy(self):
        # ⚠ Duas razões, e cada uma basta: a página não busca de outra origem sem CORS, e todo byte
        # que a pessoa recebe atravessa o ambiente — que é a promessa do vssh, não um detalhe.
        j = como_json(normalizar(fixture("busca"), "busca"))
        for item in j["itens"]:
            self.assertTrue(item["miniatura"].startswith("api/yt/miniatura?v="), item["miniatura"])
            self.assertNotIn("ytimg", item["miniatura"])
            # Sem barra inicial: o app é servido sob `/<serverId>/proxy/app/<id>/`, e um `/api/…`
            # sairia do prefixo — chegando num 404 do portal.
            self.assertFalse(item["miniatura"].startswith("/"))

    def test_o_corpo_nao_carrega_o_extract_info(self):
        j = como_json(normalizar(fixture("playlist"), "playlist"))
        bruto = json.dumps(j)
        self.assertNotIn("ytimg", bruto, "as URLs originais das miniaturas vazaram")
        self.assertNotIn("_type", bruto)
        self.assertLess(len(bruto), 6000)

    def test_a_playlist_carrega_o_id_da_lista(self):
        # É o que permite "tocar a lista" e o próximo/anterior dentro dela.
        j = como_json(normalizar(fixture("playlist"), "playlist", lista="PLabc123"))
        self.assertEqual(j["lista"], "PLabc123")


if __name__ == "__main__":
    unittest.main()
