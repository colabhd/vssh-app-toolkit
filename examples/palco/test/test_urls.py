"""Todo endereço do YouTube que o Palco pode receber — e os que ele devolve.

─── Por que este é o teste mais importante dos três ─────────────────────────

Porque ele mede a promessa que o deeplink faz. No momento em que um link do YouTube passa a abrir
aqui, o Palco tem de dar conta de TODA forma de endereço — não só de `/watch`. Se alguém clica numa
playlist e recebe "isto não é um vídeo", o roteamento ficou **pior do que não existir**: a pessoa
clicou num link e chegou num beco, e o caminho de volta (abrir no navegador) ela não sabe que existe.

Por isso o valor de retorno mais importante daqui é `None`. Ele não quer dizer "erro": quer dizer
"este endereço não é meu, devolva-o" — e quem chama devolve com
`vssh.openUrl(url, {destino: 'navegador'})`. Um analisador que tentasse adivinhar um vídeo em toda
URL do YouTube produziria exatamente o beco que o `None` evita.

Nada aqui fala com a rede: são strings entrando e dataclasses saindo. Um teste de análise de URL que
precisasse do YouTube ficaria vermelho quando o Google mudasse alguma coisa, que é o oposto de um
sinal.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from urls import analisar, segundos_de  # noqa: E402


class TestVideo(unittest.TestCase):
    def test_as_tres_formas_de_dizer_o_mesmo_video(self):
        # Três endereços, um vídeo. Quem manda o link não escolhe a forma — ela vem do botão de
        # compartilhar, do app de celular ou de um copiar-e-colar da barra.
        for url in (
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
        ):
            alvo = analisar(url)
            self.assertEqual(alvo.tipo, "video", url)
            self.assertEqual(alvo.id, "dQw4w9WgXcQ", url)

    def test_shorts_e_video_no_mesmo_player(self):
        # Vertical é enquadramento, não formato: o mesmo player toca, e o letterbox resolve.
        alvo = analisar("https://www.youtube.com/shorts/dQw4w9WgXcQ")
        self.assertEqual((alvo.tipo, alvo.id), ("video", "dQw4w9WgXcQ"))

    def test_o_embed_tambem_e_um_video(self):
        # Chega quando alguém copia o link de um <iframe> de um site qualquer.
        self.assertEqual(analisar("https://www.youtube.com/embed/dQw4w9WgXcQ").id, "dQw4w9WgXcQ")

    def test_o_id_e_conferido_e_nao_apenas_recortado(self):
        # ⚠ Sem conferir a forma, `youtu.be/robots.txt` viraria "o vídeo robots.txt" e a pessoa
        # receberia um erro do resolvedor em vez do site. O id do YouTube tem 11 caracteres de um
        # alfabeto fechado — é barato de conferir e caro de não conferir.
        for ruim in (
            "https://youtu.be/robots.txt",
            "https://youtu.be/",
            "https://www.youtube.com/watch?v=curto",
            "https://www.youtube.com/watch?v=tem/barra11",
            "https://www.youtube.com/watch",
        ):
            self.assertIsNone(analisar(ruim), ruim)


class TestTempo(unittest.TestCase):
    def test_o_link_com_hora_marcada_chega_com_ela(self):
        # É o caso do link que alguém manda dizendo "olha aos 2 minutos". Perder o `t` transforma
        # um link preciso num link genérico, e a pessoa não tem como saber o que se perdeu.
        self.assertEqual(analisar("https://youtu.be/dQw4w9WgXcQ?t=90").t, 90)
        self.assertEqual(analisar("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s").t, 90)
        self.assertEqual(analisar("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=90").t, 90)

    def test_as_formas_compostas(self):
        for texto, esperado in (
            ("90", 90), ("90s", 90), ("2m", 120), ("1m30s", 90),
            ("1h", 3600), ("1h2m3s", 3723), ("0", 0),
        ):
            self.assertEqual(segundos_de(texto), esperado, texto)


class TestTempoInvalido(unittest.TestCase):
    def test_tempo_torto_nao_derruba_o_video(self):
        # ⚠ A escolha aqui é deliberada: um `t` que não parseia vira `None` e o vídeo abre do
        # começo. Recusar o endereço inteiro por causa do parâmetro secundário mandaria a pessoa
        # para o navegador por um detalhe que ela nem vê.
        for ruim in ("abacaxi", "", "-5", "m", "1x"):
            self.assertIsNone(segundos_de(ruim), ruim)
        alvo = analisar("https://youtu.be/dQw4w9WgXcQ?t=abacaxi")
        self.assertEqual(alvo.tipo, "video")
        self.assertIsNone(alvo.t)


class TestFila(unittest.TestCase):
    def test_playlist_pura_e_uma_fila(self):
        alvo = analisar("https://www.youtube.com/playlist?list=PLabcdefghij")
        self.assertEqual((alvo.tipo, alvo.lista), ("playlist", "PLabcdefghij"))

    def test_video_dentro_de_playlist_traz_as_duas_coisas(self):
        # ⚠ Este é `video`, e não `playlist`: quem clicou pediu AQUELE vídeo. A lista vira a fila
        # ao lado — que é o que o YouTube faz, e o que o VLC faz ao abrir um item de uma pasta.
        alvo = analisar("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij&index=4")
        self.assertEqual(alvo.tipo, "video")
        self.assertEqual(alvo.id, "dQw4w9WgXcQ")
        self.assertEqual(alvo.lista, "PLabcdefghij")
        self.assertEqual(alvo.indice, 4)

    def test_a_lista_de_mix_nao_e_uma_lista(self):
        # `RD…` é o rádio que o YouTube inventa a partir de um vídeo; ele não existe como playlist
        # buscável, e pedi-la ao yt-dlp devolve erro. Tratar como fila daria um beco com cara de bug.
        alvo = analisar("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ")
        self.assertEqual(alvo.tipo, "video")
        self.assertIsNone(alvo.lista)


class TestCanalEBusca(unittest.TestCase):
    def test_as_quatro_formas_de_endereco_de_canal(self):
        # Quatro por herança: `/user` é de 2005, `/c` de 2012, `/channel` é o id verdadeiro e
        # `/@handle` é de 2022. Todas continuam circulando em links antigos, e é justamente o link
        # antigo que chega por deeplink.
        for url, esperado in (
            ("https://www.youtube.com/@fulano", "@fulano"),
            ("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "UCabcdefghijklmnopqrstuv"),
            ("https://www.youtube.com/c/NomeDoCanal", "NomeDoCanal"),
            ("https://www.youtube.com/user/NomeAntigo", "NomeAntigo"),
        ):
            alvo = analisar(url)
            self.assertEqual(alvo.tipo, "canal", url)
            self.assertEqual(alvo.canal, esperado, url)

    def test_a_aba_do_canal_nao_muda_o_canal(self):
        # `/@fulano/videos`, `/streams`, `/playlists`: a aba é navegação DENTRO do canal, e a
        # página de canal do Palco decide qual mostrar.
        alvo = analisar("https://www.youtube.com/@fulano/videos")
        self.assertEqual((alvo.tipo, alvo.canal), ("canal", "@fulano"))

    def test_busca(self):
        alvo = analisar("https://www.youtube.com/results?search_query=gatos+fofos")
        self.assertEqual((alvo.tipo, alvo.termo), ("busca", "gatos fofos"))
        self.assertEqual(analisar("https://www.youtube.com/results?search_query=caf%C3%A9").termo, "café")

    def test_busca_vazia_e_a_pagina_inicial(self):
        # Uma busca sem termo não é um erro nem um beco: é a aba do YouTube, aberta.
        self.assertEqual(analisar("https://www.youtube.com/results?search_query=").tipo, "inicio")


class TestAoVivo(unittest.TestCase):
    def test_live_e_um_video(self):
        alvo = analisar("https://www.youtube.com/live/dQw4w9WgXcQ")
        self.assertEqual((alvo.tipo, alvo.id, alvo.ao_vivo), ("video", "dQw4w9WgXcQ", True))

    def test_o_live_do_canal_e_o_canal(self):
        # `/@fulano/live` não nomeia um vídeo: é "o que este canal estiver transmitindo agora", e
        # quem responde isso é o resolvedor, não a URL.
        alvo = analisar("https://www.youtube.com/@fulano/live")
        self.assertEqual((alvo.tipo, alvo.canal, alvo.ao_vivo), ("canal", "@fulano", True))


class TestInicio(unittest.TestCase):
    def test_a_home_abre_a_aba(self):
        for url in ("https://www.youtube.com/", "https://youtube.com", "https://m.youtube.com/"):
            self.assertEqual(analisar(url).tipo, "inicio", url)


class TestDevolver(unittest.TestCase):
    """O `None`, que é o que impede o deeplink de virar beco."""

    def test_o_que_exige_login_volta_para_o_navegador(self):
        # ⚠ Estas páginas o Palco NÃO promete: sem autenticação Google não há como montá-las, e
        # montar uma casca vazia seria pior que devolver. Devolver é honesto e leva a pessoa
        # exatamente onde ela conseguiria o que pediu.
        for url in (
            "https://www.youtube.com/feed/subscriptions",
            "https://www.youtube.com/feed/history",
            "https://www.youtube.com/playlist?list=WL",          # assistir depois: é da conta
            "https://www.youtube.com/playlist?list=LL",          # curtidos: idem
            "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
        ):
            self.assertIsNone(analisar(url), url)

    def test_outro_site_nao_e_nosso(self):
        for url in ("https://exemplo.org/watch?v=dQw4w9WgXcQ", "https://vimeo.com/12345"):
            self.assertIsNone(analisar(url), url)

    def test_NAO_e_casamento_por_sufixo(self):
        # ⚠ `'evilyoutube.com'.endswith('youtube.com')` é `True`, e é assim que este casamento sai
        # errado na primeira tentativa. O mesmo engano que o `opens.urls` recusa no schema tem de
        # ser recusado aqui — senão o app faria por dentro o que o manifesto impede por fora.
        for url in (
            "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.exemplo.org/watch?v=dQw4w9WgXcQ",
            "https://naoyoutu.be/dQw4w9WgXcQ",
        ):
            self.assertIsNone(analisar(url), url)

    def test_esquema_que_nao_e_web_nao_passa(self):
        for url in ("javascript:alert(1)", "file:///etc/passwd", "ftp://youtube.com/x"):
            self.assertIsNone(analisar(url), url)

    def test_lixo_nao_derruba(self):
        # O analisador recebe o que o ambiente mandar, e o ambiente recebe o que a pessoa clicar.
        for url in ("", "://", "http://", "youtube.com", None, 42):
            self.assertIsNone(analisar(url), repr(url))


if __name__ == "__main__":
    unittest.main()
