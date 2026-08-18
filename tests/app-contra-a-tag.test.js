'use strict';

// O app usa a biblioteca do REPOSITÓRIO; o servidor instala a da TAG. Elas divergem.
//
// ─── O defeito que este arquivo existe para impedir, e ele já aconteceu ──────
//
// O Palco foi publicado, instalado, e abriu quebrado: transporte empilhado em sete linhas, cinco
// botões vazios, o botão do estado vazio jogado para o rodapé. Tudo passava aqui — 424 testes
// verdes, incluindo um que monta o frontend inteiro num Chrome de verdade.
//
// A causa: `installCommand` instala o toolkit de `refs/tags/v4.tar.gz`, e a tag estava doze
// commits atrás. Os ícones que o player usa, o `.tuff-transporte` de dois andares e a fonte de
// tempo da `TuffMidia` tinham nascido DEPOIS dela. No checkout tudo existe; no servidor, nada.
//
// ⚠ **Nenhuma bancada de navegador pega isto**, e é o que torna a classe de defeito perigosa: elas
// servem `lib/web/` do disco, que é o estado mais novo possível. O que o servidor recebe é outro
// arquivo, e a única forma de medir é ler a biblioteca NA REVISÃO QUE O MANIFESTO FIXA.
//
// Ele fica em `tests/` e não em `examples/palco/test/` porque a regra não é do Palco: vale para
// todo app deste repositório que injete as libs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const RAIZ = path.join(__dirname, '..');

/** O conteúdo de um arquivo numa revisão do git, ou `null` se ela não existe aqui. */
function naRevisao(revisao, arquivo) {
  try {
    return execFileSync('git', ['show', `${revisao}:${arquivo}`],
      { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** A ref do toolkit que o `installCommand` de um app fixa — ou `null` se ele não instala o toolkit. */
function refFixada(manifesto) {
  const cmd = String(manifesto.backend?.installCommand || '');
  const m = /vssh-app-toolkit\/archive\/refs\/(?:tags|heads)\/([\w.-]+)\.tar\.gz/.exec(cmd);
  return m ? m[1] : null;
}

/** Os apps de `examples/` que têm manifesto. */
function apps() {
  const base = path.join(RAIZ, 'examples');
  return fs.readdirSync(base)
    .map((dir) => ({ dir, mf: path.join(base, dir, 'vssh-app.json') }))
    .filter((a) => fs.existsSync(a.mf))
    .map((a) => ({ ...a, manifesto: JSON.parse(fs.readFileSync(a.mf, 'utf8')) }));
}

/** Tudo que o frontend de um app pede da biblioteca. */
function oQueOAppUsa(dir) {
  const frontend = path.join(RAIZ, 'examples', dir, 'frontend');
  if (!fs.existsSync(frontend)) return null;
  const fontes = fs.readdirSync(frontend)
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => fs.readFileSync(path.join(frontend, f), 'utf8'))
    .join('\n');

  return {
    // `<use href="#ico-play">` — um símbolo que não existe não lança: ele simplesmente não
    // desenha, e o botão fica VAZIO. Foi o sintoma mais visível do defeito que motivou o arquivo.
    icones: [...new Set([...fontes.matchAll(/#ico-([a-z0-9-]+)/g)].map((m) => m[1]))].sort(),
    // Classe sem regra também não reclama: o elemento existe, sem o layout que ele supõe.
    classes: [...new Set(
      [...fontes.matchAll(/class="([^"]+)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((c) => c.startsWith('tuff-')),
    )].sort(),
    // `data-tuff-…` é como a `TuffMidia` acha as peças. Um atributo que a versão instalada não
    // lê deixa o controle inerte — nenhum erro, nenhum efeito.
    ganchos: [...new Set([...fontes.matchAll(/data-tuff-([a-z-]+)/g)].map((m) => m[1]))].sort(),
    // ⚠ **A quarta ponta, e a que mais engana de todas.** Um método do shim que a versão
    // instalada não tem é `undefined`, e a chamada idiomática é
    // `vssh.media?.agora?.({…})` — que com `?.` não lança, não avisa e não faz NADA. O `?.`
    // existe justamente para o app sobreviver a um shell antigo, e o preço é que a ausência
    // fica invisível: a linha executa, o efeito não acontece, e o console fica limpo.
    //
    // Os `?` saem antes de casar para que `vssh.media?.agora?.(` e `vssh.media.agora(` deem o
    // mesmo caminho — senão a forma que o app de verdade usa seria a única não medida.
    api: [...new Set([...fontes.replace(/\?/g, '')
      .matchAll(/\bvssh((?:\.[A-Za-z_$][\w$]*)+)/g)].map((m) => m[1].slice(1)))].sort(),
  };
}

for (const app of apps()) {
  const ref = refFixada(app.manifesto);
  const usa = oQueOAppUsa(app.dir);
  if (!ref || !usa) continue;

  const existeAqui = naRevisao(ref, 'package.json') !== null;
  const seNaoTem = {
    skip: existeAqui ? false : `a ref \`${ref}\` não existe neste clone (clone raso?)`,
  };

  test(`${app.dir}: os ícones que ele usa existem na ref \`${ref}\``, seNaoTem, () => {
    const sprite = naRevisao(ref, 'lib/web/tuff/tuff-icones.js') || '';
    const faltando = usa.icones.filter((n) => !sprite.includes(`id="ico-${n}"`));
    assert.deepEqual(faltando, [],
      `estes ícones não existem em \`${ref}\`, e um \`<use>\` que não resolve NÃO lança — ele só `
      + 'não desenha. No servidor, estes botões aparecem vazios');
  });

  test(`${app.dir}: as classes que ele usa existem na ref \`${ref}\``, seNaoTem, () => {
    const css = ['tuff.css', 'tuff-base.css', 'tuff-midia.css', 'tuff-tokens.css']
      .map((f) => naRevisao(ref, `lib/web/tuff/${f}`) || '').join('\n');
    const faltando = usa.classes.filter((c) => !css.includes(`.${c}`));
    assert.deepEqual(faltando, [],
      `estas classes não têm regra em \`${ref}\`: no servidor o elemento existe sem o layout que `
      + 'ele supõe, e o sintoma é uma tela torta sem nada no console');
  });

  test(`${app.dir}: os métodos do shim que ele chama existem na ref \`${ref}\``, seNaoTem, () => {
    // ⚠ **Este teste nasceu de o defeito acontecer pela TERCEIRA vez, e da mais silenciosa.** O
    // Palco passou a declarar o que está tocando com `vssh.media.agora({titulo, subtitulo, capa})`
    // para a central de mídia parar de mostrar o UUID de um `blob:` como título. Funcionou no
    // repositório. No servidor, a tag `v4` não tinha o método: o `?.` transformou a chamada num
    // no-op, e o sintoma foi a central mostrando título e subtítulo IGUAIS (os dois caindo no
    // mesmo recuo) e sem capa — indistinguível de "o app instalado é velho".
    //
    // O padrão exige o nome no COMEÇO de uma linha seguido de `(` ou `:` — a forma de um membro
    // de objeto. Um `const agora = …` no meio do arquivo não conta, e contava: a primeira versão
    // desta conferência aprovava a `v4` por causa dessa linha.
    const shim = naRevisao(ref, 'lib/web/vssh-app-shim.js') || '';
    const faltando = usa.api.filter((caminho) => {
      const membro = caminho.split('.').pop();
      return !new RegExp(`^[ \t]*${membro}[ \t]*[(:]`, 'm').test(shim);
    });
    assert.deepEqual(faltando, [],
      `o shim de \`${ref}\` não tem estes métodos. Chamados com \`?.\` — como o idioma do app manda `
      + '— eles NÃO lançam: a linha executa, nada acontece, e o console fica limpo');
  });

  test(`${app.dir}: os ganchos de mídia que ele usa são LIDOS na ref \`${ref}\``, seNaoTem, () => {
    const js = naRevisao(ref, 'lib/web/tuff/tuff-midia.js') || '';
    const faltando = usa.ganchos.filter((g) => !js.includes(g));
    assert.deepEqual(faltando, [],
      `a \`TuffMidia\` de \`${ref}\` não procura estes atributos — o controle fica inerte, sem `
      + 'erro e sem efeito');
  });
}

test('todo app com frontend declara de onde vem a biblioteca', () => {
  // A rede que impede o arquivo de virar decoração: um app novo que instale o toolkit por outro
  // caminho (um `pip install vssh-app-toolkit` do PyPI, um caminho local) sai destas conferências
  // em silêncio, e volta a poder publicar contra uma biblioteca que ninguém mediu.
  const semRef = apps()
    .filter((a) => oQueOAppUsa(a.dir) && !refFixada(a.manifesto))
    .map((a) => a.dir);
  assert.deepEqual(semRef, [],
    'estes apps têm frontend e não fixam uma ref do toolkit no `installCommand` — não há como '
    + 'saber contra qual biblioteca eles vão rodar no servidor');
});
