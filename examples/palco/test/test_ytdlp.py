"""A ordem de busca do yt-dlp, que é o que decide se a atualização funciona.

⚠ **O defeito que este arquivo existe para impedir não produz erro nenhum.** Se `vendor/py` vier
antes de `$VSSH_APP_DATA_DIR/ytdlp`, o botão de atualizar diz "atualizado", o diretório tem a versão
nova, o download aparece bem-sucedido no log — e o `import` continua trazendo a versão velha. O
`/healthz` reporta a antiga, e quem investiga vê tudo funcionando e o app quebrado.

É uma linha de código e um diagnóstico caro. Por isso a ordem é uma função pura, e tem teste.
"""

import os
import sys
import tempfile
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "backend"))

from ytdlp import Mundo, caminhos_de_busca, carregar, versao  # noqa: E402


class TestAOrdemDeBusca(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = self.tmp.name
        self.dados = os.path.join(self.raiz, "dados")
        self.vendor = os.path.join(self.raiz, "vendor", "py")
        os.makedirs(os.path.join(self.dados, "ytdlp"))
        os.makedirs(self.vendor)
        self.addCleanup(self.tmp.cleanup)

    def test_o_gravavel_vem_ANTES_do_instalado(self):
        # A asserção que dá sentido ao arquivo inteiro.
        c = caminhos_de_busca(self.dados, self.vendor)
        self.assertEqual(len(c), 2)
        self.assertTrue(c[0].endswith(os.path.join("dados", "ytdlp")),
                        f"o diretório gravável não veio primeiro: {c}")
        self.assertTrue(c[1].endswith(os.path.join("vendor", "py")))

    def test_diretorio_que_nao_existe_nao_entra(self):
        # Antes da primeira atualização não há `dados/ytdlp`. Um caminho inexistente no `sys.path`
        # não quebra o import, mas suja o diagnóstico de quem for ver por que algo não carrega.
        c = caminhos_de_busca(os.path.join(self.raiz, "nao-existe"), self.vendor)
        self.assertEqual(len(c), 1)
        self.assertTrue(c[0].endswith(os.path.join("vendor", "py")))

    def test_sem_nada_a_lista_e_vazia(self):
        self.assertEqual(caminhos_de_busca(None, None), [])
        self.assertEqual(caminhos_de_busca("", ""), [])

    def test_os_caminhos_sao_absolutos(self):
        # ⚠ O `sys.path` é resolvido contra o diretório de trabalho ATUAL, e o do processo de um app
        # não é garantido. Um caminho relativo aqui funcionaria na máquina de quem escreve e
        # falharia no servidor, que é a fronteira que já custou caro duas vezes neste projeto.
        for c in caminhos_de_busca(self.dados, self.vendor):
            self.assertTrue(os.path.isabs(c), c)

    def test_o_mesmo_diretorio_duas_vezes_entra_uma(self):
        # Uma instalação onde os dois apontam para o mesmo lugar. Duplicar no `sys.path` não quebra
        # nada, mas confunde quem for diagnosticar de onde o import veio.
        c = caminhos_de_busca(self.dados, os.path.join(self.dados, "ytdlp"))
        self.assertEqual(len(c), 1, c)


class TestCarregar(unittest.TestCase):
    def test_sem_yt_dlp_devolve_None_e_nao_derruba_o_app(self):
        # ⚠ Sem yt-dlp o Palco continua sendo um player local completo. Levantar aqui trocaria um
        # recurso ausente por um app ausente — e a aba do YouTube talvez ninguém abra.
        def sem(nome):
            raise ImportError(nome)
        self.assertIsNone(carregar(caminhos=[], importar=sem))

    def test_com_yt_dlp_devolve_o_modulo(self):
        falso = type("m", (), {"version": type("v", (), {"__version__": "2026.07.04"})})
        self.assertIs(carregar(caminhos=[], importar=lambda n: falso), falso)
        self.assertEqual(versao(falso), "2026.07.04")

    def test_versao_de_um_modulo_sem_version_nao_lanca(self):
        # O `/healthz` não pode cair por causa de um atributo que uma versão do yt-dlp mudou.
        self.assertIsNone(versao(type("m", (), {})))


class TestOMundo(unittest.TestCase):
    def test_ler_cabecalho_insiste_ate_juntar_os_bytes(self):
        # ⚠ `read(n)` devolve o que CHEGOU, não o que foi pedido. Num pipe de rede é comum vir em
        # pedaços, e um cabeçalho curto faz `ranges_do_cabecalho` responder `None`: a trilha some do
        # manifesto e a qualidade cai sem uma linha no log dizendo por quê.
        pedidos = []

        class Resposta:
            def __init__(self):
                self.restante = [b"a" * 100, b"b" * 100, b"c" * 60]

            def read(self, n):
                pedidos.append(n)
                return self.restante.pop(0) if self.restante else b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        import ytdlp
        original = ytdlp.urlopen
        ytdlp.urlopen = lambda req, timeout=None: Resposta()
        try:
            dados = Mundo(None).ler_cabecalho("https://x/", {}, 260)
        finally:
            ytdlp.urlopen = original

        self.assertEqual(len(dados), 260, f"juntou só {len(dados)}; pedidos: {pedidos}")
        self.assertEqual(pedidos, [260, 160, 60], "não pediu o que ainda faltava")

    def test_ler_cabecalho_para_quando_a_conexao_acaba(self):
        # Um arquivo menor que o cabeçalho pedido, ou uma conexão cortada. Sem esta saída o laço
        # rodaria para sempre pedindo bytes que não virão.
        class Resposta:
            def read(self, n):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        import ytdlp
        original = ytdlp.urlopen
        ytdlp.urlopen = lambda req, timeout=None: Resposta()
        try:
            self.assertEqual(Mundo(None).ler_cabecalho("https://x/", {}, 4096), b"")
        finally:
            ytdlp.urlopen = original

    def test_ler_cabecalho_manda_o_Range_e_os_cabecalhos_da_credencial(self):
        # Sem o `Range` o servidor manda o arquivo inteiro — megabytes por formato, dezoito vezes,
        # para ler 4 KB de cada. E sem os cabeçalhos do yt-dlp a credencial pode ser recusada.
        vistos = {}

        class Resposta:
            def read(self, n):
                return b"x" * n

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def falso_urlopen(req, timeout=None):
            vistos["range"] = req.get_header("Range")
            vistos["ua"] = req.get_header("User-agent")
            return Resposta()

        import ytdlp
        original = ytdlp.urlopen
        ytdlp.urlopen = falso_urlopen
        try:
            Mundo(None).ler_cabecalho("https://x/", {"User-Agent": "duble/1"}, 4096)
        finally:
            ytdlp.urlopen = original

        self.assertEqual(vistos["range"], "bytes=0-4095")
        self.assertEqual(vistos["ua"], "duble/1")

    def test_extrair_desliga_a_playlist(self):
        # ⚠ Sem `noplaylist`, uma URL com `&list=` faz o yt-dlp resolver a lista INTEIRA — dezenas
        # de chamadas de rede para abrir um vídeo. A fila é assunto de outra rota.
        vistas = {}

        class YDL:
            def __init__(self, opcoes):
                vistas.update(opcoes)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def extract_info(self, url, download=False):
                vistas["url"] = url
                return {"id": "x"}

        modulo = type("m", (), {"YoutubeDL": YDL})
        Mundo(modulo).extrair("https://www.youtube.com/watch?v=x&list=PL1")
        self.assertTrue(vistas.get("noplaylist"))
        self.assertTrue(vistas.get("skip_download"))


if __name__ == "__main__":
    unittest.main()
