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

### 2 · A listagem inteira num JSON só

50 mil entradas, cada uma com `path` **absoluto**, viram megabytes que atravessam o canal SSH, o
portal e o `JSON.parse` do navegador. Duas coisas óbvias e independentes:

- **o `path` é redundante.** Toda entrada repete o diretório-pai inteiro, que o cliente já sabe.
  Mandar só o `name` e montar o caminho no cliente corta a maior parte do payload sem perder nada;
- **paginar ou streamar.** Uma pasta de 50 mil não precisa chegar de uma vez para a primeira tela
  ser desenhada.

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

## Dois defeitos de INSTRUMENTO, achados no caminho

Nenhum dos dois é do produto, e os dois teriam ficado verdes para sempre.

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

## Estado

| Item | Estado |
|---|---|
| UTF-8 partido na fronteira do chunk | ✅ concluído |
| Instrumentos de pressão (rota + painel + marca d'água) | ✅ concluído — [ver Onda 6](05-arquivos-de-rede.md) |
| 3 · Virtualizar a lista do gerenciador | ✅ concluído · 11 ataques, e o que mais importava passou verde na 1ª rodada |
| 2 · Encolher o payload da listagem | ⬜ não iniciado |
| 1 · O piso de 226 ms | ⬜ não iniciado · **decompor antes de escolher o caminho** |
