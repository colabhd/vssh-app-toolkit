# Roadmap do ecossistema vssh-app

> **Atualizado:** 2026-08-02

Este diretório é o plano vivo do ecossistema VSSH — portal (`vssh-sso`), shell de desktop
(`vssh-client/`) e este toolkit. Não é um documento de uma vez só: **cada arquivo tem cabeçalho
de estado e é para ser atualizado conforme avançamos**, não reescrito.

## A estrela-guia

O ambiente é **remoto e portátil**: o pesquisador senta em qualquer máquina, abre o navegador e tem
ali todos os recursos — que **não dependem daquela máquina**. Tudo aqui é julgado por esse critério.

Duas consequências que precisam estar ditas antes de qualquer tabela:

1. **"Sem apps Linux" ≠ "sem servidor Linux".** O modelo vssh-app exige um host Linux rodando
   backends; o que sai de cena é o **X11**, não a máquina. "Perfil headless" significa servidor sem
   servidor gráfico. Sem essa distinção, metade das decisões abaixo parece contraditória.
2. **Toda capacidade que depende da máquina do cliente é ponte para fora, não recurso do ambiente.**
   Útil, às vezes a única opção — mas nunca a resposta para "o ambiente tem X".

## Como ler

| Arquivo | O que tem |
|---|---|
| [diagnostico.md](diagnostico.md) | Onde estamos: matriz de prontidão sem-X11, dívidas do toolkit e da plataforma, questões em aberto |
| [casos-de-uso.md](casos-de-uso.md) | 20 arquétipos de aplicação, motor e daemon — e o que bloqueia cada um |
| [criterios.md](criterios.md) | Os dois critérios de projeto que toda decisão atravessa |
| [00-limpeza-de-terreno.md](00-limpeza-de-terreno.md) | Onda 0b — limpeza do `vssh-sso`: exclusões, renames, provisionador unificado |
| [0c-colapso-de-variantes.md](0c-colapso-de-variantes.md) | Onda 0c — matar o tema `neon` e o modo `dock`: uma variante de UI, não duas |
| [01-sessao-sem-xpra.md](01-sessao-sem-xpra.md) | Onda 1 — desacoplar o ciclo de vida da sessão do Xpra |
| [02-apis-de-shell.md](02-apis-de-shell.md) | Onda 2 — tray, notificações, relógio, clipboard, impressão, mixer, Configurações |
| [03-toolkit.md](03-toolkit.md) | Ondas 0 e 3 — higiene do toolkit e a FSA de verdade |
| [04-runtime-composicao.md](04-runtime-composicao.md) | Ondas 4 e 5 — limites de recurso, GPU, composição entre apps |
| [05-arquivos-de-rede.md](05-arquivos-de-rede.md) | Onda 6 — camada de arquivos de rede sem salto pelo Linux |
| [06-portabilidade.md](06-portabilidade.md) | Onda 7 — continuidade entre máquinas |

**A numeração não é sequência total.** Ondas 0, 6 e 7 não dependem das outras e podem correr em
paralelo. Só a Onda 2 depende da 1; a Onda 3 é pré-requisito real dos arquétipos A3/A4/A5. A
**Onda 0c é pré-requisito da 2.6** e recomendada antes da 2.2 — enquanto houver duas variantes de
UI, cada superfície nova nasce com duas para manter.

## Estado

| Onda | Item | Repo | Estado |
|---|---|---|---|
| 0 | Documentação da roadmap | toolkit | ✅ concluído |
| 0 | Higiene (versionamento, `lib/web/`, template, electron-shim, docs) | toolkit | ✅ concluído |
| 0 | Confinamento do `static-spa` (bug achado na verificação) | toolkit | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 1 — exclusões, aliases de compat, docs superadas | vssh-sso | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 2 — renames (`custom_xprahtml5` → `vssh-client` e cia.) | vssh-sso | ✅ concluído |
| 0b | [Limpeza](00-limpeza-de-terreno.md) Fase 3 — provisionador unificado + eixo headless | vssh-sso | ✅ concluído |
| 0c | [Colapso de variantes](0c-colapso-de-variantes.md) — fim do tema `neon` e do modo `dock` | vssh-sso | ✅ concluído |
| 1 | [Sessão desacoplada do Xpra](01-sessao-sem-xpra.md) | vssh-sso | ✅ concluído |
| 2 | [Canal shell↔app sem iframe](02-apis-de-shell.md#o-transporte-o-coletor-por-servidor---feito) — coletor por servidor | vssh-sso | ✅ concluído |
| 2 | [Tray](02-apis-de-shell.md#21--tray---concluída) — as duas fontes (janela e `engine`/`service`) | vssh-sso + toolkit | ✅ concluído |
| 2 | [Taskbar honesta](02-apis-de-shell.md#o-item-irmão-que-apareceu-ao-testar-a-taskbar-mentia---feito): capabilities + tela cheia no hambúrguer | vssh-sso | ✅ concluído |
| 2 | Pré-requisitos: helper `anchorPanel()` e extrair o `/ws/events` do `Client.js` | vssh-sso | ⬜ não iniciado |
| 2 | Centro de notificações **+ relógio** | vssh-sso + toolkit | ⬜ não iniciado |
| 2 | Clipboard (ponte de arquivos + imagem) | vssh-sso + toolkit | ⬜ não iniciado |
| 2 | Tela de impressão do ambiente | vssh-sso + toolkit | ⬜ não iniciado |
| 2 | [Mixer de volume por aplicação](02-apis-de-shell.md#25--mixer-de-volume-por-aplicação) | vssh-sso + toolkit | ⬜ não iniciado |
| 2 | [Configurações refeitas](02-apis-de-shell.md#26--a-janela-de-configurações-refeita) + registro interno de seção | vssh-sso | ⬜ não iniciado |
| 3 | FSA de verdade (`LazyFile`, `slice`, OPFS) | toolkit | ⬜ não iniciado |
| 4 | Runtime: cgroups, GPU, múltiplas instâncias, segredos | vssh-sso | ⬜ não iniciado |
| 5 | Composição: `provides`, pontos de extensão, mensageria, seção de Configurações por manifesto | vssh-sso + toolkit | ⬜ não iniciado |
| 6 | Camada de arquivos de rede | vssh-sso | ⬜ não iniciado |
| 7 | Continuidade entre máquinas | vssh-sso + toolkit | ⬜ não iniciado |

## Questões em aberto

Decisões que precisam ser tomadas, não tarefas a executar. Detalhadas em
[diagnostico.md](diagnostico.md#15-questões-em-aberto).

- **`SharedArrayBuffer`** — habilitar cross-origin isolation (COOP/COEP) ou não? Decide se WASM
  multi-thread (DuckDB-WASM, Pyodide com threads) é viável. **Precisa ser decidido antes**, não depois.
- **Terminal persistente** — `terminal-latch` não se firmou. Qual o caminho?
- **Extensão de navegador** — o Scramjet se provou; ainda vale manter a extensão?
- **Isolamento de apps** — o modelo atual é "um admin instalou, portanto é confiável". Quando cair,
  a fronteira tem de ser no processo, não na origem.

## Como manter

- Ao concluir um item, mude o estado na tabela acima **e** o cabeçalho do arquivo correspondente.
- Achou que uma premissa estava errada? **Corrija no lugar e diga que estava errada** — vários
  achados deste diagnóstico vieram de premissas que pareciam sólidas. O histórico do erro vale mais
  que a aparência de acerto.

### Antes de executar uma onda, confira as afirmações dela contra o código

Não é conselho, é passo. Ao planejar a Onda 1, **três das premissas conferidas estavam erradas**:
que o shell abria `/ws/events` nos dois modos (não abria — e isso era **bug em produção**, um shell
sem Xpra não recebia o sinal de migração); que o desktop tinha de ficar na mesma URL (o contrato era
a **profundidade** do path, não o path); e que o `startXpra` provisionava o usuário (nunca
provisionou — quem faz isso é o `provisionKey` e o `startCodeServer`).

Custou alguns `grep`. Evitou construir o lease sobre um canal que não existia no perfil que a onda
inteira servia.

**E o critério certo, que a revisão seguinte precisou aprender:** uma afirmação vale quando diz **o
que a coisa faz**, não que ela está lá. "`#taskbar-tray` já existe" tinha arquivo e linha e estava
correta sobre o elemento — e escondia que não há tray nenhuma, só um container vazio alimentado por
um renderizador de pixmap do upstream que morre sem X11. *Já existe* é a formulação que esconde
trabalho enquanto parece rigorosa.

### Conferir não basta: alguém tem de tentar REFUTAR

O levantamento da [Onda 0c](0c-colapso-de-variantes.md) foi o primeiro em que cada achado passou por
um segundo par de olhos com uma instrução só — *derrube isto*. O resultado justifica o passo:

- **duas propostas minhas caíram**, e as duas eram plausíveis. Desligar os proxies de janela no
  perfil headless não funcionaria (os proxies declaram `pointer-events: auto` **inline**, e
  descendente vence ancestral); e içar as 22 chamadas de `captureKeyboard` para a classe base tem
  ganho de runtime **zero** e semântica divergente entre os call sites;
- **duas "deleções óbvias" teriam quebrado a taskbar** — `xdg_image` e `slick.js` pareciam código do
  dock e são usados pelo Launchpad, pelo Start Menu e pelo Alt+Tab;
- **os dois pontos de maior raio não estavam em inventário nenhum** — a classe base de toda janela e
  a fábrica de ícone dos diálogos.

A diferença entre conferir e refutar é a pergunta. Conferindo, pergunta-se *"isto está lá?"*;
refutando, *"o que acontece quando eu tirar?"*. Só a segunda encontra o que sustenta outra coisa.

**E quando a refutação atinge o que você mesmo propôs, ela vale mais, não menos** — o custo de
descobrir isso na roadmap é uma linha reescrita; no código, é um perfil quebrado que só aparece na
mão de quem usa.
- Item novo entra no arquivo da onda que faz sentido, e na tabela de estado. Onda nova só se
  realmente não couber em nenhuma.
