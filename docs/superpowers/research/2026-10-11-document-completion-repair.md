# Correção de conclusão e revisão de documentos — 11/10/2026

## Falha reproduzida

O pedido natural anterior criou três PDFs em 580,744s, mas encerrou sem entregar
nenhum. O terceiro arquivo existia e ainda não tinha sido inspecionado. O host
aceitou o encerramento parcial, embora a etapa pudesse ser executada. Após uma
revisão reprovada, a resposta de reparo também remetia a pesquisa genérica em vez
de trazer os problemas daquele documento.

As reproduções locais comprovaram três falhas iniciais: encerramento parcial
com revisão ausente, encerramento parcial com revisão reprovada e ausência dos
problemas específicos no recibo de reparo. Dois controles adicionais falharam:
uma página inexistente autorizava abandonar o documento e a indisponibilidade
real do processo Office não tinha classificação identificável pelo host.

## Implementação publicada

Commit `790114cd992db9af84bdf0737a8af09a1bf4bbab`, imagem
`sha256:6fc61b47895ef52e5309ef92d199ec920d96fcbfe39ee501c748b72afd6956c8`.

- O encerramento devolve o arquivo existente, os problemas concretos registrados,
  páginas pendentes e os recibos já observados que ainda precisam de avaliação.
- Uma revisão ainda executável não pode ser contornada pelo resultado parcial.
  Correções usam o arquivo atual e só substituem bytes quando houver defeito
  material; não é necessário recriar o mesmo arquivo nem reiniciar a pesquisa.
- Página inválida continua reparável. Falta do executável Office e prazo de
  renderização excedido recebem códigos distintos de erro de conteúdo ou
  argumentos. O impedimento real pode ser relatado sem fingir revisão concluída.
- Posse, revisão da tarefa, bytes, pixels, avaliação do modelo, impedimentos
  externos e limites explicitamente configurados continuam sendo conferidos.

## Verificação

- 22 testes focados passaram; a verificação ampliada final, que os inclui,
  passou com **192/192**, zero falhas, cancelamentos ou testes ignorados.
- TypeScript e compilação passaram. Lint terminou sem erros e com quatro avisos
  preexistentes nos arquivos verificados.
- A imagem Docker concordou com cinco hashes compilados, incluindo o entry do
  harness copiado. Fontes fixadas do OpenClaw foram verificadas pelo build.
- Publicação somente da API em **78,52s**, com preservação dos dados protegidos.
  Navegador e executor físico permaneceram nas versões anteriores; manutenção
  foi encerrada e as 44 operações históricas incertas foram preservadas.

## Aceite natural parcial

O mesmo pedido foi enviado uma vez pelo app público às **15:48:33,056 UTC**,
sem instruções de ferramenta, perguntas respondidas ou reparos do operador:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

O pedido concluiu às **15:56:28,660 UTC**, em **475,604s**, com 25 respostas
somente de Luna e zero interações. Criou três versões; as duas primeiras foram
reprovadas exclusivamente por página final quase vazia. A terceira tem duas
páginas, 54.278 bytes e SHA-256
`95dd89045fd84488985f6582cff1d24779cb18e7ea97f778668c8baffc4fde16`.
As duas páginas foram confirmadas pelo agente antes da entrega. A conversa
mostrou um card visível do arquivo, e o conteúdo foi baixado e rasterizado
independentemente. **Entrega física/autônoma aprovada neste caso.**

Persistem duas reservas. A fonte GitHub preservou 54.057 bytes, mas o agente
pediu `maxChars:10000` e não registrou recuperação da parte truncada; a atribuição
completa das afirmações sobre traduções não está comprovada. O visualizador web
usa iframe PDF: os controles mudaram 1/2 → 2/2, mas os pixels não apareceram no
headless; navegação dos controles não é prova de renderização pública.

A recarga após limpeza disponibilizou o compositor em 1.401ms, com o arquivo e
a mensagem de QA ausentes. É um caso pequeno em desktop, sem aprovação geral
para celular/históricos longos. A inicialização e os 7min55s continuam excessivos.
Cobertura integral das ferramentas, Workspace, desempenho e UX permanecem abertas.

## Limpeza e preservação

Dez registros próprios de apresentação foram retirados e um novo procedimento,
aprendido automaticamente a partir do QA, foi arquivado. Os 1.871 registros
fora da seleção e as versões dos 34 procedimentos anteriores ficaram iguais.
Todas as 13 conferências dos dados reais passaram, com 58 arquivos, três
memórias e três contas Google preservados. O navegador foi fechado e somente
seu dispositivo temporário revogado.

A imagem antiga `26ee81b1` e dois arquivos de release obsoletos foram removidos
após verificar que nenhum contêiner usava a imagem e que os arquivos tinham os
hashes registrados. Imagem atual e recuperação imediata ficaram preservadas.
Diferença de espaço livre medida: 331.718.656 bytes na VPS; mais 106.690.620
bytes de arquivos antigos removidos localmente. Nenhum volume foi tocado.
As 17 cópias privadas de evidência conferiram por SHA-256 contra a VPS.

Evidências privadas: `artifacts/harness-parity-20261009/round77-*`, manifestos de
release e recibos `harness77-*` da VPS. Credenciais não constam deste documento.
