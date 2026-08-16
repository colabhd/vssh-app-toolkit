"""Onde a pessoa parou.

    lembrar(dir, caminho, segundos, duracao, assinatura=None)
    retomada(dir, caminho, assinatura=None) -> segundos ou None
    esquecer(dir, caminho)
    todas(dir) -> {caminho: {…}}

Retomar é o que separa um player de um `<video>`: ninguém assiste um filme de uma vez, e
reencontrar o minuto 47 à mão é justamente o trabalho que o programa existe para não passar adiante.

⚠ **Mas lembrar sempre é pior do que não lembrar**, e as três exceções abaixo são a maior parte
deste arquivo. As marcas moram em `VSSH_APP_DATA_DIR` — nunca em OPFS, que é do navegador de uma
máquina só (critério 3.2): trocar de computador não pode apagar onde a pessoa parou.
"""

import json
import os
import tempfile

_ARQUIVO = "retomadas.json"

# Abaixo disto a pessoa abriu e fechou; não assistiu. Retomar ali põe um aviso na frente de quem
# vai começar do zero de qualquer jeito.
_MINIMO = 30

# O fim é medido pelo que FALTA, e não pela fração assistida — mas com um teto proporcional.
#
# ⚠ A proporção sozinha não separa os dois casos, e eu escrevi a regra errada antes de o teste
# mostrar: 39 s de um clipe de 40 s e 1h55 de um filme de 2 h são os DOIS ≥ 95%, e só um deles é o
# fim. O que os separa é o resto: 1 s contra 5 minutos.
#
# E o resto sozinho também erra, do outro lado: dois minutos restantes de um clipe de três minutos
# não são "os créditos". Por isso o teto proporcional — o que falta, ou 5% do filme, o que for
# menor.
_SOBRA_FINAL = 120
_SOBRA_RELATIVA = 0.05

# Sem poda o arquivo cresce a cada vídeo aberto, para sempre, e um dia alguém lê dezenas de MB de
# JSON a cada requisição. A poda é por recência, porque o que interessa é o que se estava vendo.
_TETO = 200


def _caminho(dir_dados):
    return os.path.join(dir_dados, _ARQUIVO)


def todas(dir_dados):
    """Tudo que está guardado. Arquivo ausente ou corrompido vira `{}`.

    ⚠ Corrompido **não** levanta: um JSON truncado (disco cheio, processo morto no meio da
    escrita) não pode virar 500 numa tela de vídeo. Perder as marcas é chato; não conseguir abrir
    o filme é outra coisa.
    """
    try:
        with open(_caminho(dir_dados), encoding="utf-8") as fh:
            dados = json.load(fh)
        return dados if isinstance(dados, dict) else {}
    except (OSError, ValueError):
        return {}


def _gravar(dir_dados, dados):
    """Escrita atômica: arquivo temporário no MESMO diretório, e depois `replace`.

    Sem isto, um processo morto no meio da escrita deixa o arquivo pela metade — e a próxima
    leitura perde todas as marcas de uma vez, não só a que estava sendo escrita.
    """
    os.makedirs(dir_dados, exist_ok=True)
    fd, temporario = tempfile.mkstemp(dir=dir_dados, prefix=".retomadas-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(dados, fh, ensure_ascii=False)
        os.replace(temporario, _caminho(dir_dados))
    except OSError:
        try:
            os.unlink(temporario)
        except OSError:
            pass


def _terminou(segundos, duracao):
    if not duracao or duracao <= 0:
        return False
    return (duracao - segundos) <= min(_SOBRA_FINAL, duracao * _SOBRA_RELATIVA)


def lembrar(dir_dados, caminho, segundos, duracao=None, assinatura=None):
    """Guarda onde parou — ou apaga a marca, quando parar quis dizer terminar."""
    segundos = max(0, int(segundos or 0))
    dados = todas(dir_dados)

    # ⚠ Terminar APAGA, e não apenas deixa de gravar: havia uma marca do meio da sessão, e mantê-la
    # faria a pessoa reabrir nos créditos semanas depois. É o defeito clássico de "continuar
    # assistindo", e o mais irritante deles.
    if segundos < _MINIMO or _terminou(segundos, duracao):
        dados.pop(caminho, None)
        _gravar(dir_dados, dados)
        return

    # A ordem do dicionário é a ordem de inserção desde o 3.7, e é ela que dá a recência de graça:
    # regravar move a chave para o fim.
    dados.pop(caminho, None)
    dados[caminho] = {"seg": segundos, "dur": duracao, "sig": assinatura}

    if len(dados) > _TETO:
        for velha in list(dados)[: len(dados) - _TETO]:
            dados.pop(velha, None)

    _gravar(dir_dados, dados)


def retomada(dir_dados, caminho, assinatura=None):
    """Onde retomar este arquivo, ou `None`."""
    marca = todas(dir_dados).get(caminho)
    if not isinstance(marca, dict):
        return None

    # ⚠ `~/Vídeos/aula.mkv` é um nome que se reusa. Sem conferir, a marca da aula passada manda a
    # aula nova começar aos 40 min, e a pessoa conclui que baixou o arquivo errado.
    #
    # Uma marca SEM assinatura continua valendo: ela foi gravada antes de o campo existir, e perder
    # o histórico de alguém para estrear uma checagem é caro demais.
    guardada = marca.get("sig")
    if assinatura is not None and guardada is not None and guardada != assinatura:
        return None

    try:
        return int(marca["seg"])
    except (KeyError, TypeError, ValueError):
        return None


def esquecer(dir_dados, caminho):
    dados = todas(dir_dados)
    if dados.pop(caminho, None) is not None:
        _gravar(dir_dados, dados)


def assinatura_de(caminho):
    """`tamanho:mtime` — o mesmo par que o gerenciador de arquivos usa para dizer "mudou"."""
    try:
        st = os.stat(caminho)
        return f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return None
