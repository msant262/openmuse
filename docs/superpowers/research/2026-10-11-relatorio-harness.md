# Relatório do harness, publicação e limpeza — 11/10/2026

[Relatório consolidado de correções, limpeza, testes e pendências](2026-10-11-resumo-entrega-harness.md).
Base copiada em **`a404b96d`**, receptor local em **`fa3ef6cf`** e composição
com autoridade do desktop/broker em **`189dce56`**, sem publicação. Passaram
159 testes do executor, 32 do desktop, 42 de Python/API e 22 dos fluxos
gráficos, TypeScript, build e lint. O teto de
200 chamadas foi reproduzido antes da correção. No novo receptor, Chromium
real recebeu 120/1.200 caracteres em 0,409s/2,565s, sem chamadas à API para os
comandos, com valores relidos corretamente. O Supervisor agora liga o receptor
ao broker; falta o protocolo completo no worker, que ainda é recusado antes de
comandos. Não há teste comum com Luna por esse caminho; `browser_exec` continua sem
registro e a produção permanece em `b5043529`. **Aceite integral pendente.**
[Detalhes da base, limite reproduzido e próximo transporte](2026-10-11-browser-script-bootstrap.md).
Última conferência de containers/API às **22:24 UTC**: HTTP 200 e três
containers saudáveis. O navegador abriu também a tela pública da mesma URL
em conferência posterior, sem login ou criação de tarefa de teste.

## Última publicação — conferência 21:09 UTC

**Ainda não terminou o harness completo.** A última correção remove repetição
comprovada dos resultados de busca no contexto do modelo. A pesquisa comum
anterior entregou um PDF, mas demorou 9min35s e não confirmou todos os campos.

| Frente | Resultado comprovado | Limite / pendência |
| --- | --- | --- |
| Código e publicação | Implementação **`b5043529`** na main local/remota e API, imagem **`780569c1`**. Onze hashes compilados conferidos; publicação em 24,34 s; **13 comparações de preservação passaram**. | Web, APK e executor físico permanecem nas versões registradas no histórico. O próximo commit deste relatório é somente documentação. |
| Contexto de pesquisa | Resultados de busca repetiam fontes no agregado e em cada consulta. Agora a representação enviada ao modelo usa uma tabela e índices por consulta. Nos quatro recibos reais: **164.343 → 86.199 bytes, redução de 47,6%**, preservando cada lista, variante e proveniência. | É redução de bytes nesses resultados, não de toda a requisição ou do tempo total. Recibos canônicos e capacidade de contexto mantidos. Nenhuma chamada de modelo adicionada. |
| Verificação da correção | **42/42 testes relacionados passaram**, incluindo executor copiado e transporte ao provedor. Duas reproduções falharam antes da correção. TypeScript/build passaram; lint sem erros e um aviso preexistente. | Não houve novo pedido comum depois desta publicação. Testes controlados e reprodução de recibos não aprovam a qualidade factual ou a rapidez da tarefa completa. |
| Último pedido comum | Luna entregou um PDF de duas páginas sem orientação do operador. **26 respostas, quatro versões, aproximadamente 9min35s e 2.711.885 tokens reportados**. | **Rapidez e completude factual reprovadas.** Ainda há campos qualificados como não determinados. O retrabalho de composição também precisa ser corrigido. |
| Inicialização, correção anterior | Recuperação do desktop **60,580s → 1,300s**; início do HTTP **79,188s → 18,784s**, medidos na VPS. Leitor PDF publicado e pixels de duas páginas do último arquivo conferidos. | Não aprova desempenho de celular, carregamento incremental de todas as conversas ou estabilidade sob carga. |
| Limpeza do app | Última rodada recolheu **12 registros próprios do QA**. **1.929 registros fora da seleção permaneceram iguais**. Preservados companions/perfil, 58 arquivos reais, duas conversas, três memórias, 35 procedimentos e **três contas Google simultâneas**. | Recibos canônicos e 44 operações históricas incertas permanecem para reconciliação. Aprendizado habilitado e sem erro na conferência atual; o ciclo anterior teve gravações pendentes. Memória/proatividade completas seguem sem aprovação. |
| Armazenamento | Nesta etapa, retirada uma imagem antiga da API, seu contexto e archive: **1.621.135.360 bytes (~1,51 GiB)** livres adicionais na VPS. O archive local correspondente de **53.493.193 bytes** foi retirado com hash conferido. A limpeza anterior de imagens/cache liberou **~25,44 GiB**; **12 APKs antigos** foram retirados em etapas anteriores. | Não foi gerado APK novo. Atual e recuperação imediata, volumes, perfis, OpenBao e dados reais mantidos. Medidas históricas não são somadas novamente. |
| Disponibilidade | Na conferência 21:09 UTC: página/API públicas HTTP 200, três containers saudáveis, sem manutenção. | É conferência pontual, não aprovação de pico, GPU, celular ou estabilidade sustentada. |
| Contratos e aceite completo | A ausência de **`browser_exec` do Hermes** está explícita no inventário; Python genérico não foi apresentado como implementação equivalente. | Faltam esse contrato e os restantes de ferramentas/Kanban, Workspace completo, memória/proatividade, desempenho e UX. **Paridade integral Hermes/OpenClaw continua falsa.** |

[Causa, reprodução e alcance da correção de contexto](2026-10-11-search-context-projection.md).
[Inventário de ferramentas e contratos pendentes](2026-10-09-harness-tool-inventory.json).
As evidências privadas ficam fora do Git em `artifacts/harness-parity-20261009/`.
A meta permanece ativa e o aceite completo não foi declarado.

## Histórico — conferência das 20:50 UTC

**Não terminou o harness completo.** Há correções publicadas, limpeza aplicada
e entrega real de PDF por Luna, mas o último teste continua caro e lento.

| Frente | Feito e comprovado | Pendência / limite |
| --- | --- | --- |
| Main e publicação | Implementação **`28f4d42a`** na main local/remota e API publicada, imagem **`50517464`**. Dez hashes compilados conferidos, publicação em 23,14s e 13 comparações de preservação aprovadas. | Web segue no release `harness80-20261011-e1fd91f9`; APK, navegador e executor físico mantidos. O commit posterior deste relatório é somente documentação. |
| Pesquisa e tool calling | Busca de vários campos/ocorrências na mesma fonte preservada já publicada. Agora o executor valida o esquema exato da revisão exigida; antes ele era anunciado, mas não aplicado na execução. Revisão factual padrão registra cada requisito no mesmo turno do executor, sem modelo extra. Uma lacuna marcada como pendente impede aprovação agregada. | Confere consistência do protocolo, não a verdade de toda evidência escrita pelo modelo. Enumerar todos os requisitos e comparar corretamente fontes ainda depende do executor. |
| Testes desta implementação | **40/40 testes relacionados e cinco casos distintos da revisão independente opcional passaram**; TypeScript, build e lint sem erros. Duas reproduções falharam antes da correção. | Os grupos intermediários sobrepostos não foram somados. Testes controlados não aprovam todo o harness nem todas as ferramentas. |
| Pedido comum pelo chat | Uma mensagem em conversa nova, sem sugestões de ferramentas, perguntas ou orientações do operador. **26 respostas somente de Luna**, quatro versões e um PDF final de **65.896 bytes / duas páginas**. Bytes, pixels e oito destinos de fontes conferidos no leitor público. | Cerca de **9min35s** até a última resposta. Primeira revisão detectou três lacunas e retomou pesquisa sozinha; também houve exigências de diagramação não pedidas. **Rapidez e completude factual reprovadas**: idioma e preços ainda aparecem como não determinados. |
| Consumo real | Metadados da própria sessão: **2.702.644 tokens de entrada + 9.241 de saída = 2.711.885**. Entrada em cache: **576.128**, já incluída no total; maior entrada individual: 150.938 tokens. | Continua caro para esta tarefa. Não houve troca para modelo de fronteira. Não há isolamento de tempo/custo por ferramenta nem atribuição causal exclusiva ao novo audit. |
| Inicialização e leitor, correções anteriores | Recuperação do desktop caiu de **60,580s para 1,300s** e início do HTTP de **79,188s para 18,784s** em duas inicializações reais. Leitor PDF desenha uma página por vez e reutiliza os bytes durante navegação. | São correções já registradas no histórico. Consumo do celular, carregamento incremental de todas as conversas e estabilidade sob carga ainda não estão aprovados. |
| Limpeza do app nesta etapa | **12 registros próprios do QA** recolhidos: oito arquivos/previews, tarefa, conversa, notificação e inbox. **1.929 registros fora da seleção permaneceram iguais**. Recibos/evidências preservados, inspector fechado, hooks removidos, navegador temporário encerrado e dispositivo revogado. | Não houve limpeza de dados reais ou de históricos incertos. Nenhum procedimento novo precisou ser arquivado. |
| Dados preservados | As **13 comparações finais passaram**: companions/perfil, 58 arquivos, duas conversas, três memórias, 35 procedimentos e **três contas Google simultâneas**. Versões dos procedimentos anteriores iguais. | Preservação não é aprovação de memória/proatividade ou de todas as operações Google Workspace. |
| Armazenamento | Retirada mais uma imagem antiga da API, seu contexto e archive: **435.486.720 bytes (~415,3 MiB)** livres adicionais na VPS. Archive local correspondente de **53.492.344 bytes** retirado com hash conferido. Limpeza anterior de imagens/cache liberou **~25,44 GiB**; 12 APKs antigos foram retirados em etapas anteriores. | Valores históricos identificados separadamente; nenhum APK novo foi removido nesta etapa. Atual/recuperação, web, APK publicado, OpenBao, volumes e dados reais mantidos. |
| Saúde atual | Às **20:50 UTC**, página/API HTTP 200, três containers saudáveis, sem manutenção, seis contadores de execução em zero. Amostra API: **1,077 GiB / 53,57% CPU**; navegador: **543,1 MiB / 9,92% CPU**. | Amostra pontual, sem aprovação de pico, GPU, celular ou estabilidade. As 44 operações históricas incertas continuam preservadas. |
| Paridade e restantes | Inventário revalidado: **`browser_exec` do Hermes está ausente** no servidor/worker. Não foi tratado como implementado por existir execução genérica de Python. | Falta implementar e validar esse contrato; completar os contratos de Kanban e ferramentas restantes; aprovar Workspace completo, memória/proatividade, desempenho e UX. **Paridade integral Hermes/OpenClaw permanece falsa.** |

[Causa, implementação, teste real e limites da revisão factual](2026-10-11-native-field-audit.md).
[Inventário de ferramentas e contratos pendentes](2026-10-09-harness-tool-inventory.json).
Evidências desta etapa: `artifacts/harness-parity-20261009/`, fora do Git,
com arquivos privados 0600 e diretório de cópias 0700.

O trabalho seguinte precisa reduzir as quatro regenerações e o contexto
repetido medido, separar ajustes cosméticos de pendências factuais e concluir
os contratos ausentes. A meta permanece ativa; não há declaração de entrega integral.

## Histórico — conferência das 20:13 UTC

**O harness completo ainda não está entregue.** A pesquisa ganhou busca
de vários campos na mesma fonte e compatibilidade com termos redundantes.
O novo pedido comum concluiu sozinho e criou apenas um PDF, mas deixou
campos sem confirmação e ainda levou mais de quatro minutos desde o envio.

| Frente | Feito e comprovado | Pendência / limite |
| --- | --- | --- |
| Código e publicação | Implementações `f4a6a7b1` e `5206bbec` na main local/remota. API publicada em **`5206bbec`**, imagem **`82543a0a`**; sete hashes compilados conferidos. Publicações de 24,15s e 25,27s, cada uma com 13 comparações de preservação aprovadas. | Web permanece em `harness80-20261011-e1fd91f9`. Navegador e executor físico mantidos. Nenhum APK novo. |
| Pesquisa em partes da fonte | `read_web_source` consulta vários campos/termos e ocorrências em uma leitura dos bytes preservados, com origem, SHA-256 e continuação por termo. O pedido comum usou essa capacidade e encontrou o curso IBM pelo nome, com idiomas e três horas. | Uma consulta em lote passou; a tentativa anterior foi recusada por enviar também `query`. O agente reparou sozinho. A versão `5206bbec` combina os termos em vez de recusar; seu protocolo foi verificado com executor nativo controlado, sem outro pedido normal depois da publicação. |
| Verificação local | **44/44 testes relacionados** passaram na versão mais recente, com zero falhas, cancelamentos ou ignorados. Duas reproduções da recusa falharam antes da correção. TypeScript, build e lint passaram. | As duas rodadas usam grupos sobrepostos e não são somadas em 88 testes. Não aprovam todas as ferramentas ou o produto. |
| Pedido comum pelo chat | Mensagem enviada uma vez, conversa nova, sem nomes de ferramentas, perguntas ou direções do operador. **15 respostas apenas de Luna, um PDF de 48.821 bytes e duas páginas.** Resultado em **239,159s** da criação da tarefa; **245,274s** desde o envio no navegador. | Entrega física e autonomia aprovadas neste caso. Rapidez e completude factual continuam reprovadas. A rodada anterior levou 605,348s e criou três PDFs, mas escolheu outros cursos: a diferença observada não isola o efeito desta mudança. |
| Conteúdo e leitor PDF | Bytes/SHA-256, texto e pixels das duas páginas no leitor público conferidos, com cinco links de fontes. A tabela inteira está na primeira página; recomendações e fontes, na segunda. | Idioma e preço do badge Google, além da duração total Microsoft, continuam sem confirmação. O repositório Microsoft ligado pela fonte não foi lido. A revisão nativa aprovou o arquivo; esse status não comprova os fatos. Celular físico não testado. |
| Limpeza do app | Recolhidos **seis registros próprios do QA**: dois arquivos/previews, tarefa, conversa, notificação e inbox. **1.923 registros fora da seleção permaneceram iguais.** Nenhum procedimento novo precisou ser arquivado. Inspector fechado, hooks removidos, navegador encerrado e seu dispositivo revogado. | Limpeza da apresentação, mantendo recibos canônicos e evidências físicas. O seletor genérico de canvas e as capturas cortadas pelo contêiner foram corrigidos no observador; não são prova de defeito no PDF. |
| Dados reais / memória | Treze comparações após limpeza/publicação passaram. Preservados companions/perfil, **58 arquivos**, **duas conversas**, **três contas Google simultâneas**, **três memórias** e **35 procedimentos**. | Memória/proatividade completas continuam sem aprovação. O primeiro contador do observador contou o envelope da resposta; foi corrigido para contar suas três `entries`, mantendo a comparação integral aprovada. As 44 operações históricas incertas não foram apagadas. |
| Imagens e releases antigos | Removidas **duas imagens antigas da API**, dois contextos e dois archives, após conferência de conteúdo de 23.854 arquivos. Essa etapa liberou **870.883.328 bytes (~830,5 MiB)** na VPS. Retirados localmente os dois mesmos archives, **106.963.026 bytes**, com hashes remotos conferidos. | Mantidas API atual e recuperação imediata, as duas versões do navegador, OpenBao, web, APK publicado, volumes, perfis e dados reais. Nenhuma nova exclusão de APK nesta rodada. |
| Cache de build / espaço livre | Encontrados **34,67 GB** de cache de build. Limpeza apenas do cache sem uso há mais de duas horas: restaram **7,27 GB**. Containers, cinco imagens retidas, mounts e hashes dos ambientes permaneceram iguais. Do início da limpeza de imagens ao fim do cache, espaço livre passou de **22.080.331.776 para 49.394.556.928 bytes**, aumento de **27.314.225.152 bytes (~25,44 GiB)**. | Cache de build não é dado do usuário. A CLI instalada usa `--reserved-space`; a tentativa inicial com checagem de `--keep-storage` parou antes de qualquer remoção e foi corrigida pela ajuda local. Contagens e tamanhos arredondados do Docker não substituem a medida de espaço livre. |
| Disponibilidade / consumo | Às **20:13 UTC**, página e API públicas HTTP 200 a partir da VPS; amostra da estação também HTTP 200. Três containers saudáveis, sem manutenção e seis contadores de execução em zero. Amostra: API **869,1 MiB / 6,22% CPU**; navegador **137,4 MiB / 0,00% CPU**. | São amostras pontuais, sem aprovação de pico, GPU, celular, carga ou estabilidade sustentada. Espaço livre final variou levemente após a medida da limpeza. |
| Workspace / ferramentas / UX | Casos anteriores de Drive, Gmail, Docs/Sheets/Slides, agenda e aprovação de exclusão permanecem registrados. Principal Luna e alternativa MiMo mantidos. | **Workspace completo, equivalência integral Hermes/OpenClaw, memória/proatividade, desempenho sustentado e revisão ampla de UX continuam sem aprovação.** Não foram retestados integralmente nesta rodada. |

[Implementação, teste comum e limites desta rodada](2026-10-11-source-batch-search.md).
As evidências privadas foram copiadas da VPS com SHA-256 remoto/local
conferido; ficam fora do Git, em diretório 0700 e arquivos 0600.
A meta continua ativa. O próximo trabalho precisa resolver o aceite de
campos não comprovados e completar os contratos restantes, sem tratar
uma entrega de arquivo ou um teste controlado como aprovação de todo o harness.

## Histórico — conferência das 19:47 UTC

**O harness completo ainda não está entregue.** Nesta conferência, a API
pública respondeu HTTP 200 e os três containers estavam saudáveis. Main
local e remota estão em `6a52bb50`; a API publicada permanece em `73a633cf`.

| Situação | Resultado |
| --- | --- |
| Publicado e medido | Recuperação do desktop caiu de 60,580s para 1,300s; início do HTTP caiu de 79,188s para 18,784s. Ordem das imagens no histórico corrigida; leitor PDF publicado e duas páginas do último arquivo conferidas. |
| Limpeza aplicada | Dez registros próprios do último QA recolhidos. Espaço livre na VPS aumentou cerca de 1,51 GiB com retirada de duas imagens antigas e seus contextos/releases. Dados reais, companions e três contas Google simultâneas preservados pelas comparações da rodada anterior. |
| Teste normal pelo chat | Luna entregou um PDF sozinho em 10min05,348s, com 38 respostas e três versões. A entrega física passou; rapidez e comprovação factual integral falharam. |
| Ajuste local ainda não publicado | Busca de vários campos e ocorrências na mesma fonte preservada, com orçamento compartilhado e continuação. **44/44 testes relacionados passaram**, sem falhas, cancelamentos ou ignorados; TypeScript, build e lint passaram. Código e testes ainda têm alterações locais, sem commit ou publicação deste ajuste. |
| Ainda falta | Publicar e testar o novo ajuste por um pedido comum; resolver a revisão factual inconsistente e as chamadas/regenerações excessivas; validar desempenho no celular e carga sustentada; completar o aceite das ferramentas Hermes/OpenClaw, Google Workspace, memória, proatividade e UX. |

[Evidência e alcance do ajuste local de pesquisa](2026-10-11-source-batch-search.md).
As evidências detalhadas de publicação, teste normal, preservação e limpeza
estão abaixo. A conferência de saúde atual é pontual, não um teste de
estabilidade sustentada.

## Histórico — conferência das 19:30 UTC

**Ainda não terminou. A inicialização foi corrigida e medida na VPS. O último
pedido normal concluiu sozinho e entregou um PDF com Luna, mas levou mais de
dez minutos e deixou campos sem comprovação suficiente. Isso não atende ao
critério de entrega do harness completo.**

| Frente | Feito e comprovado | Pendência / limite |
| --- | --- | --- |
| Código e publicação | Correções `e331b56c` e `73a633cf` na main local/remota. API publicada em `73a633cf`, imagem `5d076f4f`; seis hashes compilados conferidos e 13 comparações de preservação passaram. Publicação em **24,88s**. | Web permanece no release `harness80-20261011-e1fd91f9`. Navegador e executor físico mantidos. Nenhum APK novo. |
| Inicialização: causa e correção | A recuperação do desktop relia e reescrevia visualizadores já encerrados. Agora o banco seleciona apenas casos que precisam de recuperação, incluindo entradas incertas. Na VPS, essa etapa caiu de **60,580s para 1,300s**. HTTP começou em **18,784s**, antes eram **79,188s**. | Uma comparação entre duas inicializações reais. O preparo do harness ainda levou **10,110s**. Não comprova rapidez do chat, celular ou estabilidade sustentada. |
| Imagens no histórico | Screenshots/previews históricos eram anexados depois de revisões e reparos posteriores em cada requisição. Agora a imagem acompanha o recibo que a produziu, preservando a ordem das ferramentas e mensagens seguintes. | Quatro reproduções falharam antes da correção. Isso comprova o defeito de transporte, sem atribuir toda a repetição de pesquisa a ele. |
| Verificação local | **40/40** testes relacionados à visão/documentos/executor copiado e **19/19** de recuperação do desktop/execução nativa/inbox passaram, sem falhas, cancelamentos ou ignorados. TypeScript e builds passaram; lint sem erros, com avisos preexistentes. | Grupos sobrepostos não foram somados. Não representam aprovação de todas as ferramentas ou do produto. |
| Pedido normal pelo chat | Uma mensagem comum em conversa nova, sem citar ferramentas: pesquisar três cursos gratuitos e entregar comparação em PDF. **38 respostas somente de Luna**, zero perguntas/direções do operador, três versões e uma conclusão bem-sucedida. Entregou **um PDF de 47.308 bytes e duas páginas**, com quatro links de fontes. | **605,348s (10min05,348s)** da criação da tarefa até o resultado. Entrega física e autonomia aprovadas neste caso; rapidez e comprovação factual integral reprovadas. Idioma da página não comprova idioma do curso; o preço da credencial IBM não ficou demonstrado integralmente. |
| Leitor PDF publicado | O arquivo final apareceu na conversa, abriu e mostrou as duas páginas com pixels distintos. Na segunda página, quatro links das fontes renderizados e clicáveis. Bytes e SHA-256 conferidos. | Celular físico não testado nesta rodada. Uma captura prematura da segunda página foi descartada e refeita após a renderização dos links. O visual do PDF ainda merece ajuste. |
| Limpeza do app | Recolhidos **dez registros próprios do teste**: seis arquivos/previews, tarefa, conversa, notificação e inbox. **1.914 registros fora da seleção ficaram iguais**. Inspector fechado, hooks removidos, navegador temporário encerrado e seu dispositivo revogado. | Limpeza da apresentação, preservando recibos canônicos e bytes de evidência. Nenhum procedimento novo precisou ser arquivado; os 35 anteriores mantiveram suas versões. |
| Dados reais / memória | **13 comparações finais passaram** após publicação e limpeza. Preservados companions/perfil, duas conversas reais, **58 arquivos**, **três memórias**, **35 procedimentos** e **três contas Google simultâneas**. Aprendizado habilitado, sem erro na conferência. | Memória/proatividade completas continuam sem aprovação. A última cobertura proativa de e-mails e tarefas foi parcial. As 44 operações históricas incertas continuam preservadas para reconciliação. |
| Armazenamento | Removidas **duas imagens antigas da API**, dois contextos e dois archives, após conferência de conteúdo. Aumento medido de espaço livre: **1.625.141.248 bytes (~1,51 GiB)** na VPS. Também removidos localmente os mesmos dois archives obsoletos, **106.929.582 bytes**, com hashes conferidos contra a VPS. | API atual e recuperação imediata, versões do navegador, web, APK publicado, volumes, perfis e dados reais preservados. Os 12 APKs antigos retirados anteriormente estão no histórico; nenhum novo APK foi removido nesta rodada. |
| Disponibilidade / consumo | Às **19:30 UTC**, página e `/api/health` públicos HTTP 200 por curl, tanto da estação quanto da VPS. API, navegador e OpenBao saudáveis; manutenção desligada e seis contadores de trabalho ativo em zero. Amostra: API **916,6 MiB / 17,65% CPU**, navegador **380,4 MiB / 0,61% CPU**. | Conferências pontuais, não medição de pico ou carga sustentada. Python com seu user-agent padrão recebeu Cloudflare 403/1010 na mesma origem pública; essa observação não é uma queda dos containers nem aprovação de acesso de todos os clientes. RAM, GPU e celular ainda precisam investigação. |
| Workspace / equivalência de ferramentas | Casos anteriores conferiram Drive com nome aproximado, Gmail/labels/arquivo/rascunho/card/envio, Docs/Sheets/Slides, agenda e exclusão após aprovação. Principal continua Luna, com alternativa MiMo. | **Workspace completo e equivalência integral Hermes/OpenClaw continuam sem aprovação.** Não foi feito novo teste completo dessas integrações nesta rodada. |

A origem do tempo do novo QA é a criação da tarefa no servidor. O observador
inicial procurava a rota errada; a mensagem já tinha sido aceita e **não foi
reenviada**. Portanto, esse tempo não é a medição exata do clique de envio e
não deve ser comparado diretamente ao tempo de cliente da rodada anterior.
A diferença entre entregar um arquivo, comprovar seus fatos e fazê-lo com
rapidez permanece explícita.

[Correção da ordem das imagens e teste normal](2026-10-11-vision-history-chronology.md).
[Causa e redução medida da inicialização](2026-10-11-desktop-startup-recovery.md).
[Inventário de contratos ainda pendentes](2026-10-09-harness-tool-inventory.json).
**32 evidências privadas** desta rodada copiadas da VPS, com SHA-256
remoto/local conferido. Ficam fora do Git, com diretório 0700 e arquivos
0600. Capturas do leitor e comprovantes locais estão registrados separadamente.

A meta permanece ativa. Falta reduzir chamadas e regenerações na pesquisa,
comprovar os campos solicitados sem confundir língua da página com língua do
curso, validar desempenho em celular/carga e completar os contratos de
ferramentas, Google Workspace, memória, proatividade e UX.

## Histórico — conferência das 18:47 UTC

**Ainda não terminou. API e web foram atualizados, o leitor PDF funciona no
app publicado e a limpeza desta rodada foi concluída. O pedido normal de
pesquisa/PDF voltou a falhar no aceite de autonomia e rapidez.**

| Frente | Feito e comprovado | Pendência / limite |
| --- | --- | --- |
| Código e publicação | Implementação `8415419b` e ajuste web `e1fd91f9` na main local/remota. API publicada na imagem `f6212f30`; web no release `harness80-20261011-e1fd91f9`. Sete hashes compilados e HTML/bundle/runtime/worker nas origens privada e pública conferidos. | Navegador e executor físico mantidos. **Nenhum APK novo** nesta rodada. |
| Leitor PDF | Páginas desenhadas com PDF.js local, autenticação, texto selecionável e links. As três páginas de um arquivo real apareceram no leitor público, com pixels diferentes e legíveis. Navegação/zoom no mesmo layout não fizeram novo download; fechar liberou o bitmap. Zero erros JS no período observado. | Largura de celular **simulada**, sem aparelho físico. Trocar entre os layouts desktop/celular reiniciou a página e baixou o PDF novamente. A verificação usou arquivo real existente, pois o QA não entregou seu rascunho. |
| Paginação | A reprodução exata do PDF anterior passou de três páginas para duas, mantendo texto e links; ajustados título e distribuição de colunas. | **Não resolve todos os PDFs.** O novo conteúdo do pedido normal voltou a deixar uma terceira página quase vazia. |
| Testes locais | **47/47 testes relacionados passaram**, zero falhas/cancelamentos/ignorados; verificações específicas do leitor repetidas após correções também passaram. TypeScript raiz/mobile, builds, exportação web e lint passaram. | Grupos sobrepostos não foram somados. Esses controles não aprovaram o fluxo natural inteiro. |
| Pedido normal pelo chat | Mensagem comum enviada uma vez, conversa nova, **39 respostas somente de Luna**, sem fallback, respostas do operador ou resgate. Criou dois PDFs; o último tem **56.704 bytes e três páginas**. | **Reprovado: zero arquivos finais entregues.** Após **636,532s (10min36,532s)**, somente esse QA foi cancelado depois do loop observado. Seis tentativas de conclusão parcial receberam continuação reparável; o agente não corrigiu o arquivo nesse intervalo. |
| Causa observada no fluxo | A revisão atual contradisse os bytes do PDF: disse que Great Learning estava fora da comparação e falou de duração de um curso IBM que não estava no arquivo. A pergunta para “retomar” foi bloqueada corretamente pelo guard de reparo, sem criar interação. | A validação do vínculo/hash da revisão não garante uma avaliação factual correta. O agente voltou a tentar encerrar. **Causa completa e correção desse loop ainda pendentes.** |
| Inicialização / consumo | Medição real: criação do app **58,376s** e preparo do harness **8,249s**; HTTP pronto em 71,735s. Publicação da API levou 77,70s. Amostra durante o QA: **979,7 MiB / 16,84% CPU** na API. | A espera está principalmente em `createApp`; causa interna ainda não provada. A amostra não mede pico, GPU, celular ou estabilidade sustentada. |
| Limpeza do app | Recolhidos **oito registros próprios do teste**: tarefa, conversa, cinco arquivos/previews e inbox. **1.904 registros fora da seleção permaneceram iguais.** Recibos canônicos preservados; navegador temporário fechado e dispositivo revogado. | Nenhum procedimento novo precisou ser arquivado. A verificação inicial de fechamento do inspector foi precoce; a conferência posterior confirmou que ele fechou. |
| Dados reais | **13 conferências finais passaram**: companions/perfil, duas conversas, 58 arquivos, três memórias, 35 procedimentos e **três contas Google simultâneas** preservados. | Somente assinatura/expiração dos URLs temporários mudou; campos armazenados e rotas permaneceram iguais. Memória/proatividade completas continuam sem aprovação. |
| Armazenamento | Retirada uma imagem Docker antiga da API, seu contexto e release; também o candidato web descartado e seu arquivo. Aumento medido de espaço livre: **481.329.152 bytes (~459,0 MiB)** na VPS. Retirados localmente dois archives obsoletos e 232 arquivos do export descartado: **99.520.512 bytes (~94,9 MiB)** de espaço livre adicional. | Versões atuais/de recuperação, APK publicado, volumes, perfis e dados reais preservados. Os 12 APKs antigos retirados anteriormente estão no histórico; não houve nova remoção de APK nesta rodada. |
| Disponibilidade | Às **18:46:44 UTC**, página e `/api/health` públicos HTTP 200; API, navegador e OpenBao saudáveis; manutenção desligada, seis contadores de trabalho ativo em zero. | Conferência pontual. As 44 operações históricas incertas continuam preservadas. |
| Google Workspace / ferramentas | Casos anteriores conferiram Drive com nome aproximado, Gmail/labels/arquivo/rascunho/card/envio, Docs/Sheets/Slides e calendário/exclusão após aprovação. | **Todas as operações Workspace e equivalência integral Hermes/OpenClaw ainda não estão aprovadas.** |

[Implementação, publicação e evidências desta rodada](2026-10-11-pdf-reader-startup.md).
[Inventário de contratos ainda pendentes](2026-10-09-harness-tool-inventory.json).
**36 evidências privadas** desta rodada foram copiadas da VPS com SHA-256
conferido, em diretório 0700 e arquivos 0600, fora do Git.
A meta permanece ativa. O próximo trabalho precisa corrigir o loop e a revisão
contraditória, completar a pesquisa factual e medir as fases internas da
inicialização, além dos contratos de ferramentas ainda abertos.

## Histórico — conferência das 18:14 UTC

**O trabalho completo ainda não terminou. Há correções publicadas e novos
ajustes verificados localmente; o critério de entrega integral não foi atendido.**

| Frente | Resultado comprovado | Situação |
| --- | --- | --- |
| App publicado | Página e `/api/health` responderam **HTTP 200 às 18:13:59 UTC**; API, navegador e OpenBao saudáveis. API permanece em `10b4cf18`. | Disponibilidade pontual confirmada. Não comprova estabilidade sustentada. |
| Pesquisa / conclusão | Correções publicadas preservam consultas e fontes, rejeitam revisão de arquivo antigo e continuam reparos de documentos públicos sem pedir ao usuário decisões dispensáveis. Último pedido normal entregou PDF real usando somente Luna, sem intervenção. | Levou **5min08,319s** e deixou campos sem comprovação. O aceite completo continua reprovado. |
| Google Workspace | Casos publicados conferiram Drive com nome aproximado, Gmail com rascunho/card/envio, labels e arquivo, Docs/Sheets/Slides e exclusão após aprovação. | São casos específicos. Todas as operações e a conclusão autônoma de todos os fluxos ainda não estão aprovadas. |
| Contas / memória | Última conferência de preservação manteve **três contas Google simultâneas**, companions, dados reais, três memórias e 35 procedimentos. Falha anterior da fila de aprendizado foi reproduzida e corrigida. | Aprendizado automático e proatividade completos continuam sem aprovação. Não houve nova escrita nos dados reais nesta atualização. |
| Limpeza | Retirados registros próprios de testes, imagens Docker, contextos/releases e **12 APKs antigos**, preservando dados reais, versões atuais e recuperação. A última rodada liberou **~415,1 MiB na VPS**. | Limpeza dessa rodada concluída; comprovantes e medições anteriores estão no histórico abaixo. Não somei tamanhos nominais de imagens com camadas compartilhadas. |
| Leitor PDF — novo ajuste local | Substituído iframe por páginas desenhadas com PDF.js, autenticação, texto selecionável, links clicáveis, navegação e zoom sem baixar novamente. Troca/fechamento libera o bitmap anterior; falha mostra recuperação explícita. Runtime e worker só carregam ao abrir um PDF. | **Ainda fora do commit e da publicação.** Teste em navegador real comprova pixels, links, uma única transferência durante navegação e recuperação de falha. Largura de celular simulada; celular físico ainda pendente. |
| Paginação — novo ajuste local | Reprodução do PDF anterior agora ocupa **duas páginas**, preservando texto e links. Corrigida coluna de título vazia e distribuição das colunas de tabela. | **Ainda fora do commit e da publicação.** Essa reprodução local não aprova o conteúdo factual da pesquisa. |
| Verificação local desta etapa | **47/47 testes relacionados passaram**, sem falhas/cancelamentos/ignorados; TypeScript raiz/mobile e exportação web passaram. Assets PDF separados conferidos. Lint sem erros, com um aviso no teste. | Nenhum novo pedido normal pelo chat publicado nesta etapa. Não somei estes testes às suítes anteriores, que têm sobreposição. |
| Performance / cobertura completa | Leitor passa a reutilizar o download e desenhar uma página por vez. | Consumo e lentidão geral, startup de cerca de 74s, celular e equivalência integral Hermes/OpenClaw permanecem sem solução comprovada. |

Falta publicar e verificar os novos ajustes no app; impedir conclusão de pesquisa
com campos ainda sem comprovação; reduzir repetição/latência com causa medida;
e completar o aceite natural de ferramentas, Workspace, memória/proatividade e UX.
A meta permanece ativa. Os resultados de cada teste e suas limitações seguem abaixo.

Evidências locais desta etapa: `round80-full-document-suite.log`,
`round80-root-typecheck-final.log`, `round80-mobile-typecheck.log`,
`round80-web-build.log`, `round80-web-assets-proof.json` e
`round80-biome-final.log`, em `artifacts/harness-parity-20261009/`, fora do Git.
Conferência atual de produção: `harness80-status-production.json` na VPS.

## Histórico — atualização das 17:47 UTC

**Ainda não entregue como um todo. A correção de continuação está publicada,
e o novo pedido normal entregou um PDF sem intervenção. A pesquisa completa,
a apresentação do documento, a performance e a cobertura integral continuam
sem aprovação.**

| Frente | Feito e verificado | Resultado / pendência |
| --- | --- | --- |
| Código | Implementação `10b4cf18` na main local/remota e na API; imagem `ab52237c`, com cinco hashes compilados conferidos. | Publicação somente da API. Web `d8882335`, navegador `ab3d9265` e executor físico `8aa6d479` mantidos. Sem APK novo. |
| Autonomia | `ask_user` agora consulta a revisão nativa vigente do documento: problemas reparáveis em pesquisa pública retornam continuação concreta. Perguntas indispensáveis sobre informação privada continuam permitidas. | Revisões de outra tarefa, revisão antiga, arquivo alterado ou preview diferente não autorizam a pergunta. A classificação de informação privada continua dependendo da avaliação do modelo. |
| Verificação | **77/77 testes relacionados** passaram, zero falhas/cancelamentos/ignorados; TypeScript e build passaram. Lint sem erros. | Duas reproduções falharam antes da correção e passaram depois. O conjunto inclui perguntas privadas legítimas. Não somei grupos sobrepostos nem repeti a suíte inteira. |
| Pedido normal pelo chat | Uma mensagem comum em conversa nova; **20 respostas somente de Luna**, sem fallback, perguntas, orientações ou resgate. Entregou um PDF real de **50.028 bytes e três páginas** em **308,319s (5min08,319s)**; criou duas versões. | **Entrega física aprovada; aceite completo reprovado.** A nova proteção de pergunta foi exercitada nos testes locais, mas não neste pedido real, que não chamou `ask_user`. Não atribuo a diferença de tempo exclusivamente à correção. |
| Conteúdo / apresentação | Bytes e SHA-256 do PDF conferidos; texto extraído e páginas rasterizadas. O bloco oficial da IBM comprova conteúdo, quatro idiomas e três horas. | Idioma do curso Google, preços de credenciais e carga horária total Microsoft não ficaram estabelecidos. O PDF ainda tem uma terceira página quase vazia. O status interno `verified` não aprova esses pontos. |
| Leitor web | Arquivo aparece na conversa e abre os controles do leitor. | A captura do navegador headless mostra o iframe vazio, sem pixels do PDF. Não comprova o mesmo comportamento em todos os navegadores; compatibilidade web/celular continua pendente. |
| Limpeza do app | **Nove registros próprios do teste** recolhidos: conversa, tarefa, cinco arquivos/previews, notificação e inbox. **1.894 registros fora da seleção permaneceram iguais.** | Recibos canônicos mantidos; nenhum procedimento novo desse teste precisou ser arquivado. Os 35 procedimentos anteriores mantêm suas versões. |
| Preservação | **13 conferências finais passaram:** companions/perfil, duas conversas, 58 arquivos, três memórias, 35 procedimentos e **três contas Google simultâneas** preservados. | Rotas de arquivos iguais; somente assinatura/expiração dos links temporários renovadas. Navegador temporário fechado e dispositivo revogado. Isso não aprova todo o aprendizado automático. |
| Limpeza de armazenamento | Retiradas mais **uma imagem Docker antiga**, **um contexto de build** e **um release**. Espaço livre aumentou **435.220.480 bytes (~415,1 MiB)** na VPS. 11.914 arquivos do contexto conferidos, inclusive contra o release. Retirado também o release local obsoleto de **53.442.768 bytes**. | API/navegador atuais e suas recuperações imediatas, OpenBao, volumes, perfis e dados reais mantidos. Os 12 APKs obsoletos retirados anteriormente estão no histórico. Sem nova remoção/publicação de APK nesta rodada. |
| Disponibilidade / startup | Às **17:47:02 UTC**, API e página pública HTTP 200; API, navegador e OpenBao saudáveis; manutenção desligada e seis contadores de trabalho ativos em zero. | Publicação levou **80,50s**: contêiner criado em 2,586s; health pronto em 76,663s. Há **74,077s entre criação e readiness**, com causa interna ainda não isolada. As 44 operações históricas incertas seguem preservadas. |
| Performance / escopo completo | Amostra durante o teste: API **1,069 GiB e 7,70% CPU**; recarga pontual do compositor em 1.375ms. | Amostras não são pico nem teste de carga. Performance no celular, Workspace completo, todos os contratos Hermes/OpenClaw e revisão ampla de UX continuam pendentes. |

[Causa, correção e evidências desta etapa](2026-10-11-native-document-question-recovery.md).
[Inventário e contratos ainda pendentes](2026-10-09-harness-tool-inventory.json).
**22 evidências privadas** desta rodada copiadas da VPS e conferidas por
SHA-256, em diretório 0700 e arquivos 0600, fora do Git.
A meta permanece ativa. As seções seguintes preservam os resultados anteriores,
inclusive os pedidos que falharam; não representam o estado atual da API.

## Histórico — atualização das 17:10 UTC

**Ainda não entregue. Há correções publicadas e limpeza concluída desta rodada,
mas o último pedido normal de pesquisa/PDF falhou no aceite de autonomia.**

| Frente | Feito e verificado | Resultado / pendência |
| --- | --- | --- |
| Código publicado | `2a2ef44c` na main local/remota e na API, imagem `763c49fc`; quatro hashes compilados iguais ao build verificado. | A publicação da API levou **81,99s**. Navegador `ab3d9265`, web `d8882335`, executor físico `8aa6d479` mantidos. Sem APK novo. |
| Leitura das fontes | Conteúdo útil do artigo vem antes da navegação; elementos ocultos não deslocam a fonte visível; catálogos mantêm todos os artigos e blocos laterais mantêm preços/duração. | No pedido real, o README em português já começou no conteúdo útil com trecho de apenas 2 mil caracteres. Isso aprova essa correção específica. |
| Verificação local | **106/106 testes relacionados** passaram, zero falhas/cancelamentos/ignorados. TypeScript e build passaram; lint sem erros. | Testes locais não aprovam a execução inteira pelo chat. Não somei esses testes aos conjuntos anteriores, que têm sobreposição. |
| Pedido normal pelo chat | Conversa nova, uma mensagem normal, nenhum direcionamento de ferramenta, resposta ou resgate; somente **Luna**, com **34 respostas** e **dois PDFs criados**. | **Falhou em 567,602s (9min27,602s)**: revisões reprovaram os PDFs e o agente pediu que o usuário decidisse a substituição de um curso escolhido pelo próprio agente. **Zero arquivos finais entregues.** Somente esse QA foi cancelado após a falha observada. |
| Causa de autonomia | Localizada no guard de `ask_user`: consulta revisões opcionais ausentes neste pedido e ignora a revisão nativa do documento que já contém os reparos. | **Identificada, ainda não corrigida.** O próximo ajuste deve continuar o reparo/pesquisa já autorizado, preservando perguntas sobre informações privadas indispensáveis. |
| Limpeza do app | **11 registros próprios do QA** recolhidos: tarefa, conversa, quatro arquivos/previews, três notificações, inbox e sugestão. | Primeira etapa preservou **1.885 registros fora da seleção**; retirada da notificação tardia preservou **427 outros registros de notificação**. Atividade interna que tratou dados reais e recibos canônicos preservados. |
| Dados reais | **13 conferências finais passaram**. Mantidos companions/perfil, duas conversas, 58 arquivos, três memórias, 35 procedimentos e **três contas Google simultâneas**. | Links temporários dos arquivos renovam `expires`/`signature`; todos os campos armazenados e rotas de conteúdo permaneceram iguais. Aprendizado automático completo ainda não está aprovado. |
| Limpeza da VPS | Retiradas **quatro imagens Docker antigas**, **cinco diretórios de build** e **quatro arquivos de release**; aumento medido de espaço livre nas duas etapas: **1.712.840.704 bytes (~1,60 GiB)**. | API/navegador atuais e respectivas recuperações imediatas, OpenBao, volumes, perfis e dados reais preservados. 59.447 arquivos dos contextos foram inventariados; três contextos também conferiram integralmente com seus arquivos de release. |
| Limpeza local / APK | Quatro releases locais retirados, **212.852.783 bytes** de conteúdo (**212.860.928 bytes alocados**). | Releases atual/recuperação mantidos. Os **12 APKs obsoletos** já retirados estão no histórico; nesta rodada não houve nova exclusão nem publicação de APK. |
| Disponibilidade | Às **17:08:39 UTC**, API e página pública HTTP 200; API, navegador e OpenBao saudáveis; manutenção desligada e seis contadores de trabalho ativos em zero. | Fotografia pontual, sem aprovação de estabilidade sustentada. As **44 operações históricas incertas** seguem preservadas. |
| Performance / visualização | Recarga pontual do compositor em **859ms**; amostra da API durante pesquisa: **958 MiB e 28,73% de CPU**. | Não é pico nem prova da causa do consumo. Celular, startup, leitor PDF e latência continuam sem aprovação. |
| Workspace e cobertura de ferramentas | Casos anteriores comprovaram Drive com nome aproximado, Gmail/labels/rascunhos/envio, documentos, planilhas, slides, agenda e exclusão com card. | São casos específicos; **Workspace completo e equivalência integral Hermes/OpenClaw não estão aprovados**. Os contratos restantes continuam na matriz de ferramentas. |

O relatório anterior inferiu ausência de recuperação completa do GitHub pela
falta de uma chamada manual. Essa interpretação foi corrigida: a projeção para
inferência recupera automaticamente fontes preservadas; o recibo da interface
não captura essa projeção. Controles locais verificam a requisição seguinte ao
modelo, mas não são captura da inferência daquele QA histórico.

[Correção, causa restante e evidências desta rodada](2026-10-11-public-source-content.md).
[Inventário e contratos ainda pendentes](2026-10-09-harness-tool-inventory.json).
**22 evidências privadas** copiadas da VPS com SHA-256 conferido, em diretório
0700 e arquivos 0600, fora do Git. O navegador temporário foi fechado e seu
dispositivo revogado. A meta permanece ativa.

## Histórico — publicação e teste das 16:14 UTC

**Ainda não entregue como um todo. A API foi corrigida e publicada; o novo
pedido normal terminou com um PDF real. A latência, a atribuição de parte dos
fatos, o visualizador web e a cobertura integral permanecem sem aprovação.**

| Frente | Resultado comprovado | Limite / próximo trabalho |
| --- | --- | --- |
| Implementação | `790114cd` na main local/remota e na API; imagem `6fc61b47`. Cinco hashes compilados conferidos. | Navegador `ab3d9265`, web `d8882335`, executor físico `8aa6d479` mantidos. Sem APK novo. |
| Conclusão de documentos | Revisão ausente/reprovada retorna reparo específico; resultado parcial não contorna trabalho executável. Página inválida é corrigível; falha real do Office tem código próprio. | 192/192 testes relacionados passaram, TypeScript/build passaram, lint sem erros. Não é aprovação integral do harness. |
| Pedido normal pelo chat | Uma mensagem, conversa nova, zero respostas/direções do operador; **25 respostas somente de Luna**. Concluiu em **475,604s (7min55,604s)**, com um PDF entregue de **54.278 bytes e duas páginas**, revisado pelo agente. | Criou três versões; as duas primeiras foram rejeitadas por uma última página quase vazia. Tempo e repetição continuam excessivos. Não atribuo a diferença de tempo somente à correção. |
| Conteúdo e fontes | PDF contém os três cursos e campos solicitados, com qualificações para informações não publicadas. Fonte completa foi preservada. | GitHub retornou só 10.000 bytes visíveis de 54.057 bytes preservados, conforme `maxChars:10000` escolhido pelo agente. O recibo não captura a projeção à inferência. A ausência de chamada manual não demonstra ausência de recuperação automática; veja a correção da interpretação no estado atual. A atribuição integral ainda não está comprovada. |
| Visualizador | Arquivo disponível na conversa, controles navegaram de 1/2 para 2/2; bytes/texto e rasterização local conferidos. | O iframe PDF ficou vazio no navegador headless. Os controles não provam pixels visíveis no app. Compatibilidade e visualização pública ainda precisam verificação/correção. |
| Limpeza do QA | Dez registros próprios retirados da apresentação: conversa, tarefa, seis arquivos/previews, notificação e inbox. Procedimento aprendido automaticamente nesse QA foi arquivado. | 1.871 registros não selecionados iguais; 34 procedimentos anteriores mantêm suas versões. Recibos canônicos preservados. |
| Dados reais | Treze conferências de preservação passaram: companions/perfil, conversas, tarefas, ações, atividades, 58 arquivos, três memórias e três contas Google simultâneas. | Navegador de QA fechado e dispositivo temporário revogado; aprendizado permanece habilitado. Cobertura proativa continua parcial em algumas fontes. |
| Armazenamento | Removida a imagem antiga de API `26ee81b1`, sem uso por contêineres, e dois arquivos antigos de release. Diferença medida na VPS: **331.718.656 bytes (~316,4 MiB)**. Removidos também **106.690.620 bytes** de releases locais. | Imagem atual `6fc61b47` e recuperação imediata `8f4526d7` preservadas; nenhum volume tocado. A limpeza anterior de 12 APKs permanece registrada no histórico. |
| Performance/disponibilidade | API e página pública responderam HTTP 200 após a limpeza; publicação só da API levou **78,52s**. Compositor disponível em recarga de QA em 1.401ms. | Amostra de pesquisa: **972,4 MiB e 122,43% de CPU na API**. Amostra não é pico. Dados pequenos/desktop não aprovam celular, carga sustentada ou inicialização. |

**Próximos passos:** priorizar o conteúdo útil das fontes e recuperar trechos
necessários automaticamente; evitar regenerar documentos por exigências de
paginação que não impedem a leitura; medir as etapas da inicialização e as
chamadas de modelo/ferramenta; verificar o leitor PDF em navegador e celular;
completar os contratos de ferramentas e Google Workspace. A meta permanece ativa.

[Implementação e evidências desta etapa](2026-10-11-document-completion-repair.md).
Dezessete evidências privadas foram copiadas da VPS e conferidas por SHA-256.

## Histórico — publicação e teste natural das 15:18 UTC

**Não terminou. As correções foram publicadas e os testes locais passaram, mas o
pedido natural pelo chat falhou novamente. O harness completo não está aprovado.**

| Frente | Feito e verificado | Resultado / limite |
| --- | --- | --- |
| Código e publicação | Main contém `ab3d9265`, `cb510e09` e `46c45979`. A API está no commit `46c45979`, imagem `8f4526d7`; o navegador está em `ab3d9265`, imagem `7887204d`. Quatro artefatos compilados conferiram exatamente. | Web permanece `d8882335`; executor físico permanece `8aa6d479`. Nenhum APK novo foi criado. |
| Pesquisa | Corrigidos HTML com duração vazia, recuperação da extração e espera pela hidratação no DOM. | A fonte Microsoft real publicou 37 minutos e foi recuperada pelo leitor em 2,495s. Isso não aprova a pesquisa inteira. |
| Comandos | Sem prazo configurado, o adaptador preserva os argumentos e o padrão do backend, em vez de inserir indevidamente 30 minutos. | 16 controles específicos passaram, incluindo as duas falhas reproduzidas. |
| Build | O compilador recebe explicitamente o tsconfig original copiado. Duas compilações consecutivas concordaram, assim como a nova imagem Docker. | Fontes fixadas do OpenClaw intactas; não houve alteração do manifesto rejeitado para forçar aprovação. |
| Testes | **2.112/2.112 testes do conjunto servidor/mobile passaram**, zero falhas, cancelamentos ou testes ignorados, em 1.496,023s. TypeScript e builds específicos também passaram. | Testes locais não substituem o aceite natural; a primeira passagem teve quatro falhas, já reproduzidas e corrigidas. |
| Pedido pelo chat | Enviado uma vez em conversa nova, sem orientar ferramentas, pedir cards, responder ao agente ou reparar a tarefa. Somente Luna, sem fallback. | **Falhou em 580,744s (9min40,744s)**, com 32 respostas e três PDFs criados. **Nenhum arquivo foi entregue.** |
| Limpeza desta rodada | Retirados dez registros de apresentação do próprio QA: uma conversa, uma tarefa, cinco arquivos/previews, duas notificações e um item de inbox. Removidas duas imagens candidatas descartadas e seus arquivos/contextos de publicação. | 1.858 registros não selecionados permaneceram iguais. Cerca de **835 MiB** liberados na VPS; **106.871.703 bytes** de arquivos de release locais removidos. Imagens atuais/de recuperação, volumes e dados reais preservados. |
| Dados reais | Conferidos sem mudança companions/perfil, duas conversas, três tarefas, 58 arquivos, duas ações, cinco atividades, três memórias, três contas Google simultâneas e a lista de 34 procedimentos, incluindo um QA já arquivado anteriormente. | As 44 operações históricas incertas continuam preservadas. O navegador de teste foi fechado e seu dispositivo temporário revogado. |
| Disponibilidade | Publicação concluída com API e navegador nas imagens conferidas; manutenção encerrada e seis contadores de trabalho ativos em zero. Recarga pontual do compositor em 953ms. | A publicação levou **94,8s**. Inicialização lenta, consumo sustentado e desempenho geral continuam sem aprovação. |

## Por que o pedido real falhou

Pedido idêntico ao anterior:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

O agente pesquisou, criou e revisou os dois primeiros PDFs. Reprovou conteúdo e
paginação, depois fez a terceira versão: PDF de duas páginas e 51.121 bytes,
SHA-256 `aa7bb2e5850cd09d4d9914cb3f2dc3fa48507e2e9bc45ef87bfd9fd36c19a2d9`.
Os bytes, texto e links desse rascunho foram recuperados; a página 2 foi
renderizada e inspecionada independentemente. Isso não foi enviado ao agente
nem convertido em aprovação de entrega.

**Não houve inspeção nem confirmação da terceira versão pelo harness.** O agente
encerrou com resultado parcial porque ainda não a havia inspecionado. O host
aceitou esse encerramento e marcou a tarefa como falha, sem anexar o PDF. Não
houve falta de modelo ou de ferramenta observada que justificasse abandonar essa
etapa. A diferença entre existir um arquivo e entregá-lo está registrada.

Outro problema observado: após revisões reprovadas, `finish_task` devolveu a
mensagem genérica de pesquisa com links de outros cursos e “arquivo existe e
abre” como requisito faltante. Ela não apresentou os problemas específicos da
revisão como o próximo reparo. O trace mostra novas buscas e novas tentativas de
conclusão antes da correção efetiva. A causalidade completa dessa escolha do
modelo ainda precisa reprodução controlada; a permissão de encerrar sem revisar
o rascunho atual e a mensagem inadequada estão comprovadas no trace/código.

As rodadas escolheram cursos diferentes. Não atribuo o aumento de tempo apenas
à última mudança nem considero essa execução um teste aprovado da recuperação
de duração Microsoft, pois ela selecionou outro curso Microsoft.

**Próximo trabalho:** tratar o encerramento parcial quando ainda há uma revisão
executável pendente; devolver os reparos concretos do documento, sem desviar
para pesquisa genérica. Continuam pendentes os demais contratos de ferramentas,
Workspace completo, desempenho sustentado e UX. Não se deve trocar o principal
por um modelo de fronteira para encobrir esses problemas.

## Incidente na conferência da publicação

A primeira troca das imagens foi revertida por um erro na verificação manual da
publicação: o hash incluía a ordem de `Config.Env`. O Docker Compose pode mudar
a ordem sem mudar os valores. O retorno às imagens anteriores terminou, e os
dados foram conferidos iguais. A nova tentativa comparou todos os nomes e valores,
incluindo conferência do ambiente esperado **antes** da parada; todas as variáveis
permaneceram iguais. A publicação terminou em 94,8s. Houve intervalos de
indisponibilidade da API durante as trocas; isso não é aprovação de estabilidade.

A medição do cgroup da API observou cerca de 1,05 GB durante a inicialização.
Uma medição anterior do PID de init não representa o consumo do aplicativo e
não é usada como prova. O preflight local isolado do harness levou 6,785s,
com aproximadamente 777 MB de RSS; é outra máquina e não identifica a causa do
startup lento da VPS. A próxima investigação precisa separar os tempos de
abertura do banco, recuperação, criação do app e preflight, sem atribuição por
suposição.

[Causas e verificações específicas](2026-10-11-research-duration-recovery.md).
Treze evidências privadas locais foram copiadas da VPS e conferidas por SHA-256;
os arquivos estão em `artifacts/harness-parity-20261009/private-round76-vps`,
com permissão 0600. Logs principais: `round76-final-full-suite.log`,
`round76-normal-start.json`, `round76-post-cleanup-browser.json` e o conjunto
privado de recibos/diagnóstico. Credenciais não foram incluídas no relatório.

## Histórico — publicação e teste anterior de 11/10

**O trabalho completo ainda não terminou. API e executor foram atualizados; isso não aprova todo o harness.**

- **Main local/remota:** contém a implementação `8aa6d479`. A API usa exatamente esse commit e a imagem `26ee81b1`; nove artefatos compilados conferem com os hashes da verificação local. Web permanece `d8882335`, navegador da VPS `505e4f2f`; nenhum APK novo foi criado.
- **Mudanças publicadas:** despacho automático de cards elegíveis, entrega na conversa de origem, preservação de fontes/arquivos/recibos entre tentativas, aplicação de orientações antes da inferência, retomada da mesma tarefa após resposta e conclusão em texto pelo mesmo gate de entrega. Diretório/projeto, modelo, skills e tempo declarados são resolvidos pelo host. A retomada foi reproduzida antes da correção; os **163/163 testes de integração** e a repetição dos **9/9 cenários de retomada** passaram, com grupos sobrepostos. TypeScript e build passaram. São controles locais com provedor de teste, não aceitação natural desses contratos.
- **Executor físico:** quatro arquivos instalados com hashes conferidos para Python v2/diretório e prazo restante de comandos. Publicação em **4,29 segundos**. Os **1.236 recibos históricos** permaneceram iguais, assim como 14 outros arquivos, configuração, contas e worker. Conectado novamente, epoch 46, com arquivos, navegador, captura e runtime prontos. Persistência de variáveis no novo diretório ainda precisa prova física específica.
- **Disponibilidade:** página e health responderam **HTTP 200** após a troca. API, navegador e OpenBao saudáveis. A troca da API levou **77,60 segundos** e expôs um intervalo de HTTP 502. A inicialização mais lenta permanece sem causa comprovada; disponibilidade sustentada e consumo de recursos não estão aprovados.
- **Preservação:** após a troca da API, conferidos sem mudança companions/perfil, duas conversas, três tarefas, duas ações, cinco atividades, **58 arquivos**, **três memórias**, **três contas Google simultâneas** e 33 procedimentos. Aprendizado habilitado, sem revisão ativa e sem erro. As **44 operações históricas incertas** continuam preservadas.
- **Limpeza já feita:** retirados registros próprios de QA, imagens/releases obsoletos e **12 APKs antigos**, conforme recibos nas seções históricas. Mantidos os dados reais, versões atuais/de recuperação, volumes e backups. Na conferência das **14:10:57 UTC**, após a nova imagem e a limpeza do teste, a VPS tinha **31.291.715.584 bytes livres**, aproximadamente **29,14 GiB**; a nova build consumiu parte do espaço liberado. Não houve nova remoção de dados reais nesta publicação.
- **Novo teste pelo chat:** pedido natural de pesquisa/PDF enviado às **14:01:49,215 UTC**, uma vez, em conversa nova, sem mencionar ferramentas nem pedir cards. Concluiu sem resposta/orientação humana às **14:07:44,143 UTC**: **354,928 segundos (5min55s)**, com **20 respostas somente de Luna**. Gerou dois PDFs e entregou o segundo: **52.117 bytes, duas páginas**, SHA-256 `11f6349871237c7ec454afcfe1bfc9d20c1b04e98bce5ce46c82b67120ca4db2`. Bytes, texto, pixels e navegação nas duas páginas conferidos. **Entrega física aprovada; pesquisa completa e latência não aprovadas.** Um curso ficou sem duração concreta, e a comprovação de todos os demais campos não foi aprovada. Oito registros de apresentação desse QA foram retirados: quatro arquivos, tarefa, conversa, notificação e inbox. **1.846 registros fora da seleção permaneceram iguais**. O aprendizado criou automaticamente um procedimento do teste; ele foi arquivado, preservando os **33 anteriores** e seus dados. Recibos canônicos mantidos.

**Falta para a entrega:** preencher e comprovar os campos pesquisados, sem concluir com a duração ausente; reduzir a repetição e latência observadas; teste natural dos contratos novos; cobertura integral de Workspace/Hermes/OpenClaw; objetivos/PR/CI e navegador programático; transferência de orientações para uma tentativa sucessora; investigação da inicialização, uso de recursos e celular; revisão ampla de UX. Nenhum desses itens recebe aprovação por causa do HTTP 200 ou da suíte local.

## Verificação local anterior à publicação — retomada corrigida

**A falha de retomada descrita na atualização de 13:34 UTC foi corrigida e verificada localmente antes da publicação descrita acima. Não aceita ainda por pedido natural.** A resposta agora reconecta a mesma tarefa a um novo run, reutiliza o diretório e conserva fontes e recibos. Orientações recebidas são aplicadas antes da inferência. Uma segunda reprodução identificou a falha de conclusão por resposta em texto; esse caminho passou a usar o mesmo journal e gate de entrega do `finish_task`.

**163/163 controles de integração passaram**, incluindo Google Workspace, e os **nove controles de retomada passaram novamente** após os últimos ajustes; os grupos são sobrepostos. TypeScript e build do servidor passaram. A pausa global foi testada tanto para impedir a gravação quanto para permitir a conclusão depois da liberação. Às **13:47:10 UTC**, a produção continuava em `c0c2c9ec`, sem tarefas/conversas/HTTP/entregas nativas/admissões/recursos ativos, manutenção desligada e as 44 operações incertas preservadas. [Detalhes e limites da retomada](2026-10-11-kanban-native-resume.md).

A verificação natural dos novos contratos, a cobertura integral de ferramentas e Workspace, a comprovação factual, performance e UX continuam pendentes. Os snapshots seguintes são históricos.

## Atualização de status — 13:34 UTC

**Não terminou.** O critério de entrega pedido — pesquisa e documentos corretos, integração completa de ferramentas e conclusão autônoma — ainda não foi atendido.

- **Main local e remota:** `2a9bd79c`, com despacho automático, publicação na conversa de origem e preservação de fontes, arquivos e recibos entre tentativas. Os **114/114 controles ampliados** passaram; os **41/41 controles finais** também passaram, em um grupo sobreposto. As correções desse commit ainda não estão publicadas.
- **Correção em andamento, fora do commit:** a retomada de um card após uma resposta do usuário falhou no worker real. O teste reproduziu `Current run ownership could not be proven; nothing changed`: o bloqueio encerra o run do card, mas a resposta tenta continuar com o vínculo encerrado. Há alterações locais em cinco arquivos e um novo teste de reprodução; a correção ainda não foi validada e não deve ser tratada como entregue. Evidência: `artifacts/harness-parity-20261009/round75-resume-red.log`.
- **Produção conferida novamente:** às **13:33 UTC**, página e `/api/health` responderam **HTTP 200** a partir desta estação com user-agent de navegador. Às **13:33:34 UTC**, os três containers estavam saudáveis; API permanece em `c0c2c9ec`, navegador em `505e4f2f`. Uma consulta Python sem esse user-agent, feita da VPS, recebeu HTTP 403; não equivale a uma queda dos containers nem comprova que o acesso de todos os clientes funciona.
- **Pesquisa pelo chat já comprovada:** o pedido natural anterior entregou um PDF real em **98,617 segundos**, somente com Luna. A navegação e a entrega passaram; a atribuição factual integral não passou. Não houve novo pedido natural nesta continuação.
- **Limpeza já executada:** registros próprios de QA, imagens/releases obsoletos e 12 APKs antigos foram retirados conforme os recibos abaixo. A última conferência de preservação manteve companions, dados reais de Beatriz, três contas Google simultâneas, três memórias e 58 arquivos protegidos. O espaço livre atual na VPS é **32.370.475.008 bytes**, aproximadamente **30,15 GiB**. Nenhum dado de produção foi apagado nesta atualização de status.
- **Ainda falta:** concluir e verificar a retomada, publicar código e executor, testar os fluxos naturalmente no chat, completar a cobertura do Workspace/Hermes/OpenClaw e corrigir/medir performance e UX. Os testes locais não aprovam esses itens.

As seções seguintes preservam os resultados anteriores e suas limitações. O estado de 12:56 UTC é histórico; o commit atual é o indicado acima.

**Snapshot histórico anterior à publicação atual.** A API então publicada estava em `c0c2c9ec`. O pedido normal anterior de pesquisa concluiu sozinho em **1min38,617s**, com um PDF real, usando **14 respostas somente de Luna**. O arquivo abriu no app e a navegação nas duas páginas funcionou. A comprovação factual de todos os campos ainda não passou; a integração completa do Workspace, a equivalência integral com Hermes/OpenClaw e a performance sustentada também continuam abertas.

A continuação local integrou o despacho automático e a publicação na conversa de origem. Foram corrigidas também a fase das tentativas seguintes e a perda de evidências/arquivos entre tentativas. **114/114 controles ampliados passaram; 41/41 controles dos caminhos afetados passaram novamente após os ajustes finais. Ainda não publicado.** O histórico abaixo conserva a reprodução anterior de 0/4; o estado atual desta etapa está no [registro de despacho automático](2026-10-11-kanban-auto-dispatch.md).

## Estado histórico conferido às 12:56 UTC

- **Código:** main local e main no GitHub conferidas em `3beefbf7e08fcbba36c3f3469c3afe61b41aa455` antes desta atualização documental. Esse é o último commit de implementação. As correções locais de posse, workspace, perfis e prazo de execução descritas abaixo estão commitadas e enviadas, mas ainda não foram publicadas no servidor ou no executor físico.
- **Produção:** às **12:56:33 UTC**, página inicial e `/api/health` responderam **HTTP 200**. API, navegador do agente e OpenBao estavam em execução e saudáveis. As imagens continuam `b2d6cdaa`, `6bab849f` e `6d2b9385`, respectivamente. Esta conferência de disponibilidade não prova que o consumo ou as quedas intermitentes estejam corrigidos.
- **Última etapa implementada:** **77/77 testes de integração e 85/85 testes nativos passaram**. TypeScript e builds passaram; lint sem erros, com seis avisos. São verificações locais de escopo definido, não aprovação integral do produto.
- **Etapa atual incompleta:** foram escritos quatro testes para despacho automático, entrega à conversa de origem, retomada de falhas e preservação de operações incertas. **0/4 passou:** todos interrompem a verificação porque o ciclo automático ainda não cria a execução do card. Os cenários posteriores de entrega e recuperação, portanto, ainda não foram comprovados por esses testes. O arquivo `tests/kanban-auto-dispatch.test.ts` está em desenvolvimento, fora do último commit de implementação; os resultados estão em `artifacts/harness-parity-20261009/round73-auto-red.log`.
- **Sem nova publicação nesta etapa:** não houve nova execução pelo chat publicado, novo APK ou nova imagem Docker. A entrega completa continua pendente.

## O que foi corrigido e publicado

| Problema observado | Correção e validação |
| --- | --- |
| Consultas de busca descartadas | `b1ce9f19`: o dispatcher real valida os argumentos e preserva as consultas de `query` e `queries`, sem perder intenções. Uma execução publicada conferiu cinco consultas preservadas. |
| Aprovação de PDF antigo depois de criar um substituto | `b1ce9f19`: a confirmação da inspeção antiga é rejeitada. As duas correções passaram em **23/23 controles focados**, incluindo o worker real e Code Mode. |
| Pergunta sobre certificado/credencial educacional bloqueada como senha | `c0c2c9ec`: distingue texto apresentado ao usuário de identificadores de campos secretos. Aplicado às perguntas, opções, nomes de campos de formulários e rótulos de procedimentos. Identificadores de senha/token e pedidos reais de autenticação continuam protegidos. **26/26 controles focados** passaram, incluindo reproduções das falhas anteriores. |
| Modelo de fronteira usado como fallback automático | Retirado `grok/grok-4.6` do fallback automático. Principal: `chatgpt/gpt-6-luna`; alternativa: `mimo/mimo-v2.5-pro`. O último pedido usou apenas Luna. Não houve substituição do principal por Astra. |
| Conversa salva reaparecia como rascunho depois da limpeza | Correção `6b295f52`, incluída no web `d8882335`. A recarga atual confirmou compositor disponível e ausência da conversa, tarefa e PDF de QA retirados. |
| Aprendizado automático falhava na fila de Code Mode | Falha reproduzida e corrigida em rodada anterior. Revisão de conversa em **10,789s** e aprendizado de procedimento em **15,166s** nos casos verificados. As três memórias reais permanecem salvas. Na conferência atual, aprendizado habilitado, sem revisão ativa e sem erro. |

TypeScript do projeto, build do servidor, assets e harness passaram para `c0c2c9ec`. Lint terminou sem erros, com **dois avisos preexistentes**. Os grupos de testes têm escopos próprios; não são uma nova aprovação da suíte completa ou de todo o produto.

## Pedido normal anterior pelo chat publicado — 10:37 UTC

Enviado uma única vez em conversa nova, sem citar ferramentas, orientar o agente, responder a perguntas ou reparar a tarefa manualmente:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

| Verificação | Resultado |
| --- | --- |
| Tempo | Envio às **10:37:29,849 UTC**; conclusão às **10:39:08,466 UTC**: **98,617 segundos**. |
| Modelo | **14 respostas concluídas de Luna**, sem fallback concluído ou modelo de fronteira. |
| Pesquisa | Duas buscas, uma extração de três páginas e dois fetches. Uma página FGV bloqueada foi substituída por uma fonte utilizável. |
| Entrega física | PDF de **44.467 bytes**, duas páginas. SHA-256 `b75eaab09432a4224bcec638240a9a3e8205bb32301c495da6c5a798a2185743`. Bytes, texto, pixels e navegação no visualizador publicado conferidos. |
| Conteúdo | Compara três cursos, com conteúdo, idioma, duração e certificado. Os dois cursos Egov têm idioma, duração e informações de gratuidade/certificação explícitos nas páginas selecionadas. |
| Limite factual | Para o curso Bradesco, a seção específica lida comprova quatro horas, prazo de 60 dias, conteúdo e aprovação com 70%. Não declara explicitamente idioma nem preço do certificado. As declarações literais de certificado gratuito na mesma resposta pertencem a cursos relacionados. Isso **não prova que as afirmações do PDF sejam falsas**, mas deixa a atribuição incompleta. |
| Aceite | **Entrega física, conclusão sem intervenção e navegação aprovadas neste caso. Comprovação factual integral não aprovada.** |

A rodada anterior ficou **11min39,539s** sem entrega autônoma, com 54 respostas de Luna e Grok; somente aquele teste foi cancelado pelo operador. A melhora atual é uma observação de um novo caso, com cursos e sequência de execução diferentes. Não atribuo toda a redução de tempo à última correção nem considero a latência de todos os pedidos resolvida.

## Integrações já verificadas e seu alcance

| Fluxo | O que foi observado no app publicado |
| --- | --- |
| Drive com nome aproximado | “MOVING DE” encontrou `MovingDE` entre as três contas; travessia de **508 arquivos e 15 subpastas**, em 18 páginas. Não comprova leitura integral dos documentos nem conclusão da renovação de vistos. |
| Gmail: rascunho e envio | Pedido natural criou rascunho na conta de teste, com card automático. Envio executado e mensagem encontrada posteriormente por outra conversa. |
| Gmail: labels e arquivo | Dois e-mails de teste receberam a label e saíram de `INBOX`, confirmado por releitura. Não aprova limpeza em massa. |
| Docs, Sheets e Slides | Criações/alterações de teste confirmadas por releitura, incluindo fórmula em planilha e conteúdo de dois slides. Não cobrem todas as operações. |
| Agenda | Evento conferido às 15h–15h30 de 11/10, `Europe/Berlin` (+02:00), com lembrete dez minutos antes. Uma falha de reconexão limita a prova de autonomia desse caso. |
| Exclusão com aprovação | E-mail de teste só foi para `TRASH` depois da aprovação no card; alteração confirmada no Google e tarefa retomada. |
| Imagem conectada | Pedido normal com Luna usou **`codex/gpt-image-2`**, com entrega em **89,029s**; fonte e pixels conferidos. |
| Histórico/carregamento | Coordenação limitada à conversa e resumos paginados. Amostras de recarga de **529/534 ms** para o compositor; não equivalem a um teste sustentado em celular físico. |
| Cards/ações | Card de rascunho aparece automaticamente e fica compacto depois do envio. A revisão ampla de UX e a divergência de contador permanecem abertas. |

## Publicação, limpeza e preservação

- **API:** `c0c2c9ec`, imagem `b2d6cdaa`. Publicação em **22,59 segundos**, com parada limpa e conferência dos artefatos compilados. Banco, configuração e identidade do navegador preservados.
- **Navegador do agente:** `505e4f2f`, imagem `6bab849f`; **web:** `d8882335`. Não houve novo APK nesta rodada. Main local/remota está em `3beefbf7` antes da atualização deste relatório e contém as correções locais descritas abaixo; elas ainda não estão publicadas.
- **QA atual:** retirados **seis registros de apresentação**: dois arquivos, uma tarefa, uma conversa, uma notificação e uma entrada de inbox. **1.840 registros fora da seleção ficaram idênticos**. Os 33 registros anteriores de versões de procedimentos não mudaram. Inspector fechado, hooks removidos e recibos canônicos preservados.
- **Preservação conferida:** companions e perfil, **58 arquivos protegidos**, duas conversas reais, três tarefas reais, duas ações, cinco atividades, **três memórias** e **três contas Google simultâneas**. Não houve procedimento novo de QA para arquivar.
- **Docker nesta rodada:** retiradas **oito imagens antigas sem referência em containers**; aumento observado de espaço livre de **1.607.122.944 bytes**. Preservadas API atual e recuperação, navegador atual e recuperação, OpenBao, volumes, perfis e backups. Retirados também **oito diretórios de build e seus arquivos de release**, após conferir **95.051 hashes de arquivos**; essa etapa liberou mais **1.696.251.904 bytes** na VPS. Containers, mounts, ambiente e imagens retidas permaneceram iguais. A soma dos aumentos observados nas duas etapas é cerca de **3,30 GB**; não é a soma dos tamanhos nominais das imagens com camadas compartilhadas.
- **Releases locais nesta rodada:** oito arquivos obsoletos removidos após conferir hashes contra os recibos da VPS, liberando **425.938.944 bytes alocados**. Versões atuais e de recuperação preservadas.
- **Espaço livre após a limpeza:** **32.380.198.912 bytes** na VPS, aproximadamente **30,16 GiB**. É a fotografia final, não uma medida de disponibilidade sustentada.
- **Limpeza anterior:** três imagens API e seus diretórios/arquivos de release retirados, com cerca de **1,31 GB** de liberação líquida na VPS; três arquivos locais de release liberaram **159.584.256 bytes alocados**. **12 APKs obsoletos** retirados anteriormente, liberando **811.757.568 bytes alocados**. Não houve nova remoção de APK nesta rodada.

API, navegador e OpenBao estavam saudáveis na conferência. Sem tarefas, conversas ou solicitações HTTP ativas; manutenção desligada. Permanecem **44 operações históricas incertas**, preservadas para reconciliação com evidência. Não foram apagadas ou marcadas como sucesso para esconder erros.

## Avanço local posterior — vínculo do dispatcher

Identificada a ausência do despacho automático de cards. Os testes anteriores inseriam o vínculo de execução manualmente. O host agora tem um caminho que grava card, run, tarefa e vínculo juntos, com proteção contra concorrência, revogação do perfil, pausa e perda de confirmação. **56/56 controles focados**, TypeScript, builds e lint passaram. O provedor usado nesse grupo é de teste; não constitui aceitação normal com Luna. Despacho automático, renovação de posse, provisionamento físico e entrega à conversa correta ainda precisam integração. **Esse avanço não foi publicado.** Detalhes no [registro do dispatcher](2026-10-11-kanban-dispatch.md).

Na continuação, a posse foi vinculada à autoridade da tarefa nativa: o prazo antigo de dois minutos não libera um card enquanto sua tarefa executa ou aguarda decisão. Um ator substituído perde o acesso; mudanças de vínculo, validade e pausa no instante da gravação são rejeitadas. Confirmações perdidas sobrevivem à troca de ator sem repetir a conclusão. **91/91 testes focados**, TypeScript, builds e lint passaram; os 14 novos casos são controles locais, incluindo o worker real com relógio controlado. **Não houve publicação nem novo pedido normal no app nessa continuação.** Despacho automático, workspace e os demais contratos seguem pendentes. Detalhes no [registro de posse](2026-10-11-kanban-native-ownership.md).

Na continuação seguinte, o dispatcher passou a registrar a intenção de diretório e o worker existente prepara scratch, diretório explícito ou worktree Git real. Terminal, arquivos e Python recebem o diretório confirmado; a sessão Python do card acompanha tarefa/run e o protocolo v2 leva o diretório até o launcher físico. A recuperação de confirmação perdida usa o vínculo criado pelo host e não repete diretório, pesquisa ou conclusão. **110/110 controles de integração e 61/61 de Python passaram**, além de TypeScript, builds e lint sem erros. **Esta continuação ainda não foi publicada nem aceita por pedido normal no app.** Projetos/configuração, objetivo/CI, despacho automático, entrega e os demais requisitos abaixo permanecem pendentes. Detalhes no [registro de workspace](2026-10-11-kanban-workspace.md).

Na etapa local seguinte, projeto/diretório, modelo e skills do perfil foram ligados ao worker. O card pode selecionar uma rota de modelo conectada; os guias atribuídos chegam completos à primeira inferência e os demais continuam por descoberta. A entrega já registrada também se recupera com o provedor desconectado. Foi reproduzida e corrigida a classificação que exigia alteração de agenda para um pedido de explicação; pedidos explícitos de arquivo e execução mantêm suas obrigações. **140/140 testes focados**, TypeScript e builds passaram; lint sem erros, com sete avisos. **Ainda não publicado nem validado por pedido natural no app.** Às 12:19:44 UTC, página e API responderam HTTP 200 e os três containers estavam saudáveis; a API permanece em `c0c2c9ec`. [Registro desta etapa](2026-10-11-kanban-execution-config.md).

A etapa local posterior integrou o tempo declarado no card/perfil ao worker e ao supervisor físico. O prazo não reinicia ao consultar um job; expiração cancela o mesmo processo e não executa a fonte novamente. Uma corrida reproduzida depois da entrega gravada agora recupera o recibo sem outra chamada ao modelo. **77/77 controles de integração e 85/85 testes nativos passaram**, além de TypeScript e builds; lint sem erros, com seis avisos. **Ainda não publicado nem validado por pedido natural no app.** Despacho automático, fase de novas tentativas, objetivos/CI e publicação continuam pendentes. [Registro desta etapa](2026-10-11-kanban-runtime.md).

Na continuação atual, o ciclo existente passou a iniciar cards automaticamente, e a ferramenta de criação conserva a origem para publicar o resultado uma vez no chat correto. Tentativas encerradas restauram a fase; cancelamentos não recomeçam, e operações incertas mantêm sua proteção, mesmo com parada física confirmada. Fontes, arquivos reais e recibos das tentativas anteriores permanecem disponíveis, sem copiar os recibos ou repetir uma chamada concreta concluída. Exclusão de conversa e incerteza que surgem no instante da gravação impedem a criação da nova tarefa. **114/114 controles em 14 arquivos e 41/41 controles finais em quatro arquivos passaram**, além de TypeScript e builds; lint sem erros, com três avisos. **Ainda não publicado, sem novo pedido natural, sem escrita em produção.** A transferência de orientações ainda não aplicadas, os contratos de objetivo/CI e os demais requisitos permanecem abertos. [Registro desta etapa](2026-10-11-kanban-auto-dispatch.md).

## Pendências que impedem declarar a entrega

1. Garantir comprovação dos campos pedidos no item correto, sem aproveitar informação de outro curso/documento. O contrato atual de conclusão física ainda não garante isso.
2. Publicar e verificar naturalmente o despacho automático, a entrega ao chat correto e a continuidade, incluindo orientações/decisões pendentes. Completar e verificar os demais contratos de Hermes/OpenClaw: perfis/worktrees no executor publicado, objetivos, CI, ferramentas kanban e execução programática do navegador. Schemas e código presentes não comprovam equivalência completa.
3. Ampliar os testes normais pelo chat de todas as operações do Google Workspace, incluindo alterações, exclusões e cards. Os casos acima são aprovações específicas.
4. Corrigir a causa do consumo alto e medir celular sob uso repetido. Na última amostra o servidor usava **1.005 MiB** e o navegador **421,2 MiB**, ainda com aproximadamente 7% e 8,5% de CPU sem tarefa ativa. **A causa não está estabelecida nem corrigida.**
5. Concluir a revisão ampla das ações/resumos e reconciliar as operações históricas incertas.

**16 arquivos privados da VPS foram copiados com hashes conferidos**, incluindo publicação, resultado, PDF, integridade e limpeza. Evidência privada atual em `artifacts/harness-parity-20261009/private-round67-vps`, fora do Git. O [histórico técnico](2026-10-09-harness-parity.md) e a [matriz de ferramentas](2026-10-09-harness-tool-inventory.json) preservam os resultados e limites de cada rodada.

**O objetivo permanece ativo. Não há aprovação integral do harness, do Workspace ou da performance.**

## Fechamento desta atualização — 14:10:57 UTC

A conferência após a limpeza manteve todos os dados protegidos e as três contas/memórias, sem erro de aprendizado. O procedimento aprendido exclusivamente pelo QA está arquivado, e os 33 anteriores ficaram iguais. Containers saudáveis, manutenção desligada e 44 operações históricas incertas preservadas. Havia **uma tarefa e uma admissão em segundo plano**, sem conversa, HTTP, entrega nativa ou recurso ativo; esta fotografia não é um estado totalmente ocioso e não aprova performance.

O arquivo produzido no novo pedido normal comprova entrega física, mas também expõe o aceite indevido de pesquisa sem duração concreta em um dos itens. Esse achado, os 5min55s/20 respostas e a inicialização de 77,60s continuam sem correção nesta atualização. O relatório foi atualizado para separar publicação, testes locais e aceite funcional.

**17 comprovantes privados desta atualização** foram copiados da VPS/computador com SHA-256 conferido e permissões 0600. Incluem publicação, hashes da imagem, resultado real, preservação e limpeza. A sessão web temporária de QA foi revogada após fechar o navegador; a sessão de diagnóstico foi preservada. Evidências locais em `artifacts/harness-parity-20261009/private-round75-vps` e `private-round75-native`, fora do Git.
