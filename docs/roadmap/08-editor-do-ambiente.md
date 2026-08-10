# Onda 9 — O socket vira o endereço, e o VS Code vira nosso

> **Estado:** 📋 **planejada — medida antes de escrita.** A leitura da fonte do VS Code
> (`microsoft/vscode`, commit `66fe4158`, main de 2026-08-10) e uma sonda no servidor de produção
> vieram **antes** dos itens, e mudaram três deles. · **Atualizado:** 2026-08-10
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

**E o cliente foi a 4.1.1, por honestidade.** A `4.1.0` foi declarada como *"a release em que o
lifecycle passou a entregar o socket"* — e entregava, mas o portal não sabia chegar lá. Um app que
exigisse 4.1.0 instalava e não funcionava.

**Guardas:** três casos novos em `healthcheck-verdadeiro.test.js`, refutação **7/7** — inclusive
devolver o `-L` para `127.0.0.1:<porta>` e trocar o default do transporte para `tcp`. A suíte do
`vssh-sso` fica em **1.365 testes, 1.300 passando, 0 falhas**.

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

## 1. 📋 O pacote `vsshapp-vscode`

Repositório novo, no molde do `vsshapp-xpra`. `id: "vscode"`, `type: "app"`, `backend.transport:
"socket"` — o primeiro app a nascer no padrão do passo 0 — e **`kind: "app"`, não `"service"`**:
`service` liga start automático e auto-reinício com `MAX_FAILS=5` **sem reset por tempo**; um
workbench que ninguém abriu não deve consumir RAM, e um que caiu cinco vezes num mês não deve ficar
`failed` para sempre.

**A entrega está decidida pelo número.** 617 MB não passam por `git archive` + POST único, e o GitHub
recusa arquivo acima de 100 MB. O caminho é `installCommand`, e ele funciona porque no install como
root o `cwd` é `${WORKDIR}/pkg` — um `mktemp -d` **gravável** (`vssh-app-install:335`) — e o passo
seguinte é `rsync -a --delete` para `/opt/vssh-apps/<id>/` (`:348`). **O que o `installCommand`
baixar vai parar no diretório do app, root-owned, e o tarball publicado continua em centenas de KB.**
`vssh-app-publish` não muda.

Três regras que o comando tem de respeitar, cada uma já paga por outro app:

- **Idempotente e guardado**, porque ele roda de novo **por usuário** no primeiro `vssh-app-run`
  (`:219-227`), com `cwd` em `/opt/vssh-apps/<id>`, que é **somente leitura**. Sem guarda, a primeira
  abertura de todo usuário falha. O idioma é o do `terminal-latch`:
  `( [ "${VSSH_APP_REBUILD:-}" != 1 ] && test -x vendor/…/code ) || baixa`.
- **Versão fixada e `sha256sum` conferido** no próprio comando. É o conserto do achado do
  provisionador: hoje três arquivos dizem `4.126.0` e a máquina roda `4.127.0` — os três lugares que
  declaram a versão não descrevem o servidor.
- **`resources` declarado**, e não o padrão. 85% de 79 GB são 67 GB: não é teto, é decoração. O
  número de partida é a medida — 9,3 GiB numa conta ativa.

**Guarda:** `tests/instalacao-idempotente.test.js` — roda o `installCommand` duas vezes contra um
servidor HTTP que **conta requisições**; a segunda tem de baixar zero. Refuta: tirar o guard.

## 2. 📋 O workbench é nosso, e o motor é o servidor do VS Code

O backend do app serve **a nossa página**, que chama `create()` com o objeto de construção ligado no
`vssh.*`. O extension host continua sendo o servidor do VS Code, agora em socket unix (passo 0).

Entram de cara, todos com a linha citada acima: `workspaceProvider` → janelas do VSSH;
`productConfiguration.extensionsGallery` → a galeria é nossa; `initialColorTheme` +
`configurationDefaults` → tema `tuff` e barra de título esvaziada; `secretStorageProvider` → o cofre;
`resolveExternalUri` → navegador embutido; `serverBasePath`/`webSocketFactory` → o prefixo do proxy.

**Guarda:** `tests/unit/workbench-do-ambiente.test.js` — o objeto de construção declara os sete
provedores, e `IWorkspaceProvider.open` **não** cai no `window.open` de fora. Refuta: devolver
qualquer um deles a `undefined`.

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

## 4. 📋 O contrato de contribuição

| Superfície | Hoje | Depois |
|---|---|---|
| menu de contexto de arquivo, pasta, área de trabalho | `ContextMenu.js:823-831` não tem `register`; itens em `FileContextMenu.js:49-148`, `Desktop.js:912,929,948`, `arquivos/lateral.js:115,318` | `contributes.contextMenu` no manifesto, com **precedência declarada** |
| menu do ícone no Launchpad | três itens fixos (`ContextMenu.js:559-576`) | jump list vinda do manifesto — o que o Windows faz com o botão direito no ícone |
| "Abrir com" | o app entra **sempre depois** dos embutidos, atrás de um separador, com ícone fixo `apps` (`abrir-com.js:143-146`); o OnlyOffice é sempre o primeiro (`:77-83`) | ordem declarada e ícone do próprio app; nenhum produto hardcoded na frente |
| `opens.mimeTypes` | aceito, projetado e **nunca roteado** (`docs/api.md:700-702`) | roteado pelo mesmo portão |
| `handles` | enum fechado de 5, e `vscode` é o único valor que nomeia **um produto** (`schema:142-146`) | categoria, não nome de produto |
| `category` | sobrescrito por `'Apps Integrados'` (`Launchpad.js:73-75`) | volta a valer |

O molde é o `SettingsRegistry`, que já provou o formato. A regra é a da casa: **um portão, não N
`if`s**, e precedência declarada — porque dois apps vão querer o mesmo item de menu, e "quem carregou
primeiro" não é uma regra, é um acidente.

**O VS Code é o primeiro cliente dos dois lados.** Ele contribui com o ambiente — o item "Abrir no VS
Code" passa a vir do manifesto em vez dos três ramos hardcoded de `abrir-com.js:112-137` — e o
ambiente contribui com ele, pela extensão do item 5.

**Guarda:** `tests/unit/contribuicao-de-app.test.js` — um manifesto de mentira declara um item de
menu, e ele aparece no menu de contexto do gerenciador **e** o shell não cita o app pelo nome em
lugar nenhum. Refuta: voltar um dos itens para array literal.

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

## 6. 📋 O portão do body parser

`app.ts:96-97` registra `express.json()` e `express.urlencoded()` **globais**, com o limite default de
**100 kb**, e `setupProxyRoutes(app)` só entra em `:169`. **Todo vssh-app de hoje leva 413 em POST
JSON acima de 100 kb, antes de a requisição chegar ao proxy.** Nenhum app atual bate nisso — é
latente, não vivo — e um workbench o acordaria.

Não subir o limite global: registrar o proxy **antes** dos parsers, ou isentar `/:serverId/proxy/`.
**Um portão, não um `if` por app.**

**Guarda:** POST JSON de 200 kb para `/x/proxy/app/y/` chega íntegro. Refuta: devolver
`setupProxyRoutes` para depois dos parsers.

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

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 0a | ✅ **medido** — OpenSSH 10.2 nas duas pontas, `/home` ext4, socket no `$HOME` testado, F2 rodado | — | — |
| 0b | ✅ **o contrato** — `transport`, `escutar()`, o portão do `vssh-app-run`, os cinco manifestos, o `minShellVersion` | toolkit + `vssh-sso` | 0a |
| 0c | ✅ **o caminho do portal** — endereço derivado com fonte única, sondagem por `--unix-socket` com `sudo -u`, o lado remoto do túnel; o cliente vai a **4.1.1** | `vssh-sso` | 0b |
| 0d | 📋 **a orquestração de porta morre** — os onze lugares, o `nextLoopback` e o teto de 254 | `vssh-sso` | 0c + ⛔ [Onda 10, item 2](09-motor-x11.md) |
| 1 | 📋 o pacote e a entrega por `installCommand` | `vsshapp-vscode` | 0c |
| 2 | 📋 o fork: workbench nosso + o patch da plataforma | `vsshapp-vscode` | 1 |
| — | **publicar e instalar em TODOS os servidores** | | 1, 2 |
| 3 | 📋 `/proxy/vscode/` deixa de existir | `vssh-sso` | ⛔ o passo acima |
| 3a | 📋 `changeOrigin`/`xfwd` ganham dono medido | `vssh-sso` | 3 |
| 4 | 📋 o contrato de contribuição | toolkit + `vssh-sso` | — |
| 5 | 📋 a extensão VSSH | `vsshapp-vscode` | 2, 4 |
| 6 | 📋 o portão do body parser | `vssh-sso` | — |
| 7 | ✅ **a revisão da documentação — feita** | toolkit | — (o que dependia de 0b e 2 ficou de fora, e está dito no item) |

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
