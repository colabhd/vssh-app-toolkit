"""Log estruturado em `$VSSH_APP_DATA_DIR`, para depurar um vssh-app remoto.

O par do `lib/node/app-log.js`. Vale a mesma frase: **comece por esta peça, na primeira linha de
código**. Quando um app se comporta mal num servidor, o que você tem é um frame minificado no
console do navegador — e frame minificado sustenta hipótese, não conclusão. Uma linha por falha,
com operação e caminho, dá a resposta:

    {"ts":"…","event":"op-failed","op":"stat","path":"…/graphs-txid.edn","code":"ENOENT"}

O lifecycle já guarda stdout/stderr em `~/.vssh-apps/<id>/run.log`, mas esse arquivo é rotacionado a
cada start; o log próprio em `$VSSH_APP_DATA_DIR` sobrevive a reinício e é estruturado. Os dois se
complementam em vez de competir.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone

__all__ = ["criar_log_do_app"]


def criar_log_do_app(app_id=None, data_dir=None, arquivo="app.log", stdout=True, env=None):
    """Devolve `log(evento, detalhe=None)`.

    O retorno carrega `.caminho` — um app às vezes precisa DIZER onde está escrevendo (é a primeira
    pergunta de quem for depurar).
    """
    env = os.environ if env is None else env

    app_id = app_id or env.get("VSSH_APP_ID") or "vssh-app"
    data_dir = data_dir or env.get("VSSH_APP_DATA_DIR") or os.path.join(
        os.path.expanduser("~"), ".vssh-apps", app_id, "data"
    )
    caminho = os.path.join(data_dir, arquivo)

    # O `http.server` atende cada requisição numa thread, então duas falhas simultâneas escrevem ao
    # mesmo tempo. Sem o lock, uma linha entra no meio da outra e o NDJSON deixa de ser lido por
    # máquina — justamente no incidente em que há muitas falhas juntas, que é quando ele importa.
    tranca = threading.Lock()
    estado = {"arquivo": None}

    def log(evento, detalhe=None):
        entrada = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "event": evento,
        }
        if detalhe:
            entrada.update(detalhe)
        # `default=str` para que um objeto que não serializa (um `Path`, uma exceção) vire texto em
        # vez de derrubar o log — perder a linha é perder justamente o diagnóstico.
        #
        # `separators` compactos: é NDJSON, uma linha por evento, lido por máquina — e é o que o
        # lado Node escreve. Sem isto o mesmo app produz logs diferentes conforme o runtime, e um
        # `grep '"event":"listening"'` que funciona num não funciona no outro.
        linha = json.dumps(entrada, ensure_ascii=False, default=str, separators=(",", ":")) + "\n"

        if stdout:
            sys.stdout.write(linha)
            sys.stdout.flush()

        with tranca:
            try:
                if estado["arquivo"] is None:
                    os.makedirs(data_dir, exist_ok=True)
                    estado["arquivo"] = open(caminho, "a", encoding="utf-8")
                estado["arquivo"].write(linha)
                estado["arquivo"].flush()
            except OSError:
                # Se nem o log grava, não há para onde reportar — seguir servindo é melhor que
                # morrer por causa do diagnóstico.
                pass

    log.caminho = caminho
    return log
