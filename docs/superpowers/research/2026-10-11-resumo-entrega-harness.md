# Relatório do trabalho e pendências — atualizado em 12/10/2026

**O harness completo ainda não está entregue.** Há correções publicadas e
testes reais com efeitos confirmados. O pedido comum mais recente entregou um
PDF sozinho em 3min27s, sem o loop anterior, mas ainda deixou informações sem
confirmação. O critério de aceite exigido pelo usuário permanece aberto.

## Publicação conferida

Em **12/10 às 00:47 UTC**, página e API públicas responderam HTTP 200.
API, navegador e OpenBao estavam saudáveis. Isso comprova disponibilidade
nesse instante; estabilidade sob carga e desempenho no celular continuam
pendentes.

- API publicada: implementação `0d07e448`, imagem `76267ee4`. Os 11 hashes
  compilados conferiram; publicação em 24,39s e 13 comparações de preservação
  aprovadas. A imagem anterior `b5043529` continua disponível para rollback.
- Web: release `harness80-20261011-e1fd91f9`.
- Em **12/10 às 00:24 UTC**, a página pública respondeu HTTP 200 em 0,112s. Essa
  requisição não mede o carregamento do chat, a saúde atual dos containers
  nem o desempenho no celular.
- O gerenciador do navegador foi integrado em `6bab34fc`; os cenários de teste
  foram alinhados ao esquema atual em `728e305b`. O handler nativo continua
  pendente. Esses commits não representam uma publicação no app.
- Não foi publicado APK novo nesta etapa.
- A nova base de execução Python, o receptor local e o driver estão na
  **main, sem publicação**. `browser_exec` ainda não está disponível no catálogo.

## Correções publicadas e efeitos observados

| Frente | O que foi feito e verificado | O que ainda falta |
| --- | --- | --- |
| Drive | Busca por “MOVING DE” encontrou `MovingDE` entre as três contas. Foram percorridos 508 arquivos e 15 subpastas, em 18 páginas. | Isso não comprova leitura integral dos documentos nem conclusão do pedido sobre renovação de vistos. |
| Gmail | Pedido comum criou rascunho com card automático. Envio executado e mensagem recuperada posteriormente em outra conversa. Dois e-mails de teste receberam label e saíram de `INBOX`, confirmado por releitura. | Todos os tipos de operação e organização em massa ainda não passaram pelo aceite completo. |
| Docs, Sheets e Slides | Criações e alterações de teste confirmadas por releitura, incluindo fórmula na planilha e conteúdo de dois slides. | Cobertura completa das operações e seus fluxos pelo chat. |
| Agenda e exclusão | Evento conferido em `Europe/Berlin`, com lembrete. Exclusão de e-mail só ocorreu após aprovação no card e foi confirmada no Google. | A reconexão limitou a prova de autonomia do caso da agenda. Todos os fluxos, inclusive remoção de evento, ainda não têm aprovação integral. |
| Imagem conectada | Pedido comum com Luna chamou `codex/gpt-image-2` e entregou em 89,029s; fonte e pixels conferidos. | Esse caso não aprova todas as tarefas de infográfico. |
| Pesquisa e conclusão | Consultas preservadas pelo dispatcher, leitura de vários campos na mesma fonte, rejeição de revisão de PDF antigo e continuação de reparos sem perguntas dispensáveis. A revisão factual agora valida o esquema exigido. | Revisão ainda pode avaliar fatos incorretamente; declarar conclusão não basta para aprovar o conteúdo. |
| Contexto de pesquisa | Fontes repetidas no agregado e nas consultas passaram a usar tabela com referências na representação enviada ao modelo. Quatro recibos reais passaram de 164.343 para 86.199 bytes: **47,6% de redução**. A correção passou em 42 testes relacionados, TypeScript e build. | A redução é dos resultados medidos, não de todo o contexto, tokens ou tempo da tarefa. O pedido comum posterior, na rodada 94, reprovou rapidez, custo e conclusão. |
| Retomada e revisão atual | Corrigida a perda de IDs normalizados que fazia o journal importar novamente resultados já presentes. A retomada agora consulta a revisão dos arquivos ativos, sem mandar pesquisar para resolver apenas redação/layout ou carregar defeitos de um rascunho substituído. | Não há migração automática de históricos antigos já duplicados. A avaliação factual do modelo ainda aprovou dados insuficientes no teste posterior. |
| Inicialização | Recuperação do desktop medida em 60,580s → 1,300s; início do HTTP em 79,188s → 18,784s. | Estabilidade sustentada, consumo em pico e celular físico. |
| Chat, cards e arquivos | Histórico limitado por conversa e resumos paginados; compositor observado em recargas de 529/534ms. Rascunho mostra card automaticamente e fica compacto após envio. Leitor PDF publicado exibe páginas, texto e links; navegação reutiliza o download. | Carregamento e rolagem no celular, divergências de contadores e revisão ampla de UI/UX seguem sem aprovação. |
| Modelos | Principal Luna; alternativa MiMo. Retirado o fallback automático de fronteira. O último teste de pesquisa usou apenas Luna. | Uso eficiente e confiável com os demais modelos pequenos. |
| Memória | Falha da fila de aprendizado reproduzida e corrigida. Casos anteriores concluíram revisão de conversa e aprendizado de procedimento. Última conferência registrada: aprendizado habilitado e sem erro; três memórias e 35 procedimentos preservados. | Aprendizado automático e proatividade completos ainda não estão aprovados. |

## Teste anterior pelo chat — rodada 85

Pedido enviado uma vez em conversa nova, sem indicar ferramentas, orientar
o agente ou responder perguntas:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue
> um PDF comparando conteúdo, idioma, duração e se o certificado é pago.
> Coloque os links das fontes.

O agente entregou um PDF real de duas páginas, sem resgate do operador e
somente com Luna. Foram **26 respostas e quatro versões do arquivo**, cerca
de **9min35s** até a última resposta e **2.711.885 tokens reportados** na sessão.
Bytes, texto, pixels e oito destinos de fontes foram conferidos.

**Entrega física e autonomia passaram nesse caso. Rapidez, custo e
completude factual não passaram.** Idioma, preços de credenciais e duração
de alguns cursos ficaram sem confirmação. O retrabalho de composição e a
revisão inconsistente permanecem problemas a corrigir.

## Novo teste no app publicado — rodada 94, reprovado

O mesmo pedido foi enviado uma vez pelo compositor da URL pública, em conversa
nova e sessão de navegador isolada. Não houve instrução de ferramentas, resposta
a pergunta ou resgate do operador. O modelo utilizado foi somente Luna.

O teste foi encerrado pelo operador após **28min24s e 83 respostas**, sem
conclusão, para impedir mais consumo de um caso já reprovado. Foram gerados
**três PDFs reais**, com bytes e hashes conferidos. A própria revisão detectou
um curso pago entre os gratuitos, depois lacunas de idioma/certificado e por
fim um problema de redação sobre disponibilidade de certificado. Houve
**14 chamadas a `finish_task`**, com retomada do trabalho; o PDF ainda não
recebeu aceite final. Criar um arquivo não comprova concluir a tarefa.

Uma amostra intermediária de **23 respostas com usage preservado** reportou
**8.007.468 tokens**, dos quais 8.003.402 de entrada. Essa amostra não é o total
das 83 respostas e não estima preço. A entrada chegou a **401.770 tokens**
em uma resposta. O histórico armazenado continha recibos aparentemente
repetidos com IDs normalizados diferentes; ainda é preciso conferir a árvore
ativa e o payload enviado antes de atribuir a inflação a uma duplicação efetiva.

**A redução anterior de 47,6% em quatro recibos não resolveu o problema geral.**
Seleção de opções elegíveis, reparos de conteúdo, retomada do contexto e
quantidade de chamadas precisam ser corrigidos e medidos novamente.

## Teste após a correção publicada — rodada 95

O mesmo pedido foi enviado uma vez pelo compositor público, em conversa nova,
usando apenas Luna, sem indicação de ferramentas, respostas a perguntas ou
resgate. O executor terminou sozinho em **3min27s**, com **12 respostas**,
**um PDF de duas páginas** e **uma chamada de conclusão**. O PDF foi baixado;
bytes, hash, texto e pixels das duas páginas foram conferidos.

O histórico ativo terminou com **26 mensagens, 237.172 bytes e nenhum par de
IDs duplicados**. As 12 respostas com usage preservado no executor reportaram
**639.913 tokens**, com pico de **72.871 tokens de entrada**. Isso não inclui
o roteamento inicial da conversa nem estima cobrança. A rodada anterior ficou
sem conclusão após 28min24s; é uma comparação entre duas execuções, não uma
garantia de desempenho para qualquer tarefa.

**Entrega física e autonomia passaram neste caso; precisão factual completa
ainda não passou.** O PDF usa o idioma da página consultada nas células de
idioma de dois cursos. A revisão do modelo marcou seus 13 itens como satisfeitos,
mas essa justificativa não confirma o idioma do conteúdo. Também há campos
explicitamente não publicados pelas fontes. A próxima correção precisa distinguir
o dado solicitado das características da página, sem certificar lacunas nem
entrar novamente em pesquisa sem objetivo.

Foram executados 53 testes de regressão, com zero falhas. Depois do último ajuste,
passaram 16 testes de fontes e recuperação de documentos; os conjuntos se
sobrepõem. TypeScript e build passaram. O Biome terminou sem erros, com dois
avisos preexistentes fora das linhas alteradas. A suíte geral inteira não foi
repetida nesta rodada.

A [análise desta correção](2026-10-12-harness-receipt-identity-recovery.md)
registra a causa, os testes e os limites do resultado público.

## Limpeza e preservação

- Retirados registros próprios de testes, incluindo conversas, tarefas,
  arquivos/previews, notificações e inbox. Em uma rodada anterior, 12 registros
  foram recolhidos e **1.929 registros fora da seleção ficaram iguais**.
- Retirados imagens Docker, contextos, releases e cache antigos. A limpeza
  maior documentada liberou aproximadamente **25,44 GiB**; a última etapa
  acrescentou **1,51 GiB** livres na VPS. As medidas de cada etapa estão no
  histórico, sem somar novamente valores sobrepostos.
- Retirados **12 APKs obsoletos**, com 811.757.568 bytes alocados liberados
  nas etapas anteriores. Mantido o APK publicado.
- Preservados companions/perfil, dados reais da Beatriz, **58 arquivos,
  duas conversas, três memórias, 35 procedimentos** e as três contas Google
  simultaneamente: `bcferrari23@gmail.com`, `beatrizcferrari1@gmail.com`
  e `msant262@gmail.com`.
- Mantidos imagens atual/de recuperação, volumes, perfis, OpenBao e backups.
  As 44 operações históricas sem resultado confirmado permanecem para
  reconciliação; não foram marcadas como sucesso nem apagadas.
- Nesta rodada, foram recolhidos nove registros próprios: conversa, tarefa,
  inbox e seis arquivos/previews. **1.960 registros fora da seleção ficaram
  iguais**, e as 13 verificações finais de preservação passaram. Os 35
  procedimentos não mudaram. O dispositivo de login isolado foi revogado;
  não restaram processos do helper de navegador ou do runner Python local.
- Espaço livre observado às 00:11 UTC: **45.172.842.496 bytes**, cerca de
  **42,07 GiB**, antes da publicação mais recente.
- Na rodada 95, recolhidos seis registros próprios de QA; **1.970 registros
  fora da seleção ficaram iguais**. As 13 verificações finais de preservação
  passaram; as 35 versões dos procedimentos permaneceram iguais e o dispositivo
  isolado foi revogado. Não restaram processos do navegador de QA local.
- Removida uma imagem de API obsoleta anterior ao rollback imediato e cache
  de build sem uso há mais de uma hora. O espaço livre passou de
  41.334.296.576 para **50.350.718.976 bytes**, aumento medido de **8,40 GiB**.
  Mantidos a API atual, seu rollback imediato, navegador atual e de recuperação,
  OpenBao, volumes, perfis e backups. Conferência às 00:47 UTC: cerca de
  **46,89 GiB livres**. Não somar essa medida às limpezas históricas sobrepostas.
- Conferência posterior recolheu sete processos de um navegador de QA local
  aberto desde 09:30. Corrigido o encerramento do helper de testes e confirmado
  exit code zero em 0,064s. Essa limpeza ocorreu no computador de desenvolvimento.

## Trabalho local e próximos critérios de aceite

O contrato original do Hermes `browser_exec` exige um processo Python novo
por chamada, mantendo as abas e o workspace. O executor existente retinha
o processo. A base na main cria e encerra o processo, confirma parada dos
descendentes e carrega os helpers originais copiados, com sessão vinculada.
O transporte local e o driver de abas foram implementados depois dessa base.
Esse trabalho **ainda não implementa `browser_exec` no app**: falta conectar o
driver ao handler nativo e completar grants de upload e políticas de efeitos.
O gerenciador já foi conectado e utiliza as proteções e os diálogos existentes.

Nas rodadas anteriores registradas, **159 testes do executor, 32 do desktop,
42 de Python/API e 22 dos fluxos gráficos passaram**, além de TypeScript, build
e lint/formatação sem erros. Esses conjuntos não foram repetidos nesta
conferência de status. Incluem processo filho real, chamada ao host, pausa, cancelamento,
compatibilidade com executor antigo e bloqueio de repetição de efeitos.
São testes controlados; não substituem um pedido comum com o modelo nem
o teste de todas as ferramentas no app publicado.

Foi reproduzido um limite indevido: `fill_input` com 120 caracteres atingiu
a quota de 200 chamadas. O novo receptor local separa comandos internos de
ferramentas externas, sem uma viagem pela API a cada tecla. No Chromium real
de QA, o texto foi digitado e relido corretamente: **120 caracteres em 0,409s**
e **1.200 em 2,565s**, com zero chamadas à API para os comandos. Cancelamento,
sessão estrangeira e resposta perdida foram verificados; perda após possível
efeito não é marcada como sucesso, mesmo se o script captura o erro.

O receptor foi ligado ao broker **na main, sem publicação**, com vínculo e
reservas do desktop/perfil, controle humano e validação do envelope canônico.
O driver usa o pipe CDP e separa abas, sessões, eventos e iframes por conversa.
Não expõe uma porta de controle nem credenciais ao processo Python.

Nesta conferência de status, os **10 testes do driver passaram novamente**,
com zero falhas, cancelamentos ou casos ignorados. O teste com Chromium e os
helpers Python originais digitou texto, abriu e alternou abas, capturou um PNG
real e leu um iframe em outro processo. O programa levou **1,614s**; todo o
conjunto levou **2,358s**. É QA local, sem modelo e com hooks controlados de
autorização; não comprova proteção ou desempenho no app publicado.

Esse teste que falhava por ausência de `BrowserManager.script` passou depois
da integração. Passaram **68 testes de navegador**, incluindo nove novos casos
do gerenciador, com helpers Python reais, proteção conferida nos pixels,
controle humano, segregação por conversa, redaction e recusa de diálogo de
exclusão. Os hooks de autorização externa usados nesses casos são controlados;
o handler nativo, uploads e aprovações completas continuam pendentes.

A suíte geral teve 2.158 sucessos e quatro falhas em 2.162 casos. Os quatro
testes antigos omitiam a auditoria factual agora obrigatória; foram alinhados
ao esquema e passaram na reexecução de 11 casos relacionados. A suíte inteira
não foi repetida depois dessa alteração apenas nos testes. O backend atual
de `browser_exec` continua recusado antes do comando; a ferramenta permanece
indisponível no catálogo. Nas rodadas 93/94, não foi publicada nova API, web,
versão do executor físico ou APK. A API foi atualizada na rodada 95 descrita
acima; web, executor físico e APK continuam nas versões anteriores.

Evidências desta conferência: `round92-status-driver-tests.log`,
`round92-manager-red.log` e `round92-status-report-production.json`.
A [documentação da implementação](2026-10-11-browser-script-bootstrap.md)
registra as rodadas e os limites de cada teste.

Os seguintes pontos impedem declarar a entrega:

1. Pesquisa correta e documentos completos, com menos chamadas, regenerações,
   tokens e espera, verificados por pedidos comuns no app publicado.
2. Contratos restantes de Hermes/OpenClaw, incluindo `browser_exec` e o
   contrato completo de Kanban. A paridade permanece explicitamente falsa.
3. Google Workspace completo pelo chat, com efeitos conferidos por releitura,
   contas simultâneas, fuso correto, cards e aprovação de exclusão.
4. Memória, procedimentos e proatividade comprovados em uso continuado.
5. Desempenho, carregamento incremental, estabilidade e UX no celular.

O [histórico detalhado](2026-10-11-relatorio-harness.md) contém as rodadas,
falhas e medições. O [inventário de contratos](2026-10-09-harness-tool-inventory.json)
separa as ferramentas identificadas do aceite efetivo. Evidências privadas
ficam em `artifacts/harness-parity-20261009/`, fora do Git.
