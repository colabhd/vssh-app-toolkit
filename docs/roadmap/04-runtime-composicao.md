# Ondas 4 e 5 — Runtime de apps e composição do ecossistema

> **Estado:** não iniciado · **Atualizado:** 2026-08-01 · **Repos:** `vssh-sso` + toolkit

---

## Onda 4 — Runtime de apps

O que falta para um app ser um cidadão de primeira classe do ambiente, e não um processo solto.

### Limites de recurso

Não há cgroup nem `systemd-run` por app. **Um treino desgovernado derruba a sessão inteira do
usuário** — inclusive o shell, o gerenciador de arquivos e os outros apps.

Caminho: `systemd-run --scope --user` com `MemoryMax`/`CPUQuota`, ou cgroup v2 direto no
`vssh-app-run`. Declarável no manifest, com default generoso.

> A opção de usar unidades systemd para o **lifecycle** já foi avaliada e rejeitada em
> `vssh-sso/docs/refactor-backlog.md`. Isto aqui é diferente: usar systemd só para **conter**
> recursos, mantendo o lifecycle onde está.

### GPU como conceito de runtime

Hoje GPU existe só no provisionamento (`infra/server/lxc-create-nvidia.sh`). Não há API de
runtime, nem agendamento, nem pedido por app, nem visibilidade no portal.

Mínimo viável: `gpu: true` no manifest, `CUDA_VISIBLE_DEVICES` injetado no processo, e o estado
visível em Configurações. Sem isso, o arquétipo B3 (inferência) não tem como conviver com outros
consumidores da mesma placa.

### Múltiplas instâncias e múltiplas janelas

Uma instância por `(usuário, app)`, uma janela por app. Isso bloqueia A1 diretamente — um pesquisador
quer dois notebooks abertos lado a lado, não abas dentro de uma janela.

Interage com `Window Management (getScreenDetails)` do [critério do navegador](criterios.md#31--o-navegador-já-faz-isso)
para o caso multi-monitor.

### Healthcheck assíncrono

`POST /api/apps/:id/start` faz poll do healthcheck até 15×1 s **de forma síncrona, bloqueando o
clique do usuário**. Streamlit, Panel e RStudio demoram a subir — o resultado é uma janela que parece
travada.

Caminho: devolver imediatamente com estado `starting`, e a janela mostrar "carregando" até o
`/ws/shell` avisar que subiu. É o atrito que separa A2 de "quase pronto" para "pronto".

### Cofre de segredos

Um app que fala com banco, com S3 ou com uma API externa não tem onde guardar credencial. Cada app
inventa o seu — normalmente um arquivo em texto plano no `VSSH_APP_DATA_DIR`.

---

## Onda 5 — Composição do ecossistema

Hoje o ecossistema **não compõe**: cada consumidor de motor fica acoplado a um produtor específico.

### Registro de capabilities

`AppLauncher.ensureRunning(appId)` + `fetch` cru é o estado da arte. O consumidor precisa **fixar o
`appId` no código**.

Proposta: `provides: ["llm/v1"]` no manifest, e resolução **capability → app** no `AppLauncher`. Um
app de chat pede `llm/v1` e recebe o motor que estiver instalado, seja ollama, vLLM ou outro. Isso é
o que permite trocar o produtor sem tocar em nenhum consumidor.

Primeiro consumidor real sugerido: o **engine de impressão** (`print/v1`) da
[Onda 2.4](02-apis-de-shell.md) — nasce como caso concreto em vez de abstração especulativa.

### Ponto de extensão no `FileOpener`

`vssh-client/js/FileOpener.js` é um **mapa fixo** de extensão → ação. Não há como um engine
contribuir miniatura, preview ou render (arquétipo B4). Um engine de thumbnails, um de OCR ou um
transcodificador não têm onde se plugar.

### Mensageria entre apps

`BroadcastChannel` resolve hoje, e custa quase nada — porque tudo é same-origin.

> **Acoplamento a registrar:** é o mesmo fato que torna o isolamento fraco
> ([diagnostico](diagnostico.md#15-questões-em-aberto)). Se um dia houver origem separada por app,
> `BroadcastChannel` deixa de funcionar e a mensageria precisa passar pelo shell.
