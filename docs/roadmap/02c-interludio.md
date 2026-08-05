# Onda 2c — Interlúdio: recolher o que a inversão deixou, e estabilizar a experiência

> **Estado:** 🟢 fechada — **itens 1 a 9 concluídos**; o 10 **medido por leitura**, com a metade que
> exige servidor limpo virando um checklist de quatro linhas para o próximo provisionamento (e o
> porquê está escrito lá) · **Atualizado:** 2026-08-05 · **Repos:** `vssh-sso`, `vsshapp-xpra`,
> `vssh-repo` (novo, item 6)
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

## 3 · O service worker que não faz mais nada — ✅ CONCLUÍDO

> **Feito** em `28b2731`. `sw.js` 244 → 168 linhas; `index.html` −33; `sw-cache.test.js` deu lugar
> a `sw-streamsaver.test.js`. **11 testes, 8/8 refutações** capturadas.
>
> A poda achou um **cliente em outro repositório** que a tabela não previa, e um **defeito vivo**
> que não tinha nada a ver com service worker. Ver "O que a medição achou", abaixo.

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
> é mais a precondição, e sim se sobra trabalho para este cache depois dela. **Não sobra.**

### O que a medição achou

| Achado | Consequência |
|---|---|
| **O único cliente do passthrough está em OUTRO repositório.** O `Client.js` do `vsshapp-xpra` faz `streamSaver.mitm = "./mitm.html"` ao receber um `xpra send-file` — e aquele `./` resolve contra a **página**, ou seja, contra o `mitm.html` deste bundle, que registra este `sw.js` | Três arquivos, dois repos, **nenhuma referência estática** ligando as pontas: nada no `vssh-sso` menciona `streamSaver` desde que a lib saiu com o cliente Xpra na 2.7. Uma limpeza futura concluiria, com razão aparente, que ninguém usa nenhum dos dois. É a corda que `sw-streamsaver.test.js` amarra |
| **A maquinaria de "deploy transparente" também estava morta**, e ela tinha UI: overlay de tela cheia, timer de 2 min e `location.reload()`. O gatilho era a mensagem `vssh-update-ready`, que o `activate` só postava **quando havia cache antigo a limpar** | Sem cache criado, nunca houve mensagem. Saiu junto. O gancho para ressuscitá-la é o **heartbeat do item 4**, comparando `window.__VSSH_SHELL_BUILD__` com `/api/shell/config` — não um segundo relógio no `index.html` |
| ⚠ **Um defeito vivo, e ele não era do service worker.** O `window.load` que sobe os apps `kind:"service"` e preaquece o motor de navegação estava **dentro** de um `if ('serviceWorker' in navigator)` | Numa **janela privativa do Firefox**, onde a API não existe, nenhum serviço subia e o motor nunca era preaquecido. Sem erro, sem log: só o ambiente chegando pela metade |
| O `sw.js` deixou de ser registrado no boot | Uma página **controlada** por um SW manda toda requisição de mesma origem passar por ele. Este não tem nada a dizer sobre 107 assets que o navegador já resolve pelo carimbo — então passa a existir quando há um download, que é quando ele serve para alguma coisa |

E o par honesto da remoção, a mesma lição do `provision-base.sh` no item 1: o `activate` que ficou
**apaga os `vssh-assets-*`** que a versão anterior criou em máquina de gente de verdade. Sem isso
eles ocupariam cota para sempre, sem ninguém para lê-los.

---

## 4 · A sessão que expira em uso, e o heartbeat — ✅ CONCLUÍDO

> **Feito** em `670ce3d`. **18 testes novos, 12/12 refutações** capturadas; suíte em 508.
>
> ⚠ **E não funcionava** — corrigido em `cffa724`, depois de ser notado em uso. O `sw.js` casava
> `/ping` por **sufixo**, então o batimento novo (`/:serverId/api/session/ping`) era respondido
> pelo próprio service worker com `text/plain` "pong". O portal nunca via a requisição — a sessão
> não renovava — e o shell, esperando JSON, lia aquilo como erro de parse, que o `SessionMonitor`
> traduz para *"o portal está fora"*. **O sintoma era o oposto do diagnóstico**, e nenhum teste
> pegava: os dois lados estavam certos isoladamente. Ver "A colisão do `/ping`", abaixo.
>
> Os quatro passos saíram na ordem prevista. O que mudou foi o **tamanho do passo 2**: as 98
> chamadas não foram migradas, e não por falta de fôlego — ver "A decisão sobre as 98", abaixo.

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

1. ✅ **`rolling: true`** — sem isso, todo o resto é cosmético.
2. ✅ **`VsshApi` no shell**, com o contrato do portal.
3. ✅ **`/api/session/ping`** — barato, autenticado, e é ele que renova.
4. ✅ **O indicador na bandeja** — nasceu sem UI nova, como previsto.

### O que a medição achou

**A interação com `resave: false` não se resolve lendo documentação, e a medição mostrou por quê:**
`rolling` só reemite o **cookie**. Quem estende o TTL no Redis é o `store.touch()`, que o
express-session chama exatamente no caso *"sessão existente e não modificada"* — o caso de toda
requisição de heartbeat, e que depende de `resave: false` continuar como está. **Os dois têm de
acontecer**, e se só um acontecesse a correção *pareceria* feita: cookie renovado sobre uma chave
já expirada desloga igual, só que mais tarde e sem explicação. `tests/unit/session-rolling.test.js`
mede os dois, com o middleware de verdade e um store no contrato do connect-redis — e o quarto
teste é a **refutação embutida**: sem `rolling`, o `touch` até acontece, mas o navegador continua
com a validade do login.

### A decisão sobre as 98 chamadas

Migrar as 98 para um helper de JSON seria trocar um problema real por uma migração grande com
regressão em cada tela — **e elas não são a mesma coisa**: muitas pedem blob, stream ou HEAD, e não
têm JSON para parsear; outras falam com o backend de um app pelo proxy, não com o portal. Pior: ao
fim da migração o 401 continuaria sendo notado em 98 lugares.

O que entrou no lugar é **um observador sobre o `window.fetch`**, instalado uma vez, que não altera
nada: chama o fetch original, devolve a **mesma** `Response` e só anota que passou um 401 de mesma
origem. Um lugar, sem mudança de comportamento, cobrindo inclusive o código que ainda não existe. A
regra que o mantém seguro é negativa — não trocar a resposta, não engolir rejeição — e é a primeira
coisa medida no teste, porque um observador que engole erro some com o diagnóstico de 98 telas.

> **Ele SUSPEITA, não conclui.** Um 401 de mesma origem quase sempre é a sessão do portal, mas
> "quase" não serve para um aviso na cara do usuário. O observador emite `vssh-api-401`; quem
> decide é o ping, que é a autoridade. Falso positivo custa um GET barato; falso negativo não
> existe, porque o ping roda de qualquer jeito.

**O 401 do shell não redireciona**, e é a única diferença deliberada em relação ao `fetchJson` do
portal. Lá, mandar para `/auth/login` é o certo: a página é um formulário. Aqui é um ambiente com
janelas abertas — jogá-lo fora porque uma requisição falhou desfaria a propriedade que a Onda 2.7
comprou. Sessão expirada abre o login em **outra aba**; o cookie vale para a origem inteira, e o
próximo ping limpa o aviso sozinho.

### A bandeja fica VAZIA quando está tudo bem

É regra, não economia: um ícone verde permanente é ruído que ensina a ignorar a bandeja — a lição
do botão de volume morto da Onda 2.1. Três estados, e cada um só existe enquanto há o que dizer:

| Estado | O que dispara | O que o clique faz |
|---|---|---|
| **sessão expirada** | 401 **no ping** — a única resposta que significa isso | abre `/auth/login` em outra aba |
| **portal fora** | falha de rede, timeout ou 5xx; o intervalo encurta de 5 min para 20 s | pergunta de novo agora |
| **versão nova publicada** | o `shellBuildId` do ping difere do `window.__VSSH_SHELL_BUILD__` | recarrega — **só com o clique** |

A última fecha o laço que o item 3 deixou aberto. A maquinaria antiga recarregava a página por
conta própria, com overlay e timer; ela nunca rodou, e não volta assim — **agir pelas costas de
quem está trabalhando é pior que não avisar**.

### A colisão do `/ping` — o item não funcionava, e o sintoma mentia

Notado **em uso**, não em teste, e é o achado mais desconfortável da onda: `"o pong tá cacheando"`.

O `mitm.html` do StreamSaver pede **um** endereço — a raiz do escopo mais `/ping` — e o `sw.js`
casava por **sufixo**: `url.href.endsWith('/ping')`. Enquanto aquele foi o único ping do ambiente,
a diferença entre "esta URL" e "qualquer URL terminada assim" não custou nada.

O item 4 criou `/:serverId/api/session/ping`. A partir dali, para todo mundo cuja página estivesse
sob controle do service worker:

- **o portal nunca via a requisição** — ou seja, a sessão parava de renovar, que é a coisa inteira
  que o batimento faz. O item 4 estava desligado sem que nada dissesse isso;
- o shell recebia `text/plain` "pong" onde esperava JSON → o `VsshApi` classifica como erro de
  **parse** → o `SessionMonitor` lê qualquer falha não-401 como **"o portal está fora"** → a
  bandeja mostrava um aviso permanente. **O sintoma era o oposto do diagnóstico**: parecia portal
  caído, era o próprio cliente respondendo a si mesmo.

**Nenhum teste pegava, e não por descuido: os dois lados estavam certos isoladamente.** O do SW
media que o ping do StreamSaver é atendido; o do heartbeat media que o monitor reage a 200/401/rede
— com um `fetch` de mentira, que não passa por service worker nenhum. O defeito só existe na
junção, e a junção não tinha dono.

A comparação passou a ser com a **URL exata**, e a guarda nova é a que faltava: *o SW não sequestra
outras rotas terminadas em `/ping`*. E o `/api/session/ping` ganhou `Cache-Control: no-store` pelo
mesmo motivo de fundo — **o efeito colateral É o ponto da rota**, e uma resposta servida de
qualquer cache chegaria igual com o portal fora do ar.

> **A lição, e ela vale para o resto da roadmap:** um service worker que casa por sufixo responde
> por rotas que ainda não existem. Interceptação no cliente é acoplamento a nomes futuros.

---

## 5 · O micro offline mode, nomeado — ✅ CONCLUÍDO

> **Feito** em `c714002` (vssh-sso) e no `docs/api.md` deste toolkit. 5 testes, **8/8 refutações**.
>
> **Antes de escrever a garantia, medir se ela era verdadeira.** Era — quase. Três vazamentos,
> todos mudos, e um deles degradava a sessão inteira. Ver "O que a auditoria achou", abaixo.

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

### O que a auditoria achou

A garantia se perde **uma linha por vez**, e cada perda é silenciosa por natureza: um `catch` que
esvazia uma lista não escreve nada em lugar nenhum, e o sintoma é *"a barra lateral piscou"*.

O que estava certo: o canal de eventos reconecta sozinho, indefinidamente; `connection_lost()` só
registra; e o único `location.href` do shell é o "Desconectar" do menu iniciar — ação do usuário.
O que não estava:

| Vazamento | O que acontecia |
|---|---|
| `FileBrowserWindow._loadMounts` fazia `catch { this._mounts = []; }` **e renderizava** | uma piscada do portal **apagava a lista de volumes** da barra lateral de uma janela aberta. Sumiam e voltavam sozinhos, sem nada que ligasse isso a nada |
| `_loadMimeCache` gravava `{}` ao falhar — e `null` é a única coisa que dispara nova tentativa | um erro de rede **no boot** degradava o "Abrir com" e os ícones por tipo pelo **resto da sessão**. A falha virava permanente |
| `_loadAppRegistry` zerava o cache de apps | o submenu "Abrir com" esvaziava até a próxima carga dar certo |
| `OfficeEditorWindow.createNew` fechava a janela **calado** | clicar em "Nova planilha" fazia uma janela piscar e sumir; o registro ia só para o console. Fechar está certo — a janela não tem documento dentro; **calar** não |

O idioma correto já existia no repositório, no `Desktop._fetch`: falhou, **não mexe**.

### Onde a garantia ficou escrita

Em três lugares, porque são três públicos: `CLAUDE.md` do `vssh-sso` (com as três regras que ela
impõe a código novo), `docs/client/desktop-shell.md`, e o [`docs/api.md`](../api.md) deste toolkit —
este último porque quem escreve um vssh-app precisa saber que pode contar com ela, **e precisa não
contradizê-la**: não fechar a própria janela por um `fetch` que falhou, não apagar o que já está na
tela num `catch`, e nunca chamar `location.reload()`, que de dentro de um app derruba o desktop
inteiro.

E sempre com o limite junto, que é a metade que importa. A rede que impede o apodrecimento é
`tests/unit/ambiente-sobrevive.test.js`.

---

## 6 · O `repo-worker` sai do monorepo — ✅ CONCLUÍDO

> **Feito** em `af7b6ef` (a saída, **−2623 linhas** no portal) e em `693f71c`/`65c1346` no
> repositório novo, **`vssh-repo`**, criado localmente ao lado dos outros.
>
> ⚠ **Falta criar o remoto e empurrar** — o repositório existe em disco, com a história
> preservada, mas ainda não tem `origin`. Ver "O que falta fazer à mão", abaixo.

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

### Como saiu

**Com a história**, via `git subtree split --prefix=repo-worker` — cinco commits, do
*"sistema de repositórios v2"* até a poda do item 1. Um `cp -r` teria custado o mesmo trabalho e
jogado fora a única coisa que não dá para recriar depois.

A saída confirmou o que a medição prometia: além do `zero import`, **o deploy nunca esteve no CI
deste repositório** — é `wrangler deploy`, à mão, e sempre foi. Não houve workflow a mover.

Do lado do portal sobraram três referências, todas de texto: uma linha do `CLAUDE.md`, duas da
`docs/client/distribution.md`, e a guarda de teste.

> **A guarda viajou junto com o código, e é o detalhe que quase passou.** O teste 4 de
> `deploys-sem-assunto.test.js` media o Worker: que o `handlers/customclient.js` não voltasse, e
> que os quatro arquivos que despacham por `kind` não voltassem a conhecer a string. Deixada onde
> estava, ela passaria a apontar para arquivos que o `vssh-sso` não tem mais — ou seja, **passaria
> para sempre, inclusive num Worker que tivesse ressuscitado o tipo**. Uma guarda que não pode
> falhar é pior que nenhuma, porque ocupa o lugar de uma que poderia.
>
> Ela está em `test/sem-customclient.test.js` no repositório novo (`node --test`, sem dependência
> nenhuma), e ganhou o **par positivo** que não tinha: os cinco `kind` que existem continuam
> roteados. Proibir uma string é fácil de satisfazer apagando demais.

O que ficou no `vssh-sso` é o que é de lá: o diretório não volta, e o portal não volta a conhecer
o tipo.

### O que falta fazer à mão

O repositório está em `../vssh-repo`, com dois commits novos por cima dos cinco herdados e árvore
limpa. **Falta o remoto**, que é decisão de quem tem a conta:

```bash
cd ../vssh-repo
gh repo create colabhd/vssh-repo --private --source=. --remote=origin
git push -u origin main
```

E, depois, `VSSH_REPO_ADMIN_TOKEN`/`PUBLISH_TOKEN` continuam onde estavam: **nada de segredo mudou
de lugar**, porque o Worker publicado é o mesmo — a extração é do fonte, não do deploy.

---

## 7 · `connect.html` — ✅ CONCLUÍDO

> **Feito** em `c9356b7`. **−2177 linhas**, 15 arquivos. 4 testes, **5/5 refutações**.
>
> Era para ser o menor item da onda. Foi o que mais cresceu ao ser medido — e cresceu de um jeito
> específico, que é o achado: **as coisas mortas apontavam umas para as outras.**

73 KB do diálogo de conexão do **upstream** do xpra-html5, ainda em `vssh-client/`. Inalcançável
desde que o `callback_close` deixou de redirecionar (Onda 2.7), e sem decisão desde então.

É o menor item da onda e o mais alinhado com o tema: **peso morto que ninguém nomeia é exatamente o
que a 2c existe para não deixar acontecer.**

### O que a medição achou

**Ele não estava só inalcançável: estava quebrado.** Nove das suas dezesseis referências apontavam
para arquivos que saíram com o pacote do motor na 2.7 (`VideoDecoder.js`, `RgbHelpers.js`,
`Utilities.js`, `MediaSourceUtil.js`, `OffscreenDecodeWorkerHelper.js`, os quatro do `lib/aurora/`).
Abrir aquela página teria mostrado nove 404 no console, não um diálogo de conexão.

E cada peça morta sustentava a próxima:

| Também saiu | Por quê |
|---|---|
| **`player.html`** (9,6 KB) | sem chamador em repositório nenhum — e carregava o `video.js` de um **CDN**, contra a mesma disciplina que trouxe a fonte do ambiente para dentro do repo na Onda 2.2 |
| **Dez ícones** | as decorações de janela do upstream (`close`, `maximize`, `minimize`, `fullscreen`, `unfullscreen`) já estavam órfãs; `eye`, `eye-slash`, `noicon` e `xpra-logo` só o `connect.html` pedia; e o `authentication.png` só o CSS abaixo |
| **138 linhas de CSS**, em **dois** blocos | o diálogo de login do upstream (`#login-overlay`, `#login-box`, `#password-box`, `.login-button`…) e um segundo bloco, *"CPPS Branding Overrides"*, repintando **os mesmos seletores** com os tokens do tema. Nenhum arquivo monta aquele DOM — nem aqui, nem no `vsshapp-xpra` |

### A rede que faltava, e por que ela não era redundante

> ⚠ **O CSS morto passou por baixo do `client-css-classes.test.js`, e a razão é estrutural.**
> Aquela rede pergunta *"toda classe USADA está estilizada ou consultada?"* — a direção que pega o
> erro de digitação, e que ela existe para pegar. A direção contrária, *"toda regra tem markup?"*,
> ela não faz. Por isso 138 linhas ficaram ali sem ninguém notar.

O mesmo eixo, para asset, virou `tests/unit/peso-morto-do-upstream.test.js`: **todo arquivo de
`icons/` e `fonts/` é pedido por alguém.** É a pergunta que o `client-assets.test.js` — *"todo
asset pedido existe?"* — não faz, e sem ela dez ícones ficaram em disco por três ondas, servidos e
versionados.

---

## 8 · As telas de erro, que são de outra era e de outro tamanho — ✅ CONCLUÍDO

> **Feito** em `caf9eb2`. 11 testes, **10/10 refutações** — duas delas só depois de apertar guardas
> que passavam verde. Suíte em 530.
>
> O `Sec-Fetch-Dest` era a aposta certa, e a página HTML não morreu. O que mudou em relação ao
> plano foi **onde a guarda mora** — ver "A guarda mede a junção", abaixo.

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

### Como ficou

O portal ganhou `sendError(req, res, …)`, e os **onze** pontos de erro passaram por ele. O formato
é escolhido pelo `Sec-Fetch-Dest`, e a decisão de recuo é a que estava prevista: **ausente, cai
para HTML** — navegador antigo, proxy que filtre o cabeçalho ou `curl` recebem a página de sempre,
e o pior caso é o comportamento de antes desta onda.

Quem desenha é `vssh-client/js/ErroDoProxy.js`, reusando o `.ds-empty` que o shell já tinha. Três
ações, e nenhuma delas navega: **tentar de novo** (recarrega o próprio quadro — nada da janela se
perde), **ver o log do backend** e **fechar a janela**. Ligado no `VsshAppWindow` e no
`VsCodeViewerWindow`.

Duas decisões que vale registrar:

- **O marcador `vsshProxyError` não é decoração.** O backend de um app pode legitimamente servir
  JSON na raiz dele; sem a marca, o shell trocaria por uma tela de erro um app que estava
  funcionando.
- **O `200` do `_sendProxyError` fica**, agora com o motivo escrito ao lado: o status honesto seria
  502, mas o Cloudflare intercepta 5xx e troca o corpo pela página dele. Quem lê isto dentro do
  ambiente lê o **corpo** — o status é invisível para quem carrega um iframe.
- **"Tentar de novo" não aparece em 401 nem 403.** Repetir um 403 é pedir para a pessoa bater na
  mesma porta; e quem decide se faz sentido tentar é o servidor, pelo campo `autoRetry`.

E o log do backend passou a ser alcançável por **um nome só** (`vsshContextMenu.verLogDoApp`),
compartilhado com o item de menu — o item 9 troca o que há por trás sem mexer em quem chama.

### A guarda mede a junção, e isso é a lição do `/ping`

O plano previa testar o discriminador. O que ele **não** previa é onde o defeito desta forma de
integração costuma nascer: no meio.

A colisão do `/ping` (item 4) passou por dois testes verdes porque **os dois lados estavam certos
isoladamente** — o do service worker media o service worker, o do batimento media o batimento, e o
defeito só existia na junção, que não tinha dono. Aqui a junção é o **formato**: o servidor escreve
um JSON, o cliente lê aquele JSON. Um lado renomear um campo é exatamente o que passa por dois
testes verdes e quebra em produção.

Então `erro-do-proxy.test.js` mede os dois lados **contra o mesmo objeto**, e o teste que importa é
este: *todo campo que o servidor escreve é lido pelo cliente*. Acrescentar um campo sem leitor
falha — ou o cliente regrediu, ou o campo nasceu morto.

> **E duas guardas só ficaram boas depois de tentarem me enganar.** Uma aceitava a **prosa do
> comentário** como se fosse código (o cabeçalho do módulo explica o marcador, então "o arquivo
> menciona `vsshProxyError`" passava verde num cliente que tinha parado de exigi-lo). A outra
> perguntava *"tem `var(--ds-)`?"* — e um bloco com um hex fixo ao lado de um token responde que
> sim. Virou a pergunta negativa: **nenhuma cor fixa no painel**.

---

## 9 · Uma tela de log que seja uma tela de log — ✅ CONCLUÍDO

> **Feito** em `22fc6e5`. 18 testes, **16/16 refutações** — uma delas só depois de apertar uma
> guarda que passava verde. Suíte em 548.
>
> O item era "trocar o diálogo por uma janela". O que a medição achou foi que **o lado servidor
> também mentia** — ver "Três vazios, e a tela antiga chamava os três de o mesmo", abaixo.

Eram **duas implementações da mesma coisa**, e nenhuma das duas era um visualizador:

| Onde | O que faz | O problema |
|---|---|---|
| Configurações → Serviços (`secoes-sistema.js:154`) | `VsshDialogs.alert(texto)` | o log inteiro **como mensagem de alerta**. E `catch { texto = '' }` engole a falha: uma leitura que deu erro aparece como *"o log está vazio"* |
| Menu de contexto da janela (`ContextMenu.js:324`) | `VsshDialogs.textInputBox(…, { init: body })` | o log dentro de um **campo de entrada de texto**. O comentário confessa o contorno: *"o log vai no campo de texto (init), não na mensagem: assim rola e dá para copiar"* |

Duas consequências que não eram estéticas:

- **Elas mostram dados diferentes.** O menu de contexto traz o `run.log.1` (a execução ANTERIOR —
  justamente onde está o interessante quando o app morreu e subiu de novo); a tela de Serviços,
  não. O mesmo log, dois lugares, duas respostas.
- **`tail=300` estava fixo nos dois**, sem como pedir mais.

E faltava o que qualquer visualizador de log tem: acompanhar em tempo real, buscar, quebrar linha
ou não, baixar, e distinguir uma linha de erro de uma linha comum.

> **É uma janela, não um diálogo** — e essa é a decisão do item. Diálogo é para uma pergunta com
> resposta curta; log é conteúdo que se lê, se rola, se procura e se deixa aberto ao lado do
> trabalho. Enquanto for diálogo, ele bloqueia o ambiente para fazer algo que precisa conviver com
> ele.
>
> As duas entradas passam a abrir **a mesma** janela, e o `run.log.1` aparece nas duas — a
> divergência de hoje é o argumento mais forte contra manter dois caminhos.

### Três vazios, e a tela antiga chamava os três de o mesmo

O plano era de interface. A medição achou que o problema começava antes dela: `getAppLog`
**devolvia `{ log: '', previous: '' }` quando a leitura falhava**. Um `sudo` recusado, um usuário
que não existe, um shell que morreu — tudo isso chegava ao cliente como texto vazio, e a tela
dizia *"o log está vazio"*. O `catch { texto = '' }` de Configurações era a **segunda** camada da
mesma mentira, não a única.

São três coisas distintas, e agora cada uma tem sua resposta:

| O que aconteceu | O que a tela diz |
|---|---|
| o backend subiu e não escreveu nada | *"O log está vazio"* |
| não há `~/.vssh-apps/<id>` neste servidor | *"Este app ainda não foi executado"* — o log nasce no primeiro start |
| a leitura falhou | o motivo, em vermelho, **sem apagar o que já estava na tela** |

O último é a garantia do item 5 aplicada aqui: uma atualização que falha não pode levar embora o
stack trace que a pessoa está lendo.

### O que veio junto

- **`src/utils/app-log.ts`** — o comando remoto e o parser da resposta saíram de dentro do
  `getAppLog`. Enquanto estavam colados no `ssh.execCommand`, a única forma de exercitá-los era
  ter um servidor; agora são função pura, e é contra o objeto que ela devolve que a guarda mede os
  dois lados.
- **O marcador em banda ficou namespaced, e a busca do segundo é do fim para o começo.** Uma ida
  só ao servidor traz as duas execuções, separadas por um marcador no `stdout` — e o log pode
  conter o marcador. No pior caso agora estraga a execução *anterior*; nunca a atual, que é a que
  está sendo lida.
- **O teto do `tail` passou a morar num lugar só.** Eram `300` fixo nas duas telas e um clamp
  próprio na rota. Agora é `limitarLinhas`, e a janela deixa escolher 200/500/1000/5000.
- **`--ds-warn`.** O âmbar de aviso estava escrito à mão em **cinco** lugares, três deles com um
  comentário dizendo *"o mesmo de"* outro — que é a descrição exata de um token que faltava.

### Acompanhar é polling, e nasce desligado

Cada atualização é um `tail` remoto por SSH, não um socket que fica aberto de graça. Um `tail -f`
de verdade exigiria rota de streaming e um processo remoto vivo por espectador — **superfície
nova numa onda cujo critério é o oposto disso**. Então: intervalo fixo, ligado por quem quer,
pausado enquanto a janela está minimizada ou a aba escondida, e morto no `close()`. Uma janela
esquecida aberta não fica batendo no servidor para sempre.

E o resto do que um visualizador tem: filtrar linhas (com realce e contagem), quebrar linha ou
não, baixar o arquivo, e tingir erro e aviso — **tingir, e não filtrar**: a classificação é por
padrão de texto, então ela erra às vezes, e um teste que escondesse linhas com base num palpite
seria pior que nenhum.

> **A guarda que quase não pegou.** *"Fechar a janela mata o intervalo"* estava escrita como
> `/_onClose\(\)[\s\S]*?_pararDeSeguir\(\)/` — e um `[\s\S]*?` solto atravessa o arquivo inteiro
> até encontrar a **definição** do método lá embaixo. Ela passava verde com a chamada removida. É
> a mesma família do que o item 8 achou duas vezes: uma guarda que aceita evidência de perto.

## 10 · Os dois riscos que a 2.7 deixou por medir — 🟡 MEDIDO POR LEITURA

> **Metade feito** em `8b08aeb`: o R6 tinha uma resposta que não precisava de servidor nenhum, e
> ela era ruim. 4 testes, **7/7 refutações**; suíte em 552.
>
> A outra metade **não vale uma tarde com VM limpa**, e o porquê está escrito abaixo. Virou um
> checklist de quatro linhas para o próximo provisionamento que acontecer por outro motivo.

Ela fechou os quatro passos com R1, R2, R4, R5, R7, R8 e R9 conferidos — vários contra servidor
real. **R3 e R6 nunca foram medidos**, e os dois são sobre o mesmo momento: o motor sendo instalado
e subindo pela primeira vez num servidor que ninguém preparou à mão.

**Os dois mudaram de premissa desde que foram escritos, e o texto da 2.7 ficou para trás:**

| | O que a 2.7 supunha | O que é hoje |
|---|---|---|
| **R3** | *"o pacote passa `--html=off`, e é esse `GET /` que precisa ser medido"* | ele passa **`--html="${AQUI}/frontend"`** (`entrypoint.sh:186`) — aponta para dentro do pacote, então `GET /` devolve o `index.html` do motor |
| **R3** | *"o poll do portal aceita qualquer coisa que não seja `000`"* | **não aceita mais**: `vssh-apps.ts:571` exige `!== '000' && !startsWith('5')`. A frase da 2.7 descrevia um poll que já mudou |
| **R6** | *"num servidor sem `VSSH_XPRA_REPO` isso falha"* | `install.sh` faz `apt-get install -y xpra xvfb`, com recuo para `dnf` — **não há `VSSH_XPRA_REPO`**. A falha real é outra: distro cujo repositório não tem o pacote |

### R6 — a resposta estava no código, e o erro morria na última linha

O caminho do erro está **inteiro** do lado do servidor: `install.sh` sai 1 → `vssh-app-install`
escreve em stderr e sai 1 (e nada é copiado para `/opt/vssh-apps`) → `installAppFromRepo` devolve
`code` → a rota responde **500 com o `stdout`/`stderr` junto**.

E o painel fazia isto:

```js
} catch { showToast('Erro ao instalar app.', 'error'); }   // admin-repository.js:154
```

Um `catch` **sem parâmetro** — a forma sintática de dizer *"não me interessa o motivo"*. O
`showLogs` só rodava no caminho de sucesso. Quem opera lia cinco palavras genéricas e ia de SSH
atrás de uma informação que já estava na resposta HTTP, na própria máquina dele. **É o mesmo
defeito do item 9**, em outra tela e escrito por outra mão.

Agora falha e sucesso abrem o **mesmo** painel de log — e o fracasso é justamente quando ele
importa. As três rotas de comando remoto ganharam um `error` com a última linha do `stderr`,
porque `api.js` usa `data?.error` como mensagem e caía em *"Erro interno do servidor."* quando ele
não vinha. A varredura achou **um quarto caso** do mesmo (remover atribuição, em `admin.js`).

> **A guarda é negativa, para valer para a próxima tela:** nenhum `catch` de um módulo que fala com
> a API pode avisar por toast **sem olhar para o erro**. E a pergunta não é *"tem parâmetro?"* — a
> refutação mostrou que `catch (err)` ignorando o `err` passava verde, e é o mesmo defeito com
> sintaxe melhor. O `catch` do clipboard em `utils.js` fica de fora **com o motivo escrito**: ali
> não existe corpo de resposta para ler, a falha é do navegador.

### R3 — o que sobrou não justifica uma VM

O poll já rejeita 5xx, e **um healthcheck que estoura não impede a janela de abrir**: ele avisa e
segue (foi decidido assim de propósito — o backend pode subir logo depois). O motor, além disso, é
`kind:"service"`: sobe junto com a sessão, não na abertura de uma janela. Então o pior caso não é
*"janela em branco com backend de pé"*, como a 2.7 supunha — é **15 s de espera e um toast que
mente**.

Sobra uma coisa que a leitura não responde, e ela é pequena: **`ready` hoje significa "alguém
respondeu"**. O `curl` do poll não manda o `X-Vssh-App-Token`, então um app que fecha a porta por
token devolve `403` — que não é 5xx e conta como pronto. O motor não faz isso (o `--html` serve
estático), mas o próximo app que fizer vai passar no healthcheck sem estar servindo nada.

### O que ficou pendente, e quando fazer

**Não é uma tarde agendada.** É um checklist de quatro linhas para rodar **no próximo
provisionamento que você fizer por outro motivo**:

1. instalar o motor pela aba admin numa distro sem `xpra` no repositório → a mensagem na tela tem
   de ser a do `install.sh`, não *"Erro ao instalar app."*;
2. conferir que `/opt/vssh-apps/xpra` **não** foi criado — o instalador promete isso, e promessa
   não medida é premissa;
3. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/` com o motor de pé → esperado
   `200`;
4. o mesmo pelo `healthcheckPath` do manifesto, que é outro trecho de código.

> **Por que não vale mais que isso:** o R6 virou pergunta sobre *distro*, não sobre o nosso código —
> e o nosso código agora conta o que aconteceu. O R3 custa, no pior caso, 15 s e um aviso errado.
> Provisionar uma VM limpa só para carimbar os dois é ritual, e ritual barato é o que enche uma
> roadmap de itens que ninguém faz. Fica nomeado, com o critério de aceitação escrito, e é
> respondido no dia em que houver um servidor novo de qualquer jeito.

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
- ✅ **O item 4 por refutação:** `session-rolling.test.js` (5) mede a renovação no middleware de
  verdade — cookie **e** `store.touch()`, porque só um dos dois faria a correção parecer feita — e
  `session-heartbeat.test.js` (15) carrega o `VsshApi` e o `SessionMonitor` num escopo de página
  falso. **12/12 refutações capturadas**, incluindo as duas que mais importam: o observador que
  troca a resposta e o que engole a rejeição.
- ✅ **A junção do item 9**, pela mesma razão do item 8: `log-window.test.js` (18) mede o parser do
  servidor e a janela do cliente **contra o mesmo objeto** — e a asserção exige `dado.<campo>`, a
  leitura, não a menção ao nome. O cliente guarda um objeto com as mesmas chaves, então procurar
  pelo nome passaria verde num cliente que tivesse parado de ler o que o servidor manda.
  **16/16 refutações capturadas.**
- `lint`, `tsc` e a suíte inteira, como sempre.

**Manual, e é o gate:**

1. Fazer um deploy trivial (mudar uma string visível) e recarregar **sem** `Shift+F5`. Tem de
   aparecer.
2. Deixar o ambiente aberto além do TTL da sessão e continuar usando. Não pode deslogar.
3. Derrubar o portal com o ambiente aberto: as janelas continuam, a bandeja acusa, e ao voltar o
   indicador volta sozinho — sem F5.
