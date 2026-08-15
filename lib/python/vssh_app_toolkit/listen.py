"""Onde o backend de um vssh-app escuta, num lugar só.

O par do `lib/node/app-listen.js`, e as razões são as mesmas — vale relê-las, porque elas foram
MEDIDAS: numa máquina com 23 portas de app em escuta, **14 responderam a um GET sem token**, 10 com
200 e 4 com 500, e 12 delas pertenciam a outras contas Linux. O loopback não tem dono. Um socket
unix dentro de `~/.vssh-apps/<id>/` — diretório que o `vssh-app-run` já cria 0700 — faz com
permissão de arquivo o que a conferência de `X-Vssh-App-Token` só prometia.

── Por que uma lib, e não três linhas em cada app ──

Porque são as mesmas três armadilhas do lado Node, e mais uma que só existe aqui:

1. **O arquivo de socket sobrevive ao processo.** Com TCP, morrer libera a porta; com socket unix,
   o inode fica no disco e o `bind()` seguinte falha com `EADDRINUSE`. Quem não limpa fica morto
   até alguém apagar um arquivo à mão.
2. **O modo do arquivo vem do umask**, e um umask frouxo (0022) cria o socket 0755 — conectável por
   qualquer um se o diretório algum dia deixar de ser 0700. Duas defesas, não uma.
3. **Limpar o órfão não pode derrubar o vivo.** A checagem é uma TENTATIVA DE CONEXÃO, nunca um
   `os.path.exists`: apagar pelo simples fato de o arquivo existir mata a instância que está
   atendendo agora, e o sintoma ("o app reinicia sozinho quando alguém o abre duas vezes") não
   aponta para cá.
4. **`BaseHTTPRequestHandler` supõe um endereço TCP.** Num `AF_UNIX` o `client_address` é uma
   string vazia, e o `address_string()` da stdlib — usado no log de acesso — quebra ou mente. Quem
   descobre isso é quem vê o primeiro traceback dentro de uma requisição que funcionou.

── Um endereço só: VSSH_APP_SOCKET ──

`VSSH_APP_PORT` não é aceito, e a razão é a mesma que o tirou da lib Node na v4: era um band-aid que
contava o problema tarde. Quem protege essa compatibilidade é o `minShellVersion` do manifesto,
conferido pelo PORTAL na instalação — um portão onde o erro é barato, em vez de um fallback em
runtime que deixa a porta exposta enquanto escreve um aviso num log que ninguém lê.
"""

from __future__ import annotations

import os
import socket
import socketserver
import stat as _stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: F401  (reexport útil)

__all__ = [
    "endereco_do_ambiente",
    "limpar_socket_orfao",
    "criar_servidor",
    "ServidorUnix",
    "ErroDeEndereco",
    "VSSH_APP_JA_ESCUTANDO",
    "VSSH_APP_SEM_ENDERECO",
    "VSSH_APP_SERVIDOR_ANTIGO",
]

VSSH_APP_JA_ESCUTANDO = "VSSH_APP_JA_ESCUTANDO"
VSSH_APP_SEM_ENDERECO = "VSSH_APP_SEM_ENDERECO"
VSSH_APP_SERVIDOR_ANTIGO = "VSSH_APP_SERVIDOR_ANTIGO"


class ErroDeEndereco(RuntimeError):
    """Falha ao descobrir ou tomar o endereço deste app.

    O `codigo` é o que quem chama consulta — a MENSAGEM é para gente, e muda; o código é contrato.
    Os três casos pedem ações diferentes, e é por isso que não são um erro só.
    """

    def __init__(self, mensagem: str, codigo: str):
        super().__init__(mensagem)
        self.codigo = codigo


def endereco_do_ambiente(env=None):
    """O endereço que este processo deve usar, lido do ambiente.

    Exportado à parte porque um app às vezes precisa DIZER onde está (log de boot, healthcheck
    próprio) sem escutar de novo.

    Devolve ``{"transporte": "socket", "caminho": "..."}``.
    """
    env = os.environ if env is None else env

    caminho = (env.get("VSSH_APP_SOCKET") or "").strip()
    if caminho:
        return {"transporte": "socket", "caminho": caminho}

    # A mensagem distingue os dois jeitos de chegar aqui, porque o conserto é diferente em cada um.
    # Um `VSSH_APP_PORT` presente e sozinho não é "faltou variável": é um servidor cujo
    # `vssh-app-run` é anterior à Onda 9, e dizer isso pelo nome poupa quem for depurar de procurar
    # o defeito dentro do app.
    if (env.get("VSSH_APP_PORT") or "").strip():
        raise ErroDeEndereco(
            "Veio VSSH_APP_PORT, mas não VSSH_APP_SOCKET: este servidor tem um `vssh-app-run` "
            "anterior à Onda 9. Desde a v4 do toolkit o endereço de um app é um socket unix, e "
            "esta lib não binda porta. Atualize o provisionamento do servidor — o "
            "`minShellVersion` do manifesto existe para o PORTAL recusar esta combinação antes de "
            "ela chegar aqui.",
            VSSH_APP_SERVIDOR_ANTIGO,
        )

    raise ErroDeEndereco(
        "VSSH_APP_SOCKET não veio do lifecycle. Rodando à mão? Defina: "
        "VSSH_APP_SOCKET=/tmp/meu-app.sock",
        VSSH_APP_SEM_ENDERECO,
    )


def limpar_socket_orfao(caminho: str) -> str:
    """Remove um socket órfão — arquivo que existe e que ninguém atende.

    NUNCA remove um socket VIVO: a checagem é uma tentativa de conexão, não um `exists`.

    Devolve ``"inexistente"``, ``"vivo"`` ou ``"removido"``.
    """
    if not os.path.lexists(caminho):
        return "inexistente"

    sonda = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sonda.settimeout(2.0)
    try:
        sonda.connect(caminho)
        return "vivo"
    except socket.timeout:
        # Alguém aceitou a conexão e travou. Não é órfão: está de pé, só ocupado.
        return "vivo"
    except OSError:
        # ECONNREFUSED e cia.: o inode existe e ninguém escuta. É o órfão.
        try:
            os.unlink(caminho)
            return "removido"
        except FileNotFoundError:
            return "inexistente"
    finally:
        sonda.close()


class ServidorUnix(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """Um `ThreadingHTTPServer` que fala por socket unix.

    A stdlib não traz esta combinação pronta, e as três linhas abaixo são exatamente o que falta.
    """

    # Sem isto, o `bind` seguinte a uma queda pode tropeçar no inode remanescente — e o
    # `limpar_socket_orfao` já cuidou do caso legítimo.
    allow_reuse_address = True
    # Uma thread que não é daemon segura o processo depois do `shutdown()`, e o app "não encerra"
    # sem nada dizendo por quê.
    daemon_threads = True

    def get_request(self):
        """Entrega um `client_address` que o `BaseHTTPRequestHandler` sabe ler.

        Num `AF_UNIX` o endereço do par é a string vazia, e a stdlib supõe uma tupla
        ``(host, porta)`` — `address_string()` devolve `''` no melhor caso e quebra no pior, DENTRO
        do tratamento de uma requisição que estava indo bem. A tupla abaixo é a tradução honesta:
        não há host nem porta do outro lado, e o nome diz isso.
        """
        conexao, _ = super().get_request()
        return conexao, ("socket-unix", 0)

    def handle_error(self, request, client_address):
        """Cliente que some não é incidente, e não pode parecer um.

        O padrão da stdlib despeja um traceback de 15 linhas no stderr — que num vssh-app é o
        `run.log` que a pessoa abre para descobrir o que houve. E o gatilho mais comum é o mais
        inocente possível: fechar a aba durante um stream SSE, ou um cliente que desiste no meio
        de um download. Medido: um `timeout` cortando um `curl -N` produzia
        `Exception occurred during processing of request` com "Bad request syntax" logo abaixo —
        um susto por requisição, e o log do app virando palheiro na hora em que ele mais serve.

        O que NÃO é silenciado: qualquer outra exceção continua indo para o stderr, com o
        traceback inteiro. Um defeito de verdade não pode aprender a se esconder atrás desta
        conveniência.
        """
        import sys as _sys

        erro = _sys.exc_info()[1]
        if isinstance(erro, (ConnectionError, BrokenPipeError, ConnectionResetError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def criar_servidor(handler_class, env=None, modo=0o600, classe_do_servidor=ServidorUnix):
    """Cria o servidor já bindado no endereço que o ambiente mandou.

    Diferente do lado Node — lá se cria o servidor e depois se chama `listen()`; aqui o `bind`
    acontece no construtor, então quem entrega o servidor pronto é a lib. Chame `serve_forever()`.

    Levanta `ErroDeEndereco` com `codigo == VSSH_APP_JA_ESCUTANDO` quando outra instância já
    atende — o que **não é erro de programação**: significa que o app já está de pé, e o lifecycle
    trata sair com 0 como sucesso.
    """
    alvo = endereco_do_ambiente(env)
    caminho = alvo["caminho"]

    diretorio = os.path.dirname(caminho)
    if diretorio:
        os.makedirs(diretorio, mode=0o700, exist_ok=True)

    if limpar_socket_orfao(caminho) == "vivo":
        raise ErroDeEndereco(
            f"Já há um backend atendendo em {caminho}.", VSSH_APP_JA_ESCUTANDO
        )

    servidor = classe_do_servidor(caminho, handler_class)
    # Depois do bind, porque antes dele o arquivo não existe. O diretório 0700 já basta; isto é a
    # segunda defesa, para o dia em que ele mudar de modo por outra razão.
    try:
        os.chmod(caminho, _stat.S_IMODE(modo))
    except OSError:
        pass  # o diretório já protege

    servidor.endereco_vssh = {"transporte": "socket", "endereco": caminho}
    return servidor
