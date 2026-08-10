# Onda 10 — O motor X11 para de ser um cliente hospedado: nós servimos a página, e as janelas dele viram nossas

> **Estado:** 📋 **planejada — e a medida veio antes, na Onda 9.** As três respostas que decidem esta
> onda foram tiradas de um xpra **6.5.2 de produção**, não da documentação dele.
> · **Atualizado:** 2026-08-10
>
> **Repos:** `vsshapp-xpra` + `vssh-sso`
>
> **Depende do [passo 0 da Onda 9](08-editor-do-ambiente.md)**, que já entregou o contrato de
> transporte. **É esta onda que fecha aquele passo:** enquanto ela não rodar, o `xpra` é o único app
> do ambiente declarando `backend.transport: "tcp"` — e enquanto UM declarar, o `_reconcileAppPort`,
> o cache de porta, o `nextLoopback` e o teto de **254 servidores** continuam de pé para servir a
> ele.
>
> ### O que a medida disse antes de a onda começar
>
> | A afirmação | O que a medida disse |
> |---|---|
> | "o xpra é `binary`, provavelmente nem sabe bindar socket" | **Errado — foi meu, e ao contrário.** O transporte NATIVO do xpra é socket unix (`~/.xpra/`); ele usa `--bind-tcp` porque **o lifecycle só sabia dar porta** |
> | "então basta trocar `--bind-tcp` por `--bind`" | **Não basta.** `--bind-ws` aceita só `[HOST]:[PORT]`; com caminho responde `xpra initialization error` |
> | "o xpra precisa servir o cliente HTML5" | **Não precisa, e o `--html` aponta para a NOSSA pasta.** Com `--html=off` o WebSocket continua respondendo `101` |
> | "o socket nativo não fala com a gente" | **Fala.** `connect()` cru abre e fica de pé; a um pacote malformado ele **espera o resto** em vez de fechar |
>
> **Duas medidas anteriores mediram a coisa errada com o instrumento errado**, e estão registradas
> na [Onda 9](08-editor-do-ambiente.md#o-xpra-é-o-único-que-fica-em-tcp-e-isso-foi-medido-com-controle):
> eu testava `--bind` (o socket do protocolo nativo, que não fala HTTP por desenho) com um cliente
> HTTP, e lia `/tmp/x.log`, que só tem o preâmbulo do modo daemon. **A pergunta certa não era sobre
> socket** — era *por que o xpra está servindo o nosso HTML*.

---

## A inversão, numa linha do `entrypoint.sh`

```sh
# vsshapp-xpra/backend/entrypoint.sh:185-186
  --bind-tcp="127.0.0.1:${VSSH_APP_PORT}" \
  --html="${AQUI}/frontend" \
```

**`${AQUI}/frontend` é o nosso próprio diretório.** Não é o xpra nos dando um cliente — somos nós
entregando a nossa pasta e pedindo que ele seja um servidor de arquivo estático. É a única razão de
existir uma camada HTTP no bind dele, e é por isso que a porta não sai enquanto isso não mudar.

O comentário de `:11` já dizia metade: *"`--bind-tcp` na porta que o lifecycle alocou, e SÓ nela"* —
a porta veio do que o lifecycle sabia dar, não do que o xpra precisa.

---

## 1. 📋 Nós servimos a página; o xpra fica com o protocolo

O backend do app passa a servir `frontend/` com o `static-spa` do toolkit — que é o que todo outro
vssh-app já faz — e o xpra sobe com **`--html=off`**.

O endereço do WebSocket **já é configurável**: o cliente monta a URI de `host`/`port`/`path`
(`Client.js:535`, `Protocol.js:193`), e `motor/xpra-engine.js:738-744` registra a briga que isso já
deu. Metade da inversão sempre esteve pronta.

**Guarda:** `tests/serve-o-proprio-frontend.test.js` — com `--html=off`, `GET /` do backend devolve o
`index.html` do pacote e o upgrade de WS devolve `101`. Refuta: devolver o `--html` ao xpra; o teste
tem de ficar vermelho **por servir a página de outro lugar**, não por deixar de servir.

## 2. 📋 A ponte que desembrulha o WebSocket, e a porta some

O listener de WS do xpra **não aceita caminho** (medido), então a ponte não pode ser um cano de bytes
cru. O que fica de pé: o nosso backend termina o WebSocket do navegador e escreve o payload no
`--bind` unix nativo — **o mesmo protocolo que vai dentro dos frames binários**. São dezenas de
linhas com o `ws`, que o `vssh-sso` já usa.

**O que ainda não está provado, e é implementação e não medida:** `connect()` de pé prova que o
transporte está aberto, não que o protocolo atravessa. A primeira guarda desta onda é o handshake
completo — o cliente HTML5 conectando pela ponte e desenhando uma janela.

Feito isto, o manifesto do xpra troca `transport: "tcp"` por `"socket"`, e **o ambiente fica sem
nenhum app em porta**.

**Guarda:** `tests/ponte-ws-socket.test.js` — sobe um xpra de mentira no socket nativo, conecta pela
ponte e confere que o `hello` do protocolo volta. Refuta: cortar a ponte no meio de um frame; o teste
tem de acusar, e não travar (a lição do passo 0: teste que trava é pior que vermelho).

## 3. 📋 As janelas do xpra viram `VsshWindow`

Hoje o cliente do xpra traz o **próprio gerenciador de janelas**: `frontend/js/Window.js`, **1.501
linhas** — barra de título, botões, minimizar, arraste —, desenhando por cima do desktop que já tem
tudo isso.

E o ambiente paga por essa diferença **do outro lado**. `VsshWindow.js:101-108` diz por extenso:

> *"o canvas do Xpra captura o ponteiro mesmo onde é transparente. Por isso cada janela mantém um
> **proxy invisível** dentro do `#screen`: é ele, e não o conteúdo, que recebe os eventos."*

E registra o dano junto: *"arrastar um arquivo para outra janela do gerenciador nunca chegava aos
handlers de drop dela"*. São **47 ocorrências de `proxy`** naquela classe, mais a dança de
`_dragRaised`/`_dragHooked` — elevar sem focar, porque focar B desfoca A e **reativa o proxy de A**,
quebrando o arraste de volta.

**Nada disso é otimizável: é apagável.** Se cada janela X11 for uma `VsshWindow` de verdade, não há
canvas alheio capturando ponteiro, não há proxy, não há elevação-sem-foco.

**Guarda:** `tests/unit/arraste-entre-janelas.test.js` — arrastar um arquivo de uma janela do
gerenciador para outra chega ao handler de drop **com uma janela X11 aberta na tela**. É o defeito
que o comentário descreve, virado teste. Refuta: reintroduzir o canvas em tela cheia por cima.

## 4. 📋 O último jQuery do ambiente sai — e ele é o maior

A [Onda 8](07-shell-proprio.md) tirou o jQuery do shell (**824 KB a menos**) e fechou. **O ambiente
continua entregando jQuery ao navegador**, escondido dentro deste app:

| | |
|---|---|
| `frontend/js/lib/jquery-ui.js` | **19.061 linhas** |
| `frontend/js/lib/jquery.js` | **10.716 linhas** |
| `frontend/js/lib/slick.js` | **3.011 linhas** |
| `frontend/` inteiro | **2,3 MB**, 31 arquivos |
| **call sites de `$(` no cliente** | **35**, em três arquivos |

**Trinta mil linhas para 35 chamadas** — e as chamadas são `.parents()`, `.closest()`, `.addClass()`
e `.css()` (`Window.js:144,228,369,1234`), que são uma linha de DOM cada. O item 3 já apaga
`Window.js`, que é onde a maioria delas mora.

> É a mesma forma do achado da Onda 8: *"a premissa do jQuery estava invertida, e a medida diz de que
> lado"*. Lá o shell tinha menos jQuery do que se dizia; aqui o ambiente tem mais, e num lugar onde
> ninguém procurou.

**Guarda:** o teste que a Onda 8 deixou, apontado para o pacote — nenhum `<script>` de jQuery servido
por app nenhum. Refuta: revendorizar a lib.

---

## A ordem, e por que ela é essa

| # | O quê | Repo | Trava em |
|---|---|---|---|
| 1 | 📋 nós servimos o `frontend/`; xpra com `--html=off` | `vsshapp-xpra` | — |
| 2 | 📋 a ponte WS → socket nativo, e o `transport` vira `socket` | `vsshapp-xpra` | 1 |
| — | **o ambiente fica sem nenhum app em porta** | | 2 |
| 3 | 📋 as janelas viram `VsshWindow`; os 47 proxies saem | `vsshapp-xpra` + `vssh-sso` | 1 |
| 4 | 📋 o jQuery sai do pacote | `vsshapp-xpra` | 3 |
| — | ⛔ **[Onda 9, passo 0d](08-editor-do-ambiente.md)**: a orquestração de porta morre | `vssh-sso` | 2 |

**O item 1 destrava tudo e não depende de nada**, porque servir o próprio frontend é o que todo
vssh-app já faz. O item 3 não espera a ponte: assim que a página for nossa, o cliente é nosso para
reformar.

**E a dependência que sai desta onda para outra:** enquanto o item 2 não fechar, o `vssh-sso` não
pode apagar a orquestração de porta — ela existe hoje **para servir um app só**, e o custo disso está
medido: um `127.0.0.x` por servidor e um teto de 254.

## Verificação

- **Toda afirmação sobre o xpra com a medida ao lado**, feita na 6.5.2 de produção — a versão do
  archive do Ubuntu é outra e responderia sobre outra coisa.
- **O controle continua obrigatório.** A medida que decidiu esta onda só valeu porque o mesmo
  servidor serviu por TCP na mesma corrida; sem isso, "o socket não respondeu" seria a montagem do
  teste. Toda medida nova aqui carrega o par.
- **Cada guarda por refutação**, com linha de base verde antes e a fonte real mutada.
- `npm test` do `vssh-sso` parte de **1.362** e não pode cair.

## O que esta onda NÃO faz

- **Não troca o xpra por outro motor.** A pergunta "xpra ou Wayland/`wayvnc`/RDP" é de produto e não
  se responde de passagem; esta onda torna o motor **substituível**, que é o pré-requisito de fazê-la
  um dia. Quem serve a página passa a ser nosso, e o registro de motores da
  [2.7](02b-motores.md) já existe.
- **Não mexe no `IframeHostWindow`.** Ele existe declaradamente para code-server e OnlyOffice
  (`IframeHostWindow.js:3-13`) — o xpra nunca passou por ele.
- **Não promete que o cliente HTML5 aguenta ser dividido em N janelas** sem custo de render. É a
  incerteza real do item 3, e a resposta é uma medida com uma sessão de verdade — não uma frase
  aqui.
