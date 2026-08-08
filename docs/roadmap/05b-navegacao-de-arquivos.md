# Onda 6b — A navegação de arquivos, medida

> **Estado:** em execução · **Atualizado:** 2026-08-08 · **Repo:** `vssh-sso`
> **Independente de tudo** — inclusive da [Onda 6](05-arquivos-de-rede.md), de onde ela saiu.

## De onde esta onda veio

Ela não estava na roadmap. Apareceu quando fomos **medir** a Onda 6, e o que a medição mostrou não
tinha nada a ver com o que a Onda 6 é: os números não falam de armazenamento de rede, falam do
caminho que o portal usa para listar **qualquer** pasta, inclusive a home em disco local.

Separá-las é o ponto. A Onda 6 depende de uma decisão de protocolo que ainda não foi tomada; esta
não depende de nada e melhora a navegação de hoje.

## A medida, e como refazê-la

Servidor real, diretórios sintéticos em **disco local** (nenhum NFS envolvido).

<details>
<summary>A receita, para medir de novo depois de cada mudança</summary>

```bash
# No Terminal do desktop. `xargs -n 500` BATELA — a primeira versão usava
# `xargs -I{}`, que sobe um processo `touch` por arquivo: 50 mil processos, lento
# a ponto de a medição ter sido feita sobre um diretório que ainda não tinha
# terminado de encher. O `wc -l` existe por causa disso.
for n in 100 5000 50000; do
  mkdir -p ~/medida/p$n && cd ~/medida/p$n
  seq 1 $n | sed 's/^/arq/' | xargs -n 500 touch
  echo "p$n: $(ls | wc -l)"
done
```

Depois, para cada pasta: **Administração → Dashboard → "Zerar picos"**, abrir a pasta no
gerenciador de arquivos, voltar ao Dashboard e ler **"Operação mais longa"**. O painel também
divide o teto de 8 canais por essa duração e mostra a capacidade do servidor naquele ritmo.

E `time ls -la ~/medida/pN > /dev/null` no Terminal dá o custo do filesystem, que é o que separa
"é nosso" de "é do armazenamento". Limpar com `rm -rf ~/medida`.

</details>


> ## ⚠️ OS NÚMEROS DESTA SEÇÃO ESTAVAM ERRADOS, E O ERRO ERA DE ATRIBUIÇÃO
>
> Ela dizia:
>
> | Pasta | Portal entrega | `ls -la` | "Nosso" |
> |---|---|---|---|
> | 100 arquivos | 226 ms | ~1 ms | ~225 ms |
> | 5.000 arquivos | 822 ms | 44 ms | **778 ms — 95%** |
>
> **Nenhum desses números era de uma listagem.** Eles saíam de "Operação mais longa", que é um pico
> sobre **tudo** que passa pelo limitador de canais — e o painel não dizia de quem.
>
> Quando a decomposição por fase entrou, a mesma navegação mostrou **493 ms no total e 157 ms na
> listagem**, com os 336 KB de stdout batendo exatamente com o que o python mediu no servidor. Os
> 493 eram de outra coisa: o **coletor por servidor**, que roda a cada 5 s, não foi pedido por
> ninguém, e nem sequer passa pelo caminho decomposto.
>
> O procedimento — *zerar picos, abrir a pasta, ler o pico* — não tinha como funcionar: entre zerar
> e ler, o coletor rodava várias vezes.
>
> **Uma listagem de 5.000 arquivos custa ~157 ms**, assim:
>
> | Fase | | |
> |---|---|---|
> | abrir o canal | 51 ms | 33% |
> | esperar o remoto | 64 ms | 41% — contra 34 ms medidos na própria máquina |
> | receber 336 KB | 42 ms | 27% — ~8 MB/s |
>
> E o que caiu junto: **"95% da latência é nossa"** e **"9,7 operações por segundo"**. A capacidade
> pelo mesmo cálculo, com o número certo, é ~51 op/s — e o que come canal de verdade é o coletor,
> ocupando ~10% de um dos 8 continuamente sem que ninguém tenha pedido.
>
> A correção do instrumento está em "O pico que não dizia de quem era", mais abaixo.

> **A premissa que caiu junto.** A Onda 6 dizia que cada operação de metadado vira um `exec` por
> SSH e que num diretório grande "isso é sentido como travamento". `GET /api/fs/list` é **UM**
> exec, com `scandir` e `stat` de tudo dentro do processo remoto — 30 mil arquivos custam um canal,
> igual a três. O que custa não é o número de operações; é o que cada uma carrega.

## Os três itens

### 1 · O piso e a inclinação — ⚠️ MEDIDO, e as três hipóteses caíram

**A decomposição foi feita, e o resultado desmonta esta seção inteira.** No servidor real:

| | Medido |
|---|---|
| `python3 -c 'pass'` | 10 ms |
| `sudo -H -u $USER bash -c true` | 10 ms |
| a cadeia inteira (`sudo`+`bash`+`base64`+`python3`) | **18 ms** |
| o trabalho do python em 5.000 arquivos | **16 ms** — scandir 1,6 · stat+dict 13,1 · dumps 1,5 |
| `ls -la` na mesma pasta | 25 ms |
| **o que o portal entrega** | **874 ms** |

**O processo remoto é 4% da operação.** Os três caminhos que esta seção propunha — tirar processos
da cadeia, um daemon por sessão, reusar o canal — atacavam, juntos, os 18 ms. O melhor deles
economizaria 2% de uma listagem.

E a inclinação também não é do python: de 100 para 5.000 arquivos, o trabalho remoto sobe de 0,3 ms
para 16 ms. Sobem 16; o portal sobe centenas.

> **Uma previsão minha caiu junto, e vale registrar como caiu.** Antes de medir, escrevi que os 822
> ms *"ficam entre 780 e 830"* depois do corte do payload. Deram **874**. A tese (o corte de bytes
> não move a latência) sobreviveu; a faixa estava errada, e faixa errada é previsão errada.

#### Onde os 840 ms restantes estão: ninguém sabia, e agora há um instrumento

O relógio de "Operação mais longa" começa **depois** da fila e cobre só o `_execAbortable`. Então os
874 ms são canal + execução + travessia — e a execução são 34 ms. **O vão inteiro estava sem
número.**

Ele passou a ter três, gravados como **conjunto** (as partes de UMA operação, não três marcas d'água
que não somam nada):

| Fase | O que é |
|---|---|
| **abrir o canal** | pedir o canal até o `ssh2` devolver o stream |
| **esperar o remoto** | canal aberto até o primeiro byte de stdout — deve bater com os 34 ms medidos no servidor |
| **receber os bytes** | primeiro byte até o `close` — a travessia dos 336 KB |

E o bloco traz o **próprio total**, em vez de pendurar as partes na linha de cima: `execDuracaoMs`
também é escrito por três chamadores que não passam pelo `_execAbortable` (o coletor por servidor,
o stat do Office, a rota de apps). Pendurar ali criaria exatamente a junção falsa que estes
medidores existem para não ter — e os dois totais lado a lado dizem mais do que um: iguais, é o
mesmo exec; diferentes, o mais longo não foi um comando de usuário.

**As três linhas foram lidas, e o que elas acharam não foi um gargalo — foi um erro de medição.**

| | |
|---|---|
| Operação mais longa | **493 ms** |
| Exec mais longo, por fase | **157 ms** · 336 KB |

Os dois totais não batiam, que é precisamente o que a separação deles existia para revelar: **a
operação mais longa não era a listagem que o usuário tinha acabado de pedir.** E os 336 KB
identificam o exec decomposto sem ambiguidade — é a p5000, o mesmo número que o python imprimiu no
servidor.

Dentro dos 157 ms:

| Fase | | Leitura |
|---|---|---|
| abrir o canal | 51 ms · 33% | round-trip até o host, por listagem |
| esperar o remoto | 64 ms · 41% | contra **34 ms** medidos na própria máquina — sobram ~30 ms de `sudo`/PAM/arranque sob `ssh exec` |
| receber os bytes | 42 ms · 27% | 336 KB a ~8 MB/s — normal, e é o que arquivou a paginação de vez |

Nenhuma das três domina. **Não há gargalo a atacar** — há uma operação de 157 ms razoavelmente
distribuída, e antes disso havia um número de 874 ms que pertencia a outra coisa.

## O pico que não dizia de quem era

Este é o defeito mais caro da onda, e ele não estava no produto: estava no medidor.

"Operação mais longa" é um pico sobre **tudo** que passa pelo limitador de canais — listagem,
leitura de arquivo, `stat` do Office, escrita por SFTP e o **coletor por servidor**, que roda a cada
5 segundos com `getent` + laço + `base64` por usuário e nunca foi pedido por ninguém. O número saía
sem sujeito, e foi lido a onda inteira como *"quanto custa uma listagem"*.

Dele saíram, e caíram junto: *"95% da latência é nossa"*, *"9,7 operações por segundo"*, *"o piso de
226 ms"* e a inclinação de 596. Nenhuma dessas frases tinha um dono verificado.

**É a família do `activeSessions: 0`**, e a diferença é instrutiva: aquele mentia por não ter
resposta; este mentia por não dizer sobre quem falava. Os dois têm a mesma cara na tela — um número
com autoridade.

O conserto tem três partes:

- **`withSshSlot` aceita um rótulo**, e o pico guarda número e nome **juntos** — se um exec curto
  gravasse o nome sem gravar o tempo, os dois descolariam e o painel voltaria a mentir com outra
  cara;
- **o nome sai da rota, não de 32 rótulos à mão.** Havia 32 chamadas de `execAsUser`; nomear cada
  uma seria 32 decisões a manter, com a certeza de que a 33ª nasceria anônima — que é o próprio
  defeito. `req.route.path` já sabe, e é o **padrão** da rota (`/apps/:id/log`), não a URL
  preenchida: dado de uso não vaza para um painel de administração por causa de um medidor;
- **o prefetch se separa do clique.** Mesmo caminho, custos diferentes, e o prefetch é justamente o
  que roda sem ninguém pedir — o mesmo gênero de operação que produziu este erro.

> **E o que o rótulo já entregou de graça:** o coletor segura um canal por ~493 ms a cada 5 s. É
> ~10% de um dos 8 canais, continuamente, para uma bandeja e um journal. Ninguém tinha olhado
> porque ninguém sabia que aquele número era dele.

### E o coletor fica como está — arquivado com o número e com o gatilho

A tentação era imediata: 493 ms a cada 5 segundos parece caro. Duas coisas seguram a mão.

**A otimização óbvia já estava lá.** A primeira ideia — *"não poll quando não há ninguém
conectado"* — já é o comportamento: o tick itera sobre as sessões vivas, e sem nenhuma ele não toca
em SSH. Vale escrever justamente porque alguém vai ter essa ideia de novo, olhar o `setInterval` e
concluir que ela falta.

**E não há vítima.** Fila de exec 0, espera 0, nas duas medições. Otimizar aqui seria repetir o erro
que esta onda inteira acabou de desmontar: agir sobre um número sem verificar se ele machuca alguém.

**O gatilho está escrito**, e é o que faz isto ser arquivamento e não esquecimento: **volta à mesa
quando "Maior fila de exec" passar de 0**, ou quando um servidor passar a ter muitos usuários
simultâneos — porque o custo do coletor é por servidor e por tick, não por usuário, mas o teto de 8
canais é compartilhado com todo mundo que estiver clicando.

> O que **está** anotado como estranho, para quando alguém voltar: os 493 ms são muito para um exec
> que lê meia dúzia de arquivos, e o piso medido de um exec é ~115 ms. A diferença é o script remoto
> (`getent`, laço, subshell por usuário) — e a decomposição por fase, que já existe, responde isso
> em uma leitura.

O texto abaixo é o que esta seção dizia antes de medir, e fica **como registro do que a medição
derrubou** — não como plano.

#### O que esta seção propunha, e que a medição descartou

Ela descrevia a cadeia de cada listagem —
`ssh exec → sudo -H -u <user> → bash -c → echo → base64 -d → python3 → os.scandir` — e concluía:
*"cinco processos e um interpretador subindo; **é o piso de 226 ms que toda navegação paga**"*.
Daí saíam os três caminhos: tirar processos da cadeia, um daemon por sessão, reusar o canal.

**A frase em negrito era falsa.** A cadeia inteira custa 18 ms. O piso é de outro dono.

Vale dizer como o erro se produziu, porque é reutilizável: a cadeia foi **lida** e pareceu cara —
cinco processos! um interpretador! —, e a aparência foi tratada como medida. Nenhum dos três
caminhos era absurdo; os três eram respostas confiantes a uma pergunta que ninguém tinha feito ao
sistema. É a mesma assinatura da premissa que abriu esta onda (*"cada metadado vira um exec"*), e
ela reapareceu **dentro do próprio conserto**.

Dos três, só *reusar o canal* segue de pé como candidato — e não pelo motivo escrito ali, e sim
porque abrir canal pode ser round-trip. Quem decide agora são as três fases no painel.

<details>
<summary>As duas receitas, já executadas — ficam para refazer depois de cada mudança</summary>

O bloco do piso roda **duas vezes, usando a segunda**: a primeira paga a autenticação do `sudo` e o
cache frio, e isso não é o que a rota paga em regime.

```bash
time python3 -c 'pass'                      # o arranque do interpretador       → 10 ms
time sudo -H -u "$USER" bash -c 'true'      # o sudo + o bash                   → 10 ms
time sudo -H -u "$USER" bash -c 'echo "cGFzcw==" | base64 -d | python3'   # tudo → 18 ms
```

E a inclinação, com o script se cronometrando — o que a rota faz, medido por dentro:

```bash
python3 - <<'EOF'
import os, sys, time, json
p = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/medida/p5000')
t0 = time.perf_counter(); entries = list(os.scandir(p)); t1 = time.perf_counter()
items = []
for e in entries:
    st = e.stat(follow_symlinks=True)
    items.append({'name': e.name,
                  'type': 'directory' if e.is_dir(follow_symlinks=True) else 'file',
                  'size': st.st_size, 'mtime': int(st.st_mtime)})
t2 = time.perf_counter(); s = json.dumps({'path': p, 'items': items}); t3 = time.perf_counter()
print(f"scandir {1000*(t1-t0):6.1f} ms | stat+dict {1000*(t2-t1):6.1f} ms | "
      f"dumps {1000*(t3-t2):6.1f} ms | {len(s)/1024:.0f} KB")
EOF
```

Resultado: p100 → 0,3 ms no total; p5000 → scandir 1,6 · stat+dict 13,1 · dumps 1,5 · 336 KB.

**A suspeita do `follow_symlinks=True` duplicado morreu junto.** A ideia era que `e.is_dir()` depois
de `e.stat()` faria um segundo syscall por entrada; se fizesse, 5.000 entradas não caberiam em 13 ms.
O `DirEntry` do CPython reaproveita o `stat` que já tem, e a otimização de uma linha que parecia
óbvia não tinha o que otimizar.

</details>

#### A previsão que eu tinha escrito, e como ela se saiu

Antes de medir ficou registrado: *"os 822 ms não caem com o corte do payload — ficam entre 780 e
830"*. Deram **874**.

A tese sobreviveu (o corte de bytes não move a latência); **a faixa não**, e faixa errada é previsão
errada. Fica escrita assim, com o número que a furou, porque previsão que se ajusta ao resultado
depois não serve para nada — e porque errar a faixa para **cima** é o sinal de que eu ainda não
sabia onde o tempo estava. Não sabia mesmo: estava no vão que nenhum instrumento cobria.

### 2 · A listagem inteira num JSON só — ✅ a primeira metade; a segunda foi ARQUIVADA

**O `path` era redundante, e agora não viaja.** Toda entrada repetia o diretório-pai inteiro, que o
cliente já tem na mesma resposta. Medido sobre listagens reconstruídas:

| Pasta | Com `path` | Sem | Corte |
|---|---|---|---|
| bancada p5k | 532 KB | 323 KB | 39% |
| bancada p50k | 5.468 KB | 3.282 KB | 40% |
| 5 mil arquivos em diretório de caminho fundo | 866 KB | 398 KB | **54%** |

> **A frase que estava aqui dizia "corta a maior parte do payload", e estava errada.** São 40%, e
> 54% no melhor caso. Escrita sem medir, e o número real muda a leitura: é um corte grande, mas
> **não é onde os 822 ms moram** — ver a arquivação abaixo.

E ninguém comprime esse caminho: não há `compression` no Express nem middleware `compress` no
Ingress do Traefik. Os bytes medidos são os bytes do fio.

**A parte que quase se perdeu: reconstruir e GUARDAR não conserta nada.** A RAM foi o sintoma que
apareceu em uso, e o caminho óbvio — o cliente remonta na chegada e grava no item — devolve o mesmo
array de antes. Em 50 mil entradas de caminho fundo:

| | RAM do array |
|---|---|
| hoje: vem no JSON e fica guardado | 10,3 MB |
| reconstruir e guardar | 9,9 MB — **ganho zero** |
| `path` como **getter no protótipo** | **5,0 MB** |
| não materializar nada (o piso) | 5,0 MB |

O getter custa o mesmo que não ter caminho nenhum, e os ~120 lugares que leem `item.path` seguem
lendo `item.path`. O diretório mora no protótipo: **uma** string por listagem, não 50 mil. Quem faz
isso é `vssh-client/js/FsList.js`, que virou o **leitor único** da rota — a janela de propriedades,
o restaurador de janelas e o título do terminal montavam a URL cada um por sua conta, e teriam
quebrado em silêncio.

> **Compatibilidade de graça, e uma afirmação minha que caiu junto.** Propriedade própria vence
> protótipo, então uma entrada que ainda traga `path` é respeitada — cliente novo conversa com
> servidor antigo. Só que a primeira versão **lançava**: `Object.assign` sobre um acessor sem
> setter é `TypeError`. Estava escrito em comentário que funcionava, e não funcionava. Foi o teste
> que mostrou.

#### Paginar ou streamar — arquivado, com o número que arquiva

A ideia era "uma pasta de 50 mil não precisa chegar de uma vez para a primeira tela ser desenhada".
Ela pressupõe que a chegada é o que custa. Não é:

- `JSON.parse` de 50 mil entradas: **19 ms** antes, **13 ms** depois do corte. Em 5 mil, ~1,3 ms;
- a lista já não desenha o que não cabe na tela (item 3), então a primeira tela **não espera** o
  desenho das outras;
- sobram a transferência e o trabalho remoto — e paginar não toca no trabalho remoto, que é onde os
  822 ms de uma pasta de 5 mil têm de estar.

Paginar partiria ordenação, "selecionar tudo" e contagem em duas verdades, para mexer em algo que
mede um dígito de milissegundo. **Volta à mesa se — e só se — a decomposição do item 1 mostrar a
transferência como termo dominante.**

### 3 · A lista não virtualiza — ✅ concluído

`FileBrowserWindow._patch()` criava **um nó DOM por item, para todos os itens**. 50 mil arquivos
eram 50 mil `.fm-item`, cada um com ícone, nome, tamanho e data. Não era vazamento: era o desenho.

Foi o item mais visível dos três — apareceu em uso, como consumo de RAM do navegador — e o único
puramente do cliente, sem depender de decisão nenhuma de servidor.

**Como ficou.** `_patch` desenha só a fatia que cabe na tela, mais meia tela de folga de cada lado.
Duas **escoras** — caixas vazias antes e depois — reservam a altura das linhas não desenhadas: são
elas que dão à barra de rolagem o tamanho da lista inteira e que mantêm o `offsetTop` dos itens
desenhados batendo com o índice real deles.

A conta é aritmética porque as duas vistas têm célula uniforme, mas a **métrica é medida, não
constante**: zoom, tema e fonte mudam a altura real. É a mesma régua que o `_moveSel` já usava para
contar colunas pelo layout em vez de dividir larguras.

> **O `content-visibility: auto` do CSS continua lá, e não foi substituído.** São coisas diferentes:
> ele pula layout e paint do que está fora da tela; a janela tira o **nó** do DOM. Dentro da janela
> ainda há mais itens do que os visíveis, e é neles que a regra de CSS economiza.

**Os quatro dependentes da geometria, conferidos um a um** — porque `_patch` não é ingênuo:
reconcilia por `data-path`, reusa nós, caminha um cursor de inserção e trata arraste, seleção e
recorte.

| | Veredito |
|---|---|
| `_moveSel` | calcula o alvo por **índice** e só usa o DOM para contar colunas — segue certo |
| `_syncSel` | toca só o desenhado; o resto recebe a classe ao entrar na janela |
| retângulo de seleção | as coordenadas são grampeadas ao viewport e não há rolagem automática, então a caixa nunca alcança item fora da janela |
| `_scrollIntoView` | **quebrava.** Procurava o nó pelo `data-path`, e fora da janela não há nó — `End` numa pasta de 50 mil não faria nada, que é o pior defeito de teclado que existe. Passa a achar por índice e rolar pela conta |

## O bug que a medição achou de graça

`stdout += d.toString()` — cada `Buffer` do canal decodificado isoladamente. Um caractere multibyte
partido na fronteira de dois chunks vira `�`, dos dois lados, sem erro nem log.

Sobreviveu porque **precisa de volume**: só há fronteira quando a saída passa de um chunk, e quase
todo comando do portal devolve poucas linhas. Quem estoura isso é a listagem de pasta grande — com
nomes em português, onde acento é a regra.

Corrigido com `StringDecoder` (e `end()` para a sobra no fechamento). A refutação usa **o código
anterior como ataque**, e ele produz 5 vermelhos.

> Nenhuma leitura de código tinha achado isso em meses. Gerar carga achou em uma tarde — e é o
> argumento inteiro a favor de medir em vez de raciocinar.

## Três defeitos de INSTRUMENTO, achados no caminho

Nenhum dos três é do produto, e os três teriam ficado verdes para sempre.

**A guarda que media a conta e não o uso.** A virtualização entrou com 13 casos verdes sobre
`_janela()` — e a refutação derrubou o mais importante: trocar `todos.slice(inicio, fim)` por
`todos` em `_patch`, ou seja, **desfazer a virtualização inteira**, não produzia um vermelho. Os
testes mediam a aritmética; nenhum media quem a consome. É a assinatura de sempre — duas coisas
certas que não se encontram —, agora dentro do próprio teste. Consertado rodando `_patch` contra
uma grade de mentira e contando nós criados.

**O stripper de comentários que comia código.** O `client-css-classes` tirava comentário de bloco
com `/\*[\s\S]*?\*\//` solto, e isso casa dentro de **regex literal**: `replace(/\/*$/, '/')`
contém a sequência `/*`, e há quatro delas no `FileBrowserWindow.js`. Cada uma vira falsa abertura
e engole código até o próximo `*/` de verdade.

O sintoma é do pior tipo porque é **instável**: enquanto o trecho engolido não tiver nada que o
teste procure, tudo fica verde. Acrescentar um comentário de bloco legítimo mudou o pareamento, o
trecho passou a conter um `querySelector(':not(.sb-icon-tuff)')`, e uma classe viva desde sempre
apareceu como morta — o teste acusou o **código** de um defeito que era do instrumento.

A mesma armadilha já tinha custado 14 KB na guarda de junção do manifesto, e o conserto é o mesmo:
**ancorar na linha**. Todo comentário de bloco desta base começa a linha.

**E o terceiro defeito foi descobrir o tamanho do segundo.** Ao escrever a guarda do payload,
perguntei quantos outros testes escreviam o mesmo stripper solto. Eram **24**, em 21 arquivos — o
conserto do `client-css-classes` tinha sido pontual, não sistêmico. Rodando os dois strippers sobre
a base inteira:

| Fonte | Bytes que o solto engolia |
|---|---|
| `src/routes/system.ts` | **58.586** |
| `vssh-client/js/FileBrowserWindow.js` | **40.402** |
| `js/VsshAppWindow.js` | 9.756 |
| `src/routes/browser.ts` | 7.735 |
| e mais 8 arquivos | 1 a 4 KB cada |

`system.ts` é justamente o arquivo onde vive a rota que esta onda mudou: a guarda que eu ia escrever
teria medido um fonte com 58 KB faltando. **O terceiro defeito não foi achado por um vermelho — foi
achado por perguntar "quantas vezes mais isto está aqui?"**, o que é a pergunta que a reincidência
pedia e que ninguém tinha feito.

Consertado nos 24 lugares, com duas coisas que faltavam:

- **`tests/helpers/sem-comentarios.js`** — onde a lição mora e de onde teste novo importa, com
  `semComentariosCss` à parte, solto de propósito (não há literal de regex em CSS);
- **uma guarda que proíbe a forma solta** em qualquer teste sobre fonte JS. É ela, e não o helper,
  que impede a quarta vez. A guarda precisa montar o padrão proibido em duas metades, senão se
  acusa — o que é engraçado e é também a prova de que ela mede o que diz medir.

> **E a suíte seguiu verde depois de ancorar os 24.** Ancorar só torna o stripper mais fraco: 98 KB
> de código voltaram a ficar visíveis para guardas que dizem "isto NÃO aparece aqui", e nenhuma
> achou nada. Não é o desfecho empolgante — é o desfecho que diz que as 24 estavam medindo menos do
> que anunciavam, e ninguém sabia quanto.

## Estado

| Item | Estado |
|---|---|
| UTF-8 partido na fronteira do chunk | ✅ concluído |
| Instrumentos de pressão (rota + painel + marca d'água) | ✅ concluído — [ver Onda 6](05-arquivos-de-rede.md) |
| 3 · Virtualizar a lista do gerenciador | ✅ concluído · 11 ataques, e o que mais importava passou verde na 1ª rodada |
| 2 · Encolher o payload da listagem | ✅ concluído · −40% de bytes, −51% de RAM; 11 ataques, 2 verdes na 1ª rodada |
| 2b · Paginar ou streamar | 🗄️ arquivado · a chegada custa um dígito de milissegundo; volta se as fases apontarem a travessia |
| 1 · O piso e a inclinação — **decompor o lado remoto** | ✅ medido · o processo remoto é **4%** da operação, e as três hipóteses da seção caíram |
| 1b · Decompor o que sobrou (as três fases do exec) | ✅ medido · **não há gargalo**: a listagem custa 157 ms, distribuídos em 51/64/42 |
| 1c · O pico anônimo | ✅ concluído · o número tinha autoridade e não tinha sujeito, e **os 874 ms eram do coletor** |
| O coletor segurando ~10% de um canal | 🗄️ **arquivado com o número** — ver abaixo |
