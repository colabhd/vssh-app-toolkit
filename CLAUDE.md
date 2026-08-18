# CLAUDE.md

Instruções para quem trabalha neste repositório. O que está aqui **vincula**; descrição de
arquitetura mora em [`docs/`](docs/).

## O que este repositório é

Ferramentas públicas para construir e publicar **vssh-apps** — pacotes self-contained (frontend
HTML + backend próprio, em qualquer linguagem) que rodam como processo no servidor Linux do usuário
e aparecem como janela dentro do desktop VSSH renderizado no navegador.

Ele publica **cinco coisas**, e é só isso que o resto do ecossistema consome:

| | |
|---|---|
| [`schema/vssh-app.schema.json`](schema/vssh-app.schema.json) | O contrato do manifesto. Fonte da verdade. |
| [`scripts/vssh-app-publish`](scripts/vssh-app-publish) | O portão de entrada no repositório de artefatos. |
| [`.github/workflows/_publish-app-reusable.yml`](.github/workflows/_publish-app-reusable.yml) | O reusable que o CI de um repo de app chama. |
| [`lib/`](lib/) | As bibliotecas: `lib/node/`, `lib/python/` e `lib/web/`. |
| [`.claude/skills/vssh-app/SKILL.md`](.claude/skills/vssh-app/SKILL.md) | A referência de autoria de um vssh-app. |

**Este repositório é público de propósito.** É o que faz o reusable ser chamável de qualquer repo
de app com o `github.token` padrão — sem PAT. Nada que exija credencial entra aqui.

O portal (`vssh-sso`), o shell de desktop e os motores moram em **outros repositórios**. Trabalho
deles não se planeja aqui.

## Onde cada coisa mora

| | |
|---|---|
| `lib/node/` · `lib/python/` | Backend do app. **As duas árvores têm as mesmas nove peças** — endereço, log, SPA, SSE, filesystem, bandeja, notificação, atividade, libs de navegador. |
| `lib/web/` | Carregado pelo NAVEGADOR: o shim (`vssh.*`), o polyfill de FSA, os shims de Electron/Tauri e a biblioteca de UI (`tuff/`). Viaja nos dois pacotes. |
| `templates/hello-vssh-app{,-node}/` | O mesmo app em dois runtimes, com `frontend/galeria.js` byte a byte idêntico. |
| `examples/` | Apps de referência completos (`palco`, `print-engine`). |
| `tests/` | O que não é de uma lib só. Testes de uma lib ficam ao lado dela. |
| `docs/api.md` | O que um app pode pedir ao ambiente. |
| `docs/porting.md` | Portar um app existente. |
| `docs/ui.md` | A biblioteca de UI. |
| `docs/testes.md` | Como se escreve teste aqui. **Leia antes de escrever um.** |
| `docs/decisoes/` | Razões longas, que atravessam componentes. Não é leitura de rotina. |

## Comandos

```bash
npm test                      # libs JS + tests/  (Node >= 22 pelo glob do runner)
npm run test:py               # libs Python, o template Python e os exemplos Python
VSSH_TEST_CHROME=/caminho/chrome npm test    # inclui os testes de navegador
```

Sem Chrome, os testes de navegador se **pulam**. Sem `python3`, os de publish se **pulam**. Isso é
desenho: falha por ausência de ambiente é ruído, e nem todo mundo que mexe em JavaScript tem os
dois.

## Invariantes

Cada um destes tem um modo de falha **silencioso** — é por isso que estão aqui e não nos docs.

### Versão

O número vive em **três** lugares: `package.json`, `pyproject.toml` e o literal `LIB_VERSION` do
shim (que roda no navegador e não tem `package.json` de onde ler). Bumpe os três juntos;
`tests/lib-version.test.js` reprova a divergência. Uma lib com dois números de versão é uma lib
cuja versão ninguém sabe dizer.

**A major só sobe com breaking change real das libs**, porque é isso que o portão de publicação
mede: divergência de major recusa a publicação de um app, menor e patch só avisam.

### Empacotamento

- **Entrada nova na raiz de `lib/web/` tem de entrar no `force-include` do `pyproject.toml`**, ou
  ela não viaja no wheel. O sintoma no servidor é *"o app Python é feio"* ou um `vssh` incompleto —
  nada que aponte para um arquivo de empacotamento. `tests/lib-version.test.js` reprova até ser
  mapeada.
- **`force-include` do hatchling IGNORA `exclude`**, nos dois níveis. Não tente resolver por
  exclusão: é por isso que a raiz de `lib/web/` é listada entrada a entrada em vez de mapeada
  inteira.
- **Nenhuma lib tem dependência externa.** Elas rodam no servidor do usuário, e cada dependência é
  mais uma coisa que pode faltar lá na hora do install. Vale para as libs **e** para a bancada: não
  há dependência npm neste repositório.

### O schema é copiado por outro repositório

O `vssh-sso` mantém uma cópia vendorizada de `schema/vssh-app.schema.json`, e é contra ela que o
teste de lá confere que todo campo lido pelo portal está declarado. **Campo novo que já tenha
consumidor de lá precisa da cópia atualizada junto** — senão o teste de lá fica vermelho dizendo o
nome do campo.

### `tests/browser/chrome.js` é vendorizado byte a byte pelo `vssh-sso`

Mexer nele aqui **obriga** a copiar lá. Diga isso no PR. As duas cópias divergirem é o modo de
falha: a que ficar para trás mede um instrumento que não existe mais.

### Um diretório de teste novo precisa ser acrescentado ao `test:py`

`python3 -m unittest discover` **não desce sozinho** por `examples/*/test`. O script `test:py` do
`package.json` lista os diretórios um a um, e um app cujos testes ninguém roda é pior que um app
sem testes.

### As duas árvores de lib andam juntas

Uma armadilha do socket unix não deixa de existir porque o backend é Python. Peça nova em
`lib/node/` sem par em `lib/python/` entrega um SDK que é de um runtime só — e a paridade dos
templates é medida (`tests/galeria-paridade.test.js`), mas a das libs depende de quem escreve.

**Todo JSON que vai para o wire usa separadores compactos** (`separators=(",", ":")` no Python) nos
dois runtimes. Sem isso o mesmo app produz bytes diferentes conforme o runtime, e um `grep` de
smoke que passa num falha no outro.

### O CI garante o alvo; quem desenvolve garante a máquina

A matriz é só Linux, **por custo e de propósito** — o alvo de um vssh-app é sempre um servidor
Linux. Isso não isenta o Windows: a suíte tem de passar lá, e quem verifica é quem desenvolve
rodando `npm test`. Já pegou um bug real de canonicalização de caminho que também morderia num
deploy Linux com symlink.

Antes de "restaurar" `windows-latest` no `ci.yml`: a decisão é de custo, e é deliberada.

## Testes

**Um teste mede COMPORTAMENTO, executando.** A regra inteira, com os exemplos e a tabela, está em
[`docs/testes.md`](docs/testes.md) — leia antes de escrever um teste. O que vincula:

- **Não se escreve teste que lê o fonte como TEXTO e afirma sobre ele.** `assert.match(fonte, /…/)`
  e `css.includes('.minha-classe')` provam que uma linha existe, não que o comportamento acontece.
- **Não escrever teste é um resultado permitido.** Se você não consegue medir o comportamento,
  entregue sem teste e **diga no PR o que ficou sem cobertura e por quê**. Dívida declarada vale
  mais que cobertura simulada.
- **A exceção é uma lista fechada de arquivos**, em `docs/testes.md`. Ela não é um critério que cada
  um se aplica. Acrescentar um arquivo a ela é decisão de quem mantém o repositório, **em PR
  separado** da mudança que a motivou.

## Onde escrever o PORQUÊ

- **Invariante operacional** — uma armadilha, um modo de falha silencioso, uma regra que alguém
  quebraria sem perceber: **aqui**, neste arquivo.
- **Razão curta** (uma ou duas frases) — **junto da regra**: no comentário do campo do schema, no
  cabeçalho do arquivo, no `//campo` do `package.json`. É onde ela é lida.
- **Razão longa**, que atravessa componentes, ou que responde um *"por que não X?"* que volta
  sempre: uma página em [`docs/decisoes/`](docs/decisoes/), **uma por assunto** e sempre no
  presente. Quando a decisão muda, a página é **reescrita** — nunca anexada.
- **Registro de execução** — o que foi feito, em que ordem, o que se aprendeu no caminho: **fica no
  git**. Não entra em documento nenhum.

Regra sem motivo declarado é a primeira que alguém remove quando ela incomoda. Mas o motivo se
escreve no presente: *"é assim porque X"*, nunca *"mudou porque antes era Y"*.

## Em andamento

Só o que está aberto **neste repositório**, com o que falta:

- **`createAppLog` (`lib/node/app-log.js`) escreve num `createWriteStream`** — assíncrono e
  bufferizado —, e `process.exit()` não drena buffer. Todo vssh-app Node perde a última linha antes
  de sair, que são justamente os instantes que interessam depois. O conserto é abrir o arquivo uma
  vez e usar `fs.writeSync`: um syscall por linha, e o volume aqui é de eventos, não de quadros. O
  lado Python **não tem o defeito** (ele já dá `flush()` por linha), então isto é também uma
  divergência de paridade entre as duas árvores.
