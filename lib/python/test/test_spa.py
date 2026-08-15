"""O static-spa: carimbo de conteúdo, confinamento e mounts.

Espelha `lib/node/test/static-spa.test.js`. Cada teste aqui corresponde a um defeito que já
aconteceu — em especial o primeiro, que custou uma depuração inteira: shim atualizado, arquivo em
disco CERTO, e o navegador executando o antigo.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vssh_app_toolkit.spa import criar_spa_estatica  # noqa: E402


class HandlerFalso:
    """O mínimo de `BaseHTTPRequestHandler` que a lib toca.

    De mentira, e não um servidor de verdade, porque o que se mede aqui é a DECISÃO (status,
    cabeçalho, corpo) — subir socket para isso mediria o socket.
    """

    def __init__(self, caminho, command="GET", headers=None):
        self.path = caminho
        self.command = command
        self.headers = headers or {}
        self.status = None
        self.cabecalhos = {}
        self.corpo = b""
        self.wfile = self

    def send_response(self, status):
        self.status = status

    def send_header(self, k, v):
        self.cabecalhos[k] = v

    def end_headers(self):
        pass

    def write(self, dados):
        self.corpo += dados

    def flush(self):
        pass


class BaseSpa(unittest.TestCase):
    def setUp(self):
        self.raiz = tempfile.mkdtemp(prefix="vssh-spa-")
        self.escrever("index.html", "<html><head></head><body>oi</body></html>")

    def escrever(self, rel, texto):
        caminho = os.path.join(self.raiz, rel)
        os.makedirs(os.path.dirname(caminho), exist_ok=True)
        with open(caminho, "w", encoding="utf-8") as fh:
            fh.write(texto)
        return caminho


class TestCarimbo(BaseSpa):
    def test_o_script_injetado_sai_com_o_hash_do_CONTEUDO(self):
        self.escrever("boot.js", "console.log(1)")
        servir = criar_spa_estatica(root=self.raiz, inject_scripts=["boot.js"])
        h = HandlerFalso("/")
        self.assertTrue(servir(h))
        corpo = h.corpo.decode("utf-8")
        self.assertRegex(corpo, r'<script src="boot\.js\?v=[0-9a-f]{12}"></script>')
        self.assertIn("</head>", corpo)
        # ANTES do `</head>`: o script de boot precisa executar antes dos scripts diferidos do
        # bundle, que já esperam o parse.
        self.assertLess(corpo.index("<script"), corpo.index("</head>"))

    def test_mudar_o_shim_troca_a_URL_sem_tocar_no_index(self):
        # É o cenário exato do defeito: atualizar a lib mexe no pacote instalado, nunca no index.
        # Se o carimbo não entrasse na CHAVE do cache do index, o processo seguiria servindo a URL
        # velha até alguém tocar no HTML.
        self.escrever("boot.js", "window.vssh = { audio: undefined }")
        servir = criar_spa_estatica(root=self.raiz, inject_scripts=["boot.js"])
        antes = HandlerFalso("/")
        servir(antes)

        self.escrever("boot.js", "window.vssh = { audio: {} }")
        depois = HandlerFalso("/")
        servir(depois)
        self.assertNotEqual(antes.corpo, depois.corpo)

    def test_reinstalar_a_MESMA_versao_mantem_a_URL(self):
        # O carimbo sai do conteúdo, não da data: senão todo deploy invalidaria tudo à toa, e a
        # primeira coisa que alguém faria seria desligá-lo.
        caminho = self.escrever("boot.js", "window.vssh = 1")
        servir = criar_spa_estatica(root=self.raiz, inject_scripts=["boot.js"])
        antes = HandlerFalso("/")
        servir(antes)

        # Mesmos bytes, mtime novo.
        st = os.stat(caminho)
        self.escrever("boot.js", "window.vssh = 1")
        os.utime(caminho, ns=(st.st_atime_ns + 10**9, st.st_mtime_ns + 10**9))
        depois = HandlerFalso("/")
        servir(depois)
        self.assertEqual(antes.corpo, depois.corpo)

    def test_o_LIMITE_da_memoizacao_esta_aqui_e_e_conhecido(self):
        # Este teste afirma um LIMITE, não uma virtude — e ele existe para que o limite seja
        # encontrado por quem lê a bancada, e não por quem depura um servidor.
        #
        # O carimbo é memoizado por `(mtime, tamanho)`, exatamente como no lado Node. Uma
        # substituição que preserve os DOIS — mesmo número de bytes E mesmo mtime, o que um
        # `sed -i` num filesystem de baixa resolução de tempo consegue produzir — devolve o
        # carimbo antigo. É o preço de não reler o arquivo a cada requisição, e ele é pequeno:
        # uma instalação de verdade escreve arquivo novo, com mtime novo.
        caminho = self.escrever("boot.js", "console.log(1)")
        st = os.stat(caminho)
        servir = criar_spa_estatica(root=self.raiz, inject_scripts=["boot.js"])
        antes = HandlerFalso("/")
        servir(antes)

        self.escrever("boot.js", "console.log(2)")  # MESMO tamanho
        os.utime(caminho, ns=(st.st_atime_ns, st.st_mtime_ns))  # e mesmo mtime
        depois = HandlerFalso("/")
        servir(depois)
        self.assertEqual(antes.corpo, depois.corpo,
                         "se isto mudar, a memoização deixou de ser por (mtime, tamanho) — e o "
                         "custo por requisição mudou junto")

    def test_o_index_nao_e_cacheado_NUNCA(self):
        # O par necessário do carimbo: é o index que traz a URL nova. Cacheado, ele continuaria
        # apontando para a antiga, e o carimbo viraria enfeite.
        servir = criar_spa_estatica(root=self.raiz)
        h = HandlerFalso("/")
        servir(h)
        self.assertEqual(h.cabecalhos["Cache-Control"], "no-store")

    def test_carimbo_que_confere_ganha_immutable_e_o_que_nao_confere_nao(self):
        caminho = self.escrever("app.js", "conteudo")
        servir = criar_spa_estatica(root=self.raiz, inject_scripts=["app.js"])
        indice = HandlerFalso("/")
        servir(indice)
        import re

        v = re.search(r"app\.js\?v=([0-9a-f]{12})", indice.corpo.decode("utf-8")).group(1)

        certo = HandlerFalso(f"/app.js?v={v}")
        servir(certo)
        self.assertIn("immutable", certo.cabecalhos["Cache-Control"])

        # Carimbo velho — de um index que sobreviveu em algum cache — NÃO pode ganhar `immutable`,
        # senão fixaria os bytes errados por um ano.
        errado = HandlerFalso("/app.js?v=000000000000")
        servir(errado)
        self.assertEqual(errado.cabecalhos["Cache-Control"], "no-cache")
        self.assertTrue(os.path.exists(caminho))


class TestConfinamento(BaseSpa):
    def test_dois_pontos_nao_saem_da_raiz(self):
        fora = tempfile.mkdtemp(prefix="vssh-fora-")
        with open(os.path.join(fora, "segredo.txt"), "w") as fh:
            fh.write("nao pode sair")
        servir = criar_spa_estatica(root=self.raiz)
        h = HandlerFalso("/../" + os.path.basename(fora) + "/segredo.txt")
        # `False` = não atendeu, e 404 é decisão de quem compõe as rotas.
        self.assertFalse(servir(h))

    def test_diretorio_nao_e_servido(self):
        os.makedirs(os.path.join(self.raiz, "pasta"), exist_ok=True)
        servir = criar_spa_estatica(root=self.raiz)
        self.assertFalse(servir(HandlerFalso("/pasta")))


class TestMounts(BaseSpa):
    def test_serve_de_fora_da_raiz_pelo_prefixo(self):
        # É o que faz as libs de navegador funcionarem: elas moram no pacote instalado, fora da
        # raiz do frontend por construção.
        libs = tempfile.mkdtemp(prefix="vssh-libs-")
        with open(os.path.join(libs, "shim.js"), "w") as fh:
            fh.write("window.vssh = {}")
        servir = criar_spa_estatica(root=self.raiz, mounts={"/_vssh/": libs},
                                    inject_scripts=["_vssh/shim.js"])

        indice = HandlerFalso("/")
        servir(indice)
        self.assertRegex(indice.corpo.decode("utf-8"), r'_vssh/shim\.js\?v=[0-9a-f]{12}')

        # A tag injetada tem de ser SERVIDA por este mesmo handler — sem isso ela aponta para 404,
        # a página carrega inteira e o `vssh` simplesmente não existe, sem erro que ligue uma coisa
        # à outra. É o defeito clássico, e ele mora exatamente entre estas duas asserções.
        arquivo = HandlerFalso("/_vssh/shim.js")
        self.assertTrue(servir(arquivo))
        self.assertIn(b"window.vssh", arquivo.corpo)

    def test_prefixo_sem_barras_e_recusado_na_montagem(self):
        # `/_vsshX` casaria com `/_vssh` — e o erro apareceria como um arquivo servido de onde não
        # devia, muito longe daqui.
        with self.assertRaises(ValueError):
            criar_spa_estatica(root=self.raiz, mounts={"/_vssh": "/tmp"})


class TestFallback(BaseSpa):
    def test_rota_de_SPA_recebe_o_index_quando_ligado(self):
        servir = criar_spa_estatica(root=self.raiz, spa_fallback=True)
        h = HandlerFalso("/qualquer/rota", headers={"Accept": "text/html"})
        self.assertTrue(servir(h))
        self.assertIn(b"<html>", h.corpo)

    def test_um_fetch_que_erra_o_caminho_NAO_recebe_o_index(self):
        # Sem isto o app tentaria `JSON.parse` de HTML, e o erro apareceria longe da causa.
        servir = criar_spa_estatica(root=self.raiz, spa_fallback=True)
        self.assertFalse(servir(HandlerFalso("/api/x", headers={"Accept": "application/json"})))
        # E o que parece asset também não: extensão no último segmento é pedido de arquivo.
        self.assertFalse(servir(HandlerFalso("/js/faltando.js", headers={"Accept": "text/html"})))


class TestBundleAusente(BaseSpa):
    def test_diz_como_reconstruir_em_vez_de_500_mudo(self):
        vazio = tempfile.mkdtemp(prefix="vssh-vazio-")
        servir = criar_spa_estatica(root=vazio, missing_bundle_hint="Rode o build antes.")
        h = HandlerFalso("/")
        self.assertTrue(servir(h))
        self.assertEqual(h.status, 500)
        self.assertIn("Rode o build antes.", h.corpo.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
