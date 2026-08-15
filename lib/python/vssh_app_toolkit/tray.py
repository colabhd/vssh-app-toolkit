"""Ícone na bandeja do desktop para um app SEM janela.

O par do `lib/node/vssh-tray.js`.

Se o seu app TEM janela, não use isto: use `vssh.tray.set()` do shim, no frontend. É síncrono, o
clique volta como callback e não passa por arquivo nenhum. Isto aqui é para `type: "engine"` e
`kind: "service"` — o daemon que sincroniza, indexa ou treina, e que não tem janela onde aparecer.

── O modelo: estado por arquivo, ação por HTTP ──

Você ESCREVE o estado; o portal lê e desenha. O usuário clica; o portal faz um POST no SEU backend.
Duas direções, dois mecanismos — e é assim porque a rede é assimétrica: o portal alcança o seu app
pelo túnel, o seu app não alcança o portal.

── Latência ──

O portal faz poll em lote, um exec por servidor a cada poucos segundos, e só enquanto houver alguém
com o desktop aberto. Escrever é barato, a mudança aparece em segundos, e não custa nada quando
ninguém está olhando. Não tente contornar isso escrevendo em laço apertado — não vai aparecer mais
rápido, e o arquivo é reescrito à toa.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

__all__ = ["definir_bandeja", "limpar_bandeja", "limpar_bandeja_ao_sair", "caminho_da_bandeja"]


def _dir(env=None):
    env = os.environ if env is None else env
    # VSSH_APP_DATA_DIR é `~/.vssh-apps/<id>/data`; o tray.json fica um nível acima, ao lado do
    # status.json que o supervisor já escreve — é o diretório que o coletor varre.
    dados = env.get("VSSH_APP_DATA_DIR")
    if dados:
        return os.path.dirname(os.path.normpath(dados))
    app_id = env.get("VSSH_APP_ID")
    if app_id:
        return os.path.join(env.get("HOME") or "", ".vssh-apps", app_id)
    return None


def caminho_da_bandeja(env=None):
    d = _dir(env)
    return os.path.join(d, "tray.json") if d else None


def definir_bandeja(item, env=None):
    """Publica (ou atualiza) o ícone deste app na bandeja.

    Um item por app. Chamar de novo substitui — o ícone não muda de lugar, que é o que importa
    quando o badge muda a cada segundo.

    Campos: `icon`, `tooltip`, `badge` (`{count}` | `{dot: True}` | `{text}`), `menu`
    (`[{id,label,icon,danger,disabled}]` ou `{separator: True}`), `onClick` (`{path}`). Só dados —
    nunca HTML, nunca função: isto atravessa um ARQUIVO.

    Devolve `False`, sem levantar, quando não há onde escrever.
    """
    arquivo = caminho_da_bandeja(env)
    if not arquivo:
        return False
    corpo = dict(item or {})
    corpo["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        os.makedirs(os.path.dirname(arquivo), exist_ok=True)
        # Escrita atômica — mesmo idioma do status.json do supervisor. Sem ela, o poll do portal
        # pode ler o arquivo pela metade e descartá-lo como JSON inválido; o sintoma seria um ícone
        # que pisca sob atualização frequente, que é justamente quando ele importa.
        tmp = arquivo + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(corpo, fh, ensure_ascii=False, default=str, separators=(",", ":"))
        os.replace(tmp, arquivo)
        return True
    except OSError as err:
        # Sem `raise`: o app tem trabalho de verdade a fazer, e ele não pode parar porque o ícone
        # não coube no disco.
        print(f"[vssh-tray] não foi possível escrever {arquivo}: {err}")
        return False


def limpar_bandeja(env=None):
    """Remove o ícone. Chame ao encerrar — ícone órfão mente sobre o estado do ambiente."""
    arquivo = caminho_da_bandeja(env)
    if not arquivo:
        return False
    try:
        os.unlink(arquivo)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def limpar_bandeja_ao_sair(env=None):
    """Liga `limpar_bandeja()` ao encerramento do processo.

    Opt-in pela mesma razão do `limpar_live_ao_sair`: instalar handler de sinal por conta própria
    numa lib é exatamente o tipo de coisa que briga com o shutdown do app — então o `SIGTERM` só é
    tomado se ninguém o tiver tomado antes.
    """
    import atexit
    import signal

    atexit.register(lambda: limpar_bandeja(env))

    try:
        if signal.getsignal(signal.SIGTERM) in (signal.SIG_DFL, None):
            def ao_terminar(sig, frame):  # noqa: ARG001
                limpar_bandeja(env)
                raise SystemExit(0)

            signal.signal(signal.SIGTERM, ao_terminar)
    except (ValueError, OSError):
        pass
