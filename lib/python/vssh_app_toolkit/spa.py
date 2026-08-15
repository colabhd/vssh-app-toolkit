"""Serve uma SPA já construída sob o prefixo de proxy de um vssh-app.

O par do `lib/node/static-spa.js`. Todo port de web app precisa disto, e todo mundo erra do mesmo
jeito na primeira vez.

O que NÃO está aqui de propósito: reescrever caminho absoluto (`/static/...`) para relativo. Isso é
fato do app empacotado, resolvido em tempo de build, não em tempo de resposta.

── Mounts ──

Um prefixo servido de OUTRO diretório, fora da raiz do bundle. Existe para as libs de navegador do
toolkit, que moram dentro do pacote instalado — fora da raiz por construção. Um mount é o mesmo
código do bundle apontando para outro diretório: mesmo confinamento, mesmo 304, mesmo `?v=`.

**Precedência declarada: caminho direto > mount > alias.** O direto vence porque o app é dono da
própria raiz; o mount vence o alias porque é uma afirmação sobre um prefixo, e o alias é um palpite
de último recurso.

── Carimbo de versão: por que ele existe, e por que cabeçalho não bastava ──

O caso real que produziu isto: o `vssh-app-shim.js` foi atualizado e reinstalado no servidor, o
arquivo em disco estava CERTO, e o navegador continuou executando o antigo.

`Cache-Control: no-cache` mais revalidação por `Last-Modified` depende de TODO MUNDO no caminho
colaborar: navegador, proxy do portal, CDN. Basta um elo guardar a resposta e o usuário fica com
bytes velhos sem nenhum sinal — a página carrega, o script roda, só que é outro script.

A correção não é um cabeçalho melhor: é **fazer o conteúdo novo morar noutra URL**. O hash sai do
CONTEÚDO, então ele muda quando — e só quando — os bytes mudam. Reinstalar a mesma versão mantém a
URL, e o cache do usuário sobrevive. O `index.html` é `no-store`, então é ele que traz a URL nova.
"""

from __future__ import annotations

import hashlib
import os
import threading
from email.utils import formatdate, parsedate_to_datetime
from urllib.parse import unquote, urlsplit, parse_qs

__all__ = ["criar_spa_estatica", "tipo_de_conteudo"]

# Mapa próprio, e não o do `fs`: aquele cobre conteúdo de dados do app (imagem, PDF, áudio), este
# cobre bundle web (js, css, fonte, wasm). Duplicar um mapa pequeno é o preço de as duas peças
# serem independentes uma da outra.
_TIPOS = {
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "mjs": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "map": "application/json; charset=utf-8",
    "wasm": "application/wasm",
    "svg": "image/svg+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "ico": "image/x-icon",
    "woff": "font/woff",
    "woff2": "font/woff2",
    "ttf": "font/ttf",
    "otf": "font/otf",
    "eot": "application/vnd.ms-fontobject",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "pdf": "application/pdf",
    "bin": "application/octet-stream",
}

# Arquivo grande (wasm, modelo, vídeo): ler tudo para carimbar custaria mais do que o problema
# resolve. mtime+tamanho é carimbo pior — muda entre instalações da mesma versão, o que só custa um
# download a mais — mas nunca DEIXA de mudar quando o conteúdo muda, que é a propriedade da qual a
# correção depende.
_HASH_MAX_BYTES = 4 * 1024 * 1024


def tipo_de_conteudo(caminho):
    _, _, ext = caminho.rpartition(".")
    return _TIPOS.get(ext.lower(), "application/octet-stream")


def _real(caminho):
    """Canonicaliza — e a raiz e o alvo têm de passar pela MESMA função.

    Duas grafias do mesmo diretório nunca casam, e o sintoma é desconcertante: TODO caminho
    aninhado vira 404 enquanto o index continua servindo (ele é lido direto, sem passar pelo
    confinamento). No macOS `/tmp` é symlink para `/private/tmp`, e um deploy no idioma
    `current -> releases/N` cai no mesmo buraco.
    """
    try:
        return os.path.realpath(caminho)
    except OSError:
        return os.path.abspath(caminho)


class _Carimbador:
    """Hash do conteúdo, memoizado por (mtime, tamanho). `None` = arquivo ilegível."""

    def __init__(self, ao_avisar):
        self._cache = {}
        self._tranca = threading.Lock()
        self._ao_avisar = ao_avisar

    def de(self, arquivo):
        try:
            st = os.stat(arquivo)
        except OSError:
            return None
        if not os.path.isfile(arquivo):
            return None

        chave = (st.st_mtime_ns, st.st_size)
        with self._tranca:
            achou = self._cache.get(arquivo)
            if achou and achou[0] == chave:
                return achou[1]

        if st.st_size > _HASH_MAX_BYTES:
            h = hashlib.sha1(f"{st.st_mtime_ns}:{st.st_size}".encode("utf-8")).hexdigest()[:12]
        else:
            try:
                with open(arquivo, "rb") as fh:
                    h = hashlib.sha1(fh.read()).hexdigest()[:12]
            except OSError as err:
                self._ao_avisar({"event": "stamp-failed", "file": arquivo, "message": str(err)})
                return None

        with self._tranca:
            self._cache[arquivo] = (chave, h)
        return h


def criar_spa_estatica(root, index_file="index.html", inject_scripts=None, mounts=None,
                       alias_prefixes=None, spa_fallback=False, missing_bundle_hint="",
                       ao_avisar=None, inject_styles=None):
    """Devolve `servir(handler) -> bool`. `True` quer dizer que a requisição foi atendida.

    O contrato de retorno é o mesmo do lado Node, e pela mesma razão: **404 é decisão de quem
    compõe as rotas**, não da lib. Um handler que respondesse 404 sozinho impediria o app de tentar
    as próprias rotas depois dele.

    `inject_styles` são folhas injetadas como `<link rel="stylesheet">`, com o mesmo carimbo dos
    scripts e **antes** deles — ver `tags()`. Fica por último na assinatura, e não ao lado de
    `inject_scripts`, porque quem chama por posição já existe lá fora: acrescentar um parâmetro no
    meio trocaria silenciosamente o `mounts` de um app pelas folhas.
    """
    inject_scripts = list(inject_scripts or [])
    inject_styles = list(inject_styles or [])
    alias_prefixes = list((alias_prefixes or {}).items())
    ao_avisar = ao_avisar or (lambda _evento: None)

    raiz = _real(os.path.abspath(root))

    montados = []
    for prefixo, diretorio in (mounts or {}).items():
        if not (prefixo.startswith("/") and prefixo.endswith("/")):
            raise ValueError(
                f"mounts: o prefixo '{prefixo}' precisa começar e terminar com '/' — sem isso, "
                "'/_vsshX' casaria com '/_vssh'."
            )
        montados.append((prefixo, _real(os.path.abspath(diretorio))))

    carimbador = _Carimbador(ao_avisar)
    cache_do_index = {"chave": None, "corpo": None}
    tranca_do_index = threading.Lock()

    def arquivo_do_src(src):
        """O arquivo em disco de um `src` injetado — pela MESMA precedência que serve a requisição."""
        rel = str(src).split("?")[0]
        caminho = rel if rel.startswith("/") else "/" + rel
        for prefixo, base in montados:
            if caminho.startswith(prefixo):
                return os.path.join(base, caminho[len(prefixo):])
        return os.path.join(raiz, caminho.lstrip("/"))

    def carimbo_do_src(src):
        return carimbador.de(arquivo_do_src(src))

    def _url_carimbada(src):
        v = carimbo_do_src(src)
        sep = "&" if "?" in str(src) else "?"
        return (f"{src}{sep}v={v}" if v else str(src)).replace(chr(34), "&quot;")

    def tags():
        # Sem `defer`: precisa executar antes dos scripts diferidos do bundle, que já esperam o
        # parse. O `src` vem do app, não do usuário — mas interpolar em HTML sem escapar é o tipo
        # de coisa que envelhece mal, então quebramos aspas duplas.
        #
        # ⚠ As FOLHAS saem antes dos scripts. O `<link>` bloqueia a primeira pintura, e descobri-lo
        # cedo é o que evita a página aparecer sem estilo por um quadro — fundo branco dentro de uma
        # janela escura, que é o artefato que mais denuncia "isto é uma página web".
        saida = []
        for href in inject_styles:
            saida.append(f'<link rel="stylesheet" href="{_url_carimbada(href)}">')
        for src in inject_scripts:
            saida.append(f'<script src="{_url_carimbada(src)}"></script>')
        return "\n".join(saida)

    def corpo_do_index():
        caminho = os.path.join(raiz, index_file)
        st = os.stat(caminho)
        # Os carimbos entram na CHAVE do cache, e não só no corpo: um shim atualizado sem que o
        # index mude é o caso normal (uma reinstalação mexe no pacote, nunca no `index.html`). Sem
        # isto o processo continuaria servindo a URL carimbada antiga até alguém tocar no index — e
        # o carimbo teria virado enfeite justamente no cenário que ele existe para cobrir.
        #
        # ⚠ As folhas entram nesta chave junto com os scripts. Esquecê-las reproduziria o mesmo
        # defeito que o parágrafo acima descreve, e no caso delas o sintoma é pior: uma cor velha
        # não parece cache, parece decisão de design.
        chave = (st.st_mtime_ns,
                 tuple((s, carimbo_do_src(s)) for s in inject_styles + inject_scripts))
        with tranca_do_index:
            if cache_do_index["chave"] == chave:
                return cache_do_index["corpo"]

        with open(caminho, "r", encoding="utf-8") as fh:
            html = fh.read()
        if inject_styles or inject_scripts:
            marcas = tags()
            if "</head>" in html:
                html = html.replace("</head>", f"{marcas}\n</head>", 1)
            else:
                html = marcas + html
        corpo = html.encode("utf-8")
        with tranca_do_index:
            cache_do_index["chave"] = chave
            cache_do_index["corpo"] = corpo
        return corpo

    def stat_dentro(caminho_url, base=None):
        """Um caminho só é servido se cair dentro da base depois de resolvido.

        A checagem lexical não basta sozinha: um symlink dentro do bundle apontando para fora
        passaria por ela. Por isso o caminho REAL é revalidado depois do stat.
        """
        base = raiz if base is None else base
        alvo = os.path.normpath(os.path.join(base, caminho_url.lstrip("/")))
        if alvo != base and not alvo.startswith(base + os.sep):
            return None
        try:
            st = os.stat(alvo)
        except OSError:
            return None
        if os.path.isdir(alvo):
            return None
        real = _real(alvo)
        if real != base and not real.startswith(base + os.sep):
            return None
        return alvo, st

    def resolver(caminho_url):
        direto = stat_dentro(caminho_url)
        if direto:
            return direto
        for prefixo, base in montados:
            if caminho_url.startswith(prefixo):
                achado = stat_dentro(caminho_url[len(prefixo) - 1:], base)
                if achado:
                    return achado
        for prefixo, substituto in alias_prefixes:
            if caminho_url.startswith(prefixo):
                achado = stat_dentro(substituto + caminho_url[len(prefixo):])
                if achado:
                    return achado
        return None

    def _cabecalhos(handler, status, tipo, tamanho, extras=None):
        handler.send_response(status)
        handler.send_header("Content-Type", tipo)
        handler.send_header("Content-Length", str(tamanho))
        for k, v in (extras or {}).items():
            handler.send_header(k, v)
        handler.end_headers()

    def mandar_index(handler):
        try:
            corpo = corpo_do_index()
        except OSError as err:
            ao_avisar({"event": "index-missing", "root": raiz, "message": str(err)})
            texto = (f"Bundle não encontrado em {raiz}.\n"
                     + (missing_bundle_hint + "\n" if missing_bundle_hint else "")).encode("utf-8")
            _cabecalhos(handler, 500, _TIPOS["txt"], len(texto))
            if handler.command != "HEAD":
                handler.wfile.write(texto)
            return True
        # O index carrega o script de boot, que costuma trazer estado do usuário — nunca de cache.
        _cabecalhos(handler, 200, _TIPOS["html"], len(corpo), {"Cache-Control": "no-store"})
        if handler.command != "HEAD":
            handler.wfile.write(corpo)
        return True

    def servir(handler):
        if handler.command not in ("GET", "HEAD"):
            return False

        partes = urlsplit(handler.path)
        # `%` malformado faz o unquote devolver lixo em vez de levantar; o que importa é não deixar
        # um caminho inválido virar 500 genérico no `except` de quem compõe as rotas.
        try:
            caminho_url = unquote(partes.path, errors="strict")
        except (UnicodeDecodeError, ValueError):
            texto = b"Caminho inv\xc3\xa1lido.\n"
            _cabecalhos(handler, 400, _TIPOS["txt"], len(texto))
            handler.wfile.write(texto)
            return True

        if caminho_url in ("/", "/" + index_file):
            return mandar_index(handler)

        achado = resolver(caminho_url)
        if not achado:
            # Fallback de SPA: roteamento HTML5 produz URLs que não são arquivo nenhum, e sem isto
            # elas viram 404 — o app quebra em qualquer deep link ou F5. Opt-in porque um app de
            # roteamento por fragmento não precisa, e ligá-lo sem necessidade transforma 404 de
            # asset em HTML, que é bem mais difícil de diagnosticar.
            aceita_html = "text/html" in (handler.headers.get("Accept") or "")
            ultimo = caminho_url[caminho_url.rfind("/") + 1:]
            if spa_fallback and handler.command != "HEAD" and aceita_html and "." not in ultimo:
                return mandar_index(handler)
            return False  # 404 é decisão de quem compõe as rotas

        alvo, st = achado

        # `?v=` CONFERIDO contra o hash de agora, e não aceito de boca. Carimbo velho — de um index
        # que sobreviveu em algum cache apesar do `no-store` — não pode ganhar `immutable`, senão
        # fixaria os bytes errados por um ano.
        pedido = (parse_qs(partes.query).get("v") or [None])[0]
        imutavel = bool(pedido) and pedido == carimbador.de(alvo)

        ultima_mudanca = formatdate(st.st_mtime, usegmt=True)
        ims = handler.headers.get("If-Modified-Since")
        if not imutavel and ims and _mesma_data(ims, ultima_mudanca):
            handler.send_response(304)
            handler.send_header("Last-Modified", ultima_mudanca)
            handler.send_header("Cache-Control", "no-cache")
            handler.end_headers()
            return True

        _cabecalhos(handler, 200, tipo_de_conteudo(alvo), st.st_size, {
            "Last-Modified": ultima_mudanca,
            # Com carimbo válido, conteúdo novo mora em OUTRA URL — então esta pode ser cacheada
            # para sempre. Sem carimbo, é bundle de nome fixo (main.js): cache longo aí serviria
            # versão velha depois de um upgrade.
            "Cache-Control": "public, max-age=31536000, immutable" if imutavel else "no-cache",
        })
        if handler.command != "HEAD":
            with open(alvo, "rb") as fh:
                # Em pedaços: um wasm de 40 MB lido de uma vez é 40 MB de RAM por requisição, e o
                # app tem um teto de memória declarado no manifesto.
                while True:
                    pedaco = fh.read(64 * 1024)
                    if not pedaco:
                        break
                    handler.wfile.write(pedaco)
        return True

    return servir


def _mesma_data(recebida, nossa):
    """Compara `If-Modified-Since` sem exigir a mesma GRAFIA.

    O Node compara as duas strings, e ali isso basta porque quem gerou a nossa foi
    `toUTCString()`. Aqui a data do cliente pode vir num formato equivalente e escrito de outro
    jeito — comparar texto faria o 304 nunca acontecer, e o custo seria reenviar o bundle inteiro
    a cada F5, sem nada acusando.
    """
    if recebida == nossa:
        return True
    try:
        return parsedate_to_datetime(recebida) == parsedate_to_datetime(nossa)
    except (TypeError, ValueError):
        return False
