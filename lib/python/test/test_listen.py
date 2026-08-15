"""O endereço de um app, e as três armadilhas do socket unix.

Espelha `lib/node/test/app-listen.test.js`. O que se mede aqui é o que já mordeu de verdade: um
socket órfão que trava o boot, um socket VIVO apagado por engano (que derruba a instância que está
atendendo), e o modo do arquivo vindo do umask.
"""

import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vssh_app_toolkit.listen import (  # noqa: E402
    VSSH_APP_JA_ESCUTANDO,
    VSSH_APP_SEM_ENDERECO,
    VSSH_APP_SERVIDOR_ANTIGO,
    ErroDeEndereco,
    criar_servidor,
    endereco_do_ambiente,
    limpar_socket_orfao,
)

SEM_UNIX = not hasattr(socket, "AF_UNIX")


class TestEndereco(unittest.TestCase):
    def test_le_o_socket_do_ambiente(self):
        r = endereco_do_ambiente({"VSSH_APP_SOCKET": "/tmp/x.sock"})
        self.assertEqual(r, {"transporte": "socket", "caminho": "/tmp/x.sock"})

    def test_espaco_em_branco_nao_conta_como_endereco(self):
        with self.assertRaises(ErroDeEndereco) as ctx:
            endereco_do_ambiente({"VSSH_APP_SOCKET": "   "})
        self.assertEqual(ctx.exception.codigo, VSSH_APP_SEM_ENDERECO)

    def test_port_sozinho_e_servidor_antigo_e_diz_isso(self):
        # O erro tem código PRÓPRIO porque o conserto é outro: não é "faltou variável", é um
        # servidor cujo lifecycle é anterior à Onda 9. Dizer isso pelo nome poupa quem for depurar
        # de procurar o defeito dentro do app.
        with self.assertRaises(ErroDeEndereco) as ctx:
            endereco_do_ambiente({"VSSH_APP_PORT": "8080"})
        self.assertEqual(ctx.exception.codigo, VSSH_APP_SERVIDOR_ANTIGO)
        self.assertIn("minShellVersion", str(ctx.exception))

    def test_sem_nada_ensina_a_rodar_a_mao(self):
        with self.assertRaises(ErroDeEndereco) as ctx:
            endereco_do_ambiente({})
        self.assertEqual(ctx.exception.codigo, VSSH_APP_SEM_ENDERECO)
        self.assertIn("VSSH_APP_SOCKET=", str(ctx.exception))


@unittest.skipIf(SEM_UNIX, "sem AF_UNIX (Windows): o alvo de um vssh-app é sempre Linux")
class TestSocketOrfao(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vssh-listen-")
        self.sock = os.path.join(self.dir, "app.sock")

    def test_inexistente(self):
        self.assertEqual(limpar_socket_orfao(self.sock), "inexistente")

    def test_orfao_e_removido(self):
        # Um arquivo comum no lugar do socket é o caso do `SIGKILL`: o inode fica, ninguém atende.
        open(self.sock, "w").close()
        self.assertEqual(limpar_socket_orfao(self.sock), "removido")
        self.assertFalse(os.path.exists(self.sock))

    def test_socket_VIVO_nunca_e_removido(self):
        # A asserção mais importante do arquivo. Apagar pelo simples fato de o arquivo existir
        # derrubaria a instância que está atendendo AGORA — e o sintoma ("o app reinicia sozinho
        # quando alguém o abre duas vezes") não aponta para cá.
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(self.sock)
        s.listen(1)
        try:
            self.assertEqual(limpar_socket_orfao(self.sock), "vivo")
            self.assertTrue(os.path.exists(self.sock))
        finally:
            s.close()


@unittest.skipIf(SEM_UNIX, "sem AF_UNIX (Windows): o alvo de um vssh-app é sempre Linux")
class TestCriarServidor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vssh-listen-")
        self.sock = os.path.join(self.dir, "sub", "app.sock")
        self.env = {"VSSH_APP_SOCKET": self.sock}

    def _handler(self):
        from http.server import BaseHTTPRequestHandler

        class H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", "3")
                self.end_headers()
                self.wfile.write(b"ok\n")

            def log_message(self, *a):  # silêncio no teste
                pass

        return H

    def test_cria_o_diretorio_e_binda(self):
        srv = criar_servidor(self._handler(), env=self.env)
        try:
            self.assertTrue(os.path.exists(self.sock))
            self.assertEqual(srv.endereco_vssh["endereco"], self.sock)
            # 0700 no diretório é a PRIMEIRA defesa; sem ela, o modo do socket não salva ninguém.
            self.assertEqual(os.stat(os.path.dirname(self.sock)).st_mode & 0o777, 0o700)
        finally:
            srv.server_close()

    def test_o_modo_do_socket_nao_vem_do_umask(self):
        # Com umask frouxo (0022) o socket sairia 0755 — conectável por qualquer conta da máquina
        # se o diretório algum dia deixar de ser 0700. Duas defesas, não uma.
        anterior = os.umask(0o022)
        try:
            srv = criar_servidor(self._handler(), env=self.env)
            try:
                self.assertEqual(os.stat(self.sock).st_mode & 0o777, 0o600)
            finally:
                srv.server_close()
        finally:
            os.umask(anterior)

    def test_orfao_no_caminho_nao_impede_o_boot(self):
        os.makedirs(os.path.dirname(self.sock), exist_ok=True)
        open(self.sock, "w").close()
        srv = criar_servidor(self._handler(), env=self.env)
        srv.server_close()

    def test_ja_escutando_tem_codigo_proprio(self):
        # NÃO é erro de programação: significa que o app já está de pé, e o lifecycle trata sair
        # com 0 como sucesso. Um código próprio é o que permite ao app distinguir os dois.
        primeiro = criar_servidor(self._handler(), env=self.env)
        t = threading.Thread(target=primeiro.serve_forever, daemon=True)
        t.start()
        try:
            with self.assertRaises(ErroDeEndereco) as ctx:
                criar_servidor(self._handler(), env=self.env)
            self.assertEqual(ctx.exception.codigo, VSSH_APP_JA_ESCUTANDO)
        finally:
            primeiro.shutdown()
            primeiro.server_close()

    def test_atende_HTTP_de_verdade_pelo_socket(self):
        # A prova de que a combinação existe: `BaseHTTPRequestHandler` sobre `AF_UNIX` responde. É
        # aqui que o `client_address` de mentira se paga — sem ele, `address_string()` quebra
        # DENTRO de uma requisição que estava indo bem.
        srv = criar_servidor(self._handler(), env=self.env)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            c.connect(self.sock)
            c.sendall(b"GET /healthz HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n")
            resposta = b""
            while True:
                pedaco = c.recv(4096)
                if not pedaco:
                    break
                resposta += pedaco
            c.close()
            self.assertIn(b"200", resposta)
            self.assertIn(b"ok", resposta)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
