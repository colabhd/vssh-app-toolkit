#!/usr/bin/env python3
"""Palco — o player do ambiente.

O que ele substitui: hoje um vídeo aberto no ambiente vira uma aba do navegador embutido com um
`<video controls autoplay>` cru, e `.mkv`/`.avi` caem num texto de "seu navegador não suporta".

─── A decisão que manda no arquivo inteiro ──────────────────────────────────

⚠ **O backend não serve bytes quando não precisa.** `vssh.fs.urlFor(path)` já devolve uma URL do
portal com Range: um arquivo que o navegador abre sozinho toca dali, com busca nativa e **zero** CPU
no servidor. O ffmpeg só entra quando o cliente disser que não dá conta — e quem diz é o cliente,
porque a resposta muda por máquina, por sistema e por versão.

Por isso `/api/abrir` recebe o **perfil** junto com o caminho, e devolve o modo. Um servidor que
decidisse sozinho, por tabela, transcodificaria a 180% de CPU para metade das máquinas.

─── As rotas ────────────────────────────────────────────────────────────────

    POST   /api/abrir      {caminho, perfil}  → modo, duração, faixas, legendas, onde retomar
    GET    /api/fluxo      ?caminho=&t=       → o cano de MP4 fragmentado (só nos modos pagos)
    GET    /api/legenda    ?caminho=&faixa=   → VTT
    GET    /api/vizinhos   ?caminho=          → os irmãos de pasta, para o próximo e o anterior
    POST   /api/marca      {caminho, seg}     → onde a pessoa parou
    DELETE /api/marca      ?caminho=          → esquecer

Uma dependência, e ela é o toolkit. O resto é stdlib.
"""

import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

_AQUI = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_AQUI, "..", "vendor", "py")
if os.path.isdir(_VENDOR):
    sys.path.insert(0, os.path.abspath(_VENDOR))
sys.path.insert(0, _AQUI)

from vssh_app_toolkit.listen import ErroDeEndereco, VSSH_APP_JA_ESCUTANDO, criar_servidor  # noqa: E402
from vssh_app_toolkit.log import criar_log_do_app  # noqa: E402
from vssh_app_toolkit.spa import criar_spa_estatica  # noqa: E402
from vssh_app_toolkit.tray import limpar_bandeja_ao_sair  # noqa: E402
from vssh_app_toolkit.web import DIRETORIO_WEB, ESTILOS, ESTILOS_MIDIA, SCRIPTS, SCRIPTS_MIDIA, SHIMS  # noqa: E402

from decisao import decidir, perfil_de  # noqa: E402
from fluxo import enquadrar, terminador  # noqa: E402
from midia import achar_gpu, argv_de_fluxo, argv_de_legenda, sondar_arquivo  # noqa: E402
from pasta import vizinhanca  # noqa: E402
from retomar import assinatura_de, esquecer, lembrar, retomada  # noqa: E402

APP_ID = os.environ.get("VSSH_APP_ID") or "palco"
APP_TOKEN = os.environ.get("VSSH_APP_TOKEN") or None
DADOS = os.environ.get("VSSH_APP_DATA_DIR") or os.path.join("/tmp", f"{APP_ID}-data")

log = criar_log_do_app(app_id=APP_ID)
limpar_bandeja_ao_sair()

# Medido uma vez no boot, e não por requisição: enumerar `/dev/dri` a cada abertura de vídeo seria
# I/O por uma resposta que não muda enquanto o processo vive.
GPU = achar_gpu()
log("boot", {"gpu": GPU or "sem VAAPI"})

spa = criar_spa_estatica(
    root=os.path.join(_AQUI, "..", "frontend"),
    mounts={"/_vssh/": DIRETORIO_WEB},
    inject_styles=([f"_vssh/{f}" for f in ESTILOS] + [f"_vssh/{f}" for f in ESTILOS_MIDIA]
                   + ["palco.css"]),
    # `SCRIPTS_MIDIA` é o que traz a `TuffMidia` — sem ela não há trilha, nem timecode, nem o
    # chrome que some. É a peça inteira deste app, e ela é opt-in de propósito.
    inject_scripts=([f"_vssh/{s}" for s in SHIMS] + [f"_vssh/{s}" for s in SCRIPTS]
                    + [f"_vssh/{s}" for s in SCRIPTS_MIDIA] + ["palco.js"]),
    missing_bundle_hint="O frontend do Palco não está no pacote.",
    ao_avisar=lambda e: log("spa-warn", e),
)


def token_confere(esperado, recebido):
    if not esperado:
        return True
    if not recebido:
        return False
    a = hashlib.sha256(esperado.encode("utf-8")).digest()
    b = hashlib.sha256(recebido.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def _seguro(caminho):
    """Um caminho que este app aceita abrir.

    ⚠ O confinamento aqui **não** é contra o usuário: o backend roda como ele, e ele já pode ler os
    próprios arquivos por mil caminhos. É contra um bug do frontend virando um `ffmpeg` sobre
    `/dev/urandom` ou um socket — coisas que não terminam, e que travariam o app sem erro.
    """
    if not caminho or not isinstance(caminho, str):
        return None
    caminho = os.path.abspath(os.path.expanduser(caminho))
    try:
        if not os.path.isfile(caminho):
            return None
    except OSError:
        return None
    return caminho


class Handler(BaseHTTPRequestHandler):
    server_version = "palco/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _json(self, status, corpo):
        dados = json.dumps(corpo, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(dados)

    def _corpo(self):
        try:
            tamanho = int(self.headers.get("Content-Length") or 0)
            if tamanho <= 0 or tamanho > 256 * 1024:
                return {}
            return json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (ValueError, OSError, UnicodeDecodeError):
            return {}

    def _canalizar(self, argv, tipo, rotulo):
        """Roda um processo e repassa o stdout dele como corpo da resposta.

        ⚠ **Sem `Content-Length` e sem Range, de propósito** — um cano não tem tamanho conhecido e
        não dá para voltar atrás. `Accept-Ranges: none` é a resposta honesta, e é por isso que a
        busca neste modo é do lado do SERVIDOR: o frontend troca a fonte por `?t=<segundos>` e a
        `TuffMidia` recebe a régua verdadeira por `opcoes.tempo`.

        A codificação é `chunked` e não "escreva e feche": entre o app e o navegador há o portal, e
        um corpo delimitado por fechamento de conexão é o que um intermediário reenquadra errado.

        ⚠ **E o terminador `0\\r\\n\\r\\n` é CONDICIONAL, que é o conserto mais importante deste
        método.** Escrevê-lo sempre — como estava — significa que um ffmpeg que morreu no primeiro
        quadro produz um corpo *bem formado e curto*, byte a byte indistinguível de um filme que
        acabou. O navegador não tem como saber a diferença: ele dispara `ended`, e o player conclui
        que a mídia terminou. Foi assim que um `.avi` que falhou apareceu como "tocou um quadro e
        pulou para o próximo vídeo" — a falha não tinha nenhum canal para chegar até a tela.

        Deixar o corpo INCOMPLETO é o canal. Um chunked sem terminador é erro de rede para o
        navegador, `error` no `<video>`, e a interface pode dizer o que houve.
        """
        if self.command == "HEAD":
            # ⚠ Um corpo numa resposta a HEAD desalinha o enquadramento da conexão — e aqui custaria
            # ainda um ffmpeg inteiro sobre o filme para bytes que ninguém lê.
            self.send_response(200)
            self.send_header("Content-Type", tipo)
            self.send_header("Accept-Ranges", "none")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        try:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            log("ffmpeg-ausente", {"erro": str(e)})
            self._json(503, {"erro": "ffmpeg não está neste servidor"})
            return

        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Accept-Ranges", "none")
        self.send_header("Cache-Control", "no-store")
        # Sem isto, a borda segura os primeiros blocos até fechar um buffer — e o vídeo demora a
        # começar por um motivo que não está no nosso código.
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # ⚠ O `stderr` é lido numa thread, e não ignorado. Um cano de stderr cheio BLOQUEIA o
        # ffmpeg: ele para de escrever vídeo e o player congela sem nada aparecer em lugar nenhum.
        erros = []
        leitor = threading.Thread(target=lambda: erros.append(proc.stderr.read()), daemon=True)
        leitor.start()

        bytes_enviados = 0
        abortado = False
        try:
            while True:
                bloco = proc.stdout.read(64 * 1024)
                if not bloco:
                    break
                self.wfile.write(enquadrar(bloco))
                bytes_enviados += len(bloco)
        except OSError:
            # ⚠ A pessoa buscou, e o navegador abortou a requisição. Sem MATAR o processo aqui,
            # cada arraste na linha do tempo deixa um ffmpeg vivo mastigando o filme inteiro — e
            # três arrastes ocupam o servidor de todo mundo.
            abortado = True
            log("cano-abortado", {"rotulo": rotulo, "bytes": bytes_enviados})
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            self.close_connection = True

        if abortado:
            return

        # ⚠ Esperar o leitor: sem isto, `erros` costuma estar VAZIO no instante em que se lê — e o
        # log da falha sairia sem a única linha que diz o que o ffmpeg não conseguiu fazer. O prazo
        # existe porque um `stderr` que não fecha não pode segurar a resposta.
        leitor.join(timeout=2)
        saida = ((erros[0] if erros else b"") or b"").decode("utf-8", "replace")
        fim = terminador(proc.returncode, bytes_enviados)
        if not fim:
            log("ffmpeg-erro", {"rotulo": rotulo, "status": proc.returncode,
                                "bytes": bytes_enviados, "saida": saida[-800:]})
        elif saida:
            # Saiu com zero e escreveu no stderr: avisos de timestamp, faixa ignorada. Não é falha,
            # mas é exatamente o rastro que se procura quando alguém diz "tocou torto".
            log("ffmpeg-avisou", {"rotulo": rotulo, "bytes": bytes_enviados, "saida": saida[-800:]})

        try:
            self.wfile.write(fim)
            self.wfile.flush()
        except OSError:
            log("cano-abortado", {"rotulo": rotulo, "bytes": bytes_enviados})

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
        partes = urlsplit(self.path)
        caminho_url = partes.path
        q = parse_qs(partes.query)
        um = lambda k: (q.get(k) or [None])[0]  # noqa: E731

        try:
            if caminho_url == "/healthz":
                corpo = b"ok\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(corpo)
                return

            if APP_TOKEN and not token_confere(APP_TOKEN, self.headers.get("X-Vssh-App-Token")):
                log("token-rejected", {"path": caminho_url})
                self._json(403, {"erro": "token ausente ou inválido"})
                return

            if caminho_url == "/api/abrir" and self.command == "POST":
                return self._abrir(self._corpo())

            if caminho_url == "/api/fluxo" and self.command in ("GET", "HEAD"):
                return self._fluxo(um("caminho"), um("t"), um("perfil"), um("audio"))

            if caminho_url == "/api/legenda" and self.command in ("GET", "HEAD"):
                return self._legenda(um("caminho"), um("faixa"))

            if caminho_url == "/api/vizinhos" and self.command in ("GET", "HEAD"):
                return self._vizinhos(um("caminho"))

            if caminho_url == "/api/marca":
                if self.command == "POST":
                    return self._marcar(self._corpo())
                if self.command == "DELETE":
                    alvo = um("caminho")
                    if alvo:
                        esquecer(DADOS, alvo)
                    return self._json(200, {"ok": True})

            if spa(self):
                return
            self._json(404, {"erro": "rota desconhecida"})

        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            log("erro", {"path": caminho_url, "erro": repr(e)})
            try:
                self._json(500, {"erro": "falha interna"})
            except OSError:
                pass

    # ── as rotas ─────────────────────────────────────────────────────────────

    def _abrir(self, corpo):
        """Tudo que o frontend precisa saber para começar a tocar este arquivo."""
        caminho = _seguro(corpo.get("caminho"))
        if not caminho:
            return self._json(404, {"erro": "arquivo não encontrado"})

        sonda = sondar_arquivo(caminho)
        d = decidir(sonda, perfil_de(corpo.get("perfil")))
        log("abrir", {"nome": os.path.basename(caminho), "modo": d.modo,
                      "container": sonda.container})

        def faixa(f, com_canais=False):
            item = {"indice": f.indice, "codec": f.codec, "idioma": f.idioma, "titulo": f.titulo,
                    "padrao": f.padrao}
            if com_canais:
                item["canais"] = f.canais
            return item

        return self._json(200, {
            "caminho": caminho,
            "nome": os.path.basename(caminho),
            "duracao": sonda.duracao,
            "temVideo": sonda.video is not None,
            "modo": d.modo,
            "motivo": d.motivo,
            "faixaDeAudio": d.faixa_audio,
            "audios": [faixa(f, com_canais=True) for f in sonda.audios],
            # ⚠ Só as de TEXTO. Oferecer uma legenda PGS produziria uma escolha que não aparece na
            # tela — e quem usa concluiria que o player não sabe mostrar legenda.
            "legendas": [faixa(f) for f in sonda.legendas if f.e_texto],
            "retomarEm": retomada(DADOS, caminho, assinatura=assinatura_de(caminho)),
            "gpu": bool(GPU),
        })

    def _fluxo(self, caminho, t, perfil_bruto, faixa_audio=None):
        caminho = _seguro(caminho)
        if not caminho:
            return self._json(404, {"erro": "arquivo não encontrado"})

        try:
            perfil = perfil_de(json.loads(perfil_bruto)) if perfil_bruto else None
        except ValueError:
            perfil = None

        sonda = sondar_arquivo(caminho)
        d = decidir(sonda, perfil)

        # ⚠ A faixa escolhida à mão vence a automática — mas só se ela EXISTE neste arquivo. Um
        # índice inventado viraria um `-map 0:99` que o ffmpeg recusa, e o sintoma seria um vídeo
        # que não abre depois de trocar a faixa.
        if faixa_audio is not None and re.fullmatch(r"\d{1,3}", str(faixa_audio)):
            pedida = int(faixa_audio)
            escolhida = next((f for f in sonda.audios if f.indice == pedida), None)
            if escolhida is not None:
                d.faixa_audio = pedida
                # Trocar de faixa pode trocar de MODO: sair de uma AAC para a AC3 original obriga a
                # recodificar o áudio, e manter `copiar` entregaria vídeo mudo.
                toca = perfil and escolhida.codec in perfil.audio
                d.audio = "copiar" if toca else "recodificar"
                if d.modo == "direto":
                    d.modo = "remux"
        argv = argv_de_fluxo(d, caminho, inicio=int(t or 0), gpu=GPU)
        if argv is None:
            # ⚠ Modo direto: pedir o cano aqui é um bug do frontend, e responder com bytes
            # esconderia esse bug atrás de CPU gasta em silêncio. 409 nomeia o que aconteceu.
            return self._json(409, {"erro": "este arquivo toca direto; use vssh.fs.urlFor",
                                    "modo": d.modo})
        self._canalizar(argv, "video/mp4", f"fluxo:{os.path.basename(caminho)}")

    def _legenda(self, caminho, faixa):
        caminho = _seguro(caminho)
        if not caminho or faixa is None or not re.fullmatch(r"\d{1,3}", str(faixa)):
            return self._json(400, {"erro": "caminho ou faixa inválidos"})
        self._canalizar(argv_de_legenda(caminho, int(faixa)), "text/vtt; charset=utf-8",
                        f"legenda:{faixa}")

    def _vizinhos(self, caminho):
        """Os irmãos de pasta, em ordem — é o que faz "próximo" e "anterior" existirem."""
        caminho = _seguro(caminho)
        if not caminho:
            return self._json(404, {"erro": "arquivo não encontrado"})
        diretorio = os.path.dirname(caminho)
        try:
            nomes = [n for n in os.listdir(diretorio)
                     if os.path.isfile(os.path.join(diretorio, n))]
        except OSError:
            nomes = []

        lista, atual = vizinhanca(nomes, os.path.basename(caminho))
        return self._json(200, {
            "pasta": diretorio,
            "itens": [{"nome": n, "caminho": os.path.join(diretorio, n)} for n in lista],
            "atual": atual,
        })

    def _marcar(self, corpo):
        caminho = corpo.get("caminho")
        if not caminho:
            return self._json(400, {"erro": "sem caminho"})
        lembrar(DADOS, caminho, corpo.get("seg") or 0, corpo.get("dur"),
                assinatura=assinatura_de(caminho))
        return self._json(200, {"ok": True})


def main():
    try:
        servidor = criar_servidor(Handler)
    except ErroDeEndereco as e:
        if getattr(e, "codigo", None) == VSSH_APP_JA_ESCUTANDO:
            log("ja-escutando", {"erro": str(e)})
            return 0
        log("sem-endereco", {"erro": str(e)})
        return 1
    log("escutando", {**servidor.endereco_vssh, "appId": APP_ID, "gpu": bool(GPU)})
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
