# Publicação de apps

Por que o caminho de publicação é como é. As regras estão em
[`../../README.md`](../../README.md) e no
[`schema/vssh-app.schema.json`](../../schema/vssh-app.schema.json); aqui ficam as razões que não
cabem ao lado delas.

## Por que o publish não usa PAT

Este repositório é público, então o reusable workflow é chamável de qualquer repo de app — de uma
organização ou de uma conta pessoal — e o checkout do script sai no `github.token` padrão do
chamador.

A alternativa era o que existia antes: script e reusable no `vssh-sso` privado, com um PAT
(`contents:read`) guardado como secret em cada repo de app. Isso espalha uma credencial de leitura
por N repositórios, e não resolve o caso que mais dói — o GitHub proíbe `uses:` de reusable
**privado** cross-owner, então um repo de conta pessoal não conseguia chamá-lo de jeito nenhum e
tinha de inlinear os passos à mão.

O único secret que sobra é o `VSSH_REPO_PUBLISH_TOKEN`, que é do Worker do repositório de
artefatos e escopado a um app (`app:<id>`). Ele nunca foi credencial do GitHub.

## Por que as libs vêm do npm, e não de um script de cópia

`npm i github:colabhd/vssh-app-toolkit#v4` instala do repositório público, sem token e sem
`npm publish` — inclusive num alvo sem `git` e sem `ssh`, porque o npm resolve pelo tarball do
codeload.

A alternativa era um script de cópia que sincronizava `lib/` para dentro do repo do app e escrevia
um marcador com a idade da cópia. O argumento a favor dela continua verdadeiro — o publish empacota
o que está versionado, então a cópia teria de ser commitada de qualquer forma. O que derrubou a
alternativa foi o custo dela aparecer inteiro: o script tinha o ref default escrito à mão, a major
seguinte saiu, a linha ficou para trás, e dois apps publicaram libs de uma geração contra um
toolkit de outra. **Um mecanismo de versão feito à mão tem a própria versão para esquecer.**

Com o npm, "que versão é esta?" tem uma resposta só, e ela vem do `package-lock.json`.

**O gatilho que reabre a discussão:** o dia em que este toolkit distribuir algo que não é
biblioteca importada — um CLI que se rodaria com `npx`. Aí o registry deixa de ser burocracia e
vira o transporte natural, e o `NPM_TOKEN` passa a se pagar.

## Por que a referência é uma tag, e nunca `main`

Puxar de um branch faz a validação do CI de quem publica mudar debaixo dele a cada commit deste
repositório — inclusive num push que ele não viu. Isso não é "validar menos": é não ter alvo
estável.

A tag só passou a valer a pena quando ganhou o que significar. Com o portão de versão das libs
conferido no publish, `v4` é um contrato — *estas libs, esta validação* — e não um apelido de
commit.

**`v1` é uma armadilha, e não um alvo antigo qualquer.** Ela é do toolkit original, anterior à
criação de `lib/`, `schema/` e `docs/`: um repo pinado ali não encontra o schema e publica com
validação mínima, avisando numa linha de log. Foi assim que vários repos publicaram por meses
achando que validavam.

## Por que os avisos do publish são anotações do Actions

Em log corrido um aviso é uma linha entre mil. Não é hipótese: é exatamente como o
`aviso: schema não encontrado` da `v1` passou meses despercebido.

`::warning::` sobe para o resumo do run e para a aba de anotações do PR — que é onde se olha. Fora
do Actions, stderr é o lugar certo mesmo.

## Por que o portão de versão das libs recusa só divergência de major

Divergência de **major** recusa a publicação; menor e patch avisam e publicam.

A major deste repositório só é bumpada quando as libs carregam breaking change real, então publicar
contra outra major é publicar contra um contrato que mudou. Menor e patch são compatíveis por
definição — recusar ali só ensinaria a ignorar o portão, que é o defeito que o aviso de schema
faltando já demonstrou.

**Quando o script não sabe a própria versão, a conferência é pulada e dita em voz alta.** O
checkout esparso do CI pode não trazer o `package.json`. Uma conferência que se acha feita sem ter
sido é pior que nenhuma.

## Por que o pacote é o que está versionado

Quando a fonte é um repo git, o publish empacota com `git archive`: `vendor/` e `node_modules`
commitados **entram** no tarball, e cruft ignorado pelo `.gitignore` fica de fora — sem lista de
padrões para manter.

A alternativa era uma lista de exclusão escrita à mão, que envelhece a cada diretório novo e falha
para o lado errado: o que ela esquece de excluir vai junto, e ninguém percebe até o tarball ficar
grande.

## Por que todo objeto do schema recusa campo desconhecido

`additionalProperties: false` em todo objeto, e a raiz foi a última a fechar.

Enquanto um objeto aceita qualquer chave, um erro de digitação publica limpo e o campo é descartado
em silêncio por quem lê: `requiredPackage` sem o `s` instala um app sem verificar pacote nenhum;
`widht: 900` abre a janela no tamanho padrão; `healthcheckPat` faz o poll cair no `/`. O `window` é
o mais barato de errar e o mais caro de perceber, porque o portal repassa o objeto inteiro ao
cliente e a chave a mais viaja o caminho todo para não ser lida por ninguém.

Fechar os objetos que existem hoje não impede o próximo de nascer aberto — por isso a regra é
*todo objeto fecha a porta*, e não uma lista.

**O erro nomeia o vizinho.** *"campo desconhecido: requiredPackage"* está correto e não ajuda: quem
publica olha para o manifesto, vê o campo escrito lá, e conclui que o schema está velho. A distância
é **Damerau** e não Levenshtein por um caso concreto — `widht` por `width` é uma transposição, e a
distância simples a cobra como dois erros, deixando justamente o typo mais provável sem sugestão.
Quando nada está perto, a mensagem fica só com o nome reprovado: sugestão errada é pior que
nenhuma.

## Por que um toolkit mais velho recusa um manifesto mais novo

*"Este toolkit não conhece este campo"* é a informação. A alternativa é publicar um app cujo campo
ninguém vai ler — e o autor descobre isso no servidor, onde não há mensagem de erro.

## Por que `requiredPackages` tem validação própria, além da do schema

O valor deste campo chega a um gerenciador de pacotes rodando no servidor do usuário. Um nome com
metacaractere de shell é injeção, e o portão de publicação é onde isso se recusa — depois já é
tarde, e o portal teria de desconfiar de um manifesto que passou por aqui.

O `|` é o único metacaractere admitido, no idioma do `Depends: a | b` do Debian, e ele nunca
atravessa como shell: quem confere separa as alternativas antes de montar comando nenhum. Declarar
uma alternativa só recusaria a instalação em servidores onde o app rodaria perfeitamente.

## Por que a versão é obrigatória em `provides`

Uma capacidade (`llm/v1`) é contrato entre repositórios que não se conhecem, e um contrato sem
versão só pode ser mudado quebrando alguém em silêncio. Trocar o contrato é publicar `nome/v2` e
conviver com o `v1` enquanto houver consumidor.

**Declarar não é provar.** O ambiente não verifica se o app cumpre a capacidade, pelo mesmo motivo
que o registro de motores não verifica: exigir transforma *"este app não faz isso"* em *"este app
não carrega"*. Quem não puder atender falha por dentro, que é onde sabe dizer por quê.

## Por que `minShellVersion` não é obrigatório

Um campo obrigatório transformaria toda API nova em quebra de compatibilidade declarada, que é a
burocracia sem o benefício. O padrão é não declarar; quem declara está dizendo *"eu uso uma coisa
que não existia antes"* — a mesma regra do `engines` do npm, pelo mesmo motivo.

Ele **não substitui** `vssh.capabilities()`, e construir um achando que o outro ficou resolvido é o
erro natural aqui:

| | quando responde | o que faz com o "não" |
|---|---|---|
| `minShellVersion` | na instalação, contra um número declarado | o portal recusa, nomeando a versão |
| `vssh.capabilities()` | em runtime, no ponto de uso | o app decide: degrada, esconde o botão, avisa |
