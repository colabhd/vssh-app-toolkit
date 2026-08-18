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

from listas import url_de_listagem  # noqa: E402
from pasta import EXTENSOES  # noqa: E402
from urls import analisar  # noqa: E402

with open(os.path.join(_AQUI, "..", "vssh-app.json"), encoding="utf-8") as _fh:
    MANIFESTO = json.load(_fh)


class TestAVersaoQueOAppRePORTA(unittest.TestCase):
    """O `/healthz` diz a versão do pacote INSTALADO, e ela sai deste arquivo.

    ⚠ A pergunta "isto que estou vendo é o conserto de ontem?" não tinha resposta, e sem resposta
    um app velho e um conserto que não funcionou são indistinguíveis — que é a mesma fronteira da
    tag `v4`, e custou uma sessão inteira de investigação. O `--version` do CI reescreve este campo
    no manifesto empacotado, então o número aqui é o número publicado.
    """

    def test_o_manifesto_esta_onde_o_main_o_procura(self):
        # `main.py` lê `os.path.join(<backend>, "..", "vssh-app.json")`. Mover um dos dois faz o
        # `/healthz` reportar `?` para sempre, sem erro nenhum — e é exatamente nesse momento que
        # alguém precisaria dele.
        do_main = os.path.join(_AQUI, "..", "backend", "..", "vssh-app.json")
        self.assertTrue(os.path.isfile(do_main), do_main)

    def test_a_version_tem_a_forma_que_o_CI_reescreve(self):
        # O `publish-apps.yml` deriva `<maior>.<menor>.<contagem de commits>` do que está aqui, e
        # recusa a publicação se o começo não casar `\d+\.\d+`.
        self.assertRegex(MANIFESTO.get("version", ""), r"^\d+\.\d+(\.|$)")


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

    def test_o_yt_dlp_e_INSTALADO_e_no_mesmo_lugar_que_o_toolkit(self):
        # ⚠ Sem esta linha o app instala inteiro, abre, toca arquivo local — e a aba do YouTube
        # responde 503 para sempre, sem que nada na instalação tenha falhado. O código trata a
        # ausência com elegância justamente para uma instalação ANTIGA sobreviver; para uma
        # instalação nova, ausência é defeito.
        cmd = MANIFESTO["backend"]["installCommand"]
        self.assertIn("yt-dlp", cmd)
        self.assertIn("--target vendor/py", cmd,
                      "o yt-dlp tem de cair no mesmo lugar de onde `ytdlp.py` o procura")

    def test_o_rebuild_continua_sendo_o_jeito_de_atualizar_as_libs(self):
        # O `installCommand` pula quando `vendor/py` já existe — é o que faz reinstalar ser barato.
        # A consequência é que uma instalação existente NÃO pega libs novas sem
        # `VSSH_APP_REBUILD=1`, e isso já foi o defeito de classe do primeiro dia.
        cmd = MANIFESTO["backend"]["installCommand"]
        self.assertIn("VSSH_APP_REBUILD", cmd)
        self.assertIn("test -d vendor/py", cmd)


class TestOrdemDasFases(unittest.TestCase):
    """⚠ Este teste virou o seu contrário, e o texto anterior fica registrado porque a regra é a
    mesma: no instante em que `opens.urls` existe, TODO link do YouTube passa a chegar aqui —
    playlist, canal, busca, ao vivo, `/shorts`. Se a interface não cobre todos, a pessoa clica num
    link e chega num beco, e o roteamento fica PIOR do que não existir.

    Ele vetava `opens.urls` até `frontend/youtube.js` aparecer. A aba existe; agora ele EXIGE os
    hosts, e confere que `urls.py` e o manifesto casam — porque a divergência entre os dois é
    silenciosa dos dois lados: um host no manifesto que o `urls.py` recusa devolve tudo ao
    navegador (o roteamento existe e não faz nada), e um host que o `urls.py` aceita sem estar no
    manifesto nunca chega (o código existe e não roda).
    """

    def test_a_aba_do_YouTube_existe(self):
        # O piso do teste abaixo: exigir `opens.urls` sem a aba seria exigir o beco.
        self.assertTrue(os.path.exists(os.path.join(_AQUI, "..", "frontend", "youtube.js")),
                        "`opens.urls` está declarado e a aba sumiu")

    def test_os_hosts_do_manifesto_sao_os_MESMOS_que_o_urls_py_aceita(self):
        declarados = set(MANIFESTO["opens"].get("urls") or [])
        self.assertTrue(declarados, "o roteamento de link não foi ligado")

        # `analisar` é a autoridade sobre "é meu". Todo host declarado tem de passar por ela, e
        # nenhum host vizinho pode passar.
        for host in declarados:
            nu = host.removeprefix("*.")
            # ⚠ A forma canônica depende do host: em `youtu.be` o id é o CAMINHO, e um
            # `youtu.be/watch?v=…` é um endereço que não existe. A primeira versão deste teste
            # montava `/watch?v=` para todos e reprovou — corretamente, e por um motivo que não
            # era o que ela queria medir.
            url = (f"https://{nu}/dQw4w9WgXcQ" if nu == "youtu.be"
                   else f"https://{nu}/watch?v=dQw4w9WgXcQ")
            self.assertIsNotNone(analisar(url),
                                 f"o manifesto declara {host} e o urls.py recusa {url}")

        # ⚠ E o engano clássico, do outro lado: `'evilyoutube.com'.endswith('youtube.com')` é
        # `True`. O schema recusa esse casamento por sufixo, e o `urls.py` também — este teste
        # existe para que os dois continuem recusando juntos.
        for vizinho in ("evilyoutube.com", "youtube.com.br", "notyoutu.be"):
            self.assertIsNone(analisar(f"https://{vizinho}/watch?v=dQw4w9WgXcQ"), vizinho)

    def test_TODA_forma_de_endereco_que_o_urls_py_aceita_tem_uma_TELA(self):
        # ⚠ A régua de "o deeplink não vira beco", mecânica. Cada linha é uma forma que chega por
        # link, e o que ela precisa que exista do outro lado.
        casos = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "video"),
            ("https://youtu.be/dQw4w9WgXcQ?t=90", "video"),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "video"),
            ("https://www.youtube.com/live/dQw4w9WgXcQ", "video"),
            ("https://www.youtube.com/playlist?list=PLabc123", "playlist"),
            ("https://www.youtube.com/@fulano", "canal"),
            ("https://www.youtube.com/channel/UCabc123", "canal"),
            ("https://www.youtube.com/c/Fulano", "canal"),
            ("https://www.youtube.com/user/Fulano", "canal"),
            ("https://www.youtube.com/results?search_query=gatos", "busca"),
            ("https://www.youtube.com/", "inicio"),
        ]
        for url, tipo in casos:
            alvo = analisar(url)
            self.assertIsNotNone(alvo, url)
            self.assertEqual(alvo.tipo, tipo, url)
            if tipo in ("playlist", "canal", "busca"):
                # Listagem: tem de virar um pedido ao yt-dlp, senão a aba abre vazia.
                self.assertIsNotNone(url_de_listagem(alvo), f"{url} não vira listagem")

    def test_o_que_exige_LOGIN_continua_voltando_para_o_navegador(self):
        # A outra metade da honestidade: o que não dá para mostrar sem autenticar não é
        # reivindicado. Montar uma casca vazia seria pior que devolver o link.
        for url in ("https://www.youtube.com/feed/subscriptions",
                    "https://www.youtube.com/playlist?list=WL",
                    "https://www.youtube.com/playlist?list=LL"):
            self.assertIsNone(analisar(url), url)


if __name__ == "__main__":
    unittest.main()
