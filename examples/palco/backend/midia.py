"""ffprobe e ffmpeg — o argv, e a execução fina em cima dele.

    argv_de_sonda(caminho)                  -> ffprobe … -print_format json
    argv_de_fluxo(decisao, caminho, …)      -> ffmpeg … pipe:1, ou None no modo direto
    argv_de_legenda(caminho, indice)        -> ffmpeg … -f webvtt pipe:1
    sondar_arquivo(caminho)                 executa o ffprobe e devolve a Sonda

⚠ **Um ffmpeg mal montado não falha.** Ele roda, escreve bytes, sai com zero, e o `<video>` do
outro lado não toca nada — sem stderr para ler e sem status para conferir. Por isso o argv é
construído aqui, num lugar só, com teste: é a única forma de esses erros terem onde ser presos.

⚠ **Sempre lista, nunca string de shell.** O caminho vem do sistema de arquivos de quem usa e pode
conter espaço, aspas e `$(...)`. Como elemento de argv isso é um nome de arquivo; interpolado numa
string de shell, é execução de comando.
"""

import json
import os
import subprocess

from decisao import sondar

# Os três `movflags` que fazem um MP4 existir num CANO. ⚠ **Medido** em `test_ffmpeg_real.py`, e a
# medição desmentiu o que eu tinha escrito aqui antes:
#
#   frag_keyframe       é o que torna o cano possível. Um MP4 normal guarda o índice (`moov`) e o
#                       ffmpeg volta ao começo para escrevê-lo — num cano não há como voltar, e SEM
#                       movflags nenhum ele RECUSA, alto: "muxer does not support non seekable
#                       output", status 127, zero byte. (Eu havia escrito que ele saía com status
#                       zero e entregava lixo. Não sai: falha, e diz o motivo.)
#   empty_moov          é o que faz aparecerem caixas `moof`. Sem ele o cano flui igual — primeiro
#                       byte em 0,03 s nos dois casos —, mas a saída não é fMP4 de verdade, e fMP4
#                       é o que o MSE exige. É para lá que a Fase 7, com dash.js, vai.
#   default_base_moof   offsets relativos ao fragmento, que é a forma que o MSE espera ler.
_MOVFLAGS = "+frag_keyframe+empty_moov+default_base_moof"

# ⚠ **O teto de tempo do fragmento, e ele é o que separa "toca" de "toca aos trancos".**
#
# `frag_keyframe` sozinho corta só em keyframe, então o fragmento tem o tamanho do GOP — e o player
# não desenha nada antes de o fragmento FECHAR. Num encode de acervo (GOP de 250 quadros, ~8 s) isso
# significa esperar o GOP inteiro para o primeiro quadro, e esperar de novo a cada trecho. Num filme
# a 5 Mbps são ~6 MB de espera por trecho: o vídeo toca um pedaço, para, toca outro.
#
# Medido sobre um AVI 1280x720 de 20 s com GOP de 250:
#
#     sem frag_duration    1º quadro após 318 KB   ·   maior lacuna 317 KB
#     2 s                             95 KB        ·                97 KB   (+0,16%)
#     1 s                             60 KB        ·                62 KB   (+0,43%)
#     0,5 s                           43 KB        ·                44 KB   (+0,96%)
#
# 1 s é onde a curva vira: metade da espera de 2 s por menos de meio por cento de bytes, e daí para
# baixo o retorno cai. Os timestamps não mudam em nenhum dos casos — 600 pacotes, nenhum fora de
# ordem, mesma duração —, ou seja, o preço é só cabeçalho de fragmento.
#
# `frag_keyframe` FICA: os dois juntos cortam no que vier primeiro, e manter o corte alinhado com
# keyframe é o que a Fase 7 (dash.js sobre MSE) vai precisar.
_FRAG_DURACAO = "1000000"   # microssegundos

# O `-preset veryfast` não é preguiça: transcodificar em CPU é o último recurso da lista, e ali o
# que importa é o vídeo começar. `crf 23` é o padrão visualmente transparente do x264.
_X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]


def argv_de_sonda(caminho):
    """`ffprobe` respondendo JSON, e mais nada."""
    return [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        caminho,
    ]


def argv_de_fluxo(decisao, caminho, inicio=0, gpu=None):
    """A linha do ffmpeg para servir este arquivo — ou `None` quando não há o que fazer.

    ⚠ `None` no modo **direto** é a resposta certa, e devolver um argv ali seria o pior tipo de
    defeito silencioso: o servidor gastaria CPU remuxando um arquivo que o navegador abre sozinho,
    e nada na tela mudaria.
    """
    if decisao.modo not in ("remux", "audio", "transcode"):
        return None

    argv = ["ffmpeg", "-hide_banner", "-loglevel", "error"]

    # ── A busca ──────────────────────────────────────────────────────────────
    #
    # ⚠ `-ss` **antes** do `-i` é busca de ENTRADA: o ffmpeg salta pelo índice do arquivo e começa
    # a ler dali. Depois do `-i` viraria busca de saída — decodificar desde o começo e jogar fora
    # tudo até o ponto —, e buscar aos 40 min de um filme passaria de instantâneo a minutos de CPU,
    # por espectador.
    #
    # E `-ss 0` não é inofensivo: ele faz o ffmpeg procurar keyframe e pode cortar o primeiro
    # quadro. Não pedir é diferente de pedir zero.
    if inicio and inicio > 0:
        argv += ["-ss", str(int(inicio))]

    if decisao.modo == "transcode" and gpu:
        # A decodificação também vai para a GPU: subir quadro por quadro para a placa só para
        # codificar desperdiça a metade barata do trabalho.
        argv += ["-vaapi_device", gpu, "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"]

    argv += ["-i", caminho]

    # ── O que sai ────────────────────────────────────────────────────────────
    #
    # ⚠ Sem `-map`, o ffmpeg escolhe sozinho — e escolhe a faixa "melhor", que costuma ser
    # justamente a de seis canais que o navegador não decodifica. Toda a escolha do `decisao.py`
    # se perderia na última linha.
    argv += ["-map", "0:v:0"]
    if decisao.faixa_audio is not None and decisao.audio != "nenhum":
        argv += ["-map", f"0:{decisao.faixa_audio}"]

    if decisao.video == "copiar":
        argv += ["-c:v", "copy"]
    elif gpu:
        argv += ["-vf", "scale_vaapi=format=nv12", "-c:v", "h264_vaapi"]
    else:
        argv += _X264

    if decisao.audio == "copiar":
        argv += ["-c:a", "copy"]
        # ⚠ **Copiar AAC não é copiar.** Num AVI ou num MPEG-TS o AAC vem em enquadramento ADTS —
        # cada quadro com o próprio cabeçalho —, e o muxer de MP4 quer ASC, com a configuração numa
        # caixa e os quadros crus. Sem o filtro ele RECUSA: "Malformed AAC bitstream detected".
        #
        # Foi o defeito que derrubou o primeiro `.avi` de verdade. E ele é traiçoeiro por duas
        # razões: o ffmpeg escreve o cabeçalho e alguns quadros ANTES de recusar (24 KB no caso
        # medido, o suficiente para o navegador desenhar um quadro), e as versões novas do ffmpeg
        # inserem o filtro sozinhas em ALGUNS containers — de modo que a mesma linha de comando
        # funciona na máquina de quem desenvolve e falha na de quem instalou.
        #
        # Medido: com o filtro, a saída de um AAC que já estava em ASC (de MKV, de MP4) é byte a
        # byte a mesma — ele é inócuo onde não é preciso. Mas sobre áudio que NÃO é AAC ele mata o
        # ffmpeg com EINVAL e zero byte, e é por isso que a condição olha o codec e não o container.
        if decisao.codec_audio == "aac":
            argv += ["-bsf:a", "aac_adtstoasc"]
    elif decisao.audio == "recodificar":
        # ⚠ `-ac 2` é onde se evita "não escuto o diálogo". O canal central de um 5.1 carrega a
        # fala, e uma soma ingênua de seis canais para dois a enterra. O rebaixamento do ffmpeg é
        # o bom — pedi-lo é uma bandeira, não pedi-lo é uma reclamação.
        argv += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]

    # ⚠ Nada de `-copyts`: os timestamps saem começando em zero, e é o frontend que soma o
    # deslocamento (`opcoes.tempo` da TuffMidia). Com `-copyts` o tempo mostrado ficaria dobrado, e
    # o sintoma — a linha do tempo andando rápido demais — não apontaria para cá.
    argv += ["-frag_duration", _FRAG_DURACAO, "-movflags", _MOVFLAGS, "-f", "mp4", "pipe:1"]
    return argv


def argv_de_legenda(caminho, indice):
    """Uma faixa de legenda embutida, convertida para o único formato que o `<track>` lê."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", caminho,
        "-map", f"0:{indice}",
        "-f", "webvtt", "pipe:1",
    ]


# ── A execução, que é fina de propósito ──────────────────────────────────────


def sondar_arquivo(caminho, tempo_limite=20):
    """Roda o `ffprobe` e devolve a `Sonda`. Falha vira sonda vazia, nunca exceção.

    O modo `desconhecido` que sai daí é uma resposta que a interface sabe mostrar; uma exceção
    subindo pelo handler viraria 500 numa tela que não explica nada.
    """
    try:
        saida = subprocess.run(argv_de_sonda(caminho), capture_output=True, timeout=tempo_limite,
                               check=True)
        return sondar(json.loads(saida.stdout.decode("utf-8", "replace")), os.path.basename(caminho))
    except (subprocess.SubprocessError, OSError, ValueError):
        return sondar({}, os.path.basename(caminho))


def achar_gpu():
    """O nó de render da placa, ou `None`.

    ⚠ Existir `/dev/dri/renderD*` não prova que o VAAPI funciona — prova que há um dispositivo. O
    template mede de verdade codificando um `testsrc`, e é essa a medida que vale antes de prometer
    transcodificação barata a alguém.
    """
    try:
        nos = sorted(n for n in os.listdir("/dev/dri") if n.startswith("renderD"))
    except OSError:
        return None
    return os.path.join("/dev/dri", nos[0]) if nos else None
