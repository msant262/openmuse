# Posse do workflow pela tarefa nativa — 11/10/2026

**Correção local verificada; ainda não publicada. O harness completo permanece sem aceite.**

## Causa reproduzida

O card considerava sua posse expirada após 120 segundos. O worker existente renova a tarefa nativa, mas o workflow só consultava o relógio do card. Uma tarefa longa, em fila ou aguardando aprovação/resposta podia perder o card para outra execução. O token do card também não distinguia uma tentativa antiga de um novo ator da mesma tarefa. A identidade do recibo incluía todo o escopo recebido; acrescentar a identidade do ator tornava uma confirmação perdida incompatível com a retomada.

Antes da correção, oito dos nove casos iniciais falharam. Uma segunda reprodução encontrou mais dois caminhos sem barreira final: a confirmação de uma criação já deduplicada e uma pausa global chegada entre leitura e gravação.

## Comportamento implementado

- O vínculo canônico grava o ID da tarefa nativa no run. A tarefa existente fornece status, ator e validade da posse; sua renovação normal mantém a autoridade do card sem exigir heartbeat do modelo.
- Tarefas em fila, em execução ou aguardando decisão conservam o run, inclusive quando o prazo antigo do card passa. Uma execução com posse expirada deve ser retomada pelo worker nativo existente, em vez de abrir outro run do card.
- O worker recebe tarefa e ator do host. Ator antigo, vínculo ausente, conta diferente ou vínculo incompatível não concedem autoridade para notas, anexos, follow-ups ou conclusão.
- A transação final confere a posse nativa, sua validade pelo relógio do banco, o vínculo, o card de origem e a pausa global. Os novos checks leem e bloqueiam os registros sem regravá-los ou acrescentar valores ao resultado; preservam a posição dos recibos de handoff.
- Uma tarefa terminal com efeitos incertos ou limpeza/reconciliação pendente conserva a proteção. A condição é usada tanto na consulta compacta quanto na transação de nova posse.
- Confirmações perdidas usam a identidade lógica do run, que sobrevive à troca de ator. Releitura de um recibo não concede autoridade para novas alterações nem repete a conclusão.
- `kanban_show` apresenta a tarefa nativa, seu status e a proteção da posse. A consulta projeta os campos necessários e não carrega histórico, evidências ou respostas anteriores da tarefa.
- Cards históricos sem vínculo nativo conservam o contrato de prazo existente. Vínculos históricos presentes também são reconhecidos; não recebem uma exceção à verificação do ator.

## Validação observada

**91/91 testes focados passaram**, com zero falhas, cancelamentos ou skips, em **103,874 segundos**, cobrindo doze arquivos. Incluem os 14 novos casos de posse, os controles existentes de kanban/artefatos/contexto/criação, inbox/handoff de conversa, pausa e retomada de aprovação.

Os casos novos verificam prazo antigo vencido, fila e esperas, troca de ator, mudança de vínculo/ator/validade no instante da gravação, confirmação perdida após retomada, efeito incerto, vínculo ausente, nova posse após término seguro, confirmação deduplicada e pausa tardia. Um caso usa o worker nativo real com relógio controlado e uma tarefa longa. Não usa um modelo real. Outros controles do grupo usam provedor scripted; **essa suíte não constitui um pedido natural publicado a Luna**.

Um teste histórico que encerrava manualmente um card já vinculado a uma tarefa em fila passou a ser rejeitado pela nova autoridade. Sua montagem foi corrigida para representar um handoff anterior à importação do vínculo, mantendo a exigência original: uma conclusão sem prova nativa não pode fabricar sucesso na retomada. Esse controle passou no grupo final.

TypeScript, build do servidor, assets e harness copiado passaram. Lint dos sete arquivos modificados passou sem erros, com três avisos preexistentes. O manifesto local `artifacts/harness-parity-20261009/round69-local-verification-manifest.json` fixa fontes, artefatos compilados e logs.

## O que continua necessário

Esta correção não ativa o despacho automático. Provisionamento físico de scratch/diretório/worktree, configuração efetiva de modelo/skills/orçamentos, objetivo/PR/CI, roteamento de entrega para a conversa e aceitação normal publicada continuam necessários. O [registro do dispatcher](2026-10-11-kanban-dispatch.md) mantém esses contratos.

Não houve alteração de dados, contas, configuração ou containers da produção nesta rodada. A última API publicada continua em `c0c2c9ec`; o resultado de pesquisa, limpeza e demais limites estão no [relatório](2026-10-11-relatorio-harness.md). As 44 operações históricas incertas não foram reconciliadas por esta mudança.
