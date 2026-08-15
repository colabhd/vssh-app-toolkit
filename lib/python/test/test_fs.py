"""O filesystem privado: confinamento, errno classificado e o contrato de wire.

Espelha `lib/node/vssh-app-fs/test/`. O confinamento é a razão de a lib existir, e por isso ele é o
que tem mais testes: o modelo de ameaça não é usuário malicioso (o backend já roda como o próprio
usuário), é um bug de caminho do frontend virando escrita fora da raiz.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vssh_app_toolkit.fs import (  # noqa: E402
    EACCES,
    EINVAL,
    ENOENT,
    ErroFs,
    criar_fs_do_app,
    criar_handler_fs,
    token_confere,
)


class BaseFs(unittest.TestCase):
    def setUp(self):
        self.raiz = tempfile.mkdtemp(prefix="vssh-fs-")
        self.fs = criar_fs_do_app(root=self.raiz)


class TestConfinamento(BaseFs):
    def test_dois_pontos_nao_saem_da_raiz(self):
        with self.assertRaises(ErroFs) as ctx:
            self.fs.read_file("../../../../etc/passwd")
        self.assertEqual(ctx.exception.codigo, EACCES)

    def test_absoluto_de_fora_e_recusado(self):
        with self.assertRaises(ErroFs) as ctx:
            self.fs.read_file("/etc/passwd")
        self.assertEqual(ctx.exception.codigo, EACCES)

    def test_symlink_para_fora_nao_vaza_nem_por_LEITURA(self):
        # A checagem lexical sozinha deixaria isto passar: o caminho parece estar dentro. Por isso
        # o caminho REAL é revalidado — um link dentro da raiz apontando para fora vira caminho de
        # leitura (e de escrita) arbitrário para quem falar com este socket.
        fora = tempfile.mkdtemp(prefix="vssh-fora-")
        alvo = os.path.join(fora, "segredo.txt")
        with open(alvo, "w") as fh:
            fh.write("nao pode sair")
        link = os.path.join(self.raiz, "atalho.txt")
        try:
            os.symlink(alvo, link)
        except (OSError, NotImplementedError):
            self.skipTest("sem permissão para criar symlink")
        with self.assertRaises(ErroFs) as ctx:
            self.fs.read_file("atalho.txt")
        self.assertEqual(ctx.exception.codigo, EACCES)

    def test_byte_nulo_e_entrada_invalida(self):
        with self.assertRaises(ErroFs) as ctx:
            self.fs.stat("nota\0.txt")
        self.assertEqual(ctx.exception.codigo, EINVAL)

    def test_caminho_relativo_e_absoluto_dentro_da_raiz_valem_os_dois(self):
        self.fs.write_file("nota.txt", "oi")
        self.assertEqual(self.fs.read_file("nota.txt")["content"], "oi")
        self.assertEqual(self.fs.read_file(os.path.join(self.fs.root, "nota.txt"))["content"], "oi")


class TestOperacoes(BaseFs):
    def test_exists_responde_BOOLEANO_em_vez_de_erro(self):
        # "Existe?" é pergunta booleana. Quem só quer saber isso acabaria usando o erro do `stat`
        # como fluxo de controle, e aí toda sondagem de rotina vira ruído de erro nos dois lados.
        self.assertEqual(self.fs.exists("nao-tem.txt"), {"exists": False})
        self.fs.write_file("tem.txt", "x")
        self.assertEqual(self.fs.exists("tem.txt"), {"exists": True})

    def test_exists_FORA_da_raiz_continua_sendo_recusa(self):
        # Se existe ou não lá fora não é resposta que esta lib deva dar.
        with self.assertRaises(ErroFs) as ctx:
            self.fs.exists("/etc/passwd")
        self.assertEqual(ctx.exception.codigo, EACCES)

    def test_stat_de_inexistente_e_ENOENT_e_nao_um_erro_qualquer(self):
        with self.assertRaises(ErroFs) as ctx:
            self.fs.stat("nao-tem.txt")
        self.assertEqual(ctx.exception.codigo, ENOENT)

    def test_mtime_e_epoch_em_MILISSEGUNDOS(self):
        # Segundos aqui fariam toda comparação com o frontend errar por três ordens de grandeza.
        self.fs.write_file("nota.txt", "x")
        st = self.fs.stat("nota.txt")
        self.assertGreater(st["mtime"], 1_000_000_000_000)

    def test_escrever_por_cima_de_DIRETORIO_e_pedido_invalido_e_nao_defeito(self):
        # Sem esta checagem o open lança IsADirectoryError, que o transporte não sabe classificar e
        # devolve 500 — um pedido errado do cliente aparecendo como servidor quebrado.
        self.fs.mkdir_recur("pasta")
        with self.assertRaises(ErroFs) as ctx:
            self.fs.write_file("pasta", "x")
        self.assertEqual(ctx.exception.codigo, EINVAL)

    def test_write_cria_o_diretorio_pai(self):
        self.fs.write_file("a/b/c/nota.txt", "oi")
        self.assertEqual(self.fs.read_file("a/b/c/nota.txt")["content"], "oi")

    def test_write_de_BYTES_nao_passa_por_texto(self):
        # Texto-encodar bytes os corrompe, e o defeito só aparece quando alguém os grava de volta.
        self.fs.write_file("bin.dat", b"\xde\xad\xbe\xef")
        with open(os.path.join(self.fs.root, "bin.dat"), "rb") as fh:
            self.assertEqual(fh.read(), b"\xde\xad\xbe\xef")

    def test_mkdir_de_diretorio_existente_nao_e_erro(self):
        self.fs.mkdir("pasta")
        self.fs.mkdir("pasta")  # o estado pedido já vale

    def test_unlink_RECICLA_por_padrao(self):
        # Não apaga: move, com o caminho relativo achatado, para um "desfazer" continuar possível.
        self.fs.write_file("pasta/nota.txt", "oi")
        r = self.fs.unlink("pasta/nota.txt")
        self.assertTrue(r["recycled"].endswith("pasta_nota.txt"))
        self.assertFalse(os.path.exists(os.path.join(self.fs.root, "pasta", "nota.txt")))
        self.assertTrue(os.path.exists(r["recycled"]))

    def test_unlink_sem_reciclar_apaga_de_verdade(self):
        self.fs.write_file("cache.tmp", "x")
        self.assertEqual(self.fs.unlink("cache.tmp", reciclar=False), {"recycled": None})

    def test_unlink_do_que_nao_existe_e_ENOENT(self):
        with self.assertRaises(ErroFs) as ctx:
            self.fs.unlink("nao-tem.txt")
        self.assertEqual(ctx.exception.codigo, ENOENT)

    def test_readdir_nao_lista_symlink(self):
        self.fs.write_file("a.txt", "x")
        try:
            os.symlink("/etc/passwd", os.path.join(self.fs.root, "link.txt"))
        except (OSError, NotImplementedError):
            self.skipTest("sem permissão para criar symlink")
        listados = self.fs.readdir(".")
        self.assertTrue(any(p.endswith("a.txt") for p in listados))
        self.assertFalse(any(p.endswith("link.txt") for p in listados))

    def test_open_dir_omite_o_arquivo_grande_em_vez_de_lista_lo_VAZIO(self):
        # Listá-lo com conteúdo vazio é pior: para o app ele pareceria um arquivo vazio, e o
        # primeiro save por cima apagaria o conteúdo real no disco.
        fs = criar_fs_do_app(root=self.raiz, max_content_bytes=10)
        fs.write_file("grande.md", "x" * 100)
        fs.write_file("pequeno.md", "oi")
        nomes = [os.path.basename(f["path"]) for f in fs.open_dir(".")["files"]]
        self.assertIn("pequeno.md", nomes)
        self.assertNotIn("grande.md", nomes)


class HandlerFalso:
    def __init__(self, caminho, command="POST", corpo=b"", headers=None):
        self.path = caminho
        self.command = command
        self.headers = headers or {}
        self.headers.setdefault("Content-Length", str(len(corpo)))
        self.status = None
        self.cabecalhos = {}
        self.saida = b""
        self.wfile = self
        self.rfile = _Leitor(corpo)

    def send_response(self, s):
        self.status = s

    def send_header(self, k, v):
        self.cabecalhos[k] = v

    def end_headers(self):
        pass

    def write(self, d):
        self.saida += d

    def flush(self):
        pass

    def json(self):
        return json.loads(self.saida.decode("utf-8"))


class _Leitor:
    def __init__(self, dados):
        self._dados = dados

    def read(self, n):
        d, self._dados = self._dados[:n], self._dados[n:]
        return d


class TestWire(BaseFs):
    def _rpc(self, corpo, token=None, headers=None):
        servir = criar_handler_fs(self.fs, mount_path="/api/fs", require_token=token)
        h = HandlerFalso("/api/fs", corpo=json.dumps(corpo).encode("utf-8"), headers=headers)
        atendeu = servir(h)
        return atendeu, h

    def test_rota_de_fora_do_mount_nao_e_atendida(self):
        # `False` é o contrato: 404 é decisão de quem compõe as rotas, não da lib. Uma lib que
        # respondesse sozinha impediria o app de tentar as próprias rotas depois dela.
        servir = criar_handler_fs(self.fs, mount_path="/api/fs")
        self.assertFalse(servir(HandlerFalso("/api/outra")))

    def test_op_ok(self):
        atendeu, h = self._rpc({"op": "write-file", "path": "n.txt", "content": "oi"})
        self.assertTrue(atendeu)
        self.assertEqual(h.status, 200)
        self.assertTrue(h.json()["ok"])

    def test_op_desconhecida_e_400_e_NOMEIA_a_op(self):
        _, h = self._rpc({"op": "formatar-o-disco"})
        self.assertEqual(h.status, 400)
        self.assertIn("formatar-o-disco", h.json()["error"]["message"])

    def test_erro_de_caminho_vira_404_e_NAO_500(self):
        # 500 é reservado para defeito NOSSO. Um arquivo apagado respondido como 500 faz o
        # monitoramento acordar alguém por um clique.
        _, h = self._rpc({"op": "read-file", "path": "nao-tem.txt"})
        self.assertEqual(h.status, 404)
        self.assertEqual(h.json()["error"]["code"], ENOENT)

    def test_fuga_da_raiz_vira_403(self):
        _, h = self._rpc({"op": "read-file", "path": "../../../etc/passwd"})
        self.assertEqual(h.status, 403)
        self.assertEqual(h.json()["error"]["code"], EACCES)

    def test_corpo_que_nao_e_JSON_e_400(self):
        servir = criar_handler_fs(self.fs, mount_path="/api/fs")
        h = HandlerFalso("/api/fs", corpo=b"{nao e json")
        servir(h)
        self.assertEqual(h.status, 400)

    def test_GET_no_RPC_e_405(self):
        servir = criar_handler_fs(self.fs, mount_path="/api/fs")
        h = HandlerFalso("/api/fs", command="GET")
        servir(h)
        self.assertEqual(h.status, 405)

    def test_token_ausente_e_403(self):
        _, h = self._rpc({"op": "exists", "path": "x"}, token="segredo")
        self.assertEqual(h.status, 403)

    def test_token_errado_e_403_e_o_certo_passa(self):
        _, errado = self._rpc({"op": "exists", "path": "x"}, token="segredo",
                              headers={"X-Vssh-App-Token": "outro"})
        self.assertEqual(errado.status, 403)
        _, certo = self._rpc({"op": "exists", "path": "x"}, token="segredo",
                             headers={"X-Vssh-App-Token": "segredo"})
        self.assertEqual(certo.status, 200)

    def test_comparacao_de_token_aceita_so_o_igual(self):
        self.assertTrue(token_confere("abc", "abc"))
        self.assertFalse(token_confere("abc", "abd"))
        self.assertFalse(token_confere("abc", "ab"))     # prefixo não passa
        self.assertFalse(token_confere("abc", ""))
        self.assertFalse(token_confere("abc", None))


class TestAsset(BaseFs):
    def _get(self, caminho, headers=None):
        servir = criar_handler_fs(self.fs, mount_path="/api/fs", assets_prefix="/assets/")
        h = HandlerFalso(caminho, command="GET", headers=headers)
        servir(h)
        return h

    def test_serve_binario_com_o_tipo_certo(self):
        self.fs.write_file("foto.png", b"\x89PNG\r\n\x1a\n" + b"0" * 40)
        h = self._get("/assets/foto.png")
        self.assertEqual(h.status, 200)
        self.assertEqual(h.cabecalhos["Content-Type"], "image/png")
        self.assertEqual(h.cabecalhos["Accept-Ranges"], "bytes")

    def test_Range_devolve_206_com_o_pedaco_pedido(self):
        # É o que faz um PDF grande ou um vídeo abrirem sem baixar o arquivo inteiro antes.
        self.fs.write_file("v.bin", bytes(range(256)))
        h = self._get("/assets/v.bin", headers={"Range": "bytes=10-19"})
        self.assertEqual(h.status, 206)
        self.assertEqual(h.cabecalhos["Content-Range"], "bytes 10-19/256")
        self.assertEqual(h.saida, bytes(range(10, 20)))

    def test_Range_impossivel_e_416(self):
        self.fs.write_file("v.bin", b"0123456789")
        h = self._get("/assets/v.bin", headers={"Range": "bytes=100-200"})
        self.assertEqual(h.status, 416)

    def test_asset_fora_da_raiz_e_403(self):
        h = self._get("/assets/../../../etc/passwd")
        self.assertEqual(h.status, 403)


if __name__ == "__main__":
    unittest.main()
