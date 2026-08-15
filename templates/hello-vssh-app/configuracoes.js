'use strict';

// A seção que este app acrescenta a Configurações do ambiente.
//
// Declarada no manifesto como `contributes.settings`, e carregada pelo shell quando a janela de
// Configurações abre — não no boot. Um app que ninguém configura não custa nada.
//
// ─── O que este arquivo recebe, e o que NÃO recebe ─────────────────────────
//
// Ele roda com quatro coisas no escopo, e só quatro: `SettingsRegistry` (registrar),
// `VsshSettings` (ler e gravar preferência), `AppLauncher` (abrir o próprio app) e `app` — o
// manifesto projetado, com `id`, `name`, `version`… É deliberado: são as quatro coisas de que uma
// seção de app precisa. Alcançar o resto do shell por `window` funciona hoje e é acoplamento a um
// interior que muda sem aviso.
//
// ─── O que ele PODE fazer, e você precisa saber ────────────────────────────
//
// Este script roda **na origem do shell, com a confiança do shell** — o mesmo alcance que o código
// do próprio ambiente. Não há sandbox. O portão é quem pode rodar `vssh-app-install`, e é o mesmo
// portão de todo o modelo de apps. Escreva isto como escreveria código do ambiente.
//
// ─── Onde as preferências ficam ────────────────────────────────────────────
//
// Em `appSettings.<id-do-seu-app>.<chave>`, dentro do `VsshSettings` do ambiente — o que quer
// dizer que elas **viajam com o usuário** para outra máquina.
//
// **Você não precisa registrar nada no portal.** `appSettings` é um mapa aberto, chaveado pelo id
// do app, justamente para que publicar um app não exija um commit no `vssh-sso`. O que o portal
// aperta é o VALOR: primitivo (booleano, número, texto até 512) ou lista curta de primitivos, até
// 32 chaves por app. Objeto aninhado é descartado.
//
// O que não couber aí não é preferência — é dado do app, e o lugar dele é o `VSSH_APP_DATA_DIR`,
// no servidor. Preferência é curta por natureza, e esta viaja em toda leitura de configuração.

SettingsRegistry.register({
  id: `app-${app.id}`,
  familia: 'apps',
  nome: app.name || app.id,
  icone: 'grid',
  resumo: 'Um exemplo de seção trazida por um app',
  desc: 'Esta seção não existe no shell: ela vem do manifesto deste app, e some junto com ele '
      + 'quando o app é desinstalado.',

  // A seção só existe se o app estiver instalado — o que aqui é sempre verdade, já que este
  // script só é carregado a partir do manifesto dele. Um `disponivel()` faz sentido quando a
  // seção depende de outra coisa: um dispositivo, um serviço de pé, uma capacidade do servidor.
  // Sem ele, a seção existe sempre.
  estado: () => ({ texto: `versão ${app.version || '?'}`, pill: null }),

  grupos: [
    {
      cap: 'Exemplo',
      nota: 'Estas duas linhas existem para provar que o mecanismo funciona — apague-as ao começar '
          + 'o seu app.',
      linhas: [
        {
          titulo: 'Mostrar a saudação em maiúsculas',
          desc: 'Um booleano qualquer, para demonstrar um controle que grava.',
          // O caminho pontuado é o contrato: `appSettings.<id>.<chave>`. Ele grava de verdade e
          // sobrevive à troca de máquina, sem nada a registrar no portal — o mapa é aberto e
          // chaveado pelo id do app. Interpolar o `app.id` em vez de escrever o id à mão é o que
          // faz este arquivo continuar certo se alguém copiar o template e trocar o id.
          chave: `appSettings.${app.id}.gritar`,
          controle: { tipo: 'switch' },
          hint: `Grava em appSettings.${app.id}.gritar e acompanha você em outra máquina.`,
          busca: ['hello', 'maiúsculas', 'exemplo'],
        },
        {
          titulo: 'Abrir o app',
          desc: 'Uma ação, para mostrar que a seção pode fazer mais que gravar preferência.',
          controle: {
            tipo: 'botao',
            rotulo: 'Abrir',
            onClick: () => AppLauncher.open(app.id),
          },
          busca: ['abrir', 'hello'],
        },
      ],
    },
  ],
});
