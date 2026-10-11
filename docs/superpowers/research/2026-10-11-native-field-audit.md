# Conferência factual na revisão nativa — 11/10/2026

O pedido comum anterior criou um PDF, mas a revisão registrou somente
`passed: true` e `issues: []`. A conclusão comprovou bytes e revisão visual;
não havia um registro de cada campo solicitado. Idioma/preço da credencial
Google e duração Microsoft permaneceram sem confirmação.

Na configuração padrão, a mesma resposta do executor que avalia as páginas
agora precisa registrar `requestAudit`: requisito, satisfação e evidência.
O requisito identifica o item e o campo; a evidência compara a afirmação
real do documento com a fonte observada ou identifica a lacuna e a leitura
útil restante. Não adiciona chamada de modelo ou revisor. Quando a revisão
independente está explicitamente habilitada, seu protocolo factual existente
continua responsável pelo audit, sem duplicar a exigência.

O host valida o esquema da resposta exigida, incluindo o recibo específico.
Antes, esse esquema era anunciado ao provedor, mas apenas o esquema comum
da ferramenta era validado na execução. Um campo pendente do audit impede
aprovação mesmo se o booleano agregado disser `true`; a lacuna fica salva
nos mesmos bytes, proprietário, tarefa e revisão e orienta a correção.

Isso verifica consistência e registra uma avaliação do modelo; não prova
semanticamente que todos os requisitos foram enumerados nem que uma
citação é verdadeira. O pedido comum e suas fontes ainda precisam de
conferência independente antes de considerar o problema factual resolvido.

Duas reproduções falharam antes da implementação. O worker real rejeita
aprovação sem o audit obrigatório, mantém pendente um PDF com duração não
confirmada, permite ler o syllabus e substituir o rascunho, e entrega só o
arquivo corrigido, sem revisor separado. A API interna de revisão mantém
compatibilidade com registros anteriores e documentos sem pesquisa.

A verificação final passou com **40/40 testes** de documentos, revisão padrão,
executor copiado e contexto. Cinco casos específicos da revisão independente
opcional também passaram; não são somados com grupos intermediários que
repetiram testes. TypeScript e lint passaram (o lint mantém oito avisos
preexistentes). O teste controlado não comprova a seleção autônoma de fontes
ou a precisão do modelo real.

Evidências privadas: `artifacts/harness-parity-20261009/round85-*.log`.

## Publicação

A implementação `28f4d42a` foi publicada na API, imagem `50517464`,
com dez hashes compilados conferidos. A troca levou 23,14s e as 13
comparações de preservação passaram. Web, APK, navegador físico, contas
Google, memória e dados foram mantidos. A API pública respondeu HTTP 200
em uma amostra durante o build, sem atribuir isso a estabilidade sustentada.

O pedido comum foi enviado uma vez pelo chat em conversa nova, sem citar
ferramentas ou pedir o audit. A primeira revisão de Luna registrou doze
campos, rejeitou três pendências de idioma/certificado e retomou a pesquisa
sem perguntar ao operador. Isso demonstra a escolha autônoma do novo
protocolo; não é aprovação final do PDF ou do harness. Também rejeitou
paginação legível e pediu duas páginas sem limite explícito do usuário;
esse possível retrabalho precisa ser separado das lacunas factuais.

A amostra não isolou o tempo de provedor de cada ferramenta. A consulta de
metadados de uso do próprio executor será registrada após o encerramento.
Não há mudança de esforço de raciocínio: a escolha `medium` observada
corresponde ao contrato configurado e não foi tratada como defeito sem
comparação de qualidade.

O inventário de paridade foi corrigido: `browser_exec` do Hermes não está
registrado nos diretórios do servidor/worker. Seu backend com helpers
Python, sessões nomeadas, redaction e contenção de timeout está ausente,
não apenas aguardando um teste. Os callbacks gerais de Python não
comprovam esse contrato. A meta completa permanece aberta.

## Resultado real, consumo e limpeza

O pedido comum terminou com **26 respostas somente de Luna**, sem pergunta,
orientação, intervenção ou fallback. Criou **quatro versões de PDF** e entregou
a última, de **65.896 bytes**, SHA-256
`a57343451635f5cc8d010bc1269b7e42c853023c1fc3e1063362f882d5afe83c`.
As duas páginas foram abertas no leitor público e seus pixels conferidos;
oito destinos distintos de fontes aparecem na segunda página.

Até a última resposta do modelo foram **568,406s desde a criação da tarefa**
e **574,748s desde o envio no navegador**. O despacho de `finish_task` veio
1,237s depois dessa resposta; não há timestamp separado de publicação final
no recibo. Portanto, o resultado leva cerca de **9min35s**, não dois minutos.
Os dois primeiros arquivos tinham três páginas. As revisões continuaram
misturando pendências factuais com exigências de composição; uma preferência
por duas páginas não constava do pedido do usuário.

A sessão própria preservou metadados positivos de uso em todas as 26 respostas:
**2.702.644 tokens de entrada e 9.241 de saída, total 2.711.885**.
Os **576.128 de cache de entrada já estão incluídos** na entrada e não são
somados novamente. Maior entrada de uma resposta: **150.938 tokens**.
São números reportados pelo provedor, sem inferência de preço. A sessão
anterior tinha 15 respostas e total 739.383; opções/fontes diferentes impedem
atribuir toda a diferença exclusivamente ao audit. O tempo de cada ferramenta
e o tempo do provedor não foram isolados.

As quatro revisões registraram doze campos cada. A última aprovou o arquivo,
mas o texto final ainda deixa idioma Google, custo das credenciais Google/IBM
e duração total Microsoft sem determinação. O modelo preferiu qualificar as
lacunas; isso melhora a honestidade, mas não comprova cumprimento integral
do pedido. A conferência física/autonomia passou; **rapidez e aceite factual
completo continuam reprovados**. A auditoria semântica de todas as fontes
não foi concluída. Nenhuma alegação de paridade integral foi aprovada.

A limpeza recolheu **12 registros de apresentação exclusivamente próprios**:
oito arquivos/previews, uma tarefa, uma conversa, uma notificação e um inbox.
**1.929 registros fora da seleção permaneceram iguais**. Recibos canônicos e
bytes das evidências foram mantidos; inspector fechado e hooks removidos.
Os 35 procedimentos anteriores mantêm suas versões; nenhum novo procedimento
próprio precisou ser arquivado. O navegador de QA foi encerrado e seu dispositivo
temporário revogado. As 13 comparações finais passaram: 58 arquivos reais,
duas conversas, três memórias, 35 procedimentos e três contas Google simultâneas.

A imagem/contexto/archive da API anterior à recuperação imediata foram
retirados após inventário e comparação de conteúdo. A VPS ganhou
**435.486.720 bytes (~415,3 MiB)** nessa etapa. Localmente foi retirado o mesmo
archive de 53.492.344 bytes, com SHA-256 conferido. Atual, recuperação, APK,
volumes e dados reais foram preservados. A limpeza anterior de cache/release
liberou ~25,44 GiB; é histórico e não é somada de novo à medição desta etapa.

Às **20:50 UTC**, página e API públicas responderam HTTP 200 e os três containers
estavam saudáveis, sem manutenção e com os seis contadores de execução em zero.
As 44 operações históricas incertas seguem preservadas. Amostra da API:
1,077 GiB de RAM e 53,57% CPU; navegador: 543,1 MiB e 9,92% CPU.
Essa amostra não comprova pico, GPU, celular ou estabilidade sustentada.
