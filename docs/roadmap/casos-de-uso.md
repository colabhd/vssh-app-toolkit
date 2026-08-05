# Casos de uso — 20 arquétipos e o que bloqueia cada um

> **Estado:** vigente · **Atualizado:** 2026-08-05 (revisão contra o código: A1, A4 e A5 tinham
> bloqueios que já não existem — ver as notas ⁽¹⁾ e ⁽²⁾)

O que faz sentido rodar num ambiente remoto voltado a pesquisa, e o que falta em cada caso. As
referências apontam para [diagnostico.md](diagnostico.md) e para as ondas.

## Categoria A — Aplicações com janela (`type: "app"`)

| # | Arquétipo | Exemplos | Bloqueio hoje |
|---|---|---|---|
| A1 | Notebook / IDE científico | JupyterLab, RStudio, Marimo, Positron | Uma janela por app ([Onda 4](04-runtime-composicao.md)); `kind:"service"` **com** janela ninguém mediu — ver a nota ⁽¹⁾; sem aviso de célula longa |
| A2 | Dashboard de dados | Streamlit, Panel, Dash, Voilà, Shiny | **Quase pronto.** Atrito: o healthcheck síncrono de 15 s bloqueia o clique e esses frameworks demoram a subir; sem warm-start ([Onda 4](04-runtime-composicao.md)) |
| A3 | Visualizador científico | Parquet, HDF5, Zarr, NetCDF, FITS, DICOM, OME-TIFF | **T1 e T2** ([Onda 3](03-toolkit.md)); e `SharedArrayBuffer` para os que usam WASM multi-thread |
| A4 | Editor / gestão de conhecimento | Logseq (portado), Obsidian, Zotero, Joplin, LaTeX | **T6** (a ponte `fs` sem `exists`/`rename`/`copy`); uma janela por app ([Onda 4](04-runtime-composicao.md)) — ver a nota ⁽²⁾ |
| A5 | Anotação / rotulagem | CVAT, Label Studio, anotação de áudio/vídeo | Sem drag-and-drop do gerenciador para o app; disputa de teclado só resolvida **com o motor X11 ligado** — ver a nota ⁽²⁾ |
| A6 | Terminal | — | Questão em aberto ([diagnostico](diagnostico.md#15-questões-em-aberto)) |
| A7 | Navegador | Scramjet engine (+ extensão MV2) | Questão em aberto |
| A8 | Banco / consulta | DuckDB UI, pgAdmin, SQLite browser, Trino | Sem cofre de segredos ([Onda 4](04-runtime-composicao.md)); sem descoberta entre apps ([Onda 5](04-runtime-composicao.md)) |

> ⁽¹⁾ **Três bloqueios de A1 caíram na revisão de 2026-08-05, e o texto anterior os afirmava.**
> *"Kernel morre com a janela"* — **não morre**: `VsshAppWindow._onClose` só solta listeners do
> cliente, nada no shell chama `/stop`, e o backend sobe com `nohup setsid`. O único `/stop` do
> ambiente é o botão de Configurações → Serviços, que é ação explícita. E `kind:"service"` **com**
> janela não é *"combinação não suportada"*: `routes/apps.ts:75-81` diz que `kind` (lifecycle) é
> **ortogonal** a `type` (janela/sem janela), e o launcher só filtra `type === 'engine'`. O que
> ninguém mediu é o resto — o supervisor relançando um serviço com janela aberta, e a janela
> reatando ao processo novo. **Nenhuma onda é dona dessa medição**, e ela é barata.
>
> ⁽²⁾ **O clipboard saiu da lista.** A ponte de arquivos existe (`vssh.clipboard.files()`, e imagem
> por `vssh.clipboard.readImage()`, [`docs/api.md`](../api.md)) desde a Onda 2. A4 citava **T5**,
> que foi corrigido na Onda 0 — o que sobra dali é o **T6**. Sobra também o drag-and-drop do
> gerenciador para dentro do app, que não está em onda nenhuma.

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

**Gap transversal:** não existe registro de capabilities **entre apps instalados**, nem RPC tipado.
Para chegar num backend, `AppLauncher.ensureRunning(appId)` + `fetch` cru continua sendo o caminho, e
o consumidor fixa o `appId` no código. Sem `provides: ["llm/v1"]` no manifest e resolução
capability→app no shell, cada consumidor fica acoplado a um produtor específico.

O mecanismo, porém, **deixou de ser especulação**: a [Onda 2.7](02b-motores.md) pôs
`RemoteDesktopEngines.comCapacidade(nome)` em produção — resolução por capacidade, com o consumidor
nunca escrevendo um `id`. O que falta é levá-la de "motores registrados nesta página" para "apps
instalados no servidor". Ver [Onda 5](04-runtime-composicao.md#registro-de-capabilities).

## Categoria C — Daemons / serviços (`kind: "service"`)

| # | Arquétipo | Falta |
|---|---|---|
| C1 | Sincronização / transferência (rclone, Syncthing, Globus, S3/MinIO) | A bandeja aceita `badge` de ponto/contador/texto, mas **não de progresso contínuo**; sem notificação persistente |
| C2 | Job de longa duração (treino, simulação, Nextflow/Snakemake) | Tudo de C1 + **sem cgroups** + sem GPU runtime |
| C3 | Monitoramento (disco/quota, GPU, processos) | — a bandeja entrega o indicador permanente (`TrayArea.js`) |
| C4 | Indexação em background (Recoll indexer, embeddings) | idem C1 |
| C5 | Backup / snapshot | idem C1 |
| C6 | Instrumento de laboratório (serial/USB) | **São dois casos.** Instrumento na **bancada do laboratório**, alcançável de qualquer máquina — é o que casa com a estrela-guia, e **continua sem solução** (precisaria de um `engine` falando com o dispositivo no host). Instrumento **no laptop do pesquisador** — WebSerial/WebUSB resolve, mas amarra o trabalho àquela máquina |

> #### ⚠ Duas correções a esta tabela (2026-08-05)
>
> **"Supervisor atrelado ao Xpra" era falso, e saiu.** O supervisor sempre foi o do vssh-app
> (`vssh-app-supervisor`, para `kind:"service"`), e nunca dependeu de X11 — a Categoria C não estava
> bloqueada por isso. Depois da [Onda 2.7](02b-motores.md) a relação inverteu de vez: **o Xpra é que
> é supervisionado por ele**, como qualquer outro serviço.
>
> **"Sem tray" saiu de A4 e C3.** A bandeja existe desde a Onda 2.1 (`TrayArea.js`), com
> `{ icon, tooltip, badge, menu, onClick }` e badge de ponto, contador ou texto. O que falta em C1 é
> mais estreito e continua verdadeiro: **progresso contínuo** não cabe num badge de três caracteres.

**A Categoria C dependia do tray, e ele chegou.** "Configurações → Serviços" nunca substituiria um
indicador permanente — ninguém abre Configurações para saber se o rclone está sincronizando —, e é
por isso que a Onda 2.1 o entregou antes do resto.

E há uma dificuldade real de desenho, que é o que faz a [Onda 2](02-apis-de-shell.md) começar pelo
transporte: um `engine`/`service` **não tem iframe**, logo não tem `postMessage`. A ponte atual é
inteiramente janela-a-janela.

## O que isso diz sobre a ordem

- A **Onda 1** (sessão) destrava a Categoria C inteira — sem ela, daemon nenhum sobe num ambiente
  sem X11.
- A **Onda 2** (tray) é o que torna a Categoria C *utilizável*, não só possível.
- A **Onda 3** (FSA) é o único bloqueio real de A3, e o principal de A4/A5.
- A **Onda 6** (arquivos de rede) é o que muda a experiência de A3 e A8 em dataset grande.
