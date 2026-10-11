# Despacho automático e continuidade de cards — 11/10/2026

**Implementado e verificado localmente depois de `a81475e5`. Ainda não publicado nem aceito por pedido natural no app. O objetivo completo permanece aberto.**

O ciclo existente de rotinas agora descobre cards elegíveis e chama o dispatcher que grava card, run, tarefa nativa e vínculo na mesma transação. Não existe outro executor. A consulta retorna somente identificadores e revisões, respeitando dono, perfil, opt-in da plataforma, dependências e pausa. Mensagens, corpos de documentos e histórico completo não entram nessa seleção. Uma recusa de preparação registra motivo e espaça as tentativas, sem consumir o circuito de falhas da execução; mudanças do card ou da configuração permitem uma nova avaliação.

A ferramenta de criação registra a tarefa e a conversa de origem a partir da autoridade do host. Esses campos não vêm dos argumentos do modelo. A entrega usa o caminho existente de publicação idempotente na conversa correta. Uma conversa removida impede nova execução, inclusive quando a exclusão ocorre depois da preparação, no instante da gravação do claim. O usuário de outra conta não é afetado.

O host observa tentativas nativas terminadas. Uma falha confirmada encerra o run e restaura sua fase de implementação ou revisão. Falhas consecutivas usam o padrão de duas tentativas de [Hermes e0550c97](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/hermes_cli/kanban_db_dispatch.py); o perfil autenticado pode configurar `dispatchFailureLimit`. Esse circuito conta tentativas que realmente falharam, não chamadas do modelo ou ferramentas. Um handoff bem-sucedido reinicia a contagem. Cancelamento não inicia outra tentativa; retomada explícita conserva a fase.

Uma operação incerta ou limpeza pendente mantém o claim protegido. Confirmação da parada física não torna conhecido o resultado externo. A barreira SQL também rejeita uma incerteza surgida no instante da gravação. Quando a reconciliação efetivamente registra um resultado conhecido, a próxima avaliação pode prosseguir. Recibos incertos não são apagados, alterados para sucesso ou ignorados.

Foi reproduzida outra falha: uma nova tentativa começava sem as fontes e os arquivos já obtidos. A continuidade agora conserva evidências e IDs dos arquivos reais, e consulta os recibos originais das tentativas anteriores do mesmo dono, board e card. Não copia ou reescreve os recibos canônicos. Chamadas concretas já concluídas recuperam o resultado; igualdade de argumentos sem identidade concreta não funde intenções distintas. Os checks finais da tentativa anterior impedem criar a sucessora se surgir uma operação incerta depois da primeira leitura. Uma orientação ainda não aplicada à tentativa anterior é explicitamente preservada como barreira; a transferência desse caso permanece pendente de integração.

## Verificação e alcance

- A reprodução inicial falhou em **4/4 cenários**, por ausência de despacho automático. A reprodução de continuidade falhou separadamente porque a evidência da nova tentativa estava vazia.
- O grupo ampliado passou em **114/114 controles**, em 14 arquivos, sem falhas, cancelamentos ou skips, em **111,570 segundos**. Depois dos dois ajustes finais de fase/contagem, os quatro arquivos diretamente afetados passaram novamente em **41/41 controles**, em **28,963 segundos**. São grupos sobrepostos, não 155 testes distintos.
- O novo arquivo contém **13 cenários**, incluindo ciclo automático/worker/publicação, dependências e donos, pausa, backoff, revisão, cancelamento, falsas conclusões, exclusão de conversa, recibos/arquivos preservados e corridas no instante da gravação. A prova de não repetir envio usa um efeito local contado, não um novo e-mail real no Google.
- TypeScript do projeto, build do servidor, assets e harness passaram para a versão final. Lint dos sete arquivos passou sem erros, com três avisos. Não foi executada a suíte completa.
- Os testes usam Store/PGlite, worker e caminhos reais do aplicativo, com provedor e serviços externos de teste. Não são aceitação natural com Luna nem execução no computador registrado. Nenhuma mudança foi publicada, nenhum APK foi criado e nenhum dado de produção foi escrito nesta etapa.
- Logs, fontes e arquivos compilados estão registrados por hash em `artifacts/harness-parity-20261009/round74-local-verification-manifest.json`.

**Ainda faltam** contratos de objetivo/PR/CI, integração das retomadas com orientações/decisões pendentes, herança completa de projetos, rollout do executor registrado, publicação e pedidos naturais pelo chat. A comprovação factual integral da pesquisa, todas as operações do Workspace, revisão ampla de UX e performance sustentada permanecem abertas.

A amostra de produção de **13:16:19 UTC** foi: API **849,3 MiB / 5,41% CPU**, navegador **188,9 MiB / 0,01% CPU**, OpenBao **93,55 MiB / 1,12% CPU**. Não estabelece ausência de trabalho naquele instante ou melhora sustentada. A inspeção encontrou varreduras de rotinas e publicações proativas no ciclo de um segundo; seu custo ainda precisa ser medido antes de atribuir a causa do consumo. A API publicada continua em `c0c2c9ec`.
