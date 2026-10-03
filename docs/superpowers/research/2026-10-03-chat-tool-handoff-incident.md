# Infográfico interrompido no chat e conexão Google antiga

## Evidência do uso real

O usuário rejeitou novamente a entrega: o chat pesquisou eleições e respondeu
que não conseguia gerar/anexar a imagem. A autorização Codex continuava ativa.
O histórico de eventos da execução `d47ea8a2-e845-4b2b-9286-903f6e9086c9`
contém 20 chamadas de `search_web`/`web_fetch`, nenhuma geração e nenhuma
delegação. A resposta começou com a impossibilidade de entregar a imagem.

O código do chat reservava a última etapa de suas dez iterações para uma
resposta sem ferramenta alguma. A instrução dizia explicitamente que as
ferramentas estavam indisponíveis. Isso também removia `generate_image` e
`delegate_task`, mesmo quando a pesquisa era apenas uma etapa do pedido.

O teste real anterior de GPT Image começava em `createTask`, diretamente no
executor. Ele comprovava geração e publicação, mas não percorria o chat com
pesquisa prévia. Essa lacuna permitiu publicar a correção anterior sem detectar
o encerramento prematuro na entrada usada pelo titular.

Uma segunda mensagem do usuário, pedindo a devolução em imagem, chamou
`generate_image`. A tarefa `f5db34e91e887c5af0548462491eb6ec6551d7bf0e456db313c7d872755792ba`
concluiu com critério de arquivo verificado e PNG de 1.486.887 bytes. O arquivo
foi baixado e aberto durante o diagnóstico. Isso comprova a disponibilidade do
gerador e a entrega; não é uma verificação independente dos dados eleitorais.
Nenhuma tarefa do usuário foi reiniciada ou cancelada durante o diagnóstico.

## Referência OpenClaw

A revisão anterior leu o commit `da979df299e88c3711f6ee2cd3c7443dd045584b`.
A documentação oficial foi consultada novamente neste incidente:

- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop): o ciclo integra
  admissão, contexto, inferência, ferramentas, transmissão e persistência.
  Texto do assistente e término da execução são eventos distintos.
- [Image generation](https://docs.openclaw.ai/tools/image-generation): geração
  assíncrona retorna uma tarefa, e a conclusão entrega os anexos estruturados ou
  uma falha visível. Nossa tarefa durável já fornece esse caminho.
- [System prompt](https://docs.openclaw.ai/concepts/system-prompt): instruções
  refletem capacidades disponíveis e distinguem conclusão do executor de
  realização do objetivo pedido.

Não houve incorporação de código OpenClaw. A correção precisa manter a
possibilidade de encaminhar trabalho antes de retirar as ferramentas do chat,
preservando o orçamento e evitando uma segunda tarefa para trabalho já iniciado.

## Conexão Google

Gmail e Agenda na seção de conexões antigas ainda chamavam OAuth nativo, que
exigia variáveis de servidor ausentes. A instalação também não tinha chave de
projeto Composio configurada. Portanto, trocar apenas a mensagem de erro não
resolveria o fluxo.

A disponibilidade do OAuth nativo passa a ser consultável por endpoint
autenticado. Quando não configurado, a interface abre o serviço correspondente
no catálogo e apresenta a ativação privada do Composio. Uma conta nativa
existente mantém seus controles; uma instalação nativa configurada preserva seu
OAuth. A seleção Gmail/Agenda deve sobreviver à ativação do catálogo.

Não foi cadastrada uma chave sintética na produção. A conexão real de uma conta
Google por Composio ainda exige a chave do projeto e o consentimento do titular.

## Critérios de verificação

1. Pesquisa no chat pode chegar ao limite e ainda encaminhar o infográfico,
   incluindo fatos, fontes, pedido original e conversa de origem.
2. Uma tarefa já iniciada não é duplicada na etapa reservada para encaminhamento.
3. Perguntas respondíveis com texto continuam recebendo uma resposta; cancelamento
   e pausa não provocam nova execução.
4. Um ensaio real começa em `ConversationAgent`, recebe o pedido completo e
   acompanha a tarefa até o PNG publicado na mesma conversa isolada.
5. Gmail e Agenda sem OAuth nativo abrem o serviço correto e sua ativação privada,
   sem POST para a rota nativa indisponível.
6. OAuth nativo configurado, modo de amostra e gestão de contas existentes
   preservam seu comportamento.

## Verificação antes da publicação

A regressão começou vermelha: o chat pesquisava até o limite e não deixava
nenhuma tarefa. Com a correção, oito rodadas de pesquisa são seguidas por uma
rodada reservada ao encaminhamento e pela resposta final, dentro das mesmas dez
iterações. A tarefa mantém o pedido original e recebe os dados/fontes em
`delegatedBrief`. O teste percorre o executor, a verificação do PNG e sua
publicação na conversa. Cinco testes cobrem esse caminho, resposta informativa,
delegação prévia, falha transitória ao criar tarefa e cancelamento antes do
encaminhamento. Uma revisão independente não encontrou defeitos bloqueadores.

O ensaio real com o pedido eleitoral exato criou a tarefa pelo chat, mas a busca
pública isolada não conseguiu verificar fontes. O executor terminou como falha
verificada como incompleta, sem arquivo nem sucesso fictício. O recibo desse
ensaio é preservado separadamente; ele não conta como entrega de imagem aprovada.
Outro ensaio usa dados fornecidos no próprio pedido para verificar a geração
real e a publicação, sem depender da disponibilidade da pesquisa eleitoral.

O navegador verificou Gmail e Agenda com transporte Composio simulado, desde a
ausência de configuração até os dois pedidos de autorização corretos. Não houve
POST para o OAuth nativo. Os 22 testes de compatibilidade do servidor e os 12
testes focados de roteamento passaram. As capturas Orca eram placeholders e não
são evidência visual aprovada; snapshots de acessibilidade e requisições foram
preservados.

A primeira suíte completa teve 1.102 aprovações e uma falha em um teste antigo
do executor remoto: seu prazo de 50ms expirava antes de o executor simulado
enviar um recibo. A falha foi reproduzida com atraso explícito e corrigida com
sincronização no teste, preservando as verificações e todo o código de produção.
Os 14 testes daquele arquivo passaram. A suíte completa será repetida.

Resultados finais e publicação serão registrados após a verificação.
