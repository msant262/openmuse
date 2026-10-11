# Contexto duplicado dos resultados de busca — 11/10/2026

O último pedido comum de pesquisa/PDF levou cerca de 9min35s, com 26 respostas
de Luna e 2.711.885 tokens reportados pelo provedor. A inspeção da própria
sessão encontrou resultados de busca repetidos no contexto: o lote incluía
os mesmos objetos tanto na lista agregada quanto nas listas de cada consulta.
Essa duplicação é uma causa comprovada de desperdício, mas não explica sozinha
todo o consumo, as quatro versões do PDF ou a demora da tarefa.

A implementação `b5043529` mantém uma tabela de fontes e índices por consulta
somente na representação enviada ao modelo. A tabela conserva a ordem
original das fontes; cada consulta conserva sua ordem, erros e metadados.
Objetos distintos, inclusive snippets diferentes da mesma URL, continuam
distintos. O recibo canônico, eventos e apresentação permanecem completos.
O ajuste não reduz a capacidade de contexto e não adiciona chamadas de modelo.

Os quatro recibos reais do próprio QA foram reproduzidos localmente:

| Resultado de busca | Antes (bytes UTF-8) | Depois (bytes UTF-8) |
| --- | ---: | ---: |
| Primeiro lote | 76.040 | 39.898 |
| Segundo lote | 28.751 | 14.525 |
| Terceiro lote | 41.446 | 21.920 |
| Quarto lote | 18.106 | 9.856 |
| Total | **164.343** | **86.199** |

São **47,6% menos bytes nesses resultados**. Todas as listas por consulta
foram reconstruídas e comparadas integralmente com os originais; os recibos
originais permaneceram iguais. Não houve chamada de modelo nessa reprodução.
Isso não mede redução de tokens da requisição inteira nem do tempo de uma
nova tarefa comum.

Duas reproduções falharam antes da correção e passaram depois. A verificação
final passou em **42/42 testes relacionados**, sem falhas, cancelamentos ou
casos ignorados. Inclui executor copiado real, chamada seguinte ao provedor,
recibos canônicos/eventos preservados, erros parciais, proveniência e snippets
alternativos. O caso existente de contexto de um milhão de tokens permanece
aprovado. TypeScript e build passaram; lint sem erros, com um aviso preexistente.
Os grupos intermediários sobrepostos não foram somados aos 42 testes.

Evidências privadas: `artifacts/harness-parity-20261009/round86-*.log`,
`round86-actual-search-projection.json` e os metadados de tamanho/uso da própria
sessão. A inspeção terminou com inspector fechado e hooks removidos.

A entrega integral permanece pendente: falta medir um novo pedido comum,
resolver o retrabalho factual e cosmético observado, implementar contratos
ausentes como `browser_exec` do Hermes e aprovar Workspace completo, memória,
proatividade, desempenho sustentado e celular. Executar Python genérico não
equivale ao contrato de navegador com sessões e helpers.

## Publicação e preservação

A API foi publicada em `b5043529`, imagem `780569c1`, em 24.34s.
Onze hashes compilados conferiram com a release; as 13 comparações de
preservação passaram. Às 21:09 UTC, página/API públicas HTTP 200, três
containers saudáveis e manutenção desligada. As seis contagens de execução
estavam em zero; as 44 operações históricas incertas foram mantidas.

Retirada exclusivamente a imagem antiga `82543a0a`, seu contexto e archive,
após inventário de 11.929 arquivos e comparação com o tar. A VPS ganhou
1,621,135,360 bytes (~1.51 GiB) nessa etapa. O archive local
correspondente de 53,493,193 bytes também foi retirado com
SHA-256 conferido. API atual e recuperação imediata, navegador, OpenBao,
APK, volumes, perfis e dados reais preservados. Nenhum novo pedido de QA
ou novo APK foi criado nesta etapa.

Dez evidências da VPS copiadas com hashes remoto/local conferidos, em
diretório 0700 e arquivos 0600, fora do Git. A saúde é uma amostra pontual;
a redução de bytes não comprova rapidez ou estabilidade sustentada.
