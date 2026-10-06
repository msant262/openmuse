# Visualização legível dos recibos de etapas

Publicado em 6 de outubro de 2026. Complementa a recuperação dos detalhes de
etapas registrada em `2026-10-06-step-details-memory-recovery.md`.

As etapas deixaram de apresentar argumentos e recibos como JSON aberto. O app
interpreta os valores registrados e apresenta buscas com consulta e cartões de
fontes, páginas com conteúdo Markdown, imagens com prévia e arquivo acessível,
e entregas com as verificações efetivamente registradas. Erros, resultados
parciais e trabalho restante continuam visíveis. Identificadores e metadados
ficam no botão “Detalhes técnicos (JSON)”, recolhido inicialmente e ao trocar de
operação. O conteúdo original permanece disponível nesse botão.

Registros JSON armazenados como texto são decodificados; valores desconhecidos
usam apresentação recursiva de campos, preservando zero e falso. Links de fontes
aceitam HTTP(S) sem credenciais. Arquivos usam os dados da própria tarefa;
nenhuma imagem é regenerada para exibir o histórico.

## Validação

- 156 testes do app passaram, incluindo os cinco casos novos de apresentação
  e expansão explícita do JSON. Dois testes de vínculos e detalhes da API passaram.
- Tipos do app, lint dos arquivos alterados e export web passaram.
- No domínio público, a tarefa original do Gemini confirmou cinco cartões de
  fontes, Markdown da página, modelo `gpt-image-2`, imagem carregada e abertura
  do arquivo, verificação da entrega e JSON recolhido ao trocar de etapa.
- HTML e bundle coincidiram por SHA-256 na origem tailnet e no domínio público.

## Distribuição

- Implementação em main: `bbb8bb69bdb7a3aff9c826bcaea30b987806c1f6`.
- Web: `/opt/okami-web/releases/step-viewer-20261006-bbb8bb69`.
- Bundle: `_expo/static/js/web/index-735c4fdfefb1abbea85f7ef4b6485eda.js`.
- HTML SHA-256: `ad73727aa161dfa8f665ae1a6ea2baa637b1fbac213feaeb7ebe1fd3dac2ae45`.

Somente o destino web `/` mudou. API, executor e downloads permaneceram iguais;
não houve publicação de APK. Não se afirma execução integral dos testes do
repositório nem alteração no comportamento de execução do harness.

Logs, manifestos e recibo de publicação ficam no diretório privado
`artifacts/step-viewer-20261006/` e no diretório correspondente do operador no VPS.
