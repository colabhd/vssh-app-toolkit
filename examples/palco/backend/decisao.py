"""O que o arquivo é, o que a máquina aceita, e o que fazer com a diferença.

    sondar(ffprobe_json, nome) -> Sonda      o que o arquivo é
    decidir(sonda, perfil)     -> Decisao    direto | remux | audio | transcode

⚠ **O servidor NÃO decide sozinho, e é a correção central deste módulo.** Quem sabe o que consegue
decodificar é o cliente, e isso varia por máquina, por sistema e por versão do navegador: medido em
Chrome 151 headless, `hvc1` é falso; num Chrome de mesa com decodificação por hardware costuma ser
verdadeiro. Uma tabela fixa aqui transcodificaria a 180% de CPU para metade das máquinas — e ainda
entregaria a elas vídeo pior que o original.

─── A ordem de preferência, e ela é INVERTIDA em relação à web normal ───────

Na web, o servidor é compartilhado e o cliente é a máquina forte. Aqui o vssh existe justamente
para dar uma estação remota potente: o cliente pode ser um laptop magro, e já está renderizando um
desktop inteiro.

    1. cliente nativo/hardware      de graça
    2. servidor remux (`-c copy`)   ~2%
    3. servidor transcode VAAPI     GPU, quase de graça
    4. servidor CPU                 último, e a interface diz que está trabalhando

⚠ Falta o quinto degrau — decodificação WASM no cliente (hevc.js), que caberia entre 3 e 4 quando o
servidor não tem GPU. Ele não está aqui de propósito: exige a biblioteca vendorizada no pacote, o
que é da Fase 7. A costura é o `Perfil`: um cliente que carregue o hevc.js declara `hevc` em
`video` e este módulo já responde `remux` sem mudar uma linha.

Nada aqui executa `ffprobe` nem toca em arquivo: entra JSON, sai decisão.
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional, Set

# ⚠ `format_name` do ffprobe é uma LISTA de demuxers, não um nome: `.mkv` e `.webm` respondem os
# dois `matroska,webm`, e o navegador abre o segundo e não o primeiro. Quem desempata é a extensão.
# Ignorar isto remuxaria todo `.webm` à toa, ou serviria todo `.mkv` quebrado.
_POR_EXTENSAO = {
    ".mp4": "mp4", ".m4v": "mp4", ".m4a": "mp4",
    ".webm": "webm",
    ".mkv": "matroska", ".mka": "matroska",
    ".mov": "mov", ".avi": "avi", ".wmv": "asf", ".flv": "flv", ".ts": "mpegts",
    ".mp3": "mp3", ".flac": "flac", ".ogg": "ogg", ".opus": "ogg", ".wav": "wav",
}


@dataclass
class Faixa:
    indice: int
    codec: str
    largura: int = 0
    altura: int = 0
    canais: int = 0
    padrao: bool = False    # `disposition.default` — a que o navegador vai tocar sozinho


@dataclass
class Sonda:
    container: str = ""
    duracao: Optional[float] = None
    video: Optional[Faixa] = None
    audios: List[Faixa] = field(default_factory=list)


@dataclass
class Perfil:
    """O que o cliente relatou que toca. Vocabulário curto, igual dos dois lados.

    O frontend pergunta em RFC 6381 (`avc1.640028`) e traduz para o nome curto antes de mandar —
    que é o mesmo nome que o `ffprobe` usa (`h264`). Um vocabulário só evita a tabela de tradução
    no meio, que é onde este tipo de código costuma apodrecer.

    ⚠ **`containers` vem de `video.canPlayType()`, e NÃO de `MediaSource.isTypeSupported()`.** São
    duas perguntas diferentes, e trocá-las erra a decisão inteira:

        canPlayType(t)            "eu demuxo isto sozinho?"   → o caminho DIRETO, que é `<video src>`
        MediaSource.isType…(t)    "eu aceito isto por MSE?"   → para onde um remux teria de ir

    O caminho direto não passa por MSE em nenhum momento. Medido em Chrome 151, as duas respostas
    discordam em metade dos containers que importam:

        matroska    demuxa ✓   MSE ✗     ← o `.mkv` toca DIRETO; era o caso que eu dava como caro
        flac        demuxa ✓   MSE ✗
        ogg/opus    demuxa ✓   MSE ✗
        mpegts      demuxa ✗   MSE ✓     ← o `.ts` é o inverso: só por MSE
        mov / avi   demuxa ✗   MSE ✗

    ⚠ E tomamos o navegador ao pé da letra, inclusive quando ele parece pessimista: `video/quicktime`
    responde "não" embora o demuxer de MP4 costume dar conta de um `.mov`. Confiar no "não" custa 2%
    de um núcleo; confiar num "sim" errado custa uma tela preta, e quem assiste não sabe a diferença.
    """
    containers: Set[str] = field(default_factory=set)
    video: Set[str] = field(default_factory=set)
    audio: Set[str] = field(default_factory=set)


# O que todo navegador toca desde sempre. É o que vale quando o cliente não relatou nada — uma
# versão velha do frontend, ou uma requisição que não passou pela página.
#
# ⚠ Ele erra para o lado de GASTAR CPU, e não para o lado da tela preta. O primeiro custa dinheiro;
# o segundo parece o app quebrado, e quem assiste não tem como saber a diferença. Por isso `mp4`
# sozinho, e não a lista medida acima: o mínimo é o que vale em toda máquina, não nesta.
PERFIL_MINIMO = Perfil(containers={"mp4"}, video={"h264"}, audio={"aac", "mp3"})


@dataclass
class Decisao:
    modo: str                            # direto | remux | audio | transcode | desconhecido
    video: str = "nenhum"                # copiar | recodificar | nenhum
    audio: str = "nenhum"                # copiar | recodificar | nenhum
    faixa_audio: Optional[int] = None    # o índice que o `-map` do ffmpeg vai usar
    motivo: str = ""


def sondar(bruto, nome=""):
    """A saída de `ffprobe -show_format -show_streams -print_format json`, normalizada.

    Tolera JSON torto: arquivo corrompido, extensão mentindo, `ffprobe` sem streams. A resposta é
    uma sonda vazia — nunca uma exceção subindo pelo handler.
    """
    bruto = bruto if isinstance(bruto, dict) else {}
    formato = bruto.get("format") or {}
    streams = bruto.get("streams") or []

    ext = os.path.splitext(nome or "")[1].lower()
    container = _POR_EXTENSAO.get(ext) or (str(formato.get("format_name") or "").split(",")[0])

    try:
        duracao = float(formato.get("duration"))
    except (TypeError, ValueError):
        duracao = None

    video = None
    audios = []
    for s in streams:
        codec = s.get("codec_name")
        if not codec:
            continue
        if s.get("codec_type") == "video":
            # ⚠ A capa do álbum é um stream de VÍDEO. Um MP3 com capa traz `mjpeg` com
            # `attached_pic: 1`, e sem filtrar isso toda música com capa vira "vídeo em MJPEG" e
            # cai em transcode — a 100% de CPU para tocar o que sairia direto.
            if (s.get("disposition") or {}).get("attached_pic"):
                continue
            if video is None:
                video = Faixa(indice=int(s.get("index", 0)), codec=codec,
                              largura=int(s.get("width") or 0), altura=int(s.get("height") or 0))
        elif s.get("codec_type") == "audio":
            audios.append(Faixa(indice=int(s.get("index", 0)), codec=codec,
                                canais=int(s.get("channels") or 0),
                                padrao=bool((s.get("disposition") or {}).get("default"))))

    return Sonda(container=container, duracao=duracao, video=video, audios=audios)


def decidir(sonda, perfil=None):
    """Do encontro entre o arquivo e a máquina, o modo."""
    p = perfil or PERFIL_MINIMO

    if sonda.video is None and not sonda.audios:
        return Decisao(modo="desconhecido",
                       motivo="o ffprobe não achou faixa de vídeo nem de áudio neste arquivo")

    # ── O vídeo ──────────────────────────────────────────────────────────────
    if sonda.video is None:
        acao_video, video_ok = "nenhum", True
    elif sonda.video.codec in p.video:
        acao_video, video_ok = "copiar", True
    else:
        acao_video, video_ok = "recodificar", False

    # ── O áudio, e QUAL faixa ────────────────────────────────────────────────
    #
    # ⚠ Duas regras diferentes, e a segunda só aparece quando se olha o modo direto de perto.
    #
    # 1. Pegar a primeira faixa é o reflexo, e custa caro: um MKV de filme costuma trazer AC3 em
    #    primeiro (o original) e AAC em segundo. Recodificar havendo uma faixa de graça ao lado é
    #    trabalho puro.
    # 2. Mas **no modo direto quem escolhe a faixa é o navegador**, não nós — o arquivo vai inteiro
    #    e ele toca a `default`. Se a padrão for a que ele não decodifica, o resultado é vídeo com
    #    imagem e sem som: o pior tipo de defeito, porque nada falha e ninguém sabe o que houve.
    #    Então existir uma faixa boa não basta; ela tem de ser a padrão. Não sendo, um `-c copy`
    #    que a põe na frente resolve por ~2%.
    padrao = next((f for f in sonda.audios if f.padrao), sonda.audios[0] if sonda.audios else None)
    tocavel = next((f for f in sonda.audios if f.codec in p.audio), None)

    reordenar = False
    if padrao is None:
        acao_audio, faixa, audio_ok = "nenhum", None, True
    elif padrao.codec in p.audio:
        acao_audio, faixa, audio_ok = "copiar", padrao.indice, True
    elif tocavel is not None:
        acao_audio, faixa, audio_ok, reordenar = "copiar", tocavel.indice, True, True
    else:
        acao_audio, faixa, audio_ok = "recodificar", padrao.indice, False

    # ── O encontro ───────────────────────────────────────────────────────────
    #
    # O vídeo manda: se ele precisa ser recodificado, o resto vai junto e não há economia a fazer.
    # É o único caso caro, e é por isso que a interface avisa que está trabalhando.
    if not video_ok:
        return Decisao(modo="transcode", video=acao_video,
                       audio="recodificar" if sonda.audios else "nenhum",
                       faixa_audio=faixa,
                       motivo=f"esta máquina não decodifica {sonda.video.codec}")

    container_ok = sonda.container in p.containers

    if container_ok and audio_ok and not reordenar:
        return Decisao(modo="direto", video=acao_video, audio=acao_audio, faixa_audio=faixa,
                       motivo="o arquivo sai do portal como está, com Range nativo")

    if audio_ok:
        # Só a embalagem. `-c copy` nos dois lados: ~2% de um núcleo, e o vídeo passa intacto.
        return Decisao(
            modo="remux", video=acao_video, audio=acao_audio, faixa_audio=faixa,
            motivo=(f"a faixa de áudio padrão ({padrao.codec}) não toca aqui, e há outra que toca"
                    if reordenar else f"esta máquina não abre o container {sonda.container}"))

    # ⚠ O modo que desmancha o pior caso. `MKV + H.264 + AC3` parecia transcode de 180%; é
    # embalagem errada (barata) mais áudio sem decodificador (barato), e o vídeo — que é onde estão
    # os bytes — passa intacto.
    return Decisao(modo="audio", video=acao_video, audio=acao_audio, faixa_audio=faixa,
                   motivo=f"o vídeo passa direto; só o áudio {sonda.audios[0].codec} não toca aqui")
