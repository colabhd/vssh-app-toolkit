#!/usr/bin/env python3
"""Hello World (Python) — template de partida para um vssh-app com backend Python.

**É o mesmo app que o `hello-vssh-app-node`.** Mesmas peças, mesmas rotas, mesmo frontend — o
`frontend/galeria.js` é byte a byte idêntico ao de lá, e há um teste que reprova a divergência
(`tests/galeria-paridade.test.js`). A escolha entre os dois templates é de LINGUAGEM, e mais nada.

Uma dependência, e ela é o toolkit:

    pip install "https://github.com/colabhd/vssh-app-toolkit/archive/refs/tags/v4.tar.gz"

Quem instala no servidor é o `installCommand` do manifesto. O resto é stdlib.

O que este template já faz por você, e que a primeira versão de todo app esquece:
  - log estruturado em $VSSH_APP_DATA_DIR desde a primeira linha (é o que salva a depuração
    remota: frame minificado sustenta hipótese, log do backend nomeia op e caminho);
  - checagem do X-Vssh-App-Token, resistente a timing;
  - healthcheck que responde sem depender de nada estar pronto;
  - um endpoint SSE com os cabeçalhos que sobrevivem ao proxy e ao CDN.

⚠ **Este arquivo lia `VSSH_APP_PORT` até a v4**, e com isso ele deixou de subir: desde a Onda 9 o
endereço de um app é um socket unix, e o `transport: "tcp"` que entregaria uma porta saiu do
schema. Quem lê o endereço, limpa socket órfão e falha alto quando não veio nada é o
`criar_servidor()` do toolkit, lá no fim.
"""

import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

# As libs do toolkit. `vendor/py` primeiro: é onde o `installCommand` as instala, e um `pip
# install --target` dentro do próprio pacote é o equivalente exato do `node_modules` do lado Node.
_AQUI = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_AQUI, "..", "vendor", "py")
if os.path.isdir(_VENDOR):
    sys.path.insert(0, os.path.abspath(_VENDOR))

from vssh_app_toolkit.fs import criar_fs_do_app, criar_handler_fs  # noqa: E402
from vssh_app_toolkit.listen import ErroDeEndereco, VSSH_APP_JA_ESCUTANDO, criar_servidor  # noqa: E402
from vssh_app_toolkit.log import criar_log_do_app  # noqa: E402
# As duas vozes de um app SEM janela. Elas dizem coisas diferentes, e trocar uma pela outra é o
# erro que enche o sino de quem usa o ambiente:
#
#   notificar()  um FATO que aconteceu, e que a pessoa vai querer reencontrar. Fica no histórico.
#   live         uma CONDIÇÃO que é verdade AGORA. Some quando deixa de ser, sem deixar rastro.
from vssh_app_toolkit.live import (  # noqa: E402
    definir_live,
    limpar_live,
    limpar_live_ao_sair,
    manter_live_vivo,
)
from vssh_app_toolkit.notify import notificar  # noqa: E402
from vssh_app_toolkit.spa import criar_spa_estatica  # noqa: E402
from vssh_app_toolkit.sse import abrir_stream_sse  # noqa: E402
from vssh_app_toolkit.tray import definir_bandeja, limpar_bandeja, limpar_bandeja_ao_sair  # noqa: E402
from vssh_app_toolkit.web import DIRETORIO_WEB, SHIMS, ESTILOS, SCRIPTS  # noqa: E402

APP_ID = os.environ.get("VSSH_APP_ID") or "hello-world"
APP_TOKEN = os.environ.get("VSSH_APP_TOKEN") or None

log = criar_log_do_app(app_id=APP_ID)

# As duas metades do prazo de validade de uma atividade, ligadas no boot porque é uma linha cada e
# porque esquecê-las não quebra nada — só deixa uma barra mentindo no painel de outra pessoa.
manter_live_vivo()
limpar_live_ao_sair()
# Ícone órfão mente sobre o estado do ambiente: ele fica na bandeja depois que o app morreu, e quem
# o vê conclui que o app está de pé.
limpar_bandeja_ao_sair()

# ── O armazém privado deste app ──────────────────────────────────────────────
#
# A raiz fica DENTRO do VSSH_APP_DATA_DIR, que é o único diretório gravável garantido — o pacote em
# /opt/vssh-apps/<id>/ é root-owned e somente leitura.
_RAIZ_PRIVADA = os.path.join(
    os.environ.get("VSSH_APP_DATA_DIR") or os.path.join("/tmp", f"{APP_ID}-data"), "privado"
)
arquivos_privados = criar_fs_do_app(root=_RAIZ_PRIVADA, ao_avisar=lambda e: log("fs-warn", e))
servir_privado = criar_handler_fs(
    arquivos_privados,
    mount_path="/api/privado",
    # O MESMO token do resto do app. A lib confere sozinha, com comparação resistente a timing — e
    # é por isso que ela tem essa opção em vez de deixar cada app comparar com `!=`.
    require_token=APP_TOKEN,
    ao_avisar=lambda e: log("fs-warn", e),
)

spa = criar_spa_estatica(
    root=os.path.join(_AQUI, "..", "frontend"),
    # A PONTE COM O DESKTOP, em dois passos — esquecer o primeiro é o erro clássico:
    #   1. o navegador é quem carrega a lib, então alguém tem de SERVI-LA. Ela mora dentro do
    #      pacote instalado, fora da raiz do frontend, e é o `mounts` abaixo que a põe numa URL;
    #   2. `inject_scripts` só acrescenta a tag <script> antes do </head> do index.
    # Sem o mount a página carrega normalmente, a tag aponta para 404 e o `vssh` simplesmente não
    # existe — sem erro nenhum ligando uma coisa à outra.
    #
    # **As libs de navegador NÃO têm versão Python, e não precisam ter.** É o mesmo shim, servido
    # ao mesmo navegador; o que muda entre um app Node e um app Python é só quem o serve.
    mounts={"/_vssh/": DIRETORIO_WEB},
    # `galeria.js` — o código DESTE app — entra na mesma lista, e não como uma `<script src>` no
    # index, para ganhar o carimbo de conteúdo na URL: só o que é injetado é carimbado, e o carimbo
    # é o que garante que uma reinstalação não sirva a versão velha de nenhum cache do caminho.
    # A aparência do ambiente. Listas SEPARADAS do `SHIMS` de propósito: adotar a biblioteca de UI é
    # escolha deste app, e não consequência de atualizar o toolkit — um app com identidade visual
    # própria não pode ser reestilizado por um `pip install`.
    #
    # As folhas saem antes dos scripts no `<head>`: um `<link>` bloqueia a primeira pintura, então
    # descobri-lo cedo é o que evita a página aparecer sem estilo por um quadro.
    inject_styles=[f"_vssh/{f}" for f in ESTILOS],
    inject_scripts=[f"_vssh/{s}" for s in SHIMS] + [f"_vssh/{s}" for s in SCRIPTS] + ["galeria.js"],
    # Descomente se o seu app usa roteamento HTML5 (History API) em vez de fragmento:
    # spa_fallback=True,
    missing_bundle_hint="Rode o build do frontend antes de subir o backend.",
    ao_avisar=lambda e: log("spa-warn", e),
)

# ── Estado do processo, compartilhado por todas as janelas ────────────────────
#
# Um conjunto de streams SSE abertos e um contador. É o menor estado possível que ainda prova o
# modelo: N janelas, UM backend.
conexoes = set()
_tranca = threading.Lock()
contador = 0
subiu_em = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
tarefa_em_curso = None


def estado():
    return {"contador": contador, "conexoes": len(conexoes), "subiuEm": subiu_em}


def difundir():
    for s in list(conexoes):
        s.enviar("estado", estado())


# A difusão genérica, para o que o BACKEND recebe sem ninguém ter perguntado: o clique na bandeja e
# a ação de uma notificação chegam ao processo por POST, e é por aqui que uma janela aberta fica
# sabendo. Com nenhuma janela aberta, o laço não itera — e o app recebeu do mesmo jeito.
def difundir_evento(nome, dado):
    for s in list(conexoes):
        s.enviar(nome, dado)


# ── O que o ambiente decidiu por este processo ────────────────────────────────
#
# Três coisas que o app DECLARA e o ambiente APLICA. As três se leem de dentro do processo, e é
# isso que as torna demonstráveis: o manifesto diz o que se pediu; isto aqui diz o que se recebeu.


def limites_do_cgroup():
    """O teto de memória que está VALENDO, lido do cgroup — não o que o manifesto pediu.

    A diferença é o ponto da demonstração. O manifesto declara; o `vssh-app-run` traduz para um
    escopo transitório do systemd; e um servidor sem gerenciador systemd do usuário não aplica nada
    (`loginctl enable-linger`). Ler o cgroup é a única resposta que não é suposição — e quando ela
    vem vazia, o app está rodando SEM limite, que é informação e não erro.
    """
    try:
        with open("/proc/self/cgroup", encoding="utf-8") as fh:
            linha = next((l for l in fh.read().split("\n") if l.startswith("0::")), None)
        if not linha:
            return {"contido": False, "motivo": "sem cgroup v2 neste servidor"}
        base = os.path.join("/sys/fs/cgroup", linha[3:].strip().lstrip("/"))

        def ler(nome):
            try:
                with open(os.path.join(base, nome), encoding="utf-8") as fh:
                    return fh.read().strip()
            except OSError:
                return None

        mem_max = ler("memory.max")
        return {
            # "max" é o valor que o kernel usa para "sem teto" — TEXTO, não número, e confundir os
            # dois faria um app sem limite parecer limitadíssimo.
            "contido": bool(mem_max) and mem_max != "max",
            "cgroup": linha[3:].strip(),
            "memoryMax": mem_max,
            "memoryHigh": ler("memory.high"),
            "tasksMax": ler("pids.max"),
            # Quanto o processo está usando AGORA. É o que transforma o teto de número em noção.
            "memoryCurrent": ler("memory.current"),
        }
    except OSError as err:
        # Não é Linux, ou o cgroupfs não está montado. "Não sei" é resposta, e é diferente de
        # "sem teto".
        return {"contido": None, "motivo": str(err)}


_FABRICANTES = {
    "0x10de": "NVIDIA", "0x1002": "AMD", "0x1022": "AMD", "0x8086": "Intel",
    "0x1af4": "virtio", "0x1234": "QEMU", "0x15ad": "VMware", "0x5853": "Xen",
    "0x1414": "Microsoft",
}
# Por FABRICANTE primeiro. Um servidor real mostrou uma virtio-gpu reportando `DRIVER=virtio-pci` —
# o driver do BARRAMENTO, não o do DRM —, e a placa virtual passou por física. O id do fabricante
# não erra: 0x1af4 é virtio venha o dispositivo pendurado onde vier.
_FAB_VIRTUAIS = {"0x1af4", "0x1234", "0x15ad", "0x5853", "0x1414"}
_DRIVERS_VIRTUAIS = {"virtio_gpu", "virtio-pci", "bochs-drm", "bochs", "vmwgfx", "qxl",
                     "vboxvideo", "simpledrm", "vgem", "vkms", "hyperv_drm"}


def gpu_do_servidor():
    """A GPU deste servidor — o INVENTÁRIO, e não só a variável do CUDA.

    A primeira versão desta peça mostrava apenas `CUDA_VISIBLE_DEVICES`, e era inútil: o valor `""`
    (o ambiente escondeu) é indistinguível de "não há placa nenhuma". Pior, ela dizia "sem GPU" num
    servidor com AMD, com Intel ou com placa virtual — porque só sabia perguntar ao `nvidia-smi`.

    Agora pergunta ao KERNEL, que responde para qualquer fabricante e para placa que nem existe
    fisicamente: `/sys/class/drm` diz quem é e qual driver assumiu, e `/dev/dri` diz se este
    processo consegue ABRIR. As duas perguntas são diferentes, e a segunda é a que mais trava
    gente: o dispositivo existe e o usuário não está no grupo `render`.
    """
    sysfs = os.environ.get("VSSH_GPU_SYSFS") or "/sys/class/drm"
    dev = os.environ.get("VSSH_GPU_DEV") or "/dev/dri"

    def ler(p):
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError:
            return None

    try:
        cartoes = sorted(c for c in os.listdir(sysfs) if c.startswith("card") and "-" not in c)
    except OSError as err:
        # "Não sei" ≠ "não tem". Um Windows de desenvolvimento cai aqui, e chamar isso de ausência
        # de GPU seria a peça mentindo sobre o servidor.
        return {"sei": False, "motivo": str(err), "dispositivos": []}

    dispositivos = []
    for cartao in cartoes:
        base = os.path.join(sysfs, cartao)
        vendor = ler(os.path.join(base, "device", "vendor"))
        # `uevent` é um arquivo de texto com `DRIVER=amdgpu`; `device/driver` é um symlink de mesmo
        # nome. O arquivo vem primeiro porque é legível em qualquer lugar.
        driver = None
        uevent = ler(os.path.join(base, "device", "uevent"))
        if uevent:
            for l in uevent.split("\n"):
                if l.startswith("DRIVER="):
                    driver = l[len("DRIVER="):].strip() or None
        if not driver:
            try:
                driver = os.path.basename(os.path.realpath(os.path.join(base, "device", "driver")))
            except OSError:
                driver = None

        node = None
        try:
            n = next((x for x in os.listdir(os.path.join(base, "device", "drm"))
                      if x.startswith("renderD")), None)
            if n:
                node = os.path.join(dev, n)
        except OSError:
            pass

        acesso = "ausente"
        if node:
            if os.access(node, os.R_OK | os.W_OK):
                acesso = "ok"
            else:
                acesso = "negado" if os.path.exists(node) else "ausente"

        v = (vendor or "").lower()
        virtual = True if v in _FAB_VIRTUAIS else (
            True if driver in _DRIVERS_VIRTUAIS else (False if (v or driver) else None))
        dispositivos.append({
            "card": cartao, "fabricante": _FABRICANTES.get(v, "desconhecido"),
            "vendor": vendor, "driver": driver, "virtual": virtual,
            "renderNode": node, "acesso": acesso,
        })

    usaveis = [d for d in dispositivos if d["acesso"] == "ok"]
    negados = [d for d in dispositivos if d["acesso"] == "negado"]
    if not dispositivos:
        resumo = "nenhum dispositivo DRM neste servidor"
    elif usaveis:
        resumo = ", ".join(
            f"{d['fabricante']} ({d['driver'] or 'sem driver'}{', virtual' if d['virtual'] else ''})"
            for d in usaveis)
    elif negados:
        resumo = (f"{len(negados)} dispositivo(s) presentes e SEM ACESSO — falta o grupo 'render' "
                  "(usermod -aG render <usuario>)")
    else:
        resumo = "dispositivos presentes, sem render node utilizável"

    return {
        "sei": True,
        "dispositivos": dispositivos,
        "temGpu": bool(usaveis),
        # O portão do CUDA continua sendo reportado — mas agora ao LADO do inventário, que é o que
        # torna a variável vazia legível: "escondida do app" deixa de parecer "não existe".
        "cudaVisibleDevices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        "resumo": resumo,
    }


def segredo():
    """O segredo do cofre — e **nunca o valor dele**.

    O que se devolve é: chegou, quantos caracteres tem, e um prefixo de hash que serve para
    conferir "é o mesmo que eu guardei?" sem que o valor atravesse a rede outra vez. É o hábito que
    se quer ensinar: um app que ecoa a própria credencial põe a credencial no log de alguém.
    """
    v = os.environ.get("HELLO_SEGREDO")

    # O COFRE em disco, lido só pelas CHAVES. Sem isto a peça só sabia olhar o ambiente, e aí "não
    # guardado" e "guardado depois deste processo subir" davam a MESMA resposta — que foi
    # exatamente o que se viu ao testar: guardar, reabrir a janela, e o cartão dizer que não há
    # nada. Reabrir a janela não reinicia o processo: a janela é uma view, o backend continua o
    # mesmo. E o ambiente de um processo é fixado no start.
    #
    # Só as CHAVES. O app já recebe os valores pelo ambiente; reler valores do arquivo não
    # acrescentaria nada e ensinaria o hábito errado a quem copia este template.
    no_cofre = None
    try:
        dados = os.environ.get("VSSH_APP_DATA_DIR")
        if dados:
            with open(os.path.join(dados, "..", "secrets.json"), encoding="utf-8") as fh:
                no_cofre = list(json.load(fh).keys())
    except (OSError, ValueError):
        no_cofre = None  # ausente ou ilegível é "não sei", não "vazio"

    if not v:
        guardado_agora = isinstance(no_cofre, list) and "HELLO_SEGREDO" in no_cofre
        return {
            "definido": False,
            "noCofre": guardado_agora,
            "leitura": (
                "JÁ ESTÁ GUARDADO no cofre — este processo é que subiu antes dele. Reabrir a "
                "janela não basta: a janela é uma view, o backend continua o mesmo. Pare e inicie "
                "o app (menu de contexto da janela, ou Configurações → Serviços) para ele receber "
                "o valor."
                if guardado_agora else
                'nada guardado — use o botão "guardar HELLO_SEGREDO" aqui em cima, e depois '
                "reinicie o app"
            ),
        }
    return {
        "definido": True,
        "tamanho": len(v),
        "sha256": hashlib.sha256(v.encode("utf-8")).hexdigest()[:12],
        "leitura": "chegou pelo ambiente; o valor não sai daqui",
    }


def _por_que_vaapi_falhou(stderr, dispositivo):
    """Traduz o stderr do ffmpeg no motivo, em português, de a GPU não ter codificado.

    Existe porque as causas pedem ações OPOSTAS e chegam parecidas: uma se conserta instalando um
    driver, outra dando permissão, e a mais comum não se conserta de jeito nenhum — a placa
    simplesmente não tem encoder de vídeo, que é o caso de praticamente toda GPU virtual.
    """
    s = (stderr or "").lower()
    if not s:
        return None
    if "unknown encoder" in s:
        return "este ffmpeg foi compilado SEM VAAPI — é do pacote, não do servidor nem da placa"
    if "permission denied" in s:
        return "sem permissão no render node — falta o grupo `render` (usermod -aG render <usuario>)"

    # O diagnóstico usa o que a DESCOBERTA já sabe. A primeira versão não recebia o dispositivo e
    # por isso hesitava — "instale o driver, SE ela for física" — mesmo tendo a resposta a uma
    # função de distância. Num servidor real isso mandou procurar pacote para uma virtio, onde
    # nenhum pacote resolve.
    virtual = bool(dispositivo and dispositivo.get("virtual") is True)
    nao_inicializou = any(x in s for x in ("vainitialize", "no va display", "failed to initialise",
                                           "failed to create", "not implemented"))
    sem_entrypoint = any(x in s for x in ("entrypoint", "not supported", "unsupported"))

    if virtual and (nao_inicializou or sem_entrypoint):
        # Definitivo, e de propósito: uma resposta que deixa esperança onde não há custa mais que
        # uma resposta ruim. Quem lê isto precisa parar de procurar pacote e trocar de servidor.
        quem = dispositivo.get("fabricante") or dispositivo.get("driver")
        return (f"esta é uma GPU VIRTUAL ({quem}) — ela NÃO implementa VA-API, e nenhum pacote "
                "resolve. Ela existe para desenhar tela, não para codificar vídeo: para isso, "
                "outro servidor.")
    if nao_inicializou:
        return ("a VA-API não inicializou — driver ausente ou incompleto para esta placa "
                "(mesa-va-drivers, intel-media-va-driver ou o driver do fabricante)")
    if sem_entrypoint:
        return "a placa não expõe entrypoint de ENCODE para este perfil"
    return None


def _o_que_a_placa_sabe(node):
    try:
        saida = subprocess.run(["vainfo", "--display", "drm", "--device", node],
                               capture_output=True, text=True, timeout=15, check=True).stdout
        perfis = [l.strip() for l in saida.split("\n") if "VAEntrypoint" in l]
        return {"tem": True, "entrypoints": perfis[:40],
                "codifica": any(re.search(r"VAEntrypointEnc", l) for l in perfis)}
    except (OSError, subprocess.SubprocessError) as err:
        # `vainfo` ausente é o caso COMUM e não é erro — ele não vem instalado por padrão. Devolver
        # o erro cru seria jogar na cara de quem lê um detalhe de implementação em vez da única
        # coisa acionável: instale o pacote e a pergunta fica respondida.
        bruto = getattr(err, "stderr", None) or str(err)
        return {
            "tem": False,
            "motivo": ("o `vainfo` não está instalado neste servidor — `apt-get install -y vainfo` "
                       "e esta peça passa a listar o que a placa sabe fazer"
                       if isinstance(err, FileNotFoundError) else str(bruto).split("\n")[0][:200]),
        }


def benchmark_gpu(frames=300):
    """Descobrir não basta: um inventário não diz se a placa serve para alguma coisa.

    **Por que ffmpeg, e não CUDA.** Um benchmark de CUDA só roda onde há CUDA. VAAPI atravessa
    Intel, AMD e NVIDIA pelo mesmo render node do DRM — o mesmo caminho genérico que a descoberta
    usa. E `ffmpeg` é um pacote, não um SDK: por isso este template o DECLARA em
    `requiredPackages`, e o ambiente confere antes de instalar.

    **O número útil é a RAZÃO.** "180 fps" sozinho não diz nada — depende do vídeo, do preset, da
    máquina. O mesmo trabalho em CPU e em GPU responde a pergunta que se tem de fato: *vale a pena
    usar a placa deste servidor?*
    """
    gpu = gpu_do_servidor()
    # O dispositivo, e não só o caminho: o diagnóstico da falha precisa saber se a placa é virtual
    # para responder em vez de hesitar.
    alvo = next((d for d in (gpu.get("dispositivos") or []) if d["acesso"] == "ok"), None)
    node = alvo["renderNode"] if alvo else None

    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError):
        return {"rodou": False,
                "motivo": "ffmpeg não está neste servidor — o app o declara em requiredPackages, "
                          "então o instalador deveria ter recusado"}

    def medir(args, rotulo):
        t0 = time.perf_counter()
        try:
            # **stderr é CAPTURADO.** Descartá-lo deixa só "Command failed: ffmpeg …" — a linha de
            # comando truncada, que não diz absolutamente nada sobre o que houve. Num servidor real
            # isso virou "a GPU não codificou" sem uma pista de por quê.
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", *args],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           timeout=60, check=True)
        except subprocess.CalledProcessError as err:
            saida = (err.stderr or b"").decode("utf-8", "replace").strip()
            return {"rotulo": rotulo, "ok": False,
                    # As ÚLTIMAS linhas: o ffmpeg põe a causa no fim, e o começo costuma ser ruído.
                    "erro": (" · ".join(saida.split("\n")[-4:])[:400] if saida else str(err)[:200]),
                    "diagnostico": _por_que_vaapi_falhou(saida, alvo)}
        except (OSError, subprocess.SubprocessError) as err:
            return {"rotulo": rotulo, "ok": False, "erro": str(err)[:200], "diagnostico": None}
        ms = (time.perf_counter() - t0) * 1000
        return {"rotulo": rotulo, "ok": True, "ms": round(ms), "fps": round(frames / ms * 1000)}

    # `testsrc` é gerado pelo próprio ffmpeg: sem arquivo de entrada, sem download, sem depender de
    # nada em disco. Saída para /dev/null — o que se mede é o encode, não o I/O.
    fonte = ["-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=30:duration={frames / 30}"]
    cpu = medir([*fonte, "-c:v", "libx264", "-preset", "veryfast", "-f", "null", "-"], "cpu")
    # Sem `-hwaccel vaapi`: aquilo é para DECODIFICAR em hardware, e a fonte aqui é gerada pelo
    # próprio ffmpeg. Pedi-lo faz o erro falar do decode em vez do encode que se queria medir.
    if node:
        gpu_res = medir(["-vaapi_device", node, *fonte, "-vf", "format=nv12,hwupload",
                         "-c:v", "h264_vaapi", "-f", "null", "-"], "gpu")
    else:
        gpu_res = {"rotulo": "gpu", "ok": False,
                   "erro": "nenhum render node acessível — ver o inventário acima"}

    # A razão só existe quando os DOIS lados mediram. Inventar um número a partir de um lado que
    # falhou seria pior que não ter número nenhum.
    ganho = (round(cpu["ms"] / gpu_res["ms"], 2)
             if cpu["ok"] and gpu_res["ok"] and gpu_res["ms"] > 0 else None)
    # Só quando falhou, e só quando há placa: perguntar "o que você sabe fazer?" a uma placa que
    # acabou de codificar seria gastar segundos para confirmar o óbvio.
    capacidades = _o_que_a_placa_sabe(node) if (not gpu_res["ok"] and node) else None

    if ganho is None:
        leitura = ("não deu para comparar" if gpu_res["ok"] else
                   # O diagnóstico primeiro, o stderr depois. Quem lê quer saber o que FAZER.
                   f"a GPU não codificou — {gpu_res.get('diagnostico') or gpu_res.get('erro')}")
    elif ganho >= 1.2:
        leitura = f"a GPU deste servidor é {ganho}× mais rápida que a CPU neste trabalho"
    elif ganho <= 0.8:
        leitura = (f"a GPU é MAIS LENTA que a CPU aqui ({ganho}×) — é o que costuma acontecer com "
                   "placa virtual, e é bom saber antes de projetar em cima dela")
    else:
        leitura = f"empate técnico ({ganho}×) — a GPU deste servidor não compensa neste trabalho"

    return {"rodou": True, "frames": frames, "renderNode": node, "cpu": cpu, "gpu": gpu_res,
            "ganho": ganho, "capacidades": capacidades, "leitura": leitura}


def token_confere(esperado, recebido):
    """Comparação de tamanho fixo: hash dos dois lados antes de comparar, para não vazar prefixo
    pelo tempo nem tropeçar em comprimentos diferentes."""
    if not isinstance(recebido, str) or not recebido:
        return False
    a = hashlib.sha256(esperado.encode("utf-8")).digest()
    b = hashlib.sha256(recebido.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


class Handler(BaseHTTPRequestHandler):
    server_version = "hello-vssh-app/4.0"
    # HTTP/1.1 para o SSE poder ficar aberto e para o navegador não fechar a cada resposta. Com
    # 1.0, todo `Content-Length` vira "conexão acabou", e o stream de eventos morre no primeiro.
    protocol_version = "HTTP/1.1"

    # ── plumbing ─────────────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        # O log de acesso da stdlib vai para o stderr sem estrutura. Quem registra o que importa é
        # o `log()` do toolkit — este aqui só faria ruído no run.log.
        pass

    def _json(self, status, corpo):
        dados = json.dumps(corpo, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(dados)

    def _corpo(self):
        """O corpo JSON de uma requisição — para os POSTs que o AMBIENTE faz no seu backend.

        Corpo ilegível vira `{}` em vez de erro, de propósito: estas rotas existem para reagir a um
        clique do usuário, e derrubar a reação porque o JSON veio torto seria perder o gesto dele.
        """
        try:
            tamanho = int(self.headers.get("Content-Length") or 0)
            if tamanho <= 0 or tamanho > 64 * 1024:
                return {}
            return json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (ValueError, OSError, UnicodeDecodeError):
            return {}

    # ── roteamento ───────────────────────────────────────────────────────────

    def do_GET(self):  # noqa: N802
        self._servir()

    def do_HEAD(self):  # noqa: N802
        self._servir()

    def do_POST(self):  # noqa: N802
        self._servir()

    def do_DELETE(self):  # noqa: N802
        self._servir()

    def _servir(self):
        global contador, tarefa_em_curso
        partes = urlsplit(self.path)
        caminho = partes.path

        try:
            # O healthcheck é pollado pelo lifecycle do portal DIRETO no socket, até 15x/1s,
            # bloqueando o clique de "abrir app". Desde a Onda 4 a sondagem vai COM o
            # X-Vssh-App-Token, então gatear esta rota seria permitido. Ela fica isenta por outro
            # motivo: responde `ok` sem tocar em nada, e assim o healthcheck não depende de o token
            # estar certo para dizer se o processo subiu.
            if caminho == "/healthz":
                corpo = b"ok\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(corpo)
                return

            if APP_TOKEN and not token_confere(APP_TOKEN, self.headers.get("X-Vssh-App-Token")):
                # O socket é 0600 do dono, mas outro processo do mesmo usuário Linux o alcança.
                # Apps que dão acesso sensível (shell, arquivos) devem checar; apps triviais podem
                # simplesmente não checar.
                log("token-rejected", {"path": caminho})
                self._json(403, {"error": "token ausente ou inválido"})
                return

            # ── A tarefa longa, e o ciclo completo de uma atividade ────────────
            #
            #  1. `definir_live` a cada passo, com a MESMA chave — ela reescreve no lugar;
            #  2. a renovação do `at`, ligada uma vez no boot por `manter_live_vivo()`;
            #  3. `limpar_live` com `registrar` no fim: a atividade some e deixa UMA notificação.
            #
            # `?lento=1` é o que torna a decisão 2 OBSERVÁVEL: oito passos de 10 s passam de 80 s,
            # bem além do TTL de 60 s. Com a renovação ligada, a barra atravessa; sem ela, some no
            # meio sozinha — que é o defeito que dorme numa demonstração de seis segundos.
            if caminho == "/api/tarefa-longa" and self.command == "POST":
                lento = parse_qs(partes.query).get("lento", [None])[0] == "1"
                intervalo = 10.0 if lento else 0.8
                total = 8

                if tarefa_em_curso:
                    tarefa_em_curso.set()
                parar = threading.Event()
                tarefa_em_curso = parar

                def rodar():
                    for feito in range(1, total + 1):
                        if parar.is_set():
                            return
                        definir_live("exemplo-backend", {
                            "titulo": "Tarefa do backend",
                            "texto": f"passo {feito}" + (" (devagar — atravessa o TTL)" if lento else ""),
                            "formato": "progresso",
                            "progresso": {"feito": feito, "total": total},
                        })
                        if feito < total:
                            parar.wait(intervalo)
                    limpar_live("exemplo-backend", registrar={
                        "titulo": "Tarefa concluída", "texto": f"{total} passos", "level": "success"})

                threading.Thread(target=rodar, daemon=True).start()
                self._json(202, {"iniciada": True, "total": total,
                                 "intervalo": int(intervalo * 1000),
                                 "duracaoMs": int(total * intervalo * 1000)})
                return

            # Uma notificação de backend com `key` estável. O portal lê uma JANELA do fim do
            # journal, não um delta — então é a `key` que impede o mesmo aviso de chegar a cada
            # tick. Chamar isto dez vezes no mesmo dia rende UMA notificação.
            if caminho == "/api/avisar" and self.command == "POST":
                hoje = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                notificar("O disco do servidor está acima de 90%.",
                          title="Hello World", level="warning", chave=f"disco-cheio-{hoje}")
                self._json(200, {"notificada": True, "key": f"disco-cheio-{hoje}"})
                return

            # Uma notificação com AÇÃO. A diferença para a de cima é o `path`: sem ele, o botão da
            # notificação não teria para onde mandar a resposta. O clique pode acontecer com o app
            # sem janela nenhuma aberta.
            if caminho == "/api/avisar-com-acao" and self.command == "POST":
                notificar("O índice está desatualizado. Reconstruir agora?",
                          title="Hello World", level="warning", persistent=True,
                          actions=[{"id": "reconstruir", "label": "Reconstruir"}],
                          path="/api/acao", chave=f"indice-{int(time.time() * 1000)}")
                self._json(200, {"notificada": True, "acao": "reconstruir", "rota": "/api/acao"})
                return

            # O destino da ação. Quem faz este POST é o desktop, não o seu frontend.
            if caminho == "/api/acao" and self.command == "POST":
                corpo = self._corpo()
                # ANINHADO, e não espalhado: o corpo que o ambiente manda tem chaves próprias, e
                # espalhá-las por cima do registro sequestraria o nome do evento no log.
                log("acao-de-notificacao", {"acao": corpo})
                difundir_evento("acao", {**corpo, "em": datetime.now(timezone.utc).isoformat()})
                self._json(200, {"ok": True})
                return

            # ── A bandeja pela lib, e o clique que volta ────────────────────
            if caminho == "/api/bandeja" and self.command == "POST":
                ok = definir_bandeja({
                    "icon": "refresh",
                    "tooltip": "Hello World — posto pelo BACKEND",
                    "badge": {"dot": True},
                    "menu": [
                        {"id": "oi", "label": "Um item do menu"},
                        {"separator": True},
                        {"id": "sair", "label": "Remover este ícone", "danger": True},
                    ],
                    # Só DADOS atravessam o arquivo: aqui vai uma rota, não uma função.
                    "onClick": {"path": "/api/bandeja/clique"},
                })
                self._json(200, {"ok": ok,
                                 "motivo": None if ok else "sem VSSH_APP_DATA_DIR nem VSSH_APP_ID"})
                return

            if caminho == "/api/bandeja" and self.command == "DELETE":
                limpar_bandeja()
                self._json(200, {"ok": True})
                return

            if caminho == "/api/bandeja/clique" and self.command == "POST":
                corpo = self._corpo()
                log("clique-na-bandeja", {"clique": corpo})
                if corpo.get("menuId") == "sair":
                    limpar_bandeja()
                difundir_evento("bandeja", corpo)
                self._json(200, {"ok": True})
                return

            # O filesystem privado, servido pela lib. Ela devolve `True` quando atendeu — mesmo
            # contrato do spa, e pela mesma razão: quem compõe as rotas é o app, não a lib.
            if servir_privado(self):
                return

            if caminho == "/api/ping":
                self._json(200, {"pong": True, "appId": APP_ID,
                                 "time": datetime.now(timezone.utc).isoformat(
                                     timespec="milliseconds").replace("+00:00", "Z")})
                return

            # Exemplo de SSE. Prove que eventos chegam sem buffer: `curl -N <baseUrl>api/events`.
            #
            # O stream também entra no conjunto de conexões abertas — é o que faz a demonstração de
            # "duas janelas, um backend" funcionar: quem incrementa é uma janela, e a difusão
            # alcança todas as outras.
            if caminho == "/api/events":
                stream = abrir_stream_sse(self)
                with _tranca:
                    conexoes.add(stream)
                stream.enviar("estado", estado())

                n = 0
                try:
                    # Este laço SEGURA a thread da requisição, e é assim que tem de ser: em
                    # `http.server`, retornar do handler fecha a conexão. Sem ele o `EventSource`
                    # do navegador reconecta em laço, sem um erro sequer do lado do servidor.
                    while not stream.fechado:
                        time.sleep(1.0)
                        n += 1
                        stream.enviar("tick", {"n": n, "time": datetime.now(timezone.utc).isoformat()})
                finally:
                    stream.fechar()
                    # Sem o `discard` no fim, cada abrir-e-fechar de janela deixaria um stream morto
                    # no conjunto e o número de conexões só subiria.
                    with _tranca:
                        conexoes.discard(stream)
                    difundir()
                return

            # ── Duas janelas, um backend ────────────────────────────────────
            #
            # O contador vive AQUI, no processo. Duas janelas do mesmo app são duas visões deste
            # mesmo processo — mesmo socket, mesmo token, mesmo VSSH_APP_DATA_DIR.
            if caminho == "/api/estado" and self.command == "GET":
                self._json(200, estado())
                return

            if caminho == "/api/estado/incrementar" and self.command == "POST":
                with _tranca:
                    contador += 1
                difundir()
                self._json(200, estado())
                return

            # ── O que o AMBIENTE decidiu por este processo ──────────────────
            if caminho == "/api/runtime":
                self._json(200, {"limites": limites_do_cgroup(), "gpu": gpu_do_servidor(),
                                 "segredo": segredo()})
                return

            # O benchmark fica numa rota À PARTE, e num POST. Ele leva segundos e queima CPU:
            # pendurá-lo no `/api/runtime` faria toda abertura da galeria pagar por um número que
            # ninguém pediu.
            if caminho == "/api/gpu/benchmark" and self.command == "POST":
                self._json(200, benchmark_gpu())
                return

            # O spa devolve False quando não atendeu: 404 é decisão de quem compõe as rotas.
            if spa(self):
                return

            corpo = "não encontrado\n".encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(corpo)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(corpo)

        except Exception as err:  # noqa: BLE001
            # Sem isto, uma falha derruba a thread da requisição sem deixar rastro nenhum — e o
            # lifecycle só mostra que o app "não respondeu".
            import traceback

            log("request-failed", {"path": caminho, "message": str(err),
                                   "stack": traceback.format_exc()})
            try:
                self._json(500, {"error": "erro interno"})
            except OSError:
                pass


def main():
    try:
        servidor = criar_servidor(Handler)
    except ErroDeEndereco as err:
        # `VSSH_APP_JA_ESCUTANDO` não é falha: significa que outra instância já atende neste
        # endereço, e o lifecycle trata sair-em-silêncio como sucesso. Qualquer outro erro é fatal
        # e tem de aparecer: um backend que não escuta e não reclama vira janela em branco sem causa.
        if err.codigo == VSSH_APP_JA_ESCUTANDO:
            log("already-listening", {"message": str(err)})
            raise SystemExit(0)
        log("listen-failed", {"message": str(err), "code": err.codigo})
        print(f"[{APP_ID}] não consegui escutar: {err}", file=sys.stderr)
        raise SystemExit(1)

    log("listening", {**servidor.endereco_vssh, "appId": APP_ID,
                      "tokenRequired": bool(APP_TOKEN)})
    try:
        servidor.serve_forever()
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
