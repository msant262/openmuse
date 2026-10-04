# OkamiBot: instalação e aceite em 4 de outubro de 2026

**Revisão atual publicada: API `0b0122c`; web e Android `94b47bc`.** A skill
`humanizer` entra automaticamente na conversa e nas tarefas junto ao SOUL.
O handoff evita confirmações duplicadas; pesquisas em texto passam por revisão
do pedido e dos dados observados. Os modais têm switches e seleções visíveis,
com salvamento acessível durante a rolagem.

A validação incluiu 1.334 testes completos antes do último ajuste de streaming,
37 testes focados na versão final, TypeScript, ensaios com o modelo conectado
e aceite da web pública. SOUL, modelo e avatar foram preservados. O APK ARM64
assinado está [disponível para atualização](https://app.okamibot.cloud/downloads/okamibot.apk?v=94b47bc).
Não houve novo aceite de execução nativa nesta retomada.
[Evidências e limites](superpowers/research/2026-10-04-companion-humanizer.md).

## Histórico: interface e personalização (`3e1f3ac`)

**Revisão anterior publicada: API `7f81a03`; web e Android `3e1f3ac`.** A interface
oferece temas Claro, Escuro e Automático persistidos por dispositivo, cartões
SOUL/MEMORY com edição e histórico, e navegação que destaca a conversa principal
e a criação de novas conversas. O criador de companheiro abre com campo vazio;
opções antigas aguardando seleção aparecem somente ao abrir o histórico.

Passaram **1.211/1.211 testes** na fonte exata dos builds, TypeScript de
servidor/mobile e Biome sem erros (245 avisos e quatro informações). O aceite
local da web verificou 13 fluxos; o Android API 34 confirmou atualização assinada
sem limpar dados, preservação do pareamento e rascunho, edição de SOUL/memória,
histórico, alternância entre conversas e tema automático nos dois sentidos.
Não houve teste em telefone físico.

O domínio público passou em nove verificações de interface, incluindo desktop,
viewport de 390 px, português, persistência do tema e histórico do avatar.
Personalidade, memórias e companheiro salvo mantiveram o mesmo digest antes e
depois; sem escritas de produto ou erros JavaScript. O pareamento temporário foi
revogado. A API permaneceu saudável durante a troca dos arquivos estáticos.

Web e APK ARM64 foram construídos com árvore limpa em `3e1f3ac`; o download
público confirmou HTTP 200, tamanho e SHA-256 idênticos aos artefatos locais.
O APK mantém o certificado existente. [Baixar a atualização assinada](https://app.okamibot.cloud/downloads/okamibot.apk?v=3e1f3ac).
Critérios, hashes, limites e evidências: [aceite da interface](INTERFACE-REFRESH-ACCEPTANCE.md).

## Histórico: documentos com design (`7f81a03`)

**Revisão anterior publicada: API `7f81a03`; web e Android `7529b63`.** A publicação
de documentos com design foi concluída após o ensaio conectado de PPTX. O guia
redesenhado de produção concluiu com revisão verificada das três páginas.

O catálogo incorpora as **74 referências DESIGN.md** do VoltAgent/awesome-design-md,
fixadas em `f6961238d5cddcf8042a74a70fc400ec67181abb`, com licença MIT, origem e
hashes. O renderer oferece oito perfis adaptados, PDFs diagramados e DOCX/PPTX
com conteúdo nativo editável. As skills orientam composição, consulta das fontes,
renderização, revisão de todas as páginas e reparo antes da entrega. As adaptações
e suas licenças estão em `third_party/document-skills` e nos registros de pesquisa
de 4 de outubro em `docs/superpowers/research/`.

Passaram **1.210/1.210 testes**, TypeScript de servidor/mobile e Biome sem erros
em `643e9de`. A revisão `7f81a03` altera somente duas skills Markdown: esclarece
que espaço em branco normal e continuação legível de tabela não exigem reescrita.
A imagem final compilou; ambas as skills foram lidas pelo catálogo da imagem e
seus hashes correspondem às fontes. Os 24 testes focados incluem a classificação correta
da consulta de capacidades de imagem como leitura. Ela estava marcada como efeito
e tornava obrigatórios lotes de leituras de skills/referências. A projeção também
deduplica workflows idênticos e compacta fontes/instruções de rascunhos substituídos,
preservando originais, hashes, recibos e a retomada. Limites dos modelos e revisão
visual obrigatória permanecem iguais. Evidências:
`artifacts/document-design/verification-643e9de.json` e
[diagnóstico de contexto](superpowers/research/2026-10-04-document-context-recovery.md).

O ensaio conectado final produziu um **PPTX editável de sete slides**, com tabela
nativa, os cinco passos juntos e todas as páginas revistas. A tarefa terminou em
`succeeded`, conclusão `verified`, e publicou o arquivo na conversa isolada correta.
A inspeção visual independente não encontrou cortes ou sobreposição. O arquivo tem
33.552 bytes e SHA-256
`dc379a31871f3613de7ebe28b8afbc9de7094725ffb87a796da0c86c69c78857`.
PDF e DOCX já haviam passado no ensaio `2afac00`, com três páginas cada; os reparos
posteriores de layout afetaram PPTX. Falhas anteriores foram preservadas, incluindo
o bloqueio de `4c3e9ba`, que revelou a classificação incorreta da consulta de imagem.
Recibos e revisão final: `artifacts/document-design/live-643e9de/`.

A imagem publicada é
`sha256:3a3e4b56c323f95d2a892302a578f26b7639877c2f2cc226e89760bf232597df`.
A API está saudável, a manutenção terminou e os dois recursos de controle humano
foram preservados. GUMC/avatar, perfil, seleção de modelo e pausa na revisão 16
permaneceram iguais. A troca da API reproduziu a quarentena nativa já conhecida;
reiniciar apenas `okami-executor@lenovo-okami` recuperou todas as capacidades no
epoch 26, com o mesmo ID e geração da sessão gráfica. Não se afirma correção geral
desse defeito de reconexão. Evidências: `deployment-7f81a03.log`,
`deployment-state-7f81a03.json` e `packaged-skills-7f81a03.jsonl` em
`artifacts/document-design/`.

O guia de produção foi gerado pela tarefa
`6d658c75-b3fc-4078-b981-26d9e451c1e4`, na conversa
`4d059062-e308-44c8-b770-8160d124a41e`. A revisão corrigiu uma nota final isolada,
mas depois rejeitou repetidamente espaço em branco numa seção substancial. Foi
necessária orientação editorial pelo canal normal de diretivas. Após essa mudança
de revisão, o modelo tentou concluir sem uma inspeção atual; a verificação bloqueou
a entrega. A mesma tarefa foi retomada pelos controles da API, recebeu e confirmou
os pixels das três páginas na revisão 2 e terminou em `succeeded/verified`.

A inspeção independente do arquivo final confirmou fluxo completo, tabela legível,
memória/privacidade/limites e ausência de cortes ou sobreposição. O PDF tem
**três páginas e 58.893 bytes**, SHA-256
`6d7787f1b590a4bf985133a31ec56495d61b375496d6f06658cb1b40ea303383`.
Arquivo, recibos e revisão estão em
`artifacts/document-design/production-guide-resumed/`. O ensaio não demonstra
conclusão sem intervenção editorial, nem uma correção geral de retomada após diretivas.

O aceite público confirmou o resultado na conversa original, abertura da tarefa
concluída em **Trabalhos recentes**, PDF no desktop e em viewport de 390 px, e
download HTTP 200 com o mesmo tamanho, três páginas e hash. Capturas foram
inspecionadas; sem erros JavaScript, overflow horizontal ou escritas de produto.
Pareamentos de teste foram revogados. **Limite da interface:** a tarefa criada
diretamente pela API não tem cartão de anexo inline de `delegate_task`; o arquivo
abre pela tarefa em Trabalhos recentes. A primeira tentativa de aceite assumia
esse cartão e falhou; outra expôs um seletor ambíguo, corrigido no ensaio final. Evidência final:
`artifacts/document-design/public-guide-task-2/`; tentativas anteriores preservadas.

## Histórico: harness OpenClaw (`55f9d8d`)

**Revisão anterior publicada: API `55f9d8d`; web e Android `7529b63`.** O novo
harness reutiliza cinco módulos portáveis do OpenClaw (política de entrega,
parser de skills, dois classificadores de repetição e limites de resultados),
com MIT e procedência incluídos na imagem. A integração acrescenta catálogo real
de `SKILL.md`, inventário do runtime, paginação de resultados, criação local de
PDF/texto/Markdown e correções de contexto/retomada.

Passaram **1.130 testes**, TypeScript servidor/mobile e Biome sem erros (230
avisos e quatro informações). Outros 60 contratos Python de executor/desktop
passaram; cinco testes de deployment passaram após corrigir o filtro de inputs
do Docker. A primeira montagem da imagem falhou por esse filtro e está
preservada no registro, sem ter sido publicada.

Dois ensaios com os provedores conectados passaram pela conversa real, worker e
publicação de origem numa base isolada: PDF de três páginas (20.358 bytes) e PNG
de 1086×1448 (1.275.641 bytes). O PDF consultou runtime e skills locais. A imagem
tem os valores textuais corretos; a proporção da barra decorativa é aproximada,
não uma reprodução matemática exata. Credenciais foram montadas somente para
leitura, copiadas para armazenamento temporário privado e renovação OAuth foi
bloqueada no ensaio; não houve acesso à base de conversas de produção.

A tarefa original do PDF, que estava em `waiting_provider`, foi retomada pelos
controles normais mantendo o mesmo ID, conversa e 62 operações anteriores.
Concluiu na terceira tentativa, com quatro rodadas adicionais do modelo (16→20):
quatro leituras de fontes, `create_document` e `finish_task`. O PDF baixado tem
**quatro páginas e 25.011 bytes**, SHA-256
`340a6895922c1d2fbb9d913db0dd45674bf62afbf6ea66af54e48fcb1b7b1da6`.
Seu texto real foi extraído e conferido; o status é `succeeded`, com conclusão
verificada e arquivo na conversa original. Evidências:
`artifacts/openclaw-harness/live/` e `artifacts/openclaw-harness/production-pdf/`.

O aceite público confirmou o cartão concluído e o anexo na conversa original,
renderização do PDF no desktop e em viewport de 390 px, e abertura/download
HTTP 200 com o mesmo tamanho, quatro páginas e hash. Sem erros JavaScript ou
escritas de produto; pareamentos temporários revogados. O Chromium completo
em Xvfb renderizou o leitor; o shell headless padrão não tinha essa capacidade.
Tentativas anteriores e capturas foram preservadas em
`artifacts/openclaw-harness/public-pdf-ui/`.

A publicação preservou GUMC/avatar, Codex, a política de pausa na revisão 16 e
os dois recursos de controle humano; manutenção encerrada. Reproduziu a
quarentena nativa após troca da API. Reiniciar o supervisor recuperou prontidão
no epoch 24. Esse defeito não foi apresentado como corrigido: os logs antigos
não distinguem qual etapa de contenção falhou. Revisão e limites:
[auditoria do harness](superpowers/research/2026-10-04-openclaw-harness-audit.md).

Durante o aceite, o domínio público apresentou 502/530 (Cloudflare 1033), com
API privada saudável. Os logs registraram perda das quatro conexões IPv6,
timeouts e recuperação automática por IPv4 às 00:35 UTC. Após o aceite visual,
o túnel foi fixado em `edge-ip-version: "4"`, mantendo HTTP/2; configuração
validada, quatro conexões IPv4 registradas e interface/API públicas HTTP 200
às 00:39 UTC. É mitigação da falha observada, não diagnóstico completo da rota
IPv6. Evidências: `public-tunnel-*.log` e `public-final-health.json` na mesma
pasta de artefatos. O backup da configuração está privado na VPS.

## Histórico: entrega no chat e configuração Google (`7529b63`)

**Revisão anterior: API, web e Android `7529b63`.** A publicação corrigiu
o esgotamento do loop de pesquisa no chat: existe uma rodada reservada para
delegar a entrega antes da resposta final. Google sem configuração OAuth nativa
abre o serviço correspondente no catálogo, com ativação privada; não expõe
nomes de variáveis do servidor. O login real ainda depende da chave Composio do
titular, que não foi fornecida.

Passaram **1.105 testes**, TypeScript servidor/mobile e Biome sem erros. Um
ensaio real pelo chat gerou e publicou um PNG de 1.079.162 bytes usando a conexão
Codex, sem Grok. O ensaio de pesquisa eleitoral não concluiu a verificação das
fontes e foi preservado como falha; não conta como entrega bem-sucedida.

Desktop e viewport móvel públicos passaram: Gmail/Calendar abriram o setup do
serviço correto, sem chamadas OAuth nativas, alterações bloqueadas ou erros de
página. Upgrade Android x86 preservou pareamento, GUMC/avatar e Codex; os mesmos
fluxos passaram no emulador. Não havia rascunho antes do upgrade e não houve
teste em aparelho físico. Pareamento temporário revogado e emulador encerrado.

Bundle web público: SHA-256
`d9baeec18871ce6b697f89b80f1a06376ab28923aec78ea9f3307f451a26f3d9`.
APK ARM64 público: 58.963.289 bytes, SHA-256
`0d1546469055abb68823236f3234f55a50a7b000b50501e7fa6e4ab89b00bd3f`.
Builds limpos e assinatura existente conferidos. Evidências:
`artifacts/chat-handoff/` e `artifacts/android/chat-handoff-release/`.

## Histórico: catálogo Composio (`249443b`)

**Revisão anterior publicada: API, web e Android `249443b`.** A área de Conexões
consulta o catálogo Composio com busca, categorias e paginação. O mesmo fluxo
oferece autorização oficial, contas conectadas, reconexão e desconexão. O agente
descobre schemas sob demanda e executa operações individuais com bindings por
tarefa, journal e revisão nativa para ações financeiras.
[Contrato e critérios](superpowers/specs/2026-10-03-composio-connections.md).

Passaram **1.092 testes**, TypeScript do servidor/mobile e Biome sem erros
(230 avisos e quatro informações). Os testes incluem pausa/retomada da tarefa,
reutilização, isolamento de proprietários, expiração com recuperação,
cancelamento após falha, troca de chave, reconexão durante revisão e bloqueio de
repetição de escrita com resultado incerto. Recibos incompletos não confirmam
sucesso. Uma falha de revogação remota bloqueia a conta localmente e permite
repetir a desconexão.

O ensaio de interface usou a API real do app com **transporte Composio simulado**:
ativação privada, busca de serviço não embutido, paginação, modal desktop/móvel,
confirmação no servidor e desconexão passaram. **Não houve autorização OAuth
real de uma conta Composio**: esta instalação ainda precisa da chave de projeto,
inserida pelo titular no campo privado de ativação do catálogo. Nenhuma conexão
ou chave sintética foi criada na produção.

A API pública confirmou os novos endpoints e preservou ChatGPT/Codex, GUMC e o
avatar selecionado. O computador voltou disponível após reiniciar apenas seu
supervisor, devido ao defeito de reconexão já conhecido. A publicação preservou
os dois recursos de controle humano retidos e encerrou o modo de manutenção.
O bundle web público foi comparado ao build local: SHA-256
`8c7d6c6fe63fee5e58ce980652207015bb69a552a767fc34ab0b8887fc2b1d2c`.
O APK ARM64 público tem 58.963.289 bytes e SHA-256
`a24f015797a158f9ad8953f272fdc1a43ba011eb76c76ca0321f36aaa54439ca`.
Os dois APKs usam a assinatura privada existente e o commit limpo. O upgrade
x86 no emulador preservou pareamento, identidade GUMC e rascunho local.
Não houve teste em aparelho físico. Evidências: `artifacts/composio/verification/`
e `artifacts/android/composio-release/`.

## Histórico: credenciais genéricas (`973d120` / `0df26c4`)

**Revisão anterior: API `973d120`; web e Android `0df26c4`.** O usuário rejeitou
explicitamente a solução limitada ao Tavily. Esta revisão implementa pedidos de
credenciais em runtime: o agente informa destino e campos, um modal global abre,
os valores vão ao cofre e a mesma tarefa continua. Serviços novos não precisam
ser adicionados ao catálogo/configuração do servidor. Há reutilização, troca e
revogação de credenciais, autenticação HTTP genérica e formulários de login em
sites definidos a partir da página observada.
[Contrato e critérios](superpowers/specs/2026-10-03-generic-credential-prompts.md).

A suíte completa do código final passou em **1.066 testes**, sem falhas.
TypeScript passou para servidor e mobile; Biome terminou sem erros (218 avisos e
quatro informações). Testes cobrem múltiplos campos e destinos, chave inválida,
cofre indisponível, retomada, cancelamento, concorrência, login dinâmico e a
política de aprovação das operações com efeitos. O formulário privado não gera
outra pergunta comum e polling não reabre solicitações dispensadas.

A correção posterior da API vincula a verificação de login reutilizado à tarefa
atual: um desafio OTP abre no pedido correto sem solicitar a senha novamente.
Passaram 43 regressões de credenciais/interações, o teste dedicado de reutilização
com OTP e TypeScript. O ensaio público abaixo corresponde ao build `0df26c4`;
a API posterior também teve saúde e preservação das conexões verificadas.

O ensaio **real no app público**, com o modelo conectado e um token sintético,
abriu o modal para um serviço novo HTTPBin, gravou no cofre de produção e retomou
a mesma tarefa. `credential_http_request` recebeu HTTP 200 e
`authenticated: true`; o token apareceu como `[redacted]` no recibo. Não houve
uso de navegador/computador. Conversa, eventos, tarefas e operações não expuseram
o canário. Desktop 1440 e viewport móvel 390, modal automático e serviço salvo em
Configurações passaram. Credencial de teste foi revogada, conversa de teste
excluída e pareamento temporário revogado. O primeiro ensaio foi repetido porque
a medição ocorreu antes de o layout React estabilizar após o resize; seu
cancelamento e limpeza também foram confirmados.

O bundle web público tem SHA-256
`84297533f0b8eff28555755e34632b9aef0e057bff984432828b57fdec055477`.
O APK ARM64 publicado tem 58.938.713 bytes e SHA-256
`995a71ba453adc2a4a5e5060bad10c27a66d11ec0f392a82687a8d9baa788356`.
Ambos os downloads públicos foram comparados aos builds do commit limpo.
O upgrade x86 no emulador preservou pareamento, GUMC e um rascunho de teste local
persistido antes do upgrade e removido ao final. Modelos, Codex e conexões
passaram no Android. Não houve teste em aparelho físico.
Evidências: `artifacts/generic-credentials/` e
`artifacts/android/generic-credentials-release/`.

A reinicialização da API reproduziu o defeito conhecido de reconexão nativa.
Reiniciar somente o supervisor recuperou as capacidades no epoch 21, preservando
a sessão gráfica, o controle humano na revisão 6 e a pausa desativada na revisão
16. A conexão Codex e o avatar selecionado foram preservados. A causa desse
defeito de reconexão continua aberta.

## Histórico: correção anterior do harness (`7ec9235`)

**Revisão anterior: API, web e Android `7ec9235`.** A revisão anterior
foi novamente rejeitada no uso real. Esta correção adiciona geração de imagens
pela assinatura ChatGPT via conexão Codex OAuth, seleção de modelo em
Configurações, Tavily com formulário seguro, gestão de conversas e limpeza dos
eventos internos no Feed/painel/notificações.
[Diagnóstico, referências OpenClaw e ensaios](superpowers/research/2026-10-03-openclaw-harness-correction.md).

O titular autorizou o device auth. Um ensaio real isolado, com Grok desabilitado,
gerou um infográfico PNG usando GPT Image 2 e publicou o arquivo na conversa,
sem navegador ou perguntas. O pedido de conectar Tavily abriu diretamente o
formulário privado em um chat real. A gravação/uso da API key teve teste com cofre
e endpoint controlados; a chave Tavily real ainda não foi fornecida.

A suíte completa passou em **1.034 testes**. Depois da última revisão da exclusão,
mais **29 testes focados** passaram, incluindo a corrida com um formulário tardio.
TypeScript e Biome terminaram sem erros. A navegação pública autenticada conferiu
modelos, ChatGPT conectado, Tavily, Feed e Objetivos, nas larguras 1440/1024/390,
sem overflow, erros JavaScript ou alterações de conteúdo. Ações de conversas e
preservação de rascunhos foram verificadas com API isolada, incluindo exclusão em
outro dispositivo e rotação da conversa principal. Esses testes não representam
aceite visual do usuário nem equivalência pixel a pixel com Muse.

O bundle web público tem SHA-256
`caf6d7299c82dd3acc834473b5d78e891379a99a9eccd2eba0e4455c3dc15ddf`.
O APK ARM64 tem 58.926.425 bytes e SHA-256
`c56278eda5b318686739c999918b9f655f44a54099bc78b921a2ea6ad62f0fff`.
Os dois downloads públicos foram comparados com os builds limpos e assinados.
O upgrade do APK x86 no emulador preservou pareamento, avatar GUMC e rascunho;
modelos, Codex conectado e campo seguro Tavily foram conferidos na instalação
Android. Nenhuma chave Tavily foi inserida; não houve teste em celular físico.
Evidências: `artifacts/harness-v2/`, `artifacts/desktop-usability-v2/` e
`artifacts/android/harness-v2-release/`.

A troca da API reproduziu a quarentena de reconexão do supervisor nativo.
Reiniciar somente `okami-executor@lenovo-okami.service` recuperou todas as
capacidades no epoch 19. A sessão gráfica, o controle humano na revisão 6,
a pausa desativada na revisão 16 e o avatar GUMC foram preservados. A causa desse
defeito de reconexão continua aberta; não foi apresentada como corrigida.

## Histórico das revisões anteriores

**Revisão publicada após o incidente de uso real:** web/Android `20c310d`, API
`8171783`. A revisão anterior `f4eec06` foi rejeitada pelo usuário. Esta entrega
corrige pesquisa HTTP, ciclos de perguntas e a contaminação do prompt dos
avatares, além de reconstruir a composição completa do desktop.
[Registro das causas e ensaios](superpowers/research/2026-10-03-product-incident-correction.md).
O ensaio de tarefa produziu cinco ofertas usando somente HTTP, sem perguntas;
três preços foram corroborados por leituras independentes. A conversa direta
foi ensaiada na imagem final com data atual e limitações explícitas das fontes.
A suíte completa passou em 1.002 testes; após a inclusão da data confiável,
mais 15 testes focados e o build passaram. TypeScript passou; Biome terminou sem
erros (195 avisos e quatro informações).

O bundle web público tem SHA256
`24a95312e24144058f50435a992208b84cb1d04163f3d196a51e52b30b401a2d`.
O APK ARM64 público tem 58.336.319 bytes e SHA256
`9c08f6074a4046f416fa204c2327c8785f8ef950aa01402b733b082692933375`.
Ambos foram baixados e comparados com os artefatos locais. A navegação autenticada
pública passou sem erros de página nem alterações de conteúdo. O upgrade Android
x86 preservou pareamento, persona e rascunho; foi testado em emulador, não em
aparelho físico. Evidências: `artifacts/product-correction/` e
`artifacts/android/product-correction-release/`.

Durante a publicação, a reconexão nativa exigiu reiniciar somente o supervisor.
O computador voltou pronto no epoch 18, mantendo a sessão gráfica, os PIDs dos
aplicativos, o controle humano na revisão 6 e os 233 recibos anteriores. A pausa
permaneceu desativada na revisão 16 e o avatar selecionado foi preservado.
A causa inicial da quarentena não pôde ser determinada pelos logs existentes;
não foi apresentada como defeito de reconexão definitivamente corrigido.
Recibo: `artifacts/product-correction/native-recovery.json`.


O código dos doze marcos está implementado. A instalação técnica usa a VPS e a
Lenovo existentes; o aceite de uso diário pela esposa ainda depende de
conectores, push e ensaio no celular físico. ChatGPT e Grok estão conectados. Este documento registra
resultados observados, sem equiparar testes com fixtures a contas reais.

**Acesso ao produto:** [primeira entrada pelo navegador e Android](FIRST-ACCESS.md).
A raiz HTTPS agora serve a interface web; `/api` e `/executor` preservam o backend.
O export web foi reconstruído com cache limpo e URL HTTPS de produção. A revisão
visual atual preserva a API que já oferece criação persistente de companheiros.

Atualização após o primeiro aceite real: o domínio público
`https://app.okamibot.cloud` está acessível via Cloudflare Tunnel, sem Tailscale no
aparelho do usuário. Entrada web com chave e cookie seguro verificada nesse
domínio. API sem autenticação retorna 401; rotas de executor e manutenção
retornam 404 no gateway público. O hostname privado continua disponível.
O retrabalho de produto está descrito no
[plano de implementação](superpowers/plans/2026-10-03-product-rework.md) e no
[registro da retomada](superpowers/plans/2026-10-03-product-rework-resume.md).

A versão anterior da web e dos APKs usava a fonte mobile `40390aa`: navegação desktop, EN/PT-BR,
configurações de nome/personalidade, cinco avatares 3D animados e editor de
aparência. O visualizador mantém a imagem durante polling e entrada manual.
O build anterior permanece em `/opt/okami-web/releases/40390aa-public` para rollback.

A revisão `a2845d4` foi **rejeitada visualmente pelo usuário**, apesar dos
931/931 testes funcionais daquela versão. Seus cinco modelos procedurais não
atendiam ao acabamento, movimento nem à criação livre exigidos. O
[registro anterior](superpowers/plans/2026-10-03-muse-experience.md) é histórico;
não representa aceite visual.

A correção dos avatares usou **web e Android `360b60d`**, com web preservada para
rollback em `/opt/okami-web/releases/360b60d-public`, e **API `32a1ae5`**, imagem
`openmuse-server:product-32a1ae5`. O novo estúdio transforma uma descrição livre
em quatro imagens reais, aplica a opção escolhida e gera vídeos de repouso,
trabalho e resposta. A direção de arte de pelúcia vale para qualquer personagem;
a galeria salva permite reutilizar criações ou voltar ao padrão. A conta Grok
conectada gera imagens e vídeos independentemente do modelo de conversa.
O personagem padrão usa novas imagens e vídeos locais, incluindo fones,
notebook e mesa no estado de trabalho. A interface mantém o retrato até o
primeiro quadro, respeita movimento reduzido e reorganiza navegação, conversa,
prévia e estúdio nos layouts desktop e móvel. Ícone e abertura também foram
atualizados. Prompts e origem dos assets estão em
`apps/mobile/assets/companions/README.md`; arquitetura em [AVATAR-GENERATION.md](AVATAR-GENERATION.md).

O ensaio real do mesmo padrão visual produziu quatro dragões turquesa, quatro
robôs lavanda e, pela interface pública, quatro raposas. A segunda raposa gerou
os três vídeos, foi reaberta pela galeria após recarregar a página e reproduziu
os três estados sem nova geração. A conclusão de um vídeo não sobrescreveu uma
seleção posterior. O serviço público de vídeo respondeu HTTP 206 com bytes MP4
válidos. Durante o encerramento surgiu outra criação em uma sessão do usuário;
essa escolha foi preservada, sem restaurar o backup antigo por cima dela.
Somente as duas sessões temporárias deste ensaio foram revogadas, com remoção
dos arquivos privados de credenciais. Referências, limites e evidências:
[plano da correção](superpowers/plans/2026-10-03-muse-fidelity-correction.md),
`artifacts/muse-fidelity/` e `artifacts/android/muse-fidelity-release/evidence/`.

O usuário **aprovou os avatares**, mas rejeitou a interface da revisão anterior.
A nova interface usa **web e Android `f4eec06`**, publicada em
`/opt/okami-web/releases/f4eec06-public`; a **API continua em `32a1ae5`**, sem
reinício ou alteração do pipeline de geração. Arte, renderizador, animações e
seleção salva do companheiro foram preservados.

A [auditoria de referências](superpowers/research/2026-10-03-muse-interface-reference.md)
e o [plano da interface](superpowers/plans/2026-10-03-muse-interface-correction.md)
registram as telas observadas e as adaptações. A implementação inclui janela de
configurações desktop de 760×570 com categorias, navegação móvel por categoria,
biblioteca com prévias reais, Feed, Ideias, Metas, menus de mensagem e detalhes
de tarefa com histórico lateral. O painel móvel do agente ocupa a tela inteira.
O diálogo separado de personalização é uma adaptação do app: a referência do
Muse cria personagens pela conversa. Tema escuro e controles específicos de
conta/cobrança da Meta não foram implementados nesta revisão.

A verificação integrada passou **139/139 testes de interface/comportamento**,
incluindo o teste real Playwright do visualizador, além de TypeScript e Biome
sem erros em 508 arquivos. A correção final da altura do compositor foi
conferida no navegador, inclusive após apagar um rascunho longo. Capturas desktop
e móvel, geometria, ausência de overflow, preservação do rascunho e reprodução
dos três estados estão em `artifacts/muse-interface/verification/`.
A galeria local `artifacts/muse-interface/comparison.html` coloca referência e
implementação lado a lado. Esses resultados não equivalem à aprovação visual
do usuário nem comprovam identidade pixel a pixel.

A publicação pública da web entregou o bundle `index-37ad71ba810714e90ac1bcf8f5987304.js`
com SHA256 `ffa4466701dbc97b73c6556c94b2df93913a513bd17423006ac39308d8c507f2`,
idêntico ao build local. Health respondeu 200, API sem sessão 401 e executor e
manutenção 404. Recibos: `artifacts/muse-interface/web-build.json` e
`artifacts/muse-interface/public-web-checks.json`.
O ensaio autenticado no domínio público abriu configurações, conectores,
personalização e biblioteca em desktop/móvel, com reprodução do companheiro
atual, zero erros de página e nenhum pedido de alteração de conteúdo. As sessões
temporárias próprias foram revogadas ao terminar.
Recibo final: `artifacts/muse-interface/verification/public-ui-checks.json`.

As verificações Node da correção anterior dos avatares foram executadas em dois
lotes: 431/432 e 519/519. A única falha era o harness do visualizador desktop, que
precisava reconhecer imports
MP4 e a URL Expo; foi corrigida e o ensaio real com Playwright passou. Após as
últimas alterações, geração/renderização/visualizador passaram 19/19, estúdio
11/11, idioma 4/4 e branding 1/1. TypeScript mobile/servidor, builds web/servidor
e Biome sem erros também passaram; avisos de lint permanecem. Esses resultados
comprovam funcionamento e regressões, não equivalência visual exata nem
aprovação do usuário.

A publicação da API drenou o trabalho ativo, com contadores zerados e manutenção
encerrada ao final, preservando a pausa desativada na revisão 16. O pin está em
`/root/okami-deployment/source-pin`. As publicações posteriores da web e do APK
não reiniciaram a API nem interromperam a criação iniciada pelo usuário.
O APK final foi baixado do endereço público: HTTP 200, tamanho e SHA256 idênticos
ao artefato assinado. A raiz entrega o bundle final; health responde 200, API
sem autenticação 401 e executor/manutenção 404 no gateway público.

A validação final em `d6fa127` passou **908/908 testes Node**, TypeScript e build
do servidor. Biome terminou sem erros (189 avisos existentes e duas informações).
O renderizador 3D e os fluxos reais de web/Android foram verificados separadamente;
recibos e logs estão em `artifacts/resume-recovery/` e `artifacts/android/`.

O aceite real da retomada concluiu cinco tarefas: quatro planos em texto com
artefatos da revisão atual e uma consulta `computer_status` com observação nova.
Quatro tarefas foram observadas em execução simultânea enquanto o chat respondeu
“chat disponível”. Os pedidos foram retomados por diretivas normais, preservando
recibos anteriores, sem repetir comandos ou efeitos externos. Evidência local:
`artifacts/resume-recovery/live-tasks-verified.json`.


Na implantação técnica anterior, passaram 867/867 testes Node, os três projetos
TypeScript, 92/92 testes Python do computador e 49/49 testes de scripts, incluindo
criptografia age real. A fonte instalada na Lenovo continua `985b51d`; esses
resultados são do aceite anterior e não equivalem a uma nova execução nesta retomada.
O limite operacional de contexto em ChatGPT/Grok é 131072: orçamento de admissão
do app, não medição da janela máxima do modelo.

## Instalação observada

| Máquina | Serviços e dados |
| --- | --- |
| VPS `100.113.59.40` | API e único escritor PGlite, worker de tarefas embutido, Chromium de reserva, OpenBao 2.7.1/Raft; código em `/opt/openmuse`, configuração privada `.env`, volumes persistentes. Hermes existente preservado. |
| Lenovo `100.91.96.14` | Supervisor `okami-executor@lenovo-okami`, sessão `okami-session@lenovo-okami`, Xfce/X11 e Chromium, workspace/home persistentes, LibreOffice, ferramentas de arquivos e Whisper small CPU/int8. Código de execução root-owned em `/opt/okami-computer`. |
| Aoostar | Máquina administrativa já existente: build Android, evidências e recuperação cifrada. Não é um terceiro servidor necessário ao funcionamento do bot. |

A conta nativa `okami-bot` conserva sudo e grupos existentes, SSH e RDP. Não há VM
nem limite individual fixo de 8 GB. É uma conta de confiança total: sudo amplo
permite contornar controles locais; não se promete isolamento contra esse usuário.
A RAM física medida foi 15.887.069.184 bytes; o orçamento agregado dos bots deixa
4 GiB para o host, resultando em 11.592.101.888 bytes. Aplicativos acima de 8 GB
continuam sujeitos à admissão e a um ensaio real de capacidade.

Na VPS, API 1 GiB + Chromium 2 GiB + OpenBao 256 MiB + reserva Hermes 2.304 MiB +
sistema 1 GiB totalizam **6.979.321.856 bytes**, abaixo de 7 GB decimais. Swap de
4 GiB foi instalado e persistido. Limites não representam consumo medido contínuo.
O serviço fica em `100.113.59.40:8787`, acessível pela tailnet; nenhuma porta pública
do bot nem Tailscale Funnel foi habilitado. O HTTPS privado está ativo em
`https://srv1667308.tail107988.ts.net`: HTTP 200, certificado validado sem bypass
e TLS 1.3 verificados da Aoostar. Serve/Funnel indica acesso somente pela tailnet.

O OpenBao foi inicializado com selo estático, testado com gravação/leitura/exclusão,
e usa tokens periódicos distintos para broker e snapshot. A renovação real passou;
o timer renova de hora em hora. O token root inicial foi revogado depois de guardar
recuperação/selo cifrados na Aoostar. O cofre não tem senhas pessoais cadastradas.

## Verificações reais concluídas

- Take control pela API: assumir 264 ms, captura 311 ms, confirmação de input
  266 ms, devolver ao agente 156 ms. São amostras pontuais, não percentis de carga.
- Comando nativo em background; leitura/escrita Unicode no workspace; criação
  de DOCX, PPTX e XLSX e preview DOCX → PDF pelo LibreOffice.
- Exportação e download pela API dos quatro arquivos: DOCX 36.600 bytes,
  PPTX 28.104, XLSX 4.828 e PDF 13.379; assinaturas ZIP/PDF, tamanho e hashes
  conferidos. Recibos privados em `/root/okami-deployment/media-smoke-result.json`
  na VPS. A publicação tem autorização própria, independente do bloqueio da
  leitura já concluída na Lenovo.
- Whisper small processou um WAV silencioso de dois segundos pela API, com saída
  de texto e SRT. O pin `av==18.1.0` corrigiu a incompatibilidade real do decoder
  com PyAV 19. Isto não mede reconhecimento de fala em português/inglês/alemão.
- O encerramento da API libera consultas nativas longas sem ultrapassar o limite
  de parada. Testes cobrem HTTP real, entrega ainda não autorizada e preservação
  de operações pendentes para recuperação após reinício.
- Retomada da Lenovo após parada para backup: a espera limitada pelo socket
  gráfico evita colocar a sessão recém-iniciada em quarentena. Na instalação
  do ensaio de retomada, a pausa foi liberada na revisão 12; `FreezerState=running`, display,
  captura, entrada e navegador prontos, sem erros novos no supervisor.
- Reinício controlado da API com saída 0 e sem OOM; após os testes, os contadores
  de tarefas, operações, recursos, entregas nativas e HTTP em andamento estavam
  todos em zero. Não foi simulado corte físico de energia.

Dois pedidos de aceite que falharam durante correções foram conciliados
individualmente com provas de não despacho ou leitura concluída/publicação ausente.
O estado anterior e o registro de operador foram preservados no banco. Nenhum
resultado externo incerto foi convertido genericamente em sucesso nem repetido.
O pareamento temporário usado pelo operador nesses testes foi revogado; os arquivos
locais com seus tokens foram removidos. Isso não revoga o acesso do futuro telefone.

## Backup e observação prolongada

As conexões de backup usam chaves SSH distintas, com comando forçado e origem
Tailscale fixa. Tentativas de comando arbitrário foram recusadas. As identidades
age privadas ficam na Aoostar, fora dos dois hosts de execução. Selo/recuperação
OpenBao, assinatura Android e configuração administrativa foram cifrados e suas
cópias de recuperação foram verificadas em `/root/okami-recovery`.

O backup coordenado do banco, perfis, cofre e workspace concluiu com saída 0:
VPS com 4.788.210 bytes e Lenovo com 642.848 bytes, ambas as cópias cifradas e
transferidas ao outro host com checksum. API e navegador confirmaram parada limpa.
A restauração real passou em diretórios privados da Aoostar, sem iniciar o app,
executor ou cron restaurados. O lote `f30ef47d-4247-427c-bd6d-09beb9df0f9f` preserva
a pausa histórica 9; ciphertexts e checksums coincidiram entre origem, peer e
Aoostar. PGlite: 305 registros, 36 tipos e uma publicação cujo tamanho/hash
corresponde ao workspace restaurado. Na Lenovo, sete bancos SQLite passaram na
checagem de integridade; 14 links internos foram preservados e 42 externos foram
omitidos com registro. Um cache Tracker não pôde ser verificado porque depende
de um tokenizer específico; isso não foi tratado como prova de corrupção.

O snapshot Raft de 24.601 bytes foi restaurado no OpenBao 2.7.1 isolado por loopback:
permissões dos dois tokens periódicos órfãos e revogação do root inicial preservadas,
reinício com abertura automática pela chave correta e recusa com chave incorreta.
O processo de inspeção foi encerrado e sua chave temporária removida. As provas
ficam em `/root/okami-recovery/coordinated-backup-proof.json` e
`/root/okami-recovery/raft-inspection-20261003T061807Z-c826989b/proof.json` na Aoostar.

O timer diário está habilitado, com persistência, às 03:30 Europe/Berlin e atraso
aleatório de até 15 minutos; próxima execução observada: **4/10/2026 às 03:38:10**
(01:38:10 UTC). Nenhum ciclo extra foi iniciado ao habilitá-lo.

A observação de 24 horas começou em 3/10 às **06:25:09 UTC na VPS** e
**06:25:59 UTC na Lenovo**; término previsto no dia 4 nos mesmos horários.
Amostras de metadados são coletadas a cada minuto, sem telas, conteúdo ou segredos.
Primeira amostra: API acessível nos dois hosts; 5,29 GiB livres na VPS e 11,64 GiB
na Lenovo, com métricas de cgroups disponíveis. As capturas ficam em:

- VPS: `/var/lib/okami-soak/soak-vps-20261003T062509Z.jsonl`.
- Lenovo: `/var/lib/okami-soak/soak-lenovo-20261003T062559Z.jsonl`.

Cada captura terá relatório `.report.json` ao terminar, privado de root.
São jobs únicos, sem autostart.
**A coleta foi iniciada, ainda não concluída**; não se infere estabilidade
prolongada dos testes curtos nem latência de chat a partir do healthcheck.

## Android

Fonte mobile final: `f4eec06`; identificador técnico `app.openmuse.mobile` e scheme
`openmuse` preservados. Os APKs usam a chave persistente privada do projeto,
assinatura verificada, release não debuggable e certificado SHA256
`e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
Ambos usam `https://app.okamibot.cloud`, sem Tailscale no aparelho.

- [ARM64 para o telefone](https://app.okamibot.cloud/downloads/okamibot.apk?v=f4eec06):
  58.889.561 bytes; SHA256
  `0d84d1e4ddf8fd1d526af8f8ece8d77772ecdd1a0ad7d6b80fa8f9f6f55076c8`.
  O download público foi comparado ao build local assinado; recibo em
  `artifacts/muse-interface/public-apk-checks.json`.
- [x86_64 para o emulador](../artifacts/android/muse-interface-release/okamibot-release-x86_64.apk):
  60.638.496 bytes; SHA256
  `534a43f1664d764724cc1ca9045685c1a0cf30ceac43fc41d424b4f60a6d0000`.
- Recibos de assinatura/proveniência ficam junto dos APKs em
  `artifacts/android/muse-interface-release/`. Evidências de interface ficam em
  `artifacts/android/muse-interface-release/evidence/`. Esses artefatos são locais e
  ignorados pelo Git.

A atualização final no emulador API 34 preservou pareamento e rascunho e acessou
o workspace real por HTTPS público. Configurações (categorias, Geral e
Conectores), Voltar do Android, painel do agente em tela inteira, Aprovações,
personalização com abas Aparência/Personalidade, Feed, Ideias, Metas, Biblioteca
e um arquivo existente, além dos detalhes de uma tarefa real, foram conferidos.
Navegar e fechar diálogos manteve o rascunho. Português foi verificado na web;
esta rodada nativa não concluiu uma verificação específica de PT-BR. A reprodução dos três vídeos padrão, modo offline e movimento reduzido
foi verificada na correção anterior (`32a1ae5`); o renderizador não mudou nesta
revisão. O ensaio atual não repete nem amplia essa prova de mídia.

O ensaio Android não alterou a identidade global: carregou e preservou a criação
mais recente do usuário, inclusive mudanças de nome/avatar feitas em outra
sessão durante o ensaio. Idioma, rede e escalas locais coincidiram com o estado
inicial; somente o rascunho de teste foi removido. O logcat de erros ficou vazio.
Recibos em `evidence/native-acceptance.json` e `evidence/local-cleanup.json`. Não houve teste em telefone
físico; esse aceite permanece necessário.

Instale o ARM64 como atualização se já houver app compatível, preservando dados.
Se a assinatura não corresponder, interrompa sem desinstalar/limpar dados para
contornar o problema. Keystore e senhas não são necessários para instalar o APK.

## Ativação que ainda depende de contas ou aparelho

1. Instalar o APK ARM64 pelo link público acima e parear com a chave privada do
   workspace. O telefone não precisa entrar na tailnet.
2. ChatGPT e Grok já foram autorizados: OAuth oficial com permissão de assinatura
   no ChatGPT, arquivo importado preservando a identidade própria da VPS, e device
   flow no Grok. A cópia temporária com tokens do laptop foi removida após importar.
   Por solicitação do usuário, o padrão é **`chatgpt/gpt-6-luna`**. Apesar de esse
   identificador não aparecer no catálogo inicial, a chamada real retornou HTTP 200,
   resposta completa e chamada de ferramenta no namespace `openmuse`. O fallback
   **`grok/grok-4.6`** também respondeu de fato, sem recorrer a outro provedor.
   A API está saudável com `agentConfigured:true`; a manutenção terminou sem pausa
   ativa (revisão 16). MiMo permanece configurado depois do Grok, aguardando sua chave
   Token Plan. As credenciais continuam privadas, sob o usuário da API, e a renovação
   automática está habilitada. Para reautorizar ou adicionar MiMo, seguir
   [MODEL-BACKENDS.md](MODEL-BACKENDS.md). Assinaturas Anthropic/Cursor não foram integradas.
3. Para e-mail/agenda reais, configurar Google OAuth e conectar pelo app; o fuso
   do deployment é `Europe/Berlin`. MCP/Composio são opcionais. Segredos entram
   somente nos arquivos/campos privados apropriados, nunca no chat de conversa.
4. Configurar credenciais de push Android/FCM e verificar recepção com o app fechado.
   API de notificações e testes com fixtures não comprovam entrega física.
5. Parear o telefone com a chave privada do deployment e testar três tarefas reais,
   incluindo orientação durante trabalho, quatro trabalhos concorrentes e tomada
   de controle. Falhas transitórias não devem exigir novo pareamento.

Ainda sem aceite físico: Wi-Fi/energia/reboot, cinco sessões leves, Blender/Android
Studio/emulador ou carga acima de 8 GB, persistência de login real no navegador,
senha/OTP de uma conta real e 24 horas completas de observação. Contas remotas,
qualidade dos modelos e seus limites não são dedutíveis dos testes automatizados.

## Operação

Na VPS, o procedimento ativo é o híbrido (não o computador Docker legado):

```sh
cd /opt/openmuse
docker compose -f docker-compose.yml -f deploy/compose.hybrid.yml ps
curl --fail http://100.113.59.40:8787/api/health
systemctl status okami-openbao-renew.timer okami-hybrid-backup.timer
```

Na Lenovo, use `systemctl status okami-executor@lenovo-okami.service
okami-session@lenovo-okami.service` e o [guia híbrido](../deploy/HYBRID.md).
Não abrir dois escritores no diretório PGlite nem iniciar executores restaurados
contra a API ativa. Restaurações ficam em diretórios isolados para inspeção.

MIT e avisos das dependências foram preservados. Não foi adicionada dependência
SaaS obrigatória nem licença paga para o cofre.
