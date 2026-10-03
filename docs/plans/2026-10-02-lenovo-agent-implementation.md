# OkamiBot: VPS + Lenovo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar OkamiBot com personalidade configurável pela conversa, chat contínuo com quatro tarefas duráveis, sessão móvel persistente, computador gráfico Lenovo e fallbacks de modelos/navegador VPS.

**Architecture:** VPS mantém coordenação, banco e browser de reserva. Supervisor administrativo no Lenovo gerencia contas Linux nativas, desktops e jobs com recursos compartilhados; tarefas duráveis escolhem executor por capacidade e reconciliam efeitos antes de repetir. Sem VM/container para hospedar os bots.

**Tech Stack:** TypeScript/Hono, CopilotKit/AG-UI existente, PGlite/PostgreSQL, Expo 54, Playwright, Python, systemd/cgroups v2, nftables, TigerVNC/Xvnc, Xfce/X11, noVNC e Tailscale; versões compatíveis e fixadas no lockfile/manifests.

**Spec:** [Arquitetura e decisões](2026-10-02-lenovo-agent-design.md). Ler junto com [PLAN.md](../../PLAN.md). Base histórica `a9fe722`; o [status de execução](../IMPLEMENTATION-STATUS.md) registra o código integrado e o [aceite real](../DEPLOYMENT-ACCEPTANCE.md) registra implantação e pendências. Os checkboxes abaixo preservam o plano original, não representam o status atual.

**Adendo:** [Credenciais privadas sem licença paga](2026-10-02-private-credentials.md). Inclui marco 8: cofre/login/CAPTCHA usando os browsers Lenovo e VPS existentes. Não criar serviço adicional de browser. Composio não é dependência desta entrega; OpenBao self-hosted é o cofre proposto.

**Referência comparativa:** [OpenMausBot, commit caba9353](2026-10-02-openmausbot-review.md). Reutilizar conceitos e testes de comportamento nos marcos existentes; nenhuma migração de runtime nem dependência desse projeto. Código eventualmente adaptado mantém Apache-2.0/NOTICE e atribuição próprios, além dos avisos MIT do OpenMuse; excluir `enterprise/`.

**Referência adicional:** [Noodle, commit c733034](2026-10-02-noodle-review.md). Perfil/preferências, anotações, biblioteca de resultados e contratos de desktop inspiram refinamentos nos mesmos marcos. Não importar reinício do bot ao editar estilo, interrupção automática de tarefas ou arquitetura Apple. Nenhum código externo foi incorporado.

**Revisão upstream:** [Matriz dos 65 PRs abertos, com heads e decisões](2026-10-02-upstream-pr-review.md). Abaixo, as regressões selecionadas entram nos mesmos marcos. Não aplicar patches em lote; não reintroduzir dependências cloud, aprovação de toda escrita, bypass de acesso ou contratos antigos. Fixar o head aproveitado e manter atribuições MIT. A revisão estática original é distinta dos testes executados documentados no status.

## Global Constraints

- Uma usuária; manter MIT, avisos de dependências, demo e adapters existentes; não adicionar SaaS obrigatório.
- Marca prevista OkamiBot; conta Linux inicial `okami-bot`; nome/apelido do assistente e da usuária são campos independentes. Preservar IDs técnicos/dados/pacotes upstream; migração de marca não apaga sessões, cofre ou perfis.
- Até quatro unidades de trabalho background admitidas no total entre hosts. Chat tem admissão independente/prioritária.
- `waiting_job` libera somente vaga de inferência; filhos usam o mesmo teto e orçamento da árvore.
- Proposta inicial por provedor: até três inferências background e uma interativa, reduzidas pela quota real.
- Lenovo disponível 24/7 por Wi-Fi; contas Linux nativas com RAM compartilhada, sem teto fixo de 8 GB por conta. Teto agregado medido a partir de RAM utilizável menos margem inicial de 3–4 GiB; permitir job acima de 8 GB quando houver orçamento.
- Sudo restrito via helper com operações fixas é a recomendação. Se escolhido sudo amplo no host, registrar confiança total e ausência de garantia de contenção entre contas/rede/supervisor. Nenhum privilégio foi concedido/removido nesta etapa.
- Exatamente duas máquinas. Browser Lenovo no desktop da conta nativa e browser headless no VPS; cofre no VPS. Modelo recebe referências/status pelas ferramentas, mas o próprio UID pode acessar sua sessão/perfil mesmo sem sudo.
- Uma carga pesada por host inicialmente; cinco contas/sessões não significam cinco cargas pesadas nem alteram os quatro slots OpenMuse. Blender/Android Studio/emulador são exemplos futuros, sujeitos a GPU/RAM/aceleração reais.
- Pareamento sem expiração absoluta/inatividade por padrão; access token 15 minutos; refresh silencioso e revogação por aparelho.
- Aprovação live apenas para dinheiro; demo conserva sua política existente. Não alegar garantia semântica total sobre shell/GUI arbitrários.
- VPS com browser de reserva 2 GiB e conjunto de serviços abaixo do teto original 7 GB. Um escritor PGlite; nenhum volume DB pela rede.
- Estados externos incertos nunca recebem repetição automática. IDs/argumentos/recibos/checkpoints devem sobreviver a reinício.
- Conclusão exige evidência do resultado pedido; entregas parciais preservam pendências. Prazos, prioridade e orçamento são persistentes, sem cancelar trabalho apenas porque chegou outra mensagem.
- Pausa global é comando explícito da usuária, persistente e independente do modelo; bloqueia novos trabalhos/efeitos até retomada explícita, mantendo chat e inspeção disponíveis.
- Heartbeat proativo no VPS: revisão periódica de e-mails sem resposta, tarefas humanas incompletas e planos não iniciados, com intervalo proposto de 4 horas ajustável pelo chat. Usa os mesmos quatro slots, uma revisão em voo e chat prioritário; é distinto do heartbeat técnico do executor de 15 segundos. Sem horário de silêncio imposto por padrão.
- Um commit por marco abaixo, com documentação e `pnpm test` passando. Verificações de hardware/contas são separadas de testes com fixtures.

## Review Focus

- Crash entre rotação de credencial e gravação no celular: pareamento recupera sem nova chave. Cobertura no marco 1.
- Orientação concorrente com despacho: revisão antiga não despacha; efeito já despachado ganha um único recibo. Marco 4.
- Partição de rede com processo antigo vivo ou pausa global durante despacho: não afirmar contenção sem confirmação, nem retomar após restart ou criar duas escritas. Marcos 3, 6 e 9.
- Provider cai depois de tool call: novo modelo recebe checkpoint sem executar novamente o efeito. Marco 5.
- Queda no momento de assumir/devolver controle ou troca de executor: frame/lease antigo é rejeitado e tarefa correta retoma. Marcos 7 e 9.

Novos aceites nos marcos 4/6/11 também cobrem sucesso sem evidência, prazo vencido, restauração sobre edição humana e resposta de e-mail recebida entre revisão proativa e decisão da usuária.

## Convenções de execução e contratos compartilhados

Criar `packages/domain/src/runtime.ts` no primeiro marco que precisar dos contratos; estender `agent.ts` e `computer.ts` sem duplicar tipos existentes. As assinaturas abaixo são decisões propostas, não APIs presentes hoje.

```ts
type WorkClass = "interactive" | "background";
type ResourceRequest = { key: string; units: number; mode: "shared" | "exclusive" };
type ResourceLease = { id: string; fence: number; expiresAt: string };
type DirectiveReceipt = { id: string; taskId: string; seq: number;
  desiredRevision: number; status: "received" | "applied" | "completed_before_apply" };
type OperationStatus = "queued" | "dispatching" | "running" | "succeeded" |
  "failed" | "rejected_not_dispatched" | "superseded" | "outcome_unknown";
type OperationIntent = { id: string; taskId: string; revision: number;
  bindingHash: string; executorId: string; executorEpoch: number;
  resourceFence: number; status: OperationStatus };
type TaskCheckpoint = { taskId: string; appliedRevision: number;
  mailboxSeq: number; messages: unknown[]; pendingOperationIds: string[] };
type TaskTiming = { priority: "low" | "normal" | "high";
  dueAt?: string; validUntil?: string; timezone?: string };
type RuntimePauseState = { paused: boolean; revision: number; changedAt: string };
type CompletionAssessment = { status: "verified" | "partial" | "unverified";
  checks: { criterionId: string; passed: boolean; evidenceIds: string[] }[];
  remaining: string[] };
type ExecutorCapability = "browser.dom" | "browser.screenshot" |
  "browser.pointer" | "browser.drag" | "desktop" | "command" | "files" | "transcribe";
type ExecutorHello = { hostId: string; executorId: string; osAccountId: string;
  bootId: string; minProtocolVersion: number; maxProtocolVersion: number;
  capabilities: { name: ExecutorCapability; version: number }[] };
type ModelRequirements = { tools: boolean; vision: boolean;
  structuredOutput: boolean; contextTokens: number };
```

Validar envelopes e uniões de estados com Zod. Usar transação/CAS no Store para revisões e leases; não fingir atomicidade com writes independentes. `unknown[]` em checkpoint passa pelos tipos/validação AG-UI existentes. Não persistir chain-of-thought ou segredos. Negociar protocolo comum no registro e versões das capacidades independentemente da release do app; readiness é estado separado e só libera uso depois do preflight. Screenshot não implica pointer/drag; o router exige as capacidades concretas da operação. Versão incompatível gera diagnóstico e nenhum efeito externo.

`hostId` identifica o Lenovo físico; `osAccountId` aponta ao UID cadastrado pelo operador, nunca a usuário escolhido por argumento do modelo. Conta de site é identidade separada. Sessões gráficas recebem `desktopSessionId/sessionGeneration`. Leases de tela/perfil são por executor/sessão; memória, carga pesada e administração são por host. API de arquivos resolve seu workspace lógico ao diretório privado cadastrado da conta.

Cada marco segue teste de regressão → falha observada → implementação → teste focal → suíte/tipos → documentação/commit. Não inventar arquivos de teste vazios para cumprir o formato; testar comportamento/concorrência e falhas reais. Commits abaixo são títulos propostos.

## Marco 1: sessão durável e inicialização independente dos conectores

**Arquivos:** criar `apps/server/src/device-sessions.ts`, `apps/mobile/src/auth-manager.ts`, `credential-storage.native.ts`, `credential-storage.ts`; alterar `auth.ts`, `app.ts`, `workspace.ts`, `google-auth.ts`, `apps/mobile/App.tsx`, `api.ts`, uploads e manifests mobile. Testes novos `tests/device-sessions.test.ts`, `apps/mobile/test/auth-manager.test.ts`; ampliar `tests/oauth.test.ts`.

**Interfaces:** `DeviceSessions.pair(owner, deviceLabel)`, `refresh({deviceId, rotationId, currentToken, nextTokenHash})`, `revoke(owner, deviceId)`; `AuthManager.authorization(): Promise<string>`, `recoverExpiredSession(): Promise<void>`, `subscribe(listener)`. Rotas `/api/session/refresh`, `/api/devices`, `/api/devices/:id/revoke`; access-key atual continua servindo ao pareamento e demo.

**Integração upstream e regressões do marco 1:**

- [ ] Integrar regressões upstream #125/#48: publicação completa/atômica da chave de assinatura no primeiro start, mantendo chave existente e permissões; validar números, CORS e URL pública sem userinfo/query/hash. Não abrir dois escritores PGlite para testar concorrência da chave; isolar o helper. Preservar validadores novos do fork e decidir suporte a subpath explicitamente.
- [ ] Unificar erros tipados com o parser tolerante de #95: HTML/texto vazio/502 não viram logout nem SyntaxError sem diagnóstico. #87 é referência de problema, não implementação: não guardar refresh web em localStorage, não deixar nativo somente em memória e não deslogar por qualquer 401. Conservar runner local de #94 e chave forte; não importar OPENMUSE_SKIP_ACCESS_KEY de #93.
- [ ] Adaptar leituras Google de #24 com backoff/jitter, Retry-After, cancelamento e orçamento total limitado; distinguir rate-limit de permissão e não repetir mutações com resultado incerto. #110 deve consultar apenas a seção solicitada; teste de files funciona com Google indisponível e não chama mail/calendar. Casos MIME/calendário detalhados no M11 não podem voltar a bloquear abertura do app.

- [ ] Escrever testes com relógio falso: access 15 min, 48 h/30 dias de uso sem parear, revogação só do aparelho escolhido, dez 401 simultâneos geram um refresh, 401 do Google não altera sessão OpenMuse.
- [ ] Testar resposta de rotação perdida e crash em cada fronteira. Cliente grava sucessor e rotationId antes de enviar; servidor CAS/recibo vinculado torna repetição idempotente. Recuperação tenta o estado pendente sem revogar sessões por corrida legítima. Guardar somente hashes/recibos sem tokens em logs.
- [ ] Distinguir armazenamento nativo temporariamente inacessível, credencial ausente e revogação confirmada; testar celular bloqueado/reiniciado sem apagar pareamento em erro transitório.
- [ ] Implementar credencial pequena no SecureStore compatível com Expo 54, sem biometria obrigatória no refresh. Web usa cookie HttpOnly/Secure e proteção origem/CSRF: servidor gera o sucessor e mantém recibo cifrado de rotação para recuperar resposta perdida; não expor refresh ao JavaScript nem aplicar o protocolo nativo literalmente ao cookie. Restaurar identidade estável, renovar headers de REST/CopilotKit/upload sem desmontar drafts.
- [ ] Separar snapshot essencial de Gmail/Calendar; testar Google revogado e indisponível com chat/arquivos/tela de reconexão acessíveis. Cache e rascunhos permanecem durante falha de rede.
- [ ] Rodar `pnpm exec tsx --test tests/device-sessions.test.ts apps/mobile/test/auth-manager.test.ts tests/oauth.test.ts`, depois `pnpm test` e `pnpm typecheck`; atualizar docs e commit `fix: persist device sessions and isolate connector failures`.

## Marco 2: conversa independente e personalidade pelo chat

**Arquivos:** criar `apps/server/src/conversation-inbox.ts`, `interaction-requests.ts`, `apps/mobile/src/message-outbox.ts`, `message-storage.native.ts`, `message-storage.ts`, `interaction-card.tsx`; alterar `threads.ts`, `db.ts`, `app.ts`, `engine/conversation.ts`, `chat.tsx`, `conversation-queue.ts`, `threads.tsx`; testes `tests/conversation-inbox.test.ts`, `tests/interaction-requests.test.ts`, `apps/mobile/test/message-outbox.test.ts`, `apps/mobile/test/interaction-card.test.ts`, ampliar `tests/local-threads.test.ts`.

**Perfil:** criar `apps/server/src/agent-profile.ts`, `profile-context.ts` e `tests/agent-profile.test.ts`; ampliar tipos de identidade em `packages/domain/src/agent.ts`, `personal-tools.ts`, `engine/{model,service,routes}.ts` e configurações móveis em `agent-ui.tsx`. Centralizar marca/defaults novos em módulo pequeno, preservando caminhos/pacotes upstream e perfis existentes. O prompt direto hoje fixa OpenMuse e o de tarefas lê nome/tom: ambos devem usar o mesmo construtor.

**Interfaces:** `acceptMessage(owner, {threadId, clientMessageId, contentHash, text, attachmentIds, targetTaskId?}) -> {messageId, runId, duplicate}`; `eventsAfter(owner, threadId, cursor) -> {events, nextCursor, snapshotRequired}`. Outbox persiste mensagem antes de enviar. CopilotKit continua protocolo de resposta; criação do trabalho passa pela aceitação idempotente.

`InteractionRequests.create({taskId, revision, kind, schema})`, `answer(owner, requestId, {clientResponseId, revision, answer})`, `status(owner, requestId)`; kind question/credential/oauth/approval conforme adendo. Criar/renderizar perguntas neste marco, ligadas ao input de tarefa existente; backend de credenciais é habilitado somente no marco 8. Rotas de resposta comum rejeitam payload de segredo; schema de credencial vem de adapter confiável.

`AgentProfile.get(owner, threadId?)`, `update(owner, {scope, patch, expectedRevision, requestId, origin})`, `reset(owner, {scope, expectedRevision, requestId, origin})`. Scope é `{kind: "global"} | {kind: "conversation", threadId: string}`; origin é `{kind: "chat", messageId: string} | {kind: "settings"}`, atribuído/validado pelo servidor conforme o canal autenticado, não pelo modelo. `expectedRevision` corresponde ao registro do escopo alterado; leitura efetiva retorna perfil composto e revisões global/conversa. Campos validados: nome do assistente, nome preferido da usuária, idioma, tom/formalidade, tamanho de resposta, humor, emojis e estilo textual limitado. Ferramentas `get_agent_profile`/`update_agent_profile` traduzem pedidos da usuária; servidor vincula origem/autoria reais e não aceita owner/política/permissões no patch. Edição na UI usa o mesmo CAS/idempotência. Instrução pontual de uma tarefa fica na tarefa, sem write de perfil.

**Integração upstream e regressões do marco 2:**

- [ ] Portar cenários #54/#59 para replay por runId/cursor/origem: erro histórico não desabilita composer, erro live continua visível e lock de turno não perde mensagem aceita. Chat/steering entram na inbox durante tarefa longa; não aguardar o término dessa tarefa para admitir mensagem. Preservar publicação/reconexão de rotinas do fork.
- [ ] Extrair identidade de #68 no construtor compartilhado, mantendo memory.context limitado já existente. Integrar correção do menu #124, datas futuras #100 com locale do perfil e recuperação de drafts #99 sem sobrescrever resposta recente. Testar menu e composer com teclado; registrar a issue Android #128 para aceite físico no M11/M12, sem afirmar reprodução prévia.

- [ ] Testar perda de ACK e retry/restart: uma mensagem aceita e uma tarefa criada; mesmo ID com payload diferente retorna conflito. Evento/cursor local gravado atomicamente, replay não duplica cartões.
- [ ] Testar duas mensagens offline independentes e ACK perdido antes de resposta posterior: conservar toda a fila, não só a última mensagem. Falha ao persistir outbox deve aparecer antes de afirmar envio durável. Snapshot + assinatura concorrentes não perdem evento; orientar tarefa concluída informa estado e não repete execução.
- [ ] Mover trabalho demorado/mutável do turno direto para tarefas duráveis existentes; resposta curta confirma taskId. Testar mensagem nova, encerramento do app e Stop da resposta sem chamar abort da tarefa. Cancelamento de tarefa permanece explícito.
- [ ] Manter Enviar disponível, restaurar rascunho/anexos/outbox e reconectar em AppState/rede/push. Novo envelope com targetTaskId permite futura orientação sem esperar terminar uma resposta longa.
- [ ] Renderizar perguntas inline com escolha única/múltipla/texto livre, campos e botão de envio como a referência do usuário; testar acessibilidade/teclado, duplo toque, resposta atrasada e reabertura. Uma tarefa aguardando cartão não bloqueia chat nem outras. Pergunta genérica não aprova ação financeira; nunca executar HTML/JS gerado pelo modelo.
- [ ] Implementar perfil persistente e migração do name/tone existente sem sobrescrever nome escolhido. Pedidos como “me chame de Ana”, “seu nome é Luna” e “responda curto, em português, sem emojis” confirmam apenas campos gravados. Testar perfil global versus override de conversa e instrução apenas para um e-mail; restaurar padrão não apaga memória/conexões.
- [ ] Usar contexto compartilhado em chat, tarefas e rotinas; tarefa preserva thread de origem. Verificar aplicação após restart/troca de provedor com fixtures, conflito entre edição móvel/chat e retry idempotente. Mudança de estilo entra na próxima resposta/ponto seguro sem cancelar trabalho; quatro tarefas ativas são verificadas na integração do marco 3. Fonte externa não pode mudar perfil, e estilo não altera revisão financeira ou privilégios.
- [ ] Prever referências tipadas a mensagem/anexo/frame e comentário separado de citação para anotações do marco 11, sem executar coordenadas como ações. Não persistir segredo nesse envelope.
- [ ] Executar focais com `pnpm exec tsx --test tests/conversation-inbox.test.ts tests/local-threads.test.ts tests/agent-profile.test.ts tests/interaction-requests.test.ts apps/mobile/test/message-outbox.test.ts apps/mobile/test/interaction-card.test.ts`, suíte/tipos; commit `feat: add durable chat and conversational agent profiles`.

## Marco 3: quatro slots, prioridade, pausa global e leases de recursos

**Arquivos:** criar `apps/server/src/engine/resource-leases.ts`, `work-admission.ts`, `runtime-pause.ts`; alterar `worker.ts`, `routes.ts`, `db.ts`, `config.ts`, `computer-rpc.ts`, tipos de tarefas e controles em `apps/mobile/src/agent-ui.tsx`; criar `tests/task-concurrency.test.ts`, `tests/resource-leases.test.ts`, `tests/runtime-pause.test.ts`, ampliar `tests/computer-open.test.ts`.

**Interfaces:** `WorkAdmission.claim(taskId, class, rootTaskId)`, `release(taskId)`; `ResourceLeases.acquire(owner, taskId, requests): Promise<ResourceLease[] | null>`, `renew(lease)`, `release(lease)`. Contadores globais incluem filhos e jobs em andamento; waiting_job não solta vaga de trabalho. `work-admission.ts` não é limite de inferência por provedor, que entra no marco 5.

`RuntimePause.get(owner) -> RuntimePauseState`, `set(owner, {paused, expectedRevision}) -> RuntimePauseState`; estado autoritativo no VPS. Admissão/despacho conferem sua revisão, propagada aos executores no marco 6. Prioridade e prazo usam o contrato compartilhado `TaskTiming`, cuja edição pelo chat é ampliada no marco 4: reordenar trabalho elegível sem interromper operação despachada, com envelhecimento da fila para evitar espera indefinida de prioridade baixa.

**Integração upstream e regressões do marco 3:**

- [ ] Adaptar #74 ao scheduler atual: preencher vaga durante tarefa longa preservando pendingTicks, allSettled, drainFailed e erros de persistência/shutdown. Os quatro slots e leases são duráveis e globais, não o cap em memória do PR. #107/#108 podem reduzir leitura de histórico, mas COUNT antes de INSERT não substitui admissão atômica nem pausa de goal concorrente com criação de filha.

- [ ] Reproduzir job longo bloqueando a rodada atual. Testar quatro tarefas admitidas, quinta aguarda e vaga liberada é preenchida antes de terminar outras três. Chat continua aceitando/respondendo fora desses slots.
- [ ] Testar prioridade alterada pelo chat, duas tarefas com prazo e espera prolongada de prioridade baixa: aplicar ordem no próximo claim, conservar quatro slots/leases e não cancelar jobs em curso. Uma tarefa urgente não amplia quota nem toma desktop ocupado.
- [ ] Implementar botão/comando explícito de pausa global e retomada, sem depender de inferência para o controle do app. Persistir antes de confirmar; testar pausa concorrente com claim/despacho, repetição do comando e restart. Bloquear novos trabalhos, continuações, rotinas, revisão proativa e efeitos de ferramentas inclusive chamadas pelo chat; conversa, consultas de estado e recuperação continuam disponíveis.
- [ ] Mostrar pausa solicitada, confirmação por executor e operações ainda em curso/incertas. Retomar exige pedido explícito, não simples mensagem nova ou conexão recuperada, e não reativa tarefas com pausa individual anterior. Testar essas pausas sobrepostas. No adapter local aplicar o mesmo gate; o marco 6 acrescenta contenção remota. Pedido já aceito por provedor/serviço externo não ganha promessa de cancelamento retroativo.
- [ ] Testar ocupação de desktop/perfil, escrita compartilhada, heavy=1, pai/filhos sem ultrapassar quatro; lease expirado não autoriza despacho com fence antigo.
- [ ] Alterar apelido/tom com quatro tarefas admitidas: nenhum cancelamento/reinício, nenhuma repetição de efeito e aplicação no próximo ponto seguro sem sobrepor instrução específica da tarefa.
- [ ] Vincular heavy/admin ao host físico, não ao executor lógico: cinco contas no mesmo Lenovo não geram cinco vagas pesadas. Admitir conforme orçamento de memória/pressão informado pelo supervisor; novos trabalhos aguardam recursos sem cancelar os existentes.
- [ ] Fazer claim de desktop/perfil apenas ao primeiro uso necessário; testar consulta de API/arquivo com tela ocupada por outra tarefa. Se executor cair antes do primeiro uso, emitir indisponibilidade recuperável, sem confundir com contenção nem manter espera infinita.
- [ ] Liberar seção crítica de claim antes de aguardar execução, acompanhar promises/heartbeats individualmente e consultar tarefas elegíveis por status/horário indexados em vez de scan de todo histórico.
- [ ] Separar rejeição explícita `busy/not_dispatched` de timeout após envio. Retry da mesma intenção rejeitada funciona; outcome desconhecido continua bloqueado. Manter runtime legado com um job até runtime novo do marco 6, sem aumentar seu limite artificialmente.
- [ ] Rodar focais, `pnpm test`, `pnpm typecheck`; commit `fix: schedule four independent tasks with resource leases`.

## Marco 4: orientação, journal, conclusão verificável e prazos

**Arquivos:** criar `engine/task-mailbox.ts`, `task-journal.ts`, `task-actor.ts`, `task-verification.ts`, `task-timing.ts`; alterar `engine/model.ts`, `service.ts`, `routes.ts`, `browser-history.ts`, `computer-tools.ts`, integrações MCP, `routines.ts`, `agent-ui.tsx` e `chat.tsx`; testes novos `tests/task-steering.test.ts`, `task-recovery.test.ts`, `task-verification.test.ts`, `task-timing.test.ts`.

**Interfaces:** `TaskMailbox.enqueue(owner, taskId, {clientMessageId, text, expectedRevision?}): Promise<DirectiveReceipt>`; `TaskJournal.prepare(intent)`, `authorizeDispatch(operationId, expectedRevision, fence)`, `recordReceipt(operationId, receipt)`, `checkpoint(taskId)`; `TaskActor.wake(taskId, reason)`. Rotas `POST /api/agent/tasks/:id/directives` no prefixo real de engine routes, preservando os endpoints existentes.

`TaskVerification.assess(taskId, revision) -> CompletionAssessment` consome critérios persistidos e referências a artefatos/recibos/observações; `TaskTiming.update(owner, taskId, {expectedRevision, priority?, dueAt?, validUntil?, timezone?})` altera metadados de agenda sem apagar execução. `dueAt` é a meta desejada; `validUntil` é o limite obrigatório para despachar o efeito pedido. Ambos são distintos do timeout técnico e do orçamento acumulado da árvore; “gostaria pronto às 16 h” não equivale a “só envie antes das 16 h”.

**Integração upstream e regressões do marco 4:**

- [ ] Portar #81: após finish_task/ask_user/revisão financeira pendente, nenhuma inferência extra perde o outcome se o provedor falhar; drenar operações já despachadas. Escrita autônoma concluída pode continuar normalmente. #119/#101 já têm guardas no fork: acrescentar regressões dos interleavings sem alterar audit nem tratar steering como cancelamento.
- [ ] Adaptar #120 com causa tipada de abort e estado/revisão autoritativos: takeover/falha de heartbeat não negam revisão financeira válida como se fossem cancelamento humano. Propagar #31 apenas para cancelamento explícito/perda de lease; timeout/abort HTTP não libera recurso remoto sem confirmação/recibo.
- [ ] Compor #45/#112 com operationId anterior ao efeito: testar dois imports, crash após arquivo publicado antes de mapping/checkpoint, retry da mesma intenção e nova intenção com argumentos iguais. Ampliar #43 com origem, versão e horário real de aquisição; materializar evidência em memória não a torna recente. Validar datas impossíveis (#71) e CSV financeiro ambíguo (#69/#114) antes de qualquer interpretação/despacho dependente.

- [ ] Testar orientação durante leitura/job, antes da transação de despacho, depois do despacho e imediatamente após conclusão. Exigir recibos received/applied, revisão correta e nenhuma repetição de efeito.
- [ ] Expor no cartão fila, recebido e aplicado; distinguir entrega recusada antes do envio de entrega incerta após possível aceitação. Testar perda de ACK/reconexão sem duplicar orientação. Não implementar steering matando processo ou cancelando tarefa; controles móveis explícitos selecionam o alvo.
- [ ] Testar dois alvos plausíveis: perguntar sem pausar tarefas. Mudança de destinatário/valor invalida apenas aprovação pendente correspondente. Demo/política live continuam intactas.
- [ ] Persistir IDs/argumentos/checkpoints server-side; reconstruir histórico de ferramentas computer/media/MCP e browser após reinício. Resultado incerto continua pendente, nunca recebe operationId novo como retry automático.
- [ ] Transformar limite de passos em continuação com orçamento finito; wake-up por job/recurso/orientação. Testar background job longo sem “continue” e rotina bloqueada com aviso/retomada sem perder silenciosamente todas as ocorrências futuras. Pai libera slot para filhos conforme contrato do marco 3.
- [ ] Registrar critérios proporcionais ao pedido antes de concluir: documento abre e contém itens pedidos; arquivo entregue tem versão/ACK; escrita externa tem recibo ou estado observado. `finish_task` só marca sucesso quando a avaliação é verificada; não marcar automaticamente todos os passos como feitos. Testar resumo convincente sem arquivo, arquivo vazio/inválido, recibo ausente e observação antiga após orientação. Não exigir segundo modelo avaliador para toda tarefa.
- [ ] Publicar entregas parciais com artefatos úteis, critérios satisfeitos, pendências e impedimento, sem alegar sucesso completo. Testar falta de ferramenta, orçamento esgotado e prazo ultrapassado preservando resultado e estado recuperável; trabalho incerto continua em reconciliação. Acrescentar pequeno conjunto de tarefas representativas cuja saída seja conferida fora do texto final do modelo.
- [ ] Aceitar prazo/prioridade pelo chat e cartões, persistindo fuso e revisão; pedir esclarecimento somente quando a data for ambígua. Testar alteração concorrente, restart, prazo vencido durante job e indisponibilidade do provedor. Mostrar atraso e entrega parcial quando existir, sem prometer duração, reiniciar orçamento no fallback ou cancelar efeito já despachado; orçamento esgotado exige decisão explícita para ampliá-lo.
- [ ] Validar `validUntil` na barreira de despacho junto de revisão, pausa e lease, inclusive após espera por recurso, restart e fallback de modelo/executor. Testar meta `dueAt` vencida permitindo continuidade autorizada versus validade obrigatória vencida impedindo novo envio. Preservar trabalho/rascunho e explicar expiração; requisição já despachada conserva recibo/incerteza, sem alegar desfazimento retroativo.
- [ ] Rodar focais e `tests/model-worker.test.ts`, `tests/routines-integration.test.ts`, suíte/tipos; commit `feat: steer and resume durable tasks from operation journals`.

## Marco 5: fallback de modelos por capacidade e prioridade

**Arquivos:** criar `providers/model-router.ts`, `provider-health.ts`, `model-capabilities.ts`; alterar `providers/models.ts`, `errors.ts`, `config.ts`, `engine/tanstack-agent.ts`, modelos e UI de status; testes `tests/provider-routing.test.ts` e atuais `model-provider.test.ts`/`subscription-auth.test.ts`.

**Interfaces:** `ModelRouter.select({workClass, requirements, excludedModels}): Promise<ModelLease>`; `release(lease, outcome)`; `ProviderHealth.report(model, failure)`; capacidades por modelo validadas em configuração/preflight. `ModelLease` vincula modelo e permissão de inferência; não autoriza efeito externo.

**Integração upstream e regressões do marco 5:**

- [ ] Usar cenários #80/#93 para loop streaming de tool sem argumentos, IDs/replay e falha no segundo turno em gateways; manter Chat Completions/Responses selecionados por rota e capacidades já existentes. Não adicionar flag global de API/reasoning_effort nem bypass de acesso. Variáveis Anthropic/Google de #79 já existem: conservar documentação/normalização e testar o router sem duplicá-las.

- [ ] Testar primário 429/5xx/timeout → xAI → MiMo, respeitando Retry-After/cooldown; imagem obrigatória exclui modelo sem visão e contexto excedido exclui candidato sem espaço. Se nenhum candidato servir, preservar tarefa e reportar capacidade insuficiente. Compactação automática entra no marco 10; não remover dados silenciosamente.
- [ ] Testar prioridade do chat com três chamadas background pendentes e quota inferior; número real de calls obedece limite configurado/observado. Centralizar retry/deadline, sem multiplicar tentativas de SDK e router.
- [ ] Preservar fallback pré-aceitação atual; testar stream parcial, tool call fragmentado e tool já concluída. Continuação usa checkpoint/recibos do marco 4 e não repete efeito. Todos indisponíveis preservam tarefa em waiting_provider.
- [ ] Validar rotas de assinatura e API separadas, no áudio via ChatGPT, ausência de upgrade silencioso para billing; mensagens de limite em português/status discreto sem deslogar.
- [ ] Mostrar provedor ativo, fallback ocorrido e motivo recuperável de indisponibilidade; falha de uma conexão/modelo não desmonta as demais. A UI mostra status/configuração pública, nunca chave/token.
- [ ] Rodar focais, suíte/tipos; documentar configuração e commit `feat: route model calls with capability-aware failover`.

## Marco 6: supervisor Lenovo e usuários Linux nativos

**Arquivos:** criar `apps/server/src/executors/{registry,protocol,routes,remote-computer,host-resources}.ts`, `apps/server/src/file-versions.ts`, `apps/computer/executor/{supervisor,user_session,job_runtime,files,file_versions,admin_helper}.py`, `apps/computer/deployment/{users,firewall,systemd}/`; ampliar `computer-contract.ts`, `computer-rpc.ts`, `config.ts`, `db.ts` e UI de arquivos em `apps/mobile/src/agent-ui.tsx`; testes `tests/remote-executor.test.ts`, `tests/executor-network.test.ts`, `tests/native-user-resources.test.ts`, `tests/file-versions.test.ts` e contratos Python.

**Interfaces:** `ExecutorRegistry.register(hello) -> {epoch}`, `heartbeat(executorId, epoch)`, `claimOperations(executorId, epoch)`, `submitReceipt(executorId, epoch, operationId, sequence, receipt)`, `reconcile(executorId, manifest)`. `RemoteComputerBackend` implementa ComputerBackend; credencial do nó só acessa rotas deste executor. Operações/recibos usam contratos dos marcos 3/4.

`HostResources.snapshot(hostId) -> {memoryTotalBytes, memoryAvailableBytes, botsCurrentBytes, botsHighBytes, botsMaxBytes, pressure, heavyOwner}`; `UserSession.start/stop(executorId)` só opera UID/unidades pré-cadastrados. Helper propõe `ensureApp(appId)` para catálogo root-owned de receitas fixas e manutenção de serviços do próprio executor; não recebe shell, pacote/URL arbitrários, ambiente root editável ou unidade arbitrária. Supervisor/chaves ficam fora do home e da slice dos bots.

`FileVersions.capture(taskId, artifactId, expectedVersion) -> versionId`, `trash(taskId, artifactId, expectedVersion) -> trashId`, `restore(owner, versionId, expectedCurrentVersion) -> artifactId`; conteúdo fica no executor de origem, com publicação/backup conforme contrato de arquivos, e metadados/journal no VPS. Restauração cria nova versão; conflito pode restaurar como cópia, sem sobrescrever edição posterior silenciosamente.

**Integração upstream e regressões do marco 6:**

- [ ] Portar invariantes de #111 para supervisor nativo: receipt terminal/interrompido não é sobrescrito por snapshot antigo e comando vencido não inicia. Conferência antes de exec não substitui fence/epoch. Compor #47 com IDs seguros compatíveis com UUID/hash, MIME e anexos .bin/PDF existentes; não importar validação que quebre arquivos idempotentes ou presuma que todo arquivo é PDF.

- [ ] Testar registro/boot novo/epoch antigo, recibo repetido/fora de ordem, ACK perdido e comando incerto. Simular suspensão/relógio e impedir novo efeito antes de handshake/reconciliação. Testar watchdog com processo antigo ainda vivo.
- [ ] Negociar faixa de protocolo/capacidades e separar suporte de prontidão. Testar VPS novo com executor anterior compatível, capability ausente, campo novo com default e alteração semântica incompatível: atualizar com mensagem específica sem despachar efeito. Guardar fixtures de wire protocol.
- [ ] Implementar pull/long-poll via Tailscale no supervisor, journal local e publicação de artefato com hash/versão/ACK. Criar `okami-bot` com home/workspace privado, sem DB remoto, chave administrativa, sockets privilegiados ou acesso aos homes das outras contas. Não abrir shell administrativo por RPC.
- [ ] Transferências usam staging, progresso, cancelamento e publicação exclusiva/nova versão. Testar interrupção Wi-Fi, symlink/path trocado durante cópia, origem modificada, arquivo já existente e cancelamento antes do publish; só anunciar artefato após hash/ACK. Browser recebe artifactId autorizado, sem caminho arbitrário.
- [ ] Preservar versão anterior antes de edição/substituição pelas ferramentas controladas e usar lixeira para exclusões recuperáveis; preferir cópia de trabalho em aplicativos gráficos. Testar edição errada, exclusão, crash entre captura/mutação, disco insuficiente e restauração com versão humana posterior. Expor recuperar pelo chat/app, retenção e limite de espaço explícitos; não prometer desfazer shell/GUI arbitrários ou efeito externo, nem substituir backup por lixeira.
- [ ] Publicar prontidão de conta/runtime/display/captura/input/browser e pressão de recursos, independente do heartbeat. Testar conectado sem display, driver incompatível e browser iniciando; sonda de input age numa janela de teste da própria sessão.
- [ ] Implementar slice agregada dos bots e subgrupos por conta/job com CPUWeight/IOWeight/TasksMax, MemoryHigh e MemoryMax calibráveis. Sem reserva por usuário ou teto fixo de 8 GB. Incluir desktop/browser/D-Bus/builds/descendentes antes do lançamento; auditar `/proc/PID/cgroup` e tentativas via SSH/login/cron/user-manager que escapem do ancestral. Supervisor permanece fora do limite dos bots.
- [ ] Testar job acima de 8 GB dentro do orçamento agregado, outras contas ociosas e fila de segunda carga pesada. Simular pressão/OOM de um serviço de job sem matar todo o desktop/frota; registrar falha e não repetir automaticamente efeito incerto. Congelar não é liberar RAM; não contar swap como RAM disponível para admissão.
- [ ] Prover política nftables por UID no host para IPv4/IPv6, destinos locais/privados/tailnet/metadata, DNS e exceções cadastradas. Testar shell/browser/auxiliares e proxy/socket local; proteger IPC por permissões próprias. Nenhum grupo sudo/Docker/input amplo no modo recomendado. Se habilitar sudo amplo explicitamente na configuração, expor limite de confiança e desabilitar suposição de contenção para failover mutável.
- [ ] Runtime de jobs separado do desktop, sem sweep por UID; cancelar só cgroup do job. Watchdog inicia com gate fechado, revoga egress/entrada no vencimento e confirma contenção; suspensão fecha gate antes de dormir, revalida ao voltar e usa relógio que inclua suspensão. Quarentena se não confirmar; não derrubar conta administradora ou outras contas.
- [ ] Aplicar pausa global do marco 3 no Lenovo e no browser VPS: bloquear novas ações, recolher recibos em curso e parar/congelar trabalhos gerenciados no ponto seguro, sem afetar outros usuários. ACK de contenção identifica revisão/epoch e não inventa cancelamento de requisição externa enviada. Testar executor offline, pausa durante job/GUI, suspensão, restart com pausa ativa e retomada explícita; congelamento conserva RAM/slot enquanto o job existir, e sudo amplo mantém o limite de confiança documentado.
- [ ] Executar contratos sem hardware, suíte/tipos. Em Lenovo autorizado/disponível, verificar usuários/permissões/cgroups/firewall/recuperação e contabilização real; múltiplas contas de ensaio não precisam permanecer instaladas. Docs e commit `feat: execute computer jobs under managed native Linux users`.

## Marco 7: desktop gráfico e controle compartilhado

**Arquivos:** criar `apps/computer/desktop/{session,driver}.py`, `apps/server/src/desktop-{contract,service,tools,routes}.ts`, `apps/mobile/src/desktop.tsx`; alterar worker browser/server, server browser/contracts, conversation/model tools, computer UI; testes `tests/desktop-control.test.ts`, `apps/worker/tests/desktop.test.ts`.

**Interfaces:** `observe(sessionId) -> {sessionGeneration, frameId, width, height, image, windows}`; `act(sessionId, {sessionGeneration, frameId, fence, action})`; `takeControl(sessionId, deviceId)`, `releaseControl(sessionId, deviceId)`; actions: click/doubleClick/drag/type/press/scroll/focus. Desktop e Playwright compartilham os leases do marco 3; DISPLAY/XAUTHORITY/D-Bus vêm do cadastro confiável da conta, não do modelo.

**Integração upstream e regressões do marco 7:**

- [ ] Adaptar #131/#127: limpar apenas downloads não publicados após crash, manter falha de limpeza recuperável e preservar publicados. Usar fixtures HTTP/PDF locais controladas com Chromium real para lifecycle/restart/SSRF; transporte de teste não é flag de produção. Acrescentar HTTPS/CONNECT e arquivo/mapping recuperáveis (#112/#45), além do que as fixtures upstream cobrem.
- [ ] Implementar SearchBackend/search_web independente inspirado em #84: descobrir fontes por consulta, retornar título/URL/trecho/data quando disponível, limites/truncamento/proveniência e erro/cancelamento explícitos. Adapter usa o browser existente com seus leases ou MCP autorizado já configurado; Parallel não é dependência padrão. Testes com páginas/servidor MCP sintéticos e cartão de fontes no M11; resultado não equivale à leitura integral de cada página.
- [ ] Extrair de #133 prontidão real de X11/Xfce, recuperação de modificadores e observações visuais transitórias, preservando nosso frame/fence/intenção antes do efeito e controle humano pelo mesmo lease. Não integrar E2B nem registrar texto secreto em recibos. Aplicar #102 na entrada de endereço sem relaxar SSRF; adaptar #77 a rótulos acessíveis por executor/estado/controle.

- [ ] Testar frames antigos, coordenadas/dimensões, takeover durante ação, desconexão do celular e handback. Reserva humana bloqueia GUI/DOM conflitantes, não tarefas independentes; handback acorda a tarefa correta.
- [ ] Testar rede lenta com cliente atrasado, reconexão durante drag e modificador preso: descartar frames obsoletos, manter imagem atual, resetar teclas/botões na perda de posse/conexão/foco. Preview somente de observação não reserva input; não acumular vídeo ilimitado nem prometer FPS sem ensaio.
- [ ] Servir viewer confiável do app e trafegar protocolo de tela/entrada até socket Unix privado por conta, sem TCP público no Xvnc. Não executar HTML/JavaScript fornecido pelo bot com sessão administrativa do app nem encaminhar cookies/tokens. Testar destino, origem, lease/epoch e revogação; teclado Unicode, reconexão e clique após zoom. Loopback sozinho não isola contas.
- [ ] Instalar Xvnc/Xfce por conta nativa e Chromium headed no DISPLAY correspondente, compartilhado por Playwright e pessoa, com CDP pipe e perfil exclusivo. Reusar browser headless VPS. Preservar licenças TigerVNC/noVNC e MIT; validar sandbox Chromium/AppArmor sem desligar proteção global. O marco 8 acrescenta login nesse mesmo browser.
- [ ] Testar sessões distintas sem cruzar teclado/captura/clipboard/cookies, disconnect sem logout e reinício de uma sessão incrementando geração sem matar jobs independentes/outras contas. Exercitar até cinco sessões leves na aceitação, medindo consumo; não iniciar cinco browsers permanentemente por padrão. Render node/GPU/KVM para programas futuros exigem capacidade e teste específico.
- [ ] Adicionar ferramentas e cards; verificar ciclo observar→agir→observar e conclusão por evidência. Modelos sem visão não recebem tarefa visual.
- [ ] Criar política de observação por DOM/visão/recorte e deduplicação de imagem idêntica com captura sempre atual. Testar mudança assíncrona sem clique, frameId renovado, takeover/navegação invalidando referências e segredo mascarado antes do payload. Medir tamanho/imagens enviadas e verificações; não introduzir DOM-cache como substituto de observação fresca.
- [ ] Preview pausa quando invisível ou com viewer ativo e desacelera ocioso. Só publicar captura de resultado quando houve trabalho visual, for útil e respeitar as máscaras; teste não pode interpretar tela estática como prova de tarefa concluída.
- [ ] Integrar workspace a download/upload web; ampliar tipos/tamanhos explicitamente, validar paths/versões e tratar abas/popups/diálogos com guards. Testar planilha editada → upload → cópia publicada no chat, com login manual e handback.
- [ ] Rodar focais, `pnpm test`, `pnpm test:browser`, tipos server/mobile/worker; registrar ensaio real e commit `feat: share a persistent desktop between agent and phone`.

## Marco 8: cofre, login por referência e CAPTCHA

**Spec e passos:** [Cofre e aceites do marco 8](2026-10-02-private-credentials.md#entrega-8-e-aceites). Depende de cartões do marco 2, journal do 4 e browser/desktop do 7. OpenBao roda no VPS existente; login usa Chromium Lenovo ou headless VPS, sem navegador separado.

**Arquivos:** novos `credentials/{contracts,requests,broker,openbao-store,routes}.ts` no servidor, `apps/mobile/src/credential-request.tsx`, `apps/worker/src/credential-login.ts`, `challenge.ts`, `deploy/openbao/`; testes `tests/credential-broker.test.ts`, `tests/credential-login.test.ts`, `tests/browser-challenge.test.ts`, `apps/mobile/test/credential-request.test.ts`.

**Interfaces:** `authenticateConnection(connectionRef, sessionId) -> {state, challengeId?}`; `attemptChallenge(challengeId, sessionId, snapshotId, action)` com orçamento persistido no servidor. Campos secretos não entram no tool schema; confirmação de salvamento e confirmação de login são estados distintos.

**Integração upstream e regressões do marco 8:**

- [ ] Adaptar UI/discovery/OAuth de #88 sobre MCP HTTP/SSE já existente e referências do cofre. Testar allowlist revogada, segredo ausente de transcript/log/recibo e destino/redirect não autorizado; não importar stdio arbitrário no VPS nem política de bloquear todas as escritas. Validar registro/callback/metadados OAuth exigidos pelo provedor sob Tailscale/HTTPS; incompatibilidade aparece como tal sem expor automaticamente a API administrativa.

- [ ] Implementar cofre/formulário/login conforme adendo; comprovar não exposição no caminho normal de chat/tools/logs. Não alegar que um processo do próprio UID não lê seu perfil/browser; sudo amplo alcança também outras contas e supervisor.
- [ ] Acrescentar controle visual por Playwright no headless VPS: ações de pointer/drag vinculadas a snapshotId, dimensões, região do desafio e fence. Testar em cada executor; DOM/screenshot sem controle compatível pede ajuda, sem despachar uma ferramenta inexistente. Reusar controle visual Lenovo do marco 7.
- [ ] Testar CAPTCHA DOM/visual resolvido pelo agente, falha/capacidade ausente, orçamento de três submissões ou 60 segundos, cooldown, frame antigo e handback. Só observar desafio sanitizado; respostas/clicks via controles normais, sem inventar tokens de sucesso ou contratar solver.
- [ ] Guardar challengeId/contador/deadline/recibos: restart e fallback não renovam orçamento nem repetem submissão incerta. Se não resolver, cartão vinculado à sessão mantém contexto e aciona Take control somente quando a interação exigir.
- [ ] MFA/OTP/passkeys usam fatores reais da pessoa; desafios não substituem aprovação financeira. Login deve verificar resultado do site antes de declarar sucesso ou continuar ação externa.
- [ ] Rodar focais do adendo, `pnpm test`, tipos server/mobile/worker e fixtures de browser; commit `feat: collect credentials and handle login challenges inline`.

## Marco 9: fallback do navegador no VPS

**Arquivos:** criar `apps/server/src/executors/capability-router.ts`; alterar `browser.ts`, `browser-contract.ts`, `browser-tools.ts`, sessão/worker/config, `docker-compose.yml` e overlay `deploy/compose.hybrid.yml`; testes `tests/executor-fallback.test.ts`, `tests/browser-operations.test.ts`, `tests/deployment.test.ts`.

**Interfaces:** `CapabilityRouter.choose({taskId, capability, accountId?, artifactVersions, operationClass}) -> ExecutorBinding`; binding contém executorId/profileId/accountId/epoch/fence e estado de autenticação. Classificação nunca transforma efeito incerto em leitura. Registrar VPS como executor browser e Lenovo primário.

**Integração upstream e regressões do marco 9:**

- [ ] Preservar a proteção já existente de #115: finally libera sessão após falha ao persistir perfil, retornando erro explícito em vez de sucesso silencioso. Reusar fixtures #127 e recuperação #131 no executor VPS; queda durante download/import ou abort de observação (#31) não autoriza repetir escrita nem soltar lease sem estado confirmado.

- [ ] Testar Lenovo offline antes e durante pesquisa pública: mesma tarefa continua no VPS com nova sessão/snapshot. Quatro slots globais valem para ambos hosts; cada perfil tem seu lease.
- [ ] Testar perfil VPS autenticado correto, conta errada e login ausente. Sessão correta pode migrar; nos demais casos broker tenta login autorizado compatível no browser de destino, pede desafio pelo formulário seguro ou aguarda. Não devolver senha ao modelo pelas ferramentas nem copiar perfil em uso; manter chat disponível.
- [ ] Testar partição depois de despacho externo e reconexão com worker antigo: nenhuma repetição/migração mutável sem contenção e reconciliação. Watchdog gerencia egress e grupos da conta Lenovo; sudo amplo impede presumir contenção. Browser VPS usa os mesmos recibos/fences; frames, geração de sessão, revisões e autorizações antigas são rejeitados no novo executor.
- [ ] Manter perfis independentes, persistentes e backup por host. Publicações permanecem no VPS; arquivo local sem versão disponível aguarda. Shell longo/desktop não migram automaticamente.
- [ ] Manter browser VPS 2 GiB e budget total <7 GB; adapter antigo preservado em perfil legado. Rodar focais/suíte/tipos/Compose validator; commit `feat: fail over eligible browser work from Lenovo to VPS`.

## Marco 10: contexto e memória sustentáveis

**Arquivos:** criar `apps/server/src/thread-compaction.ts`, `engine/context-budget.ts`, `memory-history.ts`; alterar `threads.ts`, `db.ts`, `memory.ts`, `agent-profile.ts`, `personal-tools.ts`, `engine/service.ts` e UI de memória/perfil em `apps/mobile/src/agent-ui.tsx`; testes `tests/thread-compaction.test.ts`, `tests/memory-context.test.ts`, `tests/memory-history.test.ts`, ampliar `tests/agent-profile.test.ts` e rich/local threads existentes.

**Interfaces:** `ContextBudget.build({threadId, model, requiredOperationIds}) -> messages`; `ThreadCompaction.migrate/resume(owner, threadId)` idempotente; memória tem origem, versão e data e usa recuperação bounded em vez de inserir tudo.

**Integração upstream e regressões do marco 10:**

- [ ] Aproveitar #105–110 com leituras filtradas, índices e paginação: notificações não carregam workspace inteiro, seção não chama conectores alheios, manutenção evita republicações. UPDATE/CAS de #105 deve passar por Store.write/persistenceFailed; marker local não comprova push entregue nem substitui outboxes. Testar perda de write, resposta concorrente e recuperação de publicação.
- [ ] Manter aprendizagem/procedimentos locais com origem e versões; #25 não reintroduz exigência de Intelligence nem injeta skills acima do perfil/permissões. Imagens de desktop (#133) saem do contexto ativo quando obsoletas, mantendo referências necessárias à auditoria/recuperação sob retenção definida; não apagar evidência exigida para resultado incerto.

- [ ] Testar migração/restart com interrupção, replay rico sem perda, tool receipts necessários sempre presentes e contexto abaixo do teto do modelo. Histórico canônico incremental substitui cópias cumulativas; cursor suporta snapshot após compactação.
- [ ] Testar preferência em português, correção posterior, esquecimento e busca em conversa antiga. Resumos não promovem conteúdo de documento a instrução nem inventam fatos pessoais.
- [ ] Acrescentar validade opcional, versões/CAS, histórico e desfazer à memória já existente. Testar edição pessoa/agente simultânea, restauração como nova revisão, expiração no fuso correto e fato esquecido não reaparecendo por recuperação automática. Mostrar origem/alteração no app; fatos, histórico e supressões permanecem no banco autoritativo.
- [ ] Ampliar perfil do marco 2 com histórico/desfazer por escopo, preservando revisão/origem; desfazer cria nova revisão e não regride permissões ou fatos. Testar dois chats com estilos distintos e preferência antiga em memória sem sobrepor perfil corrigido. Não usar Markdown como banco alternativo.
- [ ] Implementar paginação/retenção explícita e limites de arquivo/evento; medir armazenamento bruto antes/depois com fixture longa sem apresentá-la como benchmark físico do VPS.
- [ ] Rodar focais/suíte/tipos e commit `feat: bound conversation context and recover relevant memory`.

## Marco 11: entrada móvel, rotinas e revisão proativa

**Arquivos:** criar `apps/mobile/src/chat-attachments.tsx`, `voice-input.tsx`, `conversation-resources.tsx`, `attachment-annotations.tsx`, `proactivity-card.tsx`, `apps/server/src/proactivity/{service,settings,evidence,suggestions,routes}.ts`; alterar `chat.tsx`, `screens.tsx`, `details.tsx`, `thread-artifacts.tsx`, `routines.tsx`, `routine-schedule.ts`, `native-push.native.ts`, server routines/memory/ideas, `personal-tools.ts`, `config.ts`, `engine/service.ts`, tipos de goal/task em `packages/domain/src/agent.ts`, Store e manifests; testes `apps/mobile/test/chat-input.test.ts`, `apps/mobile/test/attachment-annotations.test.ts`, `apps/mobile/test/proactivity-card.test.ts`, `tests/proactivity.test.ts`, ampliar `routine-schedule.test.ts`, `native-push.test.ts`, `tests/routines-integration.test.ts`.

**Interfaces:** anexos entram na outbox do marco 2 por ID/hash; áudio cria tarefa de transcrição com artefatos/texto e não envia áudio ao ChatGPT. Rotina exige timezone explícito da usuária/dispositivo ao criar; atualizar não redefine silenciosamente fuso ou política.

**Procedimentos reutilizáveis:** criar `apps/server/src/playbooks.ts`, tabela/versionamento, ferramenta no módulo pessoal e cartão móvel, com `tests/playbooks.test.ts`. Contrato proposto `saveProcedure({sourceTaskId, expectedVersion?, inputs, steps, verification})` e `runProcedure(id, version, inputs) -> taskId`; salvar a pedido da usuária, executar sob scheduler/política atuais. Importação de pacotes externos e marketplace ficam fora do marco.

**Heartbeat proativo:** `ProactivityService.scheduleDue(owner, now) -> cycleId?` cria/retoma uma tarefa de revisão no scheduler existente do VPS; `review(cycleId)` lê evidências autorizadas e publica sugestões; `respond(owner, suggestionId, {requestId, clientResponseId, action, expectedRevision, snoozeUntil?})` aceita `start`, `continue`, `snooze`, `resolved`, `dismiss`, usando o recibo idempotente de InteractionRequest do marco 2. `ProactivitySettings.update(owner, {expectedRevision, enabled?, intervalHours?})` permite ajustar pelo chat. Proposta inicial: `PROACTIVITY_ENABLED=true`, `PROACTIVITY_INTERVAL_HOURS=4`; são defaults de configuração, persistidos por usuária quando alterados, distintos do heartbeat técnico de 15 segundos. Uma revisão em voo por usuária, dentro dos quatro slots e quotas; consultas usam limites de paginação/contexto e orçamento finito do marco 4. Não criar scheduler paralelo nem janela de silêncio padrão.

Integrar a manutenção existente do servidor: substituir/delegar o `refreshIdeas` heurístico live, hoje avaliado em ciclos de 15 minutos pelo timer de manutenção, mantendo as outras responsabilidades do timer e a demo. Um único gerador controla sugestões proativas. Estender a entidade goal existente com responsável (`user`/`agent`), progresso, estado e origem/evidência, vinculando tarefas existentes; não criar outro banco ou interpretar toda pendência humana como trabalho já delegado ao agente.

Cada ciclo tem identidade/estado durável, watermark de revisão e referências a thread/task/goal com versão, escopo autorizado e horário da observação. O cartão vincula requestId/suggestionId/revisão ao threadId e versão ou IDs das mensagens observadas; resposta não pode trocar alvo/escopo. Persistir sugestão e outbox de publicação antes do push; chave semântica da pendência evita duplicar sugestão ou tarefa por retry/restart. Intervalos vencidos são coalescidos em uma revisão atual. Adiar guarda `snoozeUntil`; Resolvido registra a declaração da pessoa com origem; Não lembrar persiste supressão da pendência, até reversão explícita, sem apagar histórico. Iniciar/Continuar revalida evidência e faz vínculo idempotente à tarefa existente ou nova antes de confirmar; aceite com fila cheia mostra enfileirada, não em execução.

**Integração upstream e regressões do marco 11:**

- [ ] Integrar #70/#123/#91 com goalId/milestoneId/taskId estáveis e patch/CAS por ID/revisão: delegar etapa existente não cria outra meta, não duplica etapa concluída e não sobrescreve progresso humano concorrente. Resultado verificado do bot e declaração da pessoa têm autoria distinta. find_ideas chama o único ProactivityService; requestId e payload sobrevivem a restart e aceite enfileirado não aparece como iniciado.
- [ ] Unificar #97/#130/#121/#117 em parsing Gmail/nomes compartilhados: charset desconhecido, cabeçalhos MIME dobrados, e-mail em display name, message/rfc822 anexado, emoji truncado e surrogate inválido. Usar remetente/thread corretos no heartbeat; sanar input inválido e nomes já recebidos sem derrubar sincronização inteira. Preservar cache/drafts e recuperação de #99.
- [ ] Acrescentar read_calendar de #134 com intervalo/fuso explícitos, calendário(s) autorizados, limites/paginação e erro distinto de agenda vazia. Unificar #71/#96/#98 em datas civis/all-day: testar data impossível, fuso ausente, DST com meia-noite inexistente e exibição no dia correto. Resultado truncado/fuso incerto não permite afirmar agenda livre; suportar primary inicialmente sem prometer cobertura de todos os calendários.
- [ ] Adaptar #118/#116/#82 nos monitores: commits antigos não substituem observação recente, pausa preserva dados concorrentes e retomada passa pela transição recuperável respeitando pausa global. #83 usa ocorrência persistente distinta de hash/retry, inclusive A→B→A→B em change. Testar concorrência, replay e stop terminal; #16/price_above é extensão opcional após esse contrato, não requisito para heartbeat.
- [ ] Aproveitar diff explicável de #66 com flag de truncamento/fallback conservador; mudar somente a cauda além do limite não vira silêncio. Compor parser #126 com preço/moeda/alvo explícitos; preço antigo/frete não é automaticamente o preço do produto. Exibir fontes/limites de search_web (#84) em cartão e resultados parciais honestos. Aceite físico Android #128 cobre composer e caixas de pergunta/credencial com teclado aberto.

- [ ] Testar importar documento/câmera/compartilhamento direto no chat, fechar/reabrir com upload pendente e receber resultado compartilhável. Validar limites/tipos e mensagens de erro.
- [ ] Reunir “Arquivos e sessões” por conversa, com preview/versão/estado e links autorizados. Testar resultado antigo após reabrir o app, Lenovo offline com arquivo publicado no VPS e sessão expirada apresentada como tal, sem falso acesso ao vivo.
- [ ] Permitir citar texto e marcar região de captura/anexo com comentário antes de Enviar. Guardar mensagem/artifactId/versão/frame e coordenadas normalizadas; rascunho sobrevive ao restart. Testar zoom/rotação/resolução, máscara de credencial, origem removida e entrega na mailbox correta. Anotação nunca clica automaticamente na tela atual; comentário e texto citado têm autoridades diferentes.
- [ ] Sincronizar catálogo MCP/skills derivados por geração, preservando descrição válida em falha transitória e retirando revogadas. Testar resposta atrasada após revogação e revalidar allowlist/autorização a cada execução; procedimentos informam ferramentas ausentes sem ampliar permissões.
- [ ] Implementar gravação/transcrição no fluxo de chat; Lenovo offline mantém áudio na fila e texto utilizável. Permissões negadas não bloqueiam composer; idioma automático PT/EN/DE com ferramenta existente.
- [ ] Testar rotina weekday no fuso da usuária, DST, retorno após indisponibilidade, ocorrência bloqueada e notificação duplicada. Melhorar sugestões no idioma escolhido, com evidência e deduplicação de rejeitadas/concluídas.
- [ ] Implementar revisão a cada intervalo de e-mails realmente sem resposta, tarefas humanas incompletas e planos ainda não iniciados. Ler thread completa e respostas enviadas/recentes: não lido não significa sem resposta; e-mail informativo não exige resposta. Não comparar somente IDs de mensagens recebidas com IDs da pasta Sent; rascunho preparado ou tarefa de preparação concluída não comprova envio. Atividade humana vem do app/conectores autorizados, com origem/data; ausência de evidência não prova que a pessoa não fez algo. Exibir incerteza ou pedir atualização quando necessário, sem vigiar outros usuários/processos do Lenovo.
- [ ] Sugerir ação concreta com evidência fresca e controles Iniciar/Continuar/Adiar/Resolvido/Não lembrar. Novos planos aguardam a decisão da pessoa; trabalho já autorizado continua sob sua tarefa/orçamento, sem pedir autorização novamente. Essa decisão define o novo escopo, não cria aprovação obrigatória para todo e-mail: envio já autorizado mantém política live MONEY-only; conteúdo de e-mail é dado não confiável, nunca instrução para ampliar acesso.
- [ ] Testar e-mail respondido pela pessoa após o scan e antes de Iniciar/Continuar, tarefa já concluída, plano alterado, alvo/escopo adulterado, duplo toque e ACK de resposta perdido: validar requestId/clientResponseId e reler origem/revisão antes de criar/retomar trabalho e novamente no próximo despacho relevante; encerrar sugestão obsoleta ou mostrar o que mudou, sem criar tarefa duplicada ou enviar resposta redundante. Fonte indisponível preserva estado e adia a decisão dependente, sem assumir ausência de resposta. Com quatro vagas ocupadas, confirmação retorna tarefa enfileirada e a UI só muda para executando após admissão real.
- [ ] Migrar a decisão de ideias para reutilizar `goalId`/`taskId` vinculados: Continuar não cria goal novo quando já existe, nem substitui tarefa em execução. Testar objetivo humano marcado concluído no app/conector, rascunho sem envio, resposta por outra mensagem da mesma thread e timer legado coexistente durante migração; só o ProactivityService live publica sugestões e a demo mantém seu comportamento.
- [ ] Testar quatro trabalhos ativos mais ciclo devido, nova mensagem durante revisão e mudança de intervalo pelo chat: revisão aguarda slot, conversa não é cancelada nem perde prioridade, e nenhum retry cria quinto trabalho. Queda de VPS, rede/provedor e longos períodos offline geram uma revisão atual recuperável, sem rajada dos intervalos perdidos ou duplicação de sugestões/notificações.
- [ ] Testar Adiar até horário escolhido, Resolvido e Não lembrar sobrevivendo a restart; evidência equivalente não recria sugestão suprimida. Pausa global impede novos ciclos/efeitos e retomada é explícita; revisão interrompida mantém cursor/estado. Revisão parcial por quota/conector ausente informa cobertura e pendências, sem alegar que todas as fontes foram verificadas nem bloquear chat/tarefas independentes.
- [ ] Permitir “guarde esse jeito de fazer” a partir de tarefa concluída, sem credenciais nos passos. Testar versão fixada em execução, entradas validadas, ferramentas ausentes, alteração do site exigindo nova observação e mesma aprovação financeira. Procedimento é instrução reutilizável, sem execução cega de coordenadas ou instalação de scripts externos.
- [ ] Notificação abre a tarefa exata, inclusive rotina destacada, e não apenas o chat ativo. Deduplicar conclusões, agrupar progresso e manter resultado/artefato acessível após reabertura; push físico continua sendo aceite separado.
- [ ] Rodar focais/suíte/tipos, exports web/iOS/Android e aceitação física separada; commit `feat: add direct mobile inputs and reliable personal routines`.

## Marco 12: instalação e aceitação dos dois hosts

**Arquivos:** ampliar `DEPLOY.md`, `.env.example`, `docs/VERIFICATION.md`, `scripts/deployment_backup.py`, manifests systemd/Compose e criar `scripts/verify_hybrid.py`; ampliar `tests/deployment.test.ts`. Documentar fontes/configs reais sem registrar segredos.

**Integração upstream e regressões do marco 12:**

- [ ] Revisar #104 antes do piloto: atualizar image-size vulnerável com lockfile consistente e verificar assets/bundles Expo web/iOS/Android; não afirmar exploração da API sem evidência. #75 depende de aparelho/SDK iOS reais: caso necessário, testar cold launch, background, deep links/OAuth e push após adaptação de lifecycle. Renovate #1 continua opcional, sem automerge nem atualização em massa para concluir este marco.
- [ ] Redesenhar quotas sugeridas por #103 por owner/device/rota e confiança explícita no proxy, com memória limitada e capacidade de controle reservada. Testar cabeçalho XFF adulterado, dois viewers, quatro tarefas, uploads e Stop/Take control sem bloqueio por polls. Preservar limites atuais de envelope multipart/anexos/PDF; vídeo/arquivos maiores precisam transferência streaming e quota própria, não aumento global. Slots/cgroups continuam sendo os limites de trabalho/RAM.

- [ ] Documentar pareamento do executor/celular, grants Tailscale, contas nativas, modo de privilégio, serviços/sessões por UID, hierarquia de recursos e autostart/tampa/Wi-Fi/energia/desbloqueio de disco. Sem VM hospedando o bot; KVM apenas se necessário a futuro emulador Android. Inspecionar configuração real antes de alterar tailnet/energia e manter recuperação administrativa.
- [ ] Revisar publicação da marca OkamiBot: textos/defaults/ícones/notificações, origem/avisos MIT e atribuições de dependências. Não renomear bundle/package/scheme, volumes, .openmuse ou @openmuse por substituição global; preservar IDs técnicos inicialmente. Testar upgrade com banco, nome personalizado, pareamento e logins existentes. Mudança posterior de IDs requer migração própria e verificação de deep links/OAuth/SecureStore.
- [ ] Publicar todas as variáveis propostas: modo híbrido, node ID/credential file, limites de tarefas/inferência/recursos, heartbeat/TTL técnico, `PROACTIVITY_ENABLED`/`PROACTIVITY_INTERVAL_HOURS`, modelo/capacidades/fallback, pareamento, destino/retenção de backup e versões/lixeira. Distinguir variáveis novas das já existentes e não fornecer valores secretos; documentar ajustes de proatividade pelo chat, pausa global e restauração de arquivo.
- [ ] Implementar backups cifrados cruzados entre VPS e Lenovo, de DB/workspace/publicações/perfis/cofre consistentes, com chaves de recuperação separadas do agente; não requer terceiro servidor. Cópia offline adicional pode usar mídia já disponível. Não matar todas as tarefas diariamente. Registrar quiescência seletiva e restore isolado sem duplicar cron/envios. Validar auto-unseal do OpenBao sem modo dev/KMS pago e comportamento com cofre selado.
- [ ] Fazer jornada física: quatro tarefas, conversar/orientar, assumir/devolver tela, fechar app, receber push, abrir artefato. Simular queda Wi-Fi e VPS/browser fallback, reinício Lenovo/sessão/VPS e modelo indisponível; nenhum envio real sem escopo de teste autorizado. Medir até cinco sessões leves e uma carga acima de 8 GB; não confundir capacidade de login com cinco cargas grandes.
- [ ] Acrescentar cenários determinísticos ao setup de testes existente: quatro tarefas + orientação, perda de ACK, claim tardio da tela, queda entre observação/ação e rotina sem duplicação. Usar provedor simulado e fixtures sintéticas, sem contas nem chamadas externas; resultados do cenário não substituem ensaio físico nem validam capacidade real do modelo.
- [ ] Exercitar conclusão sem evidência versus entrega parcial, prazo/prioridade, desfazer edição sem perder alteração humana posterior e pausa global nos dois hosts. Ensaiar proatividade com relógio controlado e fontes sintéticas: período de 4 h, ajuste pelo chat, resposta humana posterior ao scan, supressão/adiamento, limite de quatro e reinício sem duplicação. Teste real de e-mail usa somente fixture/conta autorizada e não envia mensagens como efeito da instalação.
- [ ] Medir consumo/temperatura/latência por 24 h com mistura realista, sem quatro cargas pesadas simultâneas por padrão. Confirmar browser de reserva e teto VPS, espaço livre/retensão e capacidade antes de outro bot. Medir ACK local p95 e latência de chat com/sem carga; separar latência do provedor e da rede.
- [ ] Rodar `pnpm test`, `pnpm typecheck`, `pnpm --dir apps/worker typecheck`, `pnpm build:server`, testes browser/computer pertinentes, exports e validators. Registrar exatamente o que passou e o que permanece não verificado; commit `docs: deploy and verify the hybrid personal agent`.

## Critério de conclusão

A usuária personaliza nome/tom/apelidos pelo chat e vê o perfil persistir no app, tarefas e troca de modelo. Envia quatro pedidos independentes; continua conversando, orienta um deles e altera estilo sem cancelar os demais. O agente cria um documento, usa o desktop/browser, aceita intervenção humana e entrega o arquivo com app fechado. Lenovo perde conectividade e pesquisa elegível continua no VPS; escrita incerta não se repete. Modelo primário cai e outro compatível continua de checkpoint. App reinicia/renova sessão sem nova chave. Backups restauram estado e nenhum executor antigo retoma com autorização vencida.

Resultados distinguem verificado, parcial e pendente; prazo/prioridade alteram agenda sem apagar trabalho. A usuária recupera uma versão de arquivo e pausa/retoma globalmente com confirmação real dos executores. O heartbeat proativo revisa pendências no intervalo configurado, sugere agir com evidência atual, respeita Adiar/Resolvido/Não lembrar e mantém os mesmos quatro slots. Uma resposta de e-mail posterior à revisão invalida a sugestão correspondente; trabalho já autorizado continua sem nova pergunta e pausa global sobrevive a reinício.

Este plano não afirma que contas de assinatura, hardware Lenovo, push físico, contenção por UID ou compatibilidade Blender/Android Studio/emulador já foram validados. Essas verificações pertencem à execução e devem produzir evidência própria.
