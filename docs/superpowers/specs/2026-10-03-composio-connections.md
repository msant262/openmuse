# Catálogo de conexões Composio no OkamiBot

## Objetivo autorizado

O usuário quer descobrir, conectar e gerenciar os serviços dentro do aplicativo,
sem alterações de configuração para cada provedor. O catálogo precisa alimentar
as ferramentas reais do agente. Preservar a conexão ChatGPT/Codex para geração
de imagens, as credenciais genéricas e os serviços nativos existentes.

## Experiência

Configurações → Conexões oferece Explorar e Conectadas. Explorar consulta o
catálogo oficial com busca, categorias e paginação; não há uma lista limitada
embutida no código. Conectadas reúne contas, estado, reconexão e desconexão.
Uma configuração inicial do projeto Composio fica no app, com campo privado e
chave armazenada no cofre. Nenhuma chave entra no histórico da conversa.

Ao precisar de um serviço, o agente descobre ferramentas, identifica a conta e
abre uma solicitação de conexão. O modal único apresenta a autorização oficial
Connect Link, que pode coletar OAuth ou credenciais conforme o serviço. A tarefa
aguarda e continua quando o servidor confirmar a conta. Fechar o modal não cria
novas perguntas. Cancelar encerra apenas a tentativa/tarefa correspondente.
O navegador do sistema é usado para autorizar contas; pesquisas e operações
normais usam as ferramentas conectadas quando disponíveis.

## Integração

Usar REST v3.1 de https://backend.composio.dev/api/v3.1. Sessões são persistidas
por proprietário; o modelo não escolhe user_id, sessão, chave de projeto ou
classificação do efeito. Projetar respostas de contas por whitelist porque os
endpoints administrativos do Composio também contêm material de autenticação.
O segredo do projeto fica em referência dedicada inacessível ao executor HTTP
genérico. Todo callback apenas provoca reconsulta: sucesso depende da conta e
do proprietário confirmados no servidor.

Descoberta preguiçosa retorna schemas das ferramentas relevantes e bindings
opacos. Executar uma ferramenta por operação, com sandbox remoto desativado.
Leituras explicitamente classificadas seguem o journal; escritas passam pelo
ActionService; ações financeiras mantêm revisão. Revalidar schema/conta antes
do despacho. Não expor executores amplos, proxy arbitrário ou workbench como
atalho para escapar dessas regras. Falha/timeout não pode virar sucesso nem
provocar repetição automática de escrita.

## Verificação

Cobrir configuração privada, catálogo/paginação, isolamento entre proprietários,
fluxo persistente, reutilização, expiração/cancelamento, pausa e retomada da mesma
tarefa, efeito/revisão e recibos. Verificar o layout desktop/móvel e preservar
ChatGPT, avatar e dados existentes na publicação. Testes com transporte simulado
não serão apresentados como autorização real de contas. O projeto não possuía
chave Composio configurada no início desta implementação.

## Referências consultadas

- https://github.com/ComposioHQ/composio
- https://docs.composio.dev/docs/configuring-sessions
- https://docs.composio.dev/docs/authentication/manually-authenticating
- https://docs.composio.dev/reference/api-reference/toolkits/getToolkits
- https://docs.composio.dev/docs/agent-setup/unattended-authentication

A conta automática de agente é separada da conta humana; não a criar como
substituto silencioso da conta do titular. O catálogo e a autorização dependem
do serviço hospedado Composio e de uma chave de projeto válida.
