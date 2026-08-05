# Onda 2.7 — Motores: um ambiente só, e o Xpra é um motor dele

> **Estado:** 🟢 **passos 1, 2 e 3 concluídos** · falta o **passo 4** (vocabulário) · verificação
> fechada: R1/R2/R8 contra sessão real, R4 e R9 em servidor, **R7 medido e virado teste** ·
> abertos: **R3** e **R6** · **Atualizado:** 2026-08-05 · **Repos:** `vssh-sso` + `vsshapp-xpra`
>
> **O número que a onda prometia:** `provisioning/xpra.ts` **619 → 103 linhas**, mais 300 de
> `utils/recoll-dbs.js`. `/proxy/desktop/` deixou de ser um endereço.
>
> Pré-requisito real: [Onda 1](01-sessao-sem-xpra.md) (feita). Vem logo depois da
> [2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito), que já entregou o
> registro (`RemoteDesktopEngines`) — ver "Sequenciamento", no fim.
>
> **Era "Onda 8", no fim da fila. Foi puxada para cá, e o motivo está em
> "Por que 2.7 e não Onda 8".**

## A sacada

"O Xpra vira um motor" soa como reorganização de código — mover arquivo, trocar nome, deixar mais
arrumado. **Não é.** É a segunda metade de uma inversão cuja primeira metade já foi executada, num
pedaço só do sistema, e cujo resultado foi medido: quando o desktop deixou de ser servido pelo
processo Xpra, **oito mecanismos deixaram de existir** — não ficaram menores, deixaram de existir.

E o que eles tinham em comum não era Xpra. Era **porta**.

> **A porta era a identidade.** O processo xpra do usuário só sabe servir aquele usuário; a porta
> `20000+uid` era o que distinguia um usuário do outro. Toda a orquestração — alocação, cache,
> túnel, senha, espera ativa — existia para manter de pé essa amarra. Quando quem serve é o portal,
> que já sabe quem é o usuário pela sessão autenticada, **a amarra some, e a orquestração some
> junto.**

Essa frase está escrita no código, no topo de `src/services/vssh-shell.ts`, porque foi ela que
autorizou o módulo a existir. A Onda 2.7 é aplicar a mesma frase ao que sobrou.

## O que já foi provado — a mesma inversão, uma vez, medida

### O que uma conexão de desktop custa hoje

Todos os itens abaixo estão em produção, agora, para o perfil `x11`. Nenhum deles é sobre X11: são
sobre alcançar uma porta no loopback de outra máquina.

| # | Mecanismo | Onde | Existe só porque… |
|---|---|---|---|
| 1 | `port = 20000 + uid` | `xpra.ts:92` | a porta É a identidade do usuário |
| 2 | Alocação de display: 3 comandos remotos (`pgrep`, `ps\|awk`, `ls` de locks+sockets), varredura de `:100`–`:254`, e uma exceção `Nenhum display X11 disponível` | `xpra.ts:23-66` | o namespace do X é global no servidor — é o mesmo problema da porta, com outro nome |
| 3 | Arquivo `~/.xpra/tcp-password`: gerado, `chmod 600`, com contorno para o newline que o xpra lê literal | `xpra.ts:126-145` | um socket **TCP** precisa de autenticação própria |
| 4 | Ramo `DIRECT_PROXY`: se a sessão viva bindou em `127.0.0.1` e o deploy exige `0.0.0.0`, **mata e reinicia a sessão do usuário** | `xpra.ts:155-165` | o endereço de bind é decisão de deploy, e ela chega tarde demais |
| 5 | Espera ativa: até 25 iterações de `curl` dentro do servidor, com `--connect-timeout`/`--max-time` obrigatórios sob pena de a rota `/xpra/start` ficar pendurada para sempre | `xpra.ts:259-280` | ninguém avisa quando a porta sobe |
| 6 | Túnel: um processo filho `ssh -L` **por porta**, com backoff exponencial, `MAX_RETRIES`, sniff de stderr fatal e polling de socket para saber que subiu | `ssh-tunnel.ts` (525 linhas) | a porta é do loopback do servidor remoto |
| 7 | Dois caches Redis — `xpra_port:` e `xpra_display:` — criados no start, invalidados no stop, e que podem divergir do real | `xpra.ts:94,297,311-312,369-371` | recalcular custa SSH |
| 8 | `getUserDesktopPort` devolve `20000+uid` **por aritmética**, alegremente, mesmo onde ninguém escuta — e o proxy precisou de uma guarda explícita para o erro não sair como timeout sem causa | `xpra.ts:421-448`, `proxy.ts:441-448` | a porta é derivada, não observada |
| 9 | Desligar: `xpra stop` + espera de 2 s + **dois** `sudo pkill` (xpra e Xvfb, "pkill não os mata juntos") + `sudo rm -f` do lock e do socket + descoberta do display por `pgrep` com fallback para cache | `xpra.ts:308-378` (~70 linhas) | o processo se **destacou** — ninguém o possui, então encerrá-lo virou caçá-lo |

São **cerca de 220 das 619 linhas** de `provisioning/xpra.ts`, e elas não falam de X11 em nenhum
ponto — falam de alcançar um socket e de caçar um processo solto. As duas coisas foram medidas em
servidor real; ver "R4 conferido", adiante.

### E o que ela custa servida pelo portal

```ts
if (semanticService === 'vssh-desktop') {
  return serveVsshShell(req, res, next);
}
```

Uma linha, em `proxy.ts:434`, **antes** de resolver usuário Linux, porta ou túnel. O comentário logo
acima diz por que a posição importa: *"é exatamente isso que faz esta requisição não custar canal
SSH. O portal já sabe quem é o usuário pela sessão, então não há `id -u` a fazer; e como nada é
proxiado, não há porta nem túnel."*

Os **oito primeiros** mecanismos da tabela não foram otimizados. **Ficaram sem assunto.**

O nono não — ele é do ciclo de vida do processo, não do caminho até ele, e sobreviveu inteiro. É
exatamente o que o motor mata, e foi medido em servidor real: ver "R4 conferido", adiante. Vale
notar a simetria, porque ela é a tese: **o primeiro grupo caiu quando paramos de alcançar o Xpra
por uma porta nossa; o segundo cai quando paramos de deixá-lo solto.**

### O teto que isso destravou

Não é economia abstrata. O pool de SSH chaveia por servidor, não por usuário
(`ssh-exec.ts:116`): **uma conexão TCP por servidor, compartilhada por todos os usuários**, com
`MaxSessions` do `sshd` e a sessão SFTP cacheada segurando um canal — daí o teto de **~8 canais por
SERVIDOR** (`ssh-exec.ts:152-157`, e [diagnostico §1.4](diagnostico.md#-teto-de-canais-ssh-8-por-servidor-não-por-usuário)).

Abrir o desktop deixou de disputar esse orçamento com operação de arquivo, start de app e
provisionamento. Num teto de oito, um consumidor a menos não é 12% — é a diferença entre um servidor
que atende trinta pessoas e um que estoura `MaxSessions` e devolve rajada de 409 com tudo
perfeitamente vivo (foi o que `da6bfb5` mostrou).

### O ganho que veio de brinde, e que ninguém tinha pedido

Porque o bundle passou a ser transformado por nós no caminho de saída, e não lido cru do disco pelo
xpra, `stripXpraTags()` pôde remover os `<script data-xpra>` de um **único** `index.html` — sem um
segundo arquivo para lembrar de manter. O núcleo estrito são **1.063.226 B**, 18 das 87 tags,
**31,4%** do JS avaliado antes da primeira tag do `<body>`
([diagnostico § Peso morto](diagnostico.md#peso-morto-servido-ao-navegador)).

Repare no encadeamento, porque ele é a tese desta onda inteira: tirar o Xpra do caminho de entrega
**não removeu uma dependência de X11** — removeu a razão pela qual havia dois de tudo.

E guarde este ponto, porque a onda vai adiante dele: hoje aqueles scripts ainda **estão** no
repositório e são retirados na saída. É a diferença entre não servir e não ter.

## A inversão, agora dita como vocabulário

Hoje há **dois perfis**: o `x11` e o `headless`. As palavras *headless* e *xpraless* descrevem o
ambiente pelo que **falta** nele, e essa é a formulação errada. Ela produz duas consequências que já
custaram caro:

1. **Todo trabalho nasce duas vezes.** Cada superfície nova precisa existir nos dois perfis, e a
   verificação precisa acontecer nos dois. A [Onda 0c](0c-colapso-de-variantes.md) já pagou esse
   preço uma vez com o tema `neon` e o modo `dock` — *"enquanto houver duas variantes de UI, cada
   superfície nova nasce com duas para manter"*. Dois perfis são a mesma dívida, num eixo maior.
2. **O perfil sem Xpra parece degradado.** Ele não é: navegador, vssh-apps, arquivos, documentos,
   notificações, impressão e áudio funcionam inteiros sem X11. Mas um ambiente descrito como
   "menos alguma coisa" é lido como versão reduzida — inclusive por quem o constrói.

**A inversão:** existe **um** ambiente. O Xpra é um **motor** que ele pode ter, como o Scramjet é o
motor que ele pode ter para a web.

> O que hoje chamamos de "ambiente xpraless" passa a ser simplesmente **o ambiente**. E ele pode
> ter Xpra.

Não é renomear. É parar de ramificar. Hoje `profile: 'x11' | 'headless'` é coluna de banco
(`db.js:295-322`, `resolve-server.ts:16-18`) e ramo em pelo menos quatro lugares
(`proxy.ts:444`, `keys.ts:433,543`, `printers.ts:95`) — cada um deles um `if` que alguém pode
esquecer na próxima superfície.

## O Xpra do ambiente novo não serve cliente nenhum

Aqui é onde a leitura mais fácil erra, e vale dizer com todas as letras: **o ambiente novo não vem
do Xpra.** O portal serve o desktop. O Xpra não serve nada — nem a página, nem o cliente, nem os
scripts. Ele não é a origem de coisa alguma que o navegador carrega.

Isso não é um detalhe de plumbing. Muda a pergunta da onda inteira:

| | Pergunta |
|---|---|
| ❌ Errada | *"como tiramos o cliente HTML5 do Xpra do caminho crítico do nosso desktop?"* |
| ✅ Certa | *"que integração o motor X11 oferece a um desktop que não é dele?"* |

A primeira é uma pergunta de remoção, e leva a `stripXpraTags()`, `data-xpra`, `xpraDisabled()` —
tudo mecanismo para conviver com um hóspede que chegou primeiro. A segunda é uma pergunta de
desenho, e **a resposta já tem precedente rodando**: o `scramjet-wisp` traz o próprio código de
cliente. O `BrowserWindow` nativo não carrega o Scramjet junto com o shell; ele pergunta ao motor
onde ele está, e usa o que o motor entrega.

### O cliente do Xpra viaja com o Xpra

É a consequência direta, e é a maior desta onda. Os scripts marcados `data-xpra` no `index.html` são
**23 arquivos, 1.369.332 B** (medido agora) — `Client.js`, `Window.js`, `Protocol.js`, `Keycodes.js`,
`aurora`, `brotli`, `lz4`, `rencode`, `jsmpeg`, os decodificadores. São nossos por estarem no nosso
repositório, e do Xpra por só existirem para falar o protocolo dele.

No motor, eles não são removidos na saída. **Eles não estão lá.**

| | Hoje | Com o motor |
|---|---|---|
| Os 27 arquivos + o cursor, ~1,42 MB | no nosso bundle, marcados `data-xpra`, retirados na saída por `stripXpraTags()` | no pacote do motor. Chegam se, e quando, o motor estiver instalado |
| `stripXpraTags()` + a convenção do atributo + o teste que a guarda | existem para poder tirar | somem — não há o que tirar |
| `VsshHost.xpraDisabled()` (`vssh-host.js:137`) | escolhe o host no boot | some, e por um motivo melhor que "um perfil só": não se desliga o que nunca foi carregado |
| `new XpraClient("screen")` sem guarda, `index.html:739` — **846 linhas antes** do único `if` que o checa | construído em todo boot, com `new AudioContext()`, 16 sondagens de codec e um `OffscreenCanvas` descartado | não existe no `index.html` |
| Versão do cliente Xpra | amarrada à versão do nosso desktop: subir uma é subir a outra | duas versões do pacote do motor. O desktop não se mexe |
| Edições nossas dentro de arquivo MPL do upstream | é a dívida que a 2.2 pagou tirando o `/ws/events` de dentro do `Client.js` | o arquivo do upstream deixa de ser nosso para editar |

> Repare que isto **não é a mesma coisa** que a poda de 31,4% já feita pelo `stripXpraTags()`. Aquela
> tirou o peso do navegador; esta tira o Xpra do **nosso repositório**. Uma é sobre bytes servidos, a
> outra é sobre de quem é o código.

#### ✅ Conferido (2026-08-04): o cliente aguenta ser servido de outro lugar — com uma emenda de 4 linhas

Esta era a afirmação da qual tudo dependia (R1), e ela **passa**. O que foi lido, e por quê:

**O transporte não presume mesma-origem, e a prova é do upstream.** A URL do WebSocket é montada a
partir de `window.location` **com sobrescrita explícita por query param** — `?server=`, `?port=`,
`?ssl=`, `?path=` (`index.html:724-728`) —, e `client.host`/`port`/`ssl`/`path` são atribuídos daí
(`index.html:1040-1044`). Um cliente que aceita apontar para host arbitrário não foi escrito para
assumir que veio do servidor: é herança do diálogo de conexão do upstream, e é ela que nos serve.

**E a mesma-origem vale de qualquer forma** — o que remove a preocupação maior. O motor é alcançado
por `/<serverId>/proxy/app/<id>/`, que é **o mesmo origin do shell**, só que outro caminho. Isso
importa em particular porque `new Worker()` exige mesma-origem: se o motor fosse um host separado, os
três workers do cliente Xpra seriam ilegais, e não haveria emenda que resolvesse.

**O que quebra é resolução de caminho, e são quatro sítios.** `new Worker(url)` e um `<img>` relativo
resolvem contra a **URL base do documento**, não contra o script que os chama. Com a página em
`/proxy/vssh-desktop/` e os arquivos em `/proxy/app/xpra/`, os quatro apontam para o lugar errado:

| Sítio | O que carrega |
|---|---|
| `Client.js:587` | `new Worker("js/OffscreenDecodeWorker.js")` |
| `Client.js:590` | `new Worker("js/DecodeWorker.js")` |
| `Protocol.js:39` | `new Worker("js/Protocol.js")` — o arquivo se carrega a si mesmo como worker |
| `Client.js:3528` | `icons/default_cursor.png` |

**E nada mais.** A varredura dos 23 arquivos por `new Worker`/`new Image`/`.src=`/`url(`/`fetch(`
não achou outro carregamento relativo: o resto é `data:` URI (ícone de janela, `Client.js:3054`) ou
imagem montada em memória. O `--html` do xpra, portanto, não volta — R2 também passa.

**A base já existe e não precisa ser inventada:** `AppLauncher.ensureRunning('xpra')` devolve
`{port, url, ready, lastCode}` (`AppLauncher.js:199-221`), e `url` é exatamente o prefixo que falta.

> **A emenda tem de ser desenhada contra o risco 6.** Quatro literais viram quatro leituras de uma
> base cujo default é `""` — com base vazia, o comportamento é byte a byte o do upstream. É o menor
> patch que não vira fork: se o upstream um dia trouxer o próprio mecanismo de base, o nosso sai sem
> deixar rastro. **Patch que muda semântica é que vira dívida; patch que só acrescenta um prefixo
> opcional, não.**

#### ✅✅ Nível 2 (2026-08-04): **sessão real, handshake completo, cliente servido de outro caminho**

A afirmação central da onda deixou de ser hipótese. Com a simulação ligada em produção, contra a
sessão Xpra de verdade, o cliente **inteiro** veio de `motor/` e a sessão subiu até o fim:

```
Opening WebSocket connection  wss://…/ipprivm01/proxy/desktop/
WebSocket connection established
process challenge: hmac+sha512
got hello: server version 6.5 accepted our connection
connection_progress( Session started , , 100 )
startup complete · connection-established
audio: requesting opus+mka stream from the server · audio-state: playing
received xdg start menu data
server connection is OK
```

O que cada linha fecha, e nenhuma delas era alcançável pela bancada offline:

| Evidência | Fecha |
|---|---|
| `initializing offscreen decode worker` → `we can decode using a worker` | o **ramo offscreen** carregou de `motor/` e respondeu — e o Chrome real o escolheu sozinho, sem forçar |
| `hmac+sha512` → `accepted our connection` | autenticação e handshake atravessam a fronteira sem nada especial |
| `audio-state: playing`, `opus+mka` | os decodificadores relocados (`aurora`, `jsmpeg`, `MediaSourceUtil`) funcionam de outro caminho |
| `received xdg start menu data` | o canal de aplicações X11 está vivo |
| `running libcurl.js v0.7.4` na mesma página | o motor de navegação subiu ao lado — dois motores, uma página |

**Zero 404 em todo o grafo.** O inventário de 27 está confirmado contra sessão real, não só contra
leitura estática.

> **O que ainda não foi observado**, e vale dizer: `icons/default_cursor.png`. Ele só é pedido
> quando o servidor manda um pacote de cursor **sem** imagem embutida — o ramo de fallback em
> `Client.js:3533`. Usa o mesmo prefixo dos três sítios já provados e é um `<img>`, não um worker,
> então o risco é baixo; mas "baixo" não é "medido". Confere-se na aba de rede, filtrando `cursor`.

Duas correções de percurso, ambas minhas e ambas registradas porque custaram uma ida e volta cada:

1. **O WebSocket ia para a página, não para a sessão.** O cliente deriva host/porta/caminho de
   `window.location` (`index.html:724-728`), e a página está em `…/proxy/vssh-desktop/`, que é o
   shell estático. Eu sabia que `?path=` existia e não o pus na instrução. A simulação agora
   redireciona sozinha acrescentando `&path=…/proxy/desktop/`, com guard, e a tarja mostra o alvo.
2. **`connect.html`**, achado por acidente: ao falhar a conexão, o cliente navega para o diálogo de
   conexão do **upstream** (`index.html:959`), 73 KB dentro do nosso bundle, que então estoura em
   `Cannot read properties of null (reading 'mode')` porque `/Info` não existe no portal. É peso
   morto que a régua do `data-xpra` não alcança — é `.html`, não tag de script — e é pior que peso:
   é uma página do upstream alcançável por falha de rede. Vai para o pacote do motor, ou sai.

#### ⚠ Correção: **"os 23 arquivos" estava errado.** O `data-xpra` não é o inventário

Este documento dizia, até aqui, que o lado-cliente do Xpra são os 23 `<script data-xpra>`. **Não
são.** O atributo marca *tags de script*, e o grafo de workers é invisível para ele: quatro arquivos
chegam ao navegador **só por `importScripts`**, e nenhum deles tem tag.

| Arquivo | Como chega | Bytes |
|---|---|---|
| `js/DecodeWorker.js` | `new Worker` em `Client.js:590` (ramo **sem** offscreen) | 11.776 |
| `js/OffscreenDecodeWorker.js` | `new Worker` em `Client.js:587` (ramo **com** offscreen) | 9.605 |
| `js/ImageDecoder.js` | `importScripts` dentro do OffscreenDecodeWorker | 1.353 |
| `js/Utilities.js` | `importScripts` dentro do worker do `Protocol.js:677` | 30.508 |
| `icons/default_cursor.png` | `img.src` em `Client.js:3528` | 1.252 |

**São 27 arquivos + 1 imagem — não 23.** Número medido, não contado: ver a bancada
mais abaixo. E o `Utilities.js` é o achado que muda o desenho:

#### ✅ Resolvido (2026-08-04): o `Utilities.js` foi recortado, e o corte foi maior que a fronteira

A pergunta era como dividir um arquivo que os dois lados usam. A medição respondeu outra coisa:
**quase não havia o que dividir.**

| | Bytes | % |
|---|---:|---:|
| só o motor usa | 12.521 | 41,0 |
| ninguém cita | 6.217 | 20,4 |
| só o shell usa | 7.569 | 24,8 |
| ambos | 1.890 | 6,2 |

E dos **19 símbolos** que o shell citava, **14 só apareciam dentro do próprio boot do Xpra** —
`isMobile`/`isFirefox`/`isSafari`/`isMacOS` configurando o cliente, o `sessionStorage` de senha e
token, o `getKeyboardLayout`, o `parseINIString` que lê o `default-settings.txt` do xpra. Sobravam
**quatro**, e nenhuma precisava ser herdada:

| Sobrou | Veredito |
|---|---|
| `escapeHTML` / `escapeAttr` | reescrito em 4 linhas. **A dívida de verdade não é a função**: cinco arquivos do navegador montam HTML por concatenação. Trocar a função é barato; trocar o padrão é a melhoria |
| `clog` / `cdebug` | `console.log.bind(console)`. Uma linha cada |
| `sanitizeSvgIcon` | **já era nosso** — commit `88507ba "svg sanitizer"`, morando dentro do arquivo MPL do upstream. Só mudou de casa |
| `ArrayBufferToBase64` | `Uint8Array.prototype.toBase64()` nativo, com recuo. **Correção do que eu ia afirmar:** achei que a versão herdada estouraria a pilha; não estoura — ela fatia em blocos de 10.400 de propósito. A nativa é mais curta, não mais segura |

`isRecommendedApp` foi para o `VsshUtil` **marcado como domínio do motor**: são 60 linhas de lista
de exclusão do menu xdg, que só existe com X11. Está lá porque é filtro de dados puro e movê-lo
exigiria rotear Launchpad e StartMenu pelo registro — trabalho da onda, não deste recorte.

**O resultado:** `js/Utilities.js` ganhou `data-xpra` — virou propriedade do motor. O shell ganhou
`js/VsshUtil.js`, 7.716 B. O perfil sem X11 deixa de baixar **18.614 B** por carga fria, e — o que
importa mais — **o shell parou de depender de um arquivo MPL do upstream**, que era a dívida do
risco 6 em estado puro.

##### E não há um segundo caso: a varredura foi nas duas direções

- **Arquivos do upstream fora do conjunto do motor:** dois. O `Utilities.js`, e o
  `js/lib/jquery-transform-draggable.js` (5.595 B) — que é outro caso: plugin de jQuery UI baseado
  numa resposta de StackOverflow, empacotado pelo xpra. Não é lógica do Xpra e não acopla nada.
- **Shell → motor:** o motor define 63 globais de topo; o shell cita sete, e **seis são falso
  alarme** — cinco estão no bloco de boot do Xpra do `index.html`, que vai junto, e o `XpraWindow`
  no `TilingManager` aparece só em **comentários** (linhas 8 e 645). O sétimo, `VsshHostXpra` em
  `vssh-host.js:147`, é o **encaixe intencional**: `typeof window.X !== 'undefined'`, guardado, com
  recuo para `VsshHostStandalone`.
- **Motor → shell: ~~zero~~ dois.** ⚠ **Eu disse zero, e estava errado.** Os dois detectores que
  usei só olhavam nomes com **inicial maiúscula** — então `default_settings` e `toggle_keyboard`
  passaram por baixo. Quem achou foi a bancada, rodando o carregador de verdade: erro de runtime,
  um de cada vez. Leitura estática com filtro errado não é verificação, é a aparência dela.
  - `default_settings` (`Client.js:307,310`) — o mapa lido do `default-settings.txt` do xpra. É
    dado do motor; o carregador o declara.
  - `toggle_keyboard()` (`Client.js:2941`) — chamado **nu**, sem `this.` e sem guarda. É o teclado
    na tela, que o shell desenha. O carregador publica um stub: se o shell oferecer, sobrescreve;
    se não, o motor não estoura.
  - E o susto que não era: `init_clipboard`/`init_keyboard`/`init_audio` são **métodos do próprio
    cliente** (`this.init_*`), homônimos dos helpers do index.html — e `applyHostCapabilities`
    aparece só em comentário.

> O único acoplamento real entre os dois lados é o `vssh-psdialog`, e ele é **por dados**: o
> `Client.js` monta hints `x-vssh-psdialog-*`, o `VsshDialogs.js` os lê, e nenhum dos dois nomeia o
> outro. Contrato de fio, não dependência de símbolo — que é a forma certa, e já estava assim.

##### Duas falhas minhas no corte, ambas pegas por teste

1. **A poda comeu o fim do arquivo.** `isRecommendedApp` era o último membro, e "até o próximo
   membro" virou "até o fim do arquivo" — levando junto o `const LANGUAGE_TO_LAYOUT` que vinha
   depois do objeto literal. Pego por `client-undefined-refs`. Refeito limitando ao fecho do
   objeto; o diff final é **98 deleções, 0 inserções**, exatamente os dois membros.
2. **Eu inventei o final do `sanitizeSvgIcon`.** Escrevi `new XMLSerializer().serializeToString()`
   por inferência, sem ter lido as últimas linhas — o original devolve `root.outerHTML`. Pego pelo
   mesmo teste. Mover código e trocar comportamento no mesmo passo é como se esconde uma regressão
   dentro de um refactor; ficou o `outerHTML`, com o motivo escrito.

> ### `js/Utilities.js` era do shell, e o motor precisava dele
>
> Ele entra no `index.html:58` **sem** `data-xpra`, e é usado por pelo menos dez arquivos do shell —
> `BrowserWindow`, `StartMenu`, `Launchpad`, `vssh-host` e o subsistema de navegador inteiro. É
> código nosso, que fica. Mas o worker do protocolo Xpra faz `importScripts("Utilities.js")`
> relativo ao **próprio caminho**, então o pacote do motor precisa ter uma cópia dele ao lado do
> `Protocol.js`.
>
> É a primeira fronteira de verdade desta onda, e ela não aparece em nenhuma tabela acima: ou o
> motor carrega uma cópia (e as duas podem divergir), ou o pedaço de `Utilities.js` que o worker usa
> vira um arquivo próprio, ou o worker deixa de precisar dele. **Decisão de desenho, não de
> empacotamento** — e é melhor tomá-la agora do que descobrir a divergência por um bug de decode.

**A boa notícia do mesmo achado:** `importScripts` resolve contra a URL do *worker*, não do
documento — e os call sites já usam `./lib/lz4.js`, `./RgbHelpers.js`, `lib/rencode.js`. Ou seja,
**assim que o worker carrega do lugar certo, tudo abaixo dele se conserta sozinho.** Por isso a
emenda são os 4 sítios e não o grafo inteiro: eles são a única fronteira document-relative.

#### ✅ Medido em bancada (2026-08-04): a emenda funciona, e é inerte sem a base

Nada acima é dedução. Uma bancada local serve o **mesmo diretório** em dois caminhos — `/shell/`
(de onde vem a página) e `/motor/` (de onde viriam os arquivos do motor) —, monta a página a partir
do `index.html` **real** e chama `client.connect()` contra uma porta onde ninguém escuta. Os três
workers nascem em `initialize_workers()`, chamado no topo de `connect()` (`Client.js:547`), então
**nada disto precisa de sessão viva**. O servidor loga de onde cada arquivo foi pedido.

Servir os dois caminhos com o mesmo conteúdo é deliberado: um 404 no caminho errado abortaria o
cliente no primeiro sítio e ensinaria sobre um só. **O achado não é a falha — é o endereço do
pedido.**

| Corrida | Base | Ramo de decode | Pedidos ao caminho da **página** |
|---|---|---|---|
| A | ausente | DecodeWorker | ⚠ 6 |
| B | ausente, `ssl=1` | DecodeWorker | ⚠ 6 |
| E | ausente, offscreen | OffscreenDecodeWorker | ⚠ **9** |
| C · D · F | `/motor/` | ambos os ramos | ✅ **0** |

Três leituras, e as três valem:

1. **A emenda resolve.** Com a base publicada, zero arquivos do grafo Xpra são pedidos ao caminho
   da página — nos dois ramos de decode.
2. **A emenda é inerte sem a base.** A, B e E rodam com os arquivos **já emendados** e reproduzem
   exatamente o comportamento de antes. É a prova empírica contra o risco 6: um prefixo opcional,
   não uma mudança de semântica.
3. **A cascata segue o worker.** Os 6 pedidos de A não são 6 bugs: são 2 (`Protocol.js`,
   `DecodeWorker.js`) e 4 que caem atrás deles por `importScripts`. Corrigir os 2 moveu os 6 —
   confirmando por medida o que a leitura só supunha.

> ### O achado que só a bancada daria: **o ramo offscreen quase escapou do inventário**
>
> As corridas A e B carregam `DecodeWorker.js`. A E carrega `OffscreenDecodeWorker.js` — e com ele
> **`ImageDecoder.js`, `VideoDecoder.js` e `Constants.js`**, que nas outras não aparecem. Os dois
> ramos carregam conjuntos diferentes, e o pacote precisa dos dois.
>
> Pior: forçar o ramo foi mais difícil do que parecia, e o motivo é um segundo achado.
> `XpraOffscreenWorker.isAvailable()` recusa offscreen no Chrome sem https, mas nem chega a ser
> consultada — o guard é `if (this.offscreen_api)` (`Client.js:580`), e essa flag nasce `false`
> (`Client.js:161`). **Quem a liga é o boot do shell**, em `index.html:890`
> (`client.offscreen_api = offscreen`, com o default vindo de `getboolparam("offscreen", …)`).
>
> Ou seja: **uma decisão do motor mora hoje em código do shell** — e um pacote montado sem ela
> nasceria preso ao ramo lento, em silêncio. Vai para a lista do que migra.
>
> A lição vale além deste caso: **um inventário medido numa máquina é o inventário daquela
> máquina.** Só cobrindo os dois ramos ele vira o inventário do pacote.

#### ✅ Aplicado: a emenda entrou, sozinha, com bancada e teste

Os 4 sítios já usam `(window|self).XPRA_CLIENT_BASE || ""` em `Client.js` e `Protocol.js`. Entrou
**antes** do pacote existir, e de propósito: é inerte enquanto ninguém publica a base, então não
espera nada, não quebra nada, e para de ser um achado que evapora junto com a conversa em que foi
achado.

- **A bancada mora no repositório**, em `docs/bancadas/motor-x11/` — lê o `vssh-client/` real, sem
  cópia nem overlay, então não pode ficar velha sem que alguém perceba.
- **O guard é textual**, em `tests/unit/motor-x11-base.test.js`, e não varre uma lista: varre por
  **qualquer** `new Worker("literal")` nos arquivos do motor. É o 5º sítio, escrito por alguém que
  não sabe da regra, que ele existe para pegar. Provado por mutação — revertendo um sítio, dois dos
  quatro testes reprovam.
- Um dos testes **avalia** a expressão em vez de lê-la: com a global ausente ela tem de reduzir ao
  literal original. É o que separa "prefixo opcional" de "fork do upstream", verificado e não
  prometido.
- O quarto teste guarda a dívida do `offscreen_api`: se a linha sumir do `index.html` sem o motor
  assumi-la, ele reprova — para a migração não deixar o pacote preso ao ramo lento em silêncio.

Suíte: **435 testes, 0 falhas**, `eslint` e `tsc` limpos.

> Nota de ambiente achada no caminho: `npm test` rodado pelo **PowerShell** pula **11 testes** de
> provisionamento em silêncio (`skip: !bashOk`, `provision-packages`/`provision-targets`), porque
> `bash` não está no PATH de lá. Pelo Git Bash eles rodam. Vale saber antes de confiar num verde.

#### ✅ R4 conferido em servidor real (2026-08-04, Xpra 6.5.2-r0, Ubuntu 26.04)

`xpra start :192 --daemon=no` **segura o primeiro plano** — o log strea­ma e a sessão sobe até
`xpra is ready`. O `run.pid` do lifecycle rastreia um processo vivo, e `kind:"service"` funciona.
A dúvida que decidia o formato do pacote está respondida: o entrypoint é o `xpra` em primeiro
plano, sem wrapper supervisor.

E melhor do que o previsto: **o xpra já escreve o próprio pid**, o mesmo do processo em primeiro
plano (`wrote pid 1516835 to '/run/user/1184/xpra/192/server.pid'`, e logo abaixo `running with pid
1516835`). Com `exec` no `vssh-app-run`, `run.pid` e `server.pid` são o mesmo número — não há dois
rastreadores a divergir.

**A confirmação que mais vale, e veio de brinde:** sem `--bind-tcp`, o xpra **não abriu porta
nenhuma**. Criou sockets unix e abstratos:

```
created unix domain sockets:
 '/run/user/1184/xpra/ipprivm01-192'
 '/home/dti_arthurmartins/.xpra/ipprivm01-192'
 '/run/user/1184/xpra/192/socket'
created abstract sockets:
 '@xpra/192'
```

Não é "dá para tirar a porta": **a porta é que era o acréscimo.** Toda a coluna 1/3/4/6/7 da
primeira tabela — `20000+uid`, o `tcp-password`, o ramo `DIRECT_PROXY`, o túnel dedicado, os dois
caches — existe para sustentar um `--bind-tcp` que o xpra só abre porque nós pedimos. E `insufficient
permissions to use socket path '/run/xpra/…'` mostra que ele já recua sozinho para o runtime dir do
usuário, que é onde a permissão de arquivo faz o papel da senha.

**Três achados que entram na lista de trabalho:**

| | O que o log mostrou | Consequência |
|---|---|---|
| 1 | `serving html content from '/usr/share/xpra/www'` — **sem `--html`, ele serve o cliente do upstream** | o pacote precisa passar `--html=off` explicitamente. Um motor que "não serve cliente" por omissão serve o cliente errado — e é o mesmo modo de falha da cadeia de 5 diretórios, por outra porta |
| 2 | `vssh-psdialogd` morreu com `NameExistsException: org.freedesktop.Notifications` | o daemon de notificação é **singleton por usuário**, não por display: o `DBUS_SESSION_BUS_ADDRESS` aponta para `/run/user/<uid>/bus`, compartilhado. Uma segunda sessão — ou um restart do supervisor — colide. Como `kind:"service"` reinicia sozinho, isto deixa de ser raro |
| 3 | `libEGL … /dev/dri/card1: Permission denied` → `using 'llvmpipe'` | render por software porque o usuário não está no grupo do dispositivo. É pré-requisito de ambiente, e o `installCommand` do pacote é o lugar de afirmá-lo em vez de descobrir por lentidão |

Tempo de subida medido: **~3,3 s** até `xpra is ready`; a inicialização continua depois disso
(menu de aplicativos aos 5,9 s, encaminhamento de impressão aos 6,6 s). O teto de 15 s do
healthcheck tem folga — mas o número real vale ter escrito, e "ready" não é o fim.

#### E o desligamento, que é a metade que valia mais

Um `Ctrl-C` no processo em primeiro plano:

```
seamless server is terminating
removing unix domain socket '/run/user/1184/xpra/ipprivm01-192'
removing unix domain socket '/home/dti_arthurmartins/.xpra/ipprivm01-192'
removing unix domain socket '/run/user/1184/xpra/192/socket'
removing abstract socket '@xpra/192'
killing xvfb with pid 1516979
removed session directory '/run/user/1184/xpra/192'
$ cat /tmp/.X192-lock
cat: /tmp/.X192-lock: No such file or directory
```

Ele limpa os quatro sockets, o Xvfb filho e o diretório de sessão, e não deixa lock file.

> ⚠ **Correção do que eu escrevi primeiro.** Dizia "limpa tudo sozinho". **Não limpa.** Nesta
> corrida não havia filho de `--start=` vivo para segurar nada — o `vssh-psdialogd` tinha morrido
> no arranque, por colisão de D-Bus. O R9, adiante, mostrou o que acontece quando há, e é outra
> história. Provado aqui: sockets, Xvfb e lock file. **Não "tudo".**

Ainda assim, compare com o que o `stopXpra` faz hoje (`xpra.ts:308-378`, ~70 linhas):

| Hoje | Por que existe |
|---|---|
| `xpra stop :display` e **espera 2 s** | encerramento gracioso de um processo que ninguém possui |
| `sudo pkill -u … -f "xpra.*:display"` | …que pode não ter obedecido |
| `sudo pkill -u … -f "Xvfb.*:display"` | com o comentário no código: *"pkill não os mata juntos"* |
| `sudo rm -f /tmp/.X${display}-lock /tmp/.X11-unix/X${display}` | com o comentário: *"sem isso o próximo start falha com 'display em uso'"* |
| descobrir o display por `pgrep`, com fallback para o cache Redis | porque o processo é anônimo para quem o iniciou |

> **Nada disso é sobre encerrar uma sessão X. É sobre caçar um processo que se destacou.** Em
> primeiro plano, o supervisor manda um sinal a um processo que ele **possui**, e o próprio xpra faz
> a faxina. Some o `pkill` duplo, some a espera de 2 s, some o `rm -f` de lock file, some a
> descoberta por `pgrep` — e some o **`sudo`**, que hoje é exigido duas vezes só para matar processo
> do próprio usuário.
>
> É o mesmo padrão da porta, no outro extremo do ciclo: **o trabalho não era do Xpra, era de tê-lo
> deixado solto.**

E há um efeito de segunda ordem: metade da complexidade do `findFreeXpraDisplay` (`xpra.ts:46-56`)
é varrer `/tmp/.X*-lock` e `/tmp/.X11-unix/` porque *"ambos podem existir sem processo
correspondente (Xvfb morto sem cleanup)"*. Quem morre sem cleanup é o daemon. Não zera a varredura
— outro X server na máquina ainda pode sujar —, mas a fonte que era **nossa** deixa de existir.

#### ❌ R9 conferido, e **refuta**: o xpra não encerra os filhos de `--start=`

Este é o resultado mais valioso da onda até agora, porque é o único que **derruba** um plano em vez
de confirmá-lo — e derruba barato, antes do pacote existir.

O roteiro (`docs/bancadas/motor-x11/r9-restart.sh`) põe um filho sentinela em `--start=` e manda
**SIGTERM**, que é o sinal do supervisor (`vssh-apps.ts:380,403,516,741`) — não o SIGINT do Ctrl-C.
O próprio xpra imprimiu a prova ao morrer:

```
stopping pulseaudio with pid 1544318
killing xvfb with pid 1544223
Error: cannot remove the session directory '/run/user/1184/xpra/192',
 1 commands are still running:
  * 'sleep' with pid 1544364 recorded in 'sh.pid'
```

**Ele reapa os auxiliares dele — pulseaudio, Xvfb — e não toca nos comandos de `--start=`.** A
distinção é entre *"processo que eu criei para funcionar"* e *"comando que me mandaram rodar"*, e
ela é deliberada do upstream, não um bug.

Consequência direta, e por inferência sólida: se um `sleep` sobrevive, **`vssh-psdialogd` também
sobrevive**. Ele é `--start=` na linha do portal (`xpra.ts:241`). Então numa sessão saudável o
daemon de notificação sobrevive à morte do motor — e o restart do supervisor colide com o **próprio
cadáver anterior**. Deixa de ser o caso "duas sessões concorrentes", que é raro, e vira falha
autoinfligida a cada reinício, que é o caminho normal de um `kind:"service"`.

> **E o estado vaza entre reinícios.** Na segunda subida (que funcionou — `xpra is ready`, display
> reusado, sockets recriados), o desligamento reclamou do pid **1544364** — o sentinela da
> **primeira** corrida. O `sh.pid` da corrida 1 nunca foi limpo, porque o diretório de sessão não
> pôde ser removido, e a corrida 3 leu o arquivo velho. Um motor reiniciado herda lixo do que ele
> mesmo foi.

**O que isto muda no pacote** — e é decisão de desenho, não detalhe:

| Saída | Custo |
|---|---|
| **Grupo de processos**: o entrypoint vira líder de grupo (`setsid`) e o supervisor mata o grupo (`kill -TERM -PGID`) | mexe no lifecycle de vssh-app, que hoje manda `kill -TERM <pid>`. Serve para todo app, não só este — provavelmente é a resposta certa |
| **Entrypoint que trata SIGTERM** e encerra os filhos antes de sair | fica dentro do pacote, não mexe em ninguém. Mas custa o `exec`, e com ele a coincidência `run.pid` == `server.pid` |
| **Tirar `vssh-psdialogd` do `--start=`** e fazer dele um vssh-app `kind:"service"` próprio | é o mais limpo conceitualmente — ele não é parte do motor X11, é um daemon que precisa de um display. Mas é outra onda dentro desta |

Nenhuma é escolha óbvia, e é por isso que descobrir agora vale: as três mudam o entrypoint, que é a
primeira linha do pacote a ser escrita.

##### ✅ Conferido: o `vssh-psdialogd` é capability do motor, e a saída 3 estava mal formulada

A pergunta era se o sistema de notificações depende dele. **Não depende, e a medida é seca:**
`NotificationCenter.js` cita `psdialog` **zero** vezes, e o caminho inteiro dos vssh-apps —
`EventsChannel.js`, `ws/events.ts`, `routes/notifications.ts` — também. O journal no servidor e o
`/ws/events` da Onda 2 nunca souberam que ele existe.

Onde ele é citado, são cinco lugares, e o padrão é claro:

| Onde | O que faz | De quem é |
|---|---|---|
| `Client.js:3678-3695`, `5221-5243` | **decodifica os hints `x-vssh-psdialog`** de notificações D-Bus encaminhadas pelo Xpra | **motor** — é um dos 27 arquivos |
| `xpra.ts:241` | o `--start=` que o sobe | **motor** |
| `vssh-update-client.sh:61,67` | instala `vssh-psdialog`/`vssh-psdialogd` junto com o bundle do cliente | **motor** — já viaja com o que vai mudar de dono |
| `VsshDialogs.js:586-647` | **renderiza** o diálogo a partir dos hints | **shell** |
| `terminal.ts:190` | exporta `~/.vssh-psdialogd-env` na sessão de terminal | shell citando artefato do motor |

> **O consumidor é o `Client.js`.** A ponte inteira existe dentro do cliente Xpra — logo o
> `psdialogd` é capability do motor **por construção, não por convenção**. E o recorte cai
> exatamente no idioma da 2.1/2.5: *a fonte é nomeada por quem a tem, e o chrome monta o elemento*
> — o daemon e o transporte são do motor, a renderização é do shell.

**Mas isso corrige a saída 3 em vez de escolhê-la.** Eu havia escrito "fazer dele um vssh-app
`kind:"service"` próprio". Está errado: se ele é capability do motor, ele fica **dentro** do pacote,
não ao lado. O que o achado resolve é **de quem ele é**; o R9 pergunta **quem o mata** — e essas
duas continuam sendo perguntas diferentes. Enquanto ele subir por `--start=`, sobrevive à morte do
motor e colide no reinício, esteja em que pacote estiver.

Fica um resíduo a tratar na poda: `terminal.ts:190` é código do shell citando um nome do motor. Ele
degrada sozinho (`[ -f … ] &&`), mas é exatamente o tipo de citação que o teste textual da onda
proíbe.

##### 📐 Custo medido da saída 1 (grupo de processos): pequeno, e conserta um buraco genérico

O app é lançado assim (`vssh-apps.ts:446`):

```sh
nohup vssh-app-run ${appId} >> "$d/run.log" 2>&1 &
```

e o `vssh-app-run` termina com `echo $$ > run.pid` seguido de `exec`. **Não há `setsid` em lugar
nenhum**, e `&` em bash não-interativo não cria grupo novo — controle de tarefas está desligado. Ou
seja: o app herda o grupo do `bash -c` do sudo, e `kill -TERM <pid>` mata **exatamente um
processo**.

> Isto **não é um problema do Xpra.** É um buraco genérico do lifecycle: qualquer vssh-app que crie
> filhos os deixa órfãos no stop e no restart. O Xpra só foi o primeiro a exibi-lo, porque
> `--start=` torna o filho visível.

A correção é de uma palavra mais um auxiliar:

1. **`nohup setsid vssh-app-run …`** no spawn. O `run.pid` continua correto tenha o `setsid` forkado
   ou não, porque quem escreve `$$` é o `vssh-app-run` final — depois do `setsid`, em qualquer
   caminho. E com ele o processo vira líder de sessão, então **PGID == PID == `run.pid`**.
2. **Um auxiliar** no lugar dos quatro `kill -TERM ${pid}` idênticos (`vssh-apps.ts:380, 403, 516,
   741`) — todos já passam pelo mesmo `_readAppPidFile`, então é um ponto só de mudança.

Uma armadilha a tratar, e é a única: **apps já rodando** foram lançados sem `setsid`, e para eles
`PGID ≠ PID` — `kill -TERM -<pid>` falharia com ESRCH. O auxiliar precisa conferir
`ps -o pgid= -p <pid>` e só usar a forma de grupo quando o PID for o líder, caindo no `kill` simples
caso contrário. Sem isso, a primeira atualização depois da mudança deixa de conseguir parar tudo o
que estava de pé.

##### ✅ Aplicado — e a correção não é da 2.7, é da plataforma

`nohup setsid vssh-app-run` no spawn (`vssh-apps.ts:446`) e um `_killAppTree` no lugar dos quatro
`kill -TERM ${pid}` idênticos (`vssh-apps.ts:407, 430, 555, 780`). **Suíte: 441 testes, 0 falhas**,
`eslint` e `tsc` limpos.

Vale insistir no enquadramento, porque ele muda quem se beneficia: **o Xpra só foi o mensageiro.**
Todo vssh-app que gera subprocesso deixava filhos órfãos em toda parada e todo reinício — o
`--start=` do xpra apenas tornou o filho visível o bastante para alguém notar. A correção paga para
todos, e entra antes de o pacote do motor existir.

Três decisões que o teste (`tests/unit/app-kill-tree.test.js`) fixa:

- **Um comando remoto só.** Perguntar o PGID numa chamada e matar noutra dobraria o custo de toda
  parada de app contra um teto de ~8 canais por servidor. O teste conta as `execCommand` do
  auxiliar e exige exatamente uma.
- **O snippet é extraído do fonte, não recopiado.** Uma cópia divergiria em silêncio e o teste
  passaria a atestar código que não roda mais.
- **Os dois ramos são executados**, com `ps` e `kill` de mentira, porque *qual ramo ele toma* é
  precisamente o que uma asserção textual não vê. Provado por mutação: tirando a guarda de PGID,
  dois testes reprovam; tirando o `setsid`, outro.

> A armadilha da compatibilidade é a única parte disto que **não dá para observar em
> desenvolvimento** — ela só existe na janela entre o deploy e o próximo restart de cada app. Por
> isso ela tem teste próprio, com o motivo escrito na asserção.

### O transporte deixa de ser pergunta — é o mesmo de todo app

Enquanto o socket do Xpra entregava a página, o transporte era **inegociável**: tinha de ser HTTP,
alcançável pelo navegador, e existir antes de qualquer coisa nossa rodar. Nada disso vale mais.

Com o motor instalado como vssh-app, o caminho já existe e não é dele:

- **navegador → motor**: `/<serverId>/proxy/app/<id>/` — o proxy autenticado que todo vssh-app usa,
  com `VSSH_APP_PORT` alocado por hash e **verificado contra `ss -tlnp`**, `VSSH_APP_TOKEN` injetado
  como header, WebSocket encaminhado sem configuração extra;
- **motor → sessão X**: os dois estão **na mesma máquina**. Socket unix, sem rede, sem porta, sem
  senha.

Some assim, sem escolha de transporte a fazer, a coluna inteira da primeira tabela: `20000+uid`, o
`tcp-password`, o ramo `DIRECT_PROXY` que reinicia sessão viva, o túnel dedicado, os dois caches. O
SSH que resta é o que já existe e já é compartilhado com o resto.

> **"Conectar via SSH" não é inventar um transporte para o Xpra. É parar de ter um.**

**Uma armadilha, dita antes de alguém ser esperto.** Se em algum momento parecer elegante alcançar a
sessão por um canal `direct-streamlocal` sobre o pool de exec do portal, não é: o canal do `fs-watch`
já é longo e **não passa pelo limitador** (`fs-watch.ts:14-19`), e o resultado documentado é *cada
usuário com um watch aberto rouba um canal do orçamento do servidor inteiro, sem ser contabilizado*.
Uma sessão de desktop é mais longa que um watch e existe para todo usuário com X11 aberto — seria o
mesmo bug multiplicado por sessão, chegando como "o servidor parou de abrir arquivo".

### A senha some porque a porta some

`--tcp-auth=file:filename=…` existe por uma razão só: um socket TCP no loopback é alcançável por
**qualquer processo do mesmo usuário Linux**, então precisa de um segredo. Um socket unix em
`/run/user/UID/` já tem a permissão do sistema de arquivos como autenticação — que é exatamente o
modelo que o resto do ambiente usa e declara usar ("roda como o usuário Linux dono da sessão").

O `tcp-password` não é só uma linha a menos. É um mecanismo de autenticação **que não existe em
nenhum outro lugar do ambiente**, escrito à mão, com um contorno para newline no meio
(`xpra.ts:133-138`). Ele desaparece por consequência, não por esforço.

## O motor instalável — a metade que faltava

### O que o motor precisa ganhar de próprio

Instalável não é arrumação: é o que dá ao motor as três coisas que hoje ele não tem, e que todo o
resto do ambiente já tem.

| | Hoje | Instalável |
|---|---|---|
| **Versão** | não existe uma. "Que Xpra roda neste servidor" é o que a distro instalou, e "com que flags" é o que o portal deployado tem no fonte | `version` semver no manifest, `sha256` verificado, **3 versões retidas**, rollback pela aba admin → Repositório |
| **Atualização à parte** | trocar uma flag do `xpra start` é um deploy do portal — Docker/K8s, todos os servidores, todos os usuários, de uma vez | publicar uma versão. Idempotente por versão, servidor a servidor, sem tocar no portal nem no desktop |
| **Manutenção portátil** | a política vive espalhada em TypeScript do portal; levá-la para outra instalação é levar o portal | um pacote. `vssh-app-install <id>` num servidor novo, e ele tem motor X11 — do mesmo jeito que tem Recoll ou Scramjet |

> **E a atualização à parte é nos dois sentidos.** Hoje acompanhar o upstream do Xpra é um merge
> dentro de `vssh-client/`, porque o cliente dele mora lá. Com o motor, subir de Xpra 6 para 7 é
> publicar uma versão do pacote — e o desktop não fica sabendo.

Um esclarecimento, porque é o erro fácil: **nada disso é sobre a entrega do nosso cliente.** O
`CUSTOM_XPRA_USERS` fixo no fonte, a cadeia de 5 diretórios em `/usr/share/xpra/`, o `rsync --delete`
por timer horário — tudo isso existe para servir o desktop **pelo** `--html=` do xpra, e no ambiente
novo não há esse caminho. Não é argumento desta onda; é entulho que morre com o perfil antigo, e
entra na poda do passo 4, não na motivação.

### A regra já está escrita — o Xpra é a exceção que a antecede

A SKILL do toolkit diz, sobre um backend que uma janela nativa vai consumir:

> *"não invente um mecanismo de entrega paralelo pra um backend que uma janela nativa vai consumir —
> o lifecycle de instalação/execução (`vssh-app-install`/`-run`, alocação de porta, proxy
> autenticado) já serve pros dois casos sem alteração."*

O `scramjet-wisp` é a referência completa: `type: "engine"`, sem janela, sem ícone, consumido pelo
`BrowserWindow` nativo por `AppLauncher.ensureRunning(appId)`. O Xpra é o **único** motor do
ambiente que ainda tem entrega própria — e tem porque é mais velho que a regra.

### O que o pacote do motor contém: **política, não binário**

Uma honestidade que precisa vir antes do entusiasmo: **não se vendoriza o Xpra.** Ele é pacote de
distro, com dependências de sistema (Xvfb/Xorg, GTK, codecs) que não cabem num tarball nosso, e
fingir o contrário faria a onda descobrir isso no meio do caminho.

O que vira pacote versionado é **como nós o rodamos** — que hoje está espalhado dentro do portal:

| Vai para o pacote do motor | Hoje mora em |
|---|---|
| A linha de start, **sem o `--html`** (o motor não serve página nenhuma): `--bind`, `--dpi`, `--xvfb`, `--start-env` ×7, `--input-method`, `--no-keyboard-sync`, o `vssh-psdialogd`, o `setxkbmap` | `xpra.ts:222-244`, fonte TypeScript deployado por Docker/K8s |
| A alocação de display e a política de reuso | `xpra.ts:23-66` |
| O setup por usuário: `~/.xpra`, `xpra-mimeapps.list`, o `.desktop` do `vssh-browser` com 28 MIME types | `_ensureXpraMimeDefaults`, `xpra.ts:452-532` |
| O `xvfb` escolhido por usuário (hoje há um `if (sshUser === 'arthur.carrenho')` no fonte) | `xpra.ts:172-174` |
| **O lado-cliente da integração** — os 27 arquivos + o cursor, hoje em `vssh-client/` | `index.html`, marcados `data-xpra` |
| A pergunta "há X11 aqui?" | coluna `profile` no banco do portal |

Consequência direta: **trocar uma flag do Xpra deixa de ser um deploy do portal e passa a ser
publicar uma versão.** Semver, `sha256` verificado, três versões retidas, idempotente por versão,
rollback pela aba admin → Repositório. É o que o `vsshapp-recoll` e o `scramjet-wisp` já fazem.

#### ✅ R5 conferido: o que fica no portal são **29 das 619 linhas**

Classificação linha a linha de `provisioning/xpra.ts`, em quatro destinos:

| Destino | Linhas | O quê |
|---|---:|---|
| **Some** — já não tem assunto | ~190 | `20000+uid`; o `tcp-password`; o ramo `DIRECT_PROXY`; `CUSTOM_XPRA_USERS` + a cadeia de 5 diretórios + `--html=`; o poll de 25× `curl`; os dois caches Redis; o `stopXpra` (menos o túnel); o `getUserDesktopPort`; o `checkXpraStatus`; e os seis mocks de `SSH_LOCAL_MODE` |
| **Vai para o pacote** | ~200 | `findFreeXpraDisplay` (44); a linha de start com `--xvfb`/`--start-env`/`--dpi` (~60); o `setxkbmap` (9); `_ensureXpraMimeDefaults` + os 28 MIME types (81); o `command -v xpra`, que vira `installCommand` (8) |
| **Vira endpoint do motor** | 82 | `_resolveXpraConf` + `getXpraEnv` + `setXpraEnv`. Hoje são duas rotas do portal (`/xpra/env`) que leem e escrevem `~/.config/xpra/xpra.conf` por SSH; como o motor já é um backend HTTP na mesma máquina, viram `GET`/`POST /env` dele — e as duas rotas do portal somem junto |
| **Fica no portal** | **~29** | `ensureLinuxUser` + o setup de sessão via `vssh-setup-user`/`initializeUserSession` (~17) — exige **root**, e criar conta Linux não é trabalho de motor; `ensureSshTunnelAsync`/`stopSshTunnel` (3), que viram o túnel de app compartilhado; e `ensureSession` (9), que é dono do par (servidor, usuário) e cujo lugar a [Onda 1](01-sessao-sem-xpra.md) já decidiu |

O resto (~118 linhas) é comentário, import e JSDoc.

> **A conta que importa:** o portal deixa de saber o que é um display X11, o que é um `xvfb`, quais
> MIME types o navegador integrado atende e com que flags o xpra sobe. Ele passa a saber uma coisa
> só — **que existe um motor instalado, e como pedir que ele suba.**

##### O caso de fronteira: o teclado, e ele tem resposta pronta

`keyboardLayout`/`keyboardVariant` chegam ao `startXpra` como argumentos, vindos do **banco do
portal** (`dbUser.keyboard_layout`, `keys.ts:447` e `:554`) e viram um `--start=setxkbmap`. É a única
coisa na linha de start que o motor **não pode descobrir sozinho**: é preferência de usuário, e mora
onde o motor não alcança.

Não precisa de mecanismo novo. O `startApp` já escreve `VSSH_APP_PORT`, `VSSH_APP_TOKEN` e
`VSSH_APP_BASE_PATH` em `$HOME/.vssh-apps/<id>/env` **antes** de lançar, com 0600, exatamente para
que o processo receba do portal o que só o portal sabe. Uma variável a mais é a mesma via.

> Generalizando, e é o contrato do motor instalável: **o portal escreve as preferências no
> `env` e manda subir; o motor lê e decide como.** Nenhum dos dois precisa saber do outro além
> disso — que é a mesma inversão da 2.1 e da 2.5, agora entre processos em vez de entre módulos.

### O que a instalação padrão dá de graça — e o que ela substitui

Cada linha é um mecanismo escrito à mão hoje, com equivalente já rodando em produção para outro
motor:

| O lifecycle de vssh-app já tem | Hoje, para o Xpra, é |
|---|---|
| `installCommand` root (deps de sistema) + por usuário, com marker file | `command -v xpra` solto + o portal escrevendo na home do usuário por SSH |
| `VSSH_APP_PORT` — md5(user:app), faixa 40000-49999, **verificado contra `ss -tlnp`**, cache 24h | `20000+uid` por aritmética, que mente quando ninguém escuta |
| `VSSH_APP_TOKEN` injetado como `X-Vssh-App-Token` pelo proxy autenticado | `~/.xpra/tcp-password`, gerado à mão, com contorno de newline |
| `run.pid` escrito antes do `exec`, e o supervisor rastreando por ele | `pgrep -u … -af "xpra.*:[0-9]+"` em quatro funções diferentes |
| `run.log` + `run.log.1` rotacionado, e **"Ver log do backend"** no menu de contexto da janela | nada — o diagnóstico exige SSH |
| `kind:"service"`: watchdog, backoff 2ⁿ, teto de 5 falhas, estado em Configurações → Serviços | **nada reinicia um xpra morto.** Hoje o desktop morre junto, porque a página veio dele |
| `healthcheckPath` com teto e um toast honesto quando estoura | 25 iterações de `curl` dentro do servidor |
| `GET /api/apps` como descoberta, e `disponivel()` na seção de Configurações | a coluna `profile` e cinco rotas `/xpra/*` (`keys.ts:411-528`) |

**A linha do `kind:"service"` é a que muda o que o usuário sente.** Hoje, se o Xpra cai, o ambiente
cai — a página tinha vindo dele. Como motor supervisionado, ele reinicia sozinho, e o que o usuário
vê é uma seção de Configurações que reconecta. Reiniciar o motor deixa de ser reiniciar o ambiente.

### E a portabilidade, que é a estrela-guia

*"Este servidor tem estes motores, nestas versões"* é uma frase que atravessa máquinas. *"Este
servidor é do perfil `headless`"* não é — ela descreve uma decisão de provisionamento que não
significa nada na máquina seguinte. É por isso que a [Onda 7](06-portabilidade.md) fica mais barata
depois desta, e não apesar dela.

## Por que isto é possível agora, e não era antes

Quatro coisas já aconteceram, e cada uma tirou uma dependência estrutural:

| | |
|---|---|
| [Onda 1](01-sessao-sem-xpra.md) | "Sessão" deixou de ser sinônimo de "processo xpra". O watchdog de `kind:"service"` nascia dentro do `startXpra()`; hoje `ensureSession()` é objeto de primeira classe |
| [Um index por modo](diagnostico.md#-resolvido-um-index-por-modo-sem-um-segundo-arquivo) | `stripXpraTags()` já remove os 23 `<script data-xpra>` de um único `index.html`. **O bundle já é um só** — e a marcação já diz, arquivo por arquivo, exatamente o que muda de dono |
| [O desktop servido pelo portal](diagnostico.md#três-achados-verificados-no-código) | É a primeira metade desta inversão, já entregue e medida. Ela é a evidência, não a analogia |
| [2.1](02-apis-de-shell.md#21--tray---concluída) e [2.5](02-apis-de-shell.md#25--mixer-de-volume-por-aplicação---concluída) | O idioma já existe e já foi provado duas vezes: *a fonte é nomeada por quem a tem, e o chrome monta o elemento*. O `VolumeMixer` não sabe que Xpra existe; quem tem o stream o registra |

E os dois registros já existem, simétricos: `BrowserEngines.js` (74 linhas) e
`RemoteDesktopEngines.js` (75 linhas), ambos `register`/`get`/`list` com `available()`, ambos
consumidos pela mesma seção "Motores" de Configurações. O que a 2.6 chamou de "seção condicional"
é esse `available()`.

## O que a onda entrega

### 1. O motor deixa de ser cidadão do portal

`provisioning/xpra.ts` (619 linhas, 123 ocorrências de "xpra") encolhe para o que é de fato do
portal: perguntar ao motor. A política — start line, display, setup por usuário — vai para o pacote
do motor. As cinco rotas `/xpra/*` (`keys.ts`, 31 ocorrências) colapsam nas rotas de app que já
existem.

**O teste da onda é textual e é o mesmo da 2.5:** nenhum arquivo do shell fora do motor pode citar
`client`, `xpra` ou qualquer nome do bundle removido. Hoje isso vale para o `VolumeMixer` e para a
janela de Configurações; ao fim desta onda vale para o shell inteiro, e o
`client-undefined-refs.test.js` deixa de precisar declarar `client` como global gravável.

### 2. Um perfil, e uma capability

`VsshHost.xpraDisabled()` some (`vssh-host.js:137`, e os 4 usos em `index.html` + `Client.js:2703`).
A coluna `profile` some do banco e os 4 ramos `headless` somem com ela. E `stripXpraTags()` some
**inteiro** — junto com o atributo `data-xpra` e o teste que o guarda: ele existia para tirar do
`index.html` o que agora nem entra nele. As capabilities (`nativeApps`, `audioStream`,
`fileTransfer`, `clipboardImage`) deixam de ser propriedades do *perfil* e passam a ser propriedades
do *motor instalado* — que é o que elas descrevem.

### 3. A escolha vira preferência, e ela já tem tela

A [2.6](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito) entregou a superfície: em
**Abrir com → Motores**, duas linhas — *Motor do Navegador* (Desabilitado · Scramjet) e *Motor X11*
(Desabilitado · Xpra, hoje marcada como planejada, `secoes-ambiente.js:295-301`). Desligar um faz a
seção dele deixar de existir, pelo mesmo `disponivel()`, sem caso especial.

Consequência que a 2.6 não resolve e esta onda tem de resolver: **hoje "tem Xpra" é um fato do
servidor, não uma escolha do usuário.** Virar preferência exige decidir o que acontece quando a
preferência e o fato discordam — usuário pede Xpra num servidor sem X11 provisionado. A resposta
provável é a mesma do motor de navegação: `available()` manda, e a preferência é um pedido.

### 4. O lado-cliente do Xpra sai do nosso repositório

Os 27 arquivos (+ o cursor), ~1,42 MB, passam a viajar com o pacote do motor. E **apagar o que isso torna sem
assunto** — `stripXpraTags()`, `data-xpra`, `xpraDisabled()`, o `new XpraClient` de `index.html:739`,
a cadeia de entrega em `/usr/share/xpra/` — é parte da entrega, não do "depois": código morto que
ainda compila fica.

### 5. O vocabulário some da roadmap e do código

"Headless", "xpraless" e "perfil sem Xpra" saem de todo texto e de todo identificador. O que fica é
**"com o motor X11"** e **"sem o motor X11"** — que descreve o que é, e não o que falta.

## O que NÃO é desta onda

- **Reempacotar o Xpra.** O binário continua vindo da distro; o que vira pacote é a política de
  execução **e o lado-cliente da integração**. Ver "política, não binário", acima — é a distinção
  que faz a onda ser executável.
- **Reescrever o cliente HTML5 do Xpra.** Ele vai como está, para dentro do pacote. Trocá-lo por uma
  integração nossa é uma conversa que só faz sentido depois que ele estiver lá — e aí é barata,
  porque a fronteira já existe.
- **Um segundo motor de desktop remoto** (RDP, VNC, Wayland/`waypipe`). O registro existe para que
  isso seja possível; construir o segundo é outra conversa, e sem um caso de uso real seria
  abstração especulativa.
- **Remover o Xpra.** Ele continua sendo a única forma de trazer aplicação X11 para dentro do
  ambiente, e vários [casos de uso](casos-de-uso.md) dependem disso. O que muda é o lugar dele.
- **Fundir os dois `index.html`.** Já são um só desde a
  [2.x](diagnostico.md#-resolvido-um-index-por-modo-sem-um-segundo-arquivo).

## Por que 2.7 e não Onda 8

A pergunta que moveu isto foi *"não vale adiantar para evitar retrabalho?"* — e a resposta muda
conforme o que se olha. Olhando só para a 2.6, o retrabalho é pequeno e localizado. Olhando para o
que vem **depois** da 2.6, ele é grande e, num ponto, irreversível.

**Toda onda daqui em diante paga o imposto dos dois perfis.** Cada superfície nova precisa ser
especificada e verificada duas vezes, e a [Onda 0c](0c-colapso-de-variantes.md) já cobrou esse
preço uma vez em escala menor. Mas há uma onda em que o imposto deixa de ser custo e vira dívida
permanente:

> ### A [Onda 5](04-runtime-composicao.md#registro-de-capabilities) congela um contrato PÚBLICO
>
> Ela entrega `provides`, os pontos de extensão, a mensageria e a seção de Configurações por
> manifesto — tudo negociado por `vssh.capabilities()`, e tudo **versionado, para gente de fora
> do repositório**.
>
> Com dois perfis, o que esse contrato exporta é *"em que perfil eu estou"*. Com motores, ele
> exporta *"que motores existem aqui, em que versão"*. **A segunda é a pergunta certa**, e é a única
> que continua respondível quando aparecer um segundo motor de desktop remoto.
>
> Contrato interno se reescreve numa tarde. Contrato publicado para terceiros, não: ele vira
> compatibilidade a manter, e o modelo errado sai caro para sempre — em cada app que alguém
> escrever contra ele.

As outras ondas confirmam a direção, com custo menor. A [4](04-runtime-composicao.md) especifica
limite de recurso e GPU, e "aplicação X11" e "vssh-app" têm perfis de consumo diferentes — como
motores, é um limite por motor em vez de duas especificações. A [7](06-portabilidade.md) promete
continuidade entre máquinas, e "este servidor tem estes motores" atravessa máquinas.

E há o argumento de custo, que é o mais concreto: **a 2.6 acabou de reescrever exatamente os
arquivos que leem capability.** Os dois trabalhos tocam o mesmo código na mesma semana em vez de em
duas — e o segundo, feito depois, seria feito contra código pronto, que é quando ele é caro.

## Sequenciamento

### Passo 1 · O registro — ✅ **concluído na 2.6**

`RemoteDesktopEngines` (75 linhas, `register`/`get`/`list`/`disponiveis`) e o Xpra registrado de
dentro do `if (client)` que já existia (`index.html:1412-1436`), no mesmo idioma do `init_audio`.
O arquivo do registro **não nomeia o Xpra** — é asserção de teste.

Foi adiantado porque a seção Xpra da 2.6 precisava do bloco de estado do motor, e sem registro a
janela nova leria `client` direto — reintroduzindo o acoplamento que a
[2.5](02-apis-de-shell.md#25--mixer-de-volume-por-aplicação---concluída) gastou uma onda inteira para
inverter. O ganho secundário se confirmou: a asserção *"este arquivo não cita `client`"* cobre a
janela de Configurações **desde o primeiro commit dela**.

### Passo 2 · O motor instalável — ✅ **concluído (2026-08-05)**

> #### O corte, e o que ele custou de verdade
>
> A poda foi **um** commit (`vssh-sso a4a2761`), como esta seção pedia — o que garante que os dois
> motores nunca coexistam é não haver instante entre desligar um e ligar o outro.
>
> | | antes | depois |
> |---|---:|---:|
> | `provisioning/xpra.ts` | 619 | **103** |
> | `utils/recoll-dbs.js` | 300 | **0** — apagado |
> | serviços do proxy semântico | 5 | **4** (`desktop` saiu) |
>
> O que sobrou no `xpra.ts` são as duas leituras do `xpra.conf`: preferência de usuário num
> arquivo na home dele, que por isso precisa de SSH. **Não é ciclo de vida; é leitura de arquivo
> remoto** — e é a linha divisória que o R5 previa.
>
> **Três conferências mudaram o corte, e sem elas ele teria quebrado coisa:**
>
> 1. **`_ensureXpraMimeDefaults` não era plumbing, era capacidade.** Ela faz o `xdg-open` de
>    dentro da sessão X11 resolver para o `vssh-browser`, e era chamada **de dentro do
>    `startXpra`**. Apagá-la junto quebraria o clique em link numa aplicação nativa, calado.
>    Migrou para o entrypoint do pacote — e encolheu de ~60 linhas de TypeScript com nove
>    comandos remotos por `sudo -u` para um `cat >`, porque o motor **já é** o usuário e **já
>    está** na máquina. É a tese da onda no menor exemplo que ela tem.
> 2. **`RECOLL_EXTRA_DBS` não muda de casa — foi substituído.** O entrypoint prometia que
>    mudaria; estava errado. A seleção de índices virou preferência de usuário
>    (`routes/recoll.ts`), e a constante de 300 linhas tinha um consumidor só.
> 3. **`ensureSession` já é chamado pelo start de app** (`apps.ts:158`), então a conta Linux e o
>    `XDG_RUNTIME_DIR` nunca dependeram do `startXpra`. Foi o que permitiu apagá-lo inteiro em
>    vez de reimplantar metade.
>
> E o achado que mais economizou trabalho: **`startXpra`, `stopXpra` e `checkXpraStatus` tinham
> ZERO chamadores vivos** quando o corte começou — só a reexportação em `key-provisioner`. As
> rotas `/xpra/*` já tinham sido neutralizadas antes. O corte grande era, no fim, código morto
> esperando alguém confirmar que estava morto.
>
> **A trava da transição inverteu de sinal** (`vsshapp-xpra bfd3af1`). Ela recusava subir se
> achasse algo em `20000 + uid`; agora que o portal não cria mais aquela porta, o que restar ali
> é sessão órfã — e recusar deixaria o usuário sem desktop nenhum, refém de um processo que
> ninguém alcança. Virou aviso com o comando de recolher, e a CI ganhou o par: exige
> `PORTA_LEGADA` **e proíbe** `RECUSANDO SUBIR`.
>
> #### ⚠ Uma correção a esta seção: `getXpraEnv`/`setXpraEnv` **não** vão para o motor
>
> O texto abaixo mandava "mover `getXpraEnv`/`setXpraEnv` para endpoints do motor". Não dá, e não
> deve: o backend do pacote **é o `xpra start`** — não há servidor HTTP nosso onde pendurar um
> endpoint, e criar um sidecar só para isto seria inventar transporte para o que já tem um. Elas
> leem e escrevem um arquivo na home do usuário; o portal já fala SSH autenticado com aquela
> máquina. Ficam, e é por isso que o `xpra.ts` para em 103 linhas em vez de zero.
>
> #### O que a poda **não** fez, e continua aberto
>
> `vssh-client/connect.html` (73 KB, o diálogo do upstream) segue no shell, sem decisão. Ele não é
> alcançável desde que o `callback_close` deixou de redirecionar — mas peso morto que ninguém
> nomeia é o que a onda inteira existe para não deixar acontecer.

<details>
<summary>O registro de como o passo 2 foi construído — mantido porque as medições valem</summary>

**Feito:** o esqueleto do pacote (`vsshapp-xpra/`) — manifest `type:"engine"`/`kind:"service"`,
entrypoint em primeiro plano, `installCommand` em duas fases, e o **carregador**, que é onde moram
as três regras inegociáveis do lado-cliente (conexão em segundo plano, falha que não redireciona,
falha que não cobre o ambiente). E os **28 arquivos** do cliente, copiados e conferidos.

A cópia foi verificada do jeito que importa: a bancada serve `/motor/` **do pacote** e `/shell/` do
`vssh-client`, e o cliente carrega inteiro de lá — zero pedidos ao caminho da página, nenhum erro.
Ou seja, o pacote é autossuficiente, e não funciona por estar ao lado do shell.

> **A duplicata é deliberada e conferida.** Mover os arquivos agora deixaria o shell quebrado — o
> `index.html` ainda tem as tags e a fiação. Então eles foram **copiados**, e
> `sincronizar-do-shell.mjs --conferir` falha se as duas cópias divergirem: invariante checada em
> vez de fork esperando acontecer. O script morre quando a fiação sair do shell.

**A fiação: 644 linhas no `index.html`, das quais ~555 já foram tratadas.**

| Função | Linhas | Destino |
|---|---:|---|
| `init_client` | 355 | ✅ portado. **46 das 48 propriedades** conferidas uma a uma; as duas de fora são comentário (`HELLO_TIMEOUT`, `PING_FREQUENCY`) e `start_new_session`, que nunca se aplicou — o portal é quem inicia a sessão |
| `init_file_transfer` | 68 | ✅ portado o arrastar-para-a-sessão. A **rede de proteção no documento fica no shell**: soltar arquivo no vazio faz o Chrome navegar a aba, e isso mata o ambiente com ou sem motor |
| `init_audio` | 48 | ✅ portado — é o motor se apresentando ao `VolumeMixer`, que continua não conhecendo Xpra |
| `init_tablet_input` | 41 | ✅ portado. Depende de `CHAR_TO_NAME`/`KEYSYM_TO_LAYOUT`, do `Keycodes.js` — mais uma peça que parecia do shell e não era |
| `init_remote_desktop_engine` | 26 | ✅ portado, e **completado**: o meu registro inicial tinha esquecido `iniciarMedicao`/`pararMedicao`/`latenciaMs`/`desdeMs`. Ganhou `fase` e `erro`, que com a conexão em segundo plano deixam de ser a mesma coisa |
| `connection_progress` | 25 | ✅ **morre** — é o overlay de tela cheia que a regra 3 proíbe |
| `init_clipboard` | 3 | ✅ portado (chamava só o método do cliente) |
| `load_default_settings` | 55 | ✅ **portado**, e melhorou de status: no shell ele GATEAVA o `init_page()` — o boot do desktop inteiro esperava uma ida à rede por um arquivo do xpra. No carregador não gateia nada, e falhar não é erro: o arquivo é opcional |
| `init_keyboard` + o seletor de layout | ~140 | ✅ **saiu do shell**. O menu da barra (35 layouts, busca, botão fixo nos dois perfis) morreu; sobrou uma linha em Configurações, que acha o motor **por capacidade** (`layouts` + `definirLayout`) e não por `id`. A lista vem do motor |

Cada subsistema roda dentro de um `try/catch` próprio, por causa da regra 3: um que estoure vira
uma linha de log, não uma conexão perdida nem um ambiente coberto.

**Medido na bancada, com o motor servido do pacote:** 27 pedidos ao `/motor/`, zero 404,
`fase=conectando`, cliente construído, nenhum erro de JS.

#### ⚠ Revisão (2026-08-04): o pacote estava pronto para publicar e **não** para instalar

A ordem acabou invertida — repo, CI e publish vieram antes da poda. A revisão que se seguiu achou
seis coisas, e vale registrar as três que não eram "falta fazer" e sim "está errado":

**1. `runtime: "binary"` exige o bit de execução, e ele não estava lá.** O `vssh-app-run` faz
`exec "./backend/entrypoint.sh"`; um arquivo `100644` é `EACCES` e o motor nunca sobe. Não adianta
contar com o instalador: `vssh-app-install` faz `chmod -R go+rX`, e o `X` maiúsculo só concede
execução a quem **já** a tem. O bit precisa estar no índice do git, que é o que o `git archive` do
publish carrega — e o desenvolvimento é no Windows, onde o modo em disco não diz nada. Consertado, e
`conferir-pacote.mjs` passou a ler `git ls-files -s`, que responde igual em qualquer plataforma.

**2. O contrato do teclado tinha três buracos em série, e o comentário do pacote afirmava o
contrário.** O entrypoint lia `VSSH_X11_KEYBOARD_LAYOUT` — e **ninguém no portal escrevia essa
variável**. Passava despercebido porque o recuo do motor é `br`/`abnt2`, que é o padrão do produto:
funcionava, e só não funcionava *mudar*. Os três:

- o portal não escrevia a preferência → agora escreve, por `_PREFERENCIAS_DO_PORTAL` (uma tabela
  explícita, app por app) no `EnvironmentFile`, que é o que sobrevive ao relançamento pelo
  supervisor;
- o seletor não **salvava** nada, só chamava `send_keymap` — que reprograma o cliente conectado e
  não o `setxkbmap` do arranque. A troca valia até fechar a aba, e a tela dizia "vale nesta sessão"
  porque era só isso que ela fazia;
- `us-intl` é **um** item na lista e **duas** colunas no banco. Gravado inteiro, reprovaria o
  `^[a-z]{2,8}$` do motor e a sessão seguinte recuaria para `br`.

E o valor atravessa uma fronteira desagradável: entra por um `PUT` sem schema e sai dentro de um
`printf` num `bash -c` com sudo. Ganhou alfabeto restrito no lado que escreve (o que protege) e
validação no `PUT` (o que torna o lixo visível em vez de silencioso).

> A frase falsa estava no comentário do entrypoint — exatamente onde alguém iria conferir. É o
> segundo caso desta onda: **uma afirmação errada no lugar da verificação vale menos que nenhuma**,
> porque ocupa a vaga dela.

**3. Instalar o pacote hoje subiria um SEGUNDO Xpra.** O `provisioning/xpra.ts` continua vivo, em
`20000 + uid`, e é nele que o shell conecta; o pacote é `kind:"service"`, então o eager-start do
`index.html` o levanta a cada carga de página. Duas sessões X11, dois Xvfb, a segunda sem cliente
nenhum — não quebra, e por isso não avisa.

O entrypoint passou a checar `20000 + uid` e **recusar**, com o motivo no `run.log`. A pergunta não
tem falso positivo (nenhum motor legítimo escuta ali; este roda na faixa 40000-49999) e a trava
**some sozinha** quando o caminho antigo for desligado — que é o único jeito de uma trava temporária
não virar permanente. Ela é de uma direção só, e isso está dito no lugar.

Fora esses: o `publish.yml` inlinhava o que o `_publish-app-reusable.yml` do toolkit já faz —
validava o manifesto duas vezes e exigia configurar uma `VSSH_REPO_API` que os outros dois apps
resolvem com um default. Alinhado, com as verificações próprias num job `verificar` antes.

**O que ficava** — feito em `a4a2761`, e eram **24** tags, não 26: duas das que contei eram prosa em comentário, achadas pela asserção de tamanho do próprio corte. Tirar as tags, apagar `stripXpraTags()` e `xpraDisabled()`, podar o
`provisioning/xpra.ts`, mover `getXpraEnv`/`setXpraEnv` para endpoints do motor e apontar o
`XPRA_CLIENT_BASE` para `/proxy/app/xpra/`. Isso é **um** commit e não vários: é a troca atômica
que garante que os dois motores nunca coexistam.

O pacote (`type: "engine"`, `kind: "service"`), a migração para dentro dele de **duas** coisas — a
política de execução e os 27 arquivos do lado-cliente — e a poda correspondente em
`provisioning/xpra.ts` e no `index.html`. É onde o ganho está, e é onde estão as incógnitas.

Ordem interna: **R1 vinha antes de tudo, e já foi conferido** — passa, com quatro caminhos relativos
a rebasear. O lado-cliente está liberado, e agora tem tamanho conhecido em vez de risco aberto.

A ordem que sobra, e ela importa: **R4 antes de escrever o pacote.** É ela que decide o formato — um
xpra que forka e destaca não é supervisionável por `run.pid`, e isso muda o entrypoint, não um
detalhe dele.

</details>

### Passo 3 · A preferência — ✅ **concluído**

`x11Engine` entrou no schema, com sanitizador, e a linha "Motor X11" deixou de ser `planejado`.

**A decisão de produto que travava a linha evaporou**, e vale registrar por quê. Ela era: *o que
acontece quando alguém pede Xpra num servidor sem X11 provisionado?* Depois do passo 2 não há como
pedir — a lista do seletor sai de `/api/apps` e só contém motores **instalados**. Um motor que não
está no servidor não é uma opção que exista.

**O padrão é Desabilitado**, e isso é decisão, não omissão. O ambiente é completo sem X11; ligar o
motor para todo mundo faria quem nunca abre uma aplicação gráfica pagar um Xvfb, um pulseaudio e
1,42 MB de cliente — e faria o ambiente sem X11 parecer o caso degradado, que é a leitura que esta
onda inteira desfez. O eager-start passou a consultar a chave: um motor não escolhido não é
iniciado, não é baixado e não custa nada.

**E a troca vale na hora.** O texto anterior desta seção previa um "vale a partir da próxima
sessão", e era resquício de quando havia amarra. Não há: o motor tem o lifecycle de app — sobe,
para e reinicia sob demanda — e o lado-cliente conecta e desconecta sozinho. `MotoresX11.aplicar()`
desliga derrubando a sessão e parando o backend, e liga subindo o backend, carregando o
lado-cliente se ele ainda não veio nesta página, e conectando.

A chave guarda o **id do app**, e não o do motor: é ele que o lifecycle entende, e a linha precisa
poder oferecer um motor que está desligado — que, por estar desligado, não se registrou. Os dois
ids coincidem por convenção, mas depender disso seria construir sobre um acidente.

### Passo 4 · A inversão de vocabulário — **2.7, e sozinha no commit**

Sumir com "headless" e "xpraless" de código, testes e docs — **37 ocorrências**, em 12 arquivos.

> #### ⚠ Duas correções a este passo, achadas ao conferir o estado real (2026-08-05)
>
> **`VsshHost.xpraDisabled()` já morreu.** Foi no passo 2, junto com as tags `data-xpra` e o
> `stripXpraTags()`. As 8 menções que restam nos três repositórios são **prosa em comentário**,
> explicando o que deixou de existir. Não há o que colapsar.
>
> **A coluna `profile` NÃO pode ser colapsada, e dizer que pode é o erro mais caro deste
> documento.** Ela ainda decide **quais pacotes o provisionamento instala** — que é uma pergunta
> legítima e que sobrevive à onda. O que morreu foi `profile` como discriminador **de desktop**,
> e esse já caiu com o ramo `semanticService === 'desktop'` do `proxy.ts`. São duas coisas com um
> nome só, e o passo 4 tem de separar as duas antes de apagar qualquer uma — apagar a coluna
> deixaria servidor headless instalando pacote de X11.
>
> Sobra o que ainda ramifica por desktop: `resolve-server.ts:18,60`, `db.js:308,322` e
> `printers.ts:95` — este último é **falso positivo**, "headless" ali é o do Chromium, palavra
> diferente com a mesma grafia. É exatamente o tipo de coisa que um `sed` global estraga.

É um diff grande, mecânico e de baixo risco **quando está sozinho** — e é
exatamente o tipo de mudança que, misturada a outra, esconde a quebra no meio dela. A
[Onda 0c](0c-colapso-de-variantes.md) já ensinou isso do jeito caro: subiu com `tsc`, `eslint` e 247
testes verdes, e o desktop **não abria**.

## Riscos

1. **A capability que vira mentira.** Uma preferência "Motor X11: Xpra" num servidor sem X11 tem de
   falhar visível — pílula de estado com erro, não um botão que não faz nada. É o que a 2.1 já
   ensinou tirando o botão de áudio morto da barra.
2. **Migração silenciosa.** Quem tem sessão Xpra hoje não escolheu nada; a migração tem de nascer
   com o motor ligado, e o default no schema tem de dizer isso. É o mesmo erro que
   `launcherStyle: 'auto'` cometeu — um default que aponta para um conceito que deixou de existir.
3. **O diagnóstico sem motor.** A 2.6 moveu o relatório de problema para a seção Xpra, porque é
   dele que ele é montado hoje. Sem motor X11, o ambiente fica **sem nenhum diagnóstico
   exportável** — ou nasce um relatório do shell, ou a lacuna fica escrita e visível.
4. **O canal que some do orçamento.** Se alguém achar elegante alcançar a sessão por um canal
   `direct-streamlocal` sobre o pool de exec, esta onda **introduz** a versão grande do bug do
   `fs-watch`. Ver a armadilha, acima.
5. **A poda que não acontece.** O maior risco desta onda não é quebrar: é entregar o motor
   instalável e **deixar o caminho antigo vivo ao lado**, porque ele ainda compila e ainda passa nos
   testes. Seriam os 27 arquivos no nosso repositório *e* no pacote, dois caminhos de start, duas
   entregas — que é exatamente o erro que a primeira metade desta inversão deixou aberto e ainda não
   fechou (os dois caminhos de deploy do bundle, `GET /api/shell/config` existindo só para
   diagnosticar qual está servindo).
6. **A fronteira que vira fork.** Levar os 27 arquivos para o pacote só paga se eles pararem de
   receber edição nossa. Se o motor nascer com patches por cima do upstream, trocamos "dívida no
   `vssh-client/`" por "dívida no pacote" — e a atualização à parte, que é o motivo da onda, não
   acontece. A 2.2 já mostrou o custo disso ao tirar 55 linhas nossas de dentro do `Client.js`.

## Como refutar isto

O método da roadmap é explícito: *"conferir não basta, alguém tem de tentar REFUTAR"*, e ao planejar
a Onda 1 **três premissas que pareciam sólidas estavam erradas**. As afirmações abaixo são as que
esta onda apoia e que **ainda não foram verificadas contra o ambiente real**. Cada uma tem como
falhar; cada uma tem como ser checada antes de custar uma semana.

| # | Afirmação | Como refutar |
|---|---|---|
| R1 | ✅ **Conferido, e passa.** O cliente aceita host/porta/caminho arbitrários por query param, e o motor fica no mesmo origin do shell — quatro caminhos relativos precisam de base. Detalhe e sítios em ["Conferido"](#-conferido-2026-08-04-o-cliente-aguenta-ser-servido-de-outro-lugar--com-uma-emenda-de-4-linhas), acima | falta a metade viva: subir o cliente por outro caminho contra uma sessão real e confirmar que os quatro sítios eram **os** quatro. A leitura estática não vê o que só acontece em tempo de execução (um `importScripts` dentro de worker, um `fetch` montado por concatenação) |
| R2 | ✅ **Conferido, e passa.** Fora dos 4 sítios document-relative, todo o resto do grafo (inclusive os `importScripts` dentro dos workers) resolve contra a URL do próprio worker — o `--html` não volta | idem: confirmar contra sessão viva, com a aba de rede aberta, que nada é pedido ao socket do xpra |
| R8 | **O inventário está completo em 26 + cursor** | é a afirmação mais frágil das que sobraram, porque leitura estática não vê caminho montado por concatenação. O teste de Tier 1 responde: com o motor num caminho e a página em outro, **todo** arquivo que faltar aparece como 404 no lugar errado. Rodar até a lista estabilizar |
| R3 | O healthcheck do lifecycle aceita o que um xpra com **`--html=off`** responde | **a pergunta mudou depois do R4**: sem `--html` ele não fica calado, serve o cliente do upstream. Então o pacote passa `--html=off`, e é *esse* `GET /` que precisa ser medido. O poll do portal aceita qualquer coisa que não seja `000`; o `healthcheckPath` do vssh-app é outro caminho de código — conferir os dois |
| R4 | ✅ **Conferido em servidor real, e passa.** `--daemon=no` segura o primeiro plano, e o pid do xpra é o do processo em primeiro plano — `run.pid` e `server.pid` coincidem sob `exec`. Ver ["R4 conferido"](#-r4-conferido-em-servidor-real-2026-08-04-xpra-652-r0-ubuntu-2604), acima | falta o ciclo completo: matar o PID encerra a sessão e limpa `/tmp/.X192-lock`? E o supervisor reinicia sem colidir no D-Bus (ver R9)? |
| R9 | ❌ **Conferido, e REFUTA.** O xpra reapa os auxiliares dele mas **não** os filhos de `--start=`; o diretório de sessão não é removido e o `sh.pid` velho vaza para o reinício seguinte. Ver ["R9 conferido"](#-r9-conferido-e-refuta-o-xpra-não-encerra-os-filhos-de---start), acima | o que falta agora é escolher entre as três saídas e **refutar a escolhida**: com grupo de processos, o `kill -TERM -PGID` mata mesmo tudo? Com entrypoint que trata SIGTERM, quem mata o entrypoint se ele travar? |
| R5 | ✅ **Conferido: cabe, e sobra pouco.** Das 619 linhas, **~29 ficam no portal** — provisionar a conta Linux, o túnel e o `ensureSession`. Ver ["R5 conferido"](#-r5-conferido-o-que-fica-no-portal-são-29-das-619-linhas), adiante | a classificação é por leitura; ela erra se alguma linha "de servidor" depender de root que o `vssh-app-run` (rodando como o usuário) não tem. Conferir uma a uma no `installCommand`: `mkdir` em `/home/$USER` sim, `sudo pkill` não |
| R6 | O `installCommand` dá conta das deps de sistema do Xpra | ele roda como root uma vez, mas num servidor sem repositório de pacote configurado (`VSSH_XPRA_REPO`) isso falha — e falha **na instalação**, que é o lugar certo para falhar. Confirmar que o erro chega à aba admin, e não só ao `run.log` |
| R7 | ✅ **Medido, e passa — e virou teste em vez de número num documento.** `provisioning/xpra.ts` **619 → 103**; zero chamadas a `ensureSshTunnelAsync`; **não há mais caminho de parar**, logo zero `sudo` nele; e `utils/recoll-dbs.js` (300 linhas) foi junto. `tests/unit/motor-x11-poda.test.js` cobra cada um dos nove por nome, com o que ele era escrito na mensagem de falha | nada a conferir depois — mas vale registrar o tropeço: a primeira corrida do teste **reprovou pela própria prosa** que explica o corte (o cabeçalho novo cita "`20000 + uid`" para dizer que morreu). Uma guarda que proíbe uma palavra proíbe explicá-la, e o conserto barato seria apagar a explicação. A guarda passou a desnudar comentários e medir só código |
