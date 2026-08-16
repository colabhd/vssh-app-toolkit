"""O manifesto contra o código — as duas verdades que precisam continuar sendo uma.

O `vssh-app.json` não é documentação: é o que o AMBIENTE lê para decidir o que mandar para cá. Ele
e o backend descrevem o mesmo fato por dois caminhos que ninguém percorre junto, e quando divergem
não há erro nenhum — só uma janela que abre e não toca.

⚠ E este arquivo guarda uma decisão de ORDEM que, sem ele, seria só uma nota num plano: o Palco não
pode declarar `opens.urls` antes de a aba do YouTube dar conta de toda forma de endereço. Um plano
esquece; um teste não.
"""

import json
import os
import sys
import unittest

_AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_AQUI, "..", "backend"))

from pasta import EXTENSOES  # noqa: E402

with open(os.path.join(_AQUI, "..", "vssh-app.json"), encoding="utf-8") as _fh:
    MANIFESTO = json.load(_fh)


class TestOQueOAmbienteVaiMandar(unittest.TestCase):
    def test_o_manifesto_e_o_codigo_abrem_as_MESMAS_extensoes(self):
        # ⚠ A divergência é silenciosa nos dois sentidos, e as duas doem:
        #
        #   só no manifesto   o ambiente oferece o Palco no "Abrir com" de um `.wmv`, a janela abre,
        #                     e a lista de vizinhos não mostra o arquivo que está tocando;
        #   só no código      o Palco toca o formato e ninguém consegue chegar nele pelo ambiente.
        do_manifesto = {"." + e.lstrip(".").lower() for e in MANIFESTO["opens"]["extensions"]}
        self.assertEqual(do_manifesto, EXTENSOES)

    def test_o_ponto_de_entrada_existe(self):
        # Um `entrypoint` errado instala limpo e falha no healthcheck, com a mensagem "o app não
        # subiu" — que não aponta para uma letra trocada num caminho.
        alvo = os.path.join(_AQUI, "..", MANIFESTO["backend"]["entrypoint"])
        self.assertTrue(os.path.isfile(alvo), MANIFESTO["backend"]["entrypoint"])

    def test_o_icone_existe_e_ESCALA(self):
        # ⚠ Duas coisas, e nenhuma reclama sozinha. Um `icon` apontando para arquivo que não
        # existe publica limpo e o app aparece sem ícone — indistinguível de não ter declarado.
        # E um SVG sem `viewBox` não escala: o ambiente o desenha a 22px, 42px e 48px, e sem a
        # caixa ele sai cortado em dois dos três lugares.
        rel = MANIFESTO.get("icon")
        self.assertTrue(rel, "o manifesto não declara ícone")
        alvo = os.path.join(_AQUI, "..", rel)
        self.assertTrue(os.path.isfile(alvo), rel)
        with open(alvo, encoding="utf-8") as fh:
            svg = fh.read()
        self.assertIn("viewBox", svg)
        # ⚠ Sem `<text>`: a fonte depende da máquina que RENDERIZA, e o ícone de um app não pode
        # mudar de desenho — nem sumir — porque um servidor não tem a família declarada.
        self.assertNotIn("<text", svg)

    def test_o_ffmpeg_e_DECLARADO(self):
        # Sem ele instalado no servidor, tudo que não seja o modo direto falha — e falha no meio de
        # um vídeo, não na instalação. `requiredPackages` é o que move o erro para onde ele se
        # resolve.
        self.assertIn("ffmpeg", MANIFESTO.get("requiredPackages", []))


class TestOrdemDasFases(unittest.TestCase):
    def test_o_Palco_NAO_declara_urls_antes_de_ter_a_aba_do_YouTube(self):
        # ⚠ A regra que este teste torna mecânica: no instante em que `opens.urls` existe, todo
        # link do YouTube passa a chegar aqui — playlist, canal, busca, ao vivo, `/shorts`. Se a
        # aba não cobre todos, a pessoa clica num link e chega num beco, e o roteamento ficou PIOR
        # do que não existir.
        #
        # Ligar isto é da Fase 5, junto com a aba. Quando ela existir, este teste vira o seu
        # contrário: passa a EXIGIR os hosts, e a lista abaixo deixa de ser um veto e vira a
        # conferência de que `urls.py` e o manifesto casam.
        self.assertNotIn("urls", MANIFESTO["opens"],
                         "o roteamento de link foi ligado antes de a aba do YouTube existir")
        self.assertFalse(
            os.path.exists(os.path.join(_AQUI, "..", "frontend", "youtube.js")),
            "a aba do YouTube apareceu — atualize este teste para exigir `opens.urls`")


if __name__ == "__main__":
    unittest.main()
