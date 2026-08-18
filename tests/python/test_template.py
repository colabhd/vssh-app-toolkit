"""O backend do template Python, medido EXECUTANDO as funções dele.

O par de `tests/template-galeria.test.js`, que faz o mesmo do lado Node — só que lá é preciso
recortar o fonte e passar por `new Function`, e aqui basta importar. O que se mede é idêntico, e
não por acaso: são as mesmas perguntas, porque é o mesmo app.

A junção entre marcação, comportamento e rotas NÃO é medida aqui: ela vale para os dois templates
de uma vez, e quem a garante é `tests/galeria-paridade.test.js` (as peças e as rotas são as mesmas)
somado ao `tests/template-galeria.test.js` (elas se encontram). Repetir aqui seria uma terceira
cópia da mesma pergunta, com uma a mais para esquecer de atualizar.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
import unittest.mock

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEMPLATE = os.path.join(RAIZ, "templates", "hello-vssh-app")


def carregar_backend(env):
    """Importa o `backend/main.py` com um ambiente controlado, e o DEIXA aplicado.

    O módulo faz trabalho no nível de topo (log, fs privado, spa), e é isso que se quer: se algum
    desses passos quebrar num ambiente magro, o app não sobe — e este import falharia junto, que é
    a resposta certa.

    O ambiente continua valendo depois do import porque as funções o leem NA CHAMADA — como o
    `process.env` do lado Node. Restaurá-lo aqui mediria um processo que já não é o do app: foi
    exatamente o que a primeira versão deste arquivo fez, e ela reprovou o `segredo()` por não
    encontrar uma variável que o próprio teste tinha acabado de tirar. Quem desfaz é o `tearDown`.
    """
    patcher = unittest.mock.patch.dict(os.environ, env, clear=True)
    patcher.start()
    if os.path.join(RAIZ, "lib", "python") not in sys.path:
        sys.path.insert(0, os.path.join(RAIZ, "lib", "python"))
    try:
        spec = importlib.util.spec_from_file_location(
            "hello_backend", os.path.join(TEMPLATE, "backend", "main.py"))
        modulo = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(modulo)
    except Exception:
        patcher.stop()
        raise
    return modulo, patcher


class BaseTemplate(unittest.TestCase):
    def setUp(self):
        self._patcher = None

    def tearDown(self):
        if self._patcher:
            self._patcher.stop()

    def carregar(self, extra=None):
        tmp = tempfile.mkdtemp(prefix="vssh-tpl-")
        env = {
            "VSSH_APP_ID": "hello-world",
            "VSSH_APP_DATA_DIR": os.path.join(tmp, "data"),
            "HOME": tmp,
            "PATH": os.environ.get("PATH", ""),
        }
        env.update(extra or {})
        self.tmp = tmp
        modulo, self._patcher = carregar_backend(env)
        return modulo


class TestSegredo(BaseTemplate):
    """A peça mais fácil de estragar da galeria, porque estragá-la não quebra nada.

    Bastaria devolver o valor do segredo junto com o resto e a demonstração continuaria
    "funcionando" — só teria virado exatamente o hábito que ela existe para ensinar a não ter.
    """

    def test_o_backend_NUNCA_devolve_o_valor_do_segredo(self):
        m = self.carregar({"HELLO_SEGREDO": "sk-nao-pode-vazar-9f8e7d"})
        r = m.segredo()
        self.assertTrue(r["definido"])
        self.assertNotIn("sk-nao-pode-vazar", json.dumps(r),
                         "o valor do segredo atravessou a rota — é assim que uma credencial vai "
                         "parar no log de alguém")
        self.assertEqual(r["tamanho"], len("sk-nao-pode-vazar-9f8e7d"))
        # Sem o prefixo de hash não dá para responder "é o mesmo que eu guardei?".
        self.assertRegex(r["sha256"], r"^[0-9a-f]{12}$")

    def test_a_ausencia_diz_O_QUE_FAZER(self):
        m = self.carregar()
        r = m.segredo()
        self.assertFalse(r["definido"])
        self.assertIn("reinicie", r["leitura"].lower())

    def test_guardado_no_cofre_e_ausente_do_ambiente_e_o_TERCEIRO_estado(self):
        # O caso que pareceu defeito ao testar num servidor: guardar, reabrir a janela, e a peça
        # dizer que não havia nada. Reabrir a janela não reinicia o processo — a janela é uma view,
        # o backend continua o mesmo —, e o ambiente de um processo é fixado no start.
        #
        # Olhando só o ambiente, "nunca guardado" e "guardado depois deste processo subir" dão a
        # MESMA resposta. E a segunda é a única em que a pessoa fez tudo certo, o que a torna a
        # mais cara de diagnosticar: ela conclui que o cofre não funciona.
        tmp = tempfile.mkdtemp(prefix="vssh-cofre-")
        dados = os.path.join(tmp, "data")
        os.makedirs(dados, exist_ok=True)
        with open(os.path.join(tmp, "secrets.json"), "w", encoding="utf-8") as fh:
            json.dump({"HELLO_SEGREDO": "sk-x"}, fh)

        m, self._patcher = carregar_backend({"VSSH_APP_ID": "hello-world", "VSSH_APP_DATA_DIR": dados,
                                             "HOME": tmp, "PATH": os.environ.get("PATH", "")})
        r = m.segredo()
        self.assertFalse(r["definido"])
        self.assertTrue(r["noCofre"], "a peça não olha o cofre em disco: o estado do meio some")
        self.assertRegex(r["leitura"], r"J[ÁA] EST[ÁA] GUARDADO")
        # E só as chaves: o valor não pode aparecer em lugar nenhum da resposta.
        self.assertNotIn("sk-x", json.dumps(r), "a peça leu o VALOR do cofre em disco")


class TestLimites(BaseTemplate):
    def test_o_limite_mostrado_vem_do_CGROUP_e_nao_do_manifesto(self):
        # É a demonstração inteira: o manifesto diz o que se PEDIU, o cgroup diz o que se RECEBEU.
        # Ler o próprio manifesto aqui daria sempre a resposta bonita — inclusive num servidor onde
        # nada foi aplicado, que é justamente o caso que a peça precisa saber mostrar.
        import inspect

        m = self.carregar()
        fonte = inspect.getsource(m.limites_do_cgroup)
        self.assertIn("/proc/self/cgroup", fonte)
        self.assertIn("memory.max", fonte)
        self.assertNotIn("vssh-app.json", fonte)
        self.assertNotIn("resources", fonte)
        # "max" é o valor do kernel para "sem teto", e é TEXTO. Confundi-lo com número faria um app
        # sem limite nenhum aparecer como limitadíssimo.
        self.assertIn('!= "max"', fonte)

    def test_nao_sei_e_diferente_de_sem_teto(self):
        m = self.carregar()
        r = m.limites_do_cgroup()
        # Num Linux com cgroup v2 responde `contido`; sem cgroupfs, `contido: None` com motivo. O
        # que NÃO pode acontecer é os dois casos virarem `False`, que significa "medi, e não há
        # limite".
        self.assertIn(r["contido"], (True, False, None))
        if r["contido"] is None:
            self.assertIn("motivo", r)


class TestGpu(BaseTemplate):
    def test_nao_sei_NAO_e_nao_tem(self):
        # Um servidor sem `/sys/class/drm` cai aqui, e chamar isso de ausência de GPU seria a peça
        # mentindo sobre o servidor.
        m = self.carregar({"VSSH_GPU_SYSFS": "/caminho/que/nao/existe"})
        r = m.gpu_do_servidor()
        self.assertFalse(r["sei"])
        self.assertIn("motivo", r)
        self.assertEqual(r["dispositivos"], [])

    def test_a_falha_da_GPU_e_CLASSIFICADA_porque_as_causas_pedem_acoes_OPOSTAS(self):
        m = self.carregar()
        VIRTUAL = {"virtual": True, "fabricante": "virtio", "driver": "virtio-pci"}
        FISICA = {"virtual": False, "fabricante": "AMD", "driver": "amdgpu"}

        # O caso REAL, medido num servidor: `vaInitialize: 2` numa virtio. A primeira versão
        # hesitava — "instale o driver, SE ela for física" — mesmo com a descoberta já sabendo que
        # é virtual. E aí a pessoa vai procurar pacote para um problema que nenhum pacote resolve.
        s = "Failed to initialise VAAPI connection: 2 (resource allocation failed)."
        self.assertIn("NÃO implementa VA-API", m._por_que_vaapi_falhou(s, VIRTUAL))
        self.assertIn("nenhum pacote resolve", m._por_que_vaapi_falhou(s, VIRTUAL),
                      "a resposta deixou esperança onde não há — pior que uma resposta ruim")

        # A MESMA saída numa placa física é outro diagnóstico: aí o pacote É o caminho.
        self.assertIn("driver ausente", m._por_que_vaapi_falhou(s, FISICA))
        self.assertNotIn("nenhum pacote resolve", m._por_que_vaapi_falhou(s, FISICA))

        self.assertIn("compilado SEM VAAPI", m._por_que_vaapi_falhou("Unknown encoder 'h264_vaapi'", FISICA))
        self.assertIn("grupo `render`",
                      m._por_que_vaapi_falhou("Failed to open /dev/dri/renderD128: Permission denied", FISICA))
        self.assertIn("GPU VIRTUAL",
                      m._por_que_vaapi_falhou("No usable encoding entrypoint found for profile", VIRTUAL))

        # Inventar diagnóstico custa mais que não ter nenhum.
        self.assertIsNone(m._por_que_vaapi_falhou("", VIRTUAL))
        self.assertIsNone(m._por_que_vaapi_falhou("algo que ninguém previu", VIRTUAL))
        # Sem dispositivo (o caminho do "não sei"), não pode afirmar que é virtual.
        self.assertNotIn("VIRTUAL", m._por_que_vaapi_falhou(s, None) or "")

    def test_o_stderr_do_ffmpeg_e_CAPTURADO(self):
        # Num servidor de verdade a mensagem foi: "Command failed: ffmpeg -hide_banner …". A linha
        # de comando truncada, e nenhuma palavra sobre o que houve. Erro que não dá o que procurar
        # é quase tão ruim quanto erro nenhum.
        import inspect

        m = self.carregar()
        fonte = inspect.getsource(m.benchmark_gpu)
        self.assertIn("stderr=subprocess.PIPE", fonte)
        self.assertNotIn("stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL", fonte)
        # E sem `-hwaccel vaapi`: aquilo acelera DECODE, e a fonte é gerada pelo próprio ffmpeg.
        # Pedi-lo faz o erro falar do decode em vez do encode que se queria medir.
        #
        # O recorte procura o ARGUMENTO, entre aspas — e não a palavra solta. O comentário logo
        # acima da chamada explica justamente por que ele não está lá, e uma guarda que o acusasse
        # estaria reprovando a explicação da própria regra que ela existe para impor.
        self.assertNotIn('"-hwaccel"', fonte)
        self.assertNotIn("'-hwaccel'", fonte)

    def test_sem_ffmpeg_nao_roda_e_o_motivo_aponta_o_requiredPackages(self):
        # `PATH` vazio: o ffmpeg deixa de ser encontrável, que é o caso de um servidor onde o
        # instalador deixou passar.
        m = self.carregar({"PATH": ""})
        r = m.benchmark_gpu()
        self.assertFalse(r["rodou"])
        self.assertIn("requiredPackages", r["motivo"],
                      "o motivo não liga a falta do ffmpeg ao mecanismo que deveria tê-la impedido")


class TestManifesto(unittest.TestCase):
    def manifesto(self):
        with open(os.path.join(TEMPLATE, "vssh-app.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_declara_os_tres_e_o_secrets_SEM_valor(self):
        m = self.manifesto()
        self.assertTrue(m.get("resources", {}).get("memoryMax"))
        self.assertEqual([s["name"] for s in m["secrets"]], ["HELLO_SEGREDO"])
        for s in m["secrets"]:
            for proibido in ("value", "valor", "default"):
                self.assertNotIn(proibido, s,
                                 "o template traz o VALOR do segredo no manifesto")
        # `gpu: True` porque uma galeria existe para ser EXERCITADA num servidor: o benchmark
        # precisa da placa para medir.
        self.assertIs(m["gpu"], True)

    def test_declara_o_ffmpeg_e_o_pip(self):
        m = self.manifesto()
        self.assertIn("ffmpeg", m["requiredPackages"],
                      "o benchmark usa ffmpeg e o manifesto não o declara")
        self.assertIn("python3-pip", m["requiredPackages"],
                      "o installCommand instala com pip e o manifesto não o declara: o servidor "
                      "sem pip só descobre isso quando o primeiro usuário abre o app")

    def test_o_installCommand_e_idempotente_e_respeita_o_REBUILD(self):
        # Ele roda DUAS vezes — root no install, e por usuário no primeiro run. A segunda tem de
        # conferir sem refazer; e um reinstall --force precisa de um jeito de forçar mesmo assim.
        cmd = self.manifesto()["backend"]["installCommand"]
        self.assertIn("VSSH_APP_REBUILD", cmd)
        self.assertIn("test -d vendor/py", cmd)
        # `--target vendor/py`: grava na execução ROOT, onde /opt/vssh-apps/<id>/ é gravável. Um
        # venv ou um `--user` mudaria o dono do que é instalado.
        self.assertIn("--target vendor/py", cmd)
        # Tarball, e não `git+https`: sem exigir `git` no alvo — a mesma propriedade que o npm tem.
        self.assertIn("archive/refs/tags", cmd)
        self.assertNotIn("git+", cmd)


class OEnderecoVemDoToolkit(BaseTemplate):
    """Quem abre o endereço é o `criar_servidor()` do toolkit, e não um servidor montado à mão.

    A diferença não aparece num smoke: um `UnixStreamServer` escrito à mão binda o socket e serve a
    página igual. O que se perde é o que a lib faz em volta — limpar o socket órfão por tentativa de
    CONEXÃO (nunca por `exists`, que derrubaria a instância viva), o modo 0600 contra o umask, e o
    erro nomeado de "já está escutando", que o lifecycle trata como sucesso em vez de como falha.

    Medido substituindo a função DENTRO do módulo do toolkit, que é de onde o template a importa: se
    ele passar a montar o servidor por conta própria, o dublê não é chamado e o teste fica vermelho.
    """

    def test_o_main_pega_o_servidor_do_toolkit(self):
        # O import vem DEPOIS do `carregar()`: é ele que põe `lib/python` no `sys.path`.
        modulo = self.carregar()
        import vssh_app_toolkit.listen as listen

        class Parou(Exception):
            pass

        class ServidorDeMentira:
            endereco_vssh = {"transport": "socket", "socket": "/tmp/x.sock"}

            def serve_forever(self):
                raise Parou()

            def server_close(self):
                pass

        chamadas = []
        # O `main()` registra "listening" antes de servir, e o log do template escreve em stdout por
        # padrão — o que sujaria a saída da suíte com uma linha de NDJSON por execução.
        modulo.log = lambda *a, **kw: None
        original = listen.criar_servidor
        try:
            listen.criar_servidor = lambda *a, **kw: (chamadas.append(a), ServidorDeMentira())[1]
            # O template importa o nome, então rebindar só o módulo não basta: é o nome DELE que
            # importa, e é por isso que o dublê entra nos dois lugares.
            modulo.criar_servidor = listen.criar_servidor
            with self.assertRaises(Parou):
                modulo.main()
        finally:
            listen.criar_servidor = original

        self.assertEqual(len(chamadas), 1,
                         "o backend do template não pediu o servidor ao toolkit")
        self.assertIs(chamadas[0][0], modulo.Handler,
                      "o servidor foi criado com outro handler que não o do template")


if __name__ == "__main__":
    unittest.main()
