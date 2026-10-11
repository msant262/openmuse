# Kanban: vínculo de execução e contratos ainda pendentes — 11/10/2026

**Validação local; não publicado e sem aprovação de paridade.** A API de produção continua em `c0c2c9ec`, com o resultado e os limites descritos no [relatório](2026-10-11-relatorio-harness.md).

A leitura do código atual encontrou ferramentas registradas e testes que inserem `kanban-executions` manualmente. O worker não faz despacho automático de cards. Um card criado e um teste de schema aprovado, portanto, não comprovam que a tarefa correspondente será executada.

Foi acrescentado `AgentService.dispatchKanbanCard`: o host prepara o contrato nativo já existente e grava tarefa, vínculo, run e card na mesma transação. Não aceita uma identidade de run do modelo. A revisão autenticada do perfil também integra o CAS: uma revogação durante a preparação impede a gravação inteira. A pausa é conferida novamente na transação, inclusive quando chega depois de preparar o registro. A confirmação perdida retorna a tarefa previamente vinculada, sem criar outro run. O executor recebe o contexto do workflow, incluindo autores e handoffs como dados, sem lhes atribuir autoridade de sistema.

Isso é a fundação de vínculo e execução, **não o dispatcher automático completo**. Não há novo timer ou hook do worker instalado. O novo método mantém explícitos os contratos ainda sem backend: workspace configurado, objetivo/PR/CI, seleção de modelo/provedor, skills e orçamentos físicos. Cards que declaram essas condições são recusados antes da gravação, em vez de executados como uma tarefa local comum. A provisão física de scratch também continua pendente; o caso de leitura de fonte não a aprova. O método deve ser integrado ao provisionador e ao ciclo de posse antes de ser exposto ao despacho automático.

## Evidência local

- A primeira execução do novo grupo falhou em quatro casos por inexistência do vínculo criado pelo host. Separadamente, a versão original de `claim` falhou no controle que exige invocar a preparação antes de registrar a posse. A fonte modificada foi restaurada byte a byte após essa reprodução.
- O grupo final de sete arquivos passou em **56/56 controles**, com zero falhas, cancelamentos ou skips, em **71,078 segundos**. Contém sete casos novos e os controles existentes de contexto, criação, anexos, artefatos, lifecycle e execução das ferramentas.
- Um provedor de teste usa o worker real e PGlite: o novo método cria o vínculo, a leitura deixa um recibo e `finish_task` conclui o card com prova nativa. A confirmação repetida depois do fim não cria outra tarefa/run. **O provedor é scripted; não é um pedido normal a Luna nem prova de escolha autônoma das ferramentas.**
- Falha na preparação, concorrência, revogação do perfil, pausa e outra conta não deixam tarefa órfã nem alteram o card indevidamente. Objetivo, contrato de PR e override de modelo não são rebaixados silenciosamente.
- TypeScript do projeto passou. Lint final passou sem erros, com quatro avisos em trechos preexistentes dos arquivos examinados. Build do servidor, assets e harness passou. O manifesto local fixa os hashes das cinco fontes e dos oito logs; não é aprovação de uma release publicada.

Logs e fontes de referência preservados em `artifacts/harness-parity-20261009`, fora do Git. Não houve alteração de dados, contas ou configuração da produção nesta rodada.

## Integração ainda necessária

| Contrato | O que falta verificar/implementar |
| --- | --- |
| Despacho automático | Seleção limitada em SQL, perfil autenticado, prioridade/dependências e capacidade real do worker existente. Não carregar todo o histórico nem criar um segundo executor. |
| Posse e retomada | Corrigida localmente: o run acompanha a autoridade da tarefa nativa, incluindo esperas, ator substituído, confirmação perdida e efeitos incertos. Barreiras transacionais e 91 controles focados passaram. Ainda requer publicação e aceitação normal do fluxo integrado; ver [registro de posse](2026-10-11-kanban-native-ownership.md). |
| Workspace | Preparação física de scratch/diretório/worktree e vínculo ao terminal, arquivos e Python implementados localmente; 110 controles de integração e 61 de Python passaram. Configuração de projetos/default workdir e publicação/aceitação do protocolo v2 ainda pendentes; ver [registro de workspace](2026-10-11-kanban-workspace.md). |
| Configuração | Usar efetivamente modelo/provedor, skills e orçamento declarado; armazenar e conferir o perfil responsável, sem conceder acesso por texto do modelo. |
| Objetivo e CI | Juiz/gate real do objetivo e CI do commit exato; contrato de PR não pode virar local-only. |
| Entrega | Roteamento durável para a conversa/subscrição correta; arquivo real, autor, conta e recibos. A biblioteca ou um card concluído isolado não comprovam entrega ao usuário. |
| Recuperação | Reconciliar o resultado observado e a autoridade antes de reexecutar. Preservar as 44 operações históricas incertas e os dados reais. |
| Aceitação | Testes de concorrência/retomada/provisão e um pedido normal no chat publicado, sem pedir ferramentas ou cards ao modelo. |

A comparação usa o Hermes fixado em `e0550c97`: [dispatcher](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/hermes_cli/kanban_db_dispatch.py), [watcher](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/gateway/kanban_watchers_dispatcher.py) e [workspace](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/hermes_cli/kanban_workflow.py). As três fontes foram obtidas nessa rodada e seus hashes preservados. Uma tentativa de obter um nome de teste inexistente recebeu 404; a árvore do commit foi consultada para corrigir a identificação, sem alegar que esse teste foi lido ou executado.

**Pesquisa factual, integração completa do Workspace, performance e os demais contratos Hermes/OpenClaw seguem no objetivo; esta fundação não os substitui.**
