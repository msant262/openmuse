# Recuperação de duração na pesquisa — 11/10/2026

## Falha observada

O pedido normal de três cursos gratuitos e um PDF comparando conteúdo, idioma,
duração e custo do certificado terminou em 354,928 segundos. O segundo PDF
deixou a duração do módulo Microsoft como não publicada. A execução usou Luna,
sem orientações ou respostas humanas. O aceite físico do PDF não comprovou a
pesquisa completa.

A fonte oficial contradiz essa conclusão: o
[módulo Introduction to generative AI and agents](https://learn.microsoft.com/en-us/training/modules/fundamentals-generative-ai/)
preenche **37 minutos** depois da inicialização do cliente. A página HTTP
contém `module-duration-minutes` vazio e unidades com apenas `min`. O cliente
consulta `/api/hierarchy/modules/learn.wwl.fundamentals-generative-ai?locale=en-us`
e preenche as durações de sete unidades: 1, 5, 5, 5, 15, 5 e 1 minuto.
Esses valores foram observados na fonte, não acrescentados ao produto.

## Causa e alteração

Três reproduções falharam antes da correção:

1. HTTP certificava os campos numéricos vazios como conteúdo legível completo.
2. A recuperação da extração não reconhecia os rótulos de unidade sem números;
   a presença de um spill completo também impedia o resgate pelo navegador.
3. O leitor DOM podia retornar antes do preenchimento, sem `aria-busy`, classe
   genérica de loading ou uma requisição pendente naquele instante.

O leitor agora marca duração pendente quando há slots visíveis de duração vazios
ou rótulos de unidade sem número. A extração em lote usa seu resgate existente
para recuperar esses campos, inclusive quando a representação incompleta foi
preservada integralmente. O leitor DOM aguarda o preenchimento desses slots.
Campos já preenchidos permanecem no caminho HTTP. Não há duração, URL ou domínio
de curso codificado na implementação, nem nova chamada de avaliação ao modelo.

## Verificação e limites

- **53/53 testes** dos leitores passaram. O grupo inclui as três reproduções,
  um controle de duração preenchida, FAQ, spill, cancelamento e destinos privados.
- TypeScript do projeto e do worker passaram; build do servidor, assets e harness
  passaram. Lint sem erros, com cinco avisos existentes e duas informações.
- O leitor completo corrigido recuperou os **37 minutos na fonte pública real em
  2.495 ms**, com procedência de navegador e o endpoint de dados observado.
- A suíte completa está em execução. A correção ainda não foi publicada e o
  pedido natural completo ainda não foi repetido nesta rodada.

A recuperação de uma fonte não aprova todo o harness, a escolha dos demais
cursos, os outros campos, a velocidade de entrega, todas as ferramentas ou a
integração completa do Google Workspace. Não se altera manualmente o resultado
da tarefa antiga para fazê-la passar.

Evidência privada local: `artifacts/harness-parity-20261009/round76-duration-red.log`,
`round76-reader-green.log`, `round76-live-duration-proof.json`,
`round76-typecheck.log`, `round76-worker-typecheck.log` e `round76-full-suite.log`.
