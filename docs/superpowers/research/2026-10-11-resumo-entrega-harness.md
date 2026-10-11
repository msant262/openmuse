# Relatório do trabalho e pendências — 11/10/2026

**O harness completo ainda não está entregue.** Há correções publicadas e
testes reais com efeitos confirmados, mas o pedido comum de pesquisa mais
recente continua lento, caro e com informações sem confirmação. O critério
de aceite exigido pelo usuário permanece aberto.

## Publicação conferida

Em **11/10 às 22:24 UTC**, página e API públicas responderam HTTP 200.
API, navegador e OpenBao estavam saudáveis. Isso comprova disponibilidade
nesse instante; estabilidade sob carga e desempenho no celular continuam
pendentes.

- API publicada: implementação `b5043529`, imagem `780569c1`.
- Web: release `harness80-20261011-e1fd91f9`.
- Main local e remota conferidas iguais em `189dce56`, antes desta atualização
  do relatório. Esse commit liga o receptor local ao broker e à autoridade do
  desktop; o protocolo completo dos helpers ainda falta no worker.
- Não foi publicado APK novo nesta etapa.
- A nova base de execução Python e seu receptor local estão na **main, sem publicação**.
  Não representa uma ferramenta de navegador já disponível.

## Correções publicadas e efeitos observados

| Frente | O que foi feito e verificado | O que ainda falta |
| --- | --- | --- |
| Drive | Busca por “MOVING DE” encontrou `MovingDE` entre as três contas. Foram percorridos 508 arquivos e 15 subpastas, em 18 páginas. | Isso não comprova leitura integral dos documentos nem conclusão do pedido sobre renovação de vistos. |
| Gmail | Pedido comum criou rascunho com card automático. Envio executado e mensagem recuperada posteriormente em outra conversa. Dois e-mails de teste receberam label e saíram de `INBOX`, confirmado por releitura. | Todos os tipos de operação e organização em massa ainda não passaram pelo aceite completo. |
| Docs, Sheets e Slides | Criações e alterações de teste confirmadas por releitura, incluindo fórmula na planilha e conteúdo de dois slides. | Cobertura completa das operações e seus fluxos pelo chat. |
| Agenda e exclusão | Evento conferido em `Europe/Berlin`, com lembrete. Exclusão de e-mail só ocorreu após aprovação no card e foi confirmada no Google. | A reconexão limitou a prova de autonomia do caso da agenda. Todos os fluxos, inclusive remoção de evento, ainda não têm aprovação integral. |
| Imagem conectada | Pedido comum com Luna chamou `codex/gpt-image-2` e entregou em 89,029s; fonte e pixels conferidos. | Esse caso não aprova todas as tarefas de infográfico. |
| Pesquisa e conclusão | Consultas preservadas pelo dispatcher, leitura de vários campos na mesma fonte, rejeição de revisão de PDF antigo e continuação de reparos sem perguntas dispensáveis. A revisão factual agora valida o esquema exigido. | Revisão ainda pode avaliar fatos incorretamente; declarar conclusão não basta para aprovar o conteúdo. |
| Contexto de pesquisa | Fontes repetidas no agregado e nas consultas passaram a usar tabela com referências na representação enviada ao modelo. Quatro recibos reais passaram de 164.343 para 86.199 bytes: **47,6% de redução**. A correção passou em 42 testes relacionados, TypeScript e build. | A redução é dos resultados medidos, não de todo o contexto, tokens ou tempo da tarefa. Não houve novo pedido comum após essa publicação. |
| Inicialização | Recuperação do desktop medida em 60,580s → 1,300s; início do HTTP em 79,188s → 18,784s. | Estabilidade sustentada, consumo em pico e celular físico. |
| Chat, cards e arquivos | Histórico limitado por conversa e resumos paginados; compositor observado em recargas de 529/534ms. Rascunho mostra card automaticamente e fica compacto após envio. Leitor PDF publicado exibe páginas, texto e links; navegação reutiliza o download. | Carregamento e rolagem no celular, divergências de contadores e revisão ampla de UI/UX seguem sem aprovação. |
| Modelos | Principal Luna; alternativa MiMo. Retirado o fallback automático de fronteira. O último teste de pesquisa usou apenas Luna. | Uso eficiente e confiável com os demais modelos pequenos. |
| Memória | Falha da fila de aprendizado reproduzida e corrigida. Casos anteriores concluíram revisão de conversa e aprendizado de procedimento. Última conferência registrada: aprendizado habilitado e sem erro; três memórias e 35 procedimentos preservados. | Aprendizado automático e proatividade completos ainda não estão aprovados. |

## Último teste comum pelo chat: reprovado no aceite completo

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

## Limpeza e preservação

- Retirados registros próprios de testes, incluindo conversas, tarefas,
  arquivos/previews, notificações e inbox. Na última rodada, 12 registros
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
- Espaço livre observado às 22:24 UTC: **45.469.429.760 bytes**, cerca de
  **42,35 GiB**. Esse é o espaço disponível, não o total liberado.
- Conferência posterior recolheu sete processos de um navegador de QA local
  aberto desde 09:30. Corrigido o encerramento do helper de testes e confirmado
  exit code zero em 0,064s. Essa limpeza ocorreu no computador de desenvolvimento.

## Trabalho local e próximos critérios de aceite

O contrato original do Hermes `browser_exec` exige um processo Python novo
por chamada, mantendo as abas e o workspace. O executor existente retinha
o processo. A base na main cria e encerra o processo, confirma parada dos
descendentes e carrega os helpers originais copiados, com sessão vinculada.
Esse trabalho **não implementa sozinho `browser_exec`**: falta o transporte
local e a ligação completa ao navegador, incluindo abas e controles de acesso.

Verificação final desta base: **159 testes do executor, 32 do desktop, 42 de
Python/API e 22 dos fluxos gráficos passaram**, além de TypeScript, build e lint/formatação sem
erros. Inclui processo filho real, chamada ao host, pausa, cancelamento,
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
**Falta o protocolo completo no worker**, incluindo abas, redaction e
aprovações. O backend atual é recusado antes do comando; a ferramenta continua
indisponível no catálogo. Esses tempos são do teste de digitação, sem modelo,
e não de tarefas no app; [implementação, evidência e pendências](2026-10-11-browser-script-bootstrap.md).

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
