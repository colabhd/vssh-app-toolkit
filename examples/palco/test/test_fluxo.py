"""O `Range`, que é o que transforma um arquivo servido em um vídeo com barra de progresso.

Sem Range não há busca: o `<video>` só consegue tocar do começo, e arrastar a linha do tempo baixa
tudo de novo. Com Range errado é pior — ele *parece* funcionar e entrega bytes trocados, e o
sintoma é vídeo corrompido a partir do ponto em que a pessoa buscou. É um off-by-one, o defeito mais
fácil de escrever e o mais difícil de enxergar olhando o código.

Por isso o teste do fim reconstrói o arquivo inteiro a partir das faixas: se algum byte entrar duas
vezes ou faltar, a comparação acusa. Nenhuma asserção sobre cabeçalho pega isso sozinha.

Nada aqui abre socket. O `Range` é aritmética sobre um número e uma string — e é assim que ele se
mede.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from fluxo import enquadrar, resolver, terminador  # noqa: E402

TAM = 1000


class TestSemFaixa(unittest.TestCase):
    def test_sem_cabecalho_manda_tudo(self):
        r = resolver(None, TAM)
        self.assertEqual((r.status, r.inicio, r.fim, r.comprimento), (200, 0, 999, 1000))

    def test_e_ANUNCIA_que_aceita_faixa(self):
        # ⚠ Sem `Accept-Ranges: bytes` na resposta de 200, o navegador nem tenta buscar: ele
        # assume que o servidor não sabe, e a linha do tempo vira decoração. O cabeçalho é o
        # anúncio, e esquecê-lo desliga o recurso sem erro nenhum.
        self.assertEqual(resolver(None, TAM).cabecalhos.get("Accept-Ranges"), "bytes")
        self.assertEqual(resolver("bytes=0-99", TAM).cabecalhos.get("Accept-Ranges"), "bytes")


class TestFaixaNormal(unittest.TestCase):
    def test_do_comeco_ate_o_fim(self):
        # O que todo `<video>` manda na primeira requisição.
        r = resolver("bytes=0-", TAM)
        self.assertEqual((r.status, r.inicio, r.fim, r.comprimento), (206, 0, 999, 1000))
        self.assertEqual(r.cabecalhos["Content-Range"], "bytes 0-999/1000")

    def test_um_pedaco_no_meio(self):
        r = resolver("bytes=100-199", TAM)
        self.assertEqual((r.inicio, r.fim, r.comprimento), (100, 199, 100))
        self.assertEqual(r.cabecalhos["Content-Range"], "bytes 100-199/1000")

    def test_os_dois_extremos_sao_INCLUSIVOS(self):
        # ⚠ O off-by-one mora exatamente aqui: `bytes=0-99` são CEM bytes, não noventa e nove. Uma
        # subtração ingênua (`fim - inicio`) entrega um byte a menos por requisição, e o vídeo
        # quebra num ponto que não tem relação nenhuma com o lugar onde o código está errado.
        r = resolver("bytes=0-0", TAM)
        self.assertEqual((r.inicio, r.fim, r.comprimento), (0, 0, 1))
        self.assertEqual(resolver("bytes=0-99", TAM).comprimento, 100)

    def test_a_busca_de_um_video_e_uma_faixa_aberta(self):
        # Arrastar a linha do tempo manda `bytes=<offset>-`. É o caso que faz o recurso existir.
        r = resolver("bytes=524288-", 1048576)
        self.assertEqual((r.status, r.inicio, r.fim), (206, 524288, 1048575))

    def test_fim_alem_do_arquivo_e_APARADO_e_nao_recusado(self):
        # O navegador pede folga de propósito ("me dê a partir daqui, até 5 MB"). Recusar seria
        # ler a norma ao contrário e quebrar a leitura antecipada de todo player.
        r = resolver("bytes=900-99999", TAM)
        self.assertEqual((r.status, r.inicio, r.fim, r.comprimento), (206, 900, 999, 100))


class TestSufixo(unittest.TestCase):
    def test_os_ultimos_N_bytes(self):
        # ⚠ `bytes=-500` NÃO é "do byte -500": é "os últimos 500". Ler como início negativo é o
        # segundo erro clássico deste cabeçalho — e o MP4 depende dele, porque o índice (`moov`)
        # de um arquivo não otimizado fica no FIM. Errar aqui faz o vídeo não abrir, e não abrir de
        # um jeito que parece problema do arquivo.
        r = resolver("bytes=-500", TAM)
        self.assertEqual((r.status, r.inicio, r.fim, r.comprimento), (206, 500, 999, 500))

    def test_sufixo_maior_que_o_arquivo_e_o_arquivo_inteiro(self):
        r = resolver("bytes=-5000", TAM)
        self.assertEqual((r.inicio, r.fim, r.comprimento), (0, 999, 1000))

    def test_sufixo_zero_e_insatisfativel(self):
        # "Me dê os últimos zero bytes" não tem resposta possível — 416, e não um 206 vazio.
        self.assertEqual(resolver("bytes=-0", TAM).status, 416)


class TestInsatisfativel(unittest.TestCase):
    def test_comeco_depois_do_fim_do_arquivo(self):
        self.assertEqual(resolver("bytes=1000-", TAM).status, 416)
        self.assertEqual(resolver("bytes=5000-6000", TAM).status, 416)

    def test_o_416_TEM_de_dizer_o_tamanho(self):
        # ⚠ `Content-Range: bytes */1000` é o que permite ao cliente se corrigir sozinho. Um 416
        # sem ele deixa o player num laço: ele pede errado, leva 416, e não recebe a informação de
        # que precisaria para pedir certo.
        r = resolver("bytes=5000-", TAM)
        self.assertEqual(r.cabecalhos["Content-Range"], "bytes */1000")
        self.assertEqual(r.comprimento, 0)

    def test_arquivo_vazio(self):
        # Um arquivo de zero byte não tem faixa satisfazível nenhuma — nem `bytes=0-`.
        r = resolver("bytes=0-", 0)
        self.assertEqual((r.status, r.cabecalhos["Content-Range"]), (416, "bytes */0"))


class TestCabecalhoTorto(unittest.TestCase):
    def test_o_que_nao_da_para_ler_e_IGNORADO_e_nao_recusado(self):
        # ⚠ A norma manda ignorar um `Range` que não se entende, e não responder 416: 416 diz "o
        # que você pediu não existe", que é uma afirmação diferente e errada. Ignorar devolve o
        # arquivo inteiro, que é sempre uma resposta correta.
        for torto in ("bytes=abacaxi", "items=0-100", "bytes=", "bytes=-", "", "bytes=99-50"):
            self.assertEqual(resolver(torto, TAM).status, 200, repr(torto))

    def test_espaco_sobrando_nao_atrapalha(self):
        self.assertEqual(resolver("bytes = 100 - 199", TAM).inicio, 100)

    def test_faixa_MULTIPLA_devolve_o_arquivo_inteiro(self):
        # Responder a várias faixas exige `multipart/byteranges`, que nenhum `<video>` pede e que
        # seria mecanismo sem consumidor. A norma permite ignorar — e ignorar aqui é entregar tudo,
        # não entregar a primeira faixa fingindo ter atendido as duas.
        r = resolver("bytes=0-9,20-29", TAM)
        self.assertEqual((r.status, r.comprimento), (200, 1000))


class TestReconstrucao(unittest.TestCase):
    def test_as_faixas_remontam_o_arquivo_byte_a_byte(self):
        # ⚠ A única asserção que pega um off-by-one de verdade. Nenhuma conferência de cabeçalho
        # descobre um byte repetido ou faltando; a comparação do conteúdo descobre.
        dados = bytes(i % 251 for i in range(4096))
        remontado = bytearray()
        pos = 0
        while pos < len(dados):
            r = resolver(f"bytes={pos}-{pos + 511}", len(dados))
            self.assertEqual(r.status, 206, f"faixa a partir de {pos}")
            remontado += dados[r.inicio:r.fim + 1]
            self.assertEqual(len(dados[r.inicio:r.fim + 1]), r.comprimento,
                             "o Content-Length não bate com os bytes que a faixa cobre")
            pos = r.fim + 1
        self.assertEqual(bytes(remontado), dados)

    def test_o_sufixo_pega_a_cauda_certa(self):
        dados = bytes(range(256))
        r = resolver("bytes=-10", len(dados))
        self.assertEqual(dados[r.inicio:r.fim + 1], dados[-10:])


class TestOCanoDizQuandoFalhou(unittest.TestCase):
    """O defeito que este bloco existe para impedir, e ele já aconteceu.

    Um `.avi` tocou UM QUADRO e o player pulou para o vídeo anterior. Nada no console, nada na tela,
    e a suíte inteira verde. A causa: o corpo `chunked` era sempre fechado com o terminador, então
    um ffmpeg que morreu no primeiro quadro produzia um corpo bem formado e curto — indistinguível,
    do lado do navegador, de um filme que acabou. Ele disparava `ended`, e o `ended` avançava a
    pasta. A falha não tinha por onde chegar até quem estava assistindo.
    """

    def test_saindo_bem_o_corpo_e_FECHADO(self):
        self.assertEqual(terminador(0, 4096), b"0\r\n\r\n")

    def test_saindo_MAL_o_corpo_fica_incompleto(self):
        # É o sinal inteiro: um `chunked` sem terminador é erro de rede para o navegador, `error` no
        # `<video>`, e uma frase legível. Fechá-lo aqui é o que apagava a falha.
        for status in (1, 127, -9, 255):
            self.assertEqual(terminador(status, 4096), b"",
                             f"status {status} tinha de deixar o corpo incompleto")

    def test_zero_byte_com_status_zero_TAMBEM_e_falha(self):
        # ⚠ Não é redundante com o teste acima, e foi o caso que quase escapou: um ffmpeg pode sair
        # com zero sem escrever nada (entrada sem faixa mapeável, filtro que não casa). Um corpo
        # vazio bem terminado é um vídeo de duração zero — que o navegador aceita EM SILÊNCIO, que é
        # a pior das respostas possíveis.
        self.assertEqual(terminador(0, 0), b"")

    def test_o_bloco_declara_o_tamanho_em_HEXA(self):
        # O enquadramento `chunked` é em base 16, e escrevê-lo em decimal produz um corpo que só
        # quebra em blocos maiores que nove bytes — ou seja, passa em qualquer teste pequeno demais.
        self.assertEqual(enquadrar(b"x" * 255), b"FF\r\n" + b"x" * 255 + b"\r\n")
        self.assertEqual(enquadrar(b"abc"), b"3\r\nabc\r\n")

    def test_bloco_vazio_nao_e_escrito(self):
        # ⚠ `0\r\n\r\n` É o terminador. Um bloco de tamanho zero no meio do corpo encerra a resposta
        # ali — entregando meio filme com cara de filme inteiro.
        self.assertEqual(enquadrar(b""), b"")

    def test_o_corpo_completo_remonta_os_bytes(self):
        dados = bytes(i % 251 for i in range(5000))
        corpo = b"".join(enquadrar(dados[i:i + 1024]) for i in range(0, len(dados), 1024))
        corpo += terminador(0, len(dados))
        # Desenquadrar de volta é a única asserção que pega um `\r\n` a mais ou a menos.
        fora, resto = bytearray(), corpo
        while True:
            cabeca, _, resto = resto.partition(b"\r\n")
            n = int(cabeca, 16)
            if n == 0:
                break
            fora += resto[:n]
            resto = resto[n + 2:]
        self.assertEqual(bytes(fora), dados)


if __name__ == "__main__":
    unittest.main()
