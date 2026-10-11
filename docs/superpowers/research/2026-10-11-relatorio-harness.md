# Relatório do harness, publicação e limpeza — 11/10/2026

**Ainda não está entregue.** Há correções publicadas e operações reais verificadas pelo chat. O último teste de pesquisa com PDF falhou: depois de **15min18,484s**, havia **91 respostas de Luna, seis revisões e nenhuma entrega final**. A equivalência integral com Hermes/OpenClaw, a cobertura completa do Google Workspace e a performance sustentada no celular continuam sem aprovação.

Estado conferido às **04:29 UTC de 11/10/2026**: o app publicado responde; API, navegador e OpenBao estão saudáveis; não há tarefas, conversas ou solicitações HTTP ativas. Essa fotografia não comprova disponibilidade sustentada.

## O que já foi publicado e testado no chat

| Área | Resultado observado | O que esse teste aprova |
| --- | --- | --- |
| Google Drive | O pedido normal com “MOVING DE” encontrou a pasta real `MovingDE`. A busca percorreu as três contas conectadas e verificou 508 arquivos e 15 subpastas, em 18 páginas. | Busca por nome aproximado e travessia. A análise completa dos documentos para renovação de vistos permanece pendente. |
| Gmail: rascunho e envio | Um pedido normal criou um rascunho real em `msant262@gmail.com`, com card automático de remetente, destinatário, assunto e conteúdo. O botão Enviar realizou o envio; outra conversa encontrou a mensagem. | Esse fluxo real de rascunho/envio, sem pedir ao agente para mostrar o card. |
| Gmail: organização | Dois e-mails de teste receberam a label `Okami Testes 10-10` e foram arquivados. Uma leitura posterior do Google confirmou `Label_29` e ausência de `INBOX`. | Aplicação de label e arquivamento desses dois e-mails. Não é cobertura integral de limpeza em massa. |
| Docs, Sheets e Slides | Pedidos normais criaram e leram um documento, uma planilha com fórmula e uma apresentação de dois slides, com links reais na conta correta. | Esses casos concretos; outras operações ainda precisam de cobertura. |
| Agenda | O Google e uma busca independente confirmaram um evento para 11/10, 15h–15h30, `Europe/Berlin` (+02:00), com lembrete dez minutos antes. | Horário, fuso e lembrete desse evento. Uma falha de reconexão nesse teste impede tratá-lo como prova de recuperação autônoma. |
| Exclusão com aprovação | A exclusão de um único e-mail de teste apresentou o card e aguardou aprovação. Após o clique autorizado, o Google confirmou `TRASH`, sem `INBOX`; o agente retomou e concluiu. | Esse caso de exclusão autorizada. Nenhum e-mail real da Beatriz foi usado. |
| Imagens | Luna entregou um infográfico em 89,029 segundos; o recibo registra `codex/gpt-image-2`. A imagem real foi inspecionada e abriu no visualizador publicado. | Geração e entrega desse infográfico pelo modelo de imagem conectado. |
| Memória e aprendizado | Foi reproduzido e corrigido um bloqueio da fila de Code Mode: a execução externa aguardava uma ferramenta enfileirada atrás dela. Depois da publicação, a revisão normal de conversa terminou em 10,789 segundos e a revisão de tarefa salvou um procedimento em 15,166 segundos. | Correção dessa causa e funcionamento nesses dois casos. As três memórias pessoais foram preservadas; o procedimento de QA foi arquivado. |
| Histórico e carregamento | Coordenação e admissão deixaram de carregar todo o histórico de tarefas do usuário. A medição real mostrou consulta limitada à conversa e contagem escalar. Uma recarga deixou o compositor disponível em 534 ms. | Essas consultas e essa amostra de recarga. O teste não comprova consumo de GPU/RAM ou desempenho de celular físico. |
| Cards e ações | O card de rascunho aparece automaticamente e fica compacto depois do envio. Atualizar recarrega ações e rascunhos; após a limpeza, a interface mostrou somente as duas ações reais preservadas. | Esses comportamentos. Uma divergência de contador e a revisão ampla da UX permanecem abertas. |
| Documentos | Duas repetições normais entregaram PDFs reais de duas páginas, com texto, pixels, links e visualizador conferidos. | Entrega física autônoma do arquivo. Os tempos de 10min28,483s e 8min42,779s continuam reprovados; nem todos os campos da pesquisa foram confirmados. |

Os resultados e contratos detalhados estão em [harness-parity](2026-10-09-harness-parity.md) e na [matriz de ferramentas](2026-10-09-harness-tool-inventory.json). Um caso aprovado não representa aprovação de todo o produto.

## O que falhou no último teste

O pedido comum foi: “Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.” Foi enviado pelo compositor publicado às **04:05:11,715 UTC**, sem dicas de ferramentas, respostas do operador ou conserto manual.

Às **04:20:30,199 UTC**, a tarefa continuava rodando. Havia vários rascunhos, **91 respostas de `chatgpt/gpt-6-luna` e seis revisões**, mas nenhuma entrega final. Somente essa tarefa de QA foi cancelada pelo controle normal do app. Seu último rascunho foi preservado como diagnóstico, sem ser apresentado como entrega aprovada. A evidência original da falha permanece intacta.

Encontrei outra causa concreta: a configuração de revisão independente estava desativada, mas o harness a ligava automaticamente quando entendia que o pedido exigia opções gratuitas. Isso adicionava outra sequência de chamadas do modelo e rejeições ao fluxo normal. A revisão chegou a aceitar uma política de gratuidade de um programa IBM como prova para outro, e revisões posteriores recusaram essa aplicação. Não reutilizamos a aprovação anterior como se ela confirmasse o curso escolhido.

A correção **`f2e239ae` está commitada na main, ainda sem publicação no app**. Agora o harness respeita a configuração: revisão independente desativada não faz essa chamada extra; ativada mantém a verificação sobre o texto real do documento e as fontes observadas. Os controles de arquivo real, formato, revisão visual, efeito, aprovação e recibos continuam obrigatórios. Não houve aumento de modelo, troca para modelo de fronteira ou redução arbitrária de limites.

Isso corrige o desrespeito à configuração. **Ainda não comprova melhora de tempo ou qualidade no chat publicado.** É necessário publicar e repetir o mesmo pedido normal, conferindo os fatos e o arquivo de forma independente.

## Testes e versão

- **Produção atual:** `e2610f4c023b0f79bd3c22d86a46d756e7ee80be`. Inclui as correções de referências de arquivos/fontes e a geração direta de rascunhos locais. A última publicação levou 21,2 segundos, com parada limpa e preservação de banco, ambiente e navegador.
- **Correção nova:** `f2e239ae`, commitada na main; publicação no app e repetição real pendentes.
- **Validação atual:** 114 casos distintos passaram: 61 de pesquisa/revisão, 43 de documentos/entrega/efeitos e dez do núcleo local de kanban. TypeScript e o build final do servidor/harness passaram. O lint terminou sem erros, com avisos preexistentes.
- A primeira execução de um grupo teve 11/12: uma fixture ainda dependia da revisão forçada. Ela passou a habilitar explicitamente a revisão que testa; as asserções de rejeição do arquivo incorreto permaneceram. O grupo inteiro foi repetido e passou 12/12. A invocação que falhou foi preservada.
- Os dez casos de kanban incluem descoberta limitada em SQL, dependências, comentários incrementais e recuperação de resultados anteriores. Parte desse núcleo está publicada; a extensão de contexto está local e ainda sem integração às ferramentas, ao dispatcher ou à interface. **Isso não implementa as quinze ferramentas de kanban do Hermes.**
- A suíte completa de 1.954 testes aprovada anteriormente pertence à versão `dff49510`; não é apresentada como uma nova execução completa da versão atual.

## Limpeza realizada e dados preservados

A última rodada retirou da apresentação **12 registros exclusivamente de QA**: nove arquivos, uma tarefa, uma conversa e uma entrada de mensagem. **1.739 registros fora da seleção permaneceram idênticos**. Não houve novo procedimento de QA a arquivar; as 31 versões existentes foram preservadas. Depois da recarga, o compositor estava disponível e o arquivo de QA não aparecia.

Foram preservados **companions, 58 arquivos reais/companions, duas conversas reais, três tarefas reais, duas ações, cinco atividades, três memórias e as três contas Google conectadas simultaneamente**. Recibos canônicos, credenciais, perfis, volumes e backups foram preservados.

Rodadas anteriores já retiraram as conversas, ações, revisões e documentos identificados como testes; removeram **12 APKs locais obsoletos**, liberando 811.757.568 bytes alocados, e releases/uploads duplicados na VPS. As versões atuais e de recuperação foram mantidas. A última inspeção não encontrou outro APK fora das versões protegidas para remover.

Também foram retiradas imagens Docker e árvores de build obsoletas com conferência dos hashes. Duas rodadas recentes registraram aproximadamente **1,62 GB** e **436,46 MB** liberados na VPS; o segundo arquivo local obsoleto liberou 53.108.736 bytes alocados. Esses valores são de rodadas distintas, não uma medição única do ganho líquido. A VPS tinha **37.718.372.352 bytes livres** na verificação das 04:29 UTC. A revisão de outros builds já superados continua pendente.

## O que ainda falta

1. Publicar a correção da configuração e repetir o pedido normal de pesquisa/PDF com Luna, comprovando fatos, entrega e tempo.
2. Completar os contratos ainda ausentes do Hermes/OpenClaw, incluindo integração das quinze ferramentas de kanban e execução de navegador. A equivalência integral permanece **reprovada**.
3. Ampliar a cobertura real do Google Workspace, incluindo operações de alteração/exclusão e seus cards; os casos aprovados acima não cobrem todas as ações possíveis.
4. Resolver a divergência de contador de Ações e verificar a UX completa em desktop e celular.
5. Medir performance sustentada em dispositivo real e sob uso repetido. A amostra de recarga rápida não fecha esse requisito.
6. Reconciliar os 44 registros históricos de operações com efeito incerto preservados. A prontidão do backup com escritor parado continua sem aprovação.

A investigação encontrou e corrigiu causas reais, mas **não há base para dizer que o harness inteiro funciona perfeitamente ou que o objetivo foi entregue**.
