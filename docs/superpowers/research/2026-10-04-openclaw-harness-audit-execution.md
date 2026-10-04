# Auditoria de contexto, retomada, fallback e executor

Referência: OpenClaw `da979df299e88c3711f6ee2cd3c7443dd045584b`, inspecionado no
checkout local `/tmp/openclaw-harness-reference`, inclusive objetos Git dos
pacotes fora do sparse checkout. Licença MIT, copyright 2026 OpenClaw Foundation;
aviso preservado em `third_party/openclaw/LICENSE`. Os caminhos abaixo identificam
fontes efetivamente lidas. Não foi executado código do projeto de referência.

## Incidente e causa comprovada

O pedido de um PDF explicando o próprio assistente terminou em `waiting_provider`.
A tarefa `a16cde7f54fed24a24e5f3055cc220f68d72c06f0f3f389616197ebbada9d27a`
executou 16 passos e 62 operações no primeiro trecho; todas as operações eram
leituras. Havia 48 registros de evidência web, com 47.826 bytes serializados.
O checkpoint de rejeição continha 80 mensagens, cerca de 171 KB, com código
`MODEL_CAPABILITY_UNAVAILABLE`, `accepted: false` e modelo rejeitado
`chatgpt/gpt-6-luna`. Esses números são agregados do diagnóstico privado; nenhum
segredo ou conteúdo integral de fonte é reproduzido neste documento.

A sequência importa:

1. O worker criava o prompt fixo com todo `task.evidence`. As leituras do primeiro
   trecho acumularam evidências; o próximo trecho trouxe mais 47.826 bytes para
   a parte obrigatória do contexto.
2. O orçamento serializava objetos Zod antes da conversão feita pelo SDK. A
   reconstrução local do catálogo daquele worker mediu 109.209 bytes fixos com
   schemas crus contra 61.563 com os schemas JSON realmente enviados. Em outros
   schemas, a mesma divergência subestima o tamanho: uma descrição longa de
   campo desaparecia da estimativa. Portanto, o defeito não é apenas um fator
   constante conservador.
3. A base superestimada mais as evidências ultrapassava a capacidade declarada
   de 131.072 do modelo escolhido e do primeiro fallback, antes de qualquer
   poda de histórico opcional. O segundo fallback tinha 32.768 e não estava
   disponível. O bloqueio era local, não prova de falha de rede do provedor.
4. A rejeição salvou as mensagens canônicas no checkpoint do provedor. Um retry
   posterior também colocaria esse checkpoint inteiro dentro de `priorState`
   no prompt obrigatório, duplicando o histórico e impedindo a recuperação.

Os valores de 109.209 e 61.563 são da reconstrução anterior às ferramentas novas
desta mudança; não são uma promessa de tamanho do catálogo futuro. O orçamento
permanece em bytes UTF-8 conservadores. Não aumentamos artificialmente a
capacidade declarada nem a dividimos por uma aproximação de quatro caracteres.

## Comparação com OpenClaw e decisão por camada

| Camada | Fontes OpenClaw lidas | Decisão no app |
| --- | --- | --- |
| Medição da requisição | `src/agents/sessions/context-token-pressure.ts`; `sessions/compaction/request-budget.ts` | Adaptar o contrato de medir definições renderizadas de ferramentas. `ContextBudget.cost` agora usa a mesma conversão JSON Schema que o SDK usa antes da admissão. Preservar a margem conservadora local e a reserva de saída. |
| Retenção e compactação | `packages/agent-core/src/harness/compaction/compaction.ts`; `src/agents/sessions/agent-session-compaction.ts` | Manter a projeção existente de pares chamada/resultado e recibos obrigatórios. Remover a cópia do checkpoint do prompt fixo e indexar evidência por referência. Não afirmar que existe resumo por modelo ou compactação automática equivalente à classe de sessão do OpenClaw. |
| Resultado volumoso | `src/agents/tool-result-limits.ts`; `embedded-agent-runner/tool-result-context-guard.ts`, `tool-result-text-budget.ts`, `tool-result-truncation.ts` | Copiar constantes/funções portáveis de limite com atribuição. Adaptar projeção por chamada e paginação para histórico TanStack, conservando o resultado canônico. O limite de bytes e os pares obrigatórios continuam locais. |
| Pressão antecipada | `src/agents/embedded-agent-runner/run/preemptive-compaction.ts` | A checagem local ocorre em todo dispatch. Telemetria de uso real do provedor e resumo preventivo são extensões possíveis, não implementadas por esta correção. Não tratar um prefixo em cache como prova de que o catálogo atual já cabe. |
| Falta de progresso | `src/agents/tool-loop-no-progress.ts`; `tool-loop-argument-churn.ts` | Copiar classificadores puros e alimentar com recibos canônicos. A integração avisa após dez resultados idênticos e veta a próxima execução após vinte; argumentos novos e ferramentas de conclusão continuam acessíveis. |
| Fallback e aborto | `src/agents/model-fallback-attempt.ts`; `model-fallback-stop.ts` | Reter o roteador e checkpoints locais. Eles já distinguem tentativa não aceita, saída aceita, cancelamento e efeitos confirmados. O marcador de parada do OpenClaw inspira o contrato, mas não foi copiado como uma segunda autoridade sobre o journal. |
| Limpeza e posse | `src/agents/run-cleanup-timeout.ts` | Reter drenagem de ferramentas, leases físicos e reconciliação nativa. Timeout limita espera/relato; não comprova que o processo ou efeito acabou. A incerteza deve impedir reexecução ou troca de dono. |

O pacote `@openclaw/agent-core` inspecionado é privado e depende dos workspaces
`@openclaw/ai`, `@openclaw/llm-core` e `@openclaw/normalization-core`. Sua classe
completa de compactação depende do gerenciador de sessão e do runtime próprios.
Copiar contratos e funções puras com testes é reutilização concreta; importar
a classe isoladamente não substitui o ciclo de vida do app.

## Alterações de contexto e evidência

- `apps/server/src/engine/context-budget.ts`: contabiliza os schemas de entrada
  e saída das ferramentas depois da conversão, antes da escolha de capacidade
  e da projeção. Mantém agrupamento de pares e reserva de saída existentes.
- `apps/server/src/engine/model.ts`: exclui somente `providerCheckpoint` da
  cópia de estado destinada ao prompt. O checkpoint durável e o replay via
  `TaskActor.history` continuam intactos, inclusive em retomada após restart.
- `apps/server/src/engine/task-evidence-context.ts`: substitui a lista integral
  no prompt por índice de até oito registros recentes, no máximo 10.000 bytes,
  com total, quantidade omitida e instrução de recuperação. URLs, IDs, origem,
  versão e datas preservam seus valores; títulos e trechos são resumidos.
- `read_task_evidence`: consulta a tarefa atual do mesmo proprietário por ID
  exato ou página de até vinte registros. Não recebe outro task ID/owner. O
  conteúdo original e referências para arquivos/fontes continuam disponíveis.
  É leitura no journal; resultados são dados não confiáveis, não autorização.

A evidência web não substitui recibos de efeito. `TaskJournal.requiredHistoryIds`
continua protegendo operações de efeito confirmadas ou com execução incerta;
`ContextBudget` exige seus pares completos. Campos de estado de aprovação,
efeito e trabalho nativo não são removidos por esta mudança.

## Fallback, continuação e cancelamento

Arquivos locais revistos: `providers/models.ts`, `model-router.ts`,
`model-capabilities.ts`, `preferences.ts`, `engine/model.ts`, `task-actor.ts`,
`task-journal.ts` e `tanstack-agent.ts`.

O adaptador cria um AbortController para a tentativa e respeita os limites de
tempo globais e por tentativa. Bufferiza chamadas de ferramentas até uma
resposta aceita e concluída; uma desconexão intermediária não executa chamadas
parciais. Fallback automático só ocorre em falha permitida antes de aceitação
ou saída visível. Depois disso, salva continuação em vez de repetir a resposta
em outro provedor. Leases são liberados e o transporte é abortado em `finally`.

A seleção persistida e os fallbacks explícitos passam pela mesma checagem de
ferramentas, visão, saída estruturada e capacidade. Cooldowns e limites de
concorrência permanecem ativos. A existência de um modelo na lista de fallback
não cria credenciais nem torna sua conexão disponível.

O ator recompõe o histórico a partir do journal e aceita recibos de chamadas
conhecidas no checkpoint; o restart não transforma uma intenção incerta em
autorização para repeti-la. O worker guarda o checkpoint após drenar ferramentas
pendentes e respeita pausas/supersessão. Os limites de passos ainda geram
continuação durável; o novo detector acrescenta uma condição de falta de
progresso, sem virar a autoridade de idempotência.

Na revisão da integração nova, `onMessages` recebe o histórico canônico antes
da projeção; resultados de efeitos obrigatórios não são truncados. O veto de
loop ocorre antes de `executeTool`, portanto não grava uma execução que não
aconteceu. Chamadas paralelas idênticas esperam o resultado anterior; o próximo
dispatch checa aborto depois dessa espera. Chamadas diferentes não ficam
presas nessa fila. `finish_task`, delegação e leitura de saída preservada
continuam disponíveis para concluir ou recuperar trabalho.

Limitação explícita: os hashes locais ainda incluem campos voláteis dos
resultados. Um status com timestamp/ID novo pode não contar como resultado
idêntico. Também não foram portadas as classificações específicas de falha de
terminal do OpenClaw. O detector atual não é prova de ausência de todo loop.

## Executor nativo e reconexão

Revistos `apps/computer/executor/supervisor.py`, seu journal/transporte e o
registro/reconciliação no servidor. No diagnóstico do incidente, o executor
estava conectado, mas em `status: error` e `readiness.quarantined: true`.
Display, captura, entrada e browser estavam indisponíveis; runtime, arquivos e
conta estavam prontos. Isso é mais específico que dizer apenas “offline”.

O supervisor fecha o gate antes de registrar/reconciliar. A reconexão apresenta
epoch, boot/instance IDs e manifesto durável, recebe confirmações e só então
libera execução. Recibos de outro epoch voltam pelo manifesto; trabalhos
desconhecidos não são reenviados. Ao retomar, apenas jobs conhecidos com recibo
`running` podem ser descongelados. O watchdog e a perda de heartbeat voltam a
fechar o gate.

Se qualquer etapa exigida de contenção falha, `Gate.close` mantém quarentena.
`Gate.reconciled` recusa limpar essa condição só porque a rede voltou. Essa é
uma proteção de posse, não um erro a corrigir com reset automático. O operador
reiniciou o serviço e restaurou prontidão, mas o snapshot disponível não
identifica qual etapa de contenção falhou originalmente. Não atribuímos uma
causa específica ao socket sem o log correspondente e não alteramos o
supervisor sem reprodução.

Há uma lacuna observável: o loop de reconexão registra principalmente a classe
da exceção, enquanto a prontidão informa quarentena agregada. Uma investigação
posterior deve registrar componentes/razões de contenção sem segredos e
reproduzir perda de socket durante restart. O critério para recuperação segura
continua sendo comprovação de contenção e reconciliação, não um prazo decorrido.
O módulo de limpeza do OpenClaw tem o mesmo princípio; não é um substituto
pronto para o supervisor Linux/Tailscale específico deste produto.

## Verificação realizada nesta frente

Os testes novos reproduziram falha antes da correção e passaram depois:

- `tests/memory-context.test.ts`: estimativa coincide com o request normalizado;
  a requisição real do SDK poda fonte opcional, preserva o usuário atual e
  admite o catálogo com descrições longas.
- `tests/task-context-resume.test.ts`: retomada de histórico canônico acima de
  90 KB sem duplicá-lo em instruções e sem repetir as três leituras; 150
  evidências grandes permanecem intactas e recuperáveis por ferramenta enquanto
  o índice fixo cabe no orçamento. A tarefa chega a `succeeded`.
- Execução conjunta desses testes com `task-provider-restart` e
  `model-preferences`: 13/13 aprovados.
- `provider-routing`, `task-provider-restart`, `shutdown` e `remote-executor`:
  66/66 aprovados, incluindo interrupção, liberação, restart após efeito HTTP
  e preservação do lease físico enquanto o resultado nativo é incerto.
- Contratos Python de executor, correções, supervisor de desktop e lifecycle
  systemd: 60/60 aprovados. `tsc --noEmit` sem erros no momento da verificação.

Esses resultados cobrem as fronteiras locais e usam provedores sintéticos onde
apropriado. O ensaio com o modelo conectado, download do PDF e publicação na
conversa pertencem à verificação integrada da entrega; não são inferidos dos
testes determinísticos. O release e a retomada da tarefa real são registrados
pela execução principal.
