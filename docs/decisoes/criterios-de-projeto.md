# Os três critérios de projeto

Três perguntas que todo vssh-app atravessa antes de virar trabalho. As duas primeiras puxam em
direções opostas, e é por isso que precisam ser feitas juntas: a primeira decide **como entregar**,
a segunda decide **onde guardar**. A terceira decide se aquilo pode ser considerado pronto.

Elas não são etapa de revisão. Um app que reprova na segunda não está pronto para ser portado —
está pronto para ser redesenhado, e [`../porting.md`](../porting.md) é onde essa conversa começa.

## 1 · O navegador já faz isso?

Tratar *"não existe no VSSH"* como sinônimo de *"precisa ser construído no VSSH"* é caro. Um
vssh-app roda num navegador, e várias capacidades já estão a um `if` de distância: `BroadcastChannel`
para falar com outro app, `navigator.wakeLock` para um job longo, WebGPU e `OffscreenCanvas` para um
visualizador, Media Session para controles de mídia.

O critério tem **dois limites**, e ignorá-los é o erro que ele existe para evitar.

### Limite 1 — o desktop roda em tela cheia

Se a resposta a *"onde isso aparece?"* for *"numa parte do navegador que não existe em tela cheia"*,
não resolve. Notificação do sistema operacional e badge de PWA são **complemento** ao que o ambiente
oferece (`vssh.notify`, a bandeja), nunca substituto.

### Limite 2 — o artefato nasce no ambiente remoto

Toda API de navegador que **produz** algo — PDF, gravação, arquivo baixado — deposita na máquina do
cliente por padrão. Isso quebra a promessa inteira: o pesquisador troca de computador e o que ele
produziu ficou para trás.

O destino padrão é o ambiente remoto; a máquina do cliente é exceção explícita. `window.print()`
imprime no cliente e por isso **não** cobre "PDF no ambiente" nem impressora de rede — quem cobre é
`vssh.print()`, que oferece os destinos do ambiente. `getDisplayMedia`/`MediaRecorder` têm a mesma
forma: gravam para o lado errado se ninguém disser o contrário.

### O caso que não passa, e por quê

`SharedArrayBuffer` — necessário para WASM multi-thread (DuckDB-WASM, Pyodide com threads) — exige
cross-origin isolation (COOP `same-origin` + COEP `require-corp`), o que interage com o modelo de
iframe do app e com o proxy. **Não é decisão de um app**, e habilitar depois quebra o que já
estiver embutido sem CORP. Um app que dependa disso hoje não tem caminho.

## 2 · Isso sobrevive à troca de máquina?

O pesquisador deve poder pular de um computador para outro sem perder nada. Isso torna **todo
estado guardado no navegador uma dívida**.

### OPFS é cache, nunca a verdade

O padrão natural do `sqlite-wasm` é usar OPFS como armazenamento **primário**, e isso perde tudo ao
trocar de máquina, sem erro nenhum. A verdade vai para o ambiente remoto — o filesystem do usuário
por `showDirectoryPicker()`, ou o backend do próprio app. OPFS é aceleração **reconstruível**: se
ele sumir, o app fica lento, não amnésico.

A alternativa — tratar OPFS como durável — é o que quase todo tutorial de WASM ensina, e o custo
dela não aparece em teste nenhum: aparece no dia em que a pessoa senta noutra máquina. A regra
operacional está em [`../api.md`](../api.md#opfs--cada-app-tem-a-sua-raiz-e-ela-é-cache), junto da
API.

### Armazenamento do navegador tem o escopo do NAVEGADOR, não o do ambiente

Vale além do OPFS, e é a lição que ele custou. OPFS é privado por **origem**, e todos os vssh-apps
são servidos pela origem do portal: sem isolamento, um app lia e sobrescrevia o `cache.db` de
outro. O *"Origin Private File System"* é privado de outros **sites**, não de outros **apps** — e
quem escreve um vssh-app assume a segunda coisa, porque é o que o nome promete.

O polyfill passou a dar a cada app um subdiretório próprio. Mas `localStorage`, `IndexedDB` e
cookies estão sob a mesma origem única e merecem a mesma pergunta: **de quem é este espaço aqui
dentro?** Antes de usar uma API de armazenamento, responda isso.

É a mesma razão pela qual outro app da sua sessão escuta os seus `BroadcastChannel`. Não mande por
ali o que você não mandaria por um mural.

### O grant de arquivo não é fronteira de segurança

O modelo de permissão da File System Access API nasceu no navegador porque os arquivos são da
máquina do usuário e o web app é código de terceiro. Aqui o caminho está no ambiente remoto, e o
**backend do próprio app já roda como aquele usuário Linux, com acesso POSIX a tudo** que o grant
protegeria.

Para caminho remoto o grant é, portanto, duas coisas menores e úteis: UX (o seletor é como o usuário
diz *"esta pasta"*) e rede contra erro de programação. Sendo preferência e não segurança, ele
**sincroniza no servidor** — e é por isso que um app volta funcionando noutra máquina sem o usuário
reescolher a pasta.

São dois regimes na mesma API, e confundi-los produz respostas ruins:

| Regime | De quem é a permissão | Sincroniza? |
|---|---|---|
| Caminho **remoto** (polyfill FSA) | nossa | sim — é preferência |
| Caminho **local do cliente** (FSA nativa do Chrome/Edge) | do navegador | não — é por máquina, por natureza |

### A pergunta da autoridade é outra pergunta

*"Onde isto sobrevive?"* e *"quem é a autoridade sobre isto?"* são diferentes. A autoridade sobre a
hora é uma referência externa; a **preferência** sobre como exibi-la é do usuário, e só a segunda
atravessa este critério. Um valor detectado do navegador é bom como default de quem nunca escolheu,
e ruim como resposta.

## 3 · Está BELO?

Este produto é um ambiente de desktop completo, e a promessa dele é que o usuário esqueça que está
num navegador. Um `<select>` com aparência nativa, uma scrollbar cinza do sistema no meio de uma
janela escura, campos sem hierarquia — cada um denuncia que aquela tela é remendo.

**Por que isso é critério e não gosto:** o custo não é estético, é de confiança no ambiente inteiro.
A pessoa que vê uma tela feita às pressas passa a duvidar do que mais foi feito assim.

O critério alcança **todo vssh-app**, e essa é a parte que costuma escapar: um app não é item de
plano interno, é pacote publicado por fora — então o critério que existe para o usuário esquecer que
está num navegador precisa alcançar justamente as janelas que mais parecem uma página web dentro de
outra.

O que ele exige na prática está entregue em [`../ui.md`](../ui.md), e adotar a biblioteca resolve a
maior parte. As duas armadilhas que sobram:

- **Superfície delegada fica delegada.** Diálogo, menu de contexto, aviso, bandeja e seletor são do
  ambiente, pedidos por `vssh.*`. Uma versão desenhada dentro do app fica **presa no iframe**: não
  cobre a janela, não sobrevive a tela cheia, e não aparece por cima do resto. Um `<div>` com
  `position: fixed` dá a impressão de diálogo até alguém maximizar.
- **Procurar o vocabulário existente não é procurar pelo nome que se espera.** A ausência de um nome
  não é a ausência da coisa — e a conclusão apressada vira uma variante nova para manter. Antes de
  escrever CSS, leia o que está lá.

**Limite honesto, para o critério não virar promessa vazia:** há superfície que não se alcança. A
scrollbar de dentro do visualizador de PDF do Chrome é outro documento, servido por um plugin, e
nenhuma regra nossa a atinge. Nesses casos a entrega é não somar a nossa feiura à dele, e dizer que
o limite existe.
