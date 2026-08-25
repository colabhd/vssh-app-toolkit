'use strict';

// O `Content-Type` do documento, medido onde ele tem efeito: num navegador.
//
// ─── Por que isto não pode ser teste de texto ────────────────────────────────
//
// O teste ao lado (`static-spa.test.js`) confere o CABEÇALHO — que a resposta diz
// `application/xhtml+xml`. Isso é o que o servidor controla, e é tudo o que ele pode afirmar
// sozinho. A pergunta que sobra é de outra natureza:
//
//   **o cabeçalho muda o parser?**
//
// Nenhuma leitura de bytes responde. Os dois documentos aqui são a MESMA marcação, byte a byte; o
// que muda é uma linha de header. Se a resposta fosse "não muda nada", o suporte a XHTML seria
// enfeite, e o substrato que depende dele não teria caminho.
//
// ─── O que está em jogo ─────────────────────────────────────────────────────
//
// ⚠ Em HTML a barra de uma tag auto-fechada é IGNORADA. `<spacer/>` fica ABERTA, e todo irmão
// seguinte vira FILHO dela — sem erro de parse, sem aviso no console. O sintoma é layout
// inexplicável a três níveis de distância da causa, e é assim que uma interface portada de XUL
// (onde `<spacer/>`, `<separator/>` e `<image/>` são o idioma normal) chega quebrada sem que nada
// acuse o motivo.
//
// O terceiro teste mede a outra metade: as tags que NÓS injetamos têm de ser bem formadas em XML.
// Um `<link>` sem barra num documento XHTML não degrada — ele mata o documento inteiro com erro
// fatal, e o navegador mostra a página de relato de XML no lugar do app.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { createStaticSpa } = require('../static-spa');
const {
  abrirNavegador, caminhoDoNavegador, motivoDoSkip,
} = require('../../../tests/browser/chrome.js');

// ⚠ A CONDIÇÃO é `caminhoDoNavegador()`; `motivoDoSkip()` é só a MENSAGEM, e ela é sempre uma
// string — portanto sempre verdadeira. Usá-la como condição faria este arquivo inteiro pular em
// silêncio, inclusive num ambiente com Chrome: verde sem ter rodado nada.
const temNavegador = !!caminhoDoNavegador();
const seNaoTem = { skip: temNavegador ? false : motivoDoSkip() };

// A mesma marcação para os dois documentos. É o ponto: o que os separa é uma linha de cabeçalho.
//
// O `xmlns` não é decoração. Sem ele o parser de XML põe os elementos em namespace NENHUM, e aí
// eles não são elementos de HTML — `document.body` some e o CSS não pega. Um documento XHTML sem
// namespace parseia e não funciona, que é o pior dos desfechos.
const MARCACAO = [
  '<html xmlns="http://www.w3.org/1999/xhtml">',
  '<head><title>bancada</title></head>',
  '<body>',
  '<hbox id="caixa"><label id="a">um</label><spacer/><label id="b">dois</label></hbox>',
  '</body>',
  '</html>',
].join('\n');

/** Sobe um static-spa de verdade servindo `indexFile`, e devolve a origem para o navegador. */
async function servirBundle(indexFile, opcoes = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'vssh-xhtml-'));
  await fsp.writeFile(path.join(raiz, indexFile), MARCACAO, 'utf8');
  await fsp.writeFile(path.join(raiz, 'tema.css'), '#a { color: rgb(1, 2, 3) }', 'utf8');
  await fsp.writeFile(path.join(raiz, 'boot.js'), 'window.__injetado = 1;', 'utf8');

  const spa = createStaticSpa({ root: raiz, indexFile, ...opcoes });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (await spa(req, res, url)) return;
    res.writeHead(404);
    res.end('nao');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${srv.address().port}/`,
    // ⚠ `closeAllConnections()` antes do `close()`: o `close` sozinho espera as conexões abertas, e
    // uma resposta servida por `createReadStream().pipe(res)` não é reconhecida como ociosa. Sem
    // isto cada teste que serve arquivo custa três segundos de espera pura.
    fechar: () => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok); }),
  };
}

let nav = null;
before(async () => { if (temNavegador) nav = await abrirNavegador(); });
after(async () => { if (nav) await nav.fechar(); });

test('servido como XHTML, a tag auto-fechada FECHA', seNaoTem, async () => {
  // A pergunta central. Se `<spacer/>` não fechasse nem aqui, não haveria como servir XUL a um
  // navegador — e todo o caminho do substrato precisaria de outra ideia.
  const origem = await servirBundle('index.xhtml');
  try {
    const p = await nav.novaPagina(origem.url);
    const r = JSON.parse(await p.avaliar(`(() => {
      const caixa = document.getElementById("caixa");
      const b = document.getElementById("b");
      return JSON.stringify({
        tipo: document.contentType,
        // Nulo aqui significa que o documento NÃO existe: o parser de XML falhou e o navegador
        // trocou a página pelo relato de erro. É o desfecho que uma tag mal formada produz.
        filhos: caixa ? caixa.children.length : null,
        paiDoB: b ? b.parentElement.id : null,
      });
    })()`));
    assert.equal(r.tipo, 'application/xhtml+xml', 'o cabeçalho tem de escolher o parser de XML');
    assert.equal(r.filhos, 3, 'os três filhos do hbox são IRMÃOS: o <spacer/> fechou');
    assert.equal(r.paiDoB, 'caixa', 'e o irmão seguinte continua filho da caixa');
  } finally {
    await origem.fechar();
  }
});

test('servido como HTML, a MESMA marcação engole o irmão', seNaoTem, async () => {
  // A contraprova, e a razão de a entrada no mapa de tipos existir. Os bytes são os mesmos do teste
  // acima; o que muda é o nome do arquivo, que muda o cabeçalho, que muda o parser.
  //
  // ⚠ E repare no desfecho: a página CARREGA. Nada falha, nada aparece no console — só a árvore
  // está errada. É por isso que este caso está medido, e não descrito.
  const origem = await servirBundle('index.html');
  try {
    const p = await nav.novaPagina(origem.url);
    const r = JSON.parse(await p.avaliar(`(() => {
      const caixa = document.getElementById("caixa");
      return JSON.stringify({
        tipo: document.contentType,
        filhos: caixa.children.length,
        paiDoB: document.getElementById("b").parentElement.tagName,
      });
    })()`));
    assert.equal(r.tipo, 'text/html');
    assert.equal(r.filhos, 2, 'o <spacer/> ficou ABERTO e engoliu o irmão');
    assert.equal(r.paiDoB, 'SPACER', 'o irmão virou filho do espaçador — sem erro nenhum');
  } finally {
    await origem.fechar();
  }
});

test('as tags injetadas não matam um documento XHTML', seNaoTem, async () => {
  // ⚠ Uma tag mal formada aqui não degrada: ela derruba o documento INTEIRO. `<link rel=…>` sem a
  // barra final é erro fatal de XML, e o navegador troca o app pela página de relato.
  //
  // Por isso as três asserções são de coisas diferentes: que o documento existe, que o script
  // injetado EXECUTOU, e que a folha injetada CHEGOU e foi aplicada. Um documento morto reprova a
  // primeira; um `<link>` que o parser recusou reprovaria a terceira.
  const origem = await servirBundle('index.xhtml', {
    injectStyles: ['tema.css'],
    injectScripts: ['boot.js'],
  });
  try {
    const p = await nav.novaPagina(origem.url);
    const r = JSON.parse(await p.avaliar(`(() => {
      const a = document.getElementById("a");
      return JSON.stringify({
        vivo: !!document.getElementById("caixa"),
        script: window.__injetado || null,
        cor: a ? getComputedStyle(a).color : null,
      });
    })()`));
    assert.equal(r.vivo, true, 'o documento morreu: alguma tag injetada não é XML bem formado');
    assert.equal(r.script, 1, 'o <script> injetado não executou');
    assert.equal(r.cor, 'rgb(1, 2, 3)', 'a folha injetada não chegou ou não foi aplicada');
  } finally {
    await origem.fechar();
  }
});
