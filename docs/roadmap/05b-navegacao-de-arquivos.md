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


| Pasta | Portal entrega | `ls -la` no servidor | **Nosso** |
|---|---|---|---|
| 100 arquivos | 226 ms | ~1 ms | ~225 ms |
| 5.000 arquivos | 822 ms | **44 ms** | **778 ms — 95%** |

**Fila 0 e espera 0** nos dois casos: o teto de 8 canais SSH não foi arranhado. Não é contenção
entre usuários — é a latência de cada clique, e 95% dela é nossa.

Uma pasta de 5 mil arquivos, que não tem nada de excepcional, põe a capacidade do servidor inteiro
em **9,7 operações por segundo**.

> **A premissa que caiu junto.** A Onda 6 dizia que cada operação de metadado vira um `exec` por
> SSH e que num diretório grande "isso é sentido como travamento". `GET /api/fs/list` é **UM**
> exec, com `scandir` e `stat` de tudo dentro do processo remoto — 30 mil arquivos custam um canal,
> igual a três. O que custa não é o número de operações; é o que cada uma carrega.

## Os três itens

### 1 · Um `python3` por pasta aberta

A cadeia de cada listagem:

```
ssh exec → sudo -H -u <user> → bash -c → echo → base64 -d → python3 → os.scandir
```

Cinco processos e um interpretador subindo. **É o piso de 226 ms que toda navegação paga**, e ele
não depende de quantos arquivos existem: aparece igual na home, numa pasta com três itens.

Os caminhos, do mais barato ao mais estrutural:

- **tirar processos da cadeia** — `base64 -d | python3` pode virar `python3 -c` com o código já
  escapado, e o `bash -c` pode sumir se o `sudo` receber o comando direto. Não resolve o arranque
  do interpretador, mas é medida e barata;
- **um daemon por sessão.** O ambiente já tem o conceito: a sessão da Onda 1 tem dono, refcount e
  lease, e o `fs-watch` já mantém um processo longo por `(servidor, usuário)`. Um ajudante que fique
  de pé e responda listagens por um pipe troca "subir python" por "escrever uma linha";
- **reusar o canal.** Hoje cada listagem abre um canal SSH novo. O supervisor de `watch` prova que
  dá para manter um aberto.

**Nada disso está decidido, e o primeiro passo é decompor os 226 ms.** Sem isso, escolher entre os
três caminhos é chutar — que é como esta onda inteira nasceu. A decomposição é de três comandos, no
Terminal do desktop:

```bash
time python3 -c 'pass'                      # o arranque do interpretador
time sudo -H -u "$USER" bash -c 'true'      # o sudo + o bash
time sudo -H -u "$USER" bash -c 'echo "cGFzcw==" | base64 -d | python3'   # a cadeia inteira, local
```

O que **sobrar** dos 226 ms depois de descontar a cadeia local é o custo do canal SSH — abrir e
fechar por listagem. E é esse resto que decide entre os três caminhos:

| Se o dominante for | O caminho é |
|---|---|
| o arranque do `python3` | o daemon por sessão — nenhum dos outros dois toca nisso |
| `sudo` + `bash` | tirar processos da cadeia, que é a mudança barata |
| o canal SSH | reusar o canal, como o supervisor de `watch` já faz |

#### E há um SEGUNDO número a decompor, que não tem instrumento nenhum

O piso é o que não depende do tamanho. Mas 100 arquivos custam 226 ms e 5.000 custam 822 — são
**596 ms de inclinação**, ~0,12 ms por arquivo, e o `ls -la` da mesma pasta faz o trabalho de
filesystem inteiro em 44 ms. Depois do corte do payload, a chegada explica um dígito de
milissegundo disso. **O resto está dentro do processo remoto, e nada hoje o mede.**

O jeito de medir é o script se cronometrar. Um comando, no Terminal do desktop, que faz exatamente
o que a rota faz:

```bash
python3 - <<'EOF'
import os, time, json
p = os.path.expanduser('~/medida/p5000')
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

| Se o dominante for | O que ele quer dizer |
|---|---|
| `stat+dict` | é syscall por entrada, e a suspeita a checar é o `follow_symlinks=True` do `is_dir` — se ele não estiver reaproveitando o `stat` já feito, são dois syscalls onde cabe um |
| `dumps` | serializar é o custo, e aí menos campos por entrada vale mais do que parecia |
| `scandir` | é o filesystem, e a comparação com os 44 ms do `ls -la` diz o quanto o Python cobra por cima |
| nada disso — sobra tempo | então a inclinação está **fora** do python, na travessia dos bytes, e é aí que paginar volta à mesa |

**Rodar isto antes de escolher qualquer caminho do item 1.** A tabela do piso e esta se cruzam: uma
diz de onde vem o que toda pasta paga, a outra de onde vem o que a pasta grande paga a mais.

E rodar o bloco do piso **duas vezes, usando a segunda**: a primeira paga a autenticação do `sudo` e
o cache frio, e essa parte não é o que a rota paga em regime.

#### Uma previsão escrita antes da medida

O corte do payload (item 2) já está no ar. Se a chegada fosse onde a latência mora, os 822 ms de uma
pasta de 5 mil teriam caído junto com os 40% de bytes.

> **Previsão: não caem. Ficam entre 780 e 830 ms.**

Está escrito aqui porque previsão que só aparece depois do resultado não é previsão. Se eles caírem
de verdade, a leitura desta onda inteira está errada sobre onde está o gargalo, e a decomposição
muda de alvo antes de qualquer implementação — o que é exatamente o serviço que ela deve prestar.

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
| 2b · Paginar ou streamar | 🗄️ arquivado · a chegada custa um dígito de milissegundo; volta se a decomposição apontar a transferência |
| 1 · O piso de 226 ms **e a inclinação de 596** | ⬜ não iniciado · **duas decomposições antes de escolher o caminho** |
