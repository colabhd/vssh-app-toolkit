# Onda 2c — Interlúdio: recolher o que a inversão deixou, e estabilizar a experiência

> **Estado:** 🟡 em andamento — **itens 1 e 2 concluídos** · **Atualizado:** 2026-08-05 · **Repos:** `vssh-sso`, `vsshapp-xpra` (+ um novo)
>
> Vem depois da [Onda 2.7 inteira](02b-motores.md), que **fechou os quatro passos**. Não é uma onda
> de capacidade nova: é a fatura da inversão, e três defeitos que só ficaram visíveis depois dela.
>
> **O passo 4 foi executado antes desta onda**, invertendo a ordem que este documento previa — e
> foi a decisão certa: ele achou um `TypeError` vivo em produção (`VsshHost.xpraDisabled()` chamado
> atrás de um `typeof VsshHost` que não protege de método ausente) e uma coluna de banco sem
> consumidor nenhum. Vocabulário morto estava escondendo mecanismo morto, e adiar teria feito a 2c
> construir por cima dos dois.

## A tese

A [Onda 2.7](02b-motores.md) trocou quem serve o desktop: era o processo Xpra do usuário, passou a
ser o portal. A troca funcionou e os números saíram. Mas uma inversão desse tamanho deixa três
tipos de resíduo, e nenhum deles se recolhe sozinho:

1. **Coisas que perderam o assunto e continuam sendo construídas.** Deploy de cliente custom,
   canal stable/bleeding-edge, extensão do Chrome — CI rodando, artefato publicado, aba no painel
   admin, coluna no banco. Nada quebra; só que ninguém consome.
2. **Uma defesa que não veio junto.** O portal tem fingerprinting de assets há tempos. O shell
   entrou no portal e **não entrou na defesa** — por isso o `Shift+F5`.
3. **Uma propriedade nova que ninguém nomeou.** O ambiente agora sobrevive a uma queda do portal,
   porque é só JS rodando no cliente. Isso é novo, é bom, e hoje é **invisível** — inclusive quando
   deveria ser visível.

> **O critério desta onda é diferente do das outras.** Não se mede por capacidade entregue, e sim
> por **superfície que deixou de existir** e por **falha que deixou de ser silenciosa**. Se ao fim
> dela o repositório não estiver menor e os erros não estiverem mais altos, ela não aconteceu.

---

## 1 · Os deploys que perderam o assunto — ✅ CONCLUÍDO

> **Feito** em `4eb687b` (as excisões) e `481fcfb` (a poda no shell + a guarda), mais `baae789` no
> `vsshapp-xpra`. **89 arquivos, −6460 linhas.** lint, tsc e 465 testes verdes.
>
> ⚠ **Ordem de deploy:** publicar `vsshapp-xpra` **antes** de deployar o portal — os daemons
> migraram para o pacote, e um servidor reprovisionado no meio ficaria sem eles.

O cliente HTML5 já foi instalado **no servidor do usuário**, em `/usr/share/xpra/vssh-client-www*`,
por um script no host, com dois canais e uma lista de usuários beta no fonte TypeScript. Nada disso
alcança o navegador hoje — o portal serve o shell direto.

**A superfície completa, medida:**

| O quê | Onde | Tamanho |
|---|---|---|
| CI e script de publicação | `.github/workflows/{chrome-extension,publish-customclient,release-customclient}.yml` + `.github/scripts/publish-customclient.sh` | 168 linhas |
| A extensão do Chrome (MV2) | `vssh-client/chrome-extension/` | 19 arquivos, 157 KB |
| Handler no worker do repositório | `repo-worker/src/handlers/customclient.js` | — |
| **A maquinaria de canal** | coluna `xpra_client_channel`, `updateClient()` (`infra-update.ts:54`, que ainda executa `sudo vssh-update-client` no host), `PUT /servers/:id/client/channel` e `POST …/client` (`admin.ts:284-300`), e a aba **Repositório → Cliente** do painel | a que mais se esconde |

### O que a medição achou além da tabela — e o que ela mudou no plano

A tabela acima estava certa e **incompleta**. Três superfícies não listadas, todas vivas:

| Não previsto | O que era |
|---|---|
| **O atualizador no host** | `infra/server/vssh-update-client.sh` (81 linhas), sua entrada em `binaries.json`, e um **`vssh-client-update.timer` systemd rodando de hora em hora em todo servidor provisionado** |
| **Cinco daemons X11** | o tarball do cliente também instalava `vssh-psdialog(d)`, `vssh-browser`, `vssh-fileserver` e `vssh-vscode` em `/usr/local/bin`. **Apagar a esteira sem olhar teria levado os cinco** |
| **O rastro no shell** | `ExtensionAdapter` e ~30 pontos de chamada — maior que o artefato, e ainda executando |

**Os daemons foram auditados um a um**, e a divisão não foi a esperada: três estão **vivos** (o
`entrypoint.sh` do motor inicia o `vssh-psdialogd`; o `.desktop` do `vssh-browser` é handler padrão
de ~30 MIMEs) e foram para o **pacote `vsshapp-xpra`**, onde está o `Client.js` que despacha os
esquemas que eles emitem — a mesma migração que a 2.7 fez com os defaults de MIME. Os outros dois
não tinham consumidor: `vssh-fileserver` **não tinha iniciador em repositório nenhum**, e nada
registra `inode/directory` para o `vssh-vscode`. A fase root do `install.sh` do motor **remove os
dois** de servidores que já os tinham.

O `provision-base.sh` ganhou o par honesto da remoção: reprovisionar **desliga e apaga** o timer.
Sem isso, a maquinaria sobreviveria à própria exclusão do repositório — falhando em silêncio, de
hora em hora, para sempre.

### Três defeitos que a poda revelou, e nenhum deles dava erro

Não estavam previstos porque nada os denunciava — é o argumento da onda, encontrado por acaso
dentro dela:

1. **4 segundos a mais na restauração de sessão.** `WindowStateManager` esperava
   `vsshExtensionReady` quando não havia motor, com timeout de segurança de 4 s. O evento não é
   emitido por ninguém desde a 2.6, então o ramo **caía sempre no timeout**.
2. **`BrowserWindow.openInTab` fazia o oposto do nome.** Filtrava por `w._hasExtension`, sempre
   falso: nunca abria em aba, sempre criava janela nova.
3. **`_onFrameTitle` sem chamador nos dois repositórios**, e sua última linha chamava
   `ExtensionAdapter.addHistory` — que já era **no-op silencioso**. Quem grava histórico de verdade
   é o `fetch` de `_onTabLoad`.

Mais três variáveis de ambiente **sem leitor em código** (`XPRA_CUSTOM_HTML_PATH`,
`XPRA_BLEEDINGEDGE_HTML_PATH`, `XPRA_FILE_SERVER_PORT`) — existiam só no `.env.example`, no
`types/` e na doc, que afirmava que `office.ts` lia a terceira. Não lia.

> **`ExtensionAdapter` virou `BrowserApi`.** Metade da classe era ponte para a extensão e virou
> no-op permanente; a outra metade sempre foi REST puro (`/api/user/browser/history*`) e é o que
> sobrou. Manter o nome antigo seria deixar o vocabulário mentindo — a lição que o passo 4 da 2.7
> cobrou caro.
>
> **Ficou uma ponta:** as rotas `GET/POST /api/user/browser/proxy-config` do servidor perderam o
> único cliente (o popup da extensão). Não foram removidas — é decisão à parte, e o gate
> `proxy_max_level` que elas leem segue muito vivo no `pac-proxy`.

**A guarda:** `tests/unit/deploys-sem-assunto.test.js`, cinco testes no molde do
`motor-x11-poda.test.js` — inclusive o `semComentarios()`, pela mesma razão de lá. Cada uma foi
**provada por refutação**, reintroduzindo o que proíbe: 6/6 capturadas.

**A extensão sai de vez** — não vira repositório próprio. E a decisão é barata porque **a 2.6 já
tinha feito o desmonte funcional**: a sentinela `'extension'` deixou de ser um motor de navegação,
`BrowserEngines.get('extension')` sempre devolveu `null`, e o sanitizador de `browserEngine` migra
quem a tivesse gravada para "Desabilitado". Existe até um teste que proíbe a string de voltar
(`settings-registry.test.js`, *"a sentinela 'extension' não sobrevive em código nenhum do shell"*).
O que sobrou é o artefato e a esteira que o produz.

> **A quarta superfície é a que justifica o item.** As três primeiras são arquivos que ninguém abre.
> A maquinaria de canal é diferente: ela tem **UI no painel admin**, e uma UI que executa uma ação
> sem efeito é pior que código morto — ela mente para o operador. Quem clicar em "atualizar cliente"
> vai receber um `sudo /usr/local/sbin/vssh-update-client stable --force` que instala bytes que
> ninguém serve, e um verde de sucesso.

---

## 2 · O cliente com fingerprint — ✅ CONCLUÍDO

> **Feito** em `a3167ca`. **11 arquivos, +618/−71.** lint, tsc e **481 testes** verdes; **8/8
> refutações** capturadas.
>
> **107 referências locais no `index.html` servido, 107 carimbadas, 0 cruas.** (A tabela previa
> 106; a 107ª é o `favicon.svg`, que também revalidava a cada carga.)

### O diagnóstico, e ele muda o enquadramento

Não é "melhorar o cache busting". **O portal já tem fingerprinting; o shell está fora dele.**

```ts
src/app.ts:37    BUILD_ID = computeBuildId(PUBLIC_DIR)             // public/ — o portal
src/app.ts:173   app.use('/b/:buildId', express.static(PUBLIC_DIR, { maxAge: '1y' }))
```

O shell é servido por outro caminho, e o próprio arquivo declara a lacuna:

```js
// src/services/vssh-shell.ts:108
// Os assets não são versionados por path aqui (o cliente referencia `js/…` relativo),
// então revalidação é o único jeito honesto de não servir arquivo velho depois de um deploy.
etag: true, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
```

*"O único jeito honesto"* — **dada a restrição**. Esta onda remove a restrição.

### O argumento mais forte não é o `Shift+F5`

| | hoje | com fingerprint |
|---|---:|---:|
| `<script src>` no `index.html` | 77 | 77 |
| `<link rel=stylesheet>` | 29 | 29 |
| **requisições condicionais por carga** | **106** | **0** |

São 106 idas ao servidor em **toda** carga do ambiente, só para ouvir `304`. O `Shift+F5` é o
sintoma que incomoda; as 106 são o custo que ninguém está vendo.

### Metade do trabalho já existe

`SHELL_BUILD_ID = computeBuildId(SHELL_DIR)` **já é calculado** (`vssh-shell.ts:31`), **já é
injetado** na página como `window.__VSSH_SHELL_BUILD__` e **já é exposto** em
`GET /api/shell/config`. O que falta é usá-lo **nos caminhos**.

### Duas formas, e o trade-off tem de ser escolhido com os olhos abertos

| | Como | Custo | Invalidação |
|---|---|---|---|
| **A — prefixo por build** | `/b/<buildId>/js/Client.js`, como o portal já faz | quase zero: uma linha de rota e a reescrita do prefixo no `index.html` | **tudo junto** — um byte muda e os 3,8 MB revalidam |
| **B — hash por arquivo** | `js/Client-[sha8].js` | etapa de build no deploy, que reescreve as 106 referências | **cirúrgica** — só o arquivo que mudou |

**A escolha foi B — e o custo da coluna do meio não se pagou.** A tabela supunha que "hash por
arquivo" implicava "etapa de build no deploy". Não implica: **quem carimba é quem serve**, em
memória, no boot, com um manifesto `{caminho → sha8}` que sai da MESMA varredura que já calculava o
build id. O arquivo em disco continua com o nome simples — e é isso que mantém `vssh-client/`
editável e mantém valendo as redes que leem o fonte (`client-assets`, `client-css-classes`,
`client-dom-ids`, `client-undefined-refs`).

A razão de o portal usar A e o shell usar B não é gosto, e ficou escrita nos dois lados: o portal
tem grafo de import ES, e **só um prefixo de path é herdado** por um `import './modules/api.js'`. O
shell **não tem um único módulo ES** — são 77 `<script>` clássicos listados no `index.html`. A
restrição que obriga A lá simplesmente não existe aqui. E a medição de tamanho confirmou o resto:
dos 3,6 MB, **844 KB são jQuery + jQuery UI**, que não mudam há anos. Sob prefixo único, todo deploy
do portal os rebaixaria de novo.

> ⚠ **A armadilha de B era real, mas não era a que a tabela descrevia.** A medição não achou
> **nenhum** `new Worker`/`SharedWorker` no shell, e o `importScripts` que existe (`scram-sw.js`)
> busca o Scramjet de fora, não asset local. O grafo de workers não existe.
>
> **A armadilha verdadeira é o oposto, e é pior:** a URL de um service worker **é o escopo dele**.
> Carimbar `sw.js` daria a ele um escopo novo a cada deploy, e o registro anterior continuaria vivo
> controlando a mesma página — dois SW disputando o mesmo cliente, sem erro em lugar nenhum. Por
> isso `sw.js` e `scram-sw.js` são explicitamente **proibidos** de receber carimbo, e há teste que
> cai se alguém "consertar" a string de registro.
>
> A segunda: uma query (`?v=`) **não propaga para dentro de um `url()` de CSS** — e é ali que moram
> os 703 KB de ícones e as fontes. As folhas servidas têm os `url()` reescritos junto; as folhas em
> disco, não.

### O que a medição achou além da tabela

| Achado | Consequência |
|---|---|
| **O aviso de "ambiente atualizado" nunca apareceu — em nenhuma versão.** `checkBuildId()` buscava `build-info.json` e comparava `info.buildId` com o do carregamento anterior; o arquivo é versionado e o valor dentro dele era o literal `"dev-build"`, imóvel. A comparação era do stub com ele mesmo | O ramo era inalcançável, e a busca era **uma requisição por carga para não decidir nada**. Agora compara a identidade injetada, que muda a cada deploy — e a requisição sumiu |
| Uma referência a mais do que a tabela contava: o `favicon.svg` | 107, não 106 |
| `computeBuildId` e o manifesto por arquivo são **a mesma leitura de disco** respondendo duas perguntas | O walk passou a morar num lugar só (`asset-fingerprint.ts`). Duplicá-lo seria criar duas noções de "mudou" livres para divergir |

### A política, em quatro linhas

| | forma | política |
|---|---|---|
| `index.html` | sem carimbo | `no-cache` — é ele que carrega os carimbos novos |
| assets | `js/Client.<sha8>.js` | `immutable`, 1 ano |
| carimbo de uma build **anterior** | idem | servido com o arquivo de hoje, **revalidando** — uma aba aberta durante um deploy rolling não pode receber 404, mas também não pode ficar presa |
| `sw.js` / `scram-sw.js` | **nunca** carimbados | `no-cache` |

E uma falha que deixou de ser silenciosa: um arquivo que nasça chamado `algo.deadbeef.js` tornaria
o descarimbo ambíguo — o middleware leria "`algo.js` da build deadbeef" e devolveria 404 para um
asset que está em disco. **O boot morre**, dizendo o nome do arquivo.

### O que veio junto, e são duas identidades

- ✅ **Identificador de versão real nas Configurações.** Em **Sobre → Ambiente**, primeira linha da
  tabela de identidade, e a única que não espera rede: a versão vem injetada na página. É a resposta
  para *"que versão eu estou rodando?"*, que não existia em lugar nenhum da interface.
- ✅ **Versionamento nominal (`4.0.0`).** `vssh-client/build-info.json` era um stub
  (`dev-build` / `0000000`) e passou a ser a **declaração** — e só ela: o `buildId` e o `shortSha`
  saíram de lá, porque uma cópia que envelhece dentro de um arquivo versionado é sempre a versão
  errada de uma medição.

  > **Elas respondem perguntas diferentes, e por isso as duas são publicadas.** `shellVersion` é
  > **declarada** e só muda quando alguém decide que mudou — é a que a Onda 3 vai deixar um app
  > exigir. `portalShellBuildId` é **medida** do conteúdo e muda a cada deploy — é a que diz se dois
  > ambientes rodam os mesmos bytes. Publicar só uma obrigaria alguém a usá-la para as duas coisas.

  > **O que entra aqui é só a metade que PUBLICA.** A versão passa a existir, a ser servida em
  > `/api/shell/config` e a aparecer nas Configurações. **Quem a CONSOME é a
  > [Onda 3](03-toolkit.md#o-shell-tem-versão-e-o-app-pode-exigi-la)** — o campo no manifesto, a
  > validação no publish e a mensagem quando não bate. A divisão é deliberada: publicar uma versão
  > é barato e não tem consumidor a quebrar; declarar contrato sobre ela é decisão de toolkit, e o
  > lugar dela é junto com `requiredPackages`, que atravessa a mesma fronteira.

### A perda, declarada

**A soft-update morreu com a inversão, e não volta.** Quando o cliente era instalado no servidor, um
`vssh-update-client` trocava os bytes sem redeploy do portal. Agora o shell viaja com a imagem do
portal: atualizar o cliente é subir o portal. **O ganho supera** — some a esteira inteira do item 1,
some a divergência entre servidores, some o canal beta no fonte —, mas a perda é real e quem
mantém precisa saber que ela foi escolhida, não esquecida.

---

## 3 · O service worker que não faz mais nada

Está **dormente**, e o próprio código diz:

```js
// vssh-client/sw.js:26
const CURRENT_BUILD_ID = '__BUILD_ID__'; // dormente: ninguém substitui mais (ver acima)
```

O substituidor era o `publish-customclient.sh` — que o item 1 apaga —, e ele já tinha desistido de
propósito (`publish-customclient.sh:30`). Resultado: `install` retorna cedo, nenhum cache
`vssh-assets-*` nasce, e todo `fetch` cai na rede.

**São ~170 linhas de maquinaria de cache que nunca roda.** O que continua vivo no arquivo é o
passthrough de download do StreamSaver — esse fica.

> **Não confundir com `scram-sw.js`.** É outro arquivo, do motor de navegação, e não tem nada a ver
> com esta limpeza.

E há uma razão de desenho para o cache do SW **não** voltar, escrita em `vssh-shell.ts:79-99`: um
SW que cacheia por build cria duas camadas com políticas contrárias, e vence a que está na frente —
o sintoma medido foi *"F5 mostra o cliente velho e só a carga seguinte mostra o novo"*, com assets
de duas builds na mesma página. Com fingerprint nos caminhos, o SW não tem o que resolver.

> **A precondição que o arquivo pedia chegou — e ela fecha a pergunta em vez de abri-la.** O
> comentário do `sw.js` dizia *"ANTES DE RELIGAR: versionar a URL dos assets"*. O item 2 fez isso, e
> o navegador já guarda cada asset como imutável por um ano, sem revalidar. O que resta decidir não
> é mais a precondição, e sim se sobra trabalho para este cache depois dela.

---

## 4 · A sessão que expira em uso, e o heartbeat

### A causa é uma linha

```js
src/app.ts:115   cookie: { httpOnly: true, secure: …, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
```

**`rolling` não está setado.** Sem ele, a expiração é **absoluta**: oito horas depois do login o
cookie morre, esteja você trabalhando ou não. Conferido que o OIDC não impõe TTL próprio —
`requireAuth` só olha `req.isAuthenticated()`, então a sessão é a única fonte da verdade.

### O heartbeat precisa RENOVAR, não só observar

É a consequência que muda a ordem do trabalho. Um indicador que só observa mostraria a morte com um
relógio bonito. E ele **tem de ser HTTP**: o `/ws/events` roda o middleware de sessão com um `res`
de mentira cujo `setHeader` é no-op (`proxy/upgrade.ts`), então o WebSocket nunca refresca cookie
nenhum, por mais vivo que esteja.

### O segundo buraco: o cliente não sabe o que é um 401

**98 chamadas `fetch(` cruas no shell, e zero tratamento de 401.** Não existe wrapper central. É
exatamente por isso que a falha foi silenciosa — não havia onde ela pudesse aparecer.

O portal já pagou essa lição, e ela está escrita em `tests/unit/api-fetch.test.js`: **decidir pelo
STATUS primeiro, parsear só depois** — porque o que chega ao navegador nem sempre é do Express (o
HTML de 502/504 do proxy, a página padrão de 413/431), e um `res.json()` prematuro estoura
`SyntaxError` levando o status real junto.

### A ordem, e ela importa

1. **`rolling: true`** — sem isso, todo o resto é cosmético. Verificar a interação com
   `resave: false` e `saveUninitialized: false` com teste, não por leitura da documentação.
2. **`apiFetch` no shell**, com o contrato do portal. É pré-requisito de 3 e 4.
3. **`/api/session/ping`** — barato, autenticado, e é ele que renova.
4. **O indicador na bandeja** — `TrayArea` já aceita `{ icon, tooltip, badge, menu, onClick }` com
   badge de ponto/contador/texto, então o item nasce sem UI nova.

---

## 5 · O micro offline mode, nomeado

Quando o desktop era servido pelo Xpra, uma queda do servidor **desconectava o usuário**. Hoje não:
o shell é JS rodando no navegador, e uma piscada do portal é uma requisição que falha — o ambiente
continua de pé, com as janelas abertas e o trabalho na tela.

**Isso é propriedade nova, veio de graça com a inversão, e não está escrita em lugar nenhum.**
Escrever importa por dois motivos opostos:

- **É uma garantia**, e quem constrói superfície nova precisa saber que pode contar com ela — uma
  janela não deve se destruir porque um `fetch` falhou;
- **É estreita**, e prometer mais que isso seria pior que não prometer. Não é offline mode: uma
  escrita que falhou continua perdida, o gerenciador de arquivos não navega sem o portal, e nenhum
  motor sobrevive à queda do backend dele. O que sobrevive é **o que já está na tela**.

O heartbeat do item 4 é o que torna isso legível: *"o portal está fora, o que você tem continua
aqui, e eu aviso quando voltar"* — em vez de um erro genérico por operação.

---

## 6 · O `repo-worker` sai do monorepo

990 linhas (JS + a migração D1 + o `wrangler.toml`) em 18 arquivos — um Cloudflare Worker inteiro
morando dentro do repositório do portal. **Acoplamento medido: zero** (nenhum import atravessa para
`src/`).

Sai **depois** do item 1, e não antes: assim ele nasce no repositório novo já sem
`handlers/customclient.js`, em vez de carregá-lo para depois apagar. ✅ **O item 1 já fez essa
parte** — o handler, a rota `POST /v1/publish/customclient` e o escopo `kind:customclient` saíram
em `4eb687b`, então a extração começa de um worker que já não conhece o cliente. As 990 linhas
medidas caem para ~936.

> ⚠ **`handlers/browser-extensions.js` FICA, e não é o que o nome sugere a quem chega de fora.**
> Ele não tem nada a ver com a extensão MV2 do Chrome do item 1: serve as **extensões do navegador
> embutido** — `kind='browser-extension'`, artefato é um módulo ES único (`bundle.js`) carregado
> por `import()` no runtime do motor Scramjet, com ícone em blob separado. O portal o consome em
> `routes/browser.ts` (`GET /api/browser/extensions`, com cache Redis e broadcast de
> `extensions-updated`). **Confundir os dois e apagar o handler derrubaria as extensões de todo
> usuário do navegador** — e o nome parecido é a única coisa que os une.

O contrato com o portal é HTTP e já está isolado em `src/services/repo-client.ts`, com `VSSH_REPO_API`
apontando para `https://vssh-repo.colabh.org`. Nada no portal precisa mudar.

---

## 7 · `connect.html`

73 KB do diálogo de conexão do **upstream** do xpra-html5, ainda em `vssh-client/`. Inalcançável
desde que o `callback_close` deixou de redirecionar (Onda 2.7), e sem decisão desde então.

É o menor item da onda e o mais alinhado com o tema: **peso morto que ninguém nomeia é exatamente o
que a 2c existe para não deixar acontecer.**

---

## 8 · As telas de erro, que são de outra era e de outro tamanho

Tudo mora em **um** arquivo: `src/utils/render-error.ts`, 320 linhas, com 11 chamadas em `app.ts` e
`proxy.ts`. São elas que aparecem quando um app quebra, quando o backend não subiu, e quando a
sessão morre:

```
409 'App não iniciado'          ← o que aparece quando um app quebra
409 'Usuário não provisionado'
502  autoRetry: true            ← "Serviço Offline", com o contador de 10s
401 'Não autorizado'            ← o mesmo 401 silencioso do item 4
403 · 404 ×4 · 500 ×2
```

### Por que parece de outra época — porque é

Ele tem **paleta e tipografia próprias**, sem nenhuma relação com o tema:

```ts
--accent:       ${color}        // calculado por status: âmbar, azul, vermelho, amarelo…
--font-display: 'Syne'
--font-body:    'Instrument Sans'
--font-mono:    'DM Mono'
```

Mais o vocabulário visual que a [Onda 0c](0c-colapso-de-variantes.md) matou: malha de pontos por
`radial-gradient`, barras em gradiente, `box-shadow: 0 0 8px var(--accent)` e um rótulo em caixa
alta por status (`SISTEMA`, `SEGURANÇA`, `ACESSO NEGADO`). **Nenhum `--ds-*`.**

E ele **puxa fonte do Google Fonts** — numa página que, por definição, só aparece quando alguma
coisa já falhou, e possivelmente sem rede.

### O defeito estrutural: é página inteira, e aparece dentro de um iframe

```html
<a href="/" class="btn btn-ghost">Voltar ao Início</a>
<button onclick="window.location.reload()">Tentar agora</button>
Tentando novamente em <span id="vssh-countdown">10</span>s
```

Dentro da janela de um app, `href="/"` navega **o iframe** para a raiz do portal — o resultado é a
SPA do portal desenhada dentro de uma janelinha. E um contador de 10 s que se recarrega sozinho é
comportamento de página, não de painel dentro de uma janela.

### A saída: JSON para quem está dentro do ambiente

**Decidido: o proxy passa a devolver JSON quando o erro acontece dentro do ambiente, e quem desenha
é o shell** — com o chrome de janela que ele já tem, os tokens que ele já tem, e as ações que
fazem sentido ali (reiniciar o app, ver o log, fechar a janela) em vez de "Voltar ao Início".

O HTML **não morre**: navegação direta ao portal continua precisando de uma página. O que muda é
que ela deixa de ser a única resposta.

> **O discriminador provável é `Sec-Fetch-Dest`**, e vale dizer por que não é outro: o shell não
> controla os cabeçalhos de uma navegação de iframe, então não dá para pedir `Accept: json` como
> o `apiFetch` faz. O navegador, porém, manda `Sec-Fetch-Dest: iframe` para o carregamento de um
> iframe e `document` para uma navegação de topo — que é exatamente a distinção necessária.
> **Medir antes de construir**: confirmar o valor que chega ao proxy nos dois casos, e ter recuo
> para HTML quando o cabeçalho não vier.

### E o 401 fecha o círculo com o item 4

Hoje o `401 'Não autorizado'` é uma página inteira dentro do iframe. Com o `apiFetch` tratando 401
e a sessão renovando por `rolling`, ele deveria ser **reautenticação dentro do ambiente** — não uma
tela. Os dois itens consertam a mesma experiência por pontas diferentes, e é bom que caiam na
mesma onda.

---

## 9 · Uma tela de log que seja uma tela de log

Hoje são **duas implementações da mesma coisa**, e nenhuma das duas é um visualizador:

| Onde | O que faz | O problema |
|---|---|---|
| Configurações → Serviços (`secoes-sistema.js:154`) | `VsshDialogs.alert(texto)` | o log inteiro **como mensagem de alerta**. E `catch { texto = '' }` engole a falha: uma leitura que deu erro aparece como *"o log está vazio"* |
| Menu de contexto da janela (`ContextMenu.js:324`) | `VsshDialogs.textInputBox(…, { init: body })` | o log dentro de um **campo de entrada de texto**. O comentário confessa o contorno: *"o log vai no campo de texto (init), não na mensagem: assim rola e dá para copiar"* |

Duas consequências que não são estéticas:

- **Elas mostram dados diferentes.** O menu de contexto traz o `run.log.1` (a execução ANTERIOR —
  justamente onde está o interessante quando o app morreu e subiu de novo); a tela de Serviços,
  não. O mesmo log, dois lugares, duas respostas.
- **`tail=300` está fixo nos dois**, sem como pedir mais.

E falta o que qualquer visualizador de log tem: acompanhar em tempo real, buscar, quebrar linha ou
não, baixar, e distinguir uma linha de erro de uma linha comum.

> **É uma janela, não um diálogo** — e essa é a decisão do item. Diálogo é para uma pergunta com
> resposta curta; log é conteúdo que se lê, se rola, se procura e se deixa aberto ao lado do
> trabalho. Enquanto for diálogo, ele bloqueia o ambiente para fazer algo que precisa conviver com
> ele.
>
> As duas entradas passam a abrir **a mesma** janela, e o `run.log.1` aparece nas duas — a
> divergência de hoje é o argumento mais forte contra manter dois caminhos.

## 10 · Os dois riscos que a 2.7 deixou por medir

Ela fechou os quatro passos com R1, R2, R4, R5, R7, R8 e R9 conferidos — vários contra servidor
real. **R3 e R6 nunca foram medidos**, e os dois são sobre o mesmo momento: o motor sendo instalado
e subindo pela primeira vez num servidor que ninguém preparou à mão. É o momento em que a 2.7 é
verdade ou não é.

**Os dois mudaram de premissa desde que foram escritos, e o texto da 2.7 ficou para trás:**

| | O que a 2.7 supunha | O que o pacote faz hoje |
|---|---|---|
| **R3** | *"o pacote passa `--html=off`, e é esse `GET /` que precisa ser medido"* | ele passa **`--html="${AQUI}/frontend"`** (`entrypoint.sh:189`) — aponta para dentro do pacote. Então `GET /` **não fica calado**: devolve o `index.html` do motor |
| **R6** | *"num servidor sem repositório de pacote configurado (`VSSH_XPRA_REPO`) isso falha"* | `install.sh` faz `apt-get install -y xpra xvfb`, com recuo para `dnf` — **não há `VSSH_XPRA_REPO`**. A falha real é outra: distro cujo repositório não tem o pacote `xpra` |

**R3 — o healthcheck aceita o que o motor responde?** São dois caminhos de código, e a 2.7 já
mandava conferir os dois: o poll do portal aceita qualquer coisa que não seja `000`, e o
`healthcheckPath: "/"` do manifesto é outro. Com `--html` apontando para o pacote, a resposta
provável é um `200` com HTML — mas *provável* não é medido, e o custo de errar é uma janela que
abre em branco com o backend de pé.

**R6 — o erro de instalação chega a quem instala?** `install.sh` já falha no lugar certo (na
instalação, não no primeiro uso — e o comentário dele diz isso). O que falta medir é se a mensagem
**sobe até a aba admin** ou morre no `run.log`. Um `vssh-app-install` que falha em silêncio produz
um app instalado que nunca sobe, e o operador descobre pelo usuário.

> **Por que aqui e não numa onda de capacidade:** os dois são medições, não construções. Cabem numa
> tarde, dependem de um servidor limpo, e são exatamente o tipo de coisa que fica para sempre "para
> a próxima" se não tiver um lugar. A 2c é o lugar — o critério dela é *falha que deixou de ser
> silenciosa*, e ambos são falhas silenciosas em potencial.

## O que esta onda NÃO faz

- **Não faz o passo 4 da 2.7** — ele já foi feito, e ANTES desta onda. A ordem inverteu de
  propósito: vocabulário morto estava escondendo mecanismo morto (uma coluna de banco sem
  consumidor, um flag injetado e lido por ninguém, um `TypeError` vivo no pacote do motor), e a 2c
  teria construído por cima dos três.
- **Não faz o healthcheck assíncrono.** O poll síncrono de 15×1 s (`vssh-apps.ts:569`) continua, e é
  da [Onda 4](04-runtime-composicao.md) — mexe no lifecycle, não na entrega do cliente.
- **Não ressuscita o cache do service worker.** Ver o item 3: com fingerprint nos caminhos ele não
  tem o que resolver, e a última tentativa produziu assets de duas builds na mesma página.
- **Não mexe no `scram-sw.js`** nem no motor de navegação.

## Verificação

**Automática:**

- ✅ **O contador que prova o item 2:** eram **107** referências locais revalidando a cada carga;
  são **107 carimbadas e 0 cruas**. A asserção não ficou no smoke: `shell-fingerprint.test.js` sobe
  o middleware de verdade e mede o `Cache-Control` por HTTP — porque o cabeçalho **é** o mecanismo,
  e verificar a intenção sem verificar o cabeçalho deixaria passar um `express.static` mal
  configurado, que é a forma mais provável de errar isso. 16 testes, **8/8** refutações capturadas.
- ✅ **O guard textual do item 1**, no molde do `motor-x11-poda.test.js`:
  `tests/unit/deploys-sem-assunto.test.js` — `xpra_client_channel`, `updateClient`,
  `vssh-update-client`, `chrome-extension`, `ExtensionAdapter`, `vsshBrowserExtension` e
  `customclient` não existem mais em **código** (comentário pode explicá-los, e deve). Cinco
  testes, todos provados por refutação.
- **O item 4 por refutação:** um teste que expira a sessão no store e confirma que o `ping` a
  renova; e outro que confirma que o `apiFetch` **decide pelo status antes de parsear** — o bug que
  o portal já teve.
- `lint`, `tsc` e a suíte inteira, como sempre.

**Manual, e é o gate:**

1. Fazer um deploy trivial (mudar uma string visível) e recarregar **sem** `Shift+F5`. Tem de
   aparecer.
2. Deixar o ambiente aberto além do TTL da sessão e continuar usando. Não pode deslogar.
3. Derrubar o portal com o ambiente aberto: as janelas continuam, a bandeja acusa, e ao voltar o
   indicador volta sozinho — sem F5.
