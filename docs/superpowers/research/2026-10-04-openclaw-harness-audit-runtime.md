# Auditoria de prompts, ferramentas, skills e responsabilidade pela entrega

Referência lida: OpenClaw `da979df299e88c3711f6ee2cd3c7443dd045584b`, em
`/tmp/openclaw-harness-reference`. Licença MIT, copyright 2026 OpenClaw Foundation;
aviso completo preservado em `third_party/openclaw/LICENSE`. A inspeção usou os
arquivos e objetos Git locais, sem executar código do projeto de referência.

## Evidência do incidente

O pedido real foi: “obrigado gata, agora preciso que voce me gere um pdf sobre
como voce funciona, harness, skills e tudo mais”. A tarefa
`a16cde7f54fed24a24e5f3055cc220f68d72c06f0f3f389616197ebbada9d27a` pesquisou na web
e terminou em `waiting_provider`, sem PDF. A análise de contexto/modelo e o
registro completo de produção pertencem à investigação principal; este documento
trata da escolha de fontes, descoberta de ferramentas e instruções de execução.

Antes desta correção, os prompts do chat e do worker só acrescentavam perfil,
capacidades de imagem e, no worker, direções da tarefa. Não havia documentação
de execução própria nem ferramenta que descrevesse a instância atual. As
instruções extensas de pesquisa pública ficavam disponíveis mesmo para uma
pergunta sobre o próprio assistente. `list_procedures` fornecia procedimentos
salvos; isso não constitui um catálogo de arquivos `SKILL.md` instalados.

Havia ferramentas para importar e preencher PDFs existentes. Criar um novo
PDF dependia de escrever/executar/exportar no computador; não existia um criador
de PDF no servidor. Essa lacuna é tratada pela implementação de documentos,
separada desta auditoria.

## Comparação e reaproveitamento

| Área | OpenClaw, arquivos inspecionados | Situação encontrada no app | Ação concreta |
| --- | --- | --- | --- |
| Promessa e entrega | `src/agents/promised-work-prompt.ts`; `system-prompt.ts:759` | O worker verifica resultados, mas o contrato compartilhado do chat não exigia caminho de conclusão ao prometer trabalho posterior. | Copiado o módulo pequeno, sem alterar seu texto, e incluído nos dois prompts. A cópia sozinha não prova entrega: tarefas, recibos e publicação continuam necessários. |
| Conhecimento do próprio produto | `src/agents/system-prompt.ts:604` | Sem fonte local de fatos sobre a aplicação, o modelo buscava explicações de outros produtos. | `read_runtime` informa modelo atual, ferramentas efetivamente registradas, execução, verificação, entrega, política e procedimentos do proprietário. A orientação prioriza essa fonte para explicar o próprio app. |
| Inventário efetivo | `src/agents/tools-effective-inventory.ts`, `tools-effective-inventory.types.ts`, `system-prompt-tool-list.ts` | Arrays independentes no chat/worker; descrições de uma ferramenta direta eram reaproveitadas em wrappers que apenas delegam. Aliases de arquivos/comandos repetem schemas. | O inventário consulta os arrays reais e os descritores compartilhados das ferramentas internas. Os wrappers descrevem explicitamente o retorno de cartão de tarefa e separam o contrato da operação executada pelo worker. A consolidação de aliases permanece trabalho posterior. |
| Skills reais | `src/agents/system-prompt-skills.ts`, `embedded-agent-runner/skill-runtime.ts`, `src/skills/loading/workspace-skill-prompt.ts` | Existiam procedimentos versionados derivados de tarefas verificadas, sem carregamento de skills distribuídas. | Implementado catálogo elegível de `SKILL.md`, separado dos procedimentos, com skills distribuídas no build e diretório de operador por proprietário. Uma skill não instala ferramentas nem concede autorização. |
| Busca e leitura de skills | `src/agents/installed-skill-catalog.ts`, `tools/installed-skill-tools.ts`, `src/skills/loading/skill-contract.ts`, `skill-prompt-catalog.ts` | `list_procedures` retorna o conteúdo de todos os procedimentos, sem seleção anterior por objetivo. | Adaptados os contratos: índice e busca de metadados limitados, leitura integral até 32 KiB ou erro, procedência e SHA-256. O parser portátil de frontmatter foi copiado com licença MIT. |
| Ferramentas sob limite de contexto | `src/agents/tool-search-runtime.ts`, `tool-search-catalog.ts`; `embedded-agent-runner/tool-schema-runtime.ts` | A descoberta Composio já é tardia, mas os muitos schemas nativos entram juntos; o incidente também revelou divergência entre o orçamento e os schemas serializados. | A correção de orçamento mede o formato realmente enviado. Depois, separar descoberta de execução com schemas carregados por necessidade, conservando validação, registros e cancelamento no mesmo caminho. |
| Trabalho delegado | `src/agents/delegation-guidance.ts`, `accepted-session-spawn.ts`, `reply-completion.ts` | Há tarefas duráveis, publicação na conversa e critérios de artefato; o chat já ganhou etapa de delegação antes da resposta final. | Manter a origem e a obrigação de entrega até a confirmação de publicação. Distinguir `running`, resultado pronto, publicação pendente e entrega confirmada. Um filho encerrado não conclui automaticamente o pedido do usuário. |
| Pesquisa sem progresso | `src/agents/tool-loop-no-progress.ts`, `tool-loop-argument-churn.ts`, `tool-loop-outcome-hash.ts`, `tool-loop-admission.ts` | Limites numéricos de passos não distinguem pesquisa útil, repetição e resultado requerido ainda ausente. | Reaproveitar as funções puras de observação de progresso com o journal local. Avisar e mudar de estratégia antes de esgotar o contexto; não bloquear uma consulta nova apenas porque consultas anteriores falharam. Implementação pertence à investigação principal. |

Os módulos pequenos de política, formatação, parsing, orçamento e comparação de
resultados são candidatos diretos a cópia com atribuição e testes. O carregador
completo de skills e o runtime de busca dependem de autoridade de recursos,
sandbox, plugins, configuração e ciclo de vida próprios do OpenClaw. Esses
contratos precisam de adaptação explícita às conexões, tarefas e cofre do app;
importar apenas seus nomes daria ao modelo capacidades que não existem.

## Alterações desta frente

- Novo `apps/server/src/runtime-tools.ts`, compartilhado pelo chat e worker.
  Consulta apenas metadados selecionados; não serializa config, caminhos
  privados, prompts, credenciais, histórico ou procedimentos de outro usuário.
  Inventários grandes têm orçamento de caracteres e indicação de truncamento.
  A descrição de uma ferramenta é consultada pelo nome exato no registro atual.
- Novo `apps/server/src/engine/promised-work-prompt.ts`, copiado do OpenClaw e
  registrado em `third_party/openclaw/README.md` com revisão e licença.
- Orientação de fonte própria ligada aos dois prompts. O modelo mantém a
  decisão sobre a tarefa; não foi adicionado roteador de assuntos por palavras.
- `skills_list`, `skills_search` e `skills_read` oferecem workflows reais nos
  dois agentes. As skills de artefatos, pesquisa e descrição do assistente são
  assets da aplicação, copiados para o build. O parser de frontmatter vem de
  `packages/markdown-core/src/frontmatter.ts` do OpenClaw; a adaptação local
  substitui apenas a pequena dependência `isRecord`.
- O catálogo aceita no máximo 128 entradas por origem e 32 KiB por arquivo;
  páginas de metadados têm limite de 10 mil caracteres. Rejeita travessia,
  symlinks, hardlinks, arquivos não regulares, mudanças durante a leitura,
  YAML inválido e skills cujas ferramentas obrigatórias não estão registradas.
  Leitura de instruções não é efeito nem prova de artefato criado; pode ser a
  observação necessária para explicar o próprio workflow instalado.

O operador pode instalar arquivos em
`<DATA_DIR>/skills/owners/<SHA256(owner)>/<slug>/SKILL.md`, com frontmatter
`name` igual ao slug, `description` e `required-tools` opcional como lista YAML.
`disable-model-invocation: true` exclui uma skill do agente. O modelo recebe IDs
`builtin:<slug>` ou `operator:<slug>`, nunca caminhos locais. Não há ferramenta
de instalação ou execução de código da skill; o conteúdo lido é orientação de
workflow dentro da autorização existente. Skills de operador não substituem
as identidades das skills distribuídas.

O manifest distingue registro de ferramenta de prontidão operacional. Uma
função de Google ou computador registrada não prova autenticação ou conexão.
Também identifica os procedimentos salvos como procedimentos, sem alegar que
as skills do ambiente de desenvolvimento ou de outro produto estão instaladas
no assistente do usuário.

## Verificação e critérios de aceitação

`tests/runtime-tools.test.ts` reproduziu primeiro a ausência da ferramenta no
chat e worker. Depois verificou o registro real, seleção do modelo, isolamento
de proprietário, ausência de segredos, consulta exata, rejeição de argumentos
fora do schema e limite de saída com inventário grande. Um teste adicional
falhou primeiro pela ausência do contrato de promessa nos dois requests reais
ao provider; a integração passou a fornecer o módulo compartilhado.

`tests/skill-catalog.test.ts` começou sem as ferramentas, falhando, e verifica
listagem, busca, leitura completa, hash, isolamento entre proprietários,
elegibilidade por ferramentas, arquivos alterados, rejeição de caminhos e
conteúdo inválido, origem sem autoridade elevada e leitura sem efeito no worker.
As duas superfícies conseguem ler a skill distribuída de artefatos.
O teste do worker revelou ainda que o verificador aceitava `read_*`, mas não o
novo `skills_read`: a leitura correta não concluía uma explicação do workflow.
A inclusão exata de `skills_read` conserva as verificações de erro, revisão,
conteúdo requerido e as restrições separadas para ofertas externas atuais.

Os testes determinísticos exercitam o SDK e o journal, mas o provedor sintético
escolhe as chamadas. Eles não substituem o teste com modelo real do pedido
inteiro: fonte própria → conteúdo correto → PDF real → publicação no chat.
Essa execução deve confirmar também que o arquivo abre, contém as informações
da instância e não relata capacidades de outro produto como instaladas.

Para a revisão completa, aceitar uma melhoria exige pelo menos um cenário real
por classe de entrega: arquivo, imagem, pesquisa com fontes e ação em conexão;
falha de provedor e cancelamento devem conservar recibos sem duplicar efeitos.
Não considerar promessa em texto, término de inferência ou `running` como prova
de atendimento do pedido.
