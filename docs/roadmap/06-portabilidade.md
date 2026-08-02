# Onda 7 — Continuidade entre máquinas

> **Estado:** não iniciado · **Atualizado:** 2026-08-01 · **Repos:** `vssh-sso` + toolkit

A estrela-guia diz que o pesquisador pula de um computador para outro e não perde nada. Isso era
**critério** ([3.2](criterios.md#32--isso-sobrevive-à-troca-de-máquina)) e não era **entrega** em
lugar nenhum. Esta onda conserta.

## 1. Grants e handles migram para o servidor

Hoje: grants em `localStorage` (`AppGrants.js`), handles do polyfill FSA em `IndexedDB`. Trocou de
máquina, o app não reabre a pasta de trabalho e as permissões somem.

Isso ficou **barato** depois que o critério 3.2 estabeleceu que o grant de caminho remoto é
preferência, não segurança — o backend do app já roda como o usuário Linux com acesso POSIX a tudo
que o grant protegeria. Não há invariante de segurança a preservar na migração.

- `AppGrants` deixa de ser `localStorage` e passa a `/api/user/settings` (ou store equivalente),
  chaveado por usuário;
- o `fsa-polyfill` passa a reidratar de estado do servidor, com o `IndexedDB` como **cache**;
- os dois migram **juntos** — um handle sem grant é handle morto, e um grant sem handle é órfão.

**Não migra:** permissão da FSA **nativa**, que é do navegador e per-máquina por natureza. São dois
regimes na mesma API, e a documentação precisa nomear qual é qual.

## 2. Sessão que segue o pesquisador

Estado de janela **já** está no servidor, em lock files (`~/.vssh/psd/*.lock`) — este é o pedaço que
já está do lado certo. O que falta é **reconciliação**.

`WindowStateManager.restoreAll()` roda **uma vez por carga de página**, e **duas máquinas simultâneas
hoje disputam os mesmos lock files**: as duas restauram o mesmo conjunto de janelas e as duas
escrevem por cima uma da outra.

**Isto é design, não implementação, e é pré-requisito de tudo o mais nesta onda.** As opções:

| Modelo | Comportamento |
|---|---|
| **Handoff** | a segunda máquina assume; a primeira é notificada e solta (a sessão "se muda") |
| **Espelho** | as duas veem o mesmo conjunto, com sincronização contínua (caro, e conflitos de foco/geometria) |
| **Escopos separados** | cada máquina tem seu conjunto de janelas, com o estado de app compartilhado |

O handoff é o que mais se parece com "levantar da mesa e sentar em outra", que é a metáfora da
estrela-guia. Mas a decisão não está tomada.

Fica melhor **depois da [Onda 1](01-sessao-sem-xpra.md)**, que é onde nasce um conceito de sessão com
dono — sem ele não há a quem perguntar "quem está com esta sessão agora?".

## 3. Regra "OPFS é cache"

Documentada em [`../api.md`](../api.md) e verificada nos apps de referência. Ver
[criterios.md](criterios.md#regra-para-autores-de-app-opfs-é-cache-nunca-a-verdade) — sai junto com a
[Onda 3](03-toolkit.md), porque entregar OPFS sem a regra é entregar a armadilha.

## 4. Artefatos nascem no ambiente

O [limite 2 do critério do navegador](criterios.md#31--o-navegador-já-faz-isso), aplicado
sistematicamente: gravação de tela, PDF de impressão, download, exportação — **destino padrão
remoto**, cliente por escolha explícita.

Isso é uma varredura, não um item único: cada lugar que hoje produz um `Blob` e chama
`URL.createObjectURL` + `<a download>` é um candidato.

## Nota sobre o alcance

"Trocar de máquina" aqui significa **máquina cliente**, não servidor. Estado que vive no host Linux
do usuário (lock files, journal de notificações, `VSSH_APP_DATA_DIR`) está do lado certo e segue o
usuário naturalmente — desde que ele volte ao mesmo servidor.

Portabilidade **entre servidores** é outra questão, maior, e não está nesta onda.
