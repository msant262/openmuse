# Revisão do harness após os testes reais de uso

As quatro capturas do usuário rejeitam a entrega anterior. O Feed exibia recibos
de operações internas, Objetivos misturava idiomas, o desktop escondia controles
de conversas e não havia escolha de modelo. O pedido de infográfico entrou no
fluxo de preencher PDF recebido por e-mail. O pedido de conectar Tavily recebeu
instruções genéricas em vez de um formulário seguro.

## Evidência e referência

A tarefa real `bacf1b4f4f56c86377519be439ad5674e389a3ea7d908ab97dbb0523ec63cddc`
foi consultada pela API sem alteração. Ela tinha `kind: document`, nenhuma
operação executada e critérios automáticos de PDF preenchido e envio de e-mail,
apesar de pedir um infográfico. O erro de escolher um e-mail com PDF era resultado
direto do roteamento, não da qualidade do modelo.

O código de [OpenClaw](https://github.com/openclaw/openclaw) foi estudado em
`da979df299e88c3711f6ee2cd3c7443dd045584b`, sem executar seus scripts. Referências:

- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop): separar eventos de
  ferramentas, resposta visível e confirmação de entrega; preservar resultado
  de falha mesmo quando o modelo redige uma resposta.
- [System prompt](https://docs.openclaw.ai/concepts/system-prompt): capacidades
  concretas e contexto delimitado, em vez de promessas genéricas sobre ferramentas.
- [Image generation](https://docs.openclaw.ai/tools/image-generation): seleção
  independente do provedor de mídia, consulta de capacidades e entrega do arquivo.
- [Sessions and sidebar](https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar):
  ações visíveis para arquivar, restaurar e excluir; rascunhos descartados somente
  depois da confirmação da exclusão.
- [Secrets](https://docs.openclaw.ai/gateway/secrets): referências privadas para
  credenciais, sem transportar valores secretos pelo histórico do modelo.
- [Tavily](https://docs.openclaw.ai/tools/tavily): busca como ferramenta HTTP com
  provedor configurado.

O adaptador OpenAI de OpenClaw distingue Codex OAuth de
`chatgpt-token-sharing`. O app usa a segunda modalidade. Uma chamada isolada,
com a credencial existente protegida e sem abrir o banco de produção, retornou
HTTP 400 `subscription_sharing_unsupported_capability` ao solicitar
`image_generation`. Portanto, a conexão ChatGPT atualmente instalada não deve
ser apresentada como autorização para GPT Image. O usuário explicitou que a
assinatura ChatGPT também precisa gerar imagens, mesmo exigindo outra conexão.
A implementação deve oferecer uma conexão Codex OAuth independente, com
[autenticação por dispositivo](https://developers.openai.com/codex/auth), sem
substituir o grant existente e sem recorrer silenciosamente a cobrança de API.
O gerador disponível na conta Grok conectada continua independente do modelo do chat.

## Critérios de verificação

1. Um pedido de criar imagem/infográfico não exige e-mail ou PDF; sucesso requer
   um arquivo de imagem real, disponível para abrir/baixar na conversa.
   A assinatura ChatGPT deve ser conectável por Codex OAuth para GPT Image;
   Grok é uma alternativa, não um requisito para quem tem apenas ChatGPT.
2. Uma falha de ferramenta aparece como falha, sem confirmação falsa de entrega.
3. Pedir para conectar Tavily abre o campo seguro; uma chave de teste nunca aparece
   em mensagens, argumentos de ferramentas, recibos públicos ou erros.
4. A chave salva permite usar Tavily; desconectar remove seu acesso. A ausência
   do provedor conserva a busca HTTP existente.
5. Escolher modelo persiste por proprietário e afeta as próximas execuções; o
   catálogo não confunde assinatura conectada com capacidades indisponíveis.
6. Renomear, arquivar, restaurar e excluir funcionam no desktop e no celular.
   Exclusão remove a transcrição e impede sua recriação por clientes atrasados;
   arquivos, tarefas e memórias salvos têm ciclo de vida próprio.
7. Feed e painel lateral não mostram observação do desktop, listagem interna do
   computador ou varredura de proatividade como novidades para o usuário.
8. Objetivos e configurações respeitam o idioma selecionado. Inspeção visual usa
   dados equivalentes aos casos reais, além dos exemplos de demonstração.

Resultados de execução, builds e publicação serão registrados depois dos testes.

## Verificação real da assinatura ChatGPT

O titular concluiu o device auth oficial. A credencial Codex foi salva em arquivo
privado separado, acessível pelo usuário do serviço; a conexão de chat existente
foi preservada. Nenhuma chave de API paga foi usada.

Um processo isolado, sem acesso ao banco de produção e com Grok desabilitado,
executou um pedido em português para criar um infográfico sobre cuidados de uma
planta. A tarefa entrou como `document`, foi corretamente normalizada para
`agent`, chamou `image_generation_status`, `generate_image` e `finish_task`, e
terminou como `succeeded` com conclusão `verified`. A imagem foi publicada na
conversa de origem: PNG de 2.302.462 bytes, SHA-256
`991239613aa80274816b5f01d2e2c43bbbf9357df29f2ea756b624adf588cf5c`.
O modelo de imagem foi `gpt-image-2`, exclusivamente pelo Codex OAuth da assinatura.
A imagem foi aberta e inspecionada visualmente. Não houve perguntas nem navegador.
Evidências locais: `artifacts/harness-v2/gpt-image-real-smoke.json` e
`artifacts/harness-v2/gpt-subscription-infographic.png`.

Outro chat real recebeu o pedido de conectar Tavily e usou `connect_integration`.
O resultado foi um único formulário com campo `password`, sem criar tarefa ou
sessão de navegador e sem pedir a chave na conversa. A gravação e uso da chave
foram verificados com cofre e endpoint de teste; não havia chave Tavily real do
titular disponível. Evidência: `artifacts/harness-v2/tavily-real-chat-smoke.json`.

A suíte completa passou em 1.034 testes; TypeScript e Biome terminaram sem erros.
Uma revisão posterior fortaleceu a exclusão contra um formulário Tavily iniciado
antes do DELETE: a checagem ocorre sob o mesmo lock transacional e bloqueia a
recriação de interação/evento. Cinco testes de ciclo de vida passaram, incluindo
essa corrida, isolamento entre usuários e limpeza de caches da conversa.
A verificação visual e de interação cobriu desktop e celular, ações de chats,
rascunhos preservados, exclusão em outro dispositivo, conexão Codex e formulários
Tavily/modelos. Recibos: `artifacts/desktop-usability-v2/`.
