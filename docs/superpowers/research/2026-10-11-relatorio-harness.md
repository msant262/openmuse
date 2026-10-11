# Relatório do harness, publicação e limpeza — 11/10/2026

## Atualização local — causa da duração ausente comprovada

**Ainda não publicado nem aprovado pelo chat.** O módulo Microsoft do PDF anterior
publica 37 minutos, mas os campos chegam vazios no HTML e são preenchidos por
JavaScript. Três testes reproduziram a certificação indevida e a falta de
recuperação. O leitor HTTP, a extração em lote e o leitor DOM foram corrigidos;
**53/53 controles passaram**, assim como TypeScript e build. O leitor corrigido
recuperou a duração na fonte pública real em **2,495 segundos**. A suíte completa
está em execução; a publicação e a repetição natural ainda faltam.
[Causa, verificação e limites](2026-10-11-research-duration-recovery.md).

A suíte ampla também reproduziu duas falhas de execução: sem prazo configurado,
o adaptador alterava indevidamente o timeout de comandos simples. Corrigido esse
caminho, **16/16 controles de computador/prazo passaram**. Dois controles de idioma
falhavam antes de executar o componente por uma dependência ausente na fixture;
**2/2 passaram** com o módulo real. A primeira passagem ampla permanece registrada
com quatro falhas, e o resultado integral ainda está pendente. As imagens da
primeira correção foram construídas e conferidas, mas não substituíram a produção.

## Estado atual — publicação e novo teste de 11/10

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
