# Onda 6 — Camada de arquivos de rede

> **Estado:** não iniciado · **Atualizado:** 2026-08-01 · **Repo:** `vssh-sso`
> **Independente das Ondas 1–2** — pode correr em paralelo.

## O problema, com número

Hoje o caminho de um dataset de rede é:

```
navegador → portal → canal SSH → host Linux → cliente NFS → storage
```

Dois saltos de rede, e o do meio disputa um orçamento de **~8 canais concorrentes para o servidor
inteiro** ([diagnostico](diagnostico.md#-teto-de-canais-ssh-8-por-servidor-não-por-usuário)).

NFS piora o caso: operações de metadado (`readdir`, `stat`) são conversadas por natureza, e cada uma
vai embrulhada num `exec` por SSH. Num diretório de dataset com milhares de arquivos, isso é sentido
como travamento — e, sob contenção, como os 409 de `da6bfb5`.

**Tirar a navegação de dados do SSH não é só latência: é devolver canais ao orçamento** que hoje
limita quantos pesquisadores cabem num servidor.

## O desenho: providers por ponto de montagem

Extrair de `src/routes/system.ts` um contrato de provider — `list`, `stat`, `read` com Range,
`write`, `mkdir`, `rename`, `copy`, `delete` — e rotear por prefixo de montagem:

| Provider | Serve | Toca o host Linux? |
|---|---|---|
| `ssh` | home do usuário e tudo que precisa do host | sim (é o de hoje) |
| `s3` / `webdav` / `http-index` | datasets de rede | **não** |

As montagens são declaradas por servidor/usuário e alimentadas pelo catálogo que o
`dataset-management` já publica (`indices.json` em `bases.colabh.org`) — hoje consumido só pelo
Recoll (`src/routes/recoll.ts`).

## As duas otimizações que são o ganho real

**Redirect assinado para leitura em massa.** `GET /api/fs/read` devolve 302 para uma URL pré-assinada
quando o provider suporta, e o navegador puxa os bytes **direto do storage**, com Range. Tira o portal
do caminho dos dados — é o que torna viável um viewer transmitindo um OME-TIFF de dezenas de GB (A3).

**Cache de metadado em Redis.** Datasets de pesquisa são majoritariamente imutáveis, então
`readdir`/`stat` cacheiam muito bem — ao contrário da home do usuário.

## Duas armadilhas de contrato que precisam ser declaradas

**`watch` é dependente de provider.** Não há inotify em S3 nem em WebDAV. `vssh.fs.watch` promete
algo que nem todo caminho pode cumprir — precisa virar **capability opcional por montagem**, com
resposta honesta em vez de silêncio. Um app que vigia um dataset remoto tem de saber que não vai
receber evento.

**`vssh.fs.urlFor()` é síncrono** e devolve URL do portal. Com redirect assinado ela passa a apontar
para **outra origem**: funciona em `<img>`/`<video>`, mas quebra `fetch` que espere mesma origem e
conta como taint em canvas. Tem que estar documentado em [`../api.md`](../api.md) antes de a
funcionalidade existir.

## Dois consumidores com necessidades diferentes

Este é o limite honesto do desenho, e precisa estar dito:

| Consumidor | Quer | Solução |
|---|---|---|
| **Navegador** (gerenciador, viewers, polyfill FSA) | HTTP com Range | VFS do portal — estritamente melhor que hoje |
| **Backend de um vssh-app** (kernel Jupyter, script Python, job de treino) | **POSIX**: `open()`, `seek`, `mmap` | montagem no host — o VFS não substitui. Caminho: avaliar `mountpoint-s3`/`rclone mount` no lugar do NFS, que costumam ganhar em dataset imutável dominado por leitura |
| **App que só precisa dos bytes** | HTTP | consome o mesmo endpoint do próprio backend e **dispensa montagem** — opção que hoje não existe e que o toolkit deveria documentar |

## Por que isso serve à estrela-guia

Navegar e ler dados deixa de exigir o host Linux — mais uma capacidade que passa a funcionar sem
sessão. E como as montagens são declaradas no servidor, **elas seguem o pesquisador entre máquinas
de graça** ([critério 3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)).
