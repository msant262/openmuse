# Relatório do harness, publicação e limpeza — 11/10/2026

**O trabalho completo ainda não está entregue.** A API publicada está em `c0c2c9ec`. O último pedido normal de pesquisa concluiu sozinho em **1min38,617s**, com um PDF real, usando **14 respostas somente de Luna**. O arquivo abriu no app e a navegação nas duas páginas funcionou. A comprovação factual de todos os campos ainda não passou; a integração completa do Workspace, a equivalência integral com Hermes/OpenClaw e a performance sustentada também continuam abertas.

## Estado conferido às 12:56 UTC

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

## Último pedido normal pelo chat publicado

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

## Pendências que impedem declarar a entrega

1. Garantir comprovação dos campos pedidos no item correto, sem aproveitar informação de outro curso/documento. O contrato atual de conclusão física ainda não garante isso.
2. Integrar o despacho automático dos cards ao ciclo existente, devolver a entrega à conversa correta e tratar falhas sem repetir operações cujo resultado esteja incerto. Completar e verificar os demais contratos de Hermes/OpenClaw: perfis/worktrees no executor publicado, objetivos, CI, ferramentas kanban e execução programática do navegador. Schemas e código presentes não comprovam equivalência completa.
3. Ampliar os testes normais pelo chat de todas as operações do Google Workspace, incluindo alterações, exclusões e cards. Os casos acima são aprovações específicas.
4. Corrigir a causa do consumo alto e medir celular sob uso repetido. Na última amostra o servidor usava **1.005 MiB** e o navegador **421,2 MiB**, ainda com aproximadamente 7% e 8,5% de CPU sem tarefa ativa. **A causa não está estabelecida nem corrigida.**
5. Concluir a revisão ampla das ações/resumos e reconciliar as operações históricas incertas.

**16 arquivos privados da VPS foram copiados com hashes conferidos**, incluindo publicação, resultado, PDF, integridade e limpeza. Evidência privada atual em `artifacts/harness-parity-20261009/private-round67-vps`, fora do Git. O [histórico técnico](2026-10-09-harness-parity.md) e a [matriz de ferramentas](2026-10-09-harness-tool-inventory.json) preservam os resultados e limites de cada rodada.

**O objetivo permanece ativo. Não há aprovação integral do harness, do Workspace ou da performance.**
