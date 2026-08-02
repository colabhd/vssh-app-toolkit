# Casos de uso — 20 arquétipos e o que bloqueia cada um

> **Estado:** vigente · **Atualizado:** 2026-08-01

O que faz sentido rodar num ambiente remoto voltado a pesquisa, e o que falta em cada caso. As
referências apontam para [diagnostico.md](diagnostico.md) e para as ondas.

## Categoria A — Aplicações com janela (`type: "app"`)

| # | Arquétipo | Exemplos | Bloqueio hoje |
|---|---|---|---|
| A1 | Notebook / IDE científico | JupyterLab, RStudio, Marimo, Positron | Kernel morre com a janela — precisa de `kind:"service"` **com** janela, combinação não suportada; uma janela por app; sem aviso de célula longa |
| A2 | Dashboard de dados | Streamlit, Panel, Dash, Voilà, Shiny | **Quase pronto.** Atrito: o healthcheck síncrono de 15 s bloqueia o clique e esses frameworks demoram a subir; sem warm-start ([Onda 4](04-runtime-composicao.md)) |
| A3 | Visualizador científico | Parquet, HDF5, Zarr, NetCDF, FITS, DICOM, OME-TIFF | **T1 e T2** ([Onda 3](03-toolkit.md)); e `SharedArrayBuffer` para os que usam WASM multi-thread |
| A4 | Editor / gestão de conhecimento | Logseq (portado), Obsidian, Zotero, Joplin, LaTeX | **T5**; sem tray; uma janela por app; colar imagem depende da API de clipboard ([Onda 2](02-apis-de-shell.md)) |
| A5 | Anotação / rotulagem | CVAT, Label Studio, anotação de áudio/vídeo | Sem ponte com o clipboard de arquivos do shell; sem drag-and-drop do gerenciador para o app; disputa de teclado só resolvida no modo xpra |
| A6 | Terminal | — | Questão em aberto ([diagnostico](diagnostico.md#15-questões-em-aberto)) |
| A7 | Navegador | Scramjet engine (+ extensão MV2) | Questão em aberto |
| A8 | Banco / consulta | DuckDB UI, pgAdmin, SQLite browser, Trino | Sem cofre de segredos ([Onda 4](04-runtime-composicao.md)); sem descoberta entre apps ([Onda 5](04-runtime-composicao.md)) |

## Categoria B — Motores (`type: "engine"`)

Backend sem janela, consumido por uma feature já existente do desktop.

| # | Arquétipo | Falta |
|---|---|---|
| B1 | Reescrita/proxy web | — é a referência (`scramjet-wisp`) |
| B2 | Índice / busca | Recoll hoje é app com janela; como engine precisaria de registro de capability |
| B3 | Inferência LLM/ML (ollama, vLLM, TGI) | **GPU como runtime**; limites de memória; **descoberta** |
| B4 | Miniatura, preview, transcodificação, **render de PDF** | `FileOpener.js` é mapa fixo extensão→ação: **não há ponto de extensão** para um engine contribuir |
| B5 | LSP / build server | idem B3 |
| B6 | Gateway de kernels Jupyter | idem B3 |

**Gap transversal:** não existe registro de capabilities nem RPC tipado.
`AppLauncher.ensureRunning(appId)` + `fetch` cru é o estado da arte. Sem `provides: ["llm/v1"]` no
manifest e resolução capability→app no shell, cada consumidor fica acoplado a um produtor específico
e o ecossistema não compõe. Ver [Onda 5](04-runtime-composicao.md).

## Categoria C — Daemons / serviços (`kind: "service"`)

| # | Arquétipo | Falta |
|---|---|---|
| C1 | Sincronização / transferência (rclone, Syncthing, Globus, S3/MinIO) | Supervisor atrelado ao Xpra; **sem tray com progresso**; sem notificação persistente |
| C2 | Job de longa duração (treino, simulação, Nextflow/Snakemake) | Tudo de C1 + **sem cgroups** + sem GPU runtime |
| C3 | Monitoramento (disco/quota, GPU, processos) | Precisa de indicador permanente — ou seja, **tray** |
| C4 | Indexação em background (Recoll indexer, embeddings) | idem C1 |
| C5 | Backup / snapshot | idem C1 |
| C6 | Instrumento de laboratório (serial/USB) | **São dois casos.** Instrumento na **bancada do laboratório**, alcançável de qualquer máquina — é o que casa com a estrela-guia, e **continua sem solução** (precisaria de um `engine` falando com o dispositivo no host). Instrumento **no laptop do pesquisador** — WebSerial/WebUSB resolve, mas amarra o trabalho àquela máquina |

**Toda a Categoria C é inviável sem tray.** "Configurações → Serviços" não substitui um indicador
permanente — ninguém abre Configurações para saber se o rclone está sincronizando.

E há uma dificuldade real de desenho, que é o que faz a [Onda 2](02-apis-de-shell.md) começar pelo
transporte: um `engine`/`service` **não tem iframe**, logo não tem `postMessage`. A ponte atual é
inteiramente janela-a-janela.

## O que isso diz sobre a ordem

- A **Onda 1** (sessão) destrava a Categoria C inteira — sem ela, daemon nenhum sobe num ambiente
  sem X11.
- A **Onda 2** (tray) é o que torna a Categoria C *utilizável*, não só possível.
- A **Onda 3** (FSA) é o único bloqueio real de A3, e o principal de A4/A5.
- A **Onda 6** (arquivos de rede) é o que muda a experiência de A3 e A8 em dataset grande.
