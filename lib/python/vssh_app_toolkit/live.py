"""O que o seu app está fazendo AGORA, para quem não tem janela.

O par do `lib/node/vssh-live.js`.

── Três coisas diferentes, e escolher errado custa a atenção de quem usa ──

    notify   um FATO que aconteceu. Vai para o histórico do sino, e fica.
    tray     um ÍCONE com badge. Cabe num símbolo e um número.
    live     uma CONDIÇÃO que é verdade AGORA, com título, texto e barra.
             "Sincronizando 340 de 550" — e some quando acaba.

A atividade **não deixa rastro**. Uma sincronização que terminou não é um fato a guardar; se o FIM
dela for (porque falhou, ou porque o número final interessa), encerre com `registrar`, e aí ela
vira uma notificação — uma só.

── O `at`, e por que ele é OBRIGATÓRIO ──

Um arquivo chamado `live` sobrevive a um `kill -9`. Sem prazo de validade, o primeiro processo que
morrer no meio prega "Sincronizando 3 de 12" no painel do usuário para sempre — e o módulo cujo
propósito inteiro é dizer o que está acontecendo agora vira o que mais engana.

Por isso o portal exige `at` (epoch ms) e descarta o que passa ~60 s sem renovar. `definir_live`
escreve o carimbo a cada chamada; se a sua atividade fica minutos sem novidade, chame
`manter_live_vivo()` uma vez e esqueça.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

__all__ = [
    "definir_live",
    "limpar_live",
    "manter_live_vivo",
    "limpar_live_ao_sair",
    "caminho_do_live",
]

# Renovação um pouco abaixo da metade do TTL do portal (60 s): dois tiques perdidos ainda cabem
# dentro do prazo, então uma pausa do interpretador não apaga a atividade sozinha.
_RENOVA_S = 20.0

_vivas = {}
_tranca = threading.Lock()


def _dir(env=None):
    env = os.environ if env is None else env
    # O journal e o `live/` são do USUÁRIO, não do app: um lugar só, com todos os apps dele
    # dentro. É o que permite ao portal ler tudo num exec por usuário.
    home = env.get("HOME") or ""
    return os.path.join(home, ".vssh-notifications", "live") if home else None


def _chave_valida(chave):
    """`[a-z0-9:_-]`, até 64 — o mesmo que o coletor aceita, conferido dos dois lados."""
    return isinstance(chave, str) and re.fullmatch(r"[a-z0-9:_-]{1,64}", chave, re.IGNORECASE)


def caminho_do_live(chave, env=None):
    d = _dir(env)
    return os.path.join(d, f"{chave}.json") if d and _chave_valida(chave) else None


def definir_live(chave, item, env=None):
    """Declara (ou atualiza) uma atividade.

    A mesma chave SUBSTITUI no lugar — é o ponto: relatar progresso não empilha vinte linhas no
    painel de quem está trabalhando.

    Campos: `titulo`, `texto`, `level`, `formato` (`simples`/`progresso`), `progresso`
    (`{feito,total}` ou `{indeterminado: True}`), `acoes`. Só dados.

    Devolve `False`, sem levantar, quando não há onde escrever (rodando fora do VSSH). Atividade é
    enfeite do ambiente: um app não deve morrer por não conseguir mostrar uma barra.
    """
    arquivo = caminho_do_live(chave, env)
    if not arquivo:
        return False
    corpo = dict(item or {})
    corpo["at"] = int(time.time() * 1000)
    try:
        os.makedirs(os.path.dirname(arquivo), exist_ok=True)
        # Escrita atômica, como o tray.json: sem ela o poll do portal pode ler o arquivo pela
        # metade e descartá-lo como JSON inválido — e o sintoma seria a barra piscando justamente
        # sob atualização frequente, que é quando ela importa.
        tmp = arquivo + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(corpo, fh, ensure_ascii=False, default=str, separators=(",", ":"))
        os.replace(tmp, arquivo)
        with _tranca:
            _vivas[chave] = item
        return True
    except OSError as err:
        print(f"[vssh-live] não foi possível escrever {arquivo}: {err}")
        return False


def limpar_live(chave, registrar=None, env=None):
    """Encerra a atividade.

    Sem `registrar`, ela **some e não deixa rastro** — é o certo para uma indisponibilidade que foi
    resolvida: "o disco voltou" não é um fato que alguém precise reler amanhã.
    """
    arquivo = caminho_do_live(chave, env)
    if not arquivo:
        return False
    with _tranca:
        _vivas.pop(chave, None)
    try:
        # A ordem importa: a notificação PRIMEIRO, o arquivo depois.
        #
        # O coletor lê ESTADO — ele diffa presença de arquivo —, então não há como pedir "encerre E
        # registre" pelo próprio `live/`. Registrando antes de apagar, o pior caso de uma queda no
        # meio é a atividade continuar na tela até o TTL, que é recuperável. Na ordem inversa, o
        # pior caso é a atividade sumir sem nunca ter contado como terminou.
        if registrar:
            try:
                from .notify import notificar

                notificar(
                    str(registrar.get("texto") or registrar.get("body") or ""),
                    title=registrar.get("titulo") or registrar.get("title"),
                    level=registrar.get("level"),
                    # `chave` estável na da atividade: um retry que termine de novo substitui em vez
                    # de empilhar dois "concluído" para a mesma coisa.
                    chave=f"live:{chave}",
                    env=env,
                )
            except Exception as err:  # noqa: BLE001 - registrar o fim não pode derrubar o encerrar
                print(f"[vssh-live] não foi possível registrar o fim de {chave}: {err}")
        try:
            os.unlink(arquivo)
        except FileNotFoundError:
            pass
        return True
    except OSError:
        return False


def manter_live_vivo(env=None):
    """Mantém o `at` renovado enquanto as atividades deste processo estiverem vivas.

    Opt-in, e a thread é `daemon`: uma lib que segura o processo impede o seu app de encerrar, e
    isso é pior que uma barra que expira.

    Devolve a função que para a renovação.
    """
    parar = threading.Event()

    def laco():
        while not parar.wait(_RENOVA_S):
            with _tranca:
                itens = list(_vivas.items())
            for chave, item in itens:
                definir_live(chave, item, env=env)

    t = threading.Thread(target=laco, name="vssh-live-keepalive", daemon=True)
    t.start()
    return parar.set


def limpar_live_ao_sair(env=None):
    """Liga a limpeza ao encerramento do processo.

    Vale a pena ligar: o TTL cobre o `kill -9`, mas 60 s de "sincronizando" depois de um Ctrl+C
    limpo é um minuto de mentira que dava para não contar.

    `atexit` cobre a saída normal e o `SIGINT` (que vira `KeyboardInterrupt`). Para `SIGTERM` — que
    é como o lifecycle encerra um app — é preciso um handler, e ele só é instalado se ainda não
    houver outro: sobrescrever o handler do app seria uma lib decidindo como ele encerra.
    """
    import atexit
    import signal

    def adeus(*_):
        for chave in list(_vivas.keys()):
            limpar_live(chave, env=env)

    atexit.register(adeus)

    try:
        if signal.getsignal(signal.SIGTERM) in (signal.SIG_DFL, None):
            def ao_terminar(sig, frame):  # noqa: ARG001
                adeus()
                raise SystemExit(0)

            signal.signal(signal.SIGTERM, ao_terminar)
    except (ValueError, OSError):
        # Fora da thread principal não dá para instalar handler — e não é erro: o `atexit` acima
        # continua valendo para a saída normal.
        pass
