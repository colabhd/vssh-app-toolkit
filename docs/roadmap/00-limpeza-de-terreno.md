# Onda 0b — Limpeza de terreno do `vssh-sso`

> **Estado:** Fases 1 e 2 concluídas · Fase 3 não iniciada · **Atualizado:** 2026-08-02
> **Repo:** `vssh-sso` (trabalho direto na `main` — o portão é o CI barrando subida para o Argo)

Arrumar o terreno antes de mexer no que importa: apagar o inútil, renomear o que mente, e
consolidar `infra/server/` num utilitário único já com o eixo headless.

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
- **O bloco de eslint do `vssh-client` ficou.** `npx eslint vssh-client` acusa ~1560
  problemas, então incluí-lo no portão o deixaria vermelho permanentemente. Mas o bloco não é morto:
  sem ele, um `eslint .` trataria o cliente como ESM com globals de Node e produziria ruído *pior*.
  Caminho para trazê-lo ao portão: zerar por subdiretório, começando por `js/browser/` (código nosso).

---

## Fase 2 — Renames ✅ **concluída**

**247 arquivos, 199 renomeações.** Portões verdes: `tsc`, `eslint`, 156 testes, zero links markdown
quebrados, sintaxe de shell, e o contrato do artefato conferido ponta a ponta.

| De | Para |
|---|---|
| `custom_xprahtml5/` | `vssh-client/` |
| `infra/xpra-server/` | `infra/server/` |
| `docs/xpra-client/` | `docs/client/` |
| `getUserXpraPort` | `getUserDesktopPort` |
| `xpra-browser` / `xpra-fileserver` | `vssh-browser` / `vssh-fileserver` |
| `xpra-player://` | `vssh-player://` |
| `/usr/share/xpra/custom-www*` | `/usr/share/xpra/vssh-client-www*` |
| `vssh-update-xpra-client` (+ units systemd) | `vssh-update-client` |
| `GET/POST/PUT /api/admin/servers/:id/xpra-client/*` | `.../client/*` |

**Ficaram, e é escolha:** `startXpra`/`stopXpra` e a classe `XpraClient` de `Client.js` — são
literalmente sobre o xpra, o protocolo. Renomeá-las seria mentir ao contrário.

### O que a Fase 2 ensinou

**Um rename não é uma substituição de texto — é três, e elas não coincidem.** Cada armadilha abaixo
teria passado por um `sed` global:

- **`xpra-server` também é nome de pacote apt** (`provision-base.sh:122`, na lista de pins do
  repositório do xpra). Trocar a string teria quebrado a instalação do xpra em todo provisionamento
  novo — e só no servidor, longe do CI.
- **`xpra-client` era duas coisas ao mesmo tempo:** o diretório de docs e um endpoint da API. Os dois
  viraram `client`, mas por caminhos separados. Colapsar num replace só teria acertado um.
- **Link markdown relativo não carrega o prefixo do diretório.** `docs/README.md` aponta para
  `xpra-client/README.md`, não `docs/xpra-client/README.md` — então renomear o diretório não os
  alcançava. Só uma varredura que **resolve** cada link contra o disco pega isso.

**E um replace pode quebrar o que compila.** Dois casos, ambos do rename que acabou revertido:
`data-xpra-update` virou `data-client-update` no HTML, mas o acessor `dataset.xpraUpdate` ficou —
`undefined` silencioso, sem erro. E `customclient:` era uma **chave de objeto**; `vssh-client` com
hífen não é identificador válido, e aí o `tsc` reclamou. O primeiro caso é o perigoso: nome com
hífen no markup vira camelCase no DOM, e as duas pontas precisam ser renomeadas juntas.

### Decidido diferente do plano, com o motivo

- **O artefato do repositório continua se chamando `customclient`.** O plano mandava renomeá-lo, mas
  o critério que justificou todos os outros renames — *o nome mente, diz xpra* — **não se aplica a
  ele**. E era o único que mexeria em **dado vivo**: `kind`/`name` em D1, escopos de token, com
  migration e deploy do Worker obrigatoriamente na mesma janela. Custo de migração de estado para um
  ganho só de vocabulário. O que foi renomeado é o que de fato dizia xpra e vive dentro do portal (o
  endpoint `/xpra-client/*`, `getXpraClientStatus`/`updateXpraClient`, o rótulo da UI). `repo-worker/`
  ficou com diff zero.
- **Os paths `custom-www*` voltaram à cadeia de fallback de `xpra.ts`, marcados como transitórios.**
  Exceção deliberada à regra de arrancar compat, e o motivo é ordem de deploy: o Argo sobe o portal
  assim que o CI passa, mas quem cria `/usr/share/xpra/vssh-client-www` é o updater **no servidor**.
  Na janela entre os dois, a cadeia antiga cairia direto em `/usr/share/xpra/www` — o cliente do
  upstream Xpra, sem nada do desktop VSSH — para **todo** usuário, até alguém entrar por SSH.
- **O `.gitattributes` ganhou os cinco daemons do tarball do cliente** (`vssh-browser`,
  `vssh-fileserver`, `vssh-psdialog`, `vssh-psdialogd`, `vssh-vscode`). A regra dele já dizia
  "scripts que rodam em Linux, mesmo em checkout no Windows"; eles se qualificam e estavam de fora.
  Os shebangs já estavam em LF — isto fecha a regra antes de alguém commitar de um checkout Windows.

### Limpeza manual no servidor, depois do deploy

Nada remove os nomes antigos. O `pkill` é o único com consequência silenciosa: o fileserver velho
continua segurando a porta 18765 e o novo não binda.

```bash
sudo vssh-update-binaries --force          # instala o /usr/local/sbin/vssh-update-client
sudo vssh-update-client stable && sudo vssh-update-client bleeding-edge
sudo systemctl disable --now vssh-xpra-client-update.timer
sudo pkill -x xpra-fileserver
sudo rm -f /usr/local/bin/xpra-browser /usr/local/bin/xpra-fileserver \
           /usr/local/sbin/vssh-update-xpra-client \
           /usr/local/share/applications/xpra-browser.desktop
sudo rm -rf /usr/share/xpra/custom-www /usr/share/xpra/custom-www-bleedingedge
```

Confirmado no painel admin (Repositório → Cliente mostra o build instalado por canal), as duas linhas
de fallback transitório do `xpra.ts` podem sair.

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
- **`XPRA_FILE_SERVER_PORT`** e `XPRA_CUSTOM_HTML_PATH`/`XPRA_BLEEDINGEDGE_HTML_PATH` — as env vars
  sobreviveram à Fase 2 com o prefixo antigo. Nenhuma está no `configmap` do k8s, então hoje só os
  defaults do código rodam; renomeá-las é barato mas mexe em `.env.example` e docs sem ganho até
  alguém precisar sobrescrevê-las.
- **`servers.xpra_client_channel`** — coluna do SurrealDB, na mesma situação. Renomear exige migrar
  as linhas existentes; foi por isso que ficou fora da Fase 2.
