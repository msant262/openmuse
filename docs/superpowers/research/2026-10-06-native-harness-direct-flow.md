# Fluxo nativo de pesquisa e imagem — 6 de outubro de 2026

## Falhas reproduzidas

A tarefa original `d1c6ca4705d3537b0fafb7cc84d602e15157adc3ac332ad05cf65d9c4247534e`
falhou em oito segundos, sem executar ferramentas. O executor havia respondido
com uma pergunta sobre o ano; o host tratava qualquer encerramento em texto como
conclusão e substituía a pergunta por um erro de arquivo inexistente.

A retomada real com Luna produziu um PNG pelo GPT Image 2. Entretanto, as revisões
extras de briefing confundiam códigos de UF e propunham mudanças contraditórias.
Pesquisa, revisões e geração levaram 818 segundos depois da resposta sobre o ano.
Essa execução é a linha de base lenta, não uma aprovação do desempenho. Os 54
percentuais do PNG foram comparados com os recibos da agregação: nenhuma diferença.

Dez validações novas, sem fornecer números nem URLs ao executor, também falharam.
A primeira pediu confirmação antes de pesquisar em cerca de 21 segundos. A segunda
pesquisou e, em 184 segundos, afirmou incorretamente que 4 de outubro estaria no
futuro em relação a 6 de outubro. A terceira corrigiu a data, mas em 51 segundos
pediu ao usuário os dados depois de ler apenas duas páginas, embora a reportagem
retornasse links de apuração não lidos. A quarta pesquisou por 278 segundos, encontrou
a base municipal, mas descartou os dados do G1 por não conseguir conferência direta
no TSE; terminou sem imagem. A quinta reconheceu a fragilidade de somar posições
de candidatos, mas terminou em 165 segundos após obter somente uma de 28 linhas
agregadas; as demais estavam disponíveis pela própria ferramenta. Nenhuma das
cinco entregou a imagem solicitada. A sexta chamou GPT Image 2 em 82 segundos e
recebeu um arquivo em cerca de 194 segundos, mas era um mapa de status sem os
percentuais estaduais. A tarefa terminou parcial em 214 segundos; esse arquivo
não é aprovação da tarefa nem do desempenho. A sétima sofreu interrupção do
provedor, depois um bloqueio falso de reconciliação do computador. Sua retomada
produziu somente três estados; terminou parcial em 1.074 segundos, incluindo a
pausa de operação para publicar a correção. A oitava, sem intervenções, terminou
parcial em 256 segundos com um mapa cinza sem percentuais estaduais. Nenhuma das
dez cumpre a solicitação. A nona terminou em 62 segundos sem arquivo: leu uma
prévia JSON truncada e encerrou antes de consultar as linhas ou os links relevantes.
A décima terminou em 41 segundos sem arquivo após a reportagem de serviço,
sem ler seus links de apuração. Somente as três
tarefas de diagnóstico pausadas foram canceladas, preservando seus recibos privados
e a tarefa do usuário. Não se respondeu à pergunta incorreta para aparentar sucesso.

## Fronteiras corrigidas

O fluxo padrão é o executor nativo pesquisar, gerar e entregar. As chamadas
independentes de modelo para revisar briefing e entrega são opcionais, habilitadas
somente com `AGENT_RESEARCH_REVIEW_ENABLED=true`. Conexão de imagem, pertencimento
dos arquivos, recibos duráveis, critérios de conclusão e revisão de ações externas
continuam no servidor. Verificação mecânica não certifica a precisão de cada número.

Texto ou `finish_task` prematuro sem o arquivo solicitado retorna requisitos
pendentes ao executor. `ask_user` está disponível diretamente para entradas que
realmente bloqueiem a execução. A descrição desse tool deixou de permitir pausar
por qualquer fato ausente: preserva a política original de decisões do usuário,
com instrução para pesquisar fatos públicos enquanto houver fontes disponíveis.
Não se exige plano para toda tarefa com mais de uma ação. Imagens produzidas pelo
gerador independente podem ser entregues por um
executor sem visão, sem forçar uma troca para modelo de fronteira. Referências
visuais explícitas continuam sujeitas à capacidade real do executor.

A descoberta e o dispatcher são os originais `tool_search`, `tool_describe` e
`tool_call`. Instruções detalhadas dos módulos acompanham a superfície visível e
os recibos de descoberta, em vez de carregar todos os módulos antecipadamente.
As ferramentas da aplicação permanecem autenticadas e vinculadas ao proprietário;
isso não instala os conectores ou canais de outro produto.

A proteção original de repetição está habilitada. O host remove da história nativa
somente registros de transporte `tool_call` com filhos já efetivamente despachados,
preservando a chamada filha e seu resultado. Wrappers sem filho executado permanecem.
Assim, os duplicados não expulsam resultados idênticos antes do veto original.
Algoritmos, limiares e os 10.664 arquivos de origem registrados em `UPSTREAM.json`
permanecem inalterados. O entrypoint pertencente ao host expõe o estado nativo usado.

O contexto temporal nativo já chegava ao modelo; ausência total de data não era a
explicação. A allowlist do host, porém, excluía `session_status`: essa ferramenta
original agora está habilitada. O adaptador também usa o formatador original
`appendCronStyleCurrentTimeLine` para enviar hora legível e referência UTC como
metadados do servidor ao transporte. O pedido e a árvore persistida não são
reescritos. O teste de continuidade impediu publicar uma integração que recriava
entradas antigas ao anexar a hora diretamente ao pedido.

As instruções de pesquisa foram simplificadas: removida a orientação conflitante
de paginar milhares de registros quando a ferramenta já agrega o conjunto inteiro.
Leituras grandes de objetos explicam `entries=true` quando nenhuma linha cabe na
saída, sem tratar isso como ausência de dados. Uma fonte secundária legível pode
fundamentar uma entrega atribuída, com a limitação de acesso à fonte primária;
isso não equivale a alegar conferência direta na fonte primária.

Um encerramento parcial sem o arquivo não pode declarar dados indisponíveis quando
o último recibo de agregação informa linhas restantes disponíveis. Nesse caso, o
servidor devolve a consulta e a paginação ao mesmo executor para continuar. A regra
usa recibos reais e não chama um revisor. Resultados agregados mostram a estrutura
do agregado em vez de repetir a amostra extensa da base original. Ausência real de
dados continua podendo resultar em uma entrega parcial honesta.

O leitor HTTP da aplicação agora usa `extractBasicHtmlContent`, o sanitizador de
visibilidade e extrator Markdown originais do OpenClaw. URLs acompanham os trechos
de origem, com rótulos acessíveis preservados e os controles de rede existentes.
A ferramenta de dados deixa de desencorajar código: o executor pode descobrir
`run_computer_command` para transformações no computador autorizado. O objetivo
continua sendo a entrega solicitada, sem substituição por um gráfico de status.

O resultado de `start_computer` separa o estado do computador (`running`) da
conclusão da operação (`succeeded`). A recuperação de registros antigos exige
um único recibo nativo independente de início concluído, o mesmo vínculo de
execução e nenhuma indicação de resultado desconhecido. Sem essa prova, mantém
o bloqueio. Não repete a ação nem libera recursos históricos à força. Essa
recuperação foi observada na sétima validação; seus dois registros incorretos
foram reconciliados e os 21 registros históricos restantes foram preservados.

Se o renderizador falha, o leitor pode tentar o HTTP público com validação própria
de endereço e de todos os redirects. Cancelamento e URLs privados não ganham
esse fallback. A execução de comandos fica imediatamente visível somente quando
o computador está configurado. A consulta complexa `read_web_data` continua
disponível por descoberta; não compete com leitura e shell na superfície inicial.
As instruções orientam seguir links relacionados antes de concluir que faltam
fatos e distinguem datasets relevantes de analytics ou outros assuntos.

O transporte declarava todos os modelos como `reasoning: false` e ignorava
o nível de raciocínio enviado pelo executor original. Para os modelos OpenAI
conhecidos, o host agora usa o contrato de esforços do código original e encaminha
o nível do harness ao provedor. O padrão nativo do Luna passa a chegar como
`medium`. A projeção é feita por rota efetivamente admitida: um fallback
desconhecido conserva os próprios defaults e não herda parâmetros incompatíveis.
Não se muda o modelo principal nem se insere outra revisão de modelo. Rotas de
DeepSeek, MiMo e MiniMax não recebem suposições de capacidade baseadas no Luna.

A leitura HTTP de JSON passa a manter valores da fonte na prévia, como o
leitor original, junto à estrutura completa do conjunto. Não substitui um
objeto grande por `rows: []`. O conteúdo completo continua disponível para
cálculo no computador ou consultas estruturadas; o limite da prévia não
representa ausência de fatos nem redução da janela do modelo.

Uma tentativa parcial sem o arquivo, após leituras públicas, recebe uma
continuação na mesma revisão da tarefa para percorrer caminhos concretos
restantes. Não chama um revisor nem relança efeitos concluídos. Um bloqueio
real pode encerrar parcial depois dessa continuação; não se certifica sucesso
em uma tarefa sem arquivo. A leitura incompleta de uma reportagem de serviço
não é evidência de inexistência dos resultados que ela própria referencia.

O repasse ao worker ainda cortava a conversa em 12 turnos ou 64 mil
caracteres, e checkpoints cortavam cada mensagem textual em 32 mil caracteres.
Esses cortes foram removidos para mensagens do usuário e do assistente. O
limite do fork permanece a mensagem originadora, preservando a separação entre
história e pedidos posteriores. A admissão e compactação do executor nativo
usam a janela real do modelo; redaction de credenciais e referências de
recibos grandes continuam existentes. Os testes retêm fatos do primeiro
turno de uma conversa com 40 mensagens e o final de textos com mais de
200 mil caracteres.

## Verificação e publicação

As 47 regressões de conclusão e revisão e as 22 de continuidade e retomada
passaram depois dos últimos ajustes. Os 17 testes do executor nativo, os 60 testes de provedores e os 39 testes
de leitura, dados e imagem passaram no último ajuste. Os 31 testes do ajuste
anterior passaram, incluindo configuração da superfície
inicial e recuperação do computador; os 39 testes de leitura e imagem e os 23
testes de diário e recuperação também passaram. Os testes cobrem conclusão prematura, falta genuína de entrada, geração com e sem
visão sem revisores extras, instruções progressivas, repetição direta e descoberta,
rolagem de data, leitura do relógio original com e sem descoberta, preservação da
árvore e contexto declarado de 1.050.000 tokens. Compilação do servidor e checagem
de tipos passaram. Fixtures HTTP ignoram probes GET, que não são inferências.
A suíte ampla concluiu 1.481 de 1.482 testes: a única falha foi uma fixture de visão
que contava uma sondagem GET como inferência. Depois da correção, seus quatro testes
passaram; as 36 regressões dos executores e manutenção e as 41 regressões de
conclusão, dados públicos, objetivo e revisões também passaram.

A publicação é restrita às fronteiras do executor, configuração e entrypoint do
harness, sobre a base de produção existente. Web e APK não são substituídos.
Fonte publicada: `b7431e714b5ee672703c2f9127bf38700e2bbf0b`.
Imagem: `sha256:79c8e6ca073ce30fcfad522b83555b42d39698ec1b6167806135e2bab3d1cab7`.
Luna permanece como executor de produção, com contexto de 1.050.000 tokens.
DeepSeek, MiMo e MiniMax não foram validados ao vivo nesta sessão.

A validação final de pesquisa, geração e entrega ainda deve registrar resultado,
tempo e conferência dos pixels, sem apresentar os testes anteriores como sucesso.


## Recuperação de comandos, leituras grandes e conclusão de rascunhos

A décima primeira reprodução parou com resultado desconhecido apesar de o
comando ter terminado com `KeyError: top`, exit code 1 e limpeza confirmada.
O adaptador remoto lançava uma exceção antes de persistir o recibo final.
Agora devolve o recibo vinculado, com saída e código de retorno, permitindo
corrigir o script. A manutenção reconcilia também a intenção e seu primitivo,
sem repetir a execução. Os dois registros dessa reprodução ficaram `failed`;
os 21 registros históricos e dois recursos retidos permaneceram preservados.

As ferramentas de status do computador mostram prontidão e IDs de comandos
pendentes. Saídas e scripts de outras tarefas não são injetados na nova conversa;
os recibos completos continuam disponíveis por consulta explícita do comando.
A consulta `read_web_data` rejeita campos desconhecidos na raiz, em vez de
descartar silenciosamente um `expand` colocado fora de `aggregate`.

A décima segunda reprodução encontrou o JSON correto de municípios, mas a
leitura comum recusou seu tamanho. Gerou uma imagem apenas nacional e foi
marcada como concluída em 317,4 segundos. Isso é uma falha, não uma aprovação.
URLs de datasets JSON/JWS usam agora os mesmos 16 MiB de transferência do leitor
estruturado, preservando a prévia e a estrutura para consulta do conjunto inteiro.
HTML mantém seu orçamento separado. Uma resposta textual após criar um rascunho
recebe uma continuação para o próprio executor selecionar a entrega e registrar
se o pedido original foi cumprido. Outra resposta sem decisão explícita não
certifica o rascunho como entrega completa.

O supervisor nativo publicava resultados somente depois da próxima espera de
até 15 segundos por novos comandos. Publica agora antes dessa espera e verifica
comandos ativos a cada segundo, mantendo a espera longa quando ocioso. A mudança
foi aplicada somente com fila e jobs vazios; o executor voltou conectado no
mesmo serviço registrado, epoch 31. Hash do supervisor publicado:
`0dbba0c64ad33f3cfe503d0cd53c980ad87c3aebdbd8c0aec44f9fc6a3cfd5d4`.

Passaram 28 testes de comandos e recuperação, 21 de conclusão e entrega,
14 de pesquisa e dados, e 60 contratos nativos. Compilação e checagem de tipos
passaram; lint sem erros. A décima terceira reprodução está descrita abaixo; a aprovação exige cobertura
estadual e pixels conferidos, além do tempo real.


## Links exatos e latência da descoberta

A décima terceira reprodução parou em 51,5 segundos, sem arquivo, com uma
pergunta sobre a disponibilidade da eleição. A busca tinha devolvido a URL
correta do G1. O modelo encurtou seu slug, recebeu 404 e concluiu incorretamente
que faltavam resultados. A história da conversa original confirma que o pedido
estava em uma conversa separada, iniciada pela mensagem do infográfico; não havia
uma resposta nacional anterior nesse thread para herdar.

Recibos de leitura com 404 passam a incluir URLs exatas já observadas nas buscas
da mesma tarefa e origem. São alternativas ainda não lidas; não viram evidência
nem provocam navegação automática. O executor pode corrigir a chamada sem
reconstruir slugs pelo título. O teste do worker confirma o erro, o URL exato
recuperado e a leitura real posterior, sem atribuir fatos ao link que falhou.

A descoberta HTTP tentava os dois endpoints indisponíveis do DuckDuckGo antes
do RSS do Bing, somando até 18 segundos em cada pesquisa. O backend disponível
é tentado primeiro e a última rota que respondeu passa a ter prioridade nas
pesquisas seguintes. Mantém alternativas se ela falhar, valida cada link e
faz uma leitura nova para cada query. Passaram os 32 testes de extração e fluxo,
os dois de busca e os 11 de mídia; tipos, compilação e lint sem erros.
A décima quarta reprodução começou sem URLs nem percentuais fornecidos pelo
operador. Terminou em 296,6 segundos usando Codex/GPT Image 2, mas é incorreta:
os 54 percentuais estaduais do briefing diferem da soma independente dos dados
municipais. O executor leu o panorama de governadores e inventou os percentuais
presidenciais. A inspeção dos pixels confirma que o gerador reproduziu o briefing;
a falha está na preparação factual. O servidor marcou conclusão porque havia
arquivo e finish_task explícito; essa checagem mecânica não certificou os fatos.


## Instruções menores por família de ferramenta

Pedidos de imagem carregavam também as instruções completas de PDF, DOCX e PPTX.
A execução passa a carregar somente as famílias de mídia selecionadas: imagem,
documento ou áudio. A política de autoria e inspeção dos documentos permanece
disponível quando essas ferramentas são escolhidas. O comando central foi
encurtado, preservando recibos, credenciais, efeitos, decisões e a data nativa.
A pesquisa exige correspondência entre sujeito, métrica, categoria e data do
registro e do pedido, além de cobertura completa antes de compor números.
view_file está disponível diretamente; um recibo de arquivo não autoriza alegar
inspeção visual. Não há novo revisor, nova chamada de modelo ou troca do Luna.

Passaram os 30 testes de composição nativa e fluxo de mídia. Após ampliar a
verificação da superfície efetivamente enviada ao provedor, passaram os dez
testes de conclusão de imagem: orientações de imagem presentes e instruções de
Office/PDF ausentes. Tipos e compilação passaram; lint sem erros. A décima quinta
reprodução usa o pedido original com o ano, sem URLs ou números fornecidos pelo
operador. Terminou parcial em 143,6 segundos, sem imagem: reconheceu a diferença
entre governadores e presidente, mas não abriu o link presidencial que já estava
na página lida. Não é uma aprovação da tarefa.


## Links contextuais e entrega pelo próprio executor

Na extração headless, destinos e rótulos chegavam separados do texto. O adaptador
passa a apresentar os links observados ao lado de seus rótulos de linha, como no
Markdown HTTP. Rótulos ambíguos ou URLs inválidas não recebem destinos supostos.
O recibo da continuação já existente inclui os links exatos observados ainda não
lidos, excluindo tentativas anteriores e deduplicando âncoras e parâmetros de
rastreamento. Essas entradas são pistas de navegação; não viram fatos, não fazem
fetch automático e cada leitura continua validada no backend público.

Havia também uma segunda inferência TASK_REPLY_VOICE em cada finish_task e
encerramento em texto quando a personalidade estava configurada. O executor
nativo já recebe SOUL e humanizer. Essa reescrita foi removida: a entrega conserva
a resposta original, sem chamada extra nem alterações posteriores de fatos.
A personalidade continua no prompt de execução. O teste com SOUL personalizado
confirma pesquisa e geração com as três chamadas necessárias, sem revisões ou
reescrita adicional, tanto com visão quanto sem ela.

Passaram 33 testes de leitura e conclusão, incluindo links headless contextuais
e pistas exatas no recibo de continuação. Os dez testes de conclusão de imagem
passaram com personalidade configurada; os três de humanizer/SOUL passaram
após ajustar uma fixture para fazer a leitura real da fonte exigida pelo
verificador. Tipos e compilação passaram; lint sem erros. A décima sexta
reprodução terminou parcial em 204,5 segundos: o GPT Image 2 produziu um mapa
cinza declarado como dados pendentes. O executor inspecionou o arquivo real,
mas a existência desse rascunho excluía a continuação de pesquisa do host.
Não é aprovação da tarefa ou do desempenho.


## Continuação com rascunho e progresso de fontes

A condição de continuação verificava apenas critérios de arquivo ausente. Um
finish_task parcial com PNG salvo podia encerrar mesmo com links ainda não lidos.
O fluxo padrão passa a devolver esses links ao mesmo executor também quando já
há um rascunho. A continuação usa uma assinatura do conteúdo das leituras e dos
links disponíveis; não há somente uma oportunidade por revisão do usuário.
Novos fatos ou mudanças nos links permitem continuar. Leituras duplicadas e
horários novos não criam progresso; repetir o mesmo parcial sem nova evidência
permite relatar um bloqueio, preservando a proteção nativa contra repetição.
A revisão semântica opcional mantém seu próprio caminho quando habilitada.

Passaram os onze testes de conclusão de imagem. O caso novo salva um rascunho,
recebe duas conclusões parciais com pesquisas diferentes, abre a fonte final e
entrega somente a imagem corrigida, sem revisor ou reescrita. O caso de fonte
realmente bloqueada termina sem loop. Tipos, compilação e lint passaram sem
erros. A décima sétima reprodução independente ainda precisa ser conferida.
