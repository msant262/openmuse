# Tempo declarado da execução física — 11/10/2026

**Implementado e verificado localmente depois de `05074b90`. Ainda não publicado nem aceito por pedido natural no app. O objetivo completo permanece aberto.**

O dispatcher recusava `maxRuntimeSeconds`. O worker também tratava qualquer sinal de interrupção como motivo para recolocar a tarefa na fila. Isso não bastava para controlar um processo físico, sobretudo quando um job continuava entre chamadas do worker.

O perfil autenticado pode declarar um tempo para seus cards. O valor explícito do card prevalece sobre o perfil. Sem declaração, não há novo limite automático de duração. O dispatcher grava a duração e o prazo absoluto junto de card/run/tarefa/vínculo. Esse prazo acompanha a tentativa canônica: uma consulta de job ou o reinício do worker não o renovam. Durações longas não estouram o contador de timers do Node; números que não permitem representar milissegundos exatamente são rejeitados.

O worker usa o sinal existente para interromper a execução. Terminal, preparação de worktree e Python recebem o tempo restante antes de gravar a operação física. A autoridade nativa inclui o prazo no `expiresAt` já existente; o supervisor desconta fila/transporte antes de configurar o tempo da unidade física. A operação recebida e seus argumentos canônicos permanecem intactos. Python continua verificando o gate durante a célula, sem alterar a identidade ou o conteúdo do pedido recebido.

Uma expiração não retorna à fila para executar a fonte novamente. A tarefa fica com falha e motivo concreto. Quando existe job em segundo plano, a solicitação de cancelamento aponta para o mesmo identificador; a manutenção tenta pará-lo, conservando a ocupação enquanto o executor estiver indisponível ou a parada não for comprovada. Recibos incertos continuam incertos. Uma tarefa tomada por outro worker não pode ser alterada pelo timer anterior.

Foi reproduzida também a corrida em que o handoff já havia sido gravado quando a interrupção ocorreu. O worker verifica o recibo canônico e a prova da revisão correta. Nesse caso, a próxima chamada apenas recupera a confirmação: não pesquisa, cria workspace, chama o modelo ou grava o handoff novamente. Expiração após a entrega gravada também funciona com o provedor desconectado.

## Evidência e limites

- **77/77 controles de integração passaram**, em nove arquivos, sem falhas, cancelamentos ou skips, em **80,820 segundos**. Incluem Store/PGlite e worker reais, parada confirmada de um processo filho de QA, persistência de job entre workers, cancelamento do mesmo job após indisponibilidade, proteção de posse, argumentos físicos, envelope nativo e recuperação de entrega.
- **85/85 testes nativos de Python passaram**, incluindo os novos controles de desconto do tempo em fila e diferença entre relógio local e âncora do servidor. Os controles de lançamento usam o supervisor/SQLite e adaptadores de unidade de teste; não são uma prova em systemd da conta registrada.
- TypeScript do projeto, build do servidor, assets e build do harness passaram. Lint de 13 arquivos passou sem erros, com seis avisos. A suíte completa não foi executada.
- Os logs preservam o primeiro schema rejeitado, problemas de montagem da fixture corrigidos e a reprodução da corrida de expiração após handoff. A primeira execução Python usou o pacote errado; a execução final foi feita no diretório `apps/computer`, com os imports usados pelo projeto.
- Fontes, logs e arquivos compilados estão registrados por hash em `artifacts/harness-parity-20261009/round72-local-verification-manifest.json`.

**Ainda faltam** despacho automático, tratamento da fase/circuito de novas tentativas dos cards expirados, entrega à conversa original, contratos de objetivo/PR/CI, herança completa de projetos, rollout do executor registrado e teste natural no app. A comprovação factual integral da pesquisa, todas as operações do Workspace e a performance sustentada também continuam abertas. Não houve modificação de produção, novo APK ou criação de registros públicos de QA nesta etapa. A última API publicada continua em `c0c2c9ec`.
