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
- A primeira suíte completa terminou: **2.112 testes, 2.108 passaram e quatro
  falharam**. São os quatro controles descritos abaixo e corrigidos nas
  repetições específicas. Uma passagem final está em execução. A correção ainda
  não foi publicada e o
  pedido natural completo ainda não foi repetido nesta rodada.

## Falhas adicionais reveladas pela suíte completa

Os controles `a confirmed computer start completes its journal and permits the
next authorized command` e `premature program delivery continues to actual
execution without a user answer` falharam também quando executados isoladamente.
O diagnóstico confirmou início bem-sucedido e rejeição do comando: a função
`remainingRuntimeMs` existe no contexto mesmo quando não há prazo configurado.
O adaptador testava a existência da função e inseria um timeout de 30 minutos
em comandos cujo backend isolado usa seu próprio padrão. O backend rejeitava o
argumento antes de executar e a tarefa pausava por resultado incerto.

O adaptador agora só vincula o timeout físico quando a função retorna um prazo
real. Sem prazo, preserva os argumentos e o padrão do backend. **16/16 controles**
de computador e prazo passaram depois da correção, incluindo as duas reproduções.
Limites configurados e interrupção de processos continuam verificados.

Dois controles do seletor de idioma não chegavam ao componente: a fixture
ignorava o novo import `thread-selection`. Ela agora fornece o módulo real.
**2/2 passaram**; isso não é apresentado como uma correção de produto nem como
um bug de idioma comprovado. A primeira passagem da suíte ampla conserva essas
quatro falhas no log; ainda não há aprovação integral da suíte.

Evidências adicionais: `round76-computer-reproduction.log`,
`round76-computer-diagnostic.log`, `round76-computer-green.log`,
`round76-language-reproduction.log` e `round76-language-green.log`.

A recuperação de uma fonte não aprova todo o harness, a escolha dos demais
cursos, os outros campos, a velocidade de entrega, todas as ferramentas ou a
integração completa do Google Workspace. Não se altera manualmente o resultado
da tarefa antiga para fazê-la passar.

Evidência privada local: `artifacts/harness-parity-20261009/round76-duration-red.log`,
`round76-reader-green.log`, `round76-live-duration-proof.json`,
`round76-typecheck.log`, `round76-worker-typecheck.log` e `round76-full-suite.log`.

## Reprodutibilidade do build

A conferência da imagem final foi interrompida pelo hash diferente do entry do
harness. A inspeção das dependências isolou uma diferença de emissão de campos
de classe: o `RetrySupervisor` foi compilado com semântica de definição de
campos, embora o tsconfig original fixado declare
`useDefineForClassFields: false`. Uma nova compilação local, sem mudança de
fontes, voltou ao hash da imagem Docker. Isso comprova a instabilidade da
configuração inferida; a origem interna da ordem de resolução do esbuild não
foi demonstrada.

O build agora fornece explicitamente o tsconfig original copiado. Duas
compilações consecutivas produziram o mesmo entry
`8ebff11d8aed76102cb81caa722f2036152ba5f59ce8550f84dac14c2906ba46`.
O código e os hashes de origem fixados do OpenClaw permanecem intactos.
Os controles do harness/orçamento passaram; a comparação exata com uma nova
imagem Docker e a aprovação natural ainda faltam. O build rejeitado não foi
publicado nem teve seu manifesto alterado para forçar a aprovação.
