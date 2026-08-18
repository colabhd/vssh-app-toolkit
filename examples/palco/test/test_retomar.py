"""Onde a pessoa parou — e as três vezes em que a resposta certa é "não lembre".

Retomar é o recurso que separa um player de um `<video>`: ninguém assiste um filme de uma vez, e
reencontrar o minuto 47 à mão é o tipo de trabalho que o programa existe para não passar adiante.

Mas lembrar SEMPRE é pior do que não lembrar. Três casos, e cada um vira uma reclamação diferente:

    parou aos 8 s        retomar ali é ruído: a pessoa abriu e fechou, não assistiu
    parou aos 99%        ela TERMINOU. Reabrir nos créditos e não do começo é o defeito clássico
    a marca é de outro   caminho igual, arquivo trocado — a marca velha manda para o lugar errado

O disco está fora daqui: as funções recebem o diretório, e os testes usam um temporário.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from retomar import (  # noqa: E402
    e_marca_de_video, esquecer, lembrar, marca_de_video, retomada, todas,
)

FILME = "/home/ana/Vídeos/o filme.mkv"


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="palco-retomar-")


class TestLembrar(Base):
    def test_o_meio_do_filme_e_lembrado(self):
        lembrar(self.dir, FILME, 2400, 3600)
        self.assertEqual(retomada(self.dir, FILME), 2400)

    def test_o_comeco_NAO_e_lembrado(self):
        # Abrir, ver oito segundos e fechar não é "assistir". Retomar ali põe uma faixa de
        # "continuando de 0:08" na frente de quem vai começar do zero de qualquer jeito.
        lembrar(self.dir, FILME, 8, 3600)
        self.assertIsNone(retomada(self.dir, FILME))

    def test_o_FIM_apaga_a_marca_em_vez_de_gravar(self):
        # ⚠ O defeito clássico, e o mais irritante: a pessoa termina o filme, reabre semanas
        # depois, e cai nos créditos. Terminar é o mesmo que não ter marca — e apagar é diferente
        # de só não gravar, porque havia uma marca do meio da sessão anterior.
        lembrar(self.dir, FILME, 1800, 3600)
        lembrar(self.dir, FILME, 3595, 3600)
        self.assertIsNone(retomada(self.dir, FILME),
                          "reabriria nos créditos em vez do começo")

    def test_o_fim_de_um_clipe_curto_tambem_conta(self):
        # A regra é proporcional E absoluta: 95% de um clipe de 40 s são 38 s, mas 95% de um filme
        # de 2 h ainda deixa 6 minutos — que é filme, e não crédito.
        lembrar(self.dir, FILME, 39, 40)
        self.assertIsNone(retomada(self.dir, FILME))
        lembrar(self.dir, FILME, 6900, 7200)     # faltam 5 min de um filme de 2 h
        self.assertEqual(retomada(self.dir, FILME), 6900)

    def test_sem_duracao_conhecida_ainda_da_para_lembrar(self):
        # Um fluxo que o servidor está mesclando pode não ter duração no primeiro instante. A
        # regra do fim não se aplica; a do começo sim.
        lembrar(self.dir, FILME, 2400, None)
        self.assertEqual(retomada(self.dir, FILME), 2400)


class TestIdentidade(Base):
    def test_arquivo_TROCADO_no_mesmo_caminho_nao_retoma(self):
        # ⚠ `~/Vídeos/aula.mkv` é um nome que se reusa. Sem conferir tamanho e data, a marca da
        # aula passada manda a aula nova começar aos 40 min — e a pessoa acha que baixou o arquivo
        # errado. O par (tamanho, mtime) é o que o gerenciador de arquivos já usa para dizer
        # "mudou", e é barato.
        lembrar(self.dir, FILME, 2400, 3600, assinatura="1234:99")
        self.assertEqual(retomada(self.dir, FILME, assinatura="1234:99"), 2400)
        self.assertIsNone(retomada(self.dir, FILME, assinatura="5678:100"))

    def test_marca_sem_assinatura_continua_valendo(self):
        # Compatibilidade com o que já foi gravado: uma marca antiga não some porque o campo nasceu
        # depois. Perder o histórico de alguém para estrear uma checagem é caro demais.
        lembrar(self.dir, FILME, 2400, 3600)
        self.assertEqual(retomada(self.dir, FILME, assinatura="1234:99"), 2400)


class TestPersistencia(Base):
    def test_a_marca_sobrevive_ao_processo(self):
        # É a razão de isto ir para o disco e não para a memória: o app morre quando a janela
        # fecha, e a marca tem de estar lá amanhã.
        lembrar(self.dir, FILME, 2400, 3600)
        self.assertEqual(retomada(self.dir, FILME), 2400)   # releitura do arquivo

    def test_esquecer_apaga_uma_so(self):
        lembrar(self.dir, FILME, 2400, 3600)
        lembrar(self.dir, "/outro.mp4", 100, 3600)
        esquecer(self.dir, FILME)
        self.assertIsNone(retomada(self.dir, FILME))
        self.assertEqual(retomada(self.dir, "/outro.mp4"), 100)

    def test_a_lista_nao_cresce_para_sempre(self):
        # ⚠ Sem poda, o arquivo cresce a cada vídeo aberto, para sempre, e um dia alguém abre um
        # JSON de dezenas de MB a cada requisição. A poda é por recência: o que interessa é o que
        # se estava assistindo.
        for i in range(400):
            lembrar(self.dir, f"/v/{i}.mkv", 600, 3600)
        guardadas = todas(self.dir)
        self.assertLessEqual(len(guardadas), 200)
        self.assertIn("/v/399.mkv", guardadas, "podou o mais RECENTE, que é o que importa")
        self.assertNotIn("/v/0.mkv", guardadas)


class TestNaoDerrubar(Base):
    def test_arquivo_de_marcas_corrompido_nao_impede_de_assistir(self):
        # ⚠ Um JSON truncado (disco cheio, processo morto no meio da escrita) não pode virar 500
        # numa tela de vídeo. Perder as marcas é chato; não conseguir abrir o filme é outra coisa.
        with open(os.path.join(self.dir, "retomadas.json"), "w", encoding="utf-8") as fh:
            fh.write('{"/x.mkv": {"seg')
        self.assertIsNone(retomada(self.dir, FILME))
        lembrar(self.dir, FILME, 2400, 3600)
        self.assertEqual(retomada(self.dir, FILME), 2400, "e a gravação seguinte conserta")

    def test_diretorio_inexistente_e_criado(self):
        alvo = os.path.join(self.dir, "que", "nao", "existe")
        lembrar(alvo, FILME, 2400, 3600)
        self.assertEqual(retomada(alvo, FILME), 2400)


class TestAChaveDeUmVideoDoYoutube(Base):
    """Uma marca de vídeo do YouTube mora na MESMA tabela de um arquivo, sob um prefixo.

    ⚠ Repetir, esquecer e o teto de entradas já existem e funcionam; uma segunda tabela duplicaria
    os três para ganhar nada — "onde parei" é a mesma pergunta.
    """

    def test_a_chave_NAO_se_confunde_com_um_caminho(self):
        # ⚠ Sem prefixo, `dQw4w9WgXcQ` é indistinguível de um caminho relativo — e `assinatura_de`
        # passaria a ser chamada sobre ele, `esquecer` deixaria de saber o que apaga, e um dia
        # alguém escreveria uma regra por caminho que pegaria vídeos por acidente.
        chave = marca_de_video("dQw4w9WgXcQ")
        self.assertTrue(e_marca_de_video(chave))
        self.assertNotEqual(chave, "dQw4w9WgXcQ")
        for caminho in (FILME, "/home/ana/Vídeos/aula.mkv", "aula.mkv", "C:\\v\\a.mkv"):
            self.assertFalse(e_marca_de_video(caminho), caminho)

    def test_dois_videos_diferentes_nao_compartilham_marca(self):
        self.assertNotEqual(marca_de_video("aaaaaaaaaaa"), marca_de_video("bbbbbbbbbbb"))

    def test_a_marca_de_video_percorre_o_mesmo_caminho_de_um_arquivo(self):
        chave = marca_de_video("dQw4w9WgXcQ")
        lembrar(self.dir, chave, 300, 1800)
        self.assertEqual(retomada(self.dir, chave), 300)
        # E terminar apaga, como em qualquer outro: reabrir nos créditos é o defeito clássico.
        lembrar(self.dir, chave, 1795, 1800)
        self.assertIsNone(retomada(self.dir, chave))

    def test_e_marca_de_video_recusa_o_que_nao_e_texto(self):
        for lixo in (None, 0, [], {}):
            self.assertFalse(e_marca_de_video(lixo))


if __name__ == "__main__":
    unittest.main()
