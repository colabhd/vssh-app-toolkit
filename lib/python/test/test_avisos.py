"""As três vozes de um app sem janela: notificação, atividade e bandeja.

Espelha `lib/node/test/vssh-notify.test.js` e `vssh-live.test.js`. As três escrevem ARQUIVO que o
portal lê, e é aí que moram os defeitos silenciosos: um id errado faz a notificação sumir ou
repetir; um `at` que não renova faz a barra desaparecer no meio; uma escrita não-atômica faz o
poll ler JSON pela metade.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vssh_app_toolkit.live import (  # noqa: E402
    caminho_do_live,
    definir_live,
    limpar_live,
)
from vssh_app_toolkit.notify import caminho_do_journal, notificar  # noqa: E402
from vssh_app_toolkit.tray import (  # noqa: E402
    caminho_da_bandeja,
    definir_bandeja,
    limpar_bandeja,
)


class BaseCasa(unittest.TestCase):
    def setUp(self):
        self.casa = tempfile.mkdtemp(prefix="vssh-casa-")
        self.env = {"HOME": self.casa, "VSSH_APP_ID": "meu-app"}


class TestNotify(BaseCasa):
    def linhas(self):
        with open(caminho_do_journal(self.env), encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def test_escreve_uma_linha_NDJSON_no_journal_do_usuario(self):
        # Do USUÁRIO, e não do app: um arquivo só, com todos os apps dele dentro — é o que permite
        # ao portal ler tudo num exec por usuário, em vez de um glob por app.
        ident = notificar("Backup concluído", title="Backup", level="success", env=self.env)
        self.assertTrue(ident.startswith("meu-app:"))
        (linha,) = self.linhas()
        self.assertEqual(linha["body"], "Backup concluído")
        self.assertEqual(linha["level"], "success")
        self.assertEqual(linha["appId"], "meu-app")

    def test_sem_chave_cada_chamada_e_um_evento_NOVO(self):
        a = notificar("um", env=self.env)
        b = notificar("dois", env=self.env)
        self.assertNotEqual(a, b)

    def test_com_chave_o_id_e_ESTAVEL_e_o_usuario_e_avisado_uma_vez(self):
        # O portal manda uma JANELA do fim do arquivo, não um delta — quem impede o mesmo aviso de
        # chegar a cada tick é o id.
        a = notificar("Disco cheio", chave="disco-2026-08-15", env=self.env)
        b = notificar("Disco cheio", chave="disco-2026-08-15", env=self.env)
        self.assertEqual(a, b)

    def test_a_chave_vira_id_LEGIVEL_quando_da(self):
        # Um journal é lido por gente: `meu-app:disco-cheio` responde mais que um sha1.
        self.assertEqual(notificar("x", chave="disco-cheio", env=self.env), "meu-app:disco-cheio")

    def test_chave_impronunciavel_vira_hash_em_vez_de_lixo(self):
        ident = notificar("x", chave="///", env=self.env)
        self.assertRegex(ident, r"^meu-app:[0-9a-f]{16}$")

    def test_corpo_de_varias_linhas_continua_UMA_entrada(self):
        # É assim que um formato de linha se corrompe com dado VÁLIDO.
        notificar("linha um\nlinha dois", env=self.env)
        (linha,) = self.linhas()
        self.assertEqual(linha["body"], "linha um\nlinha dois")

    def test_acoes_e_a_rota_que_recebe_o_clique(self):
        # Sem `path`, um botão de notificação não teria para onde mandar a resposta — e o clique
        # pode acontecer com o app sem janela nenhuma.
        notificar("Reconstruir?", actions=[{"id": "sim", "label": "Reconstruir"}],
                  path="/api/acao", env=self.env)
        (linha,) = self.linhas()
        self.assertEqual(linha["actions"], [{"id": "sim", "label": "Reconstruir"}])
        self.assertEqual(linha["onAction"], {"path": "/api/acao"})

    def test_no_maximo_TRES_acoes(self):
        # A quarta viraria menu, e menu numa notificação ninguém abre.
        notificar("x", actions=[{"id": str(i), "label": str(i)} for i in range(6)], env=self.env)
        self.assertEqual(len(self.linhas()[0]["actions"]), 3)

    def test_nivel_invalido_e_DESCARTADO_em_vez_de_atravessar(self):
        notificar("x", level="urgentissimo", env=self.env)
        self.assertNotIn("level", self.linhas()[0])

    def test_sem_HOME_nao_levanta_e_devolve_None(self):
        # Um app tem trabalho de verdade a fazer, e ele não pode parar porque um aviso não coube.
        self.assertIsNone(notificar("x", env={}))


class TestLive(BaseCasa):
    def ler(self, chave):
        with open(caminho_do_live(chave, self.env), encoding="utf-8") as fh:
            return json.load(fh)

    def test_escreve_a_atividade_com_carimbo_de_tempo(self):
        # O `at` é OBRIGATÓRIO porque um arquivo `live` sobrevive a um `kill -9`: sem prazo de
        # validade, o primeiro processo que morrer no meio prega "Sincronizando 3 de 12" no painel
        # do usuário para sempre.
        self.assertTrue(definir_live("sync", {"titulo": "Sincronizando"}, env=self.env))
        corpo = self.ler("sync")
        self.assertEqual(corpo["titulo"], "Sincronizando")
        self.assertGreater(corpo["at"], 1_000_000_000_000)

    def test_a_mesma_chave_SUBSTITUI_no_lugar(self):
        # Relatar progresso vinte vezes não pode virar vinte linhas no painel de quem trabalha.
        definir_live("sync", {"texto": "1 de 9"}, env=self.env)
        definir_live("sync", {"texto": "2 de 9"}, env=self.env)
        self.assertEqual(self.ler("sync")["texto"], "2 de 9")
        pasta = os.path.dirname(caminho_do_live("sync", self.env))
        self.assertEqual([n for n in os.listdir(pasta) if n.endswith(".json")], ["sync.json"])

    def test_o_at_e_RENOVADO_a_cada_chamada(self):
        definir_live("sync", {"texto": "a"}, env=self.env)
        antes = self.ler("sync")["at"]
        definir_live("sync", {"texto": "b"}, env=self.env)
        self.assertGreaterEqual(self.ler("sync")["at"], antes)

    def test_limpar_SEM_registrar_nao_deixa_rastro(self):
        # É o certo para uma condição que deixou de valer: "o disco voltou" não é um fato que
        # alguém precise reler amanhã.
        definir_live("sync", {"texto": "a"}, env=self.env)
        limpar_live("sync", env=self.env)
        self.assertFalse(os.path.exists(caminho_do_live("sync", self.env)))
        self.assertFalse(os.path.exists(caminho_do_journal(self.env)))

    def test_limpar_COM_registrar_deixa_UMA_notificacao(self):
        definir_live("sync", {"texto": "a"}, env=self.env)
        limpar_live("sync", registrar={"titulo": "Pronto", "texto": "9 arquivos"}, env=self.env)
        self.assertFalse(os.path.exists(caminho_do_live("sync", self.env)))
        with open(caminho_do_journal(self.env), encoding="utf-8") as fh:
            linhas = [json.loads(l) for l in fh if l.strip()]
        self.assertEqual(len(linhas), 1)
        self.assertEqual(linhas[0]["title"], "Pronto")
        # `chave` estável na da atividade: um retry que termine de novo substitui, em vez de
        # empilhar dois "concluído" para a mesma coisa.
        self.assertEqual(linhas[0]["id"], "meu-app:live:sync")

    def test_chave_invalida_nao_escreve_arquivo_nenhum(self):
        # A mesma regra que o coletor aceita, conferida dos dois lados. Uma chave com barra viraria
        # um caminho, e é assim que uma lib de enfeite ganha uma escrita arbitrária.
        self.assertFalse(definir_live("../fuga", {"texto": "x"}, env=self.env))
        self.assertFalse(definir_live("com espaço", {"texto": "x"}, env=self.env))

    def test_sem_HOME_devolve_False_em_vez_de_levantar(self):
        self.assertFalse(definir_live("sync", {"texto": "x"}, env={}))


class TestTray(BaseCasa):
    def test_escreve_o_tray_json_ao_lado_do_status(self):
        env = dict(self.env, VSSH_APP_DATA_DIR=os.path.join(self.casa, ".vssh-apps", "meu-app", "data"))
        self.assertTrue(definir_bandeja({"icon": "refresh", "badge": {"count": 3}}, env=env))
        with open(caminho_da_bandeja(env), encoding="utf-8") as fh:
            corpo = json.load(fh)
        self.assertEqual(corpo["icon"], "refresh")
        self.assertEqual(corpo["badge"], {"count": 3})
        self.assertIn("updatedAt", corpo)
        # Um nível ACIMA do data dir: é o diretório que o coletor varre.
        self.assertTrue(caminho_da_bandeja(env).endswith(os.path.join("meu-app", "tray.json")))

    def test_sem_data_dir_cai_no_app_id(self):
        self.assertTrue(definir_bandeja({"icon": "x"}, env=self.env))
        self.assertTrue(os.path.exists(caminho_da_bandeja(self.env)))

    def test_definir_de_novo_SUBSTITUI_o_mesmo_icone(self):
        # O ícone não muda de lugar, que é o que importa quando o badge muda a cada segundo.
        definir_bandeja({"icon": "a"}, env=self.env)
        definir_bandeja({"icon": "b"}, env=self.env)
        with open(caminho_da_bandeja(self.env), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["icon"], "b")

    def test_a_escrita_e_ATOMICA_e_nao_deixa_tmp_para_tras(self):
        # Sem o rename atômico, o poll do portal pode ler o arquivo pela metade e descartá-lo como
        # JSON inválido — e o sintoma seria um ícone que pisca sob atualização frequente, que é
        # justamente quando ele importa.
        definir_bandeja({"icon": "a"}, env=self.env)
        pasta = os.path.dirname(caminho_da_bandeja(self.env))
        self.assertEqual([n for n in os.listdir(pasta) if n.endswith(".tmp")], [])

    def test_limpar_e_idempotente(self):
        definir_bandeja({"icon": "a"}, env=self.env)
        self.assertTrue(limpar_bandeja(self.env))
        self.assertTrue(limpar_bandeja(self.env))  # ícone já ausente é o estado pedido
        self.assertFalse(os.path.exists(caminho_da_bandeja(self.env)))

    def test_sem_lugar_para_escrever_devolve_False(self):
        self.assertFalse(definir_bandeja({"icon": "x"}, env={}))


if __name__ == "__main__":
    unittest.main()
