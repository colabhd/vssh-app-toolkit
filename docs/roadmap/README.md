# Roadmap do ecossistema vssh-app

> **Atualizado:** 2026-08-11

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
| [05-arquivos-de-rede.md](05-arquivos-de-rede.md) | Onda 6 — o usuário monta as pastas de rede DELE, em WebDAV/S3, sem passar pelo host |
| [05b-navegacao-de-arquivos.md](05b-navegacao-de-arquivos.md) | Onda 6b — a navegação de arquivos, medida: 95% da latência é nossa |
| [06-portabilidade.md](06-portabilidade.md) | Onda 7 — continuidade entre máquinas |
| [07-shell-proprio.md](07-shell-proprio.md) | Onda 8 — o shell deixa de ser um fork do cliente Xpra: o jQuery sai, o gerenciador de arquivos se parte, e o ambiente passa a se medir |
| [08-editor-do-ambiente.md](08-editor-do-ambiente.md) | Onda 9 — o **socket vira o endereço** de todo vssh-app, e o VS Code vira nosso: workbench sobre um fork, e apps que passam a **contribuir** com o ambiente em vez de só consumi-lo |
| [09-motor-x11.md](09-motor-x11.md) | Onda 10 — o motor X11 para de ser um cliente hospedado: **nós servimos a página**, as janelas dele viram `VsshWindow`, e a última porta do ambiente morre |

**A numeração não é sequência total.** Ondas 0, 6, 7 e 8 não dependem das outras e podem correr em
paralelo. Só a Onda 2 depende da 1; a Onda 3 é pré-requisito real do arquétipo **A3** — A4 e A5
dependiam da Onda 4 (várias janelas, entregue) e da 2 (clipboard, entregue), não da FSA. A
**Onda 0c é pré-requisito da 2.6** e recomendada antes da 2.2 — enquanto houver duas variantes de
UI, cada superfície nova nasce com duas para manter.

A **[2.7](02b-motores.md) é a mesma frase num eixo maior**: dois perfis são duas variantes, e cada
superfície nova nasce com duas para especificar e verificar. Ela era "Onda 8", no fim da fila, e foi
puxada para logo depois da 2.6 — **para que as ondas 3 a 7 já partam de um ambiente só**.

O número 8 que ela deixou vago é agora a **[Onda 8](07-shell-proprio.md)**, e não por acaso: ela só
existe *porque* a 2.7 aconteceu. Tirar o protocolo do Xpra de dentro do `vssh-client/` deixou à
mostra o que sobrou de fundação emprestada — a biblioteca sobre a qual aquele cliente foi escrito,
que o shell ainda carrega **para um consumidor que agora mora noutro repositório e pode nem estar
instalado**.

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

A **[Onda 9](08-editor-do-ambiente.md) termina a frase que a 2.7 começou.** A 2.7 apagou
`/proxy/desktop/` e a porta `20000 + uid`; o code-server ficou para trás com `10000 + uid`, três
linhas abaixo do comentário que declara a porta aritmética um erro de desenho (`proxy.ts:451-469`).
**A 2.7 tirou a aritmética da porta; o passo 0 da 9 tira a porta** — o endereço de um vssh-app passa
a ser um socket unix derivado da identidade. É mudança de contrato da plataforma, não preparação
para o editor.

**E a frase seguinte, como estava escrita aqui, estava errada:** ela dizia que *"com ele somem a
alocação, o cache, a reconciliação, o espelhamento do `-L` e o teto de 254 servidores"*. Não somem
com ele. A reconciliação e a alocação **local** saíram; o resto sobrevive por um motivo que o passo 0
não alcança — **um app ainda declara `tcp`**, e é o xpra. Aquelas peças não estão de pé por inércia,
estão de pé **para servir um app só**. Quem as deixa sem assunto é o item 2 da
[Onda 10](09-motor-x11.md), e é por isso que o `0d` virou o **item 5 de lá**.

O que a torna 9 e não 2.8 é a outra metade: **o pedido não era encanamento melhor, era uma janela
que fosse do ambiente** — e a leitura da fonte do VS Code mostrou que a diferença entre "servidor num
iframe" e "aplicação do ambiente" é **quem serve a página**, e que uma linha do produto
(`extensionGalleryService.ts:35`) só é alcançável por fork. O item 4 dela é o que sobra quando a
pergunta é levada a sério para qualquer app, e não só para o editor: hoje um vssh-app **consome** o
ambiente e quase não **contribui** com ele.

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
| 2 | [Impressão — PDF gerado no ambiente](04-runtime-composicao.md#registro-de-capabilities) — o terceiro destino, destravado pelo `provides` | vssh-sso + toolkit | ✅ concluído · era o único item vermelho da Onda 2. O motor é `examples/print-engine`, o diálogo o acha por **capacidade**, e `print-v1.test.js` mede a junção entre os dois repositórios |
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
| 6 | [Pastas de rede do usuário](05-arquivos-de-rede.md) — a guarda de junção | vssh-sso | ✅ concluída **antes do primeiro provider**, e medindo desde já: a repartição das 28 rotas mora em código e é comparada com as rotas de verdade. O ataque nº 1 é "acrescentar `POST /fs/chmod` e seguir a vida" |
| 6 | [Pastas de rede](05-arquivos-de-rede.md) — provider WebDAV, leitor de `multistatus`, cofre cifrado, `userMounts` | vssh-sso | ✅ concluído · rodado contra **dois** servidores em container (SeaweedFS e Apache mod_dav), o que derrubou quatro coisas que eu teria feito por imaginação — e a **sonda mentia** sobre uma capacidade que existia. A primeira criptografia em repouso do portal nasce com chave própria e rotação escrita antes do primeiro segredo |
| 6 | [Pastas de rede](05-arquivos-de-rede.md) — o backend ligado ponta a ponta | vssh-sso | ✅ concluído · `/fs/list` reconhece `//rede/<id>` (barra dupla porque `/mnt` e `/media` **existem** no host), o segredo mora em tabela à parte — separação estrutural, não vigilância —, e a montagem que responde **401 é guardada** marcada como "precisa de senha", porque um 401 é uma sondagem bem-sucedida do endereço. **O ciclo roda por `curl`, sem a tela.** Falta a tela |
| 6 | [Pastas de rede](05-arquivos-de-rede.md) — **a tela, a barra lateral e os bytes** | vssh-sso | ✅ concluído · a onda ficou **usável ponta a ponta**. A tela cobrou o que faltava: `/fs/read` e `/fs/stat` passaram a reconhecer a raiz, porque uma pasta que lista e não abre nada promete e nega. E o que ela **não** faz é dito num lugar só — a recusa mora no `safePath()`, o funil de todo caminho, e a tela não oferece o que seria recusado |
| 6 | [Pastas de rede](05-arquivos-de-rede.md) — a URL assinada apontando para fora | vssh-sso | 🔵 **sem produtor** · `WEBDAV` declara `urlAssinada: 'nao'` — assinar URL é mecanismo de **S3**, e um servidor WebDAV se autentica a cada requisição. Não é tarefa esperando prioridade: é capacidade que a raiz de hoje não tem. Entra com o segundo provider |
| 6 | [Pastas de rede do usuário](05-arquivos-de-rede.md) | vssh-sso | 🔵 **desenho fechado, sem trava.** WebDAV é o padrão; S3 entra com suporte *declaradamente* limitado — diz `rename: false` em vez de emular, e a tela desabilita dizendo por quê. Credencial **no portal, cifrada**, com chave própria (o portal não cifra nada em repouso hoje — isto é novo, e o custo está escrito). As 27 operações repartidas: 9 do provider, 14 do portal, 4 em aberto |
| 6b | [Navegação de arquivos](05b-navegacao-de-arquivos.md) — os medidores ganham leitor | vssh-sso | ✅ concluído · `sshSlotStats`, `sessionStats` e o coletor estavam **exportados e sem nenhum leitor**; e o dashboard reportava `activeSessions: 0` literal |
| 6b | [Navegação de arquivos](05b-navegacao-de-arquivos.md) — UTF-8 partido na fronteira do chunk | vssh-sso | ✅ concluído · bug vivo, achado **gerando carga**; a refutação usa o código anterior como ataque |
| 6b | [Navegação de arquivos](05b-navegacao-de-arquivos.md) — virtualizar a lista do gerenciador | vssh-sso | ✅ concluído · a RAM apareceu **em uso**; os 4 dependentes da geometria conferidos um a um, e um deles quebrava |
| 6b | [Navegação de arquivos](05b-navegacao-de-arquivos.md) — encolher o payload da listagem | vssh-sso | ✅ concluído · o `path` absoluto saiu do fio (−40% de bytes) e voltou como **getter**, não como campo — reconstruir e guardar tinha ganho **zero** de RAM, e o corte real foi de 10,3 para 5,0 MB |
| 6b | [Navegação de arquivos](05b-navegacao-de-arquivos.md) — decompor a latência da listagem | vssh-sso | ✅ **medido, e não havia gargalo nenhum.** Uma listagem de 5.000 arquivos custa **157 ms** (51 abrir · 64 remoto · 42 receber). Os 874 ms que a onda perseguia eram do **coletor por servidor**, que roda a cada 5 s: "Operação mais longa" era um pico sobre TUDO e não dizia de quem. Caíram junto os "95% da latência é nossa", os "9,7 op/s", o piso de 226 e a inclinação de 596 |
| 7 | [Continuidade entre máquinas](06-portabilidade.md) — item 3 (OPFS é cache) | vssh-sso + toolkit | ✅ concluído (saiu com a Onda 3) |
| 7 | [Continuidade entre máquinas](06-portabilidade.md) — item 4 (artefatos nascem no ambiente) | vssh-sso | ✅ concluído · download e PDF já nasciam no servidor; o relatório de bug **não nasceu em lugar nenhum — foi deletado**, e o `FileSaver.js` com ele. ~~Sobra o log do app~~ — **não sobra**: o log do app virou pergunta de três respostas com "Salvar no servidor" como primária. A guarda disso passou verde numa versão em que os DOIS botões baixavam para o cliente, porque media as peças e não a ligação |
| 7 | [Continuidade entre máquinas](06-portabilidade.md) — item 1 (grants e handles migram) | vssh-sso + toolkit | ✅ concluído · `appGrants` em `/api/user/settings`, migração por **união** (quem já concedeu não perde), e o par do outro lado: `vssh.fs.grantedHandles()` reabre sem seletor o que já foi concedido. O que estava no caminho era uma **frase** — o arquivo justificava o `localStorage` dizendo que "permissão não deve sobreviver a quem a consome", e o consumidor não é o handle, é o app |
| 7 | [Continuidade entre máquinas](06-portabilidade.md) — item 2 (sessão que segue o pesquisador) | vssh-sso | 🔵 **decisão de produto** · handoff, espelho ou escopos separados. Nada anda antes dela — e é o último item aberto da onda |
| 8 | [Shell próprio](07-shell-proprio.md) — item 1: o jQuery sai do shell | vssh-sso + `vsshapp-xpra` | ✅ concluído · **a medição inverteu a premissa**: o shell tinha **9** call sites e o motor Xpra **134** — então 1a foi no **outro** repositório e foi primeiro (`vsshapp-xpra` **0.3.0** adota a própria dependência). O shell ficou com **zero** call sites e o JS caiu de **2,25 para 1,44 MB (−36%)**. Achado junto: `jquery-transform-draggable.js` nunca executou. **E o hambúrguer da taskbar ficou três dias quebrado por minha conta** — traduzi `.show()` como "apagar o inline" |
| 8 | [Shell próprio](07-shell-proprio.md) — item 2: partir o `FileBrowserWindow.js` | vssh-sso | ✅ concluído · **3.562 → 2.827 linhas** em seis módulos. **A divisão que este arquivo trazia escrita estava errada, e a medida a desmentiu** — e ao mexer nos módulos apareceu o motivo de verdade, que não é o tamanho: a área de trabalho ganhou **11 dos 13 verbos** que lhe faltavam. Dois defeitos achados **pela extração**, e uma falha da própria suíte junto |
| 8 | [Shell próprio](07-shell-proprio.md) — item 3: "Computador" vira **Acesso Rápido** | vssh-sso | ✅ concluído · `/fs/df` e um registro de espaços virtuais. **Quatro relatos de uso derrubaram a primeira versão da tela**, e ~~"`//acesso-rapido` herda a guarda do `safePath()` de graça"~~ **não herdava** — virava `/acesso-rapido` no host. Duas das sete coisas prometidas na tela **não tinham fonte de dado nenhuma**. Refutação **41/41**, depois do redesenho |
| 8 | [Shell próprio](07-shell-proprio.md) — item 4: desligar a pasta de rede do administrador | vssh-sso | ✅ concluído · `montagensOcultas` **por servidor**, e o interruptor virou primitivo. ~~"a chave nova guarda caminhos"~~ **estaria errado**: esconderia a mesma pasta em TODO servidor. Refutação **28/28** |
| 8 | [Shell próprio](07-shell-proprio.md) — item 5: gerenciador de tarefas do ambiente | vssh-sso | ✅ concluído · `/api/apps/usage`, o painel de janelas, e o `setInterval` cujo corpo era um `return` **descongelado**. A metade do navegador **não é o que o pedido supunha**, e isso ficou medido em vez de prometido. Refutação **31/31** |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — **passo 0: o endereço de um vssh-app deixa de ser uma porta** | toolkit + vssh-sso | ✅ **o contrato** (0b) **e o caminho do portal** (0c) · 📋 **0d** · `backend.transport` no schema com padrão `socket`, `escutar()` só em socket unix, o portão do transporte no `vssh-app-run`, e os cinco manifestos declarando — quatro em socket, o xpra em `tcp` com prazo. Toolkit **4.0.0** (tag `v4`), `build-info.json` **4.1.1**. **Duas peças que eu ia construir já existiam** — `minShellVersion` e `podeInstalar()` —, e cheguei a criar um duplicado antes de achá-las. **E as duas metades ficaram desencontradas por um tempo sem nada acusar:** o app foi para socket, o portal continuou sondando porta, e o resultado era `HTTP 000` em todo start — cada metade correta sozinha, o par mentindo. **E o 0c teve TRÊS defeitos, não dois** — o terceiro chegava a quem usa como *"tive que abrir o app duas vezes"*: `ssh -L <porta>:<socket que não existe>` **binda a porta local e aceita a conexão**, então o túnel se declarava pronto olhando o lado errado. Do 0d saiu a metade que não dependia de ninguém: **a porta do túnel é nossa** e parou de ser perguntada ao servidor. **O resto do 0d mudou de onda** — virou o item 5 da [Onda 10](09-motor-x11.md), porque é lá que o xpra sai do `tcp` |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 1: o pacote `vsshapp-vscode` e a entrega | `vsshapp-vscode` | ✅ **concluído** (`vscode` **0.1.15**, motor `1.132.0-local202608111558`) · o modelo de entrega mediu como o desenho previa: o pacote publicado tem **32.646 bytes** e o motor que ele instala tem **285.332.099 (272,1 MiB)** — **0,011%** —, então o `git archive` leva o roteiro e não o produto, e o `vssh-app-publish` não mudou. O `vssh-repo` ganhou uma espécie nova, `kind: "motor"`, pela **assimetria do Worker**: 128 MB de teto impedem bufferizar a subida, mas `blobResponse(obj.body)` transmite a descida — subida direto ao R2 (S3 multipart, token de **um** bucket), registro só de metadado. **O CI nunca fechou um build verde**: nove tentativas, e as causas valem por achado — o **mangler do próprio upstream** reprova o `-min` (reproduz na tag de release, não num `main` ruim), o portão de não-ASCII (`optimize.ts:253`) reprova **regexes do código deles**, e o nosso patch de galeria redirecionava o fetch de builtins **do próprio build**, que confere sha256. O que fechou foi um container que **fica de pé** (`build-local.sh`) — e a regra "ele não é uma segunda definição do build" teve de virar código, porque o defeito aconteceu **com o aviso já escrito**: o alvo do gulp agora é *lido* do workflow. **E a instalação real cobrou o que nenhuma bancada minha via**: o pacote não levava `package-lock.json` e o `npm ci` abortou como root — os cinco casos passavam porque a bancada montava um projeto npm **seu**, medindo a bancada e não o produto. O caso novo nasceu vermelho por um motivo mais fino: o lock existia no disco e **não estava versionado**, e o publish empacota `git archive`. Instalado em `ipprivm01`: **272,1 MiB em 34 s (7,90 MB/s)**, sha256 conferido, `npm ci` em 690 ms. Guarda `instalacao-idempotente.test.js`, **11 casos, refutação 11/11**. ⚠ E o `resources` declarado (`3G`/`6G`) **não é medida, é ponto de partida** — os 9,3 GiB medidos são de uma **sessão inteira**, não do editor |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 2: o workbench é nosso, sobre um fork | `vsshapp-vscode` | 📋 planejado · o VS Code web tem API de embedder pública (`web.api.ts`): `workspaceProvider`, `productConfiguration`, `commands.executeCommand` de qualquer comando, tema, cofre, prefixo. **E o fork é o único lugar que alcança** a resolução de plataforma (`extensionGalleryService.ts:35`), o renderizador do menu de contexto e o seletor de arquivo — os três são constante de módulo ou `registerSingleton`. ⚠ **E medindo o build pronto, a frase "o backend serve a NOSSA página" não se sustenta**: o alvo `reh-web` não produz `workbench.web.main.js`; produz **um** bundle de **33,8 MiB** cujo ponto de entrada **é o embedder de referência**, que lê a `<meta>` e chama `create()` sozinho. `create` só sai de `workbench.web.main.internal.js`, que o alvo empacota e não expõe. O item muda de forma, não de objetivo: o que é **dado** (galeria, tema, layout, indicador) vai no `data-settings` da `<meta>`, reescrito pelo nosso backend **sem recompilar**; o que é **função** (`workspaceProvider`, cofre, `resolveExternalUri`, handlers de comando) vira patch em `workbench.ts:603-628`, a única costura. E o prefixo custa **um header**: o `workbench.html` emite as seis URLs de uma variável só, derivada de `x-forwarded-prefix` (`webClientServer.ts:268,341`) |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 2a: o patch da plataforma de extensão | `vsshapp-vscode` | 📋 planejado · **a premissa do pedido era meia verdade.** `debugpy` veio `linux-x64` e `python 2026.4.0` veio `universal` na mesma conta, no mesmo dia — porque há **duas** resoluções que discordam: a listagem usa `isWeb → web` (`:35,1153`) e o install remoto refaz com `linux-x64` (`abstractExtensionManagementService.ts:751`). O dano é visível no `ps`: o pacote genérico não traz o binário `pet` e cai num language server pior |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 3: `/proxy/vscode/` deixa de ser um endereço | vssh-sso | 📋 planejado · a cirurgia da [2.7](02b-motores.md) no inquilino que sobrou: a porta `10000+uid`, o cookie injetado em HTTP **e** em WS, o handshake `curl -X POST /login` dentro do servidor, `provisioning/code-server.ts` **inteiro (782 linhas)**, seis endpoints e três pins de versão que **não descrevem a máquina** (dizem `4.126.0`; ela roda `4.127.0`) |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 4: o contrato de contribuição | toolkit + vssh-sso | 📋 planejado · **hoje um app consome o ambiente e não contribui com ele.** Um mecanismo completo (`contributes.settings`) e uma superfície com registro (`SettingsRegistry`); `ContextMenu.js:823-831` não tem `register` e todo item é array literal no shell. Entram menu de contexto, jump list do ícone, ordem e ícone no "Abrir com", `opens.mimeTypes` roteado — com **precedência declarada**, porque dois apps vão querer o mesmo item |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 5: a extensão VSSH servida pelo próprio app | `vsshapp-vscode` | 📋 planejado · `additionalBuiltinExtensions` aceita *"location of the extension where it is hosted"* (`web.api.ts:248-254`) — é o caminho para tudo o que o embedder não alcança, já que `asMenuId` só conhece **dois** `MenuId` (`web.factory.ts:76-81`). É por ela que o ambiente contribui de volta com o editor |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 6: o portão do body parser | vssh-sso | ✅ **concluído** · `express.json()` global em `app.ts:96` e `setupProxyRoutes` só em `:169`. **As duas frases que este item trazia estavam erradas, e as duas para menos:** ~~"leva 413"~~ — levava **500 "Erro interno"**, porque o error handler descartava o `err.status`, e a mensagem mandava tentar de novo; ~~"latente, não vivo"~~ — metade estava **viva e não é sobre tamanho**: o corpo consumido chegava ao outro lado como **0 de N bytes prometidos** no proxy PAC, e o remendo que existia entregava ao app `JSON.stringify(objeto)`, isto é, bytes **diferentes** dos que o cliente mandou. Guarda `corpo-do-proxy.test.js`, **9 casos, refutação 9/9** |
| 9 | [Editor do ambiente](08-editor-do-ambiente.md) — item 7: a documentação para de recomendar o atalho | toolkit | ✅ **concluído** · a árvore do `porting.md` passou a ter **duas perguntas** — o que custa rodar e o que custa **integrar** —, e ganhou o link para `api.md`, que a página não citava uma vez sequer. `criterios.md` virou "Os **três** critérios" e o 3.3 passou a alcançar **todo vssh-app** (a lista "Ondas 2, 4 e 5" isentava justamente as janelas que mais parecem página web). A doutrina da SKILL ganhou o gatilho de **propósito** — antes só disparava quando a ferramenta *recusava* o iframe. **E a frase errada do healthcheck tinha cinco cópias, não três**: eu contei a menos, e a quinta era o comentário do `templates/hello-vssh-app-node/backend/server.js`, de onde todo app novo nasce. Guarda `tests/docs-sem-atalho.test.js`, **10 casos, refutação 10/10** — que na primeira versão media dois arquivos e fingia medir cinco |
| 10 | [Motor X11](09-motor-x11.md) — item 1: nós servimos o `frontend/`, o xpra vai a `--html=off` | `vsshapp-xpra` | ✅ **concluído** (`vsshapp-xpra` **0.4.0**) · o `--html` apontava para a NOSSA pasta — não era o xpra nos dando um cliente, éramos nós pedindo que ele servisse a nossa. **O item custava mais do que dizia**: o app não tinha backend nenhum (`runtime: "binary"`, `exec xpra`), e agora tem um Node que serve o `frontend/`, faz a ponte de WS e **vigia o xpra como filho** — nas duas direções, senão o backend fica verde servindo arquivos para uma sessão que não existe. ~~"`GET /` devolve o `index.html` do pacote"~~ **era premissa minha e é falsa**: não há index, é `type: "engine"`, então `/` responde 404 dizendo o que o app é e o healthcheck foi para `/healthz` (fecha o **R3** da 2c, que supunha o mesmo). E veio de graça o que o xpra nunca soube fazer: o **`X-Vssh-App-Token`**, conferido inclusive no upgrade de WS — o header viajava para ninguém numa porta que toda conta Linux da máquina alcança. Nenhuma linha do lado-cliente mudou. Guarda **10 casos**, refutação nas duas direções |
| 10 | [Motor X11](09-motor-x11.md) — item 2: a ponte WS → socket nativo, e a última porta morre | `vsshapp-xpra` | ✅ **concluído** (`vsshapp-xpra` **0.5.0**, `transport: "socket"`) · a ponte deixou de repassar o upgrade e passou a TERMINAR o WebSocket, escrevendo o payload no `--bind` unix. **Metade da dúvida caiu lendo o cliente**: os bytes dentro dos frames binários SÃO o protocolo nativo (`Protocol.js:497-525` — cabeçalho `'P'` + flags + tamanho BE), e o receptor remonta atravessando fronteira de pedaço (`:265-296`), então nunca supôs frame == pacote. Duas coisas só apareceram implementando, e as duas são do NAVEGADOR: o subprotocolo `binary` **tem de ser respondido** (o Chrome aborta o handshake sem ele) e o frame tem de ser binário — e **a guarda que perguntava isso estava errada**, porque o `ws` entrega Buffer nas duas modalidades. **E a refutação achou um defeito na própria bancada**: o caso do corte no meio do frame TRAVAVA o arquivo por 120 s em vez de ficar vermelho em 4 s — e, travando, escondia a refutação (a mutação passava por "0 vermelhos"). `closeAllConnections()` não alcança socket que já virou WebSocket. Consertada: **5 mutações, 5 pegas**, cada uma nomeando o caso certo. Agora **o ambiente não tem nenhum app em porta**, e o item 5 está liberado |
| 10 | [Motor X11](09-motor-x11.md) — item 3: **o xpra vira só mais uma forma de adicionar janelas** | `vsshapp-xpra` + vssh-sso | ✅ **3a concluído** · 📋 **3b** (`vssh-sso`) · **decisão de produto tomada**: o gerenciamento de janelas já existe no ambiente, então a janela X11 não ganha cromo nem marca própria — é uma `VsshWindow` como outra qualquer, e o motor deixa de ser gerenciador para ser produtor. **A medida mostrou que a conta é maior que os proxies**: o ambiente fala DOIS dialetos de "janela" e mantém os dois à mão — **2 adaptadores** de tiling (`xpraAdapter`/`pseudoAdapter`, 60 linhas dizendo a mesma coisa duas vezes), **31 pontos** em 4 arquivos do shell perguntando de que família a janela é (`win.minimized ?? win._minimized`, `win.wid \|\| win._id`…), e **43** ocorrências de `proxy` (27 em código — a nota dizia 47). O proxy é consequência: a janela X11 mora dentro do `#screen`, e sair de lá é o que o apaga. Até os SVGs dos botões são cópia (`Window.js:208-213` ≡ `VsshWindow.js:18-21`) |
| 10 | [Motor X11](09-motor-x11.md) — item 5: **a orquestração de porta morre** (era o 0d da Onda 9) | vssh-sso | 📋 **liberado pelo item 2** · mudou de onda porque **é aqui que ela deixa de ter assunto**: enquanto o xpra declarava `tcp`, os onze lugares, o `nextLoopback` e o teto de 254 servidores existiam para servir **um app só**. A metade que não dependia disso já saiu com o 0c — a porta do túnel é local, e o portal parou de perguntá-la ao servidor. O que resta é ordem de entrega, não técnica: apagar antes de o `vsshapp-xpra` **0.5.0** estar instalado nos servidores deixa o motor sem endereço. **O gate é a 0.5.0 e não a versão mais nova** — quem trocou o transporte foi ela, e a 0.6.0 não encosta em endereço; a 0.5.0 já está publicada, e o que falta é a instalação, que se confere com `ss -tln` |
| 10 | [Motor X11](09-motor-x11.md) — item 4: o último jQuery do ambiente sai | `vsshapp-xpra` | ✅ **concluído** (`vsshapp-xpra` **0.6.0**) · **33.980 linhas de lib fora**, −14.488 no total. ~~"35 call sites em três arquivos"~~ **são 39** — a varredura só procurava `$(` e havia **8 em `jQuery(`** —, e o `Window.js` tinha **zero reais** (a única é comentário). Dos 134 originais: **16** eram `draggable`/`resizable` (já apagados no 3a), **17** o carrossel, **21** uma linha de DOM cada. **Dois terços viraram deleção, não porte.** ~~"o carrossel deixa de ser jQuery a portar para virar código a apagar"~~ **esconde uma perda**: aquele era o ÚNICO Alt+Tab do ambiente — a tecla era presa no `Client.js:868`, e ele listava só janelas X11. Varredura no `vssh-client/`: **zero** handlers de Alt+Tab, e a tela de atalhos documenta um (`secoes-ambiente.js:623`). O comentário `VsshWindow.js:592` ("o Alt+Tab lê `VsshWindow._all`") **é falso** — quem lê `_all` ali é o tiling. Virou o **item 4d**. **E o item 4 descobriu que o 3a estava QUEBRADO**: `conferirDependencias()` continuou exigindo `jQuery.ui.draggable` depois de o `jquery-ui` ser apagado — o motor recusaria carregar, citando 16 lugares que não existiam. O conserto óbvio (`typeof self.VsshWindow`) reintroduziria o defeito: **`class` em script clássico não vira propriedade de `window`**. **E o sino nunca recebeu uma notificação X11**: o `_wrapX11` do shell roda no `mount()` (index.html:850) e o motor carrega depois (`:1011`) — o envelope desiste em silêncio. Consertado na origem: quem produz **anuncia**. O desenho ficou no pacote por um limite medido — ação de notificação no shell é dado roteado por HTTP, e a resposta X11 tem de voltar pelo protocolo. Guardas 7 e 8 **invertidas** e varrendo por diretório (foi a lista à mão que deixou o defeito passar): **9 mutações, 9 vermelhos** |
| 10 | [Motor X11](09-motor-x11.md) — **o incidente de 11/08/2026**: quatro defeitos, três deles decisões do item 2 | `vsshapp-xpra` | ✅ **corrigido** (`vsshapp-xpra` **0.6.1**) · o motor ficou inalcançável **por horas** num servidor real: `ECONNRESET` e depois `HTTP 000` sem parar. O `app.log` deu a causa em **49 ms** — dois `startApp` quase simultâneos (defeito do portal, ver item 6), e o `subir()` fazia `spawn do xpra` → `escutar`. **`escutar()` é o único mecanismo de exclusão que existe ali**, e chamá-lo depois do efeito colateral é jogar a exclusão fora: a instância que perdeu já tinha spawnado um segundo xpra, os dois colidiram (`codigo 21`), e o sobrevivente ficou **órfão** porque a saída antecipada não matava o filho. Daí em diante todo start batia em `xpra.sock` vivo e saía com **`exit 0`** — que o lifecycle lê como sucesso —, sem nunca bindar o `app.sock`: nada tentava de novo, e só um `xpra stop` manual destravava. **A reordenação muda a resposta certa**: detendo o `app.sock` (único endereço pelo qual o portal alcança o app), um xpra que atenda é órfão de vida anterior — então **adotar** é a única resposta, e de brinde **a sessão X11 passa a sobreviver a um reinício do backend**. **E o quarto defeito é do TOOLKIT**: `log(...)` + `process.exit()` perde a linha, porque o `createAppLog` usa `createWriteStream`. Provado pelos dados, não por teoria — `xpra-ja-atende` está no `run.log` e não no `app.log`, sendo a mesma chamada. O registro ficava cego exatamente quando o processo desiste. **E o incidente provou A FAVOR** a única peça que o item 2 deixou sem prova: o **`--bind` unix funciona** — a sessão anterior rodou 6 minutos e saiu com `143` (SIGTERM limpo). 9 casos novos, **8 mutações, 8 vermelhos** |
: um método de jQuery chamado numa VARIÁVEL é invisível. *Guarda que procura o símbolo de uma lib mede a importação, não o uso* — passou a cobrar 23 métodos, deixando `find`/`text`/`closest` de fora porque `Array.find`, `Response.text()` e `Element.closest()` são legítimos. (2) as janelas abriam **2× maiores** e o clique caía no dobro da distância: `w/h/x/y` são pixels de DISPOSITIVO (o cliente pede framebuffer `scale`× maior — é daí que vem a nitidez HiDPI), e a conversão era um `transform: scale()` no `#screen`, que não alcança mais o `body`. **Desceu para o canvas** — buffer em pixels de dispositivo, `style.width` em CSS —, e isso é melhor por três razões: o cromo é do ambiente e não deve escalar, a geometria do div passa a ser CSS (a unidade do arraste/resize/tiling), e **o `#screen` perde o transform**, deixando sem assunto o `_observarEscalaDosMotores` do shell — **o 3b fica menor**. Achei junto uma dependência escondida (`_screen_resized` sem `* scale`, correto só por causa do transform: a nitidez morreria no primeiro resize) e **a guarda nº 6 medindo um comentário** (lia o `init()` cru, sem `soCodigo`) — consertada e invertida: escrever `transform` no `#screen` agora é proibido. **Duas suspeitas minhas a medida absolveu antes de virarem commit**: a classe `window` está lá (o 3a portou todas para `classList`) e `vssh-window` é a classe padrão de toda janela do shell. **Em aberto:** o `xpra.sh` fixa `--dpi=96` e o cliente manda `96 × dpr` no hello — se o servidor vence, a nitidez é supersampling de um layout 96 dpi, e não HiDPI nativo. **É hipótese: sonda antes de código** |
| 10 | [Motor X11](09-motor-x11.md) — **os submenus Qt e o DPI da sessão** | `vsshapp-xpra` | ✅ **0.6.3** · 🔬 **0.7.0 é medida** · os submenus Qt abriam ATRÁS da própria janela, e não era clique nem protocolo: **aritmética de empilhamento entre dois contextos**. `#screen` é `position: relative; z-index: 100`, e `position`+`z-index` CRIAM contexto — um menu em 30000 lá dentro vale 100 perante os irmãos do `body`, onde a janela dona dele vale **50000** desde o 3a. As superfícies flutuantes passaram para o `body` (barato por causa da 0.6.2: sem transform, `#screen` e `body` compartilham o sistema de coordenadas) **e o z-index delas passou a ser derivado do do shell** — mudar de contexto sem mexer nos números deixaria o defeito de pé, correto na inspeção e atrás da janela na tela. **E uma regressão minha da 0.6.2**: o `#screen` recebe `width/height: 100%` inline do shell, e até a 0.6.2 o `init()` os SOBRESCREVIA com `100*scale%` — então três de quatro lugares liam `clientWidth` sem `* scale` e estavam certos por tabela, não por decisão. Tirado o dimensionamento, os três passaram a informar METADE do framebuffer em dpr 2, e um deles é o `_make_hello()`, que CRIA a tela da sessão. Consertei um na hora porque procurei por `* this.scale` — **procurei pela correção em vez de pela unidade**. Agora é um método só com a unidade no nome, lendo a viewport. **E o DPI foi medido**: `xdpyinfo` 96x96, `Xft.dpi: 96` — o `--dpi=96` vence o hello, e a nitidez de hoje é supersampling de um layout 96 dpi. A 0.7.0 põe `--dpi=0` (o cliente decide) e **é a medida, não a conclusão**, porque o valor do cliente só existe depois de alguém conectar. Uma variável de cada vez: o `-dpi 96` do Xvfb fica |
| 10 | [Motor X11](09-motor-x11.md) — item 7: **o portal conta ao motor o tamanho e a DPI da tela** | vssh-sso | 📋 **fecha dois sintomas medidos**, não é refinamento · o log do próprio xpra diz os dois: `tried to set resolution to 2881x1565 and ended up with 1920x1080 · 1 sizes are supported` e `DPI Issue · DPI set to 96 x 96 (wanted 168 x 168)`. **A sessão é MENOR que a janela** — `Xvfb -screen 0 1920x1080` dá UM modo RandR e o xpra leva `BadMatch` ao tentar outro, então nenhuma janela X11 alcança a borda e maximizar preenche 1920×1080 de uma área maior. E o texto é supersampling e não HiDPI porque a DPI de uma tela X é DERIVADA (pixels sobre tamanho físico em mm), e o Xvfb fixa o tamanho físico na criação. **Mesma raiz nos dois: o servidor X nasce pequeno e fixo, antes de existir cliente** — foi por isso que a 0.7.0 trocar `--dpi=96` por `--dpi=0` não bastou; o xpra tentou e o servidor recusou. O pacote fez a metade dele na **0.7.2** (`VSSH_X11_DPI` com padrão 96, na mesma costura de `VSSH_X11_WIDTH/HEIGHT`, e `+extension RANDR` explícito em vez de contar com o padrão do build). Falta o portal mandar os três a partir do navegador, que é quem sabe. Alternativa que já existe: o ramo `VSSH_X11_XVFB=xorg`, com o dummy do Xorg — literalmente o que a mensagem do xpra recomenda —, que exige `/etc/xpra/xorg.conf`. **Limitação honesta nos dois caminhos:** a tela é da SESSÃO, e a sessão sobrevive ao navegador; um segundo navegador de outro tamanho volta a bater no teto. Guarda: o log da sessão não contém `DPI Issue` nem `tried to set resolution` |
| 10 | [Motor X11](09-motor-x11.md) — item 6: **o portal não deixa dois starts do mesmo app em voo** | vssh-sso | 📋 **a causa primeira do incidente acima** · dois `startApp` para o mesmo `<usuário>:<appId>` saíram a **49 ms** de distância. O app foi consertado para não quebrar com isso, mas pedir dois é do portal — e custa duas sessões SSH, dois `vssh-app-run` e a chance de a corrida achar o próximo defeito. Uma promessa em voo por par, com o segundo pedido esperando a primeira. De brinde, o `HTTP 000` do healthcheck deixa de ser corrida. Guarda: dois `startApp` no mesmo tick dão **um** `vssh-app-run`; refuta tirando o mapa |
| 10 | [Motor X11](09-motor-x11.md) — item 4d: **o ambiente ganha o Alt+Tab que o motor levou** | vssh-sso | 📋 **item novo, nascido de uma medida do item 4** · o alternador de janelas do ambiente morava no pacote do xpra e listava só `client.id_to_window`; com um navegador e um terminal na tela, ele não os via. Saiu na 0.6.0, e o shell nunca teve um. É trabalho pequeno **porque o 3a já o preparou**: `VsshWindow._all` tem tudo a listar, sem distinção de família — não há adaptador a escolher. Fica também o markup órfão: `#window_preview` (index.html:415), `css/slick.css` (109 linhas) e o resto do `menu-skin.css`. Guarda: um terminal e uma janela X11, e o alternador lista **as duas** — a frase que o carrossel nunca cumpriu |

### E uma onda revisada rende tanto quanto uma executada

As Ondas 6 e 7 foram escritas em 01-08 e revistas em 08-08, contra o código, sem escrever uma linha
de produção. O saldo:

- **duas entregas apareceram** — o item 3 da Onda 7 (a regra "OPFS é cache") saiu junto com a Onda 3,
  e o item 4 saiu aos pedaços nas Ondas 2 e 5. Estavam na tabela como pendentes há uma semana;
- **um exemplo não existia.** A Onda 7 citava "gravação de tela" como candidato de varredura; não há
  `getDisplayMedia` nem `MediaRecorder` no shell. Um item inexistente inflava o tamanho da onda;
- **a Onda 6 estava curta por um fator de três**: o contrato de provider listava 8 operações e há 26;
- **e duas coisas dadas como a construir já existiam** — a URL assinada (`/fs/file-token`) e a
  identidade por conexão do handoff (`activeEventConnections`, um `Set` de sockets que o
  `broadcastMigrate` já percorre um a um).

Nenhuma das seis foi achada lendo o documento. Todas saíram de `grep` no código — o mesmo passo que
o README já mandava dar **antes de executar** uma onda, aplicado a ondas que ninguém ia executar tão
cedo. É barato, e o que ele evita é planejar em cima de um sistema que deixou de existir.

**E a revisão produziu uma deleção.** O "Relatório de problema" era o caso mais forte do item 4 da
Onda 7 — um `.txt` com as preferências que seguem o pesquisador, entregue à máquina de onde ele está
saindo. A resposta certa não era movê-lo para o servidor: o item tinha duas respostas ("nasce no
cliente", "nasce no ambiente") e faltava a terceira, **"não tem por que existir"**. Ele é herança do
cliente Xpra, nunca funcionou na forma original, e a 2.6 consertou a execução de uma coisa sem
assunto. Saiu inteiro, com o `FileSaver.js` junto — e a lista de libs vendorizadas do
`client-undefined-refs`, que tinha sete nomes, chegou a zero.

## Questões em aberto

Decisões que precisam ser tomadas, não tarefas a executar. Detalhadas em
[diagnostico.md](diagnostico.md#15-questões-em-aberto).

- **Reconciliação de sessão entre duas máquinas** — handoff, espelho ou escopos separados?
  ([Onda 7, item 2](06-portabilidade.md#2-sessão-que-segue-o-pesquisador)). Trava o item inteiro, é
  decisão de produto, e a peça técnica que parecia faltar já existe sem nome.

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

#### O alvo da refutação nem sempre é o produto. Às vezes é o teste

Duas vezes na [Onda 6b](05b-navegacao-de-arquivos.md) o vermelho que faltava era do instrumento, e
essa é a variante mais perigosa — porque o instrumento não tem quem o meça.

**O ataque que mais importa é o que desfaz a feature inteira, e ele passou verde.** A virtualização
da lista de arquivos entrou com 13 casos verdes sobre a função que calcula a janela. Desfazê-la —
trocar `todos.slice(inicio, fim)` por `todos` no consumidor — não produziu vermelho nenhum: os
testes mediam a **conta**, e nenhum media **quem a usa**. A regra que sai daí: *entre os ataques,
escreva primeiro o que apaga a razão de a mudança existir*. Se ele não fica vermelho, os outros
doze não valem nada.

**E um extrator quebrado acusa o código de um defeito que é dele.** O stripper de comentários de um
teste de rede casava `/*` dentro de **regex literal** (`replace(/\/*$/, '/')`) e engolia código até
o próximo `*/` de verdade. Ficou verde por meses porque o trecho engolido não tinha nada que o
teste procurasse; acrescentar um comentário legítimo noutro ponto do arquivo mudou o pareamento, e
uma classe viva desde sempre apareceu como morta. **A mesma armadilha já tinha custado 14 KB na
guarda de junção do manifesto** — e reincidência é sinal de que a lição precisava estar aqui, e não
só num comentário: **comentário de bloco só conta quando abre a linha.**

##### Depois da segunda vez, a pergunta certa não é "consertei?" — é "quantas mais existem?"

O conserto acima foi pontual: um arquivo, o que estava vermelho. Ao escrever a guarda seguinte,
perguntei quantos outros testes escreviam o mesmo stripper solto. **Eram 24, em 21 arquivos**, e
rodar os dois strippers sobre a base inteira deu o tamanho do que ninguém via: **58.586 bytes**
comidos de `src/routes/system.ts`, **40.402** do `FileBrowserWindow.js`, e mais dez arquivos atrás.
O `system.ts` era justamente onde ia morar a guarda que eu estava escrevendo.

Nada disso apareceu como vermelho, e nada disso apareceria: um extrator que engole código produz
guarda que **passa**. A varredura é o único jeito de achar, e ela custou um comando. Três coisas
saíram daí, e a terceira é a que importa:

- os 24 sites passaram à forma ancorada — e a suíte seguiu verde, o que quer dizer que **nenhuma
  guarda dependia de engolir código**, e que as 24 estavam medindo menos do que diziam;
- `tests/helpers/sem-comentarios.js`, que é onde a lição mora e de onde teste novo importa (com um
  `semComentariosCss` à parte, solto de propósito: não há literal de regex em CSS);
- **uma guarda que proíbe a forma errada em qualquer teste.** É ela, e não o helper, que impede a
  quarta vez — um helper novo não impede ninguém de escrever o velho de novo, e foi exatamente isso
  que aconteceu entre a primeira e a segunda.

O teste de "o teste está MEDINDO alguma coisa" existe em vários arquivos desta base por causa disso.
Ele não é zelo — é o único que percebe quando um regex parou de casar.

#### Ler uma cadeia não é medi-la — e "isso parece caro" é a mesma armadilha de "isso já existe"

A [Onda 6b](05b-navegacao-de-arquivos.md) escreveu, com todo o rigor aparente, que o piso de 226 ms
de cada listagem era a cadeia `sudo → bash → echo → base64 → python3` — *"cinco processos e um
interpretador subindo"* — e derivou dali três caminhos de conserto, um deles estrutural.

**A cadeia inteira custa 18 ms.** E listar 5.000 arquivos dentro do python custa 16. O processo
remoto era **4%** de uma operação de 874 ms; o melhor dos três caminhos economizaria 2%.

O erro não foi de aritmética, foi de gênero: a cadeia foi **lida**, pareceu cara, e a aparência
entrou no documento como medida. É a irmã de *"já existe"* — as duas produzem frases que soam
rigorosas porque são verdadeiras sobre o texto do código e mudas sobre o comportamento dele.

E o desfecho é o que dá o método: os 96% restantes não estavam em nenhuma hipótese porque **nenhum
instrumento cobria aquele trecho**. O relógio existente começava depois da fila e terminava no
fim do exec, medindo um bloco só. Decompor o bloco em fases nomeadas foi mais barato que qualquer
um dos três consertos propostos — e é o que transforma "eu acho que é o canal" numa pergunta que o
painel responde.

#### E a pergunta que faltava era mais básica: **de quem é este número?**

A decomposição respondeu na primeira leitura, e a resposta não foi um gargalo. Foi que **não havia
gargalo**: a listagem custava 157 ms, e os 874 ms que a onda perseguia por semanas pertenciam ao
**coletor por servidor** — um poller de 5 em 5 segundos que ninguém pede.

"Operação mais longa" era um pico sobre **tudo** que passa pelo limitador de canais, e o painel não
dizia sobre quem falava. Dele saíram *"95% da latência de uma listagem é nossa"*, *"9,7 operações
por segundo"*, *"o piso de 226 ms"* e *"a inclinação de 596"* — quatro afirmações precisas,
publicadas, e sem um dono verificado. O procedimento de medida (*zerar os picos, abrir a pasta, ler
o pico*) não tinha como funcionar: entre zerar e ler, o poller rodava várias vezes.

É a família do `activeSessions: 0`, com uma diferença que vale guardar: **aquele mentia por não ter
resposta; este mentia por não dizer sobre quem falava.** Na tela os dois têm a mesma cara — um
número com autoridade. Daí a regra:

> **Métrica agregada publica o sujeito junto com o valor, ou não publica.** Um pico sobre "tudo" é
> uma pergunta, não uma resposta — e vira resposta errada no instante em que alguém a lê.

E o conserto certo não é rotular os chamadores um a um: são 32, e a 33ª nasceria anônima. O rótulo
vem de onde a informação já está — `req.route.path`, o padrão da rota e não a URL preenchida.

#### Um portão que mede a PLATAFORMA está medindo a coisa errada

Instalar o WSL numa máquina de desenvolvimento deixou **57 testes vermelhos de uma vez**, sem que
uma linha de código mudasse. O `bash` que o Node encontra passou a ser o lançador do WSL:

```
execFileSync('bash', …)  →  WindowsApps\bash.exe
uname -s                 →  Linux
python3 --version        →  Python 3.14.4
```

Oito arquivos perguntavam, cada um por sua conta, *"tem `bash`? tem `python3`?"*, e a resposta virou
**sim**. Só que o Node continua no Windows: as bancadas montam árvore em `C:\Users\…` e entregam
para um shell que enxerga `/mnt/c/…`. Nenhum dos dois está errado — **eles só deixaram de
compartilhar o sistema de arquivos**. Antes, o `bash` era o do Git for Windows, que vê `C:\` como
`/c/`, e por acidente tudo funcionava.

A pergunta certa não é sobre plataforma, é sobre junção: **"este shell enxerga os arquivos que eu
acabei de criar?"** — um `test -d` no próprio repositório. Uma linha, e ela não precisa conhecer
WSL, git-bash, nem o que vier depois.

Três coisas para levar:

- **a sonda estava duplicada em oito arquivos, e errada nos oito.** Terceira vez nesta base que uma
  verificação repetida se mostra errada em todas as cópias ao mesmo tempo — depois do stripper de
  comentário e do próprio portão de `python3`. O conserto é sempre o mesmo: recolher para um lugar
  só, e deixar uma guarda proibindo a forma errada;
- **medir pela SAÍDA, nunca pelo código de saída.** O atalho da Microsoft Store para `python3`
  imprime "Python was not found" e às vezes sai com 0. Um interpretador que responde `vssh-ok` é um
  interpretador; um que sai com zero pode ser um redirecionador de loja;
- **isto foi disparado por instalar uma ferramenta**, não por escrever código. É a irmã da lição da
  Onda 4 no CI (`systemd-run` existe no runner e não no Windows, e o caso passava por acidente) —
  e mostra que o ambiente é entrada do teste tanto quanto o código.

> #### E a mesma armadilha voltou, pela outra ponta: resolver o `python3` quebrou cinco casos
>
> Dias depois, com o `python3` da máquina consertado, `pacotes-do-app.test.js` ficou vermelho em
> cinco casos — e a acusação era contra o **produto**: *"o instalador recusa um app que não declara
> pacote nenhum"*.
>
> Não era. As bancadas punham no PATH de mentira um impostor `python3` que normaliza a saída com
> `tr -d '\r'`, **e só o escreviam quando o interpretador achado tinha outro nome** — porque um
> impostor chamado `python3` que chamasse `python3` chamaria a si mesmo. O efeito é perverso: a
> normalização existia exatamente onde não fazia falta, e **sumia no dia em que um `python3` de
> verdade aparecesse**. Aí o CRLF do Python de Windows fazia `PACKAGES` valer `"\r"` em vez de
> vazio, o portão que devia ser pulado cobrava um pacote de nome invisível, e a instalação era
> recusada com a lista de faltantes em branco.
>
> Três coisas, e as três já estão nesta lista acima: **a regra estava copiada em dois arquivos**;
> **o instrumento acusava o produto**; e o gatilho foi de novo **instalar uma ferramenta**. O
> conserto é o mesmo de sempre — o impostor mora no helper, vai **sempre**, e delega a um caminho
> absoluto resolvido antes de o PATH de mentira existir. No Linux o `tr` não tem o que tirar, que é
> como se sabe que a bancada roda o mesmo caminho de código nos dois sistemas.

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
