# Ondas 4 e 5 — Runtime de apps e composição do ecossistema

> **Estado:** não iniciado · **Atualizado:** 2026-08-02 · **Repos:** `vssh-sso` + toolkit

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

Hoje GPU existe só no provisionamento (`vssh-provision.sh --gpu`, que passa o passthrough ao host e
delega a config de Xorg ao `provision-base.sh --gpu` dentro do guest). Não há API de runtime, nem
agendamento, nem pedido por app, nem visibilidade no portal.

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
**`/ws/events`** avisar que subiu — o canal já é por sessão e aberto nos dois perfis desde a
[Onda 1](01-sessao-sem-xpra.md); não há segundo socket a criar (ver
[Onda 2.0](02-apis-de-shell.md#canal-shellnavegador-usar-o-wsevents-não-criar-um-segundo)). É o
atrito que separa A2 de "quase pronto" para "pronto".

### "Atualizei o app e nada mudou" — o par de suspeitos, anotado antes de esfriar

Ao publicar o `hello-world-node` com a bandeja, o app **só** funcionou depois de um `Shift+F5`;
fechar e reabrir a janela não bastou. O sintoma some com um hard reload, então parece cache — mas
os cabeçalhos estão certos, e é por isso que isto vira nota em vez de conserto.

O que já foi conferido, para ninguém refazer:

- `lib/node/static-spa.js` serve `index.html` com `Cache-Control: no-store` e os assets com
  `no-cache`. Corretos os dois;
- o service worker do shell é registrado com `scope: './'` a partir de `/proxy/vssh-desktop/`, então
  **não** intercepta `/proxy/app/<id>/`. Não é ele.

Sobraram dois suspeitos, e eles pedem consertos diferentes:

**A — validador fraco.** A única prova de frescor dos assets é o `Last-Modified`, comparado por
igualdade de string. Ele depende do mtime sobreviver a `cp -a` (publish) → `tar -czf` →
`rsync -a` (`vssh-app-install`) — cadeia longa para um validador de granularidade de 1 segundo. Se
o mtime não avançar em algum ponto, o servidor devolve **304** e o navegador fica com o arquivo
velho, sem erro em lugar nenhum. Conserto: `ETag` sobre o conteúdo, validador forte e imune a
mtime, com o 304 continuando a custar zero bytes.

**B — não era cache: era o backend ainda subindo.** `startApp` mata e reinicia o processo quando o
hash do código muda. A primeira abertura depois de um reinstall pode pegar o processo antigo ou em
reinício; o `Shift+F5` teria vencido o relógio, não o cache. **Se for B, o conserto é o healthcheck
assíncrono acima** — hoje o poll síncrono de 15×1 s termina devolvendo uma janela que parece pronta
e não está.

**Como separar os dois**, na próxima atualização de app, antes de consertar qualquer coisa: feche e
reabra a janela uma **segunda** vez, sem `Shift+F5`. Funcionou? Era B. Continuou velho? Era A — e dá
para confirmar pedindo o asset com `cache:'no-store'` de dentro do iframe e vendo se o conteúdo novo
está lá enquanto a página ainda mostra o antigo.

O `ETag` provavelmente vale de qualquer forma: depender só do mtime é frágil demais para ser a
única garantia de que um app atualizado chega ao navegador. Mas medir primeiro — foi o que a
[revisão da roadmap](README.md#antes-de-executar-uma-onda-confira-as-afirmações-dela-contra-o-código)
estabeleceu, e aqui a medição custa uma janela reaberta.

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
