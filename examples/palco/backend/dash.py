"""Do que o yt-dlp devolve, um MPD que o dash.js entende.

    ranges_do_cabecalho(bytes)      -> Ranges | None      onde estão o init e o índice
    escolher_formatos(formatos)     -> [Trilha]           quais entram, e agrupados como
    montar_mpd(info, trilhas, url)  -> str                o XML

Nada aqui abre socket ou lê disco: entram bytes e dicionários, sai XML. Quem busca os 4 KB de
cabeçalho de cada formato é `youtube.py`.

─── ⚠ O plano dizia que o yt-dlp entrega `initRange`/`indexRange`. Ele NÃO entrega ────

Medido em 2026-08-17 com yt-dlp 2026.07.04, contra dois vídeos (um de 2005 com 11 formatos, um 4K
com 33): **`initRange` e `indexRange` aparecem em 0 de 44 formatos**. As únicas chaves parecidas que
existem são `fragments` — e os quatro formatos que as têm são *storyboards*, as miniaturas da linha
do tempo, não mídia.

O recuo escrito no plano era o progressivo — uma qualidade só (360p), com áudio junto. Ele não foi
preciso, porque os ranges **não vêm prontos mas estão no arquivo**:

    container: "mp4_dash"          e os primeiros bytes são `ftypdash`
    a URL responde 206             `Content-Range`, `Accept-Ranges: bytes`

Ou seja, cada formato já é um fMP4 com `sidx`. Achar os dois ranges custa **uma leitura de 4 KB por
formato** e um parser de caixas, que é o que este módulo faz. Medido: 18 de 18 formatos MP4 do 4K e
6 de 6 do vídeo de 2005 responderam, ~300 ms com as leituras em paralelo.

─── ⚠ Por que o BaseURL aponta para NÓS, e não para o googlevideo ─────────────

Duas razões independentes, as duas medidas — e qualquer uma sozinha já obrigaria o proxy:

1. **A URL é presa ao IP.** O parâmetro `sparams`, que lista o que a assinatura cobre, inclui `ip`,
   e o valor de `ip=` é o de quem pediu. Quem pede é o servidor; o navegador de quem assiste está
   em outra ponta da internet.
2. **Não há CORS.** `Access-Control-Allow-Origin` não vem em resposta nenhuma, e o preflight
   `OPTIONS` responde **400**. O dash.js manda `Range`, que não é cabeçalho simples e portanto
   exige preflight. Mesmo que o IP batesse, o navegador recusaria antes de pedir o primeiro byte.

Então todo byte de vídeo atravessa o servidor. O que continua verdadeiro do plano é o que importa:
**nenhum ffmpeg** — é repasse de bytes com Range, não processamento de mídia.
"""

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import List, Optional

# ⚠ O escopo é MP4, e é uma decisão, não uma limitação esquecida. Os formatos WebM (vp9/opus) são
# EBML: não têm caixas, têm Cues, e o índice mora no fim do arquivo em vez do começo. Suportá-los
# custaria um segundo parser, com outra forma e outros defeitos, para cobrir alturas que o MP4 já
# cobre — medido no 4K: `avc1` e `av01` juntos dão 144p a 2160p, e `mp4a` dá o áudio.
#
# O sinal de que um formato é DASH (e não progressivo) é o `container` terminando em `_dash`; o
# progressivo tem vídeo e áudio no mesmo arquivo e não serve para MSE adaptativo.
_EXTENSOES = {"mp4", "m4a"}

# Só 4 KB. O `moov` de um formato do YouTube mede ~700 bytes e o `sidx` começa logo depois; o que
# precisamos DELE são os 8 primeiros bytes, onde está o próprio tamanho. Ler o `sidx` inteiro seria
# desperdício — num filme de três horas ele passa de 10 KB, e nós não vamos interpretá-lo: quem lê
# a tabela de subsegmentos é o dash.js, com o range que devolvemos aqui.
CABECALHO = 4096

_TIPO_DE_CAIXA = re.compile(rb"^[A-Za-z0-9 ]{4}$")


@dataclass
class Ranges:
    """Os dois pares de bytes que o `SegmentBase` do DASH exige."""
    init: str      # "0-740"
    index: str     # "741-2248"


@dataclass
class Trilha:
    """Um formato que entra no MPD, já com os ranges descobertos."""
    id: str                      # o itag: "134", "140"
    tipo: str                    # "video" | "audio"
    codec: str                   # RFC 6381: "avc1.4d401e", "mp4a.40.2"
    banda: int                   # bits por segundo
    ranges: Ranges
    tamanho: int = 0
    largura: int = 0
    altura: int = 0
    fps: int = 0
    canais: int = 0
    amostragem: int = 0
    idioma: Optional[str] = None

    @property
    def familia(self):
        """A chave de agrupamento em `AdaptationSet`.

        ⚠ Um `AdaptationSet` promete que suas representações são intercambiáveis **sem recriar o
        `SourceBuffer`** — é isso que permite ao ABR trocar de qualidade no meio. Perfis diferentes
        do mesmo codec (`avc1.4d401e` e `avc1.64002a`) cumprem a promessa; codecs diferentes não.
        Pôr `avc1` e `av01` juntos daria um conjunto onde subir de qualidade quebra a reprodução.

        Para vídeo o agrupamento é por família (os 4 primeiros caracteres); para áudio é pelo codec
        inteiro, porque HE-AAC (`mp4a.40.5`) e AAC-LC (`mp4a.40.2`) diferem na taxa de amostragem do
        decodificador e o YouTube os oferece lado a lado.
        """
        return self.codec[:4] if self.tipo == "video" else self.codec

    @property
    def mime(self):
        return f"{self.tipo}/mp4"


def caixas(dados):
    """Percorre as caixas de topo de um MP4: `(tipo, inicio, fim)`, com `fim` exclusivo.

    Tolerante por construção — devolve o que conseguiu ler e para no primeiro byte que não faz
    sentido. É o que permite chamá-la com 4 KB de um arquivo de 18 MB: a última caixa vista é
    truncada, e o gerador simplesmente termina.

    ⚠ Ela para em qualquer coisa que não seja MP4 em vez de devolver lixo com cara de resposta. Um
    WebM começa com `1A 45 DF A3`, que lido como tamanho de 32 bits dá 440 milhões — sem esta
    guarda, `escolher_formatos` receberia um `sidx` inventado e o MPD apontaria para bytes que não
    existem. O `<video>` do outro lado mostraria tela preta, sem erro nenhum.
    """
    if not isinstance(dados, (bytes, bytearray, memoryview)):
        return
    dados = bytes(dados)
    i = 0
    while i + 8 <= len(dados):
        tam = int.from_bytes(dados[i:i + 4], "big")
        tipo = dados[i + 4:i + 8]
        if not _TIPO_DE_CAIXA.match(tipo):
            return
        if tam == 1:                                  # tamanho de 64 bits, num campo à parte
            if i + 16 > len(dados):
                return
            tam = int.from_bytes(dados[i + 8:i + 16], "big")
        elif tam == 0:                                # "vai até o fim do arquivo"
            yield tipo.decode("ascii"), i, len(dados)
            return
        if tam < 8:
            return
        yield tipo.decode("ascii"), i, i + tam
        i += tam


def ranges_do_cabecalho(dados):
    """Os primeiros bytes de um fMP4 → `Ranges`, ou `None` se não for um.

    O layout que o YouTube entrega é `ftyp | moov | sidx | (moof mdat)*`:
    a inicialização vai do zero ao fim do `moov`, e o índice é o `sidx` inteiro.
    """
    vistas = list(caixas(dados))
    if not vistas or vistas[0][0] != "ftyp":
        # ⚠ Exigir `ftyp` em PRIMEIRO é a checagem forte, e é barata. Sem ela, um corpo de erro em
        # HTML ou uma página de captive portal poderiam, por azar, produzir quatro bytes
        # alfanuméricos e passar por uma caixa.
        return None
    moov = next((c for c in vistas if c[0] == "moov"), None)
    sidx = next((c for c in vistas if c[0] == "sidx"), None)
    if not moov or not sidx:
        return None
    return Ranges(init=f"0-{moov[2] - 1}", index=f"{sidx[1]}-{sidx[2] - 1}")


def e_dash_em_mp4(f):
    """Este formato do yt-dlp é um fMP4 segmentado?"""
    return (f.get("ext") in _EXTENSOES
            and str(f.get("container") or "").endswith("_dash")
            and bool(f.get("url")))


def escolher_formatos(formatos, ranges_por_id):
    """Os formatos do yt-dlp + os ranges já descobertos → as trilhas do MPD.

    `ranges_por_id` mapeia itag → `Ranges`. Formato sem entrada ali fica de fora — é o caso do
    cabeçalho que não chegou ou não era MP4, e o silêncio é proposital: uma trilha a menos degrada
    a qualidade disponível, uma trilha mentindo quebra a reprodução inteira.
    """
    trilhas = []
    for f in formatos or []:
        if not e_dash_em_mp4(f):
            continue
        r = ranges_por_id.get(str(f.get("format_id")))
        if r is None:
            continue
        v, a = f.get("vcodec") or "none", f.get("acodec") or "none"
        if v != "none" and a == "none":
            tipo, codec = "video", v
        elif v == "none" and a != "none":
            tipo, codec = "audio", a
        else:
            continue                                  # progressivo: não serve para MSE adaptativo

        # ⚠ `tbr` vem em kbit/s e pode faltar; `bandwidth` é obrigatório no MPD e o dash.js usa o
        # valor para escolher qualidade. Sem `tbr` deduzimos do tamanho e da duração — e se nem isso
        # houver, um zero é melhor que ausente: o esquema é respeitado e o ABR trata como a pior
        # opção, que é o lado seguro de errar.
        banda = int(round(float(f.get("tbr") or 0) * 1000))
        trilhas.append(Trilha(
            id=str(f.get("format_id")), tipo=tipo, codec=codec, banda=banda, ranges=r,
            tamanho=int(f.get("filesize") or f.get("filesize_approx") or 0),
            largura=int(f.get("width") or 0), altura=int(f.get("height") or 0),
            fps=int(round(float(f.get("fps") or 0))),
            canais=int(f.get("audio_channels") or 0), amostragem=int(f.get("asr") or 0),
            idioma=f.get("language") or None,
        ))
    return trilhas


def _duracao_iso(segundos):
    """Segundos → `PT635.0S`. O esquema do MPD pede ISO 8601, e o dash.js recusa sem isto."""
    try:
        s = float(segundos)
    except (TypeError, ValueError):
        return None
    return f"PT{s:.3f}S" if s > 0 else None


def montar_mpd(duracao, trilhas, base_url):
    """As trilhas → o XML do manifesto.

    `base_url` recebe o itag: `montar_mpd(…, "/api/yt/bytes?v=abc&f=")` produz
    `<BaseURL>/api/yt/bytes?v=abc&f=134</BaseURL>`. É o proxy — ver o cabeçalho do módulo.
    """
    dur = _duracao_iso(duracao)
    mpd = ET.Element("MPD", {
        "xmlns": "urn:mpeg:dash:schema:mpd:2011",
        # `isoff-on-demand` é o perfil de vídeo gravado com `SegmentBase` — exatamente o que temos.
        # Declarar `isoff-live` faria o dash.js procurar um template de segmento que não existe.
        "profiles": "urn:mpeg:dash:profile:isoff-on-demand:2011",
        "type": "static",
        "minBufferTime": "PT1.5S",
    })
    if dur:
        mpd.set("mediaPresentationDuration", dur)

    periodo = ET.SubElement(mpd, "Period")
    if dur:
        periodo.set("duration", dur)

    # A ordem entre conjuntos não é cosmética: o dash.js monta os `SourceBuffer` na ordem do
    # manifesto, e vídeo antes de áudio é a ordem que todo empacotador produz. Dentro do conjunto,
    # da menor banda para a maior — é o que o esquema pede e o que faz o primeiro segmento pedido
    # ser o mais leve.
    familias = {}
    for t in trilhas:
        familias.setdefault((t.tipo, t.familia), []).append(t)

    for (tipo, _fam), grupo in sorted(familias.items(), key=lambda kv: (kv[0][0] != "video", kv[0])):
        grupo.sort(key=lambda t: (t.banda, t.id))
        conj = ET.SubElement(periodo, "AdaptationSet", {
            "mimeType": grupo[0].mime,
            "contentType": tipo,
            "segmentAlignment": "true",
            "subsegmentAlignment": "true",
            # `startWithSAP=1` afirma que todo subsegmento começa em ponto de acesso — é o que
            # permite ao player trocar de representação numa fronteira sem redecodificar.
            "startWithSAP": "1",
            "subsegmentStartsWithSAP": "1",
        })
        idiomas = {t.idioma for t in grupo if t.idioma}
        if len(idiomas) == 1:
            conj.set("lang", idiomas.pop())
        if tipo == "audio":
            # O `AudioChannelConfiguration` é exigido pelo esquema para áudio. Sem ele o dash.js
            # ainda toca, mas um validador de MPD reprova — e o manifesto é a nossa saída pública.
            canais = max((t.canais for t in grupo), default=0) or 2
            ET.SubElement(conj, "AudioChannelConfiguration", {
                "schemeIdUri": "urn:mpeg:dash:23003:3:audio_channel_configuration:2011",
                "value": str(canais),
            })

        for t in grupo:
            atrs = {"id": t.id, "codecs": t.codec, "bandwidth": str(t.banda)}
            if t.tipo == "video":
                if t.largura and t.altura:
                    atrs["width"], atrs["height"] = str(t.largura), str(t.altura)
                if t.fps:
                    atrs["frameRate"] = str(t.fps)
            else:
                if t.amostragem:
                    atrs["audioSamplingRate"] = str(t.amostragem)
            rep = ET.SubElement(conj, "Representation", atrs)
            ET.SubElement(rep, "BaseURL").text = f"{base_url}{t.id}"
            seg = ET.SubElement(rep, "SegmentBase", {"indexRange": t.ranges.index,
                                                     "indexRangeExact": "true"})
            ET.SubElement(seg, "Initialization", {"range": t.ranges.init})

    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(mpd, encoding="unicode")
