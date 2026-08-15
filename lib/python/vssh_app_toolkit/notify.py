"""Avisar o usuário a partir do BACKEND, sem janela aberta.

O par do `lib/node/vssh-notify.js`.

Se o seu app TEM janela, não use isto: use `vssh.notify()` do shim, no frontend. É síncrono, as
ações voltam por `postMessage` e não passa por arquivo nenhum. Isto aqui é para `type: "engine"` e
`kind: "service"` — o daemon que sincroniza, indexa ou faz backup e precisa avisar com o desktop
FECHADO. É o caso que o centro de notificações existe para resolver: o backup falhou às 3h da manhã
e ninguém ficou sabendo.

── O `id`, que é a razão desta lib existir ──

O portal manda uma JANELA do fim do arquivo, não um delta exato — de propósito, para sobreviver a
truncar e rotacionar. Quem impede a mesma notificação de chegar a cada tick é o `id`, e errá-lo tem
dois lados, ambos silenciosos:

    id que se REPETE entre eventos diferentes  → o segundo evento nunca aparece;
    id que MUDA para o mesmo evento            → a mesma coisa avisa várias vezes.

Por isso o padrão é gerar um id único por chamada, e `chave` é como se pede idempotência.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time

__all__ = ["notificar", "caminho_do_journal"]

# O journal é do USUÁRIO, não do app: um arquivo só, com todos os apps dele dentro. É o que permite
# ao portal ler tudo num `tail` por usuário em vez de um glob por app.
_DIR = ".vssh-notifications"
_JOURNAL = "journal.ndjson"

# Rotação: acima disto o arquivo é reescrito com as últimas linhas. O teto de linhas mantidas é
# MUITO maior que a janela que o portal lê (~50), de propósito — cortar perto da janela arriscaria
# apagar algo que ainda não foi entregue.
_MAX_BYTES = 256 * 1024
_MANTER_LINHAS = 200

_NIVEIS = ("info", "success", "warning", "error")

_tranca = threading.Lock()


def _home(env=None):
    env = os.environ if env is None else env
    if env.get("HOME"):
        return env["HOME"]
    # Sem HOME (systemd sem `User=`, container magro): a home dá para deduzir do
    # VSSH_APP_DATA_DIR, que é `<home>/.vssh-apps/<id>/data`.
    dados = env.get("VSSH_APP_DATA_DIR")
    if dados:
        return os.path.abspath(os.path.join(dados, "..", "..", ".."))
    return None


def caminho_do_journal(env=None):
    h = _home(env)
    return os.path.join(h, _DIR, _JOURNAL) if h else None


def _id_de(app_id, chave):
    """`chave` vira id LEGÍVEL quando dá, e hash quando não dá — um journal é lido por gente."""
    limpa = re.sub(r"[^\w.:-]+", "-", str(chave))[:80]
    if limpa and limpa != "-":
        return f"{app_id}:{limpa}"
    return f"{app_id}:{hashlib.sha1(str(chave).encode('utf-8')).hexdigest()[:16]}"


def notificar(corpo, title=None, level=None, chave=None, actions=None, persistent=False,
              path=None, app_id=None, at=None, env=None):
    """Acrescenta uma notificação ao journal do usuário.

    Devolve o `id` gravado, ou `None` quando não havia onde escrever.

    `path` é a rota do SEU backend que recebe o POST quando o usuário clica numa ação — sem ela, um
    botão de notificação não teria para onde mandar a resposta.

    Não levanta: um app tem trabalho de verdade a fazer, e ele não pode parar porque um aviso não
    coube no disco. Fora do VSSH devolve `None` sem barulho.
    """
    env = os.environ if env is None else env
    arquivo = caminho_do_journal(env)
    if not arquivo:
        return None

    app_id = str(app_id or env.get("VSSH_APP_ID") or "app")[:64]
    if chave not in (None, ""):
        ident = _id_de(app_id, chave)
    else:
        # Sem `chave`, cada chamada é um evento novo. Tempo + aleatório, e não um contador:
        # contador reinicia com o processo, e aí o id de ontem volta a existir — o portal o
        # reconheceria como já entregue e o aviso sumiria em silêncio.
        ident = f"{app_id}:{int(time.time() * 1000):x}-{secrets.token_hex(4)}"

    entrada = {
        "id": ident,
        "appId": app_id,
        "body": str(corpo if corpo is not None else "")[:500],
        # `at` é do EMISSOR, não da entrega: um evento que aconteceu com o desktop fechado tem de
        # mostrar a hora em que aconteceu, não a hora em que alguém abriu o navegador.
        "at": int(at) if isinstance(at, (int, float)) else int(time.time() * 1000),
    }
    if title:
        entrada["title"] = str(title)[:120]
    if level in _NIVEIS:
        entrada["level"] = level
    if persistent:
        entrada["persistent"] = True
    if actions:
        entrada["actions"] = [
            {"id": a["id"], "label": a["label"]}
            for a in actions
            if isinstance(a, dict) and isinstance(a.get("id"), str) and isinstance(a.get("label"), str)
        ][:3]
    if path:
        entrada["onAction"] = {"path": str(path)}

    try:
        with _tranca:
            os.makedirs(os.path.dirname(arquivo), exist_ok=True)
            # Uma linha, uma escrita, modo append. O `json.dumps` já escapa quebra de linha do
            # corpo — o que garante que uma notificação de várias linhas não vire várias entradas
            # meio quebradas, que é como um formato de linha se corrompe com dado VÁLIDO.
            with open(arquivo, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entrada, ensure_ascii=False, separators=(",", ":")) + "\n")
            _rotacionar(arquivo)
        return ident
    except OSError as err:
        print(f"[vssh-notify] não foi possível escrever {arquivo}: {err}")
        return None


def _rotacionar(arquivo):
    """Corta o journal quando ele passa do teto, mantendo as últimas linhas.

    Reescreve por temporário + rename: o rename é atômico, então o portal nunca lê um journal pela
    metade. Sem isso, o corte aconteceria exatamente no instante em que o poll está lendo — e o
    sintoma seria notificação perdida de vez em quando, sem nada no log.
    """
    try:
        if os.path.getsize(arquivo) <= _MAX_BYTES:
            return
        with open(arquivo, "r", encoding="utf-8") as fh:
            linhas = [l for l in fh.read().split("\n") if l.strip()]
        tmp = arquivo + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("\n".join(linhas[-_MANTER_LINHAS:]) + "\n")
        os.replace(tmp, arquivo)
    except OSError as err:
        # Falhar em rotacionar não pode falhar a notificação: ela já está no arquivo.
        print(f"[vssh-notify] rotação falhou: {err}")
