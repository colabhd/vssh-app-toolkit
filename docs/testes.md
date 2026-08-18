# Como se escreve teste aqui

**Um teste mede COMPORTAMENTO, executando.** O resto desta página é o que isso exclui, por que a
alternativa é tentadora, e o que fazer quando não dá.

## A proibição

Não se escreve teste que lê o fonte como TEXTO e afirma sobre ele.

```js
assert.match(fonte, /requestAnimationFrame/);            // ❌
assert.match(corpo, /if \(t\.janelaRaf\) return;/);      // ❌
assert.ok(css.includes('.minha-classe'));                // ❌
assert.doesNotMatch(src, /VSSH_APP_PORT/);               // ❌
assert.match(doc, /Onda 4/);                             // ❌
```

Eles provam que **uma linha existe**, não que o comportamento acontece — e erram nos dois sentidos:

- **verdes** quando o código muda de casa levando o defeito junto, ou quando o defeito volta escrito
  de outro jeito (`os.getenv` no lugar de `environ[…]`, um import com apelido);
- **vermelhas** numa refatoração que não quebrou nada, o que treina quem lê a afrouxar a asserção em
  vez de investigar.

## Por que elas continuam nascendo

Não é desatenção, é mecânica: **depois de escrever um código, uma regex que casa a linha
recém-escrita SEMPRE PASSA.** É o verde mais barato que existe. Ele parece verificação e é
proof-of-work — o registro de que alguém passou por ali.

A proibição sozinha não segura isso. Ela já esteve escrita neste ecossistema e as guardas
continuaram chegando, por duas falhas de desenho que esta página existe para não repetir:

1. **uma válvula de escape auto-aplicável** — *"a exceção é quando não há execução possível"*. Quem
   não consegue executar sempre acha que é o seu caso;
2. **nenhuma saída alternativa** — não estava escrito que entregar sem teste era permitido, então
   quem não conseguia medir escrevia a regex, porque a opção aparente era não entregar nada.

## Não escrever teste é um resultado permitido

Com todas as letras: **se você não consegue medir o comportamento, entregue sem teste.** Não invente
um substituto de texto para o que não deu para executar, e não invente um teste novo para ocupar o
lugar de um que você apagou.

O que a entrega precisa ter, nesse caso, é uma frase no PR dizendo **o que ficou sem cobertura e por
quê**. Dívida declarada vale mais que cobertura simulada: a primeira alguém pode pagar, a segunda
esconde a pergunta.

## Junção × guarda

O critério é objetivo, e não depende de julgar intenção:

| | JUNÇÃO ✅ | GUARDA ❌ |
|---|---|---|
| **O que faz** | ENUMERA um conjunto de um lado e exige que CADA item exista do outro | CITA uma linha específica que alguém escreveu |
| **Conhece alguma linha?** | Nenhuma. A agulha é derivada do que foi enumerado | Sim, a agulha está escrita no teste |
| **Fica vermelha quando** | um elo real quebra | alguém reescreve a linha preservando o comportamento |
| **Sobrevive a** | reescrita dos dois lados, renomeação consistente | nada |
| **Exemplo** | os ícones que o app cita ↔ os símbolos que a lib declara | `assert.match(src, /const ICO_RAIZ =/)` |

**Exigir o VALOR, e não a presença.** A forma boa da segunda coluna quase sempre existe: em vez de
procurar `const ICO_RAIZ =` no fonte, carregue o módulo e leia `Modulo.ICO_RAIZ`. A versão por texto
passava com três nomes apontando para o mesmo SVG.

**Um IIFE de navegador carrega com `new Function(src + ';return X;')`**, passando dublês inertes
(`window`, `document`, `localStorage` vazios) como parâmetros. `lib/web/test/_superficie.js` e
`lib/web/test/_ambiente-falso.js` já fazem isso, e é de lá que se copia.

**Ler o fonte para EXECUTÁ-LO não é guarda.** `tests/publish-validacao.test.js` e
`tests/publish-libs-gate.test.js` recortam um bloco do `vssh-app-publish` pelos delimitadores e o
rodam de verdade; o que as asserções olham é a saída. Isso é execução, com um passo de extração na
frente.

## Quando o texto é a única resposta: a lista é fechada

Existe um caso legítimo — a junção entre dois arquivos que precisam concordar sobre um nome e
**nunca se encontram em runtime**: um CSS e a marcação que o usa, um `pyproject.toml` e o diretório
que ele empacota, um `.md` e o arquivo que ele linka.

**A exceção é uma LISTA FECHADA DE ARQUIVOS, e não um critério que cada um se aplica a si.** Ela
mora em `tests/testes-medem-comportamento.test.js`, em UM lugar só — cada entrada nomeia a junção
que aquele arquivo mede, e uma segunda cópia dela aqui divergiria da primeira no primeiro dia.

**Acrescentar um arquivo a esta lista é decisão de quem mantém o repositório, em PR separado da
mudança que a motivou.** Se ela vier junto, o revisor está sendo perguntado sobre duas coisas ao
mesmo tempo, e a que ele veio olhar é a outra.

## Varredura com allowlist é regra de LINT

Quatro coisas nesta base têm forma de *"nenhum arquivo faz X, exceto estes, declarados"*: os bytes
de controle nos workflows, as cores escritas à mão no CSS, o `@layer` obrigatório em toda folha, e a
própria lista acima.

Elas **não são testes** — são regras de lint hospedadas na suíte, porque este repositório não tem
ferramenta de lint (e não vai ter: [nenhuma dependência](../CLAUDE.md#invariantes) é regra). O lugar
certo delas seria uma configuração de ESLint. Cada arquivo que hospeda uma diz isso no cabeçalho.

A diferença prática é que uma regra de lint **não prova comportamento**, e não conta como cobertura
de nada.

## Refutação: o teste tem de poder ficar vermelho

Não há ferramenta de mutação aqui. O que existe é o hábito, e ele é barato: **mude a fonte de
propósito e confira que o teste fica vermelho.**

Ele responde uma pergunta só — *"este teste NOVO mede alguma coisa?"* — e nada mais. Não é portão de
CI, não se roda para revisar diff, e não se roda para mudar CSS.

Duas regras que saíram de refutações que falharam:

- **Escreva primeiro o ataque que apaga a razão de a mudança existir.** Se ele não fica vermelho, os
  outros não valem nada. Uma virtualização de lista entrou com treze casos verdes sobre a função que
  calcula a janela; trocar o consumidor para ignorar a janela inteira não produziu vermelho nenhum,
  porque nenhum caso media quem usava a conta.
- **Toda extração precisa de um PISO.** Uma regex que para de casar devolve vazio, e vazio passa em
  qualquer `deepEqual([], [])` — verde, silencioso, medindo nada. Um `assert.ok(achados.length >= N)`
  antes da comparação é o que separa "não há defeito" de "não há leitura".
