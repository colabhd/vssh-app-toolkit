"""A ordem dos irmãos de pasta, e o perfil que o cliente manda.

Duas peças pequenas que moravam no `main.py` e saíram de lá por um motivo prático: `main.py` importa
a lib do toolkit, que usa socket Unix, e por isso não abre no Windows. Uma regra que só se mede em
metade das máquinas de quem desenvolve é uma regra que ninguém mede.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from decisao import PERFIL_MINIMO, perfil_de  # noqa: E402
from pasta import em_ordem, vizinhanca  # noqa: E402


class TestOrdem(unittest.TestCase):
    def test_o_episodio_10_vem_depois_do_2(self):
        # ⚠ Alfabética crua compara `1` com `2` e põe `ep10` **antes** de `ep2`. Numa série isso
        # joga o episódio 10 para o meio da primeira metade, e o botão "próximo" passa a pular — um
        # defeito que parece aleatório e que ninguém liga a uma função de ordenação.
        nomes = ["ep10.mkv", "ep2.mkv", "ep1.mkv", "ep20.mkv", "ep3.mkv"]
        self.assertEqual(em_ordem(nomes),
                         ["ep1.mkv", "ep2.mkv", "ep3.mkv", "ep10.mkv", "ep20.mkv"])

    def test_temporada_e_episodio_juntos(self):
        nomes = ["S01E10.mkv", "S01E02.mkv", "S02E01.mkv", "S01E09.mkv"]
        self.assertEqual(em_ordem(nomes),
                         ["S01E02.mkv", "S01E09.mkv", "S01E10.mkv", "S02E01.mkv"])

    def test_maiuscula_nao_separa_o_acervo_em_dois(self):
        # Ordem por byte põe todo `Z` antes de todo `a`, e a lista aparece cortada ao meio.
        self.assertEqual(em_ordem(["banana.mp3", "Abacaxi.mp3", "cereja.mp3"]),
                         ["Abacaxi.mp3", "banana.mp3", "cereja.mp3"])

    def test_o_que_o_Palco_nao_abre_fica_de_fora(self):
        nomes = ["filme.mkv", "capa.jpg", "legenda.srt", "notas.txt", "musica.flac"]
        self.assertEqual(em_ordem(nomes), ["filme.mkv", "musica.flac"])

    def test_arquivo_oculto_e_sem_extensao(self):
        self.assertEqual(em_ordem([".oculto", "semponto", "a.mkv"]), ["a.mkv"])


class TestVizinhanca(unittest.TestCase):
    def test_o_indice_aponta_para_o_que_esta_tocando(self):
        lista, i = vizinhanca(["ep2.mkv", "ep10.mkv", "ep1.mkv"], "ep2.mkv")
        self.assertEqual(lista, ["ep1.mkv", "ep2.mkv", "ep10.mkv"])
        self.assertEqual(i, 1)

    def test_o_atual_ENTRA_na_lista_mesmo_com_extensao_estranha(self):
        # ⚠ O ambiente pode ter mandado abrir por MIME, ou a pessoa usou "abrir com". Sumir com o
        # arquivo que está tocando da própria lista é pior do que ter um item a mais: o "próximo"
        # partiria de lugar nenhum.
        lista, i = vizinhanca(["a.mkv", "b.mkv"], "estranho.mxf")
        self.assertIn("estranho.mxf", lista)
        self.assertEqual(lista[i], "estranho.mxf")

    def test_pasta_de_um_arquivo_so(self):
        lista, i = vizinhanca(["unico.mp4"], "unico.mp4")
        self.assertEqual((lista, i), (["unico.mp4"], 0))


class TestPerfil(unittest.TestCase):
    def test_o_perfil_completo_passa(self):
        p = perfil_de({"containers": ["mp4"], "video": ["h264", "vp9"], "audio": ["aac"]})
        self.assertEqual(p.video, {"h264", "vp9"})

    def test_perfil_PARCIAL_cai_no_minimo(self):
        # ⚠ É pior que perfil nenhum: um cliente que mandasse `video: []` por um bug de sondagem
        # receberia transcodificação de TUDO, para sempre, sem nada indicando o motivo. Cair no
        # mínimo é previsível, e o mínimo toca.
        for parcial in (
            {"containers": ["mp4"], "video": [], "audio": ["aac"]},
            {"containers": ["mp4"], "video": ["h264"]},
            {},
            {"containers": ["mp4"], "video": ["h264"], "audio": None},
        ):
            self.assertIsNone(perfil_de(parcial), repr(parcial))

    def test_lixo_nao_derruba(self):
        for lixo in (None, "mp4", 42, [1, 2], {"containers": 5, "video": 1, "audio": 1}):
            p = perfil_de(lixo)
            self.assertTrue(p is None or p == PERFIL_MINIMO, repr(lixo))


if __name__ == "__main__":
    unittest.main()
