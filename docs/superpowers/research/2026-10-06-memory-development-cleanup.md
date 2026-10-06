# Memória, limpeza dos testes e recuperação do acesso

Entrega de 6 de outubro de 2026. Implementação da memória em `ca1324ff`;
entrada manual da chave após falha da sessão em `93d6da6f`.

## Causa da revisão de memória travada

Uma revisão tinha selecionado a tarefa de desenvolvimento “Teste Google
Workspace: Gmail e Agenda somente leitura”. A tarefa foi removida às
14:33:47.607 UTC; dez segundos depois, a revisão tentou `learn_procedure`
com essa fonte. O recibo rejeitou a escrita com `Task not found`. A revisão
continuou tentando concluir uma escrita que já não podia ocorrer e, depois,
a resposta do provedor foi interrompida. Essa revisão falha bloqueava o
agendamento seguinte. Não foi esgotamento do orçamento: foram 17 de 24 passos
e aproximadamente 45 segundos de cinco minutos disponíveis.

A validade da fonte agora é conferida antes da inferência e nos pontos seguros
da execução. Fontes removidas ou excluídas do aprendizado são aposentadas; uma
escrita pendente só é descartada quando sua fonte deixou de existir. Correções
válidas com erro continuam recuperáveis. Revisões que perderam todas as fontes
são encerradas sem chamar o modelo e sem registrar aprendizado inexistente.
Interrupções transitórias do provedor preservam checkpoints e recibos e recebem
nova tentativa automática, com espera crescente de um a trinta minutos.
Revisões canceladas não são reativadas.

## Limpeza e dados preservados

Um plano com IDs previamente revisados delimitou a limpeza. Foram ocultados
594 registros: 51 ações, 104 atividades, nove artefatos, três entradas de
conversa, 68 arquivos, quatro referências de rascunhos, 131 notificações, uma
sugestão proativa, 222 tarefas e uma conversa de testes. A conversa de rotina
usada em testes anteriores ainda aparecia pela seleção salva do navegador;
ela foi excluída pela interface normal, após a confirmação do próprio app.

As APIs de apresentação filtram `historyHiddenAt`; os acessos canônicos continuam
disponíveis para reconciliação e prevenção de efeitos duplicados. Fontes de
testes não entram no aprendizado. Arquivos ocultados permanecem recuperáveis;
essa operação não excluiu documentos, eventos ou e-mails no Google.

O recibo da transação verificou 4.761 registros protegidos sem alterações,
32 mensagens reais de Beatriz e 40 arquivos dos companions. Perfil, avatar,
preferências, personalidade e credenciais foram preservados. A conversa real
“Oi, tentando” e sua tarefa “Organizar e limpar Gmail” continuam disponíveis.
A tarefa antiga conserva o erro histórico, sem reescrever a conversa da usuária.
As contas `bcferrari23@gmail.com` e `msant262@gmail.com` permanecem simultaneamente
conectadas. Os recibos canônicos de operações, inclusive 28 operações históricas
ainda incertas, não foram apagados nem declarados concluídos.

## Recuperação da sessão e botão de entrada

A primeira publicação encontrou arquivos do banco criados com proprietário root,
incompatíveis com o usuário 1000 da API. A recuperação restaurou uma cópia
consistente do banco e repetiu a limpeza com o usuário correto e uma verificação
de reabertura antes de iniciar o servidor.

Durante essa janela, uma sessão web avançou da revisão 381 para 382. A cópia
restaurada continha 381, tornando inválido o cookie já entregue ao navegador da
usuária. A autoridade 382 foi recuperada do banco preservado, conferindo o mesmo
dispositivo, proprietário, criação, chave de assinatura e recibo legítimo do
sucessor. Nenhum dispositivo revogado foi reativado; todos os demais registros
permaneceram idênticos. Não houve mudança das regras de autenticação.

A tela de falha do acesso salvo agora oferece “Inserir chave de acesso”, abre
um campo protegido e permite voltar à tentativa com a sessão salva. Chave vazia
não pode ser enviada nesse fluxo. Uma chave incorreta mantém o campo disponível
para correção. A chave digitada é limpa após pareamento bem-sucedido. O erro de
sessão inválida explica em português como reconectar. A API não foi reiniciada
para publicar essa alteração da interface.

## Validação

- Regressões da fonte removida falharam antes da correção e passaram depois.
  O conjunto principal passou 65 testes; as conferências adicionais de histórico,
  threads, proatividade e manutenção também passaram. Tipos do servidor e app,
  compilação do servidor e exportação web passaram; lint sem novos erros.
- Um aceite isolado usou `chatgpt/gpt-6-luna`, conectado e sem fallback, e passou
  nove verificações: captura espontânea de preferência/hábito/plano, exclusão de
  ficção e fatos pontuais, recuperação em outra conversa, acompanhamento proativo,
  cancelamento de plano, seleção de notificação relevante, respeito a fontes
  esquecidas, aprendizado e reutilização de procedimento e revisão sem fatos
  indevidos. A fronteira de e-mail usou uma fixture. Nenhum fato sintético foi
  inserido nas memórias reais de Beatriz.
- Os 25 testes de sessão passaram. A interface exportada foi exercitada na prévia
  T3 com endpoints de autenticação isolados: mensagem de sessão inválida, abertura
  do campo protegido, bloqueio da chave vazia, envio da chave digitada, correção
  após chave incorreta e retorno à tentativa do acesso salvo. As primitivas de
  Web Locks/UUID foram simuladas apenas na origem HTTP local desse teste.
- A aplicação pública foi aberta no endereço raiz. O bundle novo foi conferido;
  a conversa de testes desapareceu e a conversa real permaneceu. A tela de memória
  apresentou aprendizado ativado, revisão atualizada e nenhum erro pendente.
  Ambas as contas Google e suas permissões foram conferidas na interface.

Zero memórias pessoais salvas não foi mascarado com fatos inventados. As fontes
reais preservadas contêm principalmente conversa breve, nome do companion e pedido
de Gmail, sem um fato pessoal duradouro inequívoco. Memórias esquecidas continuam
esquecidas; três procedimentos existentes foram preservados.

## Distribuição e limites

API: fonte `ca1324ff548024e32312cf822e49715d3672372f`, imagem
`sha256:e473590b8d2b642615e76dac8f56a99a08e233a7d80b71a2941c5e9674b2526a`.
Web e Android incluem somente a alteração adicional de interface, fonte
`93d6da6f0845e02391c0dbd14d2d6b9372e1cc1e`. Release web:
`/opt/okami-web/releases/session-key-entry-20261006-93d6da6f`.
HTML público SHA-256:
`bfcd1e92b9096f6fdfd7dbd3c8d98f9832ed49c377bde3bb2d5610b9f6ae4693`.

APK ARM64 assinado, com Firebase configurado, SHA-256:
`26e109e8eb842ebbe1ce129c35d7d827df6847bf260e42dadff69f344e07ed30`.
Assinante preservado:
`e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
Download versionado: `/downloads/okamibot.apk?v=93d6da6f`. HTML, bundle e download
públicos foram conferidos por hash. O primeiro build local falhou pela quota do
diretório temporário do Java; a repetição com temporários em `/var/tmp` passou.

O harness OpenClaw permaneceu na revisão
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`; ambiente e pausa global foram
preservados. A prévia usa o mesmo endereço público e build do site. A reparação
da autoridade foi comprovada no servidor; a sessão do navegador particular da
usuária não foi acessada para afirmar que ela já conseguiu entrar.

Logs, backups privados e recibos ficam em `artifacts/memory-cleanup-20261006/`,
`artifacts/session-key-entry-20261006/` e nos diretórios equivalentes do operador
no VPS. Não incluem novos testes reais de ações Google neste escopo. Não se
afirma aceite em aparelho Android físico.
