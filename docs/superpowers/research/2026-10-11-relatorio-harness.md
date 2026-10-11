# Relatório do harness, publicação e limpeza — 11/10/2026

**Ainda não está entregue.** Houve correções publicadas, testes reais e limpeza, mas o último pedido normal com Luna entregou um PDF com lacunas factuais e foi marcado como concluído. A pesquisa autônoma completa, a cobertura integral do Google Workspace e a equivalência com Hermes/OpenClaw continuam sem aprovação.

## Estado da publicação e do código

| Estado | O que está nessa versão |
| --- | --- |
| API publicada: `d8882335` | Inclui as correções anteriores e o workflow de pesquisa `59721605`. Troca da API em **21,18 segundos**, com parada limpa. |
| Frontend web publicado: `d8882335` | Inclui `6b295f52`: conversa salva ausente da página recebida deixa de ser recriada como rascunho. Os hashes do HTML e do JavaScript conferem no endereço público. A barra lateral publicada foi conferida após a limpeza: a conversa real permaneceu e as conversas de QA retiradas não reapareceram. |
| Correção de revisão na main: `0a9fd8e5` | A revisão de um documento substituto recebe os problemas reais da revisão recusada anterior, ligados à mesma tarefa/revisão e à cadeia de substituição do arquivo. **Validada localmente; ainda não publicada nem aprovada por um pedido normal.** |

A publicação preservou banco, configuração, identidade do navegador e contas. Imagem atual da API: `sha256:ad4a211a98f420f005dfc06675d1ab0d1c7b5d595755f0afb876bc41e185d468`. A versão anterior `eab48171` foi mantida para recuperação. O APK não foi atualizado nesta rodada.

Na conferência de **11/10/2026 às 09:15 UTC**, API, navegador e OpenBao estavam saudáveis, sem tarefas, conversas, solicitações HTTP ou entregas nativas ativas. Permanecem **44 operações históricas incertas**, sem alteração artificial de resultado. Essa fotografia não comprova disponibilidade ou desempenho sustentados.

## Último teste real: PDF entregue, pesquisa reprovada

Pedido enviado pelo compositor do app publicado, em conversa nova, sem citar ferramentas, responder ao agente ou reparar a tarefa:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

| Medida | Resultado observado |
| --- | --- |
| Tempo desde o envio | **5min33,319s**; de 09:03:59,047 a 09:09:32,366 UTC. |
| Modelo executor | **40 respostas de `chatgpt/gpt-6-luna`**, sem revisor independente ou modelo de fronteira. |
| Documento | PDF real de **52.399 bytes e três páginas**, `cursos-gratuitos-ia-generativa.pdf`; bytes, texto e imagens das três páginas conferidos. |
| Entrega física | Aprovada. SHA-256 `35c7e39ed4005bf92eb7386d0d12dadb282990e13ff777d8c8a06d19092bc421`. Não foi completada a navegação pelo visualizador publicado antes da retirada dos dados de QA. |
| Operações canônicas | Nenhuma operação falhou; houve dois documentos e duas revisões. |
| Pesquisa e conclusão | **Reprovadas**. A tarefa foi encerrada com fatos pedidos sem comprovação suficiente. O tempo piorou em relação aos 4min20s da rodada anterior. |

A primeira revisão do próprio executor recusou o PDF porque os cursos Google não tinham idioma e gratuidade suficientemente confirmados. O agente consultou o plano Google e as páginas IBM, trocou uma opção e criou um PDF substituto. A segunda revisão aprovou, mas os campos Google ainda derivam idioma da página/material consultado, sem evidência do idioma do curso completo. A capa e a nota final afirmam acesso e credencial gratuitos enquanto remetem ao usuário a confirmação das condições dos labs. A ausência de preço anunciado não comprova credencial sem taxa.

Houve progresso verificável: a página da **credencial IBM selecionada** informa expressamente os quatro idiomas e a duração de três horas. As fontes dos cursos Google informam 45 minutos e uma hora. O plano Starter Google existe sem custo e oferece créditos mensais limitados; essa política geral não prova as condições completas de cada curso/badge escolhido.

O contrato canônico de conclusão ainda exige apenas um PDF válido, com `requiredItems` vazio. A revisão do executor não estabelece uma verificação suficiente de completude factual. A nova correção local preserva as falhas anteriores no contexto obrigatório da revisão; **isso não substitui uma verificação factual suficiente nem prova que o modelo corrigirá o resultado**.

A evidência está em `artifacts/harness-parity-20261009/research64-acceptance.json` e `private-round64-vps`, fora do Git. Onze arquivos privados de execução, publicação e limpeza foram copiados com hashes iguais aos da VPS, conforme `round64-private-evidence-manifest.json`.

Corrigi também a interpretação de uma evidência anterior: não chamar `read_web_source` explicitamente não prova que o modelo recebeu só um trecho, porque a projeção do executor pode expandir automaticamente o cache elegível. A requisição real do provedor não foi capturada nessa rodada. A correção foi registrada separadamente, preservando os recibos originais; as lacunas factuais continuam reprovadas.

## Causas corrigidas e validação

| Causa | Correção e limite da prova |
| --- | --- |
| Leitura HTTP considerava FAQ sem respostas como completa | `841f4bf4`, já publicada: classifica a representação como parcial e permite recuperação. Quatro falhas reproduzidas antes; 70/70 controles depois. |
| Política permitia encerrar campo pedido após uma leitura | `201b48df`, publicada: mantém o requisito enquanto houver detalhe, recuperação ou alternativa útil. Três falhas reproduzidas; 62/62 controles. Os pedidos normais posteriores continuaram reprovados factualmente. |
| Revisão obrigatória conferia só aparência | `4f8163da`, publicada na imagem atual: inclui pedido real, orientações atuais, fontes observadas e total de páginas. 74 controles anteriores à paginação; nove controles finais de revisão/paginação, TypeScript e builds aprovados. Os grupos não são uma nova suíte completa da release. |
| Workflow realmente carregado ainda contradizia a política geral | `59721605`, publicada: orienta `read_web_source` com `spill.fileId` para recuperar trechos preservados, evita inferir idioma do item pela interface e mantém pesquisa/substituição úteis. A falha foi reproduzida no workflow entregue ao modelo; **17/17 controles** passaram, mais uma repetição final do caso de contexto. TypeScript, cópia dos assets e build do harness aprovados. Publicação e novo pedido normal concluídos; a pesquisa continua reprovada factualmente. |
| Cache de conversa salva era classificado como rascunho | `6b295f52`, publicada no web: só visitas ainda não salvas entram como rascunhos. Falha reproduzida antes; **5/5 controles**, TypeScript do projeto e mobile aprovados. Lint final sem erros, com dois avisos preexistentes. Não apaga cache nem dados do usuário. A interface publicada foi conferida após a limpeza, sem reconstruir as conversas de QA retiradas. Não aprova toda a UX. |

A correção `0a9fd8e5` reproduziu a ausência dos problemas anteriores no contexto obrigatório da revisão substituta. **12/12 controles focados** passaram, com TypeScript, build do servidor, assets e harness aprovados. Lint sem erros, com dois avisos preexistentes. Não adiciona outro modelo ou uma revisão externa; publicação e resultado autônomo continuam pendentes.

A integração nativa de kanban contém quinze schemas originais e contratos de journal/posse/retomada. A recuperação `820c880b` está publicada, com 78 controles focados. A suíte de **2.021 testes** pertence à árvore fixa C e exclui a última proteção de perfil e mudanças posteriores; não é uma aprovação completa da versão atual. Dispatcher real, execução física de worktrees/perfis, objetivos e CI do commit exato continuam pendentes.

## Casos anteriores verificados pelo chat publicado

| Fluxo | Evidência e alcance |
| --- | --- |
| Drive com nome aproximado | “MOVING DE” encontrou `MovingDE` entre as três contas; travessia conferiu **508 arquivos e 15 subpastas**, em 18 páginas. Não comprova leitura integral dos documentos nem conclusão da renovação de vistos. |
| Gmail: rascunho e envio | Pedido natural criou rascunho real na conta de teste, com card automático. Enviar realizou o envio; outra conversa encontrou a mensagem. |
| Gmail: labels e arquivo | Dois e-mails de teste receberam a label e saíram da caixa de entrada; leitura posterior confirmou `Label_29` e ausência de `INBOX`. Não aprova limpeza em massa. |
| Docs, Sheets e Slides | Criações/alterações de documentos de teste verificadas por releitura; inclui fórmula na planilha e conteúdo de dois slides. Não é cobertura de todas as operações. |
| Agenda | Evento conferido para 11/10, 15h–15h30, `Europe/Berlin` (+02:00), com lembrete dez minutos antes. Uma falha de reconexão limita a prova de autonomia desse caso. |
| Exclusão com aprovação | Um e-mail de teste só foi para `TRASH` depois da aprovação no card; Google confirmou a alteração e o agente retomou. |
| Imagem conectada | Infográfico normal com Luna usou **`codex/gpt-image-2`** e foi entregue em **89,029s**, com fonte e pixels conferidos. |
| Memória e aprendizado | Bloqueio da fila de Code Mode reproduzido e corrigido. Revisão de conversa em **10,789s** e aprendizado de procedimento em **15,166s** nos casos verificados. Três memórias reais preservadas; procedimento de QA arquivado. |
| Histórico/carregamento | Consultas de coordenação limitadas à conversa, sem carregar todo o histórico de tarefas. Amostras de recarga de **529/534 ms** para o compositor; não medem GPU/RAM sustentadas no celular. |
| Cards/ações | Rascunho aparece automaticamente e fica compacto após envio. A revisão ampla de UX e a divergência de contador permanecem abertas. |

Os casos têm resultados próprios; não representam aprovação integral do Workspace ou do produto. O histórico técnico e a comparação dos contratos estão em [harness-parity](2026-10-09-harness-parity.md) e na [matriz de ferramentas](2026-10-09-harness-tool-inventory.json).

## Limpeza e preservação

- Rodada mais recente: **oito registros de apresentação de QA** retirados — quatro arquivos, uma tarefa, uma conversa, uma notificação e uma entrada de inbox. **1.804 registros fora da seleção ficaram idênticos**. Os recibos canônicos foram preservados.
- Um procedimento aprendido exclusivamente nessa rodada de QA foi arquivado, de forma reversível. Os **32 registros de versões de procedimentos existentes** ficaram iguais.
- Companions, dados reais da Beatriz, **três contas Google simultâneas**, três memórias e 58 arquivos protegidos foram preservados. A conferência também preservou duas conversas, três tarefas, duas ações e cinco atividades reais que já existiam antes do teste.
- VPS, limpeza anterior: removidas **três imagens API obsoletas** e seus três diretórios/arquivos de release, após conferir referências dos containers e **35.644 hashes de arquivos**. Liberação líquida observada de aproximadamente **1,31 GB**. Volumes, backups, perfis nativos e recibos permaneceram intactos. A imagem atual e a recuperação continuam preservadas.
- Local: três arquivos de release obsoletos removidos após conferência de hashes, liberando **159.584.256 bytes alocados**.
- Rodadas anteriores: **12 APKs obsoletos** retirados, liberando **811.757.568 bytes alocados**, além de conversas, ações, revisões e documentos identificados como testes. Não houve nova retirada de APK nesta rodada.
- Após a nova publicação, **32.345.411.584 bytes livres na VPS**, aproximadamente 30,1 GiB. O número anterior de 33.467.715.584 bytes precedia os novos builds; a diferença não é uma nova liberação de espaço.

## Trabalho ainda necessário

1. Corrigir a conclusão que aceita lacunas factuais e a demora da pesquisa. Publicar a correção local de contexto de revisão após a validação, repetir o pedido normal com Luna e conferir cada campo nas fontes e no documento. A publicação do workflow e da barra lateral já foi concluída.
2. Completar os contratos restantes de Hermes/OpenClaw e validar seu uso autônomo, incluindo dispatcher, perfis/worktrees, objetivos, CI e execução programática do navegador. Nomes e schemas não bastam.
3. Ampliar os testes pelo chat de todas as operações do Workspace, especialmente alterações/exclusões e os cards correspondentes. Os casos já aprovados não cobrem todas as ações possíveis.
4. Medir performance sustentada no celular e sob uso repetido, incluindo consumo de RAM/GPU, carregamento incremental e crescimento das conversas.
5. Concluir a revisão de UX das ações e reconciliar os registros históricos incertos com evidência do resultado. Esses registros não foram apagados para simular um sistema sem erros.

**O objetivo permanece ativo. Não há evidência suficiente para declarar o harness completo, perfeito ou entregue.**
