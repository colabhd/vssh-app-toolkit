# Onda 0b — Limpeza de terreno do `vssh-sso`

> **Estado:** ✅ concluída (Fases 1, 2 e 3) · **Atualizado:** 2026-08-02
> **Repo:** `vssh-sso` (trabalho direto na `main` — o portão é o CI barrando subida para o Argo)

Arrumar o terreno antes de mexer no que importa: apagar o inútil, renomear o que mente, e
consolidar `infra/server/` num utilitário único já com o eixo headless.

A varredura achou mais do que desarrumação. Achou **coisas quebradas em produção** — as três estão
detalhadas na Fase 3, porque é lá que sumiram.

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

## Fase 3 — Provisionador unificado ✅ **concluída**

**18 arquivos, +1.417/−1.062.** Cinco scripts (718 linhas) viraram um `vssh-provision.sh` de 460.
Portões: `tsc`, `eslint`, **178 testes** (eram 156), links, sintaxe shell.

```
vssh-provision.sh --target <lxd|pct|vm|here> [<VMID-ou-nome>] [opções]
```

**Plataforma é subcomando; GPU e perfil são flags.** A matriz é 4×2×2 — nomear arquivo por
combinação foi o que produziu 5 e produziria 16.

### Os três bugs se dissolveram, nenhum foi consertado pontualmente

- **`pct-create.sh` empurrava 3 dos 5 arquivos exigidos** e abortava com `set -e`. O `fetch_asset()`
  inverteu a responsabilidade — o guest busca os próprios assets, o host não conhece lista nenhuma.
  O bug sumiu sem o arquivo ser tocado; o arquivo foi apagado depois.
- **`lxc-create-nvidia.sh` nunca instalava o `100-vssh-gpu.conf`.** A config de GPU migrou para o
  guest: `provision-base.sh --gpu` detecta o BusID e gera o `xorg.conf`. Nenhuma variante de host
  consegue esquecer, porque nenhuma participa. Morreram junto o `nvidia-utils-<major>` do apt (só o
  `.run` na versão exata do host) e o `security.privileged=true` do LXD.
- **`cloud-init.yaml` nunca chamava o `provision-base.sh`** — `runcmd` era um `sysctl` e dois `echo`.
  Agora busca por HTTP com placeholders renderizados, que é a única forma possível: não há como
  empurrar arquivo numa VM que ainda não bootou.

### Eixo headless

44 pacotes viraram `PKGS_CORE`/`X11`/`MEDIA`/`SEARCH`/`GPU`. A propriedade que tornou o corte
revisável em vez de fé:

```
antes: 44  depois: 44 · diff: IDÊNTICO
```

Headless cai para 32. A fixture trava **quais** 12 saem — se um pacote gráfico cair em CORE por
engano, o headless continuaria "funcionando", arrastando X11 junto. Headless também pula o repo apt
do Xpra e o `apt-mark hold`.

### O que impede a fragmentação de voltar

Três travas, porque a promessa "não crie `pct-create-foo.sh`" sozinha não vale nada:

1. Teste de CI falha se `infra/server/*-create*.sh` reaparecer.
2. `provision-targets.json` é **emitido pelo próprio script** (`--describe`), com paridade afirmada
   em CI — duas fontes de verdade sobre os alvos seria o mesmo problema por outra porta.
3. `installBuilder.js` valida contra esse catálogo: **o portal não consegue oferecer opção que o
   provisionador ignore.** As 7 abas viraram 4 alvos + toggles de GPU e perfil.

### O que a Fase 3 ensinou

**A opção aceita-e-ignorada é pior que a opção ausente.** O levantamento já sabia de
`CORES`/`MEMORY` em LXD e `GPU_INDEX` em lxc+nvidia; a execução achou mais: `SKIP_ONLYOFFICE` e
`USE_WARP` **nunca funcionaram** em nenhum alvo de container, porque `pct exec -- bash script.sh`
não carrega ambiente algum. O operador marcava "pular OnlyOffice", copiava o comando, e o OnlyOffice
era instalado. É por isso que a regra virou dura: **env var errada é silenciosa, flag errada é
erro** — três env no total, todas sobre onde fica o portal, nunca sobre o que instalar.

**Converter env em flag é uma mudança de contrato, e ela vaza para quem emite o comando.** Ao fazer
a conversão eu quebrei o one-liner do portal, que ainda emitia as quatro como env. Encontrado por
varredura de chamadores, não por teste — não havia teste. Agora há.

### Decidido diferente do plano, com o motivo

- **`--gpu` em `--target vm` avisa em vez de aceitar.** Passthrough para VM exige `vfio` no host,
  que o script não faz. Aceitar e ignorar seria reproduzir exatamente o defeito que a fase inteira
  ataca.
- **O `userdata` do cloud-init virou `chmod 600`, não 644.** Quando `VSSH_SERVER_TOKEN` é
  renderizado, o arquivo passa a conter um segredo em claro no disco do host Proxmox.
- **`--target here` substituiu o modo `base`** e cobre também bare-metal e cloud-init manual. É
  literalmente `bash provision-base.sh`, que agora funciona por `curl` sem nenhum arquivo ao lado.

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
  o tema neon**, senão o trabalho é feito duas vezes. ➜ **destravado pela
  [Onda 0c](0c-colapso-de-variantes.md)**, que é justamente a remoção do neon.
- **`_eagerStartAlwaysRunningEngines`** — bloqueado até o supervisor ser validado num servidor real.
- **`XPRA_FILE_SERVER_PORT`** e `XPRA_CUSTOM_HTML_PATH`/`XPRA_BLEEDINGEDGE_HTML_PATH` — as env vars
  sobreviveram à Fase 2 com o prefixo antigo. Nenhuma está no `configmap` do k8s, então hoje só os
  defaults do código rodam; renomeá-las é barato mas mexe em `.env.example` e docs sem ganho até
  alguém precisar sobrescrevê-las.
- **`servers.xpra_client_channel`** — coluna do SurrealDB, na mesma situação. Renomear exige migrar
  as linhas existentes; foi por isso que ficou fora da Fase 2.
