# Relatório do harness, publicação e limpeza — 11/10/2026

**Ainda não está entregue.** Houve correções publicadas, testes reais e limpeza, mas o último pedido normal com Luna entregou um PDF com lacunas factuais e foi marcado como concluído. A pesquisa autônoma completa, a cobertura integral do Google Workspace e a equivalência com Hermes/OpenClaw continuam sem aprovação.

## Estado da publicação e do código

| Estado | O que está nessa versão |
| --- | --- |
| App publicado: `eab48171` | Inclui a recuperação nativa `820c880b`, a política de campos comparativos `201b48df` e a revisão obrigatória de pedido/fontes `4f8163da`. Troca somente da API em 19,87 segundos, com parada limpa. |
| Correção de pesquisa na main: `59721605` | Remove a instrução do workflow que aceitava campos sem confirmação após uma leitura. Explica a recuperação do texto completo preservado e a substituição de opções insuficientemente documentadas. **Ainda não publicada nem aprovada por novo pedido normal.** |
| Correção da barra lateral na main: `6b295f52` | Conversa já salva que não aparece na página recebida do servidor deixa de ser recriada como rascunho local. **Ainda não publicada nem conferida na interface publicada.** |

A publicação preservou banco, configuração, identidade do navegador e contas. Imagem atual: `sha256:1bebf0f8385c620a7f4e77b456393d2585b79d0c57150b7b28b80b8ca08351f6`. A imagem anterior `201b48df` foi mantida para recuperação. O frontend não foi atualizado nessa troca da API.

Na última conferência registrada, API, navegador e OpenBao estavam saudáveis, sem tarefas, conversas, solicitações HTTP ou entregas nativas ativas. Permanecem **44 operações históricas incertas**, sem alteração artificial de resultado. Essa fotografia não comprova disponibilidade ou desempenho sustentados.

## Último teste real: PDF entregue, pesquisa reprovada

Pedido enviado pelo compositor do app publicado, em conversa nova, sem citar ferramentas, responder ao agente ou reparar a tarefa:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

| Medida | Resultado observado |
| --- | --- |
| Tempo desde o envio | **4min20,127s**; de 08:29:23,090 a 08:33:43,217 UTC. |
| Modelo executor | **21 respostas de `chatgpt/gpt-6-luna`**, sem revisor independente ou modelo de fronteira. |
| Documento | PDF real de **60.030 bytes e três páginas**; bytes, texto, imagens e navegação pelas três páginas conferidos. |
| Entrega física | Aprovada. SHA-256 `67b68f11c0a4488f4f48fc576e2fb41626b326cb77717dfa3dd8e535bad1b459`. |
| Pesquisa e conclusão | **Reprovadas**. A tarefa foi encerrada mesmo com campos pedidos sem comprovação suficiente. |

A primeira revisão do próprio executor detectou três problemas: confusão entre o curso Google e a trilha que concede o badge, idioma do item IBM sem confirmação e acesso/custo Google sem confirmação suficiente. O agente consultou outra página Google e criou um PDF substituto; a segunda revisão aprovou sem resolver a lacuna IBM. O PDF final ainda deriva idiomas do idioma da página. Também afirma ausência de detalhes na fonte Microsoft sem recuperar o texto completo, que estava truncado.

Os trechos reais sustentavam três currículos distintos, a duração Google de 45 minutos, a trilha de badge separada de cerca de duas horas, o intervalo IBM de três a dez horas, as 21 lições Microsoft e a tradução disponível para português brasileiro. Esses acertos não comprovam todos os campos solicitados.

O contrato canônico de conclusão exigia apenas um PDF válido, com `requiredItems` vazio. A revisão do executor passou a conferir conteúdo, mas ainda não estabelece uma verificação suficiente de completude factual. Houve três falhas de leitura pública e uma inspeção com identificador inválido; a tarefa seguiu sem perguntar ao usuário. A aprovação física não foi usada como aprovação do objetivo inteiro.

A evidência privada da rodada está em `artifacts/harness-parity-20261009/private-round63-vps`, fora do Git. Quatorze arquivos foram copiados com hashes iguais aos da VPS. O snapshot completo só diferia na URL temporária assinada do arquivo; as duas versões foram preservadas, com operações e etapas iguais. Manifesto: `round63-private-evidence-manifest.json`.

## Causas corrigidas e validação

| Causa | Correção e limite da prova |
| --- | --- |
| Leitura HTTP considerava FAQ sem respostas como completa | `841f4bf4`, já publicada: classifica a representação como parcial e permite recuperação. Quatro falhas reproduzidas antes; 70/70 controles depois. |
| Política permitia encerrar campo pedido após uma leitura | `201b48df`, publicada: mantém o requisito enquanto houver detalhe, recuperação ou alternativa útil. Três falhas reproduzidas; 62/62 controles. Os pedidos normais posteriores continuaram reprovados factualmente. |
| Revisão obrigatória conferia só aparência | `4f8163da`, publicada na imagem atual: inclui pedido real, orientações atuais, fontes observadas e total de páginas. 74 controles anteriores à paginação; nove controles finais de revisão/paginação, TypeScript e builds aprovados. Os grupos não são uma nova suíte completa da release. |
| Workflow realmente carregado ainda contradizia a política geral | `59721605`, na main: orienta `read_web_source` com `spill.fileId` para recuperar trechos preservados, evita inferir idioma do item pela interface e mantém pesquisa/substituição úteis. A falha foi reproduzida no workflow entregue ao modelo; **17/17 controles** passaram, mais uma repetição final do caso de contexto. TypeScript, cópia dos assets e build do harness aprovados. Falta publicação e aceitação normal. |
| Cache de conversa salva era classificado como rascunho | `6b295f52`, na main: só visitas ainda não salvas entram como rascunhos. Falha reproduzida antes; **5/5 controles**, TypeScript do projeto e mobile aprovados. Lint final sem erros, com dois avisos preexistentes. Não apaga cache nem dados do usuário. Falta publicação e aceitação visual. |

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

- Rodada mais recente: **oito registros de apresentação de QA** retirados — quatro arquivos, uma tarefa, uma conversa, uma notificação e uma entrada de inbox. **1.795 registros fora da seleção ficaram idênticos**. Os recibos canônicos foram preservados.
- Companions, dados reais da Beatriz, **três contas Google simultâneas**, três memórias e 58 arquivos reais protegidos foram preservados. Os 32 registros de versões de procedimentos existentes ficaram iguais; nenhum procedimento novo de QA dessa rodada precisava ser arquivado.
- VPS: removidas **três imagens API obsoletas** e seus três diretórios/arquivos de release, após conferir referências dos containers e **35.644 hashes de arquivos**. Liberação líquida observada de aproximadamente **1,31 GB**. Oito imagens atuais/de recuperação/serviços foram mantidas; volumes, backups, perfis nativos e recibos permaneceram intactos.
- Local: três arquivos de release obsoletos removidos após conferência de hashes, liberando **159.584.256 bytes alocados**.
- Rodadas anteriores: **12 APKs obsoletos** retirados, liberando **811.757.568 bytes alocados**, além de conversas, ações, revisões e documentos identificados como testes. Não houve nova retirada de APK nesta rodada.
- Última conferência: **33.467.715.584 bytes livres na VPS**. A limpeza da base não removia a entrada reconstruída pelo cache local; a causa foi corrigida no código da barra lateral e ainda precisa ser publicada.

## Trabalho ainda necessário

1. Publicar as duas novas correções da main e repetir o pedido normal com Luna, conferindo cada campo nas fontes reais e no documento entregue. Corrigir a conclusão que aceita somente a existência física do PDF.
2. Completar os contratos restantes de Hermes/OpenClaw e validar seu uso autônomo, incluindo dispatcher, perfis/worktrees, objetivos, CI e execução programática do navegador. Nomes e schemas não bastam.
3. Ampliar os testes pelo chat de todas as operações do Workspace, especialmente alterações/exclusões e os cards correspondentes. Os casos já aprovados não cobrem todas as ações possíveis.
4. Medir performance sustentada no celular e sob uso repetido, incluindo consumo de RAM/GPU, carregamento incremental e crescimento das conversas.
5. Concluir a revisão de UX das ações e reconciliar os registros históricos incertos com evidência do resultado. Esses registros não foram apagados para simular um sistema sem erros.

**O objetivo permanece ativo. Não há evidência suficiente para declarar o harness completo, perfeito ou entregue.**
