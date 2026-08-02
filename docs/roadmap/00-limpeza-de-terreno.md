# Onda 0b — Limpeza de terreno do `vssh-sso`

> **Estado:** Fase 1 concluída · Fases 2 e 3 não iniciadas · **Atualizado:** 2026-08-02
> **Repo:** `vssh-sso` (trabalho direto na `main` — o portão é o CI barrando subida para o Argo)

Arrumar o terreno antes de mexer no que importa: apagar o inútil, renomear o que mente, e
consolidar `infra/xpra-server/` num utilitário único já com o eixo headless.

A varredura achou mais do que desarrumação. Achou **coisas quebradas em produção** — as três estão
detalhadas na Fase 3, porque é lá que somem.

---

## Fase 1 — Exclusões e docs ✅ **concluída**

**60 arquivos, −11.801 linhas.** Portões verdes: `tsc`, `eslint`, 150 testes (149 + 1 auto-pulado).

| Item | O quê |
|---|---|
| 1.1 | Removidos `scripts/`, `.claude/skills/` e `examples/` (+ submódulo `terminal-latch`) — com o job `skill-sync` do CI, que fazia `diff -u` bloqueante contra o toolkit |
| 1.2 | Órfãos de referência zero: `clipboard/crypto/digest.html`, `icons-tuff.css`, `empty.png`, `loading-xpra.html` |
| 1.3 | **simple-keyboard (296 KB)** — carregado em toda sessão e nunca instanciado; `connect.css`; `ORG_LOGO_URL` |
| 1.4 | Aliases de compat arrancados: `PseudoNativeAppWindow`, `UrlViewerWindow` (o alias, não a classe), `VSSH_XPRA_REPO`, `VSSH_INFRA_SCRIPTS_REPO`, `vssh-update-infra-scripts` |
| 1.5 | Diagnóstico deixado para trás: os dois `DIAGNÓSTICO TEMPORÁRIO` de `terminal.ts`, 9 `console.log("[Keyboard] …")` que disparavam por tecla acentuada, log por POST no proxy |
| 1.6 | Docs: removido **conteúdo superado**, não só links mortos |
| 1.7 | Escopo do lint documentado |

### O que a Fase 1 ensinou

**A doc mais perigosa não é a que falta — é a que descreve um código que não existe mais.**
`src/services/README.md` descrevia `key-provisioner.js` como um "god-module de ~2381 LOC" com cinco
ciclos de vida. Hoje tem **393 linhas**: o resto virou `provisioning/` com cinco arquivos. Também
documentava `getUserElectronPort` (que não existe em lugar nenhum do código) e alertava sobre "dois
pools SSH independentes" que **já haviam sido consolidados** — o `ssh-exec.ts` diz literalmente ser
a fonte única. Quem lesse essa doc para planejar um refactor planejaria contra um fantasma.

**Números em doc apodrecem em silêncio.** As contagens de endpoint diziam 85 (README) e 98
(`docs/api/`). São **126**. A correção veio com o comando de recontagem ao lado da tabela.

**Uma lacuna real no `.gitattributes`:** `vssh-app-supervisor` é publicado como binário, não tem
extensão (então `*.sh` não pega) e não tinha linha de `eol=lf`. Num checkout Windows o shebang
viraria `#!/bin/bash\r` e quebraria no servidor.

### Decidido diferente do plano, com o motivo

- **O formulário do `connect.html` ficou.** O plano supunha que apagar só o `connect.css` deixaria o
  formulário quebrado — mas o CSS **nunca teve `<link>`**, então ele já roda sem estilo. E removê-lo
  não é limpeza: 20 call sites de JS no mesmo arquivo dependem dos campos, e 1330 das 1792 linhas
  são script. Seria reescrever o arquivo até sobrar a tela de disconnect.
- **O bloco de eslint do `custom_xprahtml5` ficou.** `npx eslint custom_xprahtml5` acusa ~1560
  problemas, então incluí-lo no portão o deixaria vermelho permanentemente. Mas o bloco não é morto:
  sem ele, um `eslint .` trataria o cliente como ESM com globals de Node e produziria ruído *pior*.
  Caminho para trazê-lo ao portão: zerar por subdiretório, começando por `js/browser/` (código nosso).

---

## Fase 2 — Renames ⬜ **não iniciada**

Sem bloqueio cross-repo: com `.claude/skills/` fora, a amarra com o toolkit deixou de existir.

| De | Para | Cuidado |
|---|---|---|
| `custom_xprahtml5/` | `vssh-client/` | **Falha silenciosa:** os `paths:` de `publish-customclient.yml` e `chrome-extension.yml` param de disparar sem erro |
| `infra/xpra-server/` | `infra/server/` | Barato: `app.ts:146` monta `/infra` apontando *para* o diretório — a URL pública `/infra/vssh-register.sh` não muda |
| `docs/xpra-client/` | `docs/client/` | — |
| `getUserXpraPort` | `getUserDesktopPort` | 8 ocorrências |
| `customclient` | `vssh-client` | D1, R2, escopo de token, e a URL que o servidor pede |
| `vssh-update-xpra-client` | `vssh-update-client` | O `name` é a chave de rastreio; desabilitar o timer velho |
| `xpra-browser` / `xpra-fileserver` | `vssh-browser` / `vssh-fileserver` | `.desktop`/mimeapps por sessão; `pkill -x` por nome exato |
| `custom-www*` | `vssh-client-www*` | `rsync --delete` deixa o path antigo órfão |

`startXpra`/`stopXpra` ficam: são literalmente sobre o xpra.

**Ordem:** repo primeiro (verificável por CI), servidor depois, `customclient` por último — é o
único cujo passo em falso deixa o servidor sem atualização.

---

## Fase 3 — Provisionador unificado ⬜ **não iniciada**

Substitui cinco scripts por **um** `infra/server/vssh-provision.sh`.

```
vssh-provision.sh --target <lxd|pct|vm|here> [<VMID-ou-nome>] [opções]
```

**Plataforma é subcomando; GPU e perfil são flags** (`--gpu`, `--profile x11|headless`). A matriz é
4×2×2 — nomear arquivo por combinação foi o que produziu 5 e produziria 16. É isso, e só isso, que
impede o `pct-create-foo.sh` de voltar.

### Os três bugs que a consolidação dissolve

- **`pct-create.sh` está quebrado**: empurra 3 dos 5 arquivos que `provision-base.sh` exige via
  `cp "$(dirname $0)/…"`. Com `set -euo pipefail`, o provisionamento **aborta na l. 205**; as
  l. 83-87 do próprio script são código morto que rodaria depois do abort.
- **`lxc-create-nvidia.sh` nunca instala `100-vssh-gpu.conf`**: a variante "LXD com GPU" sobe usando
  Xvfb por software.
- **`cloud-init.yaml` nunca invoca `provision-base.sh`** — é a única variante **documentada como
  funcionando que não funciona**.

A correção é estrutural, não pontual: `provision-base.sh` ganha `fetch_asset()` e **o host deixa de
precisar saber a lista de arquivos**. É esse acoplamento que quebrou o `pct-create.sh`, e ele some
sem o arquivo ser tocado.

### A consequência técnica que dita a arquitetura

O provisionador tem que ser buscável por `curl` — hoje o portal emite `bash pct-create-nvidia.sh 201`
**sem dizer de onde o arquivo vem**. Mas sob `bash <(curl …)`, `$0` é `/dev/fd/63`: `$(dirname "$0")`
e `source lib/*.sh` deixam de funcionar. Distribuir por HTTP e matar a duplicação do bloco de push
são, portanto, a **mesma** decisão.

### Eixo headless

Decompor o `nala install` monolítico de 44 pacotes em `PKGS_CORE`/`PKGS_X11`/`PKGS_MEDIA`/
`PKGS_SEARCH`/`PKGS_GPU`. **A propriedade que torna o corte revisável:** `--profile x11` tem de
produzir conjunto **byte-idêntico** ao atual — materializar com `--print-packages` + fixture em CI.
Sem isso, cortar 185 linhas é fé; com isso, é diff.

---

## Registrado, não executado

- **`CUSTOM_XPRA_USERS`** (`xpra.ts:187`) — 5 usernames decidindo quem recebe bleeding-edge. Existe
  `servers.xpra_client_channel`, mas o eixo é por **servidor** e a lista é por **usuário**.
- **`sshUser === 'arthur.carrenho'`** (`xpra.ts:171`) — escolhe `Xorg` em vez de `Xvfb` para um
  usuário nomeado.
- **`/media/hdvm05/scripts/shell-script/…`** (`user-setup.ts:70`) — caminho absoluto de um mount
  específico, hardcodado no provisionamento de usuário.
- **Escapes de HTML** — duas funções chamadas `_escAttr` com semânticas **incompatíveis**
  (`VsshWindow._escAttr` escapa só `"`; `browser/*._escAttr` escapa `&<>"`).
- **`connect.html`** — poderia encolher de 1792 para ~130 linhas (só a tela de disconnect), mas é
  reescrita, não limpeza.
- **`design-tokens.css` duplicado** — ver [criterios.md](criterios.md); **não tocar antes de remover
  o tema neon**, senão o trabalho é feito duas vezes.
- **`_eagerStartAlwaysRunningEngines`** — bloqueado até o supervisor ser validado num servidor real.
