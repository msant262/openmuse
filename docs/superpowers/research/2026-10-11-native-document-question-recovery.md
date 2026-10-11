# Continuação da revisão nativa de documentos — 11/10/2026

Implementação `10b4cf1801a752153de69cf902c3e0628a75875b`, commitada e
enviada à main. Publicada na API com imagem `ab52237c`. A correção específica
passou nos controles locais; o harness inteiro continua sem aprovação.

## Causa e alteração

No pedido anterior, o agente pediu ao usuário que decidisse a substituição de
um curso escolhido pelo próprio agente. O guard de `ask_user` consultava as
revisões opcionais de pesquisa/documento, ausentes nessa execução, e ignorava
os reparos já descritos pela revisão nativa do PDF. Havia trabalho público
executável, mas a tarefa entrava em `waiting_input`.

O guard agora reaproveita a revisão nativa atual quando existem observações de
pesquisa pública e problemas de documento ainda reparáveis. Retorna
`continue_document_repair` com os arquivos e passos concretos, sem criar uma
interação. O mesmo levantamento de revisões pendentes serve à conclusão e à
pergunta, mantendo os caminhos de falha real do renderer.

A avaliação nativa aceita `privateInput` para indicar informação privada ou
decisão indispensável ao pedido original. Não serve para pedir permissão para
continuar, substituir recomendação própria ou pesquisar fatos públicos.
Confirmações são vinculadas a tarefa, revisão aplicada, SHA do arquivo e SHA
do preview observado. Evidência antiga, estrangeira ou cujo arquivo mudou
não carrega problemas nem autorização de pergunta para a revisão atual.

Perguntas privadas legítimas continuam abrindo uma interação. O campo é
avaliado pelo modelo; a validação de vínculo não garante uma classificação
semântica perfeita. Não foi introduzido um classificador adicional, ativada a
revisão opcional ou alterado o modelo/limite de contexto para este ajuste.

## Verificação

Duas reproduções de reparo de PDF de pesquisa terminaram em `waiting_input`
antes da correção. Depois passaram, inclusive após tentativa de conclusão
parcial. Três controles preservam pergunta indispensável sobre horários
privados, com documento atual, documento substituído ou sem documento.
O teste de revisão também verifica vínculos inválidos e alteração real dos
bytes do arquivo.

**77/77 testes passaram**, zero falhas, cancelamentos ou testes ignorados,
em 183,360s. Arquivos: `document-question-recovery.test.ts`,
`document-review.test.ts`, `document-completion-repair.test.ts` e
`research-delivery-review.test.ts`. TypeScript e build passaram. Lint teve
zero erros e dois avisos preexistentes. Os grupos intermediários se
sobrepõem ao conjunto final e não foram somados.

Logs privados locais: `round79-question-red.log`,
`round79-recovery-suite.log`, `round79-typecheck.log`, `round79-build.log`.

## Publicação e execução natural

Cinco hashes compilados conferiram. A publicação da API levou 80,50s:
parada em 1,767s, contêiner criado em 2,586s, health pronto em 76,663s e
leituras protegidas concluídas em 80,486s. A espera de 74,077s entre criação
e readiness é real; a fase interna responsável ainda não foi medida.
Web, navegador, executor físico, ambiente, mounts e banco foram preservados.

Pedido enviado uma vez no chat público, em conversa nova:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue
> um PDF comparando conteúdo, idioma, duração e se o certificado é pago.
> Coloque os links das fontes.

Enviado às 17:30:25,562 UTC; encerrado às 17:35:33,881 UTC:
**308,319 segundos**, 20 respostas exclusivamente de `chatgpt/gpt-6-luna`,
duas versões de PDF e um arquivo final entregue. Zero perguntas, respostas,
orientações ou resgate pelo operador. A nova proteção de `ask_user` não foi
acionada neste caso real; sua verificação é local. A diferença de tempo entre
pedidos não prova causalidade exclusiva da correção.

O arquivo final tem **50.028 bytes e três páginas**; SHA-256
`2f0fa66403411587c9f820b2f0a4de2404d1ccce1923d041a4d9ce57ba02ee85`.
Foi recuperado pela API publicada, conferido, extraído com Poppler e
rasterizado. **Entrega física aprovada; aceite completo reprovado:**

- A fonte Google observada não estabelece o idioma das aulas nem preço do
  badge. Idioma da interface não comprova idioma do curso.
- O bloco exato da credencial IBM estabelece temas, idiomas e três horas,
  mas o preço separado da credencial permanece sem comprovação.
- A página principal Microsoft não estabelece carga horária total ou
  certificado. Há qualificações no PDF, mas elas não comprovam pesquisa
  suficiente dos campos solicitados.
- A terceira página contém somente uma nota de duas linhas. A aprovação
  nativa de revisão deixou passar essa apresentação ruim.
- O leitor público exibe controles e iframe; a captura headless não mostra
  pixels do PDF. Isso não prova falha em todos os navegadores, e a
  visualização web/celular continua sem aprovação.

O status interno `succeeded`/`verified` comprova que a execução terminou pelos
gates existentes, não a aprovação independente do resultado inteiro.

## Limpeza e preservação

Nove registros próprios do QA foram recolhidos da apresentação: tarefa,
conversa, cinco arquivos/previews, notificação e inbox. Os 1.894 registros
fora da seleção ficaram iguais, e recibos canônicos foram preservados.
Nenhum procedimento novo desse teste foi arquivado; os 35 anteriores
mantêm suas versões. Treze conferências finais preservam companions/perfil,
duas conversas, 58 arquivos, três memórias e três contas Google simultâneas.
Somente expiração/assinatura dos URLs temporários mudou, mantendo as rotas.
O navegador temporário foi fechado e seu dispositivo revogado.

Uma imagem antiga da API, seu contexto e seu release foram removidos após
verificação de uso, revisão, mounts, processos, inventário e correspondência
integral do contexto com o arquivo. **435.220.480 bytes (~415,1 MiB)** de
aumento medido de espaço livre na VPS. Versões atuais/de recuperação,
OpenBao, volumes, perfis e dados reais preservados. Não houve APK novo.
O release local obsoleto de 53.442.768 bytes também foi retirado após SHA-256
conferir com o inventário remoto; releases atual/de recuperação mantidos.

Às 17:47:02 UTC, página e API responderam HTTP 200, três containers estavam
saudáveis, manutenção desligada e seis contadores ativos em zero. As 44
operações históricas incertas permanecem preservadas. Esse snapshot não
aprova estabilidade sustentada, consumo, celular ou cobertura integral.

Recibos, capturas e arquivo final ficam fora do Git em
`artifacts/harness-parity-20261009/private-round79-vps`, com diretório 0700 e
arquivos 0600. As 22 cópias remotas tiveram seus SHA-256 conferidos.
A auditoria independente está em
`round79-independent-audit.json`; limpeza e conferências têm recibos próprios.

O próximo trabalho deve comprovar os campos pesquisados, melhorar paginação
e leitor, medir fases do startup e completar os contratos registrados no
[inventário](2026-10-09-harness-tool-inventory.json). A meta continua ativa.
