# Roadmap do ecossistema vssh-app

> **Atualizado:** 2026-08-08

Este diretório é o plano vivo do ecossistema VSSH — portal (`vssh-sso`), shell de desktop
(`vssh-client/`) e este toolkit. Não é um documento de uma vez só: **cada arquivo tem cabeçalho
de estado e é para ser atualizado conforme avançamos**, não reescrito.

## A estrela-guia

O ambiente é **remoto e portátil**: o pesquisador senta em qualquer máquina, abre o navegador e tem
ali todos os recursos — que **não dependem daquela máquina**. Tudo aqui é julgado por esse critério.

Duas consequências que precisam estar ditas antes de qualquer tabela:

1. **"Sem apps Linux" ≠ "sem servidor Linux".** O modelo vssh-app exige um host Linux rodando
   backends; o que sai de cena é o **X11**, não a máquina. Sem essa distinção, metade das decisões
   abaixo parece contraditória.
   **E a formulação mudou:** falávamos em "perfil headless" e "ambiente xpraless" — as duas
   descrevem o ambiente pelo que FALTA nele, e isso produziu dois perfis a manter e a leitura de
   que um deles é a versão reduzida. Ele não é. A [Onda 2.7](02b-motores.md) inverte: existe **um**
   ambiente, e o Xpra é um **motor** que ele pode ter — como o Scramjet é o motor que ele pode ter
   para a web. O que hoje chamamos de "xpraless" passa a ser simplesmente **o ambiente**.
2. **Toda capacidade que depende da máquina do cliente é ponte para fora, não recurso do ambiente.**
   Útil, às vezes a única opção — mas nunca a resposta para "o ambiente tem X".

## Como ler

| Arquivo | O que tem |
|---|---|
| [diagnostico.md](diagnostico.md) | Onde estamos: matriz de prontidão sem-X11, dívidas do toolkit e da plataforma, questões em aberto |
| [casos-de-uso.md](casos-de-uso.md) | 20 arquétipos de aplicação, motor e daemon — e o que bloqueia cada um |
| [criterios.md](criterios.md) | Os três critérios de projeto que toda decisão atravessa — o navegador já faz isso, sobrevive à troca de máquina, e está belo |
| [00-limpeza-de-terreno.md](00-limpeza-de-terreno.md) | Onda 0b — limpeza do `vssh-sso`: exclusões, renames, provisionador unificado |
| [0c-colapso-de-variantes.md](0c-colapso-de-variantes.md) | Onda 0c — matar o tema `neon` e o modo `dock`: uma variante de UI, não duas |
| [01-sessao-sem-xpra.md](01-sessao-sem-xpra.md) | Onda 1 — desacoplar o ciclo de vida da sessão do Xpra |
| [02-apis-de-shell.md](02-apis-de-shell.md) | Onda 2 — tray, notificações, relógio, clipboard, impressão, mixer, Configurações |
| [02b-motores.md](02b-motores.md) | Onda 2.7 — um ambiente só, e o Xpra vira um motor dele |
| [02c-interludio.md](02c-interludio.md) | Onda 2c — recolher o que a inversão deixou: deploys mortos, fingerprint do cliente, sessão que expira em uso |
| [03-toolkit.md](03-toolkit.md) | Ondas 0 e 3 — higiene do toolkit e a FSA de verdade |
| [04-runtime-composicao.md](04-runtime-composicao.md) | Ondas 4 e 5 — limites de recurso, GPU, composição entre apps |
| [05-arquivos-de-rede.md](05-arquivos-de-rede.md) | Onda 6 — camada de arquivos de rede sem salto pelo Linux |
| [06-portabilidade.md](06-portabilidade.md) | Onda 7 — continuidade entre máquinas |

**A numeração não é sequência total.** Ondas 0, 6 e 7 não dependem das outras e podem correr em
paralelo. Só a Onda 2 depende da 1; a Onda 3 é pré-requisito real do arquétipo **A3** — A4 e A5
dependiam da Onda 4 (várias janelas, entregue) e da 2 (clipboard, entregue), não da FSA. A
**Onda 0c é pré-requisito da 2.6** e recomendada antes da 2.2 — enquanto houver duas variantes de
UI, cada superfície nova nasce com duas para manter.

A **[2.7](02b-motores.md) é a mesma frase num eixo maior**: dois perfis são duas variantes, e cada
superfície nova nasce com duas para especificar e verificar. Ela era "Onda 8", no fim da fila, e foi
puxada para logo depois da 2.6 — **para que as ondas 3 a 7 já partam de um ambiente só**.

E ela não é uma aposta: **a primeira metade dela já foi executada e medida.** Quando o desktop
deixou de ser servido pelo processo Xpra, oito mecanismos de orquestração de porta — alocação,
senha de socket, túnel `ssh -L`, dois caches, espera ativa — não ficaram menores, **ficaram sem
assunto**, e abrir o desktop deixou de gastar canal SSH num teto de ~8 por servidor. A segunda
metade é o Xpra como motor instalável: ele não serve cliente nenhum no ambiente novo, então os 23
arquivos que hoje falam o protocolo dele saem de `vssh-client/` e passam a viajar com o pacote do
motor — versionado, atualizável à parte, presente só onde o motor estiver. O que
torna isso urgente e não apenas desejável é a [Onda 5](04-runtime-composicao.md#registro-de-capabilities):
ela congela um contrato PÚBLICO, para gente de fora do repositório. Com dois perfis, esse contrato
exporta *"em que perfil eu estou"*; com motores, *"que motores existem aqui"* — e contrato publicado
não se reescreve numa tarde.

## Estado

| Onda | Item | Repo | Estado |
|---|---|---|---|
| 0 | Documentação da roadmap | toolkit | ✅ concluído |
| 0 | Higiene (versionamento, `lib/web/`, template, electron-shim, docs) | toolkit | ✅ concluído |
| 0 | Confinamento do `static-spa` (bug achado na verificação) | toolkit | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 1 — exclusões, aliases de compat, docs superadas | vssh-sso | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 2 — renames (`custom_xprahtml5` → `vssh-client` e cia.) | vssh-sso | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 3 — provisionador unificado + eixo headless | vssh-sso | ✅ concluído |
| 0c | [Colapso de variantes](0c-colapso-de-variantes.md) — fim do tema `neon` e do modo `dock` | vssh-sso | ✅ concluído |
| 1 | [Sessão desacoplada do Xpra](01-sessao-sem-xpra.md) | vssh-sso | ✅ concluído |
| 2 | [Canal shell↔app sem iframe](02-apis-de-shell.md#o-transporte-o-coletor-por-servidor---feito) — coletor por servidor | vssh-sso | ✅ concluído |
| 2 | [Tray](02-apis-de-shell.md#21--tray---concluída) — as duas fontes (janela e `engine`/`service`) | vssh-sso + toolkit | ✅ concluído |
| 2 | [Taskbar honesta](02-apis-de-shell.md#o-item-irmão-que-apareceu-ao-testar-a-taskbar-mentia---feito): capabilities + tela cheia no hambúrguer | vssh-sso | ✅ concluído |
| 2 | Pré-requisito: extrair o `/ws/events` do `Client.js` (`js/EventsChannel.js`) | vssh-sso | ✅ concluído |
| 2 | [Um index por modo](diagnostico.md#-resolvido-um-index-por-modo-sem-um-segundo-arquivo) — o perfil sem Xpra deixa de baixar 40,4% do JS | vssh-sso | ✅ concluído |
| 2 | Pré-requisito: helper `anchorPanel()` (`js/AnchorPanel.js`) | vssh-sso | ✅ concluído |
| 2 | [Relógio](02-apis-de-shell.md#o-relógio) — fuso do usuário, formatador único do shell | vssh-sso | ✅ concluído |
| 2 | [Centro de notificações](02-apis-de-shell.md#o-centro-de-notificações) — sino, histórico, identidade por app, "não perturbe" | vssh-sso | ✅ concluído |
| 2 | [Centro de notificações — journal no servidor](02-apis-de-shell.md#o-centro-de-notificações) — app sem janela notifica com o shell fechado | vssh-sso + toolkit | ✅ concluído |
| 2 | [Centro de notificações — `actions`, `persistent`, Notification API](02-apis-de-shell.md#o-centro-de-notificações) — a notificação passa a poder ser respondida | vssh-sso | ✅ concluído |
| 2 | [`lib/node/vssh-notify.js`](02-apis-de-shell.md#o-centro-de-notificações) — o app escreve no journal sem errar o `id` | toolkit | ✅ concluído |
| 2 | [Clipboard](02-apis-de-shell.md#23--clipboard-integração-não-construção) — ponte de arquivos; imagem ficou **sem** ponte, e por quê | vssh-sso + toolkit | ✅ concluído |
| 2 | [Impressão — fila do servidor](02-apis-de-shell.md#-destino-3-primeiro--e-a-ordem-tem-motivo) — o arquivo não viaja para imprimir | vssh-sso | ✅ concluído |
| 2 | [Impressão — `vssh.print()` e o destino no navegador](02-apis-de-shell.md#-e-os-outros-dois-destinos-desbloqueados) | vssh-sso + toolkit | ✅ concluído |
| 2 | [Impressão — a tela vira diálogo de verdade](02-apis-de-shell.md#-e-então-virou-um-diálogo-de-impressão-de-verdade) — prévia preguiçosa, opções da própria fila, o overlay vira janela, e o navegador vira um destino da lista | vssh-sso | ✅ concluído |
| 2 | [Impressão — PDF gerado no ambiente](04-runtime-composicao.md#registro-de-capabilities) — o terceiro destino, destravado pelo `provides` | vssh-sso + `vsshapp-print` | ✅ concluído · era o único item vermelho da Onda 2 |
| 2 | [Mixer de volume por aplicação](02-apis-de-shell.md#25--mixer-de-volume-por-aplicação---concluída) — o botão volta ao perfil sem Xpra como mixer; master, por app e por aba | vssh-sso + toolkit | ✅ concluído |
| 2 | [Rede de classes CSS](02-apis-de-shell.md#o-que-o-critério-33-exigiu) (`client-css-classes.test.js`) — o simétrico do `client-dom-ids` que faltava | vssh-sso | ✅ concluído |
| 2 | [Configurações refeitas](02-apis-de-shell.md#26--a-janela-de-configurações-refeita---feito) + `SettingsRegistry`, `VsshSettings`, `RemoteDesktopEngines`; o portal saiu | vssh-sso | ✅ feito |
| 2 | [Motores](02b-motores.md) — passo 1, o registro `RemoteDesktopEngines` | vssh-sso | ✅ concluído (na 2.6) |
| 2 | [Motores](02b-motores.md) — passos 2 e 3: o motor instalável (`vsshapp-xpra`), o transporte por SSH e a preferência `x11Engine` | vssh-sso + vsshapp-xpra | ✅ concluído · `xpra.ts` 619→103, `/proxy/desktop/` morreu |
| 2 | [Interlúdio 2c](02c-interludio.md) — deploys mortos, cliente com fingerprint, sessão que expira em uso, `repo-worker` para fora | vssh-sso + `vssh-repo` | ✅ fechada · −11260 linhas no portal, 107 requisições por carga viraram 0, a sessão parou de expirar em uso, o erro do proxy virou painel de janela, o log do backend virou janela — e três telas pararam de chamar de "vazio" uma falha que tinham em mãos |
| 2 | [Motores](02b-motores.md#passo-4--a-inversão-de-vocabulário---concluído-2026-08-06) — passo 4: o vocabulário dos dois perfis sai do código | vssh-sso + vsshapp-xpra | ✅ concluído · a coluna `profile` morreu, e o sweep achou um TypeError vivo |
| 2 | [Interlúdio 2c, item 11](02c-interludio.md#11--dois-defeitos-que-só-o-uso-achou-com-a-onda-já-fechada---concluído) — o erro do proxy nomeia quem caiu; a sessão expirada volta a responder 401 | vssh-sso | ✅ concluído · achados **em uso**, com a onda fechada |
| 3 | [Testes de navegador](03-toolkit.md#t9--testes-de-navegador) (T9) — CDP à mão, sem dependência npm | toolkit | ✅ concluído |
| 3 | [`LazyFile` com respaldo real](03-toolkit.md#t1--lazyfile-é-um-blob-vazio) (T1) — `slice` por Range HTTP, `Response`/`fetch`/`FileReader` | toolkit | ✅ concluído |
| 3 | [OPFS isolado por app](03-toolkit.md#t2--opfs) (T2) — o "private" era da origem, não do app | toolkit | ✅ concluído |
| 3 | [`exists`/`rename`/`copy`](03-toolkit.md#t6-e-t7--as-duas-dívidas-que-não-tinham-onda) (T6) — e o gate de grant de dois caminhos | toolkit + vssh-sso | ✅ concluído |
| 3 | [Versão do shell + `.d.ts`](03-toolkit.md#t6-e-t7--as-duas-dívidas-que-não-tinham-onda) (T7) | toolkit + vssh-sso | ✅ concluído |
| 3 | Primeiros testes de `electron-shim` e `tauri-shim` — 3 defeitos achados | toolkit | ✅ concluído |
| 3 | [`requiredPackages`](03-toolkit.md#requiredpackages--o-app-declara-de-que-pacote-linux-ele-precisa) — a metade declarativa (schema + publish) | toolkit | ✅ concluído |
| 3 | [A cópia vendorizada se declara](03-toolkit.md#a-cópia-vendorizada-não-sabe-a-idade-que-tem) — `libVersion` e o publish conferindo | toolkit | ✅ concluído |
| 4 | [Healthcheck](04-runtime-composicao.md#healthcheck-assíncrono---concluído) — verdadeiro (leva o token) **e** assíncrono; a janela abre coberta e espera | vssh-sso | ✅ concluído |
| 4 | [`kind:"service"` com janela](04-runtime-composicao.md#kindservice-com-janela---medido-era-um-teste-e-não-um-mecanismo) — medido rodando os scripts de verdade | vssh-sso | ✅ concluído · era um teste |
| 4 | [Múltiplas janelas](04-runtime-composicao.md#múltiplas-janelas---n-janelas-um-backend) — a cópia (menu) e a **extra** (`vssh.window.abrir`), com N janelas sobre um backend | vssh-sso + toolkit | ✅ concluído |
| 4 | [`requiredPackages`](04-runtime-composicao.md#requiredpackages--a-metade-que-verifica---concluído) — a metade que verifica: o instalador recusa, o painel mostra por servidor | vssh-sso + `vssh-repo` | ✅ concluído |
| 4 | [Limites de recurso](04-runtime-composicao.md#limites-de-recurso---concluído) — `systemd-run --user --scope` no `vssh-app-run`, `resources` no manifesto; e o grupo de processos que a roadmap dizia pago e não estava | vssh-sso + toolkit | ✅ concluído |
| 4 | [GPU como conceito de runtime](04-runtime-composicao.md#gpu-como-conceito-de-runtime---concluído) — descoberta **genérica** pelo kernel (qualquer fabricante, inclusive virtual) + benchmark GPU×CPU; o portão é só de CUDA, e isso está dito | vssh-sso + toolkit | ✅ concluído |
| 4 | [Cofre de segredos](04-runtime-composicao.md#cofre-de-segredos---concluído) — **o app pede** na hora em que falta; Configurações → Cofre só lista; o portal grava e não guarda cópia | vssh-sso + toolkit | ✅ concluído |
| 4 | [O que só apareceu ao INSTALAR](04-runtime-composicao.md#o-que-só-apareceu-quando-a-onda-foi-instalada) — cinco defeitos que nenhuma bancada alcançava, e a terceira etapa que a regra de verificação ganhou | toolkit | ✅ registrado |
| 5 | [Contrato do manifesto](04-runtime-composicao.md#o-contrato-do-manifesto-um-schema-uma-validação-uma-guarda) — a peneira fechou (raiz, `backend`, `window`), o erro nomeia o vizinho, e a guarda de junção mede os 5 consumidores | toolkit + vssh-sso | ✅ concluído · 3 afirmações da onda caíram na medição |
| 5 | [Capacidades](04-runtime-composicao.md#registro-de-capabilities) — `provides` e `minShellVersion`; o motor de navegação deixou de fixar o appId no código | vssh-sso + toolkit + `vsshapp-scramjet-wisp` | ✅ concluído |
| 5 | [Mensageria entre apps](04-runtime-composicao.md#mensageria-entre-apps---medida-escrita-e-cercada) — nada a construir; medida, escrita e cercada, com o limite junto | vssh-sso + toolkit | ✅ concluído |
| 5 | [Seção de Configurações por manifesto](04-runtime-composicao.md#seção-de-configurações-declarada-por-manifesto) — resolvida por `engine.loader` para app de admin; falta a **decisão de confiança** para terceiro | — | 🔵 decisão, não tarefa |
| 5 | [Extensão do `FileOpener`](04-runtime-composicao.md#ponto-de-extensão-no-fileopener---desenhado-falta-um-produtor-e-é-isso-que-falta) — desenhado sobre `provides`; falta um **produtor** (thumbnail/OCR/transcode) | — | 🔵 sem consumidor |
| 6 | Camada de arquivos de rede | vssh-sso | ⬜ não iniciado |
| 7 | Continuidade entre máquinas | vssh-sso + toolkit | ⬜ não iniciado |

## Questões em aberto

Decisões que precisam ser tomadas, não tarefas a executar. Detalhadas em
[diagnostico.md](diagnostico.md#15-questões-em-aberto).

- **`SharedArrayBuffer`** — habilitar cross-origin isolation (COOP/COEP) ou não? Decide se WASM
  multi-thread (DuckDB-WASM, Pyodide com threads) é viável. **Precisa ser decidido antes**, não depois.
- **Terminal persistente** — `terminal-latch` não se firmou. Qual o caminho?
- ~~**Extensão de navegador** — o Scramjet se provou; ainda vale manter a extensão?~~ **RESPONDIDA:
  não vale, e ela já saiu** na [Onda 2c, item 1](02c-interludio.md#1--os-deploys-que-perderam-o-assunto---concluído).
  A 2.6 já tinha feito o desmonte funcional (`BrowserEngines.get('extension')` sempre devolveu
  `null`), e o que restava era artefato e esteira. **Não confundir com as extensões do navegador
  embutido**, que são outra coisa e continuam vivas — o aviso está no item 6 da mesma onda.
- **Isolamento de apps** — o modelo atual é "um admin instalou, portanto é confiável". Quando cair,
  a fronteira tem de ser no processo, não na origem.
- **O rewriter do Scramjet emite uma variável que ninguém declara.** `$scramjet$temploc` é usado
  como alvo de atribuição sem `var` correspondente; em módulo ES (sempre strict) isso é
  `ReferenceError`, e derrubava páginas inteiras no navegador embutido —
  `dash.cloudflare.com`, entre outras. **Consertado no nosso fork** declarando-o como propriedade
  gravável do global (`wrap.ts`, release `2.0.67-alpha.3`, entregue em `scramjet-wisp 1.0.9`), o que
  restaura a semântica sloppy que o rewriter presume. **O conserto estrutural continua em aberto**:
  içar um `var $scramjet$temploc;` para a função/programa envolvente quando um `TempVar` é emitido
  em posição de alvo. É Rust, o bug está no `main` do upstream hoje, e nenhum dos commits que
  sincronizamos o toca — então é candidato a PR, não a dívida nossa para sempre.

## Como manter

- Ao concluir um item, mude o estado na tabela acima **e** o cabeçalho do arquivo correspondente.
- Achou que uma premissa estava errada? **Corrija no lugar e diga que estava errada** — vários
  achados deste diagnóstico vieram de premissas que pareciam sólidas. O histórico do erro vale mais
  que a aparência de acerto.

### Antes de executar uma onda, confira as afirmações dela contra o código

Não é conselho, é passo. Ao planejar a Onda 1, **três das premissas conferidas estavam erradas**:
que o shell abria `/ws/events` nos dois modos (não abria — e isso era **bug em produção**, um shell
sem Xpra não recebia o sinal de migração); que o desktop tinha de ficar na mesma URL (o contrato era
a **profundidade** do path, não o path); e que o `startXpra` provisionava o usuário (nunca
provisionou — quem faz isso é o `provisionKey` e o `startCodeServer`).

Custou alguns `grep`. Evitou construir o lease sobre um canal que não existia no perfil que a onda
inteira servia.

**E o critério certo, que a revisão seguinte precisou aprender:** uma afirmação vale quando diz **o
que a coisa faz**, não que ela está lá. "`#taskbar-tray` já existe" tinha arquivo e linha e estava
correta sobre o elemento — e escondia que não há tray nenhuma, só um container vazio alimentado por
um renderizador de pixmap do upstream que morre sem X11. *Já existe* é a formulação que esconde
trabalho enquanto parece rigorosa.

### Conferir não basta: alguém tem de tentar REFUTAR

O levantamento da [Onda 0c](0c-colapso-de-variantes.md) foi o primeiro em que cada achado passou por
um segundo par de olhos com uma instrução só — *derrube isto*. O resultado justifica o passo:

- **duas propostas minhas caíram**, e as duas eram plausíveis. Desligar os proxies de janela no
  perfil headless não funcionaria (os proxies declaram `pointer-events: auto` **inline**, e
  descendente vence ancestral); e içar as 22 chamadas de `captureKeyboard` para a classe base tem
  ganho de runtime **zero** e semântica divergente entre os call sites;
- **duas "deleções óbvias" teriam quebrado a taskbar** — `xdg_image` e `slick.js` pareciam código do
  dock e são usados pelo Launchpad, pelo Start Menu e pelo Alt+Tab;
- **os dois pontos de maior raio não estavam em inventário nenhum** — a classe base de toda janela e
  a fábrica de ícone dos diálogos.

A diferença entre conferir e refutar é a pergunta. Conferindo, pergunta-se *"isto está lá?"*;
refutando, *"o que acontece quando eu tirar?"*. Só a segunda encontra o que sustenta outra coisa.

**E quando a refutação atinge o que você mesmo propôs, ela vale mais, não menos** — o custo de
descobrir isso na roadmap é uma linha reescrita; no código, é um perfil quebrado que só aparece na
mão de quem usa.

### Depois de executar, alguém tem de tentar ABRIR

A [Onda 0c](0c-colapso-de-variantes.md) subiu com `tsc`, `eslint`, 247 testes verdes, links
conferidos — e o desktop **não abria**. A remoção foi feita por intervalo de linhas e engoliu quatro
funções que moravam no meio do bloco do dock sem serem do dock; a verificação rodava
`new Function(fonte)`, que valida **sintaxe**, enquanto um nome apagado é erro de **runtime**.

Duas regras saem daí, e valem para toda onda de remoção:

- **apagar por SÍMBOLO, não por intervalo** — o intervalo não sabe o que tem no meio dele;
- **o portão verde tem de medir a mesma coisa que abrir mediria.** Onde não dá para abrir no CI, o
  teste tem de conferir o que o navegador confere: que os nomes resolvem e que os elementos existem
  (`client-undefined-refs.test.js` e `client-dom-ids.test.js` são exatamente isso, e nasceram desta
  falha).
- Item novo entra no arquivo da onda que faz sentido, e na tabela de estado. Onda nova só se
  realmente não couber em nenhuma.

### E depois de abrir, alguém tem de INSTALAR e usar

A [Onda 4](04-runtime-composicao.md#o-que-só-apareceu-quando-a-onda-foi-instalada) fechou com suíte
verde, refutação 20/20 e bancadas rodando os scripts de verdade contra árvores de mentira. Aí a
galeria foi instalada num servidor, e **cinco defeitos apareceram em três rodadas** — nenhum deles
alcançável daqui:

- um `MemoryHigh` **cem vezes acima** do `MemoryMax` (precisava de uma máquina com RAM de verdade);
- uma GPU virtual dada como física (a virtio reporta o driver do **barramento**, coisa que nenhuma
  árvore de mentira minha tinha imaginado);
- um cofre que podia gravar em `/root` (depende do sudoers **daquele** servidor);
- um erro que devolvia a linha de comando em vez do motivo (só um `ffmpeg` real falhando mostrou);
- um diagnóstico que hesitava com a resposta em mãos.

**As três camadas acharam defeitos disjuntos.** O Windows achou guardas que não mediam nada; o CI
achou testes que mediam a *plataforma* (`systemd-run` existe no runner e não no Windows — o caso
passava por acidente); o servidor achou o que só o mundo sabe. Nenhuma era dispensável, e um teste
verde na máquina de quem o escreveu não mediu nada além daquela máquina.

E os cinco têm a mesma assinatura: **duas informações que existiam e não se encontravam.** O padrão
do ambiente não conhecia o teto do app; a lista de drivers virtuais não conhecia o id do fabricante;
o diagnóstico da falha não conhecia a descoberta. Não é falta de dado — é dado que não atravessa a
fronteira entre duas funções, e é o tipo de defeito que revisão de código não pega porque cada lado,
sozinho, está certo.
