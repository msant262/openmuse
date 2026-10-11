# Diretório físico da tarefa e Python nativo — 11/10/2026

**Implementação local verificada; ainda não publicada. O objetivo integral permanece aberto.** A última API publicada continua em `c0c2c9ec`.

## Causas encontradas e reproduzidas

O card declarava um workspace, mas o dispatcher não preparava o diretório e os comandos/arquivos usavam `/workspace` como base. O Python fixava `/workspace` tanto no envelope do servidor quanto no lançamento físico por systemd. A sessão Python era associada à conversa, sem identidade própria da execução do card. A recuperação de uma conclusão já gravada também precisava atravessar a nova preparação sem tentar criar outro diretório.

Os dois novos controles de ferramentas falharam antes da mudança. O grupo Python inicial apresentou seis erros e uma falha nos sete novos casos. O teste de exportação via protocolo v2 encontrou ainda verificações privadas de RPC fixadas em v1; elas foram corrigidas mantendo a correspondência exata entre a versão da célula e sua resposta. Dois controles de confirmação perdida, agora montados pelo dispatcher real, reproduziram a rejeição indevida de uma conclusão já gravada antes da correção de recuperação.

## Comportamento implementado

- O dispatcher grava a intenção de workspace na mesma transação do card/run/tarefa. A preparação física ocorre somente no worker nativo admitido, usando o journal, as leases de recursos e o computador existentes.
- Scratch usa um diretório estável por board/card. Diretórios explícitos são criados e seus arquivos existentes permanecem intactos. Worktrees usam Git real, branch própria e conferência da branch observada. Um checkout vinculado a outra branch é preservado; a tarefa usa seu caminho próprio na raiz do repositório principal.
- A gravação da preparação confere ator, validade pelo relógio do banco, estado da tarefa, revisão do perfil, vínculo, revisão do card e pausa global. O recibo físico fica preservado quando o ator perde a posse ou uma pausa chega antes da gravação.
- O diretório confirmado alimenta os comandos, caminhos relativos de arquivos, buscas e a célula Python. A sessão Python do card usa tarefa/run fornecidos pelo host; o modelo não escolhe a identidade nem o diretório da célula. Conversas comuns mantêm sua sessão habitual.
- O protocolo Python v2 transmite o diretório até o launcher físico e seu `WorkingDirectory`. V1 continua atendendo `/workspace`. Um executor v1 recusa um diretório específico antes de criar outra operação. Respostas de RPC conservam a versão, tarefa, sequência e autoridade da célula original.
- Uma alteração incompatível do diretório da mesma sessão é rejeitada antes de criar o job. Isso preserva o interpretador correto e suas variáveis, inclusive se a solicitação incorreta pedir reset.
- O launcher nativo confere o diretório da conta registrada e rejeita travessia, diretório ausente ou symlink. Não recebe UID, ambiente ou credencial escolhidos pelo modelo.
- Uma conclusão já gravada segue para a recuperação existente, que exige seu recibo e a prova nativa do mesmo handoff. Os controles confirmam ausência de outro diretório, leitura de fonte, turno do modelo ou mutação do card.

## Validação e limites

**110/110 controles focados passaram**, sem falhas, cancelamentos ou skips, em **87,233 segundos**, cobrindo 16 arquivos. Incluem oito controles de preparação física, as novas ferramentas com diretório do host, as proteções anteriores de posse, artefatos, contexto, autoridade/RPC Python, leases e executor remoto. Os dois controles existentes de confirmação perdida passaram a usar o vínculo criado pelo host, sem inserção manual da execução.

**61/61 controles Python passaram**, em **6,174 segundos**, nos três arquivos de kernel, launcher e transporte. Há interpretadores filhos reais: criam arquivos no diretório correto, preservam variáveis na retomada e isolam diretórios de sessões distintas. O teste de protocolo/RPC exporta bytes reais pela ferramenta original para Files. Git e os arquivos de preparação são reais em diretórios temporários de testes.

TypeScript do projeto, build do servidor, cópia de assets e build do harness passaram. Lint dos 20 arquivos TypeScript examinados passou sem erros, com seis avisos preexistentes. O manifesto `artifacts/harness-parity-20261009/round70-local-verification-manifest.json` fixa fontes, logs e arquivos compilados.

**Esses controles não são aceitação natural a Luna, instalação/publicação do protocolo v2 no computador registrado ou aprovação de todo o harness.** A configuração de projetos/default workdir, modelo/provedor, skills e orçamentos ainda precisa integração. Objetivo, PR e CI continuam exigindo seus gates reais; o dispatcher mantém essas condições sem suporte recusadas. Despacho automático, roteamento de entrega e aceitação publicada permanecem pendentes.

A referência de workspace foi lida no Hermes fixado em `e0550c97`: [kanban_db_workspace.py](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/hermes_cli/kanban_db_workspace.py). A cópia preservada tem SHA-256 `019a14f01be5030e893fd89c4799b55aa89896ad31208b3558b7f0dd340626ce`. A integração mantém o contrato de diretório estável e execução em worktree, com os executores e a autoridade já existentes no OkamiBot.

Não houve alteração de dados, contas, containers ou configuração de produção. Pesquisa factual, Google Workspace completo, performance, UI e as 44 operações históricas incertas permanecem no objetivo. O [relatório geral](2026-10-11-relatorio-harness.md) e o [registro do dispatcher](2026-10-11-kanban-dispatch.md) mantêm os demais requisitos.
