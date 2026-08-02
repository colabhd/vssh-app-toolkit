# Os dois critérios de projeto

> **Estado:** vigente · **Atualizado:** 2026-08-01

Duas perguntas antes de construir qualquer coisa. Puxam em direções opostas, e é por isso que
precisam ser feitas juntas: a primeira decide **como entregar**, a segunda decide **onde guardar**.

---

## 3.1 — O navegador já faz isso?

Tratar "não existe no VSSH" como sinônimo de "precisa ser construído no VSSH" é caro. O shell roda
num navegador, e várias capacidades já existem a um `if` de distância.

Mas o critério tem **dois limites**, e ignorá-los foi o erro da primeira versão deste diagnóstico.

> ### Limite 1 — o desktop roda em tela cheia
> Se a resposta a "onde isso aparece?" for "numa parte do navegador que não existe em tela cheia",
> **não resolve**. Notificação do SO e badge de PWA são **complemento**; a tray na nossa taskbar e um
> centro de notificações próprios continuam **obrigatórios**.
>
> ### Limite 2 — o artefato tem que nascer no ambiente remoto
> Toda API do navegador que **produz** algo (PDF, gravação, arquivo) deposita no cliente por padrão —
> e isso quebra a estrela-guia. O destino padrão tem que ser o ambiente remoto; o cliente é exceção
> explícita. Foi a impressão que ensinou isso, e a regra vale para todas as linhas ⚠ abaixo.

| API do navegador | Para quê | Custo | Ressalva |
|---|---|---|---|
| `window.print()` | Um dos três destinos da tela de impressão | trivial | ⚠ Imprime no cliente. Não cobre "PDF no ambiente" nem impressora de rede |
| Notification API + Service Worker | **Complemento** ao centro de notificações | baixo | Limite 1. O shell já tem `sw.js` |
| `navigator.setAppBadge()` | **Complemento** ao badge da taskbar | trivial | Limite 1. Depende de PWA instalada |
| `BroadcastChannel` | Mensageria entre apps | trivial | Funciona hoje porque tudo é same-origin. Acoplado à decisão de isolamento |
| `getDisplayMedia` / `MediaRecorder` | Captura e gravação (A5) | baixo | ⚠ A gravação cai no cliente. Precisa subir para o ambiente por padrão |
| WebSerial / WebUSB / WebHID | Instrumento **no laptop** (C6, caso 2) | médio | ⚠ Amarra o trabalho àquela máquina. Não resolve o caso da bancada |
| FSA **nativa** (Chrome/Edge) | Ponte para o disco **do cliente** | médio | ⚠ Ponte para fora, não capacidade do ambiente. Convive com o polyfill, que já se auto-desativa |
| `navigator.wakeLock` | Sessão longa não dorme durante um job | trivial | — |
| Page Visibility API | Heartbeat do lease (Onda 1) | trivial | Distinguir "aba em segundo plano" de "usuário foi embora" muda o grace period |
| Window Management (`getScreenDetails`) | Multi-monitor (Onda 4) | médio | — |
| Media Session API | Controles de mídia do SO para apps A/V | trivial | — |
| WebGPU / OffscreenCanvas | Visualizador científico (A3) | — | Já disponível ao app **sem nada nosso** |

**A exceção cara:** `SharedArrayBuffer` exige cross-origin isolation e é a única linha que precisa
ser decidida antes, não depois. Ver
[diagnostico.md](diagnostico.md#15-questões-em-aberto).

---

## 3.2 — Isso sobrevive à troca de máquina?

O pesquisador deve poder pular de um computador para outro sem perder nada. Isso torna **todo estado
guardado no navegador uma dívida**.

| Onde | O quê | Consequência |
|---|---|---|
| `localStorage` | Grants de arquivo (`AppGrants.js`) | Trocou de máquina, perdeu as permissões |
| `IndexedDB` | Handles persistidos pelo `fsa-polyfill` | Trocou de máquina, o app não reabre a pasta de trabalho |
| **OPFS** | Cache de DuckDB-WASM / sqlite-wasm / Pyodide | **Armadilha silenciosa** — ver a regra abaixo |

### Regra para autores de app: OPFS é cache, nunca a verdade

O padrão natural de `sqlite-wasm` é usar OPFS como armazenamento **primário** — e isso perde tudo ao
trocar de máquina, sem erro nenhum. A verdade vai para o ambiente remoto; OPFS é aceleração
reconstruível.

Entregar OPFS ([Onda 3](03-toolkit.md)) sem essa regra é entregar uma armadilha — por isso as duas
coisas saem juntas, e a regra entra em [`../api.md`](../api.md).

### Sobre os grants: boa parte não precisava existir

O modelo de permissão da File System Access API nasceu no navegador porque os arquivos são da
**máquina do usuário** e o web app é código de terceiro. Aqui o caminho está no **ambiente remoto**,
e o **backend do próprio app já roda como aquele usuário Linux, com acesso POSIX a tudo** que o grant
protegeria.

Para caminho remoto, portanto, o grant **não é fronteira**: é UX (o seletor é como o usuário diz
"esta pasta") e rede contra erro de programação — o que `AppGrants.js:21-24` já afirma. Sendo
preferência e não segurança, **sincronizar no servidor é barato**.

**A distinção que a documentação precisa nomear** — são dois regimes na mesma API:

| Regime | Quem é dono da permissão | Sincroniza? |
|---|---|---|
| Caminho **remoto** (polyfill FSA) | nós | sim — é preferência, e o grant é cerimonial |
| Caminho **local do cliente** (FSA nativa) | o navegador | não — per-máquina por natureza, e não é nossa para sincronizar |

### O que já está do lado certo

Estado de janela em lock files (`~/.vssh/psd/*.lock`) e preferências em `/api/user/settings`. Servem
de modelo para o resto.

---

## Como aplicar

Todo item das Ondas 2, 4 e 5 atravessa as duas perguntas antes de virar tarefa. Se a resposta da
primeira for "sim, o navegador faz", ainda falta checar os dois limites. Se a resposta da segunda for
"não sobrevive", o item não está pronto para ser executado — só para ser redesenhado.

A portabilidade não é só critério: virou entrega na [Onda 7](06-portabilidade.md).
