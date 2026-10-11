# Busca de campos em fontes preservadas — 11/10/2026

## Evidência e alcance

O último pedido normal entregou o PDF sem intervenção, mas levou 605,348s,
com 38 respostas de Luna, 32 operações principais e 12 recibos de primitivas.
Dois intervalos entre uma revisão reprovada e o próximo rascunho foram
159,968s e 148,836s. São tempos entre criação de operações, **não** medições
isoladas de provedor ou ferramenta.

O trace registra chamadas separadas de `read_web_source` para idioma,
duração e outra expressão, sobre bytes já preservados. Essa ferramenta
só oferecia uma consulta literal por chamada e a primeira ocorrência.
Um índice ou menção inicial podia ocultar as seções seguintes. Também houve
rejeições inconsistentes da política institucional da IBM: isso continua
pendente e não é resolvido por ampliar a busca de texto.

## Correção

`read_web_source` agora oferece `queries` para vários campos ou termos
alternativos, com várias ocorrências por termo. A busca lê os bytes da fonte
uma vez, preserva URL, horário, proprietário e SHA-256, e retorna trechos
literais com seus offsets. Trechos sobrepostos são reunidos no texto
apresentado ao executor. Não faz novo fetch, abre navegador ou cria anexo.

O orçamento `limit` vale para o texto combinado, incluindo separadores.
Ocorrências omitidas têm continuação por termo; se a frase não couber no
trecho, o resultado mantém `found: true` e um offset de recuperação, sem
apresentar uma frase cortada como prova. Um termo não encontrado só prova
a ausência daquela expressão literal. Trechos não equivalem à leitura
integral ou à ausência de um fato. A consulta única e a leitura sequencial
existentes mantêm seus contratos.

É uma capacidade do mesmo executor, disponível pela descoberta nativa de
ferramentas. Não adiciona modelo, revisor independente ou etapa obrigatória.
A escolha de usá-la permanece com o agente.

## Verificação

As duas reproduções iniciais falharam antes da mudança por ausência dos
resultados de lote. A cobertura inclui múltiplos campos, ocorrências além
do índice, continuação, orçamento combinado, frases literais, isolamento
entre proprietários e uma só leitura física dos bytes.

O worker real foi verificado com o executor OpenClaw copiado: o esquema de
busca em lote aparece na requisição à inferência; a referência curta da
fonte é resolvida e o recibo registra os matches reais, sem outro fetch.
Esse teste usa um provedor de fixture para controlar chamadas de protocolo;
**não comprova a escolha autônoma do modelo nem rapidez em produção**.

Erros encontrados na preparação/verificação: execução inicial usou strip
sem o loader TS necessário; os novos fixtures de fonte precisaram de IDs
de operação válidos; o observador do esquema não reconhecia o tipo opcional
`array/null`; TypeScript apontou a compatibilidade do campo `found` da
resposta antiga. Esses pontos foram corrigidos, sem converter resultados
negativos em aprovação. Uma reprodução adicional mostrou corte da frase
encontrada pelo contexto anterior; o limite agora reserva a frase inteira.

**44/44 testes relacionados passaram**, com zero falhas, cancelamentos ou
ignorados, em 34.437,329ms. TypeScript e o build completo passaram; o lint
dos dois arquivos passou sem erros ou avisos após os ajustes. Os testes
incluem leitura das fontes, recuperação, contexto e revisão do executor e
fetch público; grupos anteriores sobrepostos não são somados.

## Publicação e pedido comum

A API com esta capacidade foi publicada em `f4a6a7b1`, imagem `26046b39`.
Sete hashes compilados conferiram; 13 comparações de preservação passaram.
A publicação levou 24,15s e a API pública respondeu HTTP 200.

O pedido comum foi enviado uma vez pelo chat público, em conversa nova,
sem citar ferramentas ou orientar o agente. Luna concluiu sozinho com
15 respostas, um PDF de 48.821 bytes e duas páginas. Tempo: **239,159s**
da criação da tarefa até o resultado; **245,274s** desde o envio observado
no navegador. Zero perguntas, respostas ou direções do operador. A rodada
anterior levou 605,348s desde a criação, mas escolheu outros cursos e criou
três versões; a diferença observada não isola o efeito desta correção.

A chamada em lote recuperou a seção do curso IBM pelo nome, com seus
idiomas e três horas. Uma tentativa anterior foi recusada por combinar
`query` com `queries`; o agente corrigiu sozinho. Esse erro desnecessário
motivou o ajuste de compatibilidade abaixo.

Bytes, SHA-256, páginas renderizadas no leitor público e cinco links foram
conferidos. Capturas de elemento inicialmente ficaram cortadas pelo
contêiner de rolagem; a conferência das páginas completas usou os pixels
do canvas PDF nomeado. Um seletor genérico também encontrou um canvas
auxiliar do PDF.js e foi corrigido. Esses erros do observador não foram
tratados como prova de defeito no PDF. Celular físico não foi testado.

**Entrega física e autonomia aprovadas neste caso; aceite integral ainda
reprovado.** A revisão nativa aprovou o arquivo, mas idioma/preço do badge
Google e duração total Microsoft continuaram sem confirmação; o repositório
Microsoft ligado pela fonte não foi lido. A verificação externa ao agente
não toma o status `passed` como comprovação factual.

Seis registros próprios do QA foram recolhidos, mantendo 1.923 registros
fora da seleção iguais, 58 arquivos reais e duas conversas protegidos.
Recibos canônicos preservados; nenhum procedimento novo precisou ser
arquivado. Inspector fechado, hooks removidos, navegador encerrado e seu
dispositivo temporário revogado.

## Compatibilidade de consultas redundantes — ajuste seguinte

O trace real demonstrou uma chamada com o mesmo termo em `query` e
`queries`. Recusá-la não ajuda a busca. Quando ambos são enviados, a leitura
agora combina os termos distintos, mantendo também um termo adicional que
exista só em `query`. O orçamento combinado, offsets, origem e isolamento
do proprietário continuam valendo. A consulta única mantém seu resultado.

Duas reproduções falharam antes da correção, inclusive com o executor nativo.
**44/44 testes relacionados passaram** depois, sem falhas, cancelamentos ou
ignorados, em 34.754,715ms. TypeScript, build e lint passaram. Esse ajuste
seguinte foi publicado em `5206bbec`, imagem `82543a0a`, em 25,27s,
com sete hashes compilados e 13 comparações de preservação conferidos.
Não foi exercitado em outro pedido normal após essa publicação; o protocolo
nativo com ambos os parâmetros foi verificado nos testes controlados.

Logs privados em `artifacts/harness-parity-20261009/`:
`round83-source-batch-red.log`, `round83-match-boundary-red.log`,
`round83-source-native-final.log`, `round83-typecheck-final.log` e
`round83-biome.log`. Fonte e trace privados não entram no Git.
