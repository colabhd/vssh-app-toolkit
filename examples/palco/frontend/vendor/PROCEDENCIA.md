# De onde veio o que está nesta pasta

Bibliotecas de terceiro **vendorizadas no pacote do app**. A regra vem de longe e já custou código:
o `player.html` do shell foi deletado por carregar `video.js` de uma CDN. Um app do ambiente não
pode depender de um host que não é nosso — nem para funcionar, nem para ser auditado.

Esta pasta **não é injetada** por `criar_spa_estatica`. O `dash.js` tem 714 KB e só serve ao
YouTube: injetá-lo faria quem abre um `.mkv` da própria pasta pagar por ele. Ele é carregado sob
demanda, quando um vídeo do YouTube começa.

⚠ Os arquivos aqui estão marcados como `binary` no `.gitattributes` da raiz. Eles são texto, e é
justamente por isso: o `* text=auto` os converteria para CRLF no Windows, e a conversão destrói a
única propriedade que torna um arquivo vendorizado conferível — ser byte a byte o que o upstream
publicou. Sem ela, o `sha256` abaixo passa a mentir na primeira vez que alguém faz checkout.

## dash.js

| | |
|---|---|
| pacote | `dashjs` |
| versão | **5.2.1** |
| arquivo | `dist/modern/umd/dash.mediaplayer.min.js` |
| sha256 | `d4ee2d6fd00a3944f448964787d4603ca1e4ae5ce2956d0a755b78e0d3566b57` |
| tamanho | 731 494 bytes (208 KB gzipado) |
| licença | BSD-3-Clause — `dash.js-LICENSE.md` e `dash.mediaplayer.min.js.LICENSE.txt` |

**Por que `mediaplayer` e não `all`:** o pacote completo traz proteção (DRM/EME), Microsoft Smooth
Streaming e o módulo offline. Nada do que pegamos do YouTube é protegido, e os outros dois não têm
consumidor aqui — são 68 KB de código que só existiria para nunca rodar.

**Por que `modern` e não `legacy`:** o `legacy` carrega polyfills para navegadores que este ambiente
não atende (ele roda dentro do próprio shell, num Chrome atual) e é 32% maior.

### Conferir

```bash
npm pack dashjs@5.2.1
tar -xzf dashjs-5.2.1.tgz
sha256sum package/dist/modern/umd/dash.mediaplayer.min.js
```

### Atualizar

Refazer os passos acima com a versão nova, copiar o `.min.js` **e** os dois arquivos de licença, e
atualizar a tabela. Depois rodar `node --test tests/palco-dash.test.js` — ela toca um MPD gerado
pelo backend num Chrome de verdade, que é o que uma mudança de versão pode quebrar em silêncio.
