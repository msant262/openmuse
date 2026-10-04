# Revisão do harness: Hermes e OpenClaw

Revisão de 4 de outubro de 2026, sobre OpenMuse `13f363e`, com árvore limpa no
início. Escopo: identidade, memória, aprendizado, contexto, ferramentas,
execução, retomada, skills, provedores e proatividade. Este documento registra
achados e propostas; as mudanças propostas abaixo ainda não foram implementadas.

A sessão anterior terminou com memória/aprendizado e heartbeat publicados e
verificados. A aceitação está em
[memory-learning-heartbeat-acceptance](2026-10-04-memory-learning-heartbeat-acceptance.md).
Esta revisão não alterou a produção nem retomou o processo da sessão anterior.

## Referências efetivamente inspecionadas

Foram consultados os repositórios oficiais e feitos novos checkouts de leitura,
separados das referências usadas na implementação anterior:

- [Hermes `1298c8e`](https://github.com/NousResearch/hermes-agent/tree/1298c8e74baa73e1a2b90124228d017261ac6bc4),
  em `/tmp/harness-audit-20261004-hermes`.
- [OpenClaw `b56ae70`](https://github.com/openclaw/openclaw/tree/b56ae70a5e7e302dc2165c96b60214e84e19c7b1),
  em `/tmp/harness-audit-20261004-openclaw`.

Os links abaixo fixam essas versões. A comparação inclui código e testes de
referência; não foi executado o runtime dos projetos externos. As verificações
locais usaram banco isolado e provedor sintético. Os números medem requisições
montadas pelo nosso SDK, não custo ou latência de um provedor real.

## Contrato de SOUL definido pelo usuário

Memória registra fatos, gostos, hábitos e planos do usuário. Procedimentos
registram métodos reutilizáveis. SOUL define a personalidade e o jeito de falar
do agente. Aprendizado, recordações, documentos, emails e resultados de
ferramentas não podem editar SOUL nem criar instruções de personalidade por
outro caminho.

Quando o usuário pedir explicitamente uma mudança persistente de personalidade
ou fala, o agente deve alterar diretamente o SOUL/perfil, com revisão e origem
na mensagem atual. Uma instrução para um único email ou tarefa continua local
àquela tarefa. Uma citação de outra pessoa não vira pedido do usuário.

No OpenMuse, SOUL é o perfil persistido em `agent-profiles`, com histórico em
`profile-history`; não existe necessidade de criar um segundo arquivo como
autoridade concorrente. `AgentProfiles.authorizeOrigin` vincula alterações à
mensagem aceita do mesmo proprietário, conversa e execução. O aprendizado
automático não recebe ferramentas para editar esse perfil. `buildProfileContext`
e `MemoryService.context` também distinguem personalidade de fatos recuperados.

O Hermes separa [memória em MEMORY.md/USER.md](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/memory_tool_store.py)
da [leitura de SOUL](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/agent/prompt_builder.py).
OpenClaw documenta [SOUL, USER, memória e skills separadamente](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/docs/concepts/agent-workspace.md).
Há preferências de comunicação em USER nos upstreams; aqui vale a determinação
mais específica do usuário: mudanças persistentes no jeito do agente passam pelo
SOUL e por um pedido explícito. Não copiar políticas de evolução autônoma de
personalidade.

## Achados prioritários

P1 indica lacuna que afeta diretamente o comportamento solicitado. P2 indica
melhoria relevante após essas correções. São prioridades de produto, não uma
classificação de vulnerabilidades.

### 1. P1 — Aceitar pedidos naturais de mudança de SOUL

**Evidência local:** `apps/server/src/agent-profile.ts:131,285` e
`apps/server/src/personal-tools.ts:234`. A autorização depende do resultado de
`profileIntent`, um parser por expressões regulares. A reprodução encontrou:

| Mensagem atual do usuário | Resultado do parser |
| --- | --- |
| `Responda formal` | Reconhecida |
| `Fala comigo de um jeito mais carinhoso e menos formal` | Não reconhecida |
| `Quero que você pare de usar emojis nas suas respostas` | Não reconhecida |
| `Sua personalidade: gentil e objetiva.` | Reconhecida |

Mesmo que o modelo entenda o pedido, a ferramenta recusa a alteração fora desse
conjunto e devolve uma instrução genérica para pedir esclarecimento. A barreira
contra memória alterar SOUL funciona; a compreensão do pedido autorizado é
restrita demais.

**Incorporar:** usar a separação de identidade/memória dos upstreams e conservar
nossa autorização por origem. Acrescentar interpretação estruturada de intenção
sobre a mensagem atual, com escopo e campos limitados. A proposta do modelo não
deve ser suficiente para autorizar uma escrita: precisa de validação independente
da origem e do trecho que sustenta a mudança. Conteúdo citado e histórico ficam
fora dessa autorização. Isso exige adaptação local; nenhum arquivo upstream
inspecionado é um substituto direto para nosso inbox e suas revisões.

**Aceitação:** os dois pedidos naturais acima atualizam o perfil; a mesma frase
em email, memória, citação ou tarefa de revisão não atualiza nada. Pedido válido
não exige que o usuário repita uma frase de comando. Reset e instruções locais
mantêm suas distinções.

### 2. P1 — Unificar a qualidade das escritas de memória

**Evidência local:** `personal-tools.ts:290` expõe `remember_fact` apenas com
`text`. Chama `memory.save` com a descrição fixa `User confirmed in chat`, sem
exigir categoria, citação ou validade. A ferramenta também existe no worker,
onde pode gravar origem `local`. `correct_memory` exige revisão, mas não passa
pela validação de evidência da revisão automática.

Na reprodução isolada, uma chamada direta salvou uma frase de estilo sem
categoria nem evidência. O perfil permaneceu idêntico. Isso prova uma diferença
de contratos entre ferramentas; não prova que um modelo real gerará essa chamada
ou que o SOUL em produção foi alterado.

`learning/service.ts:184` já valida citações, origem, correções mais recentes e
fontes esquecidas. Seu prompt também exige utilidade e exclui persona do agente.
A gravação direta não deve contornar esse trabalho, nem guardar um plano datado
sem os campos que permitem encerrá-lo.

**Incorporar:** a ferramenta central de
[memória do Hermes](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/memory_tool.py)
encaminha operações ao mesmo store, com validação, substituição explícita e
operações em lote. Adaptar essa centralização ao nosso banco: um contrato de
escrita para chat, worker e revisão, reaproveitando a validação local já existente.
Origem, evidência, categoria, revisão e estado/validade de planos devem acompanhar
a gravação; indicação de mudança de personalidade encaminha ao perfil apenas
quando o turno atual a autoriza. Não exigir um comando “lembre” para fatos úteis.

O Hermes também distingue mutações de revisão desassistida; isso não obriga a
copiar suas telas de aprovação. A política do usuário e nossa correção automática
com evidência continuam prevalecendo.

**Aceitação:** “gosto de hotéis silenciosos” é lembrado; uma tarefa isolada não
vira hábito; “cancelei a viagem” atualiza o mesmo plano; fatos sem suporte são
recusados em todos os caminhos; nada disso muda SOUL. Repetir ensaios com modelos
reais: uma citação válida, sozinha, não prova que toda a frase derivada é verdadeira.

### 3. P1 — Carregar ferramentas nativas sob demanda

**Evidência local:** `engine/tanstack-agent.ts:279` registra todo o catálogo
disponível a cada requisição. A descoberta de Composio e o catálogo de skills já
são progressivos; a maioria das ferramentas nativas não é.

| Cenário isolado | Ferramentas enviadas | Schemas serializados | Requisição inteira |
| --- | ---: | ---: | ---: |
| Chat `Olá` | 78 | 60.304 bytes | 78.198 bytes |
| Primeiro dispatch do worker | 85 | 55.684 bytes | 74.528 bytes |

Esses números incluem ferramentas auxiliares do SDK e variam com conexões e
configuração. Bytes não equivalem a tokens faturados. O resultado mostra que o
catálogo domina essas requisições simples.

**Copiar/adaptar:** a ponte `search → describe → call` de
[Hermes tool_search](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/tool_search.py)
e o catálogo com busca lexical/ID exato de
[OpenClaw ToolSearchRuntime](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/agents/tool-search-runtime.ts).
Manter diretas as ferramentas necessárias para perguntar, concluir, delegar e
recuperar evidência; adiar schemas de capacidades especializadas. Invocação deve
continuar pelo dispatcher atual, conservando validação, journal e recibos.

**Aceitação:** medir redução de schemas no mesmo fixture e conferir descoberta
de PDF, navegador, email e computador. Ferramenta adiada continua descobrível;
carregar schema não concede conexão/permissão. Não prometer economia percentual
de latência antes de medir com o provedor.

### 4. P1 — Compactação que preserve o pedido e as restrições

**Evidência local:** `engine/context-budget.ts:352` preserva o último usuário,
mensagens de sistema e grupos ligados a operações obrigatórias. Depois inclui
histórico recente enquanto houver orçamento. Não produz resumo semântico.

No teste com 14 mensagens e orçamento reduzido, o pedido inicial com a restrição
“evitar voos noturnos” saiu da projeção; ficaram duas observações recentes e
“Pode continuar.”. O histórico canônico continua armazenado. O problema é o que
chega à próxima inferência. Workers também têm `task.prompt` fixo, portanto esse
ensaio não demonstra perda do pedido inicial em todo tipo de tarefa.

**Copiar/adaptar:** o contrato e as funções de qualidade de
[OpenClaw compaction-safeguard-quality](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/agents/agent-hooks/compaction-safeguard-quality.ts):
decisões, pendências, restrições, pedidos não resolvidos e identificadores exatos.
Usar também a referência de
[cancelamento da sumarização no Hermes](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/agent/context_compressor_summary.py).
Persistir um resumo versionado com referências ao intervalo resumido; validar o
texto final já limitado antes de substituir a projeção. Falha/cancelamento não
pode descartar o histórico ou confirmar um resumo incompleto.

**Aceitação:** uma conversa longa seguida de “continue” mantém restrições,
cancelamentos e trabalho pendente. Reinício após efeito externo confirmado não
o repete. Os pares chamada/resultado e recibos obrigatórios atuais permanecem
protegidos; um resumo não substitui a autoridade do journal.

### 5. P1 — Recuperação de histórico e memória por relevância

**Evidência local:** `db.ts:960,1036` busca substring literal e ordena por data.
`memory.ts:190` complementa palavras da pergunta com uma base limitada de fatos
recentes. Isso ajuda em contas pequenas, mas não equivale a busca semântica.
`search_past_threads` devolve trechos de até 500 caracteres, sem ferramenta
complementar para ler a vizinhança completa de uma mensagem.

**Copiar/adaptar:** o contrato de descoberta, leitura e navegação por mensagem do
[Hermes session_search_tool](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/session_search_tool.py),
incluindo prioridade para conversa humana sobre atividade automática e deduplicação
de linhagens. Implementar busca textual indexada no armazenamento existente;
avaliar busca híbrida do
[OpenClaw hybrid](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/extensions/memory-core/src/memory/hybrid.ts)
para sinônimos e idiomas diferentes, com recuperação da fonte original.

As funções de [MMR](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/extensions/memory-core/src/memory/mmr.ts)
reduzem resultados redundantes; o
[decaimento temporal](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/extensions/memory-core/src/memory/temporal-decay.ts)
separa notas datadas de conhecimento durável. Ambos são opções desativadas por
padrão nessa referência, não qualidades garantidas de toda instalação OpenClaw.
Validade/estado continua sendo filtro obrigatório antes do ranking: baixar o
score de uma viagem cancelada não basta. Preferência estável não deve desaparecer
só por ser antiga.

**Aceitação:** “aquela viagem” recupera plano e correção mesmo sem repetir a frase
original; cancelamento prevalece sobre a intenção antiga; rotinas repetidas não
dominam os resultados; só fontes do mesmo proprietário são retornadas.

### 6. P1/P2 — Heartbeat por eventos e cobertura explícita

**Evidência local:** `proactivity/service.ts:113,167,448,592` agenda pela última
revisão mais intervalo, com ciclo durável único. `proactivity/settings.ts` expõe
ativação e intervalo; não há janela de atividade por fuso. O padrão é quatro
horas. A revisão de email processa até oito threads por ciclo com cursor e expõe
cobertura parcial. Há seleção semântica, supressão de repetição, adiamento e
revalidação antes de publicar/agir.

`workspace.ts:123,158` consulta Gmail nativo e calendário `primary`. Ferramentas
Composio/MCP acessíveis ao chat não são automaticamente fontes do heartbeat.
Na aceitação anterior não havia conta de email/calendário conectada; essa é uma
constatação histórica, não uma nova inspeção da conta em produção.

**Copiar/adaptar:**
[OpenClaw heartbeat-wake-policy](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/infra/heartbeat-wake-policy.ts),
[session-event-wake](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/infra/session-event-wake.ts)
e [active-hours](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/infra/heartbeat-active-hours.ts).
Adicionar eventos direcionados de mudança de fonte, prazo próximo e tarefa
bloqueada, agrupados para evitar tempestade de revisões, conservando nosso ciclo
durável. O
[Gmail watcher](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/hooks/gmail-watcher.ts)
é referência concreta de observação por eventos, mas usa `gog`; a integração
deve usar nossas conexões, não iniciar um segundo gerenciador de contas.

Priorizar eventos/prazos e adapters de fontes autorizadas. Depois acrescentar
horário de silêncio com fuso e política explícita para urgências. Push já existe
em `push.ts`; não tratar notificação criada, aceita pelo provedor e lida pelo
usuário como o mesmo estado.

**Aceitação:** mensagem importante com prazo menor que quatro horas dispara
revisão oportuna; eventos duplicados produzem um alerta; alteração/cancelamento
antes da entrega retira a sugestão; fonte desconectada aparece como indisponível,
nunca como “nenhum email importante”. Não alertar novamente um plano encerrado.

### 7. P2 — Manutenção e avaliação dos procedimentos aprendidos

**Evidência local:** `playbooks.ts:19,37,109` oferece versões e exige tarefa
verificada/recibos bem-sucedidos para aprendizado. Protege procedimentos do
usuário. Porém `list_procedures` retorna todos os conteúdos, não há telemetria
dedicada de reutilização/qualidade e, após 30 versões, a orientação é criar outro
procedimento. Deduplicação por classe de tarefa depende principalmente do prompt.

**Copiar/adaptar:**
[Hermes skill_usage](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/skill_usage.py),
[curator](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/agent/curator.py)
e [skill_ledger](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/skill_ledger.py).
Registrar leitura, uso, revisão, origem e reutilização após correção; separar
procedimentos automáticos dos protegidos pelo usuário; arquivar reversivelmente
e permitir restauração de versão. No Hermes, consolidação por modelo é opt-in;
contagem de uso não prova sucesso.

Integrar esses sinais aos nossos resultados verificados é uma adaptação local.
Oferecer índice paginado e leitura de um método; aproveitar `SkillCatalog` já
existente em vez de injetar todos os textos. Fortalecer procedimento relacionado
em vez de acumular variantes. Falta de uso, sozinha, não prova que um método é ruim.

**Aceitação:** uma correção útil melhora o método existente; nova tarefa registra
qual versão usou e seu resultado; revisão ruim pode ser revertida; conteúdo do
usuário e SOUL permanecem fora da manutenção automática.

### 8. P2 — Prefixo estável para cache de prompt

**Evidência local:** `engine/tanstack-agent.ts:127,183` põe data/hora por execução
e contexto dinâmico antes das instruções estáveis. Isso encurta o prefixo comum
entre requisições. Não foi medido hit-rate, custo ou latência no provedor.

**Incorporar:** separar base estável e cauda dinâmica, inspirado na declaração
explícita de fronteira do
[Hermes prompt_cache_boundary](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/agent/prompt_cache_boundary.py).
O módulo é específico do planejamento de cache Anthropic; portar a organização,
não campos de protocolo incompatíveis. Manter ordem estável dos schemas e medir
tokens em cache/latência sem registrar conteúdo pessoal.

**Aceitação:** atualização de hora ou memória não muda os bytes da base estável;
o modelo continua recebendo a revisão atual; comparar uso real antes/depois.

### 9. P2 — Completar a detecção de ferramentas sem progresso

**Evidência local:** `engine/tool-progress.ts:25,76` calcula hash de todo o
resultado. Um timestamp diferente pode mascarar repetição. Já copiamos os
classificadores de sequências do OpenClaw; falta normalizar os recibos locais
de acordo com a ferramenta.

**Copiar/adaptar:** as projeções de status/saída, identidade de falha e polling em
[OpenClaw tool-loop-detection](https://github.com/openclaw/openclaw/blob/b56ae70a5e7e302dc2165c96b60214e84e19c7b1/src/agents/tool-loop-detection.ts).
Ignorar campos voláteis somente em contratos conhecidos; preservar o recibo
original no journal. Remover timestamps indiscriminadamente de qualquer
resultado pode esconder progresso real.

**Aceitação:** polling sem novidade, mesmo com timestamps novos, recebe limite;
nova saída ou nova causa de erro reinicia a avaliação; conclusão e recuperação
continuam disponíveis.

## Componentes que já existem e devem ser preservados

| Área revisada | Situação e decisão |
| --- | --- |
| Execução durável | Journal, operações, leases e reconciliação após restart já existem. Não substituir por um segundo loop upstream. |
| Retorno de tarefas | Delegação, tarefas filhas, `wait_for_children` e retorno ao pai já existem (`engine/service.ts:745,1842`). |
| Efeitos e ferramentas | Recibos obrigatórios, resultados limitados e leitura paginada já estão integrados. Preservar ao adiar schemas/compactar. |
| Provedores | Há roteamento por capacidade, fila, cooldown e fallback que distingue resposta aceita de tentativa rejeitada. Sem nova falha reproduzida nesta revisão que justifique reescrita. |
| Skills | Descoberta e leitura progressiva já existem. A lacuna principal está no ciclo de vida de procedimentos aprendidos. |
| Compromissos | A política `promised-work-prompt.ts` já foi copiada do OpenClaw. Não apresentar essa política como implementação ainda ausente. |
| Planos e lembretes | Cancelamento, resolução, esquecimento, validade e revisão de alvo já são persistidos. As mudanças devem ampliar cobertura, não enfraquecer esses filtros. |
| Notificações | Há entrega durável e adapters APNs/FCM. Eventos de heartbeat precisam usar esse caminho. |

Não há benefício demonstrado em trocar TanStack pelo runtime inteiro do Hermes
ou OpenClaw, migrar nosso banco para arquivos Markdown ou aumentar a janela de
contexto artificialmente. Priorizar as funções portáveis e seus testes; manter
atribuição e licença MIT nas cópias, como já fazemos em `third_party/`.

## Ordem de implementação recomendada

1. Fechar o contrato memória/SOUL: intenção natural autorizada e validação comum
   das gravações. Regressões de cancelamento, esquecimento e expiração primeiro.
2. Catálogo de ferramentas sob demanda e compactação validada. Medir novamente
   as requisições e a continuidade das tarefas.
3. Busca de histórico com leitura da fonte e eventos do heartbeat. Preservar
   a separação entre fonte indisponível, revisão sem alerta e notificação entregue.
4. Curadoria dos procedimentos, cache e normalização de progresso, com métricas
   de uso/resultado. Não medir aprendizado pelo número de memórias criadas.

## Verificação e limites

- Um ensaio diagnóstico isolado reproduziu tamanho do catálogo, gravação direta
  sem evidência, limitações do parser e perda do pedido inicial na projeção.
  Resultado: **1/1 aprovado como reprodução do comportamento atual**, não como
  comprovação de correção das lacunas. Script local em
  `artifacts/harness-audit/measure.test.ts`; resultados preservados em
  [harness-audit-measurements](2026-10-04-harness-audit-measurements.json).
- **37/37 testes de regressão passaram**, em `agent-profile`,
  `profile-personality`, `personal-learning`, `memory-context`,
  `proactivity-learning` e `playbooks`. Log local:
  `artifacts/harness-audit/regression.log`.
- Comando: `PATH=/home/marcos/.local/node/bin:$PATH taskset -c 0-3 pnpm exec tsx --test tests/agent-profile.test.ts tests/profile-personality.test.ts tests/personal-learning.test.ts tests/memory-context.test.ts tests/proactivity-learning.test.ts tests/playbooks.test.ts`.
- Não foram feitos deploy, alterações de perfil/memória real, envios externos
  nem nova avaliação com modelo conectado. A revisão não é benchmark comparativo
  dos três agentes e não demonstra ausência de todas as falhas possíveis.
