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
// Em `VsshSettings`, junto com as do ambiente, o que quer dizer que elas **viajam com o usuário**
// para outra máquina. A chave precisa existir no `ALLOWED_KEYS` do portal — enquanto não existir,
// o PUT responde 200 e o servidor descarta em silêncio, que é o buraco que a Onda 2.6 fechou para
// as chaves do próprio shell. Para preferência que é SÓ do app e não precisa atravessar máquina, o
// lugar certo é o backend do app, no `VSSH_APP_DATA_DIR`.

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
          // ⚠ Chave de EXEMPLO: ela não está no `ALLOWED_KEYS` do portal, então o valor vive
          // apenas nesta aba e não sobrevive a um recarregamento. É de propósito — o template não
          // deve gravar lixo permanente no perfil de quem só o instalou para olhar. Ao criar a sua
          // de verdade, acrescente-a ao schema do portal, senão ela some sem avisar.
          chave: 'helloWorldNodeGritar',
          controle: { tipo: 'switch' },
          hint: 'Chave de exemplo: não persiste até entrar no schema do portal.',
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
