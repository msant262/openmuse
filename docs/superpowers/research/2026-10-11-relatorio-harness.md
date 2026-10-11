# Relatório do harness, publicação e limpeza — 11/10/2026

**Ainda não está entregue.** Há correções publicadas e operações reais verificadas pelo chat. O último teste entregou um PDF em **89,133 segundos**, com **14 respostas de Luna**, mas **reprovou na pesquisa**: selecionou como gratuito um curso cujo acesso completo exige pagamento ou auxílio financeiro. O arquivo físico foi entregue; o pedido não foi cumprido corretamente. A equivalência integral com Hermes/OpenClaw, a cobertura completa do Google Workspace e a performance sustentada no celular continuam sem aprovação.

Estado conferido às **04:55 UTC de 11/10/2026**: o app publicado responde; API, navegador e OpenBao estão saudáveis; não há tarefas, conversas ou solicitações HTTP ativas. Essa fotografia não comprova disponibilidade sustentada.

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

## Falha anterior, correção publicada e resultado do último teste

O pedido comum foi: “Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.” Foi enviado pelo compositor publicado às **04:05:11,715 UTC**, sem dicas de ferramentas, respostas do operador ou conserto manual.

Às **04:20:30,199 UTC**, a tarefa continuava rodando. Havia vários rascunhos, **91 respostas de `chatgpt/gpt-6-luna` e seis revisões**, mas nenhuma entrega final. Somente essa tarefa de QA foi cancelada pelo controle normal do app. Seu último rascunho foi preservado como diagnóstico, sem ser apresentado como entrega aprovada. A evidência original da falha permanece intacta.

Encontrei outra causa concreta: a configuração de revisão independente estava desativada, mas o harness a ligava automaticamente quando entendia que o pedido exigia opções gratuitas. Isso adicionava outra sequência de chamadas do modelo e rejeições ao fluxo normal. A revisão chegou a aceitar uma política de gratuidade de um programa IBM como prova para outro, e revisões posteriores recusaram essa aplicação. Não reutilizamos a aprovação anterior como se ela confirmasse o curso escolhido.

A correção **`f2e239ae` foi publicada no app**, por uma troca somente da API que levou **19,71 segundos**, com parada limpa e preservação de ambiente, banco e navegador. Agora o harness respeita a configuração: revisão independente desativada não faz essa chamada extra; ativada mantém a verificação sobre o texto real do documento e as fontes observadas. Os controles de arquivo real, formato, revisão visual, efeito, aprovação e recibos continuam obrigatórios. Não houve aumento de modelo, troca para modelo de fronteira ou redução arbitrária de limites.

A repetição pelo compositor publicado começou às **04:36:21,293 UTC** e terminou às **04:37:50,426 UTC**: **89,133 segundos**, **14 respostas de `chatgpt/gpt-6-luna`**, sem revisão semântica independente, dicas de ferramentas, respostas do operador ou conserto manual. O PDF real tem **51.350 bytes**, três páginas e SHA-256 `5ad9231e3a31b470e598f476c2624e844f401b8604c93017d40a288a4d82510e`. Texto, pixels, quatro URLs de fontes e navegação pelas três páginas no visualizador publicado foram conferidos. O layout é legível, mas ainda tem título duplicado e colunas estreitas.

**A pesquisa continua reprovada.** A opção da Coursera foi incluída como gratuita, embora a [FAQ da página exata](https://www.coursera.org/learn/introduction-to-generative-ai) restrinja o conteúdo completo a pagamento ou auxílio financeiro. Google Skills e Coursera também apresentam o mesmo curso introdutório do Google Cloud em plataformas diferentes; três cursos distintos não ficaram comprovados. Alguns idiomas e custos de certificado continuam sem confirmação. O estado “concluído” e a verificação nativa do arquivo não comprovam a correção desses fatos.

A extração entregue ao agente continha os títulos das perguntas da FAQ, sem suas respostas, e estava marcada como leitura completa. Uma nova comparação direta dos modos básico e avançado trouxe o texto completo em ambos; portanto, trocar todas as leituras para avançado não está comprovado como solução.

A correção **`fd9906c3` está commitada na main, ainda sem publicação**. Ela detecta perguntas de FAQ sem respostas, tenta uma recuperação avançada uma única vez e conserva o texto observado com indicação explícita de incompletude se a tentativa falhar. Isso permite usar a recuperação por navegador já existente. Leituras completas continuam sem essa chamada adicional. A melhora factual precisa ser comprovada por outra repetição normal após a publicação.

## Testes e versão

- **Produção atual:** `f2e239ae505a5cf1ef2d9004bce5133fdeccbaa0`. Inclui as correções de referências de arquivos/fontes, geração direta de rascunhos locais e respeito à configuração de revisão independente. A última publicação levou 19,71 segundos, com parada limpa e preservação de banco, ambiente e navegador.
- **Correções novas:** `fd9906c3` recupera FAQs incompletas; `427e77dc` limita o contexto de kanban e completa a paginação. Ambas estão commitadas na main; ainda não estão no app publicado.
- **Validação anterior da correção publicada:** 114 casos distintos passaram: 61 de pesquisa/revisão, 43 de documentos/entrega/efeitos e dez do núcleo local de kanban. TypeScript e o build final do servidor/harness passaram. O lint terminou sem erros, com avisos preexistentes.
- A primeira execução de um grupo teve 11/12: uma fixture ainda dependia da revisão forçada. Ela passou a habilitar explicitamente a revisão que testa; as asserções de rejeição do arquivo incorreto permaneceram. O grupo inteiro foi repetido e passou 12/12. A invocação que falhou foi preservada.
- A nova validação focada passou **61/61**, sem falhas, cancelamentos ou casos ignorados, em **12,146 segundos**, usando Node **24.16.0**: 49 de integração/leitura/extração e 12 de kanban. TypeScript e o build final do servidor/harness passaram nesse runtime. Os três testes iniciais de extração reproduziram a falha antes da correção; a versão final cobre recuperação, conteúdo ainda parcial, falha do provedor, cancelamento e recuperação pelo navegador. Esses 61 casos são outra execução focada; não são uma nova suíte completa nem uma soma com os 114 anteriores.
- Os 12 casos de kanban incluem descoberta limitada em SQL, dependências, comentários incrementais, recuperação de resultados anteriores, paginação de 211 cards e 205 filhos. Parte desse núcleo está publicada; a extensão de contexto está commitada, sem publicação nem integração às ferramentas, ao dispatcher ou à interface. **Isso não implementa as quinze ferramentas de kanban do Hermes.**
- A suíte completa de 1.954 testes aprovada anteriormente pertence à versão `dff49510`; não é apresentada como uma nova execução completa da versão atual.

## Limpeza realizada e dados preservados

A última rodada retirou da apresentação **seis registros exclusivamente de QA**: dois arquivos, uma tarefa, uma conversa, uma notificação e uma entrada de mensagem. **1.750 registros fora da seleção permaneceram idênticos**. O teste também atualizou um procedimento aprendido que já existia; pelo controle versionado normal, o conteúdo anterior foi restaurado como versão 3. As versões históricas 1 e 2 e os outros 30 procedimentos permaneceram intactos. Depois da recarga, o compositor estava disponível e nem a conversa nem o PDF de QA apareciam. A evidência da pesquisa reprovada foi preservada.

A rodada anterior retirou 12 registros de QA e preservou 1.739 registros fora da seleção; ela permanece documentada separadamente.

Foram preservados **companions, 58 arquivos reais/companions, duas conversas reais, três tarefas reais, duas ações, cinco atividades, três memórias e as três contas Google conectadas simultaneamente**. Recibos canônicos, credenciais, perfis, volumes e backups foram preservados.

Rodadas anteriores já retiraram as conversas, ações, revisões e documentos identificados como testes; removeram **12 APKs locais obsoletos**, liberando 811.757.568 bytes alocados, e releases/uploads duplicados na VPS. As versões atuais e de recuperação foram mantidas. A última inspeção não encontrou outro APK fora das versões protegidas para remover.

Também foram retiradas imagens Docker e árvores de build obsoletas com conferência dos hashes. Duas rodadas recentes registraram aproximadamente **1,62 GB** e **436,46 MB** liberados na VPS; o segundo arquivo local obsoleto liberou 53.108.736 bytes alocados. Esses valores são de rodadas distintas, não uma medição única do ganho líquido. Nesta rodada, mais **duas imagens Docker obsoletas** e seus builds/releases foram retirados, depois de conferir **23.754 arquivos de origem** e os hashes dos releases. A retirada registrou **873.172.992 bytes** liberados na VPS, preservando a imagem atual, a recuperação imediata e a recuperação já aceita. Esse é o ganho durante a retirada; o novo build também consumiu armazenamento. A última medição após essa limpeza registrou **37.523.091.456 bytes livres** na VPS. Os dois arquivos de release locais correspondentes também foram retirados após conferir os hashes, liberando **106.401.792 bytes alocados**. APKs atuais e de recuperação foram preservados. Vinte arquivos de evidência foram copiados da VPS para o diagnóstico local, com hashes verificados e acesso restrito.

## O que ainda falta

1. Publicar a correção de leitura parcial e repetir o pedido normal de pesquisa/PDF com Luna, comprovando os fatos no conteúdo entregue. O arquivo mais rápido ainda apresentou informação incorreta.
2. Completar os contratos ainda ausentes do Hermes/OpenClaw, incluindo integração das quinze ferramentas de kanban e execução de navegador. A equivalência integral permanece **reprovada**.
3. Ampliar a cobertura real do Google Workspace, incluindo operações de alteração/exclusão e seus cards; os casos aprovados acima não cobrem todas as ações possíveis.
4. Resolver a divergência de contador de Ações e verificar a UX completa em desktop e celular.
5. Medir performance sustentada em dispositivo real e sob uso repetido. A amostra de recarga rápida não fecha esse requisito.
6. Reconciliar os 44 registros históricos de operações com efeito incerto preservados. A prontidão do backup com escritor parado continua sem aprovação.

A investigação encontrou e corrigiu causas reais, mas **não há base para dizer que o harness inteiro funciona perfeitamente ou que o objetivo foi entregue**.
