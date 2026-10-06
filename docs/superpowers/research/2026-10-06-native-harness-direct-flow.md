# Harness de pesquisa e imagem — estado em 6 de outubro de 2026

## Resultado e limite da entrega

As correções abaixo estão em `main` e publicadas na API e no web. Luna continua
como executor e GPT Image 2 como gerador. **A autonomia e o desempenho ainda não
estão aprovados.** Uma execução independente entregou o mapa com os 54 percentuais
corretos, mas levou 9min23s. As duas seguintes falharam na cobertura dos dados ou
fizeram uma pergunta desnecessária. Testes de contrato e existência de arquivo
não substituem essas validações reais.

Cada reprodução recebeu o pedido original de mapa com dois candidatos por UF e
o ano 2026. O operador não forneceu fontes, percentuais nem respostas para
contornar as perguntas indevidas. Recibos e imagens permanecem no arquivo privado
do diagnóstico, fora do Git.

| Execução | Resultado observado | Tempo | Avaliação |
| --- | --- | --- | --- |
| Original, retomada após informar o ano | PNG com 54 valores conferidos contra a agregação municipal usada | 818,2s | Correto para a fonte usada; desempenho excessivo |
| Reprodução 17, fonte `b7431e7` | Mapa geográfico, 27 UFs e tabela com os dois percentuais; 54 valores conferidos nos pixels contra o JSON consolidado lido | 563,5s | Passa funcionalmente; 9min23s continua excessivo |
| Reprodução 18, fonte `c9dcb4a` | Apenas os percentuais dos 27 líderes; declarou parcial, depois mudou somente o status para concluído | 256,1s | Falha; a publicação seguinte impede essa troca sem progresso |
| Reprodução 19, fonte atual `c8ac1fa` | Fonte municipal integral preservada; perguntou se podia usar o publicador sem confirmação direta no TSE; nenhum PNG | 143,6s até a pergunta | Falha de autonomia; não foi respondida para aparentar sucesso |

A conferência da reprodução 17 valida os números contra a fonte consolidada
atribuída ao publicador, sem alegar conferência direta no TSE. A fonte municipal
e a consolidada têm quatro percentuais divergentes em DF/MT; não se troca o
snapshot ou método usado sem registrar essa diferença. O gerador foi
`gpt-image-2`, provider `codex`; a chamada levou aproximadamente 106 segundos.
A maior parte dos 563,5 segundos ficou na pesquisa e preparação, incluindo
releituras e timeout de fonte.

## Código original e fronteiras da aplicação

O `runEmbeddedAgent` original controla loop, ferramentas, recuperação e
compactação. Os 10.664 arquivos registrados em `UPSTREAM.json` permanecem
inalterados, pin `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`, versão 2026.9.8,
licença MIT. Não se instalou o produto OpenClaw.

Autenticação, arquivos, computador remoto, persistência de operações e formulários
pertencem ao host. Essas fronteiras precisaram de correções; ter o código original
no repositório não prova equivalência com a configuração do OpenClaw do usuário.
Essa configuração e seu trace de dois minutos não foram obtidos. DeepSeek, MiMo
e MiniMax não foram validados ao vivo nesta sessão.

## Correções publicadas

- Pesquisar, gerar e concluir ocorre no mesmo executor. Revisões independentes de
  briefing/entrega são opt-in por `AGENT_RESEARCH_REVIEW_ENABLED=true`, desligadas
  nesta produção. A reescrita adicional `TASK_REPLY_VOICE` foi removida; SOUL e
  humanizer continuam no executor.
- A data nativa já chegava ao modelo. `session_status` original está disponível,
  e o formatador original anexa hora UTC ao transporte sem reescrever o pedido
  ou recriar a história. Pedir a data não era ausência total de relógio.
- O contexto declarado do Luna é 1.050.000 tokens. Foram removidos os cortes de
  12 turnos/64 mil caracteres no repasse e 32 mil caracteres em mensagens de
  usuário/assistente. Admissão e compactação usam o contexto do modelo. Testes
  conservam o primeiro turno de 40 mensagens e textos com mais de 200 mil
  caracteres; isso não é medição ao vivo com 200 mil tokens.
- A descoberta original `tool_search`/`tool_describe`/`tool_call` permanece.
  Ferramentas frequentes de pesquisa, imagem e conclusão ficam diretamente
  disponíveis; instruções detalhadas acompanham famílias selecionadas. Gerar
  imagem não carrega todas as instruções de Office/PDF.
- A proteção original contra repetição permanece. Duplicatas do wrapper
  `tool_call` saem somente quando seu filho foi executado; resultados filhos e
  wrappers não executados permanecem. Os antigos tetos de 64/96 passos foram
  removidos. Limites de transferência, prévias e resultados individuais ainda
  existem e não equivalem à janela do modelo.
- Modelos OpenAI conhecidos recebem o esforço de raciocínio original por rota;
  `medium` do Luna chega ao provedor. Rotas desconhecidas conservam seus defaults.
  Não houve troca do executor para Astra. A ponte Codex de geração pode usar um
  modelo de texto interno; não se afirma ausência total de Astra na infraestrutura.
- `web_fetch` usa o extrator Markdown original no HTTP, preserva links junto dos
  rótulos e distingue reportagem, snippets e dados. Um 404 pode retornar URLs
  exatas observadas, sem inventar ou ler endpoints sozinho. Busca tenta primeiro
  o backend HTTP disponível e conserva alternativas.
- JSON/JWS publicado tem transferência até 16 MiB e usa HTTP, inclusive quando
  se pediu headless. HTML conserva orçamento próprio. O leitor negocia gzip,
  deflate e Brotli com limite sobre bytes descompactados e validação de destinos.
  Gzip reduziu a base municipal de 10.208.549 para 1.020.393 bytes; leituras em
  4,34s e 1,64s não demonstram ganho de tempo por compressão.
- Fontes excedentes são preservadas integralmente em arquivo interno privado.
  `spill.fileId` e hash identificam o snapshot; `import_computer_file` e
  `run_computer_command` permitem analisá-lo sem baixar outra vez. Esses arquivos
  não aparecem como entrega. `maxChars` é admitido proporcionalmente ao contexto;
  resultados grandes continuam recuperáveis por recibos/paginação.
- Consultas estruturadas rejeitam campos fora do contrato e agregam o conjunto
  antes de filtrar/paginar. Prévia incompleta não prova ausência de dados. Falha
  de renderização pode usar HTTP público; URL privado e cancelamento não recebem
  esse fallback.
- Comandos falhos conservam saída, exit code e limpeza confirmada em recibo
  durável. Reconciliação exige prova nativa e vínculo exato, sem repetir efeitos.
  Status do computador deixa de injetar scripts e saídas de outras tarefas.
- Texto sem arquivo não conclui imagem. Um rascunho parcial com caminhos observados
  pode continuar no mesmo executor. Novos fatos permitem progresso; releituras
  idênticas não criam continuação indefinida. Após declarar um arquivo parcial,
  mudar apenas para `completed`, mantendo evidência e arquivo iguais, não resolve
  requisitos. Essas verificações mecânicas não certificam a exatidão de fatos.
- O supervisor publica resultados antes da espera por comandos, verifica jobs
  ativos a cada segundo e mantém espera longa ociosa. Antes, uma espera de até
  15 segundos atrasava resultados prontos.
- No chat, a análise deixou de copiar todo o prefixo por mensagem. Índices de
  mensagens, ferramentas e reações são memorizados enquanto seus dados não mudam.
  Todos os turnos permanecem. Em cinco amostras, a mediana do trecho com 20 mil
  mensagens caiu de 178,381ms para 0,070ms. Não é FPS: `ScrollView` ainda monta o
  histórico completo.

## Validação e distribuição

O estado de publicação abaixo descreve esta entrega anterior. A atualização
posterior de detalhes, memória e proatividade está documentada em
[2026-10-06-step-details-memory-recovery.md](2026-10-06-step-details-memory-recovery.md).

O último ajuste passou 49 testes de fontes/conclusão, tipos do servidor e
compilação do candidato isolado. O chat passou 28 testes, tipos do app e export
web. O supervisor passou 60 contratos nativos. Lint terminou sem erros.
Testes anteriores estão nos commits anteriores. A suíte ampla anterior passou
1.481 de 1.482 testes; o caso restante era uma fixture que contava GET como
inferência, corrigida e validada isoladamente. Não se afirma nova execução
integral verde.

API publicada sobre a base de produção `73b15b5`, somente com as fronteiras
autorizadas deste trabalho:

- Fonte: `c8ac1fa0fc357c4a9d7d7417fd2461b1a0c117ba`.
- Tag: `deploy/harness-direct-20261006-c8ac1fa`.
- Imagem: `sha256:12a060efa81df1a8e7909ed6d81a95aa8ff78efb6528e95f43c8a6bcc97f703a`.
- Web: `/opt/okami-web/releases/harness-native-20261006-9e2345e-chat`, com origem do
  app em `9e2345e40df9041d4619ec2428fae7504851a69b`.
- SHA-256 do HTML público: `3a55758ffafab47b7677a91a2b7240da6fbd026f5440fc1a884018fd692c8831`.
- Supervisor: `0dbba0c64ad33f3cfe503d0cd53c980ad87c3aebdbd8c0aec44f9fc6a3cfd5d4`.

HTML e bundle publicados foram conferidos byte a byte pela origem tailnet e pelo
domínio público. A primeira publicação web foi revertida na verificação; um 404
anterior do bundle permanecia no cache CDN. A release final usa nome exclusivo
e passou ambas as verificações. Rotas de API, executor e APK foram preservadas;
não houve novo APK. A prévia local retornou erros de automação. Depois, a navegação
na produção pelo browser colaborativo funcionou: a inspeção DOM confirmou o novo
bundle carregado e o chat com a tarefa original. A captura de tela continuou
falhando; não se apresenta isso como inspeção visual ou medição de chat longo.

Os 19 diagnósticos próprios tiveram recibos privados arquivados e foram retirados
da lista por exclusão lógica. Somente os dois aguardando entrada foram cancelados.
A tarefa original do usuário e seus arquivos permaneceram iguais. Os 21 registros
históricos de operações e dois recursos retidos foram preservados; não se forçou
limpeza de resultados incertos.

A sessão de dispositivo criada exclusivamente pelo diagnóstico foi revogada.
O computador permaneceu conectado no epoch 31; o supervisor e seu serviço foram
conferidos, e somente os dois scripts temporários desta publicação foram removidos.
O servidor local da prévia também foi encerrado. A checagem final encontrou API e
browser saudáveis, zero tarefas/conversas/entregas nativas ativas, nenhuma manutenção
aberta e o estado de pausa original preservado.

Existe apenas o checkout principal; `git worktree prune --dry-run` não encontra
worktrees órfãos. Há 38 branches locais sem ancestralidade com main: quatro têm
somente patches equivalentes, enquanto 34 têm patches não reconhecidos como
idênticos por `git cherry`. Isso requer análise própria antes de chamá-las de
integradas; nenhuma foi apagada ou mesclada às cegas. `.orca/` permanece intocado.

Permanecem pendentes a falha de confirmação pública da reprodução 19, a meta de
tempo relatada pelo usuário, a medição real da primeira resposta e do chat longo,
e a comparação com as ferramentas/provedor do seu OpenClaw.
