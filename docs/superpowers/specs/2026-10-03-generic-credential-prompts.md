# Credenciais solicitadas pelo agente, sem cadastro de novos serviços em código

O usuário rejeitou o fluxo restrito ao Tavily. O requisito é que qualquer
credencial necessária seja coletada pelo próprio aplicativo, em modal seguro,
sem uma mudança de configuração/implementação para cada serviço novo.

## Causa confirmada

`connect_integration` aceitava somente Tavily. O formulário de navegador usava
uma enumeração dos adapters existentes no startup. Não havia um host global de
modais, apenas cartões inline. `InteractionRequests.forTask` criava uma pergunta
normal mesmo quando a tarefa já estava aguardando credenciais. Assim, o app
simultaneamente deixava de atender serviços novos e duplicava perguntas.

## Fluxo implementado nesta correção

1. Ferramentas genéricas descrevem serviço, origem HTTPS, finalidade, campos e
   aplicação da autenticação. Somente metadados, nunca valores secretos, entram
   nos argumentos do modelo.
2. Um pedido em conversa cria uma tarefa durável aguardando a credencial; um
   pedido durante uma execução pausa a tarefa atual. O usuário pode continuar
   conversando enquanto ela aguarda.
3. Um host global apresenta um único modal, inclusive no desktop e no Android.
   Atualizações de polling não reabrem o modal dispensado nem apagam o que está
   sendo digitado. O cartão da conversa permite reabrir. Fechar só dispensa;
   cancelar encerra o trabalho dependente.
4. Submit escreve no mesmo cofre OpenBao, confirma a versão e retoma a tarefa
   correspondente uma única vez. A conversa recebe apenas status e referência.
5. Uma ferramenta HTTP autenticada resolve a referência dentro do runtime, fixa
   o destino à origem autorizada, valida DNS/rede e não segue redirects. Suporta
   autenticação por bearer, header, basic, query, corpo JSON e múltiplos campos, sem tabelas de
   serviços. Operações seguem o journal e a política existente de ações.
6. Login em sites também pode declarar o formulário observado em runtime. O
   broker fixa a identidade da definição, proprietário e origem. Seletores de
   senha são intersectados com inputs password reais; o worker conserva as
   checagens de formulário POST, origem e ocultação antes de preencher. Nenhuma
   senha passa por browser_act ou ferramentas de texto.
7. A área de conexões lista os serviços salvos e permite revogar/atualizar. Não
   existe mais uma tela Tavily necessária para solicitar uma chave. Os endpoints
   legados permanecem para compatibilidade de versões e credenciais existentes.

A autorização OAuth (como ChatGPT) mantém seu fluxo oficial. O objetivo do
modal é coletar credenciais que o usuário precisa fornecer, sem tentar substituir
consentimento do provedor, autenticação multifator ou autorização de pagamentos.

## Aceite

- Serviço fictício não cadastrado: pedido → modal → cofre → mesma tarefa → HTTP
  autenticado com resultado, sem adicionar nome de provedor a arquivos do app.
- Dois serviços com campos/autenticação distintos, inclusive múltiplos campos.
- Senha em site não cadastrado: definição dinâmica persiste e fica limitada ao
  proprietário, destino e controles de senha.
- Nenhum valor secreto no histórico, argumentos de tools, journal, eventos,
  erros, exportações ou storage local. Testes com canários nos destinos controlados.
- Save duplicado não duplica retomada; polling, reinício, expiração, cancelamento,
  revisão da tarefa e exclusão do chat não recriam solicitações antigas.
- O formulário de credenciais não gera uma segunda pergunta comum.
- UI verificada em navegador e Android; publicação somente após testes/builds.
