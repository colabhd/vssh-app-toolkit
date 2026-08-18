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

from ytdlp import (  # noqa: E402
    Mundo, atualizar, caminhos_de_busca, carregar, diretorio_de_atualizacao,
    negociar_idioma, recarregar, versao,
)


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


# ── O idioma ─────────────────────────────────────────────────────────────────
#
# ⚠ **Duas medições contra o YouTube de verdade decidem tudo aqui, e a segunda é a que morde.**
#
# 1. Sem `lang`, o yt-dlp fixa `hl: "en"` e o YouTube devolve o título TRADUZIDO. Buscando
#    "receita de bolo": "I MADE IT IN 4 MINUTES!! THE SIMPLEEST AND CHEAPEST CAKE" contra
#    "FIZ EM 4 MINUTOS!! O BOLO MAIS SIMPLES E BARATO DO MUNDO!" com `lang=pt`. Mesmos vídeos,
#    brasileiros, com o título passado por tradução automática.
#
# 2. **`pt-BR` NÃO está na lista do YouTube**, e um código fora dela levanta
#    `Unsupported language code` em TODA chamada. Como `pt-BR` é exatamente o que
#    `navigator.language` devolve para quem relatou o problema, passar o pedido cru trocaria
#    "títulos em inglês" por "o app inteiro parou".
#
# A lista abaixo é a de verdade, recortada nas famílias que importam para a negociação.

LISTA_DO_YOUTUBE = ("af", "az", "id", "ms", "bs", "ca", "cs", "da", "de", "et", "en-IN", "en-GB",
                    "en", "es", "es-419", "es-US", "eu", "fil", "fr", "fr-CA", "gl", "pt-PT", "pt",
                    "zh-CN", "zh-TW", "ja", "ko")


class TestNegociarIdioma(unittest.TestCase):
    def test_o_piso_ptBR_NAO_esta_na_lista_do_youtube(self):
        # Sem isto, todo o resto deste bloco seria trabalho para um problema que talvez não
        # existisse. É a medição que justifica a função existir.
        self.assertNotIn("pt-BR", LISTA_DO_YOUTUBE)
        self.assertIn("pt", LISTA_DO_YOUTUBE)

    def test_ptBR_vira_pt(self):
        self.assertEqual(negociar_idioma("pt-BR", LISTA_DO_YOUTUBE), "pt")

    def test_o_exato_ganha_do_base(self):
        # `fr-CA` existe: rebaixá-lo para `fr` entregaria o francês da França a quem pediu o do
        # Canadá, e a lista tem os dois justamente porque eles diferem.
        self.assertEqual(negociar_idioma("fr-CA", LISTA_DO_YOUTUBE), "fr-CA")
        self.assertEqual(negociar_idioma("en-GB", LISTA_DO_YOUTUBE), "en-GB")

    def test_pt_NAO_sobe_para_ptPT(self):
        # ⚠ A direção só vale para baixo. O YouTube trata `pt` como o do Brasil; promover um pedido
        # genérico ao primeiro específico da lista entregaria Portugal a quem pediu português.
        self.assertEqual(negociar_idioma("pt", LISTA_DO_YOUTUBE), "pt")

    def test_a_caixa_do_pedido_nao_importa_e_a_da_RESPOSTA_e_a_da_lista(self):
        # ⚠ O yt-dlp compara com `casesense=True`. Aceitar `PT-br` e repassá-lo cru trocaria um
        # acerto por um `Unsupported language code` — o erro que esta função existe para evitar.
        self.assertEqual(negociar_idioma("PT-br", LISTA_DO_YOUTUBE), "pt")
        self.assertEqual(negociar_idioma("ZH-cn", LISTA_DO_YOUTUBE), "zh-CN")

    def test_idioma_que_o_youtube_nao_tem_vira_None(self):
        # `None` quer dizer "não mande `lang`" — o padrão do yt-dlp. Mandar o mais parecido seria
        # escolher um idioma no lugar de quem assiste.
        for fora in ("tlh", "cy-GB", "xx"):
            self.assertIsNone(negociar_idioma(fora, LISTA_DO_YOUTUBE))

    def test_pedido_vazio_vira_None(self):
        for vazio in (None, "", "  "):
            self.assertIsNone(negociar_idioma(vazio, LISTA_DO_YOUTUBE))

    def test_sem_lista_NENHUM_pedido_e_honrado(self):
        # ⚠ A lista é lida de dentro do yt-dlp e pode mudar de lugar numa versão futura. Quando ela
        # some, a resposta certa é o comportamento de hoje — e não chutar um código que faria toda
        # chamada levantar.
        for lista in ((), None):
            self.assertIsNone(negociar_idioma("pt-BR", lista))


class TestOMundoLevaOIdioma(unittest.TestCase):
    class YDLFalso:
        ultimas = None

        def __init__(self, opcoes):
            TestOMundoLevaOIdioma.YDLFalso.ultimas = opcoes

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def extract_info(self, url, download=False):
            return {"url": url}

    def _modulo(self):
        return type("M", (), {"YoutubeDL": TestOMundoLevaOIdioma.YDLFalso})

    def test_extrair_manda_o_lang(self):
        Mundo(self._modulo(), idioma="pt").extrair("https://x")
        self.assertEqual(self.YDLFalso.ultimas["extractor_args"], {"youtube": {"lang": ["pt"]}})

    def test_listar_manda_o_lang_TAMBEM(self):
        # ⚠ As duas rotas, e não só a de abrir: a busca é onde o defeito aparece primeiro, porque
        # é uma grade inteira de títulos traduzidos de uma vez.
        Mundo(self._modulo(), idioma="pt").listar("https://x", 1, 30)
        self.assertEqual(self.YDLFalso.ultimas["extractor_args"], {"youtube": {"lang": ["pt"]}})

    def test_sem_idioma_NAO_manda_extractor_args(self):
        # Mandar `lang: [""]` não é o mesmo que não mandar — o primeiro entra na conferência de
        # código suportado do extractor e levanta.
        Mundo(self._modulo()).extrair("https://x")
        self.assertNotIn("extractor_args", self.YDLFalso.ultimas)

    def test_as_opcoes_que_ja_existiam_seguem_de_pe(self):
        # A refatoração para `_comuns()` mexeu nos dois dicionários; um `noplaylist` perdido faz o
        # yt-dlp resolver a playlist inteira ao abrir um `watch?v=…&list=…`.
        m = Mundo(self._modulo(), idioma="pt")
        m.extrair("https://x")
        self.assertTrue(self.YDLFalso.ultimas["noplaylist"])
        m.listar("https://x", 7, 36)
        self.assertEqual(self.YDLFalso.ultimas["extract_flat"], "in_playlist")
        self.assertEqual(self.YDLFalso.ultimas["playliststart"], 7)
        self.assertEqual(self.YDLFalso.ultimas["playlistend"], 36)
        self.assertNotIn("noplaylist", self.YDLFalso.ultimas)


# ── A atualização ────────────────────────────────────────────────────────────

_MODULO_FALSO = type("M", (), {"version": type("V", (), {"__version__": "9.9.9"})})


class TestAtualizar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dados = self.tmp.name

    def _ok(self, argv):
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})

    def test_baixa_para_o_diretorio_que_o_import_procura_PRIMEIRO(self):
        # ⚠ É a costura inteira. `caminhos_de_busca` procura `$VSSH_APP_DATA_DIR/ytdlp` antes de
        # `vendor/py`; baixar para qualquer outro lugar faria o download funcionar e o `import`
        # continuar trazendo a versão velha — o botão dizendo "pronto" sobre um app quebrado.
        self.assertEqual(diretorio_de_atualizacao(self.dados),
                         os.path.join(self.dados, "ytdlp"))
        vendor = os.path.join(self.dados, "vendor")
        os.makedirs(os.path.join(self.dados, "ytdlp"), exist_ok=True)
        os.makedirs(vendor, exist_ok=True)
        self.assertEqual(caminhos_de_busca(self.dados, vendor)[0],
                         os.path.abspath(diretorio_de_atualizacao(self.dados)))

    def test_o_pip_recebe_upgrade_e_target(self):
        vistos = []

        def rodar(argv):
            vistos.append(argv)
            return self._ok(argv)

        atualizar(self.dados, rodar=rodar, importar=lambda n: _MODULO_FALSO)
        argv = vistos[0]
        # ⚠ Sem `--upgrade`, o pip vê o pacote já instalado no `--target` e não faz nada: o botão
        # responderia "pronto" toda vez sem nunca trocar de versão.
        self.assertIn("--upgrade", argv)
        self.assertIn("--target", argv)
        self.assertEqual(argv[argv.index("--target") + 1], os.path.join(self.dados, "ytdlp"))
        self.assertEqual(argv[-1], "yt-dlp")

    def test_o_diretorio_entra_no_sys_path_antes_do_reimport(self):
        # Numa instalação que nunca atualizou, este diretório não existia quando o app subiu —
        # então ele não está no caminho, e o reimport traria a versão velha de novo.
        antes = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), antes))
        atualizar(self.dados, rodar=self._ok, importar=lambda n: _MODULO_FALSO)
        self.assertIn(os.path.abspath(os.path.join(self.dados, "ytdlp")), sys.path)

    def test_pip_que_falha_NAO_diz_que_atualizou(self):
        def ruim(argv):
            return type("R", (), {"returncode": 1, "stdout": "",
                                  "stderr": "linha de ruido\nERROR: sem rede"})

        modulo, detalhe = atualizar(self.dados, rodar=ruim, importar=lambda n: _MODULO_FALSO)
        self.assertIsNone(modulo)
        # A ÚLTIMA linha do pip é a que diz o motivo; o resto é resolução de dependência.
        self.assertIn("sem rede", detalhe["erro"])

    def test_pip_que_nem_roda_vira_erro_e_nao_excecao(self):
        def explode(argv):
            raise OSError("python nao encontrado")

        modulo, detalhe = atualizar(self.dados, rodar=explode, importar=lambda n: _MODULO_FALSO)
        self.assertIsNone(modulo)
        self.assertIn("pip", detalhe["erro"])

    def test_baixou_e_o_import_falhou_e_um_ERRO_e_nao_um_sucesso(self):
        # ⚠ O caso do meio, e o mais perigoso: o disco tem a versão nova e o processo não. Dizer
        # "atualizado" aqui faria o `/healthz` e a tela concordarem sobre uma coisa que não é.
        def sem_import(nome):
            raise ImportError(nome)

        modulo, detalhe = atualizar(self.dados, rodar=self._ok, importar=sem_import)
        self.assertIsNone(modulo)
        self.assertIn("reabra", detalhe["erro"])

    def test_sem_diretorio_de_dados_nao_tenta_baixar(self):
        vistos = []
        modulo, detalhe = atualizar(None, rodar=lambda a: vistos.append(a))
        self.assertIsNone(modulo)
        self.assertEqual(vistos, [])

    def test_recarregar_APAGA_o_ytdlp_do_sys_modules(self):
        # ⚠ **Medido, e é o defeito inteiro deste recurso:** com o yt-dlp 2025.06.09 já importado e
        # o 2026.07.04 à frente no `sys.path`, um `import yt_dlp` continuou devolvendo 2025.06.09 —
        # o `sys.modules` responde antes de o caminho ser consultado. Só a purga troca a versão, e
        # no mesmo experimento ela trocou, com o extractor do YouTube junto.
        sys.modules["yt_dlp"] = _MODULO_FALSO
        sys.modules["yt_dlp.extractor"] = _MODULO_FALSO
        sys.modules["yt_dlpzinho"] = _MODULO_FALSO      # NÃO é submódulo: o prefixo engana
        self.addCleanup(lambda: sys.modules.pop("yt_dlpzinho", None))

        recarregar(importar=lambda n: _MODULO_FALSO)
        self.assertNotIn("yt_dlp", sys.modules)
        self.assertNotIn("yt_dlp.extractor", sys.modules)
        self.assertIn("yt_dlpzinho", sys.modules)


class TestASegundaOpiniao(unittest.TestCase):
    def test_o_cliente_entra_no_extractor_args_SEM_apagar_o_idioma(self):
        # ⚠ Os dois moram na mesma chave `extractor_args["youtube"]`. Sobrescrevê-la faria a segunda
        # opinião perder o idioma — e a frase do YouTube voltaria em inglês exatamente no momento em
        # que ela vai para a tela de alguém.
        vistas = {}

        class YDL:
            def __init__(self, o):
                vistas.update(o)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def extract_info(self, url, download=False):
                return {}

        Mundo(type("M", (), {"YoutubeDL": YDL}), idioma="pt").extrair("https://x", cliente="tv")
        self.assertEqual(vistas["extractor_args"]["youtube"]["lang"], ["pt"])
        self.assertEqual(vistas["extractor_args"]["youtube"]["player_client"], ["tv"])

    def test_sem_cliente_NAO_aparece_player_client(self):
        # O caminho normal não pede cliente nenhum: fixar um aqui trocaria a escolha do yt-dlp — que
        # muda com ele — por uma nossa, congelada.
        vistas = {}

        class YDL:
            def __init__(self, o):
                vistas.update(o)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def extract_info(self, url, download=False):
                return {}

        Mundo(type("M", (), {"YoutubeDL": YDL}), idioma="pt").extrair("https://x")
        self.assertNotIn("player_client", vistas["extractor_args"]["youtube"])
