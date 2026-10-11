# Configuração usada pelo worker e pedidos de explicação — 11/10/2026

**Correção local posterior a `3af92d34`, ainda não publicada. O objetivo completo permanece aberto.**

O perfil autenticado só aceitava seleções de ferramentas. O dispatcher recusava modelo, skills e projeto; o executor consultava apenas a seleção geral da conta. A configuração não chegava à execução. A API de perfis agora aceita projetos com diretório em `/workspace`, projeto padrão, diretório padrão, modelo conectado e guias atribuídos. Identidades de projeto duplicadas, projeto padrão desconhecido e caminhos fora do workspace são rejeitados antes de salvar.

O `kanban_create` usa o registro do perfil para criar o card com seu projeto, worktree e branch. Scratch explícito continua selecionando scratch. Sem projeto, o diretório padrão seleciona uma execução em diretório. O dispatcher existente grava junto do vínculo nativo a revisão do perfil, a seleção do modelo e as skills. O mesmo worker provisiona a worktree física; não foi criado outro executor.

Modelo do card prevalece sobre modelo do perfil; ambos usam apenas rotas conectadas e disponíveis. Um nome de modelo sem provedor usa o provedor explicitamente selecionado ou o da configuração vigente. Modelo/provedor incompatíveis e rota indisponível impedem o despacho sem deixar tarefa, card reclamado ou vínculo incompleto. Um override explícito não adiciona fallback silencioso. Tarefas comuns também usam o modelo do perfil sem exigir opt-in ao kanban. Projeção de contexto e inferência usam a mesma seleção.

As skills atribuídas pelo perfil/card são resolvidas por identidade e lidas integralmente pelo catálogo já existente, com as ferramentas realmente disponíveis. Só os corpos atribuídos são injetados antes da primeira inferência; o restante continua como metadados e descoberta progressiva. Nomes ambíguos pedem a identidade completa. Guias ausentes interrompem antes de inferência com o nome e a configuração afetada. As instruções são orientação, sem conceder ferramentas ou credenciais.

A disponibilidade de modelo só é exigida quando uma inferência será feita. A recuperação de uma entrega já gravada usa os recibos nativos mesmo depois de desconectar o provedor, sem repetir pesquisa, criação do workspace, chamada de modelo ou conclusão.

Na varredura, um pedido para **explicar** como organizar o dia foi classificado como operação externa por conter “schedule”. Isso exigia um recibo de alteração que o usuário não pediu. As cláusulas de explicação agora geram obrigação de resposta; solicitações independentes de execução permanecem sujeitas a recibos. Um PDF explicitamente solicitado com a explicação continua exigindo arquivo real. Os controles cobrem explicações de calendário, Docs e exclusão de Gmail, além de pedidos mistos com execução.

## Evidência e limites

- **140/140 controles focados passaram**, sem falhas, cancelamentos ou skips, em 15 arquivos e 128,974 segundos. Incluem worker real, PGlite, provedores de protocolo de teste, arquivos temporários e Git real. O projeto padrão foi confirmado por arquivo físico na branch da worktree, com a branch principal preservada.
- TypeScript do projeto, build do servidor, assets e build do harness passaram. Lint dos 14 arquivos TypeScript examinados passou sem erros, com sete avisos. A suíte completa não foi executada nesta rodada.
- Os logs preservam as falhas iniciais de schema, recuperação após indisponibilidade do provedor e classificação da explicação. O primeiro grupo ampliado teve três falhas: expectativa antiga de modelo sem suporte, entrega explicativa sem recibo e fixture sem provedor conectado. Foram investigadas e corrigidas antes da verificação final.
- `artifacts/harness-parity-20261009/round71-local-verification-manifest.json` registra hashes das fontes, logs e arquivos compilados.
- A conferência de produção às **12:19:44 UTC** encontrou página pública e health da API com **HTTP 200**; API, navegador e OpenBao estavam saudáveis. A imagem API permanece a de `c0c2c9ec`. Não houve publicação nem modificação de dados na VPS nesta rodada. A primeira sondagem com User-Agent padrão do Python retornou 403; a sondagem seguinte com User-Agent de navegador passou.

**Isso não é aceitação por pedido natural com Luna no app publicado.** Orçamento físico declarado, contratos de objetivo/PR/CI, herança completa de projetos entre perfis, despacho automático, entrega à conversa correta e publicação permanecem pendentes. Comprovação factual completa da pesquisa, todas as operações do Google Workspace e consumo/performance sustentados também não estão aprovados. Nenhum APK, imagem Docker ou registro público de teste novo foi criado nesta rodada.
