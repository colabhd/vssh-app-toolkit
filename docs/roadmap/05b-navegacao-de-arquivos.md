# Onda 6b — A navegação de arquivos, medida

> **Estado:** em execução · **Atualizado:** 2026-08-08 · **Repo:** `vssh-sso`
> **Independente de tudo** — inclusive da [Onda 6](05-arquivos-de-rede.md), de onde ela saiu.

## De onde esta onda veio

Ela não estava na roadmap. Apareceu quando fomos **medir** a Onda 6, e o que a medição mostrou não
tinha nada a ver com o que a Onda 6 é: os números não falam de armazenamento de rede, falam do
caminho que o portal usa para listar **qualquer** pasta, inclusive a home em disco local.

Separá-las é o ponto. A Onda 6 depende de uma decisão de protocolo que ainda não foi tomada; esta
não depende de nada e melhora a navegação de hoje.

## A medida

Servidor real, diretórios sintéticos em **disco local** (nenhum NFS envolvido):

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

**Nada disso está decidido, e o primeiro passo é decompor os 226 ms**: quanto é abrir o canal,
quanto é `sudo`+`bash`, quanto é o arranque do `python3`. Sem isso, escolher entre os três caminhos
é chutar — que é como esta onda inteira nasceu.

### 2 · A listagem inteira num JSON só

50 mil entradas, cada uma com `path` **absoluto**, viram megabytes que atravessam o canal SSH, o
portal e o `JSON.parse` do navegador. Duas coisas óbvias e independentes:

- **o `path` é redundante.** Toda entrada repete o diretório-pai inteiro, que o cliente já sabe.
  Mandar só o `name` e montar o caminho no cliente corta a maior parte do payload sem perder nada;
- **paginar ou streamar.** Uma pasta de 50 mil não precisa chegar de uma vez para a primeira tela
  ser desenhada.

### 3 · A lista não virtualiza

`FileBrowserWindow._patch()` cria **um nó DOM por item, para todos os itens**. 50 mil arquivos são
50 mil `.fm-item`, cada um com ícone, nome, tamanho e data. Não é vazamento: é o desenho.

É o item mais visível dos três — foi o que apareceu em uso, como consumo de RAM do navegador — e o
único que é puramente do cliente, sem depender de nenhuma decisão de servidor.

> **Cuidado que o `_patch` merece:** ele não é ingênuo. Reconcilia por `data-path`, reusa nós,
> caminha um cursor de inserção para não remexer a ordem, e trata arraste, seleção e recorte. A
> virtualização tem de preservar tudo isso — e é por isso que ela é o item com mais chance de
> quebrar algo que já funciona.

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

## Estado

| Item | Estado |
|---|---|
| UTF-8 partido na fronteira do chunk | ✅ concluído |
| Instrumentos de pressão (rota + painel + marca d'água) | ✅ concluído — [ver Onda 6](05-arquivos-de-rede.md) |
| 3 · Virtualizar a lista do gerenciador | ⬜ em execução |
| 2 · Encolher o payload da listagem | ⬜ não iniciado |
| 1 · O piso de 226 ms | ⬜ não iniciado · **decompor antes de escolher o caminho** |
