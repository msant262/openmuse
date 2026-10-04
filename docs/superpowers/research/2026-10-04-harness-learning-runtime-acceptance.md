# Aceitação: memória e execução do harness

Implementação dos seis itens autorizados da [revisão de Hermes/OpenClaw](2026-10-04-harness-hermes-openclaw-review.md), sobre a base `13f363e`.
Código integrado até `9953ca8`. A sessão anterior terminou com a versão anterior publicada; esta etapa implementa as melhorias adicionais da revisão.

## Origem e adaptação

Referências realmente inspecionadas: [Hermes `1298c8e`](https://github.com/NousResearch/hermes-agent/tree/1298c8e74baa73e1a2b90124228d017261ac6bc4) e [OpenClaw `b56ae70`](https://github.com/openclaw/openclaw/tree/b56ae70a5e7e302dc2165c96b60214e84e19c7b1). Os checkouts externos foram usados apenas para leitura. Licenças e distinção entre cópia de código e adaptação de contratos estão em [Hermes](../../../third_party/hermes-learning/README.md) e [OpenClaw](../../../third_party/openclaw/README.md).

| Parte | Incorporado | Caminho de execução e evidência |
| --- | --- | --- |
| Memória consistente | Centralização da escrita do Hermes, adaptada à origem autenticada e às revisões existentes. Categoria, citação e estado do plano passam pelo mesmo contrato. | `learning/memory-writer.ts`, ferramentas do chat/worker e revisão automática. `sourced-memory`, `personal-learning`, `proactivity-learning`, `routines-integration`. |
| Ferramentas sob demanda | Ranking lexical/BM25 copiado do OpenClaw; descoberta e descrição progressiva de Hermes/OpenClaw. | `engine/tool-discovery.ts` e projeção do provider em `tanstack-agent.ts`. Execução e journal mantêm o nome nativo. `tool-discovery`, `conversation-browser`, `model-worker`, `runtime-tools`. |
| Recuperação de histórico | Descobrir, ler e navegar nas fontes como no Hermes, com ranking textual no banco existente. | `history-retrieval.ts`, `search_past_threads` e `read_past_thread`; índice PostgreSQL, acentos e stemming inglês/português. `history-retrieval`, `memory-history`, `routines-integration`. |
| Compactação | Estrutura, identificadores e auditoria lexical copiados do OpenClaw; propriedade de geração/cancelamento adaptada do Hermes. | `engine/context-compaction.ts` em chat e worker; resumo separado do histórico canônico. `context-compaction`, `task-context-resume`, `task-provider-restart`. |
| Heartbeat por eventos | Prioridade, agrupamento e retenção de eventos do OpenClaw; avaliador de horários ativos copiado. | `proactivity/events.ts`, `source-events.ts` e worker existente. Prazos de planos/tarefas, alterações de objetivos, resultados e mudanças de Gmail/calendário. `proactivity-events` e regressões de pausa, autoridade, recuperação e corridas. |
| Manutenção do aprendizado | Contratos de uso, curadoria e histórico do Hermes, adaptados ao banco e às tarefas verificadas existentes. | `playbooks.ts`, `learning/procedure-maintenance.ts`; catálogo paginado, versão exata, resultados reais, arquivo/restauração e controles no aplicativo. `procedure-maintenance`, `playbooks`, `personal-learning`. |

SOUL continua no perfil persistido, separado das memórias e dos procedimentos. Escritas de perfil exigem origem na mensagem atual autorizada. Revisão automática e manutenção de procedimentos não recebem ferramentas de alteração de SOUL. A interpretação de novas formulações naturais para mudar personalidade, otimização de cache e classificadores adicionais de polling ficaram fora destes seis itens.

## Comportamentos conferidos

- Preferência com citação autêntica persiste, entra no contexto de outra execução e sobrevive ao reinício. Worker não inventa origem de usuário. Uma correção atualiza o mesmo plano; esquecimento suprime reaprendizado da fonte. Estilo do agente não vira fato pessoal.
- Conversa longa com plano inicial, cancelamento e “continue” passa por resumo no provider configurado, mantendo recibos obrigatórios literais e o histórico canônico. Resumo inválido falha explicitamente. Cache usa proprietário, escopo e hash da fonte.
- Descoberta carrega o schema antes da execução real de navegador/documento/computador, preservando nomes, permissões e recibos. Conhecer um nome não concede uma capacidade que a execução já não autorizava.
- Busca recupera palavras reordenadas e acentuadas, separa proprietários, reduz repetição de automação e permite ler a mensagem original com atualizações posteriores. Planos expirados e fatos esquecidos saem da recuperação ativa.
- Prazo próximo desperta revisão antes das quatro horas; duplicatas se agrupam. Pausa, reinício, horário de silêncio, falha de fonte e mudança durante a revisão preservam eventos pendentes. Calendário com treze eventos continua no ciclo seguinte sem reconhecer o alvo omitido como revisado.
- Uso de procedimento registra a versão executada e o resultado confirmado, uma vez por tentativa. Versões anteriores continuam disponíveis após mais de trinta edições. Manutenção protege procedimentos do usuário, fixados e referenciados por trabalho ativo; não altera SOUL.

## Medição do catálogo

Mesmo fixture isolado de chat `Olá` e primeiro dispatch do worker; valores em bytes UTF-8. Números anteriores em [harness-audit-measurements](2026-10-04-harness-audit-measurements.json). Resultados novos em [harness-runtime-measurements](2026-10-04-harness-runtime-measurements.json).

| Pedido | Schemas antes → depois | Bytes de schemas antes → depois | Pedido inteiro antes → depois |
| --- | ---: | ---: | ---: |
| Chat | 78 → 11 | 60.304 → 9.515 | 78.198 → 27.811 |
| Worker | 85 → 15 | 55.684 → 10.494 | 74.528 → 29.740 |

Redução aproximada de 84%/81% nos schemas iniciais. Bytes não equivalem a tokens faturados; não foi medido ganho de latência ou custo de um provedor real nesta etapa.

## Revisão e correções finais

Uma revisão independente do intervalo `13f363e..f86c160` encontrou três problemas importantes, reproduzidos em testes e corrigidos em `9953ca8`:

1. Uma janela posterior podia descartar pedidos da anterior. Cada resumo e cache agora passa pela auditoria contra todos os turnos do usuário no prefixo canônico resumido.
2. Dois cancelamentos sobrepostos podiam restaurar um checkpoint cancelado. Cancelamento invalida somente o próprio token; não restaura um predecessor capturado durante uma corrida. O histórico original permite regeneração.
3. Cobertura completa da leitura do calendário podia reconhecer eventos fora dos doze candidatos. Há prioridade dos alvos reclamados, continuação vinculada à versão da fonte e confirmação individual de revisão.

A segunda leitura independente aprovou essas correções e não encontrou novos problemas críticos/importantes. A suíte integrada também revelou duas expectativas antigas de schemas carregados antecipadamente, uma expectativa de substring substituída pela leitura por ID e vírgulas indevidas nos trechos retornados pelo PostgreSQL. Os testes foram adaptados ao novo contrato e o formato do trecho foi corrigido. Foi acrescentada uma regressão que compara prazos/expiração pelos instantes reais mesmo com offsets diferentes.

## Verificação

- Regressões finais direcionadas: 22/22 (compactação, navegador, eventos), depois 26/26 (worker, rotinas, memória, histórico, eventos e fusos).
- `pnpm typecheck`: servidor e aplicativo aprovados.
- `pnpm lint`: zero erros; 271 avisos e sete informações. A árvore não é livre de avisos.
- `pnpm build:server` e `pnpm build:web`: aprovados.
- Suíte completa final sobre `9953ca8`: **1.261/1.261 aprovados**, zero falhas/cancelamentos/itens pulados; duração de 609 segundos.
- Navegador sobre o build web: fixar, arquivar, restaurar, consultar histórico, recuperar a versão inicial como nova versão e persistir após recarregar. Viewport de 390 × 844: controles de fixação funcionam, sem overflow horizontal. Nenhum erro de runtime no ensaio desktop. API e banco isolados; somente destinos locais liberados pelo navegador.
- Medição final sobre `9953ca8`: 1/1 aprovada, valores iguais aos da tabela.

Comando da suíte: `PATH=/home/marcos/.local/node/bin:$PATH taskset -c 0-3 pnpm exec tsx --test --test-concurrency=4 tests/*.test.ts apps/mobile/test/*.test.ts`. Logs finais preservados localmente em `artifacts/harness-learning-runtime/evidence/`; scripts e capturas de interface em `artifacts/harness-audit/`. Os testes usam bancos isolados e protocolos de provider/fontes sintéticos. Nenhum email real foi enviado nem memória fictícia inserida na conta de produção.

## Limites operacionais

- Gmail nativo usa o token `historyId`; calendário cobre a agenda primária nos próximos sete dias. O poll ocorre a cada cinco minutos e alimenta o scheduler existente de um minuto. A revisão periódica de quatro horas permanece como reconciliação. Não há Google Pub/Sub, `gog` ou adapter automático de qualquer conexão MCP.
- Desconexão, leitura parcial e falha de raciocínio continuam visíveis e não contam como ausência de itens importantes. Entrega real ao aparelho depende da conexão e do push já configurados; os testes não comprovam leitura de uma notificação pelo usuário.
- Recuperação usa busca textual, sem embeddings nem equivalência semântica garantida entre idiomas. O catálogo de procedimentos é limitado para o modelo; a tela existente ainda lista os procedimentos completos.
- Auditoria de resumos é estrutural/lexical, como a referência copiada. Ela detecta perdas cobertas pelos testes, mas não prova preservação de toda negação ou equivalência semântica. Inferências do modelo continuam sujeitas a erro; fontes, revisões e recibos permanecem consultáveis.
- Curadoria semanal após duas horas ociosas marca métodos aprendidos como antigos aos 14 dias e arquiva aos 30 dias, usando a última edição/leitura/execução. Arquivo é reversível. Consolidação exige métodos elegíveis idênticos e operação explícita; não há reescrita semântica autônoma de métodos.
- Esta etapa não fez deploy nem gerou um novo APK assinado. Builds locais não equivalem à publicação. A aceitação conectada e a publicação da sessão anterior permanecem documentadas separadamente.

## Decisões de adaptação

- Continuar na branch existente preservou o trabalho anterior. Não foi feita integração em outra branch nem assumida autorização de uma nova publicação.
- Ferramentas do modelo usam evidência autenticada; edições diretas nas configurações continuam sendo ações confiáveis do usuário. A origem única do chat pode ser preenchida no servidor. Se essa fronteira fosse usada por fontes externas, a garantia de autoria se perderia; os testes de worker e proprietário cobrem essa distinção.
- Descoberta projeta schemas e mantém o executor autorizado original. Restringir apenas a visibilidade não seria suficiente para bloquear efeitos: os modos de conclusão/handoff também restringem o executor. Essa escolha conserva métodos aprendidos que já conhecem nomes nativos.
- Busca textual, diversidade por conversa e contexto pessoal básico limitado aproveitam o banco existente. A consequência é não garantir sinônimos ou tradução entre idiomas; fontes longas exigem leitura/navegação explícita. A busca de conversas locais não substitui histórico hospedado em Rich Threads.
- Resumo usa o provider configurado, sem ferramentas e com orçamento separado. Há custo de inferência na compactação e uma falha explícita se o resumo não passar nas verificações; nenhum histórico canônico é apagado para forçar sucesso. Cancelamento pode exigir regenerar o cache.
- O heartbeat usa o scheduler/worker atuais, com eventos duráveis e consulta nativa das conexões existentes. A escolha evita outro serviço de agendamento, mas mudanças de email podem levar até o próximo poll/review; não se promete tempo real.
- Confirmação por alvo evita repetir um plano só porque outro catálogo está paginado. Calendários maiores continuam em ciclos posteriores; falhas mantêm a fonte pendente com espera crescente.
- A curadoria altera estado de métodos aprendidos e preserva versões. A falta de uso pode arquivar um método ainda útil, por isso há fixação, proteção de referências e restauração. Atualização de conteúdo continua exigindo aprendizado verificado; consolidação semântica automática não foi habilitada.
- Somente as últimas trinta versões ficam no registro principal, mas o histórico imutável mantém todas. A migração adiciona armazenamento por revisão para evitar perder leitura, execução antiga e rollback.

Não restaram achados menores adiados no relatório do revisor. As limitações acima são escolhas de escopo e de adaptação explicitadas, não uma afirmação de equivalência completa entre os três agentes.
