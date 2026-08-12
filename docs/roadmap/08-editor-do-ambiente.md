# Onda 9 — O socket vira o endereço, e o VS Code vira nosso

> **Estado:** 🚧 **em execução — o passo 0 fechou; o fork começa agora.** A leitura da fonte do VS
> Code (`microsoft/vscode`, commit `66fe4158`, main de 2026-08-10) e uma sonda no servidor de
> produção vieram **antes** dos itens, e mudaram três deles. **O passo 0 (`0a`–`0d`) está fechado
> nesta onda**, e o que restava do `0d` mudou de dono: virou o [item 5 da Onda 10](09-motor-x11.md),
> porque é lá que ele deixa de ter assunto. · **Atualizado:** 2026-08-10
>
> **Repos:** `vssh-sso` + toolkit + um `vsshapp-vscode` novo
>
> **Depende da [2.7](02b-motores.md)**, que já fechou: ela apagou `/proxy/desktop/` e provou que a
> porta aritmética não é detalhe. **Esta onda termina a frase.** A 2.7 tirou a *aritmética* da porta;
> o passo 0 tira a *porta*. Independente da [Onda 8](07-shell-proprio.md).
>
> **A onda tem duas metades, e a primeira é maior que o pedido que a abriu.** O passo 0 muda como
> **todo** vssh-app é provisionado e não é sobre o VS Code; o resto é o fork.
>
> ### O que a medida disse antes de a onda começar
>
> | A afirmação | O que a medida disse |
> |---|---|
> | "o code-server baixa extensão como generic e deveria ser linux" | **Meia verdade, e a metade errada é a que mudaria o plano.** Ele baixa as duas coisas — `debugpy` veio `linux-x64` e `python` veio `universal`, na mesma conta, no mesmo dia |
> | "virar vssh-app conserta isso" | **Não conserta.** `CURRENT_TARGET_PLATFORM` é constante de módulo, derivada de `isWeb` — vale igual no code-server, no `code serve-web` e no openvscode-server. **Só o fork alcança** |
> | "o seletor de arquivo do editor vira `vssh.pickFile`" | **Errado — foi meu.** `registerSingleton` estático; não há opção de construção |
> | "o hospedeiro injeta comandos nos menus do VS Code" | **Errado — foi meu.** O enum `Menu` tem **dois** valores: paleta e menu do selo de status |
> | "o sequestro de `window.open` é gambiarra" | **Errado — foi meu.** É o **único** ponto de contato que existe para a janela auxiliar |
> | "o app poderia contribuir com o menu de contexto do ambiente" | **Não há onde.** `ContextMenu.js` não tem `register`; todo item é array literal no shell |
> | "ele roda sem contenção" | **Verdade, e agora com número.** `session-705.scope`, sem teto nosso; uma conta sustentando **9,3 GiB**; a mais velha de pé há **6,3 dias** |
> | "o provisionador instala a versão que a gente escolheu" | **Não instala.** Três arquivos fixam `4.126.0`; a máquina roda **4.127.0** |
>
> Quatro delas foram **minhas**, escritas horas antes. É a mesma lição da
> [Onda 8](07-shell-proprio.md): uma frase escrita não é uma medida, e a distância entre as duas não
> aparece sozinha.

---

# Passo 0 — o endereço de um vssh-app deixa de ser uma porta

**Isto não é preparação para o VS Code. É o padrão de provisionamento de todo vssh-app**, e o VS
Code é só o primeiro a nascer nele. Vem primeiro porque é o único item da onda que muda um contrato
da plataforma, e porque tudo o que vem depois fica mais simples com ele pronto.

## Onze lugares sabem a porta, e um deles existe porque dois discordam

Levantado no código, não de memória:

| # | Onde | O que ele sabe |
|---|---|---|
| 1 | `vssh-apps.ts:58-79` | `_allocateAppPort` — varre `ss -tlnp` no servidor e prefere `md5(user:appId)` na faixa 40000–49999 |
| 2 | `vssh-apps.ts:377` | cache Redis `app_port:<id>:<user>:<server>`, TTL de 24 h |
| 3 | `vssh-apps.ts:606` | `~/.vssh-apps/<id>/env`, 0600, escrito **antes** do lançamento |
| 4 | `vssh-apps.ts:279-288` | `/proc/<pid>/environ` — declarado "a fonte de verdade" quando o cache esfria |
| 5 | `vssh-apps.ts:361-368` | `_reconcileAppPort` — **existe porque 2 e 4 discordam** |
| 6 | `vssh-app-run:200-204` | fallback `40000 + (UID % 10000)` quando o portal não passou nada |
| 7 | `vssh-app-run:206` | `/dev/tcp/127.0.0.1/<porta>` — "já tem alguém escutando?" |
| 8 | `vssh-app-supervisor:122` | relê a porta do `env` para relançar |
| 9 | `ssh-tunnel.ts:111,125` | a chave do túnel **é** `<loopback>:<porta>`, e o `-L` espelha **o mesmo número dos dois lados** |
| 10 | `server-register.ts:8-19` | `nextLoopback` — um `127.0.0.x` por servidor, **teto de 254**, e ele existe por causa do espelhamento do item 9 |
| 11 | `circuit-breaker.ts:27` | o disjuntor é indexado por porta |

E o `schema/vssh-app.schema.json:13` põe a frase inteira em uma linha: o `id` *"vira path, **porta** e
sentinel"*.

**O item 5 é o diagnóstico.** `_reconcileAppPort` é código que só existe para reconciliar duas
notações do mesmo fato — exatamente o que a casa proíbe. Ele não é um remendo mal feito: é bem
escrito, tem o comentário certo e resolveu um incidente real. É o **sintoma**, e o defeito é ter dois
lugares guardando o mesmo número.

**E o item 10 é o preço já pago.** O portal aceita no máximo **254 servidores registrados**, e não
por decisão de produto: é porque `-L` copia o número da porta remota para o loopback local, então
dois servidores com um app na mesma porta colidiriam dentro do portal. Um endereço `127.0.0.x`
por servidor é o contorno.

**E é a porta que sustenta o achado de segurança:** **70 portas escutando em `127.0.0.1`** num
servidor com **233 contas com uid ≥ 1000** (medido). O `X-Vssh-App-Token` existe
(`vssh-apps.ts:83-111`, injetado em `proxy.ts:575-577`) e **conferi-lo é opcional para o app**. Com
um VS Code do outro lado, "não conferir" é o terminal do vizinho.

## O socket resolve os onze de uma vez, e por um motivo só

**Um caminho de socket não é alocado — é derivado da identidade.** `~/.vssh-apps/<id>/app.sock` se
calcula dos dois lados a partir de (usuário, appId), não colide com nada por construção, e por isso
não precisa ser descoberto, cacheado, reconciliado nem espelhado.

| Sai | Vira |
|---|---|
| 1 varredura `ss -tlnp` + hash | nada — o caminho é o `id` |
| 2 cache Redis de porta | nada |
| 4 leitura de `/proc/<pid>/environ` para achar a porta | nada |
| 5 `_reconcileAppPort` | **apagado** — não há duas notações para divergirem |
| 6 fallback `40000 + UID % 10000` | nada |
| 7 `/dev/tcp` | `test -S` |
| 9 chave do túnel e espelhamento do `-L` | `ssh -L <socket-local>:<socket-remoto>` |
| 10 `nextLoopback` e o teto de 254 servidores | **apagado** — nada mais espelha número |
| 11 disjuntor por porta | indexado pelo caminho |
| 70 portas alcançáveis por 233 contas | **zero** — o diretório é 0700 |

**Permissão de arquivo faz o que a conferência de token só promete.** O token continua, como defesa
em profundidade; o que muda é que ele deixa de ser a única coisa entre um app e a conta vizinha.

## O desenho, com as três peças medidas

**A ponta do portal fecha sem porta nenhuma.** `http-proxy-3` aceita `target: { socketPath }` —
`common.js:50` copia o campo para as opções da requisição de saída, e `index.d.ts:10` o declara. E o
caminho de **upgrade WebSocket usa o mesmo `setupOutgoing`** (`ws-incoming.js:174`), então o
extension host do VS Code passa por ele sem tratamento à parte. Medido no `node_modules` do repo, não
lido na documentação.

**O caminho é no home, e isso veio de um erro da sonda.** A sonda respondeu `XDG_RUNTIME_DIR` vazio
— artefato de sessão SSH, não do servidor —, e a resposta errada entregou a decisão certa: um socket
não pode morar num diretório que às vezes não existe. `~/.vssh-apps/<id>/` já é criado com `chmod
700` pelo próprio `vssh-app-run:212-215`, em todo caminho de subida. O diretório com o modo certo
já existe.

**Uma fonte, com precedência declarada.** Quem decide o transporte é o `vssh-app-run`, **uma vez**, e
grava o resultado no `env`; portal, supervisor e healthcheck leem de lá. Um portão, não um `if` por
chamador.

```
backend.transport: "socket" | "tcp"     # default "socket"
VSSH_APP_SOCKET=~/.vssh-apps/<id>/app.sock
VSSH_APP_PORT=<n>                        # só quando transport = "tcp"
```

App que só fala TCP declara `"tcp"` e continua exatamente como hoje — inclusive com a porta
alcançável pelo vizinho, que passa a ser **uma escolha escrita no manifesto** em vez do padrão
silencioso. O healthcheck acompanha: `curl --unix-socket` no lugar de `curl http://127.0.0.1:<porta>`
(`vssh-apps.ts:241-252`).

**E o proxy semântico fica inteiro.** Hoje `/proxy/app/<id>/` é um nome que precisa ser traduzido em
número por uma cadeia de cinco lugares. Com o socket, o nome na URL e o nome em disco são a **mesma
identidade**, e a tradução some. É a frase da 2.7 — *"a porta era a identidade"* — dita até o fim.

## O que muda, arquivo por arquivo

Levantado no código antes da medida, porque o inventário não depende da resposta dela — só a
autorização para executá-lo depende.

| Onde | Hoje | Depois |
|---|---|---|
| `schema/vssh-app.schema.json` | `entrypoint` *"deve bindar em `127.0.0.1:$VSSH_APP_PORT`"* | ganha `backend.transport`, e a descrição do `entrypoint` passa a derivar dele |
| `vssh-app-run:199-209` | fallback `40000 + UID%10000` e `/dev/tcp` para ver se já subiu | **decide o transporte uma vez**, exporta `VSSH_APP_SOCKET`, checa com `test -S`, e grava o resultado no `env` — é o portão |
| `vssh-apps.ts:58-79` `_allocateAppPort` | varre `ss -tlnp` e prefere `md5(user:appId)` | não é chamado quando o transporte é socket |
| `vssh-apps.ts:361-368` `_reconcileAppPort` | reconcilia cache × `/proc` | **apagado** para socket: não há duas notações para divergirem |
| `vssh-apps.ts:241-252` `_appHttpCode` | `curl http://127.0.0.1:<porta><path>` | `curl --unix-socket <caminho>` |
| `vssh-apps.ts:606` | o `printf` do `env` escreve `VSSH_APP_PORT` | escreve transporte + endereço |
| `vssh-app-supervisor:122` | `grep '^VSSH_APP_PORT='` no `env` | lê o endereço, qualquer que ele seja |
| `ssh-tunnel.ts:109-133` | `-L <loopback>:<porta>:127.0.0.1:<porta>`, chave `<loopback>:<porta>` | `-L <socket-local>:<socket-remoto>`, e a chave passa a ser o caminho |
| `ssh-tunnel.ts:144-165` `checkPort` | conecta em TCP para saber se o túnel subiu | espera o socket local existir e aceitar conexão |
| `proxy.ts:567,574` | `target: 'http://<host>:<porta>'` | `target: { socketPath }` |
| `proxy/upgrade.ts:83,108,124` | o mesmo, no upgrade WS | o mesmo — `ws-incoming.js:174` compartilha o `setupOutgoing` |
| `circuit-breaker.ts:27` | disjuntor indexado por porta | indexado pelo endereço |
| `routes/apps.ts:334,415,520` | devolve `port` ao cliente junto da URL semântica | `port` só significa algo em `transport: "tcp"` |
| `server-register.ts:8-19` `nextLoopback` | um `127.0.0.x` por servidor, teto de 254 | sai quando nenhum app usar TCP |

**E o inventário achou uma sobra da 2.7, de graça.** `startApp` devolve
`url: '/proxy/${port}/'` (`vssh-apps.ts:688`, e o atalho de `SSH_LOCAL_MODE` em `:476`) — **o proxy
numérico, que a 2.7 apagou**. Hoje aquele endereço dá 404. Não é bug vivo: **ninguém lê esse campo**
— as três rotas montam a URL semântica por conta própria (`routes/apps.ts:334,415,520`). É saída
morta, do tipo que a próxima pessoa copia por parecer oficial. Sai junto, e o mesmo campo em
`code-server.ts:169` sai com o item 3.

## A medida do passo 0 — feita, e ela autoriza

Sonda de leitura em `ipprivm01`, 2026-08-10. As três perguntas que o item exigia responder antes da
primeira linha de código:

| A pergunta | A resposta |
|---|---|
| OpenSSH ≥ 6.7 nas duas pontas (o `direct-streamlocal` existe)? | **10.2p1** no cliente e no sshd — banner `SSH-2.0-OpenSSH_10.2p1`. Folga de onze anos sobre o mínimo |
| O sshd proíbe encaminhamento de socket? | **nenhuma diretiva escrita** em `sshd_config` nem em `sshd_config.d/` → vale o default, que é `AllowStreamLocalForwarding yes` |
| `/home` é NFS? | **não** — `/dev/sdc1`, **ext4** |
| Socket unix no `$HOME` funciona de verdade? | **sim, testado e não deduzido:** o bind criou `srw-------` e `curl --unix-socket` devolveu o corpo |
| O contêiner do portal tem `ssh`? | **sim** — `Dockerfile:24-25` instala `openssh-client` sobre `node:26-slim`. Era esse o risco real; a versão exata ainda quer o `ssh -V` no pod, e nenhum Debian da última década traz abaixo de 6.7 |
| Os runtimes sabem bindar em socket? | os cinco apps instalados são **4 `node` + 1 `binary`** (`xpra`). Os quatro `node` fazem `listen(PORT, '127.0.0.1')` e viram socket em uma linha. O `xpra` **não** — ver abaixo |

> ⚠ **Uma linha da saída é do instrumento, não do servidor.** O `http: 000` da seção P6 é culpa da
> minha sonda: o servidor de teste chama `handle_request()`, que atende **uma** requisição — o
> primeiro `curl` consumiu, o segundo não achou ninguém. A linha que vale é a de cima,
> `curl: socket unix ok`. É o sexto defeito de instrumento desta série, e o segundo que aparece
> antes de custar alguma coisa.

**E a medida entregou um caminho melhor do que o planejado.** O `ssh2@1.17.0`, que o portal já usa,
tem `openssh_forwardOutStreamLocal(socketPath, cb)` (`client.js:1533`) — ou seja, dá para abrir o
canal **na conexão SSH que já existe no pool**, sem `ssh -L`, sem processo de túnel e sem socket
local. Não é o que o passo 0 faz: **fica registrado como o passo seguinte**, porque trocar o
mecanismo de túnel e o transporte do app na mesma mudança é como se esconde qual dos dois quebrou. O
passo 0 usa `ssh -L <socket-local>:<socket-remoto>`, que reaproveita o ciclo de vida de túnel que já
existe e já tem reconexão, dedup e `ExitOnForwardFailure`.

### O xpra é o único que fica em TCP, e isso foi medido com controle

**⚠ Eu tinha escrito que o `binary` "provavelmente nem sabe bindar socket", e isso era presunção
— e ao contrário:** o transporte nativo do xpra **é** socket unix (`~/.xpra/`), e o
`vsshapp-xpra/backend/entrypoint.sh:185` usa `--bind-tcp` só porque o lifecycle só sabia dar porta
(o comentário de `:11` diz isso por extenso). A pergunta certa não era essa; era se ele serve o
cliente HTML5 e aceita upgrade de WebSocket **num bind de socket** — porque é o mesmo bind que
carrega o `--html` (`:186`).

Medido no servidor, com xpra **6.5.2** (a versão de produção — a do archive do Ubuntu é outra, e
responderia sobre outra coisa):

| O mesmo servidor, na mesma execução | HTTP | Corpo |
|---|---|---|
| `--bind-tcp=127.0.0.1:<porta>` | **200** `text/html` | **59.041 bytes** — o cliente HTML5 |
| `--bind=<socket unix>` | **000**, `curl` saiu 7 | nada, em 45 s de espera |

**O controle é o que torna isto uma medida e não um palpite.** Sem o TCP servindo na mesma corrida,
"o socket não respondeu" poderia ser a montagem do teste.

> ### ⚠ E aqui eu escrevi "o `xpra` fica em `transport: tcp`" — estava errado, e o erro era de
> ### pergunta, não de medida
>
> Eu tinha medido **`--bind`**, que é o socket do protocolo NATIVO do xpra: ele não fala HTTP por
> desenho, então "não respondeu a um GET" nunca disse nada sobre o que a onda queria saber. E eu
> tinha lido `/tmp/x.log`, que só tem o preâmbulo do modo daemon — o log de verdade o xpra anuncia
> no boot (`$XDG_RUNTIME_DIR/xpra/<display>/server.log`) e é onde ele **lista os sockets que criou**.
> Duas rodadas medindo a coisa errada com o instrumento errado, e eu ia fechar a decisão com elas.
>
> **A pergunta certa era outra, e ela nem era sobre socket:** *por que o xpra está servindo o nosso
> HTML?* O `--html="${AQUI}/frontend"` aponta para o **nosso próprio diretório** — não é o xpra nos
> dando um cliente, somos nós entregando a nossa pasta e pedindo que ele seja servidor de arquivo
> estático.

Medido de novo, com a pergunta certa:

| O que | Resultado |
|---|---|
| `--bind-tcp` + `--html=off` → `GET /` | **404** — ele fala HTTP, só não tem o que servir |
| `--bind-tcp` + `--html=off` → upgrade WS | **101 Switching Protocols**, `Sec-WebSocket-Protocol: binary` |
| `--bind-ws=<caminho>` | **`xpra initialization error`** — a ajuda diz `[HOST]:[PORT]`, e é só isso mesmo |
| `--bind=<socket unix>` → `connect()` cru | **OK.** Ficou de pé; a um pacote malformado ele **esperou o resto** em vez de fechar |

**Duas conclusões, e elas são independentes:**

1. **O `--html` é separável.** Com ele desligado o WebSocket continua dando 101 — logo servir o
   frontend é papel nosso, e sempre foi. Isso vale por si, e é o que destrava a reforma da janela.
2. **O socket nativo aceita a gente.** O que morreu foi a *ponte burra* (cano de bytes crus do
   upgrade até o socket), porque o listener de WS não aceita caminho. O que fica de pé é a ponte que
   **desembrulha o WebSocket** e escreve o payload no socket nativo — o mesmo protocolo que vai
   dentro dos frames binários. São dezenas de linhas com o `ws`, que o `vssh-sso` já usa.

**Portanto o TCP morre, e a orquestração de porta morre junto** — nenhum app declara `tcp`, e os onze
lugares da tabela lá em cima viram um caminho derivado do `id`. O `transport: "tcp"` continua no
schema como escape declarado para runtime de terceiro, e **o ambiente não usa nenhum**.

**O que falta para virar entrega, e é implementação e não medida:** a ponte precisa completar um
handshake de verdade. `connect()` de pé prova que o transporte está aberto, não que o protocolo
atravessa — e essa é a primeira guarda da **[Onda 10](09-motor-x11.md)**, não uma sonda.

### E o F2 deixou de ser cenário: doze backends de outras contas responderam

Rodado da conta de um usuário comum, contra as portas de **todos** os apps da máquina — `GET /`, sem
token, que é exatamente o que um vizinho mandaria:

| | |
|---|---|
| portas de vssh-app em escuta (40000–49999) | **23** |
| recusaram (`401`/`403`) | **8** |
| **responderam sem token** | **14** — sendo **10 com `200`** e **4 com `500`** |
| destes, de **outras contas Linux** | **12** |

**O `500` não é melhor que o `200`; é pior.** Ele significa que a requisição de um estranho
atravessou o roteamento e chegou a executar lógica do app antes de estourar. Um `403` teria custado
uma comparação de string.

Cinco apps instalados (`hello-world-node`, `logseq`, `print-engine`, `scramjet-wisp`, `xpra`) e 23
portas: o custo é **por usuário**, e a superfície cresce com a base de contas, não com o catálogo.

> A onda dizia que *"a exposição de porta vira onda própria se o F2 mostrar que há mais de um app sem
> gate"*. Ele mostrou **doze portas**, de contas alheias. Não vira onda própria: é o motivo de o
> passo 0 ser passo 0.

## ✅ O que o 0b entregou, e o que a execução cobrou

**O contrato está de pé.** `backend.transport` no schema (padrão `socket`), `lib/node/app-listen.js`
como o portão do lado do app, o portão do transporte no `vssh-app-run` (precedência: ambiente >
manifesto > `socket`), e os cinco manifestos declarando — quatro em `socket`, o xpra em `tcp`, com
prazo. Toolkit em **4.0.0** (tag `v4`); `vssh-client/build-info.json` em **4.1.0**, que é o número
contra o qual o `minShellVersion` é conferido.

**Duas coisas que eu ia construir já existiam**, e as duas com a descrição dizendo o que eu tinha
acabado de raciocinar sozinho: o campo **`minShellVersion`** no schema, e o portão **`podeInstalar()`**
(`utils/versao-de-shell.ts`), usado na listagem e no install. Cheguei a criar um `requires.shell`
para a mesma coisa antes de achá-los — **uma segunda noção do mesmo fato**, removida. A lição não é
sobre este campo: **antes de projetar um mecanismo, procurar se o repositório já o antecipou** — o
comentário de `vssh-shell.ts:57` prometia esse campo desde a Onda 3.

**E a v3 durou uma hora, de propósito.** Ela aceitava `VSSH_APP_PORT` como alternativa, para um app
novo sobreviver num servidor velho. Era band-aid, e o defeito dele é de **tempo**: funcionava,
avisava num `run.log` que ninguém lê, e deixava a porta exposta enquanto isso. A v4 tirou o ramo e
pôs um portão no lugar — o erro passou a aparecer na instalação, onde é barato.

### As três armadilhas que a execução cobrou, e nenhuma era do desenho

| O que | Como apareceu |
|---|---|
| **O verificador que confunde a própria ausência com uma medida** | a checagem de "já está escutando" lia o **código de saída** do `python3`; no Windows ele é um alias da Store que sai **0 sem fazer nada**, e o portão leu aquele 0 como *"o app está de pé"* — **recusando subir um app que nunca subira**. Agora o veredito vem por palavra (`VIVO`/`MORTO`), e a ausência das duas é dita e tratada como livre |
| **A morte em silêncio do `set -euo pipefail`** | `_vivo=$(python3 … \| tr …)` sem `\|\| true` derruba o script inteiro: saída vazia, app não sobe, `run.log` sem uma linha. **O próprio arquivo documenta essa armadilha** alguns blocos abaixo, e eu a reproduzi |
| **A guarda que trava em vez de falhar** | na refutação, a mutação que faz `escutar()` não recusar a segunda instância deixava o segundo servidor escutando, segurando o event loop — o teste pendurava para sempre. Travar e falhar são diagnósticos diferentes, e nenhum CI distingue os dois |

E o arnês de refutação teve o mesmo defeito da primeira: ele mutava com `python3`, que não existe no
`node:26-slim`, **a mutação não acontecia**, o teste passava (claro — a fonte estava intacta) e ele
acusou a **guarda** de não medir, seis vezes seguidas. Hoje ele muta com `node` e **prova com `cmp`
que a fonte mudou** antes de concluir qualquer coisa. Refutação: **6/6**.

### A bancada que ficou obsoleta pelo motivo certo

`servico-com-janela.test.js` guardava *"sem o EnvironmentFile, o mesmo relançamento cairia noutra
porta"*. Estava certo, e **deixou de valer**: com socket não há o que segurar, porque o caminho é
derivado de (HOME, appId). Virou o oposto — *"o socket NÃO depende do EnvironmentFile"* — e ganhou um
terceiro caso guardando que quem declara `tcp` **mantém a fragilidade inteira do modelo antigo**, que
é o preço declarado do xpra.

## ✅ O que o 0c entregou — e o defeito que ele deixou existir por um tempo

**As duas metades ficaram desencontradas, e nada ficou vermelho.** O 0b levou o lado do APP para
socket (o `escutar()` da v4 só binda socket, e o `vssh-app-run` entrega `VSSH_APP_SOCKET`); o lado
do PORTAL continuou alocando porta, tunelando a porta e sondando a porta. Em produção isso apareceu
assim, em **todo app e todo start**:

```
[apps] App 'logseq' na porta 40318 não ficou pronto em 15s (último HTTP 000); abrindo mesmo assim.
[proxy] Porta 40318 indisponível (ECONNRESET) — aguardando túnel SSH reconectar...
```

Cada metade estava correta sozinha, e é por isso que nenhuma suíte acusou: **era o par que mentia**.
A guarda que faltava não é sobre socket nem sobre porta — é sobre as duas pontas concordarem, e é
essa que entrou agora.

**O endereço passou a ter uma fonte e um default só.** `enderecoDoApp()` deriva
`$HOME/.vssh-apps/<id>/app.sock` — o mesmo caminho que o `vssh-app-run` deriva —, com o HOME vindo
do `getent` e não de um palpite `/home/<user>`; e o default de transporte quando o manifesto não
declara nada é `socket` **nos dois lados**, escrito numa função de um nome só.

| O que mudou | Onde |
|---|---|
| a sondagem vai por `curl --unix-socket`, com `sudo -u <dono>` — o socket é 0600, e sem o sudo a falha por PERMISSÃO devolve 000, que se parece com "não subiu" | `_appHttpCode` |
| o `-L` ganhou o lado remoto: local continua porta TCP (é dela que o http-proxy fala), remoto vira o caminho do socket | `ssh-tunnel.ts` |
| o proxy e o upgrade só ganharam a pergunta *"qual é o endereço deste app?"* — o encaminhamento não mudou | `proxy.ts`, `proxy/upgrade.ts` |
| **em socket não existe reconciliar**: procurar "em que porta o processo está de verdade" só faz sentido para endereço ESCOLHIDO. Derivado, se está vivo e não responde, está travado | `_reconcileAppPort` |

### O segundo defeito: quem ABRE o socket

Com o endereço certo, o app servindo e o `run.log` dizendo `transporte: socket`, o proxy ainda via
`ECONNRESET`. **O `-L` é executado pelo usuário de LOGIN do ssh**, e o socket é `srw------- <dono>`:
como provisionador, o `connect()` remoto leva EACCES. O sintoma é indistinguível de "não tem
ninguém escutando" — a mesma tela, a causa oposta.

Com porta isso nunca apareceu **porque loopback não tem dono** — que é exatamente a exposição que
esta onda mediu (14 backends respondendo sem token, 12 de outras contas). Voltar o socket para
`0666` desfaria a onda inteira.

**A saída é o túnel logar como o dono**, e o portal ganha uma chave **própria e por usuário**,
criada sozinha no primeiro app aberto. Ela não é a que a pessoa cadastra na interface — aquela é o
acesso dela, para outra coisa —, e ninguém precisa criar chave à mão para o ambiente abrir um app.
A pública entra numa linha marcada do `authorized_keys`, escrita por **reescrita** (`grep -v` da
marca + append, com `mktemp` no próprio `.ssh` e `mv` atômico), então uma chave regenerada
substitui a anterior em vez de empilhar linha morta.

**Isso não concede nada novo ao portal** — ele já tem `sudo -u <qualquer um>` sem senha, que é
estritamente mais poder. O que muda é ficar **visível**: quem olha o próprio `authorized_keys` vê a
linha e pode apagá-la, e aí o túnel para de subir com "Permission denied", que é falha alta e
legível.

**A chave não vai para banco nem cofre.** Vive num diretório local do processo; se sumir num deploy,
o próximo app aberto gera outra e reescreve a linha. Chave descartável não precisa de cofre — e o
que não se guarda não vaza. (Por isso o cache do Redis só é consultado **depois** de conferir que o
arquivo existe: o cache sobrevive à troca do container e a chave não.)

> **Descartado com motivo:** socket `0660` com grupo compartilhado. Exigiria pôr todo usuário
> provisionado num grupo do portal — um usuário só pode `chgrp` para grupo do qual participa — e
> alargaria o alcance do socket para qualquer processo daquele grupo.

**E o cliente foi a 4.1.1, por honestidade.** A `4.1.0` foi declarada como *"a release em que o
lifecycle passou a entregar o socket"* — e entregava, mas o portal não sabia chegar lá. Um app que
exigisse 4.1.0 instalava e não funcionava.

**Guardas:** três casos novos em `healthcheck-verdadeiro.test.js`, refutação **7/7 + 6/6** — inclusive
devolver o `-L` para `127.0.0.1:<porta>`, trocar o default do transporte para `tcp` e fazer o túnel
voltar a logar como provisionador. A suíte do
`vssh-sso` fica em **1.365 testes, 1.300 passando, 0 falhas**.

### O terceiro defeito: um túnel que se declarava pronto olhando o lado errado

Com o endereço certo, o dono certo e o app servindo, ainda sobrava um sintoma — e ele chegou de
quem usa, na forma mais fácil de descartar: *"tive a impressão de que tive que abrir duas vezes"*.

**Não era impressão, e a medida foi feita num container com sshd de verdade:**

```
ssh -L 45999:/caminho/de/um/socket/que/nao/existe  →  processo VIVO, porta local BINDADA, conexão ACEITA
                                                       e só então: channel 2: open failed: connect failed
```

`ExitOnForwardFailure=yes` **não cobre isso** — ele vale para falha de **bind**, e o bind funciona.
A consequência é a de sempre nesta onda, duas peças certas sozinhas mentindo juntas: o túnel entrava
em `activeTunnels`, e daí em diante o proxy **pulava o `checkAppStatus`**, porque *"existe túnel"*
era lido como *"o app está de pé"*. Todo pedido durante a subida virava ECONNRESET até o disjuntor
agir. A segunda abertura funcionava porque aí o socket já existia.

| A pergunta | socket ausente | socket presente |
|---|---|---|
| **nova** — o alvo sobrevive a uma graça de 250 ms? | `false` | `true` |
| **antiga** — a porta local bindou? | `true` ← o defeito | `true` |

A mesma medida deu a outra metade, e ela decidiu o conserto: **quando o socket nasce depois, o MESMO
túnel passa a funcionar**. Então a espera é por o outro lado aparecer, e não derrubar e recriar.

**E desistir agora MATA o `ssh`.** Antes, desistir deixava um forward vivo com canal morto de pé e
registrado no mapa — o defeito montado, permanente, para todo pedido seguinte.

**A conferência cara é só de socket.** Ela custa a graça inteira por tentativa; ligá-la em endereço
de porta tornaria todo túnel do ambiente mais lento (SSH do usuário, OnlyOffice, app em `tcp`) por
um defeito que só existe em socket. Em porta, aceitar continua sendo resposta.

**Guarda:** `tests/unit/tunel-pronto.test.js`, **4 casos**, refutação **6/6** — inclusive a mutação
que restaura o defeito original (*aceitar a conexão volta a bastar*).

## ✅ O 0d saiu pela metade — e a outra metade mudou de onda

**A metade que não dependia de ninguém:** a porta do túnel era escolhida **no servidor**, por um
`ss -tlnp` remoto, porque era lá que o backend ia bindar. Com socket unix o backend não binda porta
nenhuma — **o único lugar onde esse número existe é a ponta local do `-L`**. Continuar perguntando
ao servidor é pagar uma ida de SSH por app para medir a coisa errada, e "medir a coisa errada" é
como um número certo por acaso vira uma resposta em que todo mundo confia.

Agora `alocarPortaLocal()` decide aqui: honra a preferida do hash quando ela está livre, varre a
faixa quando não está (duas contas podem preferir a mesma porta, e o portal é um só), e **falha alto
quando a faixa acaba** em vez de devolver uma porta ocupada. Só `transport: "tcp"` ainda pergunta ao
servidor — e é dele que trata a outra metade.

**Guarda:** mais **4 casos** em `tunel-pronto.test.js`, refutação **5/5**. Suíte do `vssh-sso`:
**1.375 testes, 1.310 passando, 0 falhas**.

**A outra metade mudou de onda, e não por conveniência.** Os onze lugares, o `nextLoopback` e o teto
de 254 servidores não são trabalho esperando prioridade: **eles existem hoje para servir um app só**,
o xpra, e enquanto ele declarar `tcp` apagá-los quebra o ambiente. Quem os deixa sem assunto é o
item 2 da [Onda 10](09-motor-x11.md) — então o resto do 0d é **o item 5 de lá**, ao lado da medida
que o autoriza, em vez de ficar aqui marcado como bloqueado para sempre.

## As duas guardas

**`tests/unit/app-sem-porta.test.js`** — com `transport: "socket"`, o app serve HTTP **e** WebSocket
pelo proxy, e `ss -tln` no servidor **não** mostra porta nenhuma dele. Refuta: devolver o app para
TCP; o teste tem de ficar vermelho pelas duas metades, não só pela do HTTP.

**`tests/porta-do-vizinho.test.js` (F2)** — **já rodado uma vez à mão, e o resultado está acima:
14 de 23 responderam sem token.** O que falta é ele virar teste que roda sozinho: de uma segunda
conta Linux, `curl` na porta esperando 401/403 e `curl --unix-socket` esperando `EACCES`. O valor
dele não acaba com o passo 0 — enquanto existir `transport: "tcp"`, ele é a única coisa que mede se
aquela escolha continua sendo defensável.

**E um portão na entrega (F3):** `vssh-app-install` recusa manifesto que declare `transport: "tcp"`
sem `requiresToken: true`. Declaração sozinha não impõe nada — **só vale casada com o F2**.

~~F4 — bindar num endereço não compartilhado~~ — **descartado com motivo**: o loopback é compartilhado
por definição; isolar exigiria network namespace por usuário, e quebra o `ssh -L`.

---

# O que a fonte do VS Code decidiu

Clone raso de `microsoft/vscode` no commit `66fe41585b0491e707b316b5ba0473bff73412bd`. Todas as
linhas abaixo são desse commit. Esta seção não pergunta se o fork vale — ela diz **o que o fork tem
de tocar**.

## A linha que obriga o fork

```ts
// src/vs/platform/extensionManagement/common/extensionGalleryService.ts:35
const CURRENT_TARGET_PLATFORM = isWeb ? TargetPlatform.WEB : getTargetPlatform(platform, arch);
```

Constante de módulo. Em qualquer workbench servido no navegador ela vale `web`, e a listagem da
galeria a usa sem escapatória (`:1153`), porque `IQueryOptions` **não tem campo `targetPlatform`**
(`extensionManagement.ts:323-332`).

**E existe um segundo caminho, que responde outra coisa.** A instalação pelo servidor remoto
re-resolve com a plataforma real: `extensionManagementIpc.ts:254` pergunta ao servidor por IPC, e
`abstractExtensionManagementService.ts:751` refaz a consulta com `{ targetPlatform, compatible: true }`.
Isso é `linux-x64`.

> **Duas resoluções de plataforma no mesmo produto, e elas discordam.** O dano estava visível no `ps`
> do servidor: a conta com `debugpy` em `linux-x64` roda o binário `pet`; a com `python` em
> `universal` cai no `run-jedi-language-server.py`.

## O que vem do embedder, e o que exige patch

Um embedder é o hospedeiro servindo a própria página e chamando `create()` com um
`IWorkbenchConstructionOptions`. É o que o github.dev usa. Vem de graça:

| Superfície | Onde | O que dá |
|---|---|---|
| `commands.executeCommand(cmd, …args)` | `web.api.ts:31-41` | Executa **qualquer** comando do editor, de fora. Apaga as 180 linhas de socket IPC de `code-server.ts:532-712` |
| `IWorkspaceProvider.open(ws, { reuse, payload })` | `web.api.ts:412-442` | O funil **único** de abrir pasta/workspace/janela vazia (`browserHostService.ts:486-508`) |
| `productConfiguration` | `web.api.ts:360` → `web.main.ts:289` | A galeria, o nome, a versão — entra por `mixin` |
| `initialColorTheme`, `configurationDefaults`, `defaultLayout` | `web.api.ts:310-374` | Tema `tuff` e layout por contrato |
| `secretStorageProvider` | `web.api.ts:246` | O cofre do app vira o cofre do editor |
| `resolveExternalUri`, `openerAllowedExternalUrlPrefixes` | `web.api.ts:192,285` | Link clicado abre no navegador embutido |
| `serverBasePath`, `webSocketFactory`, `resourceUriProvider` | `web.api.ts:164-187` | **O prefixo do proxy deixa de ser problema** |
| `additionalBuiltinExtensions` | `web.api.ts:248-254` | Aceita *"location of the extension where it is hosted"*: uma extensão VSSH servida pelo backend do app, embutida e não desinstalável |

E **não** vem — cada linha aqui é um patch do fork ou uma promessa que não se faz:

| Queria | Por que não dá | Linha |
|---|---|---|
| a plataforma certa | constante de módulo | `extensionGalleryService.ts:35` |
| trocar o seletor de arquivo | `registerSingleton` no import | `fileDialogService.ts:279` |
| trocar o renderizador do menu de contexto | idem, no bundle | `workbench.web.main.ts:113` |
| ler a árvore do menubar por API | `IMenuService` não é exposto; o handler recebe os argumentos **mas não o `accessor`**, *"to reduce our exposure of internal API"* | `web.factory.ts:45-48` |
| pôr comando num menu qualquer | `asMenuId` aceita **dois**: `CommandPalette` e `StatusBarWindowIndicatorMenu` | `web.factory.ts:76-81` |
| controlar a janela auxiliar | `mainWindow.open('about:blank', …)`, sem serviço substituível | `auxiliaryWindowService.ts:385` |

**A barra dupla tem resposta, e não é a que eu esperava.** `window.customTitleBarVisibility` é
**ignorado no web** — o bloco que o lê está dentro de um `if (!isWeb)` (`layoutService.ts:633`). O
caminho é esvaziar a barra por `configurationDefaults` (`window.commandCenter: false`,
`workbench.layoutControl.enabled: false`, `window.menuBarVisibility: "compact"`), e aí
`isTitleBarEmpty` vira verdadeiro e a parte some (`layoutService.ts:640,665,681-707`). **O menubar
não vai junto**: em `compact` ele migra para a activity bar (`activitybarPart.ts:452`) — e `compact`
já é o padrão do web (`workbench.contribution.ts:887`).

**A regra que limita os patches** já estava escrita neste repositório, em `docs/porting.md:169-171`:
*"patch para integrar com o ambiente, nunca para substituir o que o ambiente já oferece"*. Todo patch
desta onda **informa** ao VS Code algo que o ambiente já sabe — em que plataforma ele está, onde fica
a galeria, quem desenha o menu. Nenhum troca uma camada que o VS Code já tem por uma nossa. O que
derrubaria o desenho é a lista crescer para além disso.

---

# O plano do fork

## 1. ✅ O pacote `vsshapp-vscode` — **feito**, e a instalação real cobrou o que nenhuma bancada via

Repositório novo, no molde do `vsshapp-xpra`. `id: "vscode"`, `type: "app"`, `backend.transport:
"socket"` — o primeiro app a nascer no padrão do passo 0 — e **`kind: "app"`, não `"service"`**:
`service` liga start automático e auto-reinício com `MAX_FAILS=5` **sem reset por tempo**; um
workbench que ninguém abriu não deve consumir RAM, e um que caiu cinco vezes num mês não deve ficar
`failed` para sempre.

**A entrega estava decidida pelo número, e o número saiu como o desenho previa.** 617 MB não passam
por `git archive` + POST único, e o GitHub recusa arquivo acima de 100 MB. O caminho é o
`installCommand`, e ele funciona porque no install como root o `cwd` é `${WORKDIR}/pkg` — um
`mktemp -d` **gravável** (`vssh-app-install:335`) — e o passo seguinte é `rsync -a --delete` para
`/opt/vssh-apps/<id>/` (`:348`). Medido no que está publicado hoje:

| O quê | Tamanho | Onde mora |
|---|---|---|
| o pacote `vscode` **0.1.15** (`git archive` + POST) | **32.646 bytes** | índice do `vssh-repo` |
| o motor `1.132.0-local202608111558` (o build do fork) | **285.332.099 bytes — 272,1 MiB** | R2, baixado pelo `installCommand` |

**O pacote é 0,011% do que ele entrega**, e é essa razão que faz o modelo funcionar sem tocar no
`vssh-app-publish`: o que o `git archive` leva é o *roteiro*, não o produto.

**O motor virou uma espécie de artefato, e não um app disfarçado.** O `vssh-repo` ganhou `kind:
"motor"` porque app e motor têm ciclos diferentes — 0.1.15 do pacote contra um motor que só muda
quando o fork recompila — e porque o assimétrico do Worker obriga: 128 MB de teto de memória
impedem bufferizar 272 MiB na subida, mas `blobResponse(obj.body)` **transmite** a descida sem
carregar nada. Então a subida vai direto ao R2 (S3 multipart, token com escopo de **um** bucket) e o
registro no Worker é **só metadado**, conferindo `head()` e tamanho.

As três regras do comando, cada uma paga por outro app, e o que cada uma custou aqui:

- **Idempotente e guardado**, porque ele roda de novo **por usuário** no primeiro `vssh-app-run`
  (`:219-227`), com `cwd` em `/opt/vssh-apps/<id>`, que é **somente leitura**. A fase por usuário não
  baixa nada: ela confere, e **falha alto nomeando o conserto** se a fase root não aconteceu.
- **Versão fixada e `sha256sum` conferido** no próprio comando, **antes de extrair** — um tarball
  trocado no caminho não chega a escrever arquivo no destino. É o conserto do achado do
  provisionador: três arquivos diziam `4.126.0` e a máquina rodava `4.127.0`. Aqui a versão está em
  **um** arquivo, `backend/motor.env`, que o `install.sh`, o `server.js` e a guarda leem.
- **`resources` declarado**, e não o padrão. 85% de 79 GB são 67 GB: não é teto, é decoração.
  ⚠ **Mas o que está declarado — `memoryHigh: 3G`, `memoryMax: 6G` — não é medida, é ponto de
  partida**, e a frase anterior deste item dava a entender o contrário. Os 9,3 GiB medidos são de uma
  **sessão inteira** (`session-705.scope`), não do editor; o número do editor sozinho ainda não
  existe, e vem da primeira sessão real.

### O build saiu na minha máquina, e o CI ainda não fez um verde

**Nove tentativas no CI, nenhuma completa.** As causas, na ordem em que apareceram, porque cada uma é
um achado: `setup-node` com arquivo fora do workspace; **o mangler do próprio upstream** reprovando
um `-min` (e ele reproduz na *tag de release*, não só num `main` de um dia ruim); heap de 8 GB num
runner de 7,9 GB; nomes de task de gulp copiados de outra versão; **o nosso patch de galeria
redirecionando o fetch de extensões embutidas do próprio build**, que confere sha256 gravado de
artefatos do GitHub; a minha limpeza de disco apagando o toolcache com o Node 24 dentro; e o portão
de não-ASCII do upstream (`optimize.ts:253`) reprovando **regexes do código deles**, que o `charset`
do esbuild não reescreve.

Daí o `scripts/build-local.sh`: o mesmo build, num container que **fica de pé**. Cada tentativa no CI
repetia `npm ci` + compile inteiro para chegar ao passo que falhava, ~25 min cada. **Ele não é uma
segunda definição do build** — e essa regra teve de virar código **duas vezes**, as duas com o aviso
já escrito no cabeçalho do arquivo:

1. o `motor.yml` trocou de alvo, o `build-local.sh` ficou no `-min`, e a execução seguinte morreu num
   erro que já estava resolvido. O alvo passou a ser **lido** do workflow;
2. **a extensão embutida do Copilot**, que derrubou a tarefa em **três builds** com
   *"Copilot SDK directory not found"* — com a fonte intacta e o bundle já pronto, o patch
   conferido dentro dele. E cujo diagnóstico eu **errei duas vezes**, cada uma registrada aqui
   como se fosse o conserto.

   ⚠ **Primeiro eu disse que o produto da vez anterior era estado consumido pelo passo.** Mandei o
   `compilar()` apagar a saída, escrevi guarda, registrei como resolvido. Com a saída limpa, falhou
   no mesmo lugar.

   ⚠ **Depois eu disse que era o cache `.build/extensions`, consumido pelo build.** Mandei limpá-lo
   também, escrevi guarda de novo, registrei de novo. Com tudo limpo por regra, falhou de novo — e
   a medida do estado limpo é definitiva: **37 arquivos em `@github/copilot/sdk` na fonte, 0 em
   `.build/extensions`**. O cache nunca teve aqueles arquivos para perder.

   **A causa é de empacotamento, e estava na fonte o tempo todo.** `copilot` está em
   `excludedExtensions` (`build/lib/extensions.ts:319`), então a esteira normal o pula; um caminho
   separado, declarado *"para builds locais não-CI, onde o copilot não é baixado como VSIX"*,
   produz `dist/` e **não carrega** o `node_modules/@github/copilot/sdk`. O
   `prepareBuiltInCopilotRipgrepShim` cobra exatamente esse diretório. Um passo pedindo o que o
   anterior não entrega, numa configuração que o upstream monta de outro jeito — e por isso o CI
   dele nunca vê.

   **O conserto foi de produto, e é do dono do produto:** a extensão embutida do GitHub Copilot
   **sai do build** (patch `0007`). Este é um fork OSS cuja galeria aponta para o Open VSX;
   embutir um produto Microsoft/GitHub num build que assinamos e distribuímos é outra promessa.
   Quem quiser Copilot instala pela galeria, como qualquer extensão.

   E ele teve **duas metades**, o que quase me escapou: tirar o *passo* deixava o *diretório* na
   saída — meio empacotado, e o VS Code carrega toda pasta sob `extensions/` como embutida. Seria
   entregar a extensão num estado pior que o original. A segunda metade entrou onde a frase já
   existia: a lista `// Do not ship the test extensions` (`gulpfile.reh.ts:380`).

   **O que sobrou de verdadeiro nos dois palpites errados**, e fica: a saída anterior é estado e
   não ponto de partida, e o `.build/extensions` é um **cache sem chave** — não se invalida quando
   a fonte das extensões ou os `node_modules` mudam, e um cache assim dá verde sobre entrada
   velha. Limpar os dois custa **nada**, medido: 7,67 min limpo contra 8,48 min com cache. É
   higiene, e a guarda que a protege agora diz isso — em vez de dizer que era o conserto.

### O que a instalação real cobrou — e as bancadas mediam a bancada

Primeira instalação de verdade, em `ipprivm01`, e ela abortou:

```
==> motor 1.132.0-local202608111558 instalado em vendor/motor
==> npm ci
npm ERR! code EUSAGE
ERRO: installCommand falhou como root (código 1). Instalação ABORTADA
```

**O pacote não levava `package-lock.json`.** E os cinco casos de instalação passavam verdes porque a
bancada monta um pacote de teste **com `package.json` e lock próprios** — ela media o `install.sh`
contra um projeto npm que ela mesma criava. É a assinatura que esta casa já registrou noutro eixo: a
guarda media a bancada, não o produto, e ficava verde justamente enquanto a instalação real não
existia.

O caso novo nasceu vermelho, e por um motivo mais fino que "faltava o arquivo": **o lock existia no
disco e não estava versionado**, e o que o publish empacota é `git archive`, que só vê o versionado.
Por isso o caso cobra as três coisas juntas — existe, está em `git ls-files`, e **resolve o
`vssh-app-toolkit`** (um lock que não resolve a dependência deixa o `npm ci` instalar nada e o
backend morre no primeiro `require`).

Com o `0.1.15`, a instalação foi ao fim:

```
[vssh-app-install] Baixando vscode@0.1.15 do repositório...
==> baixando o motor do editor 1.132.0-local202608111558
100 272.1M  100 272.1M   0  0  7.90M  0  00:34  00:34  --:--:--  7.43M
==> motor 1.132.0-local202608111558 instalado em vendor/motor
==> npm ci
added 1 package, and audited 2 packages in 690ms
[vssh-app-install] 'vscode' instalado em /opt/vssh-apps/vscode.
```

**272,1 MiB em 34 s (7,90 MB/s médio), sha256 conferido, `npm ci` em 690 ms.** O caminho inteiro —
build do fork → R2 → registro → download público sem token → `sha256sum -c` no servidor — mediu
certo de ponta a ponta.

**Guarda:** `tests/instalacao-idempotente.test.js`, **11 casos, refutação 11/11**. Os cinco primeiros
rodam o `installCommand` de verdade contra um servidor HTTP que **conta requisições**; os seis
seguintes são de fonte, e existem porque cada um já foi um defeito real: o nome do binário que o
`install.sh` confere ≠ o que o `server.js` executa; o `motor.env` sem um dos quatro campos; um patch
com caractere não-ASCII; **um byte de controle num workflow** (uma vez o GitHub respondeu que o
`motor.yml` *"não tem gatilho `workflow_dispatch`"* quando o defeito era um `ESC` num comentário);
alvo do gulp divergindo entre local e CI; e o lock ausente.

## 2. 📋 O workbench é nosso, e o motor é o servidor do VS Code

O extension host continua sendo o servidor do VS Code, agora em socket unix (passo 0).

### ⚠ Dos sete provedores prometidos, a medida derrubou dois — e um deles por bom motivo

Este item listava sete entradas do embedder como se as sete fossem alcançáveis. **Duas não são**, e
descobrir isso custou uma leitura da ponte, não um build:

| O que estava escrito | O que a medida disse |
|---|---|
| `workspaceProvider` → janelas do VSSH | ✅ **alcançável hoje.** `vssh.window.abrir(rota)` abre outra janela **deste app** — mesmo backend, mesmo token, mesmo `VSSH_APP_DATA_DIR` — e a pasta viaja na rota |
| `initialColorTheme` + `configurationDefaults` | ✅ **e sem patch** — são dado, entram pela `<meta>` |
| `productConfiguration.extensionsGallery` | ✅ já vai no `product.json` do artefato |
| `serverBasePath` / o prefixo | ✅ resolvido pelo header (item 2c) |
| ~~`secretStorageProvider` → o cofre~~ | ❌ **a ponte não pode, por decisão de projeto** — e o padrão já é melhor |
| ~~`resolveExternalUri` → navegador embutido~~ | ❌ **não existe op na ponte** que abra uma URL |

**O cofre não é esquecimento, é desenho — e ele está certo.** O `VsshAppWindow.js:510-512` diz por
extenso: *"O app nunca toca no valor: ele não manda e não recebe. […] Um app que pudesse ler o
próprio segredo pela ponte teria uma porta de leitura que o cofre não tem."* O `vssh.secrets` tem
`list` (só nomes), `set` (o **shell** mostra o campo) e `remove`. Não tem `get`, de propósito. Um
`ISecretStorageProvider` precisa de `get(key)` devolvendo o valor — então ligá-los exigiria abrir no
cofre exatamente a porta que ele foi feito para não ter.

**E o que já acontece é melhor do que o que eu ia fazer.** Com `remoteAuthority` presente e sem o
cookie `vscode-secret-key-path`, o embedder de referência deixa `secretStorageProvider` como
`undefined` — e o próprio upstream comenta: *"with a remote without embedder-preferred storage,
store on the remote"*. Ou seja, o segredo já mora **no servidor, na conta Linux da pessoa**, e não
no `localStorage` do navegador. A ação certa aqui é **nenhuma**, e ficar escrito por quê.

**O navegador embutido não tem porta.** A ponte tem 17 ops (`notify`, `dialog`, `pick`, `fs`,
`grants`, `capabilities`, `print`, `audio-state`, `clipboard`, `tray`, `title`, `secrets`, `window`,
`context-menu`, `open-file`, `open-folder`, `open-with`) e **nenhuma abre uma URL**. `openFile` é
caminho de arquivo, não endereço. Fazer isso não é um patch no fork: é uma capacidade nova da
plataforma — op no `VsshAppWindow`, função no shim, versão do toolkit e `minShellVersion`. **Fica
como item próprio**, e não escondido dentro deste.

### A divisão que sobrou, e ela é limpa

| Metade | Como chega | Custo de mudar |
|---|---|---|
| `windowIndicator`, `initialColorTheme`, `configurationDefaults` | JSON na `<meta>`, reescrito pelo `backend/pagina.js` | **restart do app** |
| `workspaceProvider` | patch `0004-janela-do-ambiente.patch` | ~25 min de build |

**O que a reescrita da página entrega, e é o item 2b junto:**

⚠ **Aqui estava escrito `window.customTitleBarVisibility: 'never'` — "a barra de título do VS Code
**sai**, porque a janela já tem uma, a do ambiente". Isso está errado, e o conserto inverteu o
sentido do item.** Quem sai é a **nossa**: o valor é `'auto'`, a barra do VS Code fica, e ela passa a
ser a barra da janela — o arranjo do Electron, e o que o usuário pediu com uma frase que desmontou um
desenho meu bem maior: *"tudo que eu quero é colocar os botões de abrir fechar e minizar nela, e
ocultar a nossa padrão"*. Duas barras empilhadas continuam sendo o defeito; some a de fora, não a de
dentro. Ver **2d**, abaixo.

Com ela vão `window.commandCenter` (duplicava a barra do ambiente), `update.mode: 'none'` (não há
servidor de atualização para um build OSS nosso — deixar ligado é prometer uma verificação que não
existe) e `telemetry.telemetryLevel: 'off'`.

⚠ **A paleta do `tuff` NÃO entra ainda.** `initialColorTheme.colors` aceita ids de cor do workbench,
e escrever uma paleta que eu não medi seria inventar. Vai só o **tipo** — escuro —, que é verdade e
já mata o flash branco no boot. A paleta é passo próprio, com a medida das cores do shell.

### O patch só ACRESCENTA, e isso é o contrato

`WorkspaceProvider.open()` continua inteiro: o ramo `reuse` navega a página, e o ramo do navegador
(`mainWindow.open`) **fica**. O nosso é um desvio antes dele, condicionado a a ponte existir — fora
do ambiente, o editor abre e funciona como sempre, que é também como ele se desenvolve. A guarda
cobra isso pelo diff: **nenhuma linha removida**.

⚠ E o primeiro caso dessa guarda estava errado: ele procurava `mainWindow.open(targetHref)` no patch
para provar que o caminho do upstream continuava lá — e media a **janela de contexto do diff**, três
linhas, não a fonte. Ficou vermelho sem defeito nenhum. "Nenhuma linha removida" é a mesma pergunta,
respondida por algo que o diff de fato garante.

### ⚠ "O backend do app serve **a nossa página**" — medi o build, e essa frase não se sustenta

Este item dizia que o backend serviria uma página nossa, chamando `create()`. **Com o alvo que o
motor é (`vscode-reh-web-linux-x64`), isso não é alcançável**, e a medida é do artefato construído,
não da fonte:

| O que eu esperava achar | O que o build tem |
|---|---|
| `out/vs/workbench/workbench.web.main.js`, exportando `create` para um hospedeiro | **não existe.** `out/vs/workbench/` só tem `api/`, `contrib/`, `services/` |
| um bundle importável pela nossa página | **um bundle só** — `out/vs/code/browser/workbench/workbench.js`, **35.494.883 bytes (33,8 MiB)** —, e o seu ponto de entrada **é o embedder de referência**: um IIFE que lê o `<meta id="vscode-workbench-web-configuration">`, monta as opções e chama `create()` sozinho (`workbench.ts:603-628`) |

`create` só é exportado de `workbench.web.main.internal.js`, que este alvo **empacota e não expõe**.
Servir uma página nossa contra este build daria a mesma página, sem chamada nossa nenhuma.

**E o que a página do upstream realmente é, lida no artefato, muda o desenho para melhor.** O
`workbench.html` servido tem **uma** variável de caminho, `{{WORKBENCH_WEB_BASE_URL}}`, usada nas
seis URLs que ele emite (ícone, manifest, CSS, NLS ×2, o bundle) e num
`new URL(…, window.location.origin)` que define o `_VSCODE_FILE_ROOT`. Essa variável é o
`staticRoute` de `webClientServer.ts:341`, montado sobre o `basePath` de `:268` —
`getFirstHeader('x-forwarded-prefix') || this._basePath`. **Um header resolve o prefixo inteiro**, o
que confirma com o HTML na mão a correção que já estava escrita no `backend/motor.env`.

**Então o item 2 muda de forma, e não de objetivo.** A separação é entre o que é *dado* e o que é
*função*:

| Metade | Como chega | Onde mora |
|---|---|---|
| `productConfiguration` (a galeria), `initialColorTheme`, `configurationDefaults`, `windowIndicator`, `defaultLayout` | **JSON no `data-settings` da `<meta>`**, reescrito pelo nosso backend a cada requisição | não precisa de patch — e por isso muda **sem recompilar o motor** |
| `workspaceProvider`, `secretStorageProvider`, `resolveExternalUri`, `urlCallbackProvider`, `commands[].handler` | **funções**, que não atravessam JSON | patch em `workbench.ts`, no fork — a única costura que existe |

O desenho que sai disso: o patch põe os provedores, e eles **leem a sua configuração de um campo
`vssh` que o backend injeta na mesma `<meta>`** — serverId, prefixo, tema, token. Assim o que muda
por sessão é dado, e só comportamento novo custa os ~25 min de rebuild. É a mesma regra do
`motor.env` aplicada ao runtime: um lugar declara, todos leem.

### ✅ 2c. O portal conta ao app o prefixo público — **feito**, e vale para todo vssh-app

A primeira metade já está de pé, e ela é de plataforma, não do editor. `VSSH_APP_BASE_PATH` chega ao
processo como `/proxy/app/<id>/`, **sem o serverId**; a URL pública tem o serverId. **Falta ao
backend exatamente o pedaço que só quem proxia conhece** — e a resposta que a casa dava até aqui
("use `fetch` relativo") vale para código nosso e não vale para um motor de terceiro que emite as
URLs dele.

O portal passou a mandar `X-Forwarded-Prefix: /<serverId>/proxy/app/<id>` em toda requisição de app.
Duas decisões dentro disso, e as duas com motivo:

- **Vai para todo app, não só para o `vscode`.** O header é padrão de fato (nginx, traefik, Spring),
  então não é dialeto nosso; e um `if` por app id seria o começo de N caminhos. Quem não lê não é
  afetado — varredura: zero leituras nos apps de hoje.
- **É uma função, `prefixoPublicoDoApp()`, e não um template no meio da rota.** O invariante que
  importa não é o formato do header: é que **o pedaço cortado e o pedaço anunciado sejam o mesmo**.
  O corte acontece numa expressão e o anúncio noutra; divergirem dá 404 em asset, longe da causa.
  A função também recusa valor que não pode virar header — `appId` vem de segmento de URL, e CR/LF
  ali seria injeção de cabeçalho.

**Guarda:** `tests/unit/prefixo-do-app.test.js`, **12 casos, refutação 12/12**. O caso central recompõe
`prefixo + restante` e exige a URL pública de volta. ⚠ **E a primeira rodada de refutação não valia:**
o `git checkout` restaurava dois caminhos e falhava inteiro por causa do arquivo de teste ainda não
versionado, então as mutações **se acumulavam** e todo caso ficava vermelho por um motivo que não era
o dele. O roteiro agora **confere o restauro** (`git diff --quiet`) e aborta se ele não aconteceu —
uma bancada de refutação que não restaura mede a si mesma, que é o defeito que ela existe para pegar.

### A primeira abertura real do editor — o que ela provou, e o defeito que só ela mostrava

**A página carregou inteira.** Os assets vieram todos por
`https://vssh.colabh.org/ipprivm01/proxy/app/vscode/oss-<commit>/static/out/…`, o que fecha o
argumento do prefixo com a medida em vez do raciocínio. E o backend mediu o caminho todo:

| | |
|---|---|
| o app bindou o `app.sock` | `16:21:29.210` |
| o motor bindou o socket dele | **200 ms depois** |
| `Extension host agent started` | no mesmo instante |

Nenhuma porta TCP em lugar nenhum, nas duas pontas.

**E então o WebSocket morreu na construção — não na conexão, na construção:**

```
SyntaxError: Failed to construct 'WebSocket': The URL
'wss://[vssh.colabh.org:443,80]:443/ipprivm01/proxy/app/vscode/oss-df53daab…' is invalid.
```

Cinco tentativas até *"It will be treated as a permanent error"*, e um editor **sem extension host**:
sem terminal, sem linguagem, sem filesystem remoto. O `remoteAuthority` era
`vssh.colabh.org:443,80`.

**A causa é uma cadeia entregue a quem precisa de um endereço.** `xfwd: true` do `http-proxy-3`
**acrescenta** ao que já veio (`web-incoming.js:82-83`), e antes do portal a requisição já passou
pelo Cloudflare: o app recebeu `x-forwarded-port: 443,80`. Uma cadeia não é errada por si — ela
descreve o caminho percorrido. Errado é entregá-la a quem precisa de **um** valor, e quem sabe qual é
o endereço público é o portal, que é o último salto antes do app. Mesmo argumento do prefixo, mesmo
lugar, mesma abrangência: vale para todo vssh-app.

**A metade que não se vê são as chaves em minúscula.** O `http-proxy-3` copia `req.headers` (que o
Node entrega em minúscula) e só depois faz `{...outgoing.headers, ...options.headers}`
(`common.js:76-77`). Uma chave `X-Forwarded-Port` **não substitui** `x-forwarded-port`: cria uma
segunda, e o cliente HTTP manda as duas — recriando exatamente a cadeia que o conserto desfaz. Há um
caso só para isso, e ele fica vermelho se alguém "arrumar" a capitalização.

⚠ **E há um segundo defeito, do upstream, registrado e não consertado.** O `getFirstHeader` de
`webClientServer.ts:262-265` só desempacota quando o valor é **array** — e o Node junta cabeçalhos
repetidos numa **string** com vírgula, caso em que a função devolve a lista inteira. É um `first` que
não é o primeiro. Consertar lá custa recompilar o motor e não ajuda mais nenhum app; o portão fica no
portal, e isto fica escrito para quem for ler o `webClientServer` acreditando no nome da função.

**O que o caso central da guarda mede não é "não tem vírgula".** Ele monta o `remoteAuthority` do
jeito que o motor monta e exige que o construtor de `URL` do navegador **aceite** — o sintoma que se
mede, e não o sintoma que se descreve.

**Em aberto, e é hipótese:** quatro extensões embutidas (`emmet`, `github-authentication`,
`git-base`, `merge-conflict`) falharam ao ativar com `File not found: …/dist/browser/…`. Conferido no
artefato: elas têm `dist/node` e **não** têm `dist/browser`, porque quem produz os pacotes de
navegador é o `compile-web-extensions-build` do alvo `vscode-web`, que não construímos. **A hipótese
é que isso se resolva sozinho** quando o WebSocket subir, porque aí existe o extension host **remoto**
(node) e é nele que essas extensões rodam. Só a próxima abertura diz — e por isso não há rebuild do
motor marcado por causa disto.

### ✅ O editor subiu — e a hipótese das extensões estava certa

Segunda abertura, com o portal já no conserto do endereço:

```
INFO Resolving connection token (vssh.colabh.org:443)...
INFO Creating a socket (renderer-Management-1a42e1f7…) was successful after 267 ms.
INFO Creating a socket (renderer-ExtensionHost-02fef832…) was successful after 209 ms.
[ManagementConnection] New connection established.
[ExtensionHostConnection] <3849663> Launched Extension Host Process.
INFO [AgentHost:remote] Initializing (enabled=true, remoteAuthority=vssh.colabh.org:443)
```

`remoteAuthority = vssh.colabh.org:443`, sem vírgula. **E `File > Open Folder` mostrou a home**, o
que é a prova de ponta a ponta que importa: o filesystem remoto responde, logo o extension host está
vivo, logo o WebSocket atravessou o portal, o socket unix do app e o socket unix do motor.

**As quatro extensões pararam de reclamar** — nem uma linha `dist/browser` nesta abertura. A hipótese
era essa e ela se confirmou: elas rodam no extension host **remoto** (node), e o que faltava não era
o pacote de navegador, era o host. **Não há rebuild do motor pendente por causa disto**, e a
suspeita morreu sem custar um build.

O que sobrou no console é ruído catalogado, e vale catalogar para ninguém gastar tempo com ele
depois:

| O que aparece | O que é |
|---|---|
| `node_modules/vsda/rust/web/vsda_bg.wasm` e `vsda.js` → **404** | o validador de *connection token* da Microsoft, **proprietário e ausente do OSS**. Subimos com `--without-connection-token`: não há token para validar. Dois 404 por conexão, e nada atrás deles |
| `[AgentHost:remote] Connect failed … no upstream agent host endpoint was configured` | a ponte de *agent host* nova do upstream, que só existe com `--agent-host-bridge-port`. Não passamos, e não queremos |
| `vscode.mermaid-markdown-features … CANNOT use 'legacyToolReferenceFullNames'` | extensão embutida do upstream pedindo uma API proposta que o build OSS não habilita. É deles com eles |
| `*.js.map` → 404 | o build sem minificação não publica *source maps*. Custo zero, e some se um dia o `-min` voltar |
| `static.cloudflareinsights.com/beacon.min.js` → `ERR_BLOCKED_BY_CLIENT` | bloqueador de anúncios de quem estava olhando. Não é nosso |

**Guarda:** `tests/workbench-do-ambiente.test.js` — o objeto de construção declara os provedores, e
`IWorkspaceProvider.open` **não** cai no `window.open` de fora. Refuta: devolver qualquer um deles a
`undefined`. E um caso de artefato: se o alvo do gulp passar a produzir `workbench.web.main.js`, o
caso fica vermelho **pedindo que este item seja reescrito** — porque aí a página nossa volta a ser
alcançável e o patch deixa de ser a única costura.

### ✅ 2d. A barra do editor É a barra da janela — feito, e a janela real cobrou três defeitos

O manifesto ganha `window.cabecalho: "app"` (schema do toolkit, enum `ambiente|app`, padrão
`ambiente`); o shell para de desenhar o cabeçalho dele e o iframe passa a ocupar 100% da altura; e o
patch `0006` põe os três botões dentro do `.window-controls-container` que o próprio
`titlebarPart.ts` já constrói, com a `titlebar-drag-region` inteira arrastando.

**Arrastar não precisou de retângulo nem de geometria**, e essa é a diferença para o
`/proxy/vscode/`: a região de arraste é **prependada** (`titlebarPart.ts:486`) e tudo o mais é
appendado **por cima** dela (`:550`) — não há buraco a recortar, e um botão recebe o próprio clique
porque está acima, não porque alguém o excluiu. O que atravessa a ponte é um **ponto**, não geometria.

Três coisas só a janela real mostrou, e nenhuma bancada via:

1. **Os botões não apareciam, e estavam no DOM.** O container é do upstream e vale `width: 0px` na
   web (`titlebarpart.css:308,325`) — um navegador não tem controle de janela, e a caixa só reserva
   espaço para um overlay que não existe. Dentro dela, um item de flex com o `flex-shrink: 1` padrão
   encolhe até zero por mais que declare 46px. São duas metades, e a que faltava não dava erro
   nenhum. Medido: container `0×35`, três botões, cada um medindo zero.

2. **O arraste ficou "meio toggle".** Segurar a barra não movia nada; sair da janela com o ponteiro
   finalmente movia, e a janela saltava; soltar dentro do iframe deixava o arraste **ligado**. Uma
   causa só, e ela estava escrita **como acerto** no comentário do `iniciarDeFora`: *"mesmo limiar"*
   e *"o `guard` que o `iniciar()` levanta já cobre o iframe"*. As duas frases estavam erradas — o
   `iniciar()` só roda **depois** do limiar, e o limiar só passa com um `pointermove` no documento do
   ambiente, que não pode chegar enquanto o ponteiro está sobre o iframe. Sem `guard`, nem o move nem
   o `pointerup` atravessam. **O limiar é de quem tem o ponteiro:** quem conta os 5 px passou a ser a
   barra do app, e o ambiente levanta a `guard` na hora.

3. **A janela ficou sem controle nenhum, e o motor estava certo.** Os dois blocos do patch são
   guardados por `if (ponte?.window?.arrastar)`, e `arrastar` nasceu no toolkit **4.1.0** — mas o
   `package-lock.json` do repo do app fixava o commit da **4.0.0**. A lição que eu já tinha escrita
   dizia *"mover a tag `v4`"*, e estava **incompleta**: a tag moveu; quem a ignora é o `npm ci`, que
   obedece ao lock. Mover a tag é necessário e não é suficiente. Pior: **um guarda opcional que dá
   falso não quebra — ele desliga o recurso**, calado, e o sintoma aparece a três repositórios de
   distância.

⚠ E o conserto do (2) **ainda não bastou** — foi a terceira janela que disse. Contar o limiar do
lado certo tirou o "toggle" e sobrou o resto do gesto, que continuava sendo uma **entrega no meio
dele**. Esse desenho depende de a `guard` subir antes do próximo evento **e** de ela ganhar o
empilhamento; enquanto qualquer uma das duas falha, os pontos se perdem e nada acusa. Dois consertos
meus só trocaram o sintoma, e o que mudou foi o critério: em vez de mais um conserto pontual, **um
desenho em que a falha não seja possível**.

**Quem tem o ponteiro é o app**, e com `setPointerCapture` ele tem o gesto inteiro — fora do próprio
quadro, sobre outra janela, inclusive o `pointerup`. Então ele reporta os três, e é o `drag-end` que
torna impossível a janela seguir o ponteiro depois de o usuário soltar:

| verbo | quem decide |
|---|---|
| `arrastar(x, y)` | o app, **depois do limiar**, que também é dele |
| `arrastarPara(x, y)` | o app, a cada ponto |
| `arrastarFim()` | o app, no `pointerup`/`pointercancel` |

O ambiente continua dono do que é dele: containment, encaixe e o commit da posição. A conta do
movimento saiu de dentro do `aoMover` e virou uma função só — duas contas iguais em dois lugares é
o defeito que a casa proíbe, e ela agora serve o `pointermove` do shell e o ponto que vem do iframe.

**E a proposta que isto descartou, com o motivo:** tirar o cabeçalho do iframe e desenhá-lo no
shell. Resolveria, e custa caro — a barra do VS Code carrega o menu, o command center, os controles
de layout e o título, e reconstruí-los no shell é a mesma inversão que arrancamos do
`/proxy/vscode/`, apontada para o outro lado. Além disso não remove a fronteira: só a desce 35 px,
e o próximo gesto que nascer dentro do editor tem o mesmo problema.

### ✅ 2e. O banner ficava por cima da cabeça da janela, e o `Shift+F5` tinha outra causa

Dois achados da mesma rodada, e nenhum dos dois era do arraste.

**O banner.** `shouldShowBannerFirst() { return isWeb && !isWCOEnabled(); }` (`layout.ts:1385-1387`)
põe o banner **acima** da barra de título na web — e o upstream está certo: numa aba de navegador não
existe barra de janela, e uma mensagem no topo absoluto é o lugar dela. Dentro do ambiente a premissa
é falsa, e o que apareceu no topo foi o *Workspace Trust*: *"Restricted Mode is intended for safe
code browsing"*. Duas metades: o **dado** desliga o Restricted Mode
(`security.workspace.trust.enabled: false`), porque ele não protege de nada num editor que já roda
como o usuário Linux dono da sessão com terminal integrado a um clique; a **função** é o patch
`0008`, que vale para o banner de amanhã — numa janela cujo cabeçalho é esta barra, ela é a primeira
faixa. Fora do ambiente o `return` do upstream continua no caminho, intacto: o patch só acrescenta.

**O `Shift+F5`, e ele teve DUAS causas diferentes com o mesmo sintoma.**

⚠ Aqui estava escrito *"e a página nunca foi a culpada"*. **Está errado**, e apaga o primeiro
conserto: na primeira vez a culpada **era** a página. Depois de um upgrade, o navegador servia a
página da versão ANTERIOR — sem a tag da ponte —, e sem `window.vssh` o embedder cai no
`mainWindow.open` do upstream, que é o comportamento correto dele quando não há ambiente. A janela
nova voltava a abrir como aba. O que torna essa página diferente de qualquer outra: **o conteúdo
dela é função da versão do app**, e o app é trocado por fora do navegador (`vssh-app-install`) —
nenhum `ETag` do motor descreve a nossa camada. O conserto é o `cabecalhosDaPagina` mandar
`no-store` e **descartar o `etag`/`last-modified` do motor**, que validam o HTML dele e não a nossa
reescrita. E ele só podia chegar sendo buscado uma vez, então o `Shift+F5` daquela vez foi o preço
da transição, pago uma vez.

A segunda vez foi outra coisa, e a página já estava certa: `getServerProductSegment(product)` devolve
`${quality ?? 'oss'}-${commit ?? 'dev'}` (`network.ts:256-258`), e é ele que vira o
`/oss-<commit>/static/…` de onde saem o `workbench.js` e o `workbench.css` — servidos com
`Cache-Control: public, max-age=31536000` (`webClientServer.ts:69`), **um ano**. Todos os nossos
motores nascem do mesmo commit do upstream: **mesma URL, marcada imutável, bytes diferentes a cada
build.** O navegador estava obedecendo ao que a gente mandou. Cada motor passa a carimbar o próprio
`commit` (`df53daab-<carimbo>`), e o endereço muda com os bytes.

⚠ E o carimbo entrou junto com uma dívida antiga: a reescrita do `product.json` estava escrita no
`motor.yml` **e** no `build-local.sh`. É a mesma duplicação que fez o alvo do gulp ficar para trás e
custou um build inteiro — o alvo virou leitura, e isto virou `scripts/carimbar-produto.js`, chamado
pelos dois.

**Guarda:** `tests/unit/cabecalho-do-app.test.js` no `vssh-sso`, **10 casos**, e
`tests/pagina-do-ambiente.test.js` no editor, **7 casos** dos 36 — refutação **13/13**. O caso do
gesto cobra o fim nas três consequências (a `guard` desce, a posição é commitada, e um ponto depois
do fim não move mais nada); o do carimbo **executa** o carimbador com dois carimbos e exige dois
commits diferentes, em vez de conferir que a linha existe.

⚠ **Duas guardas minhas mediram a coisa errada, e as duas do mesmo jeito.** Uma ficou **verde o tempo
todo com a janela quebrada**: montava o arraste com `distance: 0`, e com limiar zero a `guard` sobe
de qualquer jeito — um caso que só passa na configuração que ninguém usa não cobra nada. A outra
ficou **vermelha sem defeito nenhum**: perguntava por `doc.addEventListener('pointermove')`, ou seja
media o **mecanismo**, e reprovou quando o mecanismo melhorou. É o mesmo erro do caso que procurava
`mainWindow.open(targetHref)` na janela de contexto do diff, e agora está catalogado três vezes:
**a pergunta é o invariante, nunca a implementação dele.**

### ✅ 2f. Eu publiquei um editor que recusava a própria conexão

O conserto do `Shift+F5` da seção anterior **quebrou o editor**, e o defeito ficou publicado. Vale
escrito inteiro, porque o erro é de um tipo que se repete.

O `commit` é o caminho dos estáticos, e eu o carimbei no `product.json` **depois** do build. Só que
ele é embutido no bundle do **cliente** em tempo de compilação (`gulpfile.reh.ts:41,420`), e o
servidor compara os dois no handshake:

```ts
const rendererCommit = msg2.commit;
const myCommit = this._productService.commit;
if (rendererCommit !== myCommit) {
    return rejectWebSocketConnection(`Client refused: version mismatch`);
}
// remoteExtensionHostAgentServer.ts:335-341
```

**Carimbar depois do build carimba um lado só, e os dois lados se conferem.** O editor subia e
recusava a própria conexão.

O carimbo mudou para `BUILD_SOURCEVERSION`, **antes** de compilar — dali ele entra no bundle e no
`product.json` pelo mesmo caminho, e ninguém precisa concordar com ninguém. E o formato não é
escolha: `getVersion` só aceita a variável se ela casar com `/^[0-9a-f]{40}$/i`; fora disso ela cai
no git e **ignora o carimbo em silêncio** (`build/lib/getVersion.ts`). Por isso o commit é o prefixo
do sha do upstream seguido do carimbo em dígitos — que já são hex válidos.

**O que fica é o portão, e ele é o assunto.** O `carimbar-produto.js` passou a abrir o bundle do
cliente e exigir encontrar lá o commit que o servidor vai anunciar. Um produto cujas metades
discordam não sai daqui. Era **a pergunta que nenhuma bancada minha podia fazer**, porque ela só
existe depois do build — e a guarda a executa contra um produto de mentira, cobrando que ele
**reprove**.

### ✅ 2g. O arraste tremia, e o Copilot custou o terceiro build

**O tremor.** Com o gesto inteiro atravessando, o arraste parou de escapar e passou a oscilar. Mesma
família de tudo nesta onda: **coordenada de dentro do iframe é um laço de realimentação.** Enquanto a
janela é arrastada, o quadro do app se move **junto** com ela, então o `clientX` que ele manda vale
`tela − posição da janela` — um número que depende justamente do que o ambiente acabou de mudar. O
ambiente reconvertia lendo `getBoundingClientRect()` a cada ponto; com mais de um `pointermove` por
quadro (mouse de 240 Hz, eventos coalescidos), a leitura é de um quadro atrás e o erro vira
oscilação.

A tela não se move com a janela. O deslocamento entre o quadro do ambiente e a tela é guardado
**uma vez**, no começo do gesto, com nada ainda deslocado; dali em diante todo ponto é uma soma
constante. O caminho antigo fica — um app compilado contra o toolkit 4.2.0 ainda manda o ponto do
quadro, e tirá-lo seria quebrar um app publicado para consertar outro.

**E o Copilot cobrou o terceiro build.** O script de build da extensão liga o modo de pipeline
oficial assim que vê `BUILD_SOURCEVERSION` (`extensions/copilot/.esbuild.mts:326`) e passa a exigir
`VSCODE_QUALITY`, depois `VSCODE_PUBLISH_COUNTER` — **um por build derrubado, 5,3 min cada**. E o
`BUILD_SOURCEVERSION` a gente precisa por um motivo nosso. Eu alimentei duas variáveis antes de
parar e ver o óbvio: **construir o que a gente descarta era alimentar essa colisão para sempre.** A
dívida "o Copilot ainda é *construído* mesmo sem ser embarcado" estava registrada desde o item 1, e
agora tem preço. `compileCopilotExtensionBuildTask` saiu da série do alvo REH, e o import junto
(`noUnusedLocals: true`). De brinde: **8,03 min → 5,08 min**.

**Guarda:** `pagina-do-ambiente.test.js`, **38 casos**, refutação **7/7**; `cabecalho-do-app.test.js`
no `vssh-sso`, **12 casos**, refutação **4/4**. Os dois casos novos do shell **executam** o método
extraído do arquivo — mesmo idioma do `validadorDeRota` — porque a pergunta é aritmética, e regex
não mede aritmética.

⚠ E eu li um `grep` vazio como sucesso e disse que um build tinha fechado quando ele havia falhado
com `exit 1`. O código de saída estava no arquivo da tarefa, e eu não o li.

### ✅ 2h. O arraste ficou certo e a janela parou de encaixar nas bordas

O último desta série, e o mais curto de explicar: quando eu separei a conta do movimento do evento
que a traz, escrevi `if (e) opts.drag?.(e)`. Um ponto que vem de fora não traz evento, então o
callback não acontecia — e quem escuta ele é o `TilingManager.onDrag`. Sem ele não há
`_pendingZone`; sem `_pendingZone`, o `onDragStop` não tem o que aplicar. **Levei o ponto e deixei o
evento para trás**, e o sintoma foi um arraste perfeito que não encaixava em borda nenhuma.

O que o consumidor lê do evento é `pageX ?? clientX` e mais nada (`TilingManager.js:419-420`), então
o ponto basta: um evento sintético aqui não é remendo, é dizer a mesma coisa que o de verdade dizia
para quem só perguntava isso. E o gesto que nasce no shell continua entregando o evento **original**,
com todos os campos — a guarda cobra **identidade**, não formato, e a refutação inclui a mutação
simétrica (trocar o evento real por um sintético).

**Guarda:** `cabecalho-do-app.test.js`, **13 casos**, refutação **3/3**. Conserto só de shell
(**4.4.1**): nenhum rebuild do motor, nenhuma reinstalação.

### ✅ 2i. VSSHCode — o editor ganha nome, e o ícone anterior era um defeito

O nome vivia em **dois lugares dizendo coisas diferentes**: o manifesto dizia `Editor` (é o que o
Launchpad, a barra de tarefas e o alternador mostram) e o `product.json` dizia `VSSH Code` (é o que a
barra de título do próprio editor mostra). Com `cabecalho: "app"` os dois aparecem na **mesma
janela**, um dentro do outro. Agora é **VSSHCode** nos dois, com guarda cobrando que continuem iguais.

**E o ícone não era só sem graça — ele estava invisível.** Era monolinha em `currentColor`, e o shell
desenha ícone de app com `<img src>` (`Launchpad.js:203-208`): dentro de um `<img>` o SVG é um
documento independente, `currentColor` não herda nada e cai para o valor inicial, que é **preto**.
Preto sobre um desktop escuro — com o arquivo "correto" e nada acusando.

O desenho novo é o **irmão do favicon do portal**, que escreve `>_` em monoespaçada no azul da casa
(`#0c0c0e` + `#0e639c`). Aqui a última palavra muda: o `_` de shell vira o **cursor de bloco**, no
verde que o tema chama de *"cursor terminal"*. Mesma gramática, outro fim — o parentesco se lê sem
explicação. Escolhido entre três, julgados **renderizados de 16 a 64px** no chão do desktop, em fundo
claro, no Launchpad e na barra de tarefas; as outras duas eram uma janela com faixa de cabeçalho
(bonita a 64px, borrão a 24) e um bloco de código (a mais legível e a **menos nossa** — serviria a
qualquer editor de qualquer lugar).

**O que NÃO acompanha o rótulo, e a distinção é o conteúdo do item:** `serverApplicationName`,
`applicationName`, `dataFolderName` — e o `id` do app. **Identificador não é nome de exibição.** O
build e o `install.sh` procuram `bin/vssh-code-server` pelo nome; o `id` vira caminho
(`/proxy/app/vscode/`), porta, sentinela e chave no repositório, e trocá-lo seria um app novo, com
reinstalação e `~/.vssh-apps/vscode/data` órfão. Há guarda cobrando que o binário fique.

**Guarda:** `pagina-do-ambiente.test.js`, **40 casos**, refutação **5/5**.

⚠ E a guarda do ícone **nasceu vermelha lendo o comentário que explica por que `currentColor` não é
usado** — a mesma armadilha que fez o `vssh-sso` ganhar um `soCodigo`. A pergunta é sobre o desenho,
não sobre o texto ao redor dele.

### ✅ 2j. Os ícones DENTRO do app, e onde a marca deve ser trocada

O rename para VSSHCode parou na porta: a página do motor aponta para `resources/server/favicon.ico`,
`code-192.png` e um `manifest.json` que é **arquivo estático** — e por isso ele continuava dizendo
`"name": "Code - OSS"` depois de o `product.json` virar VSSHCode. Era um **terceiro** lugar guardando
a identidade, e o único que ninguém tinha atualizado.

⚠ **A primeira versão trocava os três `<link>` reescrevendo a página em runtime, e o lugar estava
errado.** Funciona — e falha **calada**: se o upstream mexer naquela marcação, a expressão deixa de
casar, o logo do VS Code volta e ninguém fica sabendo. Foi o usuário que apontou o lugar certo:
*"a gente não pode copiar os arquivos estáticos para o tarball?"* — no **empacotamento**, junto da
galeria e do commit, onde a mesma cirurgia **aborta** se não casar. É a diferença entre um remendo e
um portão, e não custa rebuild, porque vestir o produto é passo pós-build.

O `carimbar-produto.js` passou a copiar o `icon.svg` do pacote para `resources/server/vssh-icon.svg`,
gerar o webmanifest do próprio `product.json` — a mesma fonte do nome que a barra de título usa — e
apontar o `rel="icon"` e o `apple-touch-icon` para ele **com o tipo certo**: um SVG entregue como
`image/x-icon` não desenha.

**O que NÃO dá para fazer aqui, dito por extenso:** gerar os PNG e o `.ico`. Rasterizar um SVG pede
um renderizador, e trazer um para dentro do build por causa de três arquivos seria pior que o
problema. Eles continuam no tarball, sem ninguém apontando para eles.

**Guarda:** `pagina-do-ambiente.test.js`, **42 casos** — o novo **executa** o carimbador contra um
produto de mentira, confere os três `<link>` e o webmanifest, e exige que ele **reprove** uma página
que não casa.

⚠ E uma armadilha de operação que ficou clara aqui: `publicar-motor.sh` apaga a cópia local e traz a
do container — então a marca sobrevive, porque a cirurgia é **antes** do `tar`. Mas quem mexer no
ícone e publicar **sem** rodar `empacotar` publica o tarball anterior, calado. O publicador não pode
editar bytes (é ele quem garante que o publicado é o que o build produziu); o que falta é ele
**recusar** um tarball mais velho que suas entradas.

### ✅ 2k. O `window-appicon`, a marca d'água, e o portão para o lugar que eu ainda não vi

O 2j trocou a iconografia de `resources/server/` e eu dei o assunto por encerrado. **Estava
incompleto**, e quem achou o resto foi o usuário, colando a URL:

```
…/static/out/media/code-icon.svg   →  ainda o logo do VS Code
```

Ela dói mais que o favicon, e o CSS diz por quê: é ela que desenha o **`.window-appicon`** — à
esquerda da barra de título, na mesma faixa onde este fork põe os botões de janela do ambiente.
Também aparece no `product-logo` do tooltip de atualização, na página de boas-vindas e no onboarding.

**É o mesmo defeito da noite inteira: troquei os arquivos de um diretório e não perguntei se havia
outro.** A terceira vez — depois de uma das duas chamadas de `timeout` no CI e dos `resources/server`
sem o `out/media`. Por isso, além de acrescentar o arquivo à lista, entrou um **portão que responde
por quem eu não conheço**: `#167abf` é o azul da marca do VS Code, e a varredura mediu que ele não
aparece em mais nenhum SVG do artefato (os da página de boas-vindas usam `#0065A9`/`#007ACC`, que são
ilustração de UI). Qualquer arquivo que saia do empacotamento com esse azul **derruba o build**.

**A marca d'água do editor vazio também virou nossa.** ⚠ E aqui vale corrigir uma leitura: o
`letterpress` do upstream **não é o logo deles** — é uma ilustração de editor (janela com barra
lateral e linhas de texto), preta a 30% de opacidade, medido, sem filtro no CSS. Trocá-la não é tirar
marca alheia, é ter a nossa. A versão VSSHCode é o **símbolo** — chevron e cursor, sem a placa —,
porque marca d'água quer o símbolo: a placa escura viraria um retângulo no meio do editor. Uma
geometria só, quatro variantes geradas dela, com as cores e opacidades que cada tema já usava.

⚠ **O molde é um SVG de verdade, e não um arquivo com `__COR__` no lugar da cor.** A pergunta foi do
usuário — *"stroke=`__COR__`?"* — e ela pegou uma contradição de uma linha de distância: eu tinha
acabado de escrever uma guarda dizendo que **ícone tem de abrir**, e criei em seguida um `.svg` que
não abre. O molde passou a ser a variante escura, que se abre e se vê, e as outras três saem dela
trocando dois pontos explícitos — com o passo abortando se o molde perdê-los.

⚠ **E o passo virou idempotente, depois de o segundo `empacotar` abortar.** A guarda exigia que cada
expressão **casasse**, e na segunda execução a página já estava reescrita. Agora se cobra o **estado
final** — *"a página saiu sem a marca alheia?"* —, que é verdade nas duas execuções e falso
exatamente quando o upstream mudar a marcação. É a mesma lição do caso que media o mecanismo do
arraste em vez do invariante, e a terceira vez que ela aparece nesta onda.

**Guarda:** `pagina-do-ambiente.test.js`, **42 casos**. O da iconografia **executa** o carimbador
seis vezes: página que casa, página que não casa, arquivo novo com a marca, e duas passadas seguidas.

### 2a. 📋 O patch da plataforma — e ele é uma linha

`CURRENT_TARGET_PLATFORM` deixa de derivar de `isWeb` e passa a vir do servidor remoto, que é quem
sabe. É o patch que a queixa que abriu a onda pedia, e o único lugar de onde ela é alcançável.

**Guarda:** `tests/plataforma-do-servidor.test.js` — o fork, montado, resolve `linux-x64` nos **dois**
caminhos, listagem e install. Refuta: reverter a linha. E o teste tem de ficar vermelho também se
alguém "consertar" só o caminho do install — que é o estado de hoje, e ele já passa por metade.

### 2b. 📋 O que sobra do `VsCodeViewerWindow` — e ele estava certo

O sequestro de `window.open` (`VsCodeViewerWindow.js:243-258`) **fica**, porque
`auxiliaryWindowService.ts:385` chama `mainWindow.open` e não há serviço substituível. O que sai é o
resto: os seletores `.part.titlebar .titlebar-right .window-controls-container` (`:113-115`), o
arraste ancorado em `.titlebar-left` (`:153`) e o `MutationObserver` no `<title>` (`:175-182`) — os
três deixam de existir porque a barra some por configuração e o título vem por API.

## 3. 📋 `/proxy/vscode/` deixa de ser um endereço

A cirurgia da [2.7](02b-motores.md), no inquilino que sobrou. Somem:

| O quê | Onde |
|---|---|
| o ramo `vscode` e a porta `10000 + uid` | `proxy.ts:468-469` |
| a injeção do cookie `code-server-session` | `proxy.ts:578-591` e `proxy/upgrade.ts:167-179` |
| o handshake `curl -X POST /login` dentro do servidor + cache Redis de 24 h | `code-server.ts:727-768` |
| `provisioning/code-server.ts` **inteiro** | 782 linhas |
| os seis endpoints `/api/keys/web-server/*` | `routes/keys.ts:231-408` |
| o `xpra/start` no-op que só existia para o botão do code-server | `routes/keys.ts:420-425` |
| as duas rotas de admin | `routes/admin.ts:148-158` |
| a instalação incondicional e os três pins de versão | `provision-base.sh:364-371`, `vssh-provision.sh:99`, `provision-targets.json:23` |
| o `config.yaml` com `auth: none` que o runtime contradiz com `auth: password` | `vssh-setup-user.sh:65-75` × `code-server.ts:93-106` |

**Guarda:** `tests/unit/vscode-nao-e-mais-endereco.test.js` — `GET /x/proxy/vscode/` cai no 404 de
"Serviço proxy inválido", e `code-server-session` não aparece em `src/`. Refuta: restaurar o ramo.
Atualizar junto `tests/unit/erro-do-proxy.test.js:153,171-197`, que hoje garante o nome *"o editor
web"*.

**Trava:** o app instalado e verde em **todos** os servidores. Enquanto um não tiver,
`/proxy/vscode/` é o único caminho até o editor, e apagá-lo cria um 502 sem causa.

### 3a. 📋 `changeOrigin: false` ganha dono, ou perde a justificativa

`proxy.ts:59-64` diz *"DEVE SER FALSE: Host header precisa bater com o Origin do code-server"* e
*"xfwd: true — X-Forwarded-* vitais para o code-server"*, e é **global**. Depois do item 3 esses
comentários nomeiam um serviço que não existe mais. Ou a razão é outra e passa a estar escrita
medida, ou é carga de culto e sai.

**Guarda:** virar cada um e ver o que quebra (Xpra, OnlyOffice, um app com WebSocket) — o resultado
vira o comentário e o teste.

---

# O que o ecossistema ganha

O pedido que abriu a onda tinha uma segunda metade: *"novas aplicações devem sempre contribuir pro
ecossistema"*. Hoje um vssh-app **consome** o ambiente e quase não **contribui** com ele. Existe
**um** mecanismo completo (`contributes.settings`) e **uma** superfície com registro
(`SettingsRegistry.register`, `SettingsRegistry.js:81-85`). Todo o resto é array literal no shell.

## 4. 🔶 O contrato de contribuição — o menu de contexto **feito**, e quatro linhas ainda abertas

| Superfície | Hoje | Depois |
|---|---|---|
| menu de contexto de arquivo, pasta, área de trabalho | `ContextMenu.js:823-831` não tem `register`; itens em `FileContextMenu.js:49-148`, `Desktop.js:912,929,948`, `arquivos/lateral.js:115,318` | ✅ `contributes.contextMenu` no manifesto, com **precedência declarada** |
| menu do ícone no Launchpad | três itens fixos (`ContextMenu.js:559-576`) | 📋 jump list vinda do manifesto — o que o Windows faz com o botão direito no ícone |
| "Abrir com" | o app entra **sempre depois** dos embutidos, atrás de um separador, com ícone fixo `apps` (`abrir-com.js:143-146`); o OnlyOffice é sempre o primeiro (`:77-83`) | 🔶 o ícone é o do próprio app — **feito**; a ordem contra os embutidos continua fixa |
| `opens.mimeTypes` | aceito, projetado e **nunca roteado** (`docs/api.md:700-702`) | 📋 roteado pelo mesmo portão |
| `handles` | enum fechado de 5, e `vscode` é o único valor que nomeia **um produto** (`schema:142-146`) | 📋 categoria, não nome de produto |
| `category` | sobrescrito por `'Apps Integrados'` (`Launchpad.js:73-75`) | 📋 volta a valer |

O molde é o `SettingsRegistry`, que já provou o formato. A regra é a da casa: **um portão, não N
`if`s**, e precedência declarada — porque dois apps vão querer o mesmo item de menu, e "quem carregou
primeiro" não é uma regra, é um acidente.

### ✅ 4a. O menu de contexto tem registro, e a contribuição é DADO — não script

`contributes.settings` é um caminho de script. A primeira forma que escrevi para o menu copiava
isso, e **estava errada**, por uma razão que só aparece quando se olha o MOMENTO de cada superfície:

|  | quando roda | o que acontece se demorar ou falhar |
|---|---|---|
| `settings` | quando a pessoa **abre** Configurações | há uma janela para culpar; a seção não aparece, e o resto abre |
| `contextMenu` | em **todo clique direito, em todo arquivo** | não há janela, não há espera aceitável, e um app que trava trava o gesto mais usado do ambiente |

Então o vocabulário ficou **fechado**: o app declara `id`, `superficie`, `rotulo`, `ordem`, um
`quando` opcional e um verbo. Quem monta o item, ordena e executa é o shell — **nenhuma linha do app
roda na origem do shell para pôr um item de menu**, que é a diferença entre contribuir e ser
confiado. E não custa fetch nenhum: os itens já viajam na projeção de `GET /api/apps`, que o shell
já lia.

**O verbo é UM, e isso é decisão e não começo.** `abrir` entrega o caminho clicado pelo
`open-context`, que já era contrato publicado — não há segundo protocolo. Verbo diferente **recusa**
o item: quem pediu outra coisa não quis "abrir", e atendê-lo com "abrir" é responder outra pergunta.

**⚠ A jump list ficou de fora, e a falta é de VERBO, não de superfície.** `abrir` sem caminho é
exatamente o item "Abrir" que os três itens fixos já têm. Uma jump list útil ("Novo arquivo", "Abrir
recente") pede um segundo verbo com **rota** — e a regra de rota segura já existe em UM lugar
(`VsshAppWindow._rotaSegura`, `:953-961`). Escrever uma segunda cópia dela no portal seria duas
noções do mesmo fato; movê-la é mexer numa classe que o arraste acabou de tocar. Ela entra junto com
o segundo verbo, e a linha da tabela acima continua 📋 por isso.

**A `ordem` mede contra os itens do PRÓPRIO shell.** Sem isso `ordem: 50` só responderia "antes do
outro app que também declarou". Para a régua existir, os embutidos do `FileContextMenu` deixaram de
ser uma sequência de `items.push` e passaram a carregar posição, **da mesma tabela `ANCORAS`** que o
manifesto usa. É o que permite a um app declarar `ordem: 15` e ficar entre "Abrir" e "Abrir Terminal
Aqui" — em vez de sempre no fim, atrás de um separador, que é como o "Abrir com" tratava todo
vssh-app. O desempate entre apps é o **id**, alfabético, e não a ordem de chegada: a mesma correção
que o `SettingsRegistry.porFamilia` já teve de fazer.

**⚠ E a medida achou um defeito que estava lá sem ninguém ver.** A tabela desta seção dizia que o
vssh-app entrava no "Abrir com" *"com ícone fixo `apps`"*. **Está errado, e para pior:** `apps` não
existe — nem no `_ICON_MAP` do `ContextMenu` nem na folha de sprites (60 símbolos, conferidos um a
um). Ele caía no fallback **silencioso** `#ico-file`, então todo vssh-app aparecia ali com ícone de
arquivo genérico, e nada acusava. É o mesmo defeito que o comentário do próprio `_ICON_MAP:26-28` já
descrevia para a grade da área de trabalho — descrito de um lado, e nunca conferido do outro. O
conserto não foi achar um sprite melhor: é o ícone do **próprio app**, que é o que distingue dois
apps que abrem a mesma extensão.

**⚠ Duas guardas ficaram vermelhas lendo o próprio comentário**, e é a mesma armadilha do
`currentColor` do ícone: a que proíbe `icon: 'apps'` casou com a frase que explica por que ele saiu,
e a do `focusFn` em `abrir-com.test.js` casou com a frase que explica por que o `FileContextMenu` não
o passa. As duas passaram a usar `soCodigo`. Uma guarda que uma frase derruba mede prosa.

**⚠ E a refutação derrubou uma terceira** — a que cobrava posição declarada nos embutidos. Ela
cobrava **presença**, e `ordem: _ANCORAS.vscode` aparece em **três** lugares: tirar de um deixava a
guarda verde porque os outros dois ainda casavam. É "consertei um dos dois" pela quarta vez nesta
onda. A conta agora é exata por chave, mais a soma contra `aberturas.push(` — que é o que pega um
item **novo** empurrado sem posição nenhuma.

**O VSSHCode é o primeiro cliente**, com três itens (pasta, área de trabalho, e arquivo de código com
filtro de extensão). Durante a transição ele aparece **ao lado** do "Abrir no VS Code" embutido, e
isso é a verdade do estado: o embutido ainda aponta para `/proxy/vscode/`, que só deixa de ser
endereço no item 3. Trocar um pelo outro antes de todo servidor ter o app é a dependência dura desta
onda.

**Guarda:** `tests/unit/contribuicao-de-menu.test.js`, **23 casos, refutação 11/11**. A suíte do
`vssh-sso` vai de 1.362 a **1.450**. Shell **4.5.0**, schema ressincronizado
(`vssh-app-toolkit@6f88805`).

**⚠ O primeiro passe de refutação saiu verde em sete das onze, e não media nada:** os
`--test-name-pattern` estavam **sem acento** e os nomes dos testes têm. Padrão que não casa roda zero
teste e sai 0. O script passou a contar quantos testes o filtro alcançou, e recusa a rodada quando o
filtro vem vazio — é a mesma lição do comando de medida da Onda 8, cuja guarda perguntava sobre
escape e nunca sobre se aquilo era shell que roda.

## 5. 📋 A extensão VSSH, servida pelo próprio app

`additionalBuiltinExtensions` aceita *"location of the extension where it is hosted"*
(`web.api.ts:248-254`): o backend do app serve uma extensão que o workbench carrega embutida e o
usuário não desinstala. **É o caminho para tudo o que o embedder não alcança** — `explorer/context`,
`editor/title`, comandos em menus de verdade —, já que `asMenuId` só conhece dois `MenuId`.

O que ela entrega: abrir um arquivo do editor no visualizador do ambiente, mandar uma pasta para o
gerenciador de arquivos, notificar pelo `vssh.notify` em vez do toast interno, e o selo
`windowIndicator` dizendo em que servidor o workbench está — o verde do Codespaces, com o nosso nome.

**Guarda:** `tests/unit/extensao-vssh.test.js` — a extensão declara os contribution points, e o
workbench montado a carrega sem passar pela galeria. Refuta: removê-la de
`additionalBuiltinExtensions`; o teste tem de ficar vermelho por ausência, não por erro de rede.

## 6. ✅ O portão do body parser — **feito**, e a medida corrigiu duas coisas do que estava escrito aqui

`app.ts:96-97` registrava `express.json()` e `express.urlencoded()` **globais**, com o limite default
de **100 kb**, e `setupProxyRoutes(app)` só entrava em `:169`. O diagnóstico estava certo; **as duas
frases que descreviam a consequência estavam erradas**, e as duas para menos.

**⚠ "leva 413" — não levava. Levava 500 "Erro interno".** Medido contra o portal de pé: o
`PayloadTooLargeError` do body-parser subia até o error handler de `app.ts`, que respondia **500 para
qualquer erro** e descartava o `err.status`. A diferença não é cosmética — 413 diz *"seu corpo é
grande demais"* e 500 diz *"o portal quebrou"*, com uma mensagem mandando **tentar de novo mais
tarde**, isto é, repetir exatamente o que não pode dar certo. Quem escreve o app procuraria o defeito
no lugar errado.

| POST para uma rota de proxy | antes | depois |
|---|---|---|
| JSON 1 kB | 404 (chega ao roteamento) | 404 |
| JSON 200 kB | **500** | 404 |
| urlencoded 200 kB | **500** | 404 |
| octet-stream 200 kB | 404 | 404 |

**⚠ "é latente, não vivo" — metade dele estava vivo, e não é sobre tamanho.** Consumir o stream tem
dois efeitos que não dependem de 100 kb nenhum:

- quem repassa o corpo por `req.pipe()` — **o proxy PAC do navegador embutido** (`pac-proxy.ts:58`) —
  mandava o `Content-Length` original com **zero byte atrás dele**. Medido com `http-proxy-3` e um
  alvo que conta bytes: **0 de N prometidos**, e o outro lado esperando;
- e o que existia para tapar isso era **reescrever o corpo a partir do objeto**
  (`JSON.stringify(req.body)`), o que entrega ao app **bytes diferentes dos que o cliente mandou**.
  Qualquer backend que confira assinatura ou hash sobre o corpo cru quebra — em silêncio, e só nos
  pedidos com corpo. Com corpo `{}` era pior: não escrevia nada e deixava o `Content-Length` de pé.

**O conserto é a frase, não o remendo:** *o corpo de um pedido proxiado é do outro lado, e o portal
não o toca*. Quem sabe quais rotas são essas é o `proxy.ts`, **ao lado dos mounts que ele descreve** —
não uma segunda lista no `app.ts`. O PAC entra pelo mesmo teste que ele próprio usa (URL em forma
absoluta), porque ele não se reconhece pelo caminho. E a reescrita **saiu**: ela era o conserto de um
dano que o portal causava a si mesmo, e sumiu com a causa.

**Nas rotas do próprio portal o teto continua valendo** — ali o corpo é nosso e o limite protege a
memória do processo. O que mudou é o error handler reaproveitar status 4xx, então agora ele **se
chama 413**.

**Guarda:** `tests/unit/corpo-do-proxy.test.js`, **9 casos**, refutação **9/9**. Três deles são de
junção — todo `app.use` de proxy tem de estar coberto pelo predicado, que é o ataque nº 1 aqui
(*acrescentar um mount novo e seguir a vida*) — e dois medem o **mecanismo** com `express` e
`http-proxy-3` de verdade contra um alvo que conta bytes, porque "o corpo chega íntegro" é afirmação
sobre o que chega, não sobre o que sai. Suíte do `vssh-sso`: **1.387 testes, 1.376 passando, 0
falhas**.

> **E um caso vermelho foi do instrumento.** A guarda de junção expande o padrão do express
> (`/:serverId/proxy/:service?`) para um caminho de verdade, e a primeira expansão devolvia `/x` —
> media outra coisa e teria passado verde com a lista vazia. O caso agora recusa qualquer expansão
> que ainda tenha `:` sobrando.

## 7. ✅ A documentação para de recomendar o atalho — **feito**

**Executado antes do resto da onda, e de propósito:** nada aqui depende do socket nem do fork. O que
dependia ficou de fora e está listado no fim do item.

**A mudança de fundo, entregue:** a árvore de decisão de `porting.md` deixou de ser ordenada por
**custo de rodar**. Agora são **duas perguntas** — *"o app já roda num navegador?"* e *"o que ele
contribui com o ambiente?"* —, a segunda com tabela própria ligando cada capacidade ao lugar dela em
`api.md`, que a página **não linkava uma única vez**. E a regra que sai daí é a do critério 3.2 na
forma: um app que responde "nada" à segunda pergunta não está pronto para ser portado, está pronto
para ser redesenhado.

As correções, cada uma no lugar e dizendo que estava errada:

| Onde | O que estava escrito | O que passou a estar |
|---|---|---|
| `porting.md`, árvore de decisão | uma pergunta, ordenada por custo de rodar, terminando em *"o shim resolve"* | duas perguntas e duas tabelas; *"o shim resolve"* passa a fechar a **primeira**, não o port |
| `porting.md`, regra do fork | *"normalmente sem fork"* e *"patch para integrar com o ambiente"* a 150 linhas uma da outra, sem se falarem | ditas juntas: o fork não é custo de **rodar**, é às vezes custo de **integrar** — com a linha 35 do VS Code como caso trabalhado |
| `porting.md` + `logseq-port.md`, tabela do modo web | `IndexedDB` vendido como *"modo web (de graça)"* | *"já implementado"*, com o 3.2 dito por extenso: estado no navegador é **dívida**, e o que o modo web poupa é implementar agora, não durar |
| `criterios.md:1` | título **"Os dois critérios"** num arquivo que cobra três | **"Os três critérios"**, com o motivo (o 3.3 nasceu na 2.4 e o título ficou para trás) |
| `criterios.md`, "Como aplicar" | *"todo item das Ondas 2, 4 e 5"* | *"todo item de qualquer onda, e todo vssh-app"* — **nenhum vssh-app passava pelo 3.3**, porque vssh-app não é item de onda |
| `SKILL.md`, doutrina da extração | disparava só por gatilho **acidental** (`X-Frame-Options`, TLS próprio) | ganhou o gatilho de **propósito**: quantas camadas da UI original ficam por cima da do ambiente. Se a ferramenta *deixa* ser posta em iframe, a doutrina nunca disparava |

**E o erro do healthcheck tinha cinco cópias, não três — eu contei a menos.** A frase *"o healthcheck
não carrega `X-Vssh-App-Token`; isente essa rota"* estava em `porting.md`, `logseq-port.md`,
`schema/vssh-app.schema.json`, `lib/node/vssh-app-fs/README.md` e **no comentário do
`templates/hello-vssh-app-node/backend/server.js`** — que é o arquivo de onde todo app novo nasce.
**Mudou na Onda 4:** a sondagem vai **com** o header (`vssh-apps.ts:625-629`,
`SKILL.md:214-217,448-451`), e `401`/`403` deixaram de contar como pronto. As cinco foram corrigidas,
e o `vendor/` do template foi ressincronizado com o `lib/`.

**O que ficou de fora, e por quê:**

- **A `porting.md` não menciona `transport: "socket"`.** Ele não existe ainda. Entra quando o passo 0
  entrar, e junto sai a frase do `schema:13` — *"o `id` vira path, **porta** e sentinel"* —, que hoje
  ainda é verdade.
- **Esta onda como exemplo trabalhado** da doutrina do `SKILL.md` está citada como plano, não como
  entrega. Vira exemplo quando o item 2 existir.

**Guarda:** `tests/docs-sem-atalho.test.js` no toolkit, **10 casos, refutação 10/10** — cada mutação
feita na fonte real, com a linha de base verde antes e restaurada depois. Suíte do toolkit em
**288** (era 278).

Ela é de **junção**, e a forma veio de um problema: a frase errada continua aparecendo nos cinco
arquivos, porque toda correção **cita** o que estava escrito antes. Procurar a frase acusaria a
correção junto com o defeito. Então a pergunta não é *"a frase sumiu?"* — é *"a frase está
acompanhada do que a desmente, ali perto?"*.

> **⚠ E a refutação achou um defeito na guarda antes de ela guardar coisa nenhuma.** A primeira
> versão só cobrava o marcador **se** o texto antigo ainda estivesse no arquivo (`if (!frase) return`).
> Em três dos cinco a correção reescreveu a frase em vez de citá-la, o `return` disparava, e mutar o
> arquivo deixava o teste **verde**: a guarda media dois arquivos e fingia medir cinco. É o defeito
> de instrumento outra vez — medir onde é fácil chegar em vez de medir o que se quer saber —, e é o
> segundo desta onda a aparecer antes de custar alguma coisa. A versão de hoje cobra o marcador de
> forma incondicional e **por vizinhança**, porque um "Onda 4" no outro extremo do arquivo não
> corrige o parágrafo do healthcheck.

---

## 8. 📋 O fim de vida de um vssh-app — hoje não existe, e a conta escala

**Este item é de PLATAFORMA, e não do editor.** Quem o revelou foi o editor, porque é o primeiro
app do ambiente que segura um processo caro; mas o que falta falta para todos.

### A medida que abriu o assunto

Fechar a janela de um app **não encerra nada**. `POST /api/apps/:id/stop` existe (`apps.ts:371`) e
**ninguém o chama**: uma varredura no `vssh-client/` não acha uma única invocação a partir do
fechamento de janela. O `close()` do `VsshAppWindow` tira a janela da tela e pronto. O backend vive
até a sessão acabar.

O sintoma chegou por quem usa: *"no desempenho os apps aparecem rodando mesmo quando fechado"*. A
tela está certa; o comportamento é que nunca foi decidido.

**E a conta não é por app: é por (usuário × app já aberto uma vez).** Um app que alguém abriu em
março continua ocupando RAM em agosto, em toda sessão daquela conta, sem uma janela na tela. Com o
editor isso deixa de ser detalhe — o motor sobe um extension host e o que ele carregar fica.

⚠ **E o número ainda não existe.** Os 9,3 GiB medidos no passo 0 são de uma **sessão inteira**, não
do motor ocioso. **A primeira coisa deste item é medir o RSS do editor sem cliente conectado**, e
qualquer teto escrito antes disso é decoração — foi o que já aconteceu com o `resources` do
manifesto (`3G`/`6G`), que está declarado e é ponto de partida, não medida.

### Mas "fechou, morreu" está ERRADO para os apps que mais custam

E a prova está no log da primeira sessão real do editor:

```
[reconnection-grace-time] Extension host: read VSCODE_RECONNECTION_GRACE_TIME=10800000ms (10800s)
```

**Três horas.** O servidor do VS Code é construído para **sobreviver ao navegador** — é assim que o
terminal integrado, um build rodando e o extension host continuam vivos quando se fecha a aba e se
volta depois. Encerrar no fechamento da última janela mataria o terminal de quem foi almoçar.

O xpra diz o mesmo por outro caminho: o incidente de 11/08 registrou **como ganho** a sessão X11
sobreviver a um reinício do backend. Ali, encerrar ao fechar a janela mataria a sessão inteira.

Então a resposta certa não é "sim" nem "não" — é que **o padrão de hoje é implícito e único**
("nunca encerra"), e ele foi escolhido por omissão.

### O contrato, e por que ele não cabe no `kind`

`kind: "app" | "service"` governa **start automático e supervisão**. Fim de vida é outra pergunta, e
colá-la ali seria juntar duas decisões numa chave — o defeito que esta casa já pagou noutros eixos.

| `backend.aoFechar` | Para quem | O que acontece ao fechar a última janela |
|---|---|---|
| `"encerrar"` (**padrão**) | app sem estado vivo — visualizador, editor de nota, painel | o shell chama o `stop` |
| `"manter"` | quem é dono de sessão de terceiro | fica; quem o mantém vivo é o trabalho, não a janela |
| `"ocioso:<N>m"` | o meio-termo, e o certo para o editor | fica, e encerra sozinho depois de N minutos **sem cliente e sem processo filho ativo** |

`"encerrar"` é o padrão porque é o que a maioria dos apps quer e é o que a pessoa espera de um
desktop — e porque um padrão que vaza memória tem de ser o que se escolhe, não o que se herda.

**Para o `vscode` o valor é `ocioso`, não `manter`**: casa com as 3 h do próprio upstream e resolve a
queixa de verdade — RAM parada some sozinha, terminal em uso não morre. O `N` sai da medida, não do
gosto.

### O que a implementação tem de responder, e nenhuma resposta é óbvia

- **Quem conta as janelas.** É o shell que sabe (`app-varias-janelas.test.js` já mede N janelas por
  app), mas quem encerra é o portal. Contagem no cliente decidindo desligamento no servidor é uma
  ponte nova, e ela erra quando o navegador morre sem avisar.
- **"Sem processo filho ativo" é o pedaço difícil.** Um motor de editor sempre tem filhos; o que
  importa é se algum deles é um terminal de alguém. Sem uma resposta boa aqui, `ocioso` vira um
  temporizador que mata trabalho — pior que não ter.
- **A aba fechada sem `unload`** (queda de rede, navegador morto) não pode deixar o app vivo para
  sempre nem encerrá-lo cedo demais. O relógio do ocioso é o que cobre os dois casos, e é mais uma
  razão para ele ser o valor do editor.

**Guarda:** `tests/unit/fim-de-vida-de-app.test.js` — fechar a última janela de um app `encerrar`
chama o `stop` **uma vez**; fechar uma de duas não chama nenhuma; um app `manter` nunca é encerrado
por fechamento; e o relógio do `ocioso` não dispara enquanto houver cliente. Refuta: trocar o padrão
por `manter` tem de ficar vermelho — porque o padrão é a metade que decide a conta de memória.

---

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 0a | ✅ **medido** — OpenSSH 10.2 nas duas pontas, `/home` ext4, socket no `$HOME` testado, F2 rodado | — | — |
| 0b | ✅ **o contrato** — `transport`, `escutar()`, o portão do `vssh-app-run`, os cinco manifestos, o `minShellVersion` | toolkit + `vssh-sso` | 0a |
| 0c | ✅ **o caminho do portal** — endereço derivado com fonte única, sondagem por `--unix-socket` com `sudo -u`, o lado remoto do túnel, o túnel logando como o **dono**, e o "pronto" medindo o **outro lado**; o cliente vai a **4.1.1** | `vssh-sso` | 0b |
| 0d | ✅ **a porta do túnel é NOSSA** — decidida no portal, e o `ss -tlnp` remoto sobra só para `tcp` | `vssh-sso` | 0c |
| — | ➜ **o resto do 0d virou o [item 5 da Onda 10](09-motor-x11.md)** — os onze lugares, o `nextLoopback` e o teto de 254 só ficam sem assunto quando o xpra sair do `tcp` | `vssh-sso` | ⛔ Onda 10, item 2 |
| 1 | ✅ **feito** — o pacote (32.646 bytes) e o motor (272,1 MiB) entregues por `installCommand`, instalados num servidor real | `vsshapp-vscode` | 0c |
| 2 | 📋 o fork: workbench nosso + o patch da plataforma | `vsshapp-vscode` | 1 |
| — | **publicar e instalar em TODOS os servidores** | | 1, 2 |
| 3 | 📋 `/proxy/vscode/` deixa de existir | `vssh-sso` | ⛔ o passo acima |
| 3a | 📋 `changeOrigin`/`xfwd` ganham dono medido | `vssh-sso` | 3 |
| 4 | 📋 o contrato de contribuição | toolkit + `vssh-sso` | — |
| 5 | 📋 a extensão VSSH | `vsshapp-vscode` | 2, 4 |
| 6 | ✅ **feito** — o corpo de um pedido proxiado é do outro lado; e "413" era 500 | `vssh-sso` | — |
| 7 | ✅ **a revisão da documentação — feita** | toolkit | — (o que dependia de 0b e 2 ficou de fora, e está dito no item) |
| 8 | 📋 **o fim de vida de um vssh-app** — hoje não existe, e a conta escala por (usuário × app já aberto) | toolkit + vssh-sso | — (é de plataforma; o editor só foi quem revelou) |

**A dependência dura é uma só, e é onde a onda pode machucar alguém:** enquanto um servidor não tiver
o app, `/proxy/vscode/` é o único caminho até o editor. E há um agravante que a 2.7 não teve — lá o
registro de motores mediava; aqui `handles: "vscode"` é **preferência de usuário**
(`categoryHandlers.vscode`, lida em `VsCodeLauncher.js:53-60`), que vive no portal, enquanto o app
vive no servidor. **Ninguém confere que os dois concordam.** Antes de delegar, o shell tem de checar
em `GET /api/apps` que o app existe **naquele servidor** e falhar com nome — "VS Code não está
instalado neste servidor" — em vez de abrir uma janela que dá 502.

**E um passo que parece redundante e não é:** repetir a medida de plataforma **contra o app**. A
medida que autoriza a onda foi feita contra o code-server de hoje; se o pacote novo mudar
`product.json`, `--extensions-dir` ou a versão, a resposta pode mudar. Medida de uma configuração é
a medida daquela configuração.

## Verificação

- **A fonte:** toda afirmação sobre o VS Code com caminho:linha do commit `66fe4158`, registrado no
  topo. Afirmação sem linha não entra.
- **O servidor:** os números vieram de sonda de leitura. Quatro respostas dela eram artefato do
  instrumento (`extensionsGallery: AUSENTE` era o arquivo errado; o 404 da Marketplace era `GET` num
  endpoint de `POST`; `bus: NÃO existe` era `XDG_RUNTIME_DIR` vazio numa sessão SSH; "1 conta com
  code-server" era `$HOME` alheio ilegível — o `ps` viu o que o `ls` não vê). Estão ditas como tais,
  e uma delas **decidiu onde o socket mora**. **Medida que não vem simplesmente não aparece.**
- **As três medidas do passo 0** (`ssh -V`, versão do sshd, `stat -f /home`) vêm **antes** da primeira
  linha de código, e uma resposta negativa muda o item em vez de ser contornada.
- **Cada guarda por refutação:** mutar a fonte real, rodar o teste filtrado, restaurar, com linha de
  base verde antes. Guarda que não fica vermelha ao quebrar o produto não mede nada.
- **A guarda do 2a é de junção** — mede os **dois** caminhos de resolução de plataforma, não um.
- `npm test` do `vssh-sso` parte de **1.362** e não pode cair. **⚠ Este número dizia 1.266, e estava
  velho** — a suíte cresceu entre a escrita da onda e a execução dela, e um piso desatualizado é um
  piso que não segura nada.

## O que esta onda NÃO faz

- **Não migra os apps existentes para socket de uma vez.** `transport` tem default `"socket"` para
  manifesto novo; os quatro apps já instalados migram um a um, cada um com o F2 rodado antes e
  depois. Virar tudo num dia é como se troca um mecanismo sem saber qual app quebrou.
- **Não torna o VS Code o editor padrão do shell** (`handles: "editor"`). Subir um workbench para
  abrir um `.txt` é pior que o editor embutido, e a escolha já é do usuário, por categoria.
- **Não mexe no `code` desktop dentro do X11.** Ele é servido pelo motor X11, não pelo proxy, e no
  item 2 ele passa a compartilhar `~/.vscode/extensions`. Mexer nas duas pontas de um diretório
  compartilhado na mesma onda é como se esconde uma regressão.
- **Não entrega menubar de aplicação nem atalho global.** `docs/api.md:869-870` os lista como
  inexistentes, e a leitura confirmou: o menubar é DOM do workbench e não há serviço exposto.
  Consequência concreta: `Ctrl+W`, `Ctrl+N` e `Ctrl+T` continuam do navegador. **Não é regressão —
  hoje é igual** —, mas é o limite da promessa "desktop-like", e limite não dito vira decepção.
- **Não substitui o seletor de arquivo nem o menu de contexto do editor.** Os dois são
  `registerSingleton` no import; trocá-los é patch que **substitui** uma camada que o VS Code já tem,
  e a regra de `porting.md:169-171` proíbe exatamente isso. O que os cobre é a extensão do item 5.
- **Não migra para a Marketplace da Microsoft.** É decisão de licença, não de engenharia, e **nenhum
  teste guarda um ToS**.

## Próximos passos, registrados para não sumirem

- **O OnlyOffice é o último inquilino do modelo especial, e é outro problema.** Ele proxia um
  **container compartilhado do portal** (`proxy.ts:471`, `ONLYOFFICE_INTERNAL_PORT`), não um processo
  por usuário: não há porta aritmética, não há processo solto, não há cookie derivado de senha. Uma
  onda dele teria de responder (i) container compartilhado × processo por usuário; (ii) o JWT de
  callback do save (`routes/office.ts:283-286`); (iii) o mount `/cache` **sem sessão de usuário**
  (`proxy.ts:214-237`); (iv) a taxonomia de extensões duplicada JS↔TS (`routes/office.ts:56-70` ×
  `FileOpener.js:25-30`, com o comentário *"manter os dois em sincronia"*). **E o item 4 é
  pré-requisito dela** — enquanto não houver contrato de contribuição, o editor de Office continua
  sendo cascata `if/else` e sempre o primeiro no "Abrir com".
- **`IframeHostWindow` morre quando os dois inquilinos saírem.** A classe existe declaradamente para
  code-server e OnlyOffice (`IframeHostWindow.js:3-13`). Esta onda tira um; a de Office tira o outro,
  e a classe sai junto.
- **O `VSSH_APP_PORT` só pode ser apagado do contrato quando nenhum app declarar `tcp`.** Enquanto um
  declarar, o campo continua no schema — e o dia em que o último sair é o dia de tirar o fallback
  `40000 + (UID % 10000)` do `vssh-app-run`, que é a última aritmética de porta que restou no
  ambiente.
