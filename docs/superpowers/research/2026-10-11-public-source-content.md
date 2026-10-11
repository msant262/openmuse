# Conteúdo útil das fontes públicas — 11/10/2026

## Causa reproduzida

O leitor de produção escolhia o primeiro elemento `main` ou `article` na ordem
do HTML. No GitHub, o `main` externo contém a navegação, a lista de arquivos e
o README em um `article` interno. Com o HTML real de 524.228 bytes e
`maxChars:10000`, o trecho começou em “Repository navigation”, sem a seção de
traduções do README. O texto completo extraído tinha 54.031 caracteres.

Havia outros dois defeitos: um artigo dentro de um ancestral oculto podia ser
selecionado, e catálogos com `role="main"` e vários artigos devolviam somente o
primeiro artigo.

## Correção

Commit `2a2ef44ce7ff6854f8403947d36c3c344803c54b` na main local/remota.
O leitor reconhece o elemento/role principal visível e coloca um artigo único
antes da navegação. Mantém os outros fatos da região principal, inclusive
preços/duração em blocos laterais e regiões ainda carregando. Catálogos mantêm
todos os artigos. O renderer Markdown copiado do OpenClaw, os dados publicados,
as fontes preservadas, a posse dos arquivos e a validação de rede permanecem
no caminho de execução.

Com o mesmo HTML e o mesmo limite de 10.000 caracteres, o trecho passou a
começar no README e incluiu a seção de traduções e a referência ao português.
Nenhum aumento de limite ou novo pedido de pesquisa foi necessário.

## Verificação

- Quatro controles novos falharam antes da implementação; o controle adicional
  de preço em bloco lateral também reproduziu perda de informação e foi corrigido.
- O conjunto final passou com **106/106 testes**, zero falhas, cancelamentos ou
  ignorados, em 67.225,960 ms. Cobre seleção, HTTP/SSRF, redirecionamentos,
  cancelamento, HTML profundo, dados públicos, extração parcial e recuperação.
- Os testes do executor conferem a requisição seguinte enviada à inferência:
  fontes preservadas completas são entregues automaticamente em contextos de
  131.072 e 1.048.576 tokens, sem nova requisição de rede. O recibo canônico e o
  evento da interface conservam o trecho solicitado.
- TypeScript e build passaram; lint sem erros, com dois avisos preexistentes.
- A primeira implementação introduziu serialização recursiva em HTML profundo;
  a regressão foi detectada e removida antes do conjunto final aprovado.

## Correção da interpretação do QA anterior

A ausência de `read_tool_output` ou `read_web_source` no QA anterior não prova
que a fonte completa não chegou ao modelo. `projectToolResult` chama
`recoverResearchToolResult` antes da inferência e confere posse, origem, bytes e
hash. O recibo canônico observado tinha 10.000 caracteres e não registra essa
projeção. O campo `fullSourceRecoveredByHarness:false` no diagnóstico anterior
foi inferido dessa ausência; não é observação da requisição de inferência.

Isso corrige a interpretação, sem transformar testes controlados em captura da
inferência daquele pedido real. A atribuição de cada afirmação continua sujeita
à revisão das fontes.

## Publicação e pedido normal pelo chat

A API publicada usa o commit acima e a imagem `763c49fc`. Os quatro hashes
compilados conferiram; a troca só da API levou **81,99 segundos**. Navegador,
web e executor físico mantiveram as versões anteriores. Não houve APK novo.

Uma conversa nova recebeu uma única mensagem normal, sem instruir ferramentas,
responder ao agente ou consertar o resultado:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

O trace publicado comprova que o fetch do README em português começou em
“IA Generativa Para Iniciantes”, inclusive com `maxChars:2000`. A correção de
seleção foi exercitada no pedido real. Isso não aprova a autonomia inteira.

**O pedido falhou no aceite natural.** Após **567,602 segundos (9min27,602s)**,
**34 respostas somente de Luna** e **dois PDFs reprovados**, o agente pediu ao
usuário para escolher entre substituir um curso selecionado por ele ou aceitar
um campo não comprovado. Não entregou arquivo final. Nenhuma resposta ou
orientação foi fornecida; somente esse QA foi cancelado depois de registrar a
espera por input. Cancelamento e limpeza não são conclusão autônoma.

As revisões identificaram linhas partidas entre páginas e afirmações não
comprovadas sobre idioma/certificado. O bloqueio de `finish_task` devolveu o
reparo concreto e impediu encerrar parcialmente por falta de revisão. Contudo,
o guard de `ask_user` só consulta `documentBriefReview` e
`researchDeliveryReview`. Ambos estavam ausentes neste pedido. A revisão
factual opcional está desligada por padrão, e o guard não usou a revisão nativa
de documento reprovada, já disponível no estado de continuação.

**Essa causa está identificada, mas ainda não foi corrigida nesta publicação.**
O próximo reparo deve usar a evidência nativa atual, ligada aos bytes e à revisão
da tarefa, sem exigir outra revisão opcional de modelo. Deve conservar perguntas
sobre decisões/informações privadas indispensáveis e rejeitar perguntas que
apenas transferem ao usuário a escolha pública já delegada ao agente. As
exigências de comprovação dos fatos permanecem necessárias.

## Limpeza e preservação

Foram recolhidos dez registros próprios do QA e, depois, uma notificação
proativa derivada desse mesmo teste: tarefa, conversa, quatro arquivos/previews,
três notificações, inbox e sugestão. Na primeira etapa, **1.885 registros fora
da seleção** permaneceram iguais. Na segunda, **427 outros registros de
notificação** permaneceram iguais. A atividade interna de revisão que também
tratou dados reais foi preservada; recibos canônicos não foram apagados.

As **13 comparações finais** passaram: companions/perfil, ações, atividades,
conversas, tarefas, arquivos, memórias, procedimentos e contas Google. Os
**58 arquivos**, **duas conversas**, **três contas simultâneas**, **três memórias**
e **35 procedimentos** anteriores permanecem. A comparação de arquivos conserva
todos os campos armazenados e a rota de conteúdo; somente `expires` e
`signature` dos links assinados de 15 minutos são renovados pelo servidor.
Os primeiros recibos que detectaram diferenças continuam preservados, junto
das verificações posteriores. Nenhum procedimento novo foi arquivado neste QA.

O navegador temporário foi fechado e seu dispositivo revogado. A amostra de
recarga do compositor foi de **859ms**, em desktop e com dados pequenos; não
aprova desempenho em celular. A amostra da API durante a pesquisa foi
**958 MiB / 28,73% de CPU**, não uma medição de pico ou causa do consumo alto.

Na VPS foram retiradas quatro imagens antigas sem uso por contêineres, cinco
contextos de build e quatro releases. Foram mantidas as imagens atuais e as
recuperações imediatas de API/navegador, o OpenBao e os releases atual/anterior.
Os 59.447 arquivos dos contextos foram inventariados antes da remoção; três
contextos também coincidiram integralmente com seus arquivos de release.
Contêineres, mounts e configuração permaneceram iguais. O aumento observado
de espaço livre somado nas duas etapas foi de **1.712.840.704 bytes (~1,60 GiB)**.
Quatro releases locais, com hashes iguais aos recibos da VPS, liberaram
**212.860.928 bytes alocados**. Nenhum volume foi limpo. Não houve novo APK
nem nova exclusão de APK nesta etapa.

Às 17:08:39 UTC, página pública e health retornaram HTTP 200, os três
contêineres estavam saudáveis e a manutenção estava desligada. Isso é uma
conferência pontual. As 44 operações históricas incertas foram preservadas.
Foram copiadas 22 evidências privadas com hashes conferidos, fora do Git.

O harness completo continua sem aprovação: latência, repetição de documentos,
visualizador, uso no celular e contratos integrais de ferramentas/Workspace
continuam no escopo da meta.
