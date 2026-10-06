# Detalhes de etapas, memória e skills: recuperação em produção

Entrega de 6 de outubro de 2026. Complementa o diagnóstico do harness em
`2026-10-06-native-harness-direct-flow.md`; não encerra as questões de autonomia
e desempenho registradas naquele documento.

## Causas confirmadas

A tela de detalhes selecionava eventos com apenas o nome da etapa e ignorava as
operações que a API já devolvia. Na tarefa original “Infográfico: Gemini 4 Argon”,
as cinco etapas de ferramentas tinham detalhes vazios, embora os recibos existissem.

A manutenção percorria tarefas removidas logicamente e `publishOutcome` chamava
`getTask`, que lança 404 para uma tarefa excluída. A exceção interrompia o ciclo
antes do agendamento de memória e proatividade. O problema foi reproduzido em
teste antes da correção. Em produção, a revisão proativa estava parada desde
2026-10-05 08:21:37 UTC e a revisão de memória desde 07:59:40 UTC, apesar de ambas
estarem habilitadas.

Os procedimentos aprendidos ficavam no armazenamento de playbooks, enquanto
`skills_search` e `skills_read` acessavam somente skills de arquivos. Além disso,
a revisão de memória descartava mensagens que não cabiam em 32 mil caracteres e
desencorajava aprender métodos de trabalhos bem-sucedidos sem técnica nova.

## Correções

- Eventos novos registram o ID da operação. Eventos antigos recuperam o vínculo
  somente quando tarefa, ferramenta e intervalo de tempo identificam um único
  recibo. A tela mostra entrada, resultado e status registrados.
- A API remove campos sensíveis dos argumentos e recibos. O vínculo respeita o
  proprietário; não cria detalhes para eventos históricos ambíguos.
- Publicação de resultados e telemetria de procedimentos toleram tarefas removidas.
  Tarefas excluídas também não entram como novas fontes de aprendizado.
- O catálogo de skills inclui procedimentos aprendidos elegíveis do mesmo
  armazenamento. Uma leitura completa registra a versão consultada; busca e
  listagem não contam como uso. Métodos arquivados ou sem ferramentas disponíveis
  permanecem inelegíveis.
- O orçamento do modelo selecionado controla o contexto da revisão; o corte fixo
  de 32 mil caracteres foi removido. Há regressão com evidência autenticada maior
  que esse corte, persistência e recuperação da memória resultante.
- Métodos reutilizáveis de trabalhos verificados podem ser aprendidos mesmo sem
  um erro anterior. Fatos temporários não viram preferências pessoais, e métodos
  existentes são consultados para evitar duplicatas.

## Evidência real

A navegação na aplicação publicada confirmou os detalhes da entrega e da geração
de imagem da tarefa original. A geração tem recibo `gpt-image-2`, provedor `codex`.
As cinco etapas ficaram vinculadas, sem refazer a imagem. Status, pedido, resultado,
arquivos e data de atualização da tarefa original permaneceram iguais.

A proatividade retomou automaticamente e concluiu uma revisão em
2026-10-06 08:39:09 UTC. A memória processou as fontes pendentes nas gerações 20 e
21, com última revisão registrada em 08:40:11 UTC e nenhum erro pendente. E-mail
e calendário estão desconectados; a revisão registra essa indisponibilidade.

Após corrigir a política, uma revisão adicional foi disparada explicitamente no
mesmo worker de aprendizado, usando apenas a tarefa original verificada como
fonte. O modelo efetivo continuou `chatgpt/gpt-6-luna`, sem alterar a preferência.
Ele salvou automaticamente o método “Research and create a sourced infographic”,
com recibo de `learn_procedure` bem-sucedido e referências às operações originais.
Uma segunda tarefa consultou a nova skill com `skills_search` e `skills_read` e
entregou um resumo textual correto. Isso comprova criação, descoberta e leitura;
não é uma medição de aprendizado espontâneo em todos os modelos.

Não foram inseridos fatos pessoais artificiais para aumentar o contador de memória.
A persistência de fatos com evidência, recuperação em outra pergunta, isolamento,
correções e proteção de fontes esquecidas foram verificadas em testes isolados.

As duas tarefas de diagnóstico concluídas foram arquivadas e removidas logicamente.
O método aprendido, cujo conteúdo veio da tarefa real, permaneceu disponível. O
dispositivo temporário de diagnóstico foi revogado; a tarefa original não foi removida.

## Validação e distribuição

A execução ampla deste escopo passou 120 de 121 testes. O caso restante tinha uma
fixture sem o campo obrigatório `reason` ao arquivar um método; a fixture foi
corrigida e os 11 testes de skills, manutenção e playbooks passaram. O ajuste de
evidência e política passou mais 18 testes, incluindo a regressão nova do corte
de contexto. Tipos do servidor e app, compilação dos dois candidatos e export web
passaram. Lint não teve erros; há avisos de estilo existentes. Não se afirma nova
execução integral da suíte do repositório.

- Commits de implementação em main: `5731b240` e `e02fe7f8`, enviados ao origin.
- API final: fonte `5fdfe1b97d647130cd6a80b0cb923c7913b21837`, tag
  `deploy/step-memory-final-20261006-5fdfe1b`.
- Imagem: `sha256:b1a2c87f5bdfe77813bef0842a1412961ed53798865ffc03da3eb52c8b013b38`.
- Web: `/opt/okami-web/releases/step-memory-20261006-bc60df4`, fonte do app
  `5731b240d045ea3f07ed7430cca8f3be3cd6aa6e`.
- Bundle: `_expo/static/js/web/index-529809824fba30016626c81e3e32f9f0.js`.
- HTML público SHA-256:
  `373d73a154ea301fee74a54e34db434b5c08fae51081cd7a3384f6cad302866d`.

A API inclui o conjunto compatível de memória, procedimentos, recuperação de
histórico e eventos proativos que já estava em main, mas não na release anterior
restrita ao harness. O harness compilado original permanece na revisão
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`.

HTML e bundle foram comparados por SHA-256 na origem tailnet e no domínio público.
Somente o destino web `/` foi atualizado no Tailscale Serve. API, executor e rotas
de downloads foram preservados. Não houve publicação de APK nem alteração no
supervisor nativo nesta entrega.

Às 08:51 UTC, API e browser estavam saudáveis, sem tarefas, conversas, admissões,
entregas nativas ou manutenção ativas. A pausa original continuava desativada,
revisão 16. Os 21 registros históricos de operações e dois recursos retidos foram
preservados. Não houve limpeza forçada nem alteração de credenciais do usuário.

Os recibos completos, logs e snapshots de diagnóstico estão no diretório privado
`artifacts/step-details-memory-20261006/` e no diretório equivalente do operador
no VPS; não fazem parte do repositório publicado.
