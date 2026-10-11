# Base de scripts, comandos locais e integração pendente — 11/10/2026

Base copiada na main: **`a404b96d905309676e69074c84da5dab98c06e66`**.
Transporte interno adicional: **`fa3ef6cffa0921a9c23b41bab4aff8b273d07376`**.
Composição com autoridade do desktop e broker: **`189dce56a60d7d6e11ab121b5972088057d821dd`**.
Driver CDP/meta com helpers reais: **`1fc7cb6b`**.
Iframes separados por conversa, incluindo OOP: **`7d044174`**.
Não publicada na API ou no executor físico. **`browser_exec` continua sem
registro no catálogo; seu contrato completo permanece pendente.**

O contrato do Hermes foi lido no commit
`e0550c97bbd916cd5ff8fa0450e6291c31921b94`: cada chamada usa um processo
Python novo, enquanto navegador, sessão nomeada e workspace permanecem.
A execução Python anterior retinha o processo.

## Implementação e fonte copiada

- O modo `fresh` cria um processo por chamada e confirma o encerramento da
  unidade e dos descendentes antes de devolver sucesso. Variáveis, módulos,
  ambiente e alterações em builtins não passam para a próxima chamada.
  Arquivos permanecem no workspace.
- Falha de encerramento mantém a incerteza e impede substituição/repetição.
  Callback pendente, pausa, cancelamento e tarefa retomada preservam os
  recibos originais e sua autoridade.
- Protocolo nativo v3 transporta o ciclo de vida, sessão dos helpers e prazo
  de até 1.800 segundos, conforme o contrato original. Versões anteriores
  não recebem parâmetros que ignorariam; a recusa ocorre antes do envio.
- Foram copiados **sem alteração** `helpers.py`, `paths.py`, `recorder.py`,
  `__init__.py` e a licença MIT de Browser Harness, commit
  `dbf0e4f3a37ebc31aaeaf9d378ab1760b5776c15`. O manifesto
  `apps/computer/executor/vendor/browser_harness/UPSTREAM.json` registra
  cada SHA-256 e sua origem. Os cinco hashes foram conferidos.
- O adaptador substitui somente o transporte IPC e pré-carrega os helpers
  na captura do executor Hermes copiado. O código do script, números de
  linha e `from __future__` permanecem intactos. `agent_helpers.py` do
  workspace é carregado, conforme a biblioteca original.
- Sessões diferentes da vinculada ao script são recusadas no executor,
  na entrega privada e na autoridade canônica da API, antes do efeito.
  O processo Python não recebe token do servidor ou porta CDP.

## Verificação e limites

Na base `a404b96d`, **152/152 testes do executor e 36/36 testes de protocolo/integração passaram**,
com zero falhas, cancelamentos ou casos ignorados nos conjuntos finais.
TypeScript, build do servidor/harness, lint e `git diff --check` passaram.
Os grupos focados anteriores estão contidos nesses conjuntos e não são
somados novamente.

As reproduções anteriores à implementação falharam por ausência do ciclo
novo, bootstrap, campo de sessão e recusa de desvio de sessão. Também foram
detectados e corrigidos controles da API que ainda aceitavam apenas v1/v2.
Uma verificação de cópia do inicializador parou antes de escrever por
diferença de newline; a cópia foi refeita contra os bytes do commit Git e
os conjuntos finais passaram depois de completar o pacote.

Há subprocessos e transporte reais nesses testes: arquivo gravado no
workspace, chamada ao host sob o TaskJournal, resposta privada e confirmação
de zero processos vivos antes de encerrar o peer de teste. **As respostas do
backend do navegador nesses casos são fixtures.** Não há prova de efeitos
reais no navegador na rodada 87, Google, disponibilidade da ferramenta para Luna ou
conclusão de uma tarefa comum por `browser_exec`.

## Limite indevido reproduzido antes da publicação

O helper original `fill_input` envia eventos de tecla para cada caractere.
Na adaptação `a404b96d`, cada evento vira uma chamada ao host e consome a quota
geral de ferramentas Python. Preencher **120 caracteres**, com um receptor
controlado, atingiu **200 chamadas** e falhou com:

> RuntimeError: Python tool call budget reached for this cell

O processo foi encerrado corretamente. O receptor era uma fixture; não foi
medida latência de produção e não houve preenchimento de página real.
O recibo está em `round87-browser-granularity-proof.json`.

Além da quota, a leitura de `NativePythonJobs._rpc` mostra que a versão
usada naquela rodada publica e aguarda uma resposta via API para cada comando. Isso não
é o transporte local do daemon original. Projetar a latência desse caminho
sem medição seria incorreto, mas a quantidade de viagens e recibos é real.

**Essa adaptação não deve ser anunciada como o contrato completo.** A
integração precisa executar comandos CDP dentro do broker local do
computador, com sessão, prazo e controle vinculados ao programa. A API deve
continuar responsável pelas ferramentas externas e aprovações, sem tratar
cada tecla como uma nova ferramenta do modelo. O orçamento de ferramentas
externas não pode limitar comandos internos de um helper.

## Comandos locais implementados e digitando no Chromium — rodada 88

`PythonKernels` e `NativePythonJobs` agora aceitam um receptor local fornecido
pelo host. Quando esse receptor está configurado, `browser_harness_rpc` executa
nele, sem publicar `pythonRpc`, aguardar resposta da API ou consumir a quota
de ferramentas externas. O programa conserva apenas totais dos comandos,
sem guardar um histórico crescente de texto digitado, argumentos ou imagens.
O teste de transporte confirmou somente dois recibos: início e resultado.

Sessão vinculada, validação do comando, prazo e encerramento continuam no
host. Uma sessão estrangeira é recusada antes do receptor. Um comando pendente
após cancelamento impede substituir a execução. Exceção de transporte após
possível efeito mantém `outcome_unknown`, inclusive se o script captura o erro
e termina normalmente. Rejeição conhecida antes do receptor não cria falsa
incerteza. Limites e recibos das ferramentas externas permanecem separados.

No teste adicional, o receptor falou com **Chromium real via CDP pipe**, em
contexto isolado de QA. O helper original preencheu uma textarea e o valor foi
relido do DOM, comparado byte a byte e por SHA-256. Foram observados eventos
`input`/`change`, sem simular o valor final:

| Texto | Comandos internos | Tempo final medido | Chamadas à API para comandos |
| --- | --- | --- | --- |
| 120 caracteres | 370 | 0,409s | 0 |
| 1.200 caracteres | 3.610 | 2,565s | 0 |

O teste usou quota de **uma** ferramenta externa e consumiu zero. As duas
unidades Python e o navegador de QA foram encerrados. A configuração desse
Chromium é exclusiva do teste; **não comprova sandbox, autorização ou controle
do broker nativo publicado**. Não houve login nem trabalho no app de usuários.
Os tempos não são medições de uma tarefa com Luna ou de latência de produção.

Verificação final de `fa3ef6cf`: **159/159 testes do executor e 37/37 testes
de protocolo/integração**, TypeScript, build do servidor/harness, Biome e
`git diff --check` passaram. Os novos testes foram reproduzidos falhando antes
das correções; esses conjuntos substituem, sem somar, os conjuntos sobrepostos.

Na rodada 88, o Supervisor ainda não fornecia esse receptor ao broker. A
rodada 89 fez essa composição, descrita abaixo. O worker de navegador ainda
não implementa o protocolo completo; a ferramenta continua sem registro.
O caminho antigo via API permanece onde nenhum receptor local foi configurado
e não deve servir à nova ferramenta.

## Autoridade do desktop e composição privada — rodada 89

A API agora deriva `browserAuthority` da sessão e do controle registrados,
com reservas exclusivas tanto do desktop quanto do perfil. O script não
seleciona esses identificadores ou seus fences. A operação preserva sua
identidade Python e recebe a autorização adicional no envelope canônico.
O vínculo é persistido e revalidado antes do envio. Perfil forjado, reserva
ausente, controle humano ou revisão alterada impedem o envio.

O Supervisor passa o receptor local a `NativePythonJobs`. O cliente envia
o **mesmo envelope** e o comando pelo socket privado; o broker exige peer
root, identidade Python válida, sessão/generation/perfil correspondentes,
revisão de controle e fences do desktop/perfil. Checa novamente depois do
retorno. Usa a renovação existente do watchdog, sem nova viagem à API ou
atualização de gate por tecla. O início de um programa atualiza o permit uma
vez. Nenhum token do broker é entregue ao interpretador.

O worker atual **não declara `browserScriptVersion: 1`**. O encaminhamento
recusa esse backend antes de mandar o comando, com
`BROWSER_SCRIPT_UNAVAILABLE`, em vez de simular execução. Portanto,
**essa composição não torna `browser_exec` disponível**. Falta implementar
CDP/meta, abas persistentes e pertencentes à sessão, eventos, iframes,
uploads, screenshots com proteção e efeitos com aprovação no worker.

Passaram **159 testes do executor, 32 do desktop, 42 de Python/API e 22 dos
fluxos gráficos**, além de TypeScript, build do servidor/harness, Biome e
`git diff --check`. Os cinco novos casos de autoridade falharam antes da
implementação. As verificações do receptor nativo usam um backend controlado;
não comprovam execução do SDK no worker nem teste comum com Luna. A medição
com Chromium real da rodada 88 permanece identificada separadamente.

## Restante necessário para `browser_exec`

Na rodada 90 foi implementado `apps/worker/src/browser-harness-driver.ts`,
ainda sem conexão a `createBrowserManager` ou ao handler do worker nativo.
Ele usa o **pipe CDP existente**, com sessões opacas e alvos separados por
proprietário, conversa e nome. Implementa navegação, execução CDP na página,
meta de sessão, criação/seleção/fechamento de abas, eventos limitados e captura
através de um hook obrigatório para imagem protegida. Hooks do host para
controle, autorização e redaction também são obrigatórios.

**8/8 novos testes passaram**, incluindo uma execução Python real com os
helpers copiados: digitação de 120 caracteres, segunda aba, retorno à primeira
e PNG com assinatura/bytes conferidos. Esse programa levou **1,350s** no
conjunto final; é uma medida de QA local sem modelo, não de produção.
Verificados isolamento de alvos/sessões/eventos, retomada dos eventos de rede
ao voltar para a aba, criação depois de fechar a aba atual e timeout sem replay.
TypeScript, build e Biome passaram. Os testes do host usam funções controladas
de autorização; isso **não comprova as aprovações e a proteção publicadas**.

O driver daquela rodada ainda não cobria iframes nem uploads, e seus hooks precisam ser
integrados às políticas existentes. `browserScriptVersion: 1` continua ausente,
`browser_exec` continua sem registro e não houve publicação ou chat natural
por esse caminho. Evidências: `round90-driver-final-tests.log`,
`round90-typecheck-final2.log`, `round90-biome-final2.log` e os testes com
proveniência explícita no repositório. A falha inicial de importação de tipos
foi corrigida antes da verificação final.

Na rodada 91, a descoberta de iframe foi implementada e verificada em
**Chromium real com os helpers Python originais**. O primeiro teste real
falhou: `Page.getFrameTree` omitia o iframe de outro processo. A observação
CDP confirmou `parentId`/`parentFrameId`, e a implementação passou a resolver
a cadeia de parentesco a partir das páginas pertencentes à conversa,
incluindo iframe aninhado. Alvo estrangeiro permanece recusado. O comando
`Target.closeTarget` de iframe não fecha inadvertidamente sua página pai.

Passaram **10/10 testes do driver e helpers**, com leitura real de conteúdo
de iframe de outra origem, além da digitação, abas, PNG, isolamento e timeout
anteriores. No conjunto final, esse programa completo levou **1,645s**.
TypeScript, build e Biome passaram. São tempos de teste local sem modelo;
os hooks de autorização continuam controlados no teste. **Manager, handler
nativo, uploads, políticas completas, publicação e teste comum com Luna
continuam pendentes.** Não foi declarado `browserScriptVersion: 1`.

Evidências da rodada: `round91-owned-iframe-red.log`,
`round91-oop-ancestry-red.log`, `round91-real-iframe-helper.log`,
`round91-real-iframe-diagnostic.json`, `round91-iframe-tests-clean.log`,
`round91-typecheck.log` e `round91-biome-final.log`.

1. Integrar o driver CDP/meta ao worker e concluir seu protocolo, recebendo o
   envelope canônico pela composição privada já criada. Autoridade Python, desktop,
   geração, perfil, controle e fences devem continuar válidos por comando.
2. Sessões e abas persistentes, isoladas pela tarefa/proprietário, incluindo
   iframes, eventos, espera, upload e captura de imagem.
3. Controle humano, navegação/egress, redaction e efeitos com aprovação no
   broker. Comandos arbitrários não podem contornar a aprovação de exclusão.
4. Seleção/disponibilidade da ferramenta baseada no backend real conectado.
5. Atualização do executor e publicação, teste comum pelo chat e conferência
   dos efeitos reais e de desempenho. A base não encerra o aceite integral.

Produção permaneceu em `b5043529`. A prévia T3 informou bloqueio de AppArmor;
o fluxo Playwright existente abriu a mesma URL publicada, conferiu pixels
da tela pública de entrada e encerrou seu contexto. Não houve login,
mensagem de usuário, nova tarefa/arquivo no app ou alteração nos dados reais.
Às **22:24:09 UTC**, página/API responderam HTTP 200 e os três containers
continuavam saudáveis, nas mesmas imagens.

## Resíduo local de QA recolhido

A conferência de processos encontrou um helper `browser.cjs` aberto desde
09:30, com seis filhos Chromium, no computador de desenvolvimento. Foram
encerrados os **sete processos próprios de QA** depois de conferir comando,
workspace e parentesco. O RSS somado observado era 1.645.789.184 bytes; esse
valor contém páginas compartilhadas e **não é uma medida de RAM física
liberada**, nem de consumo do celular ou da VPS.

SIGTERM encerrou o navegador, mas o Node permanecia aguardando readline.
O helper local de QA foi corrigido para fechar a entrada e sair ao receber
SIGTERM/SIGINT. Nova execução real, mantendo stdin aberto, encerrou em
**0,064s**, com exit code zero. A conferência final não encontrou processos
desse helper ou do runner Python. Isso corrige o fluxo local de testes;
não é uma correção publicada do harness do produto.

Evidências fora do Git: `artifacts/harness-parity-20261009/round87-*.log`,
`round87-browser-granularity-proof.json` e `round87-public-entry.png`.
Recibos de limpeza: `round87-old-local-browser-cleanup.json` e
`round87-browser-helper-shutdown.json`.
Rodada 88: `round88-browser-local-proof-final.json` registra hashes do código
medido, dos valores e encerramento; `round88-executor-suite-final.log`,
`round88-python-api-suite.log`, `round88-typecheck.log`, `round88-biome.log`
e `round88-source.patch` preservam a verificação. O erro inicial da prévia e o
preflight de QA sem `--enable-automation` foram identificados; a flag foi
corrigida no teste antes da medição final, sem mudar configuração de produção.
Rodada 89: logs `round89-native-executor-suite.log`,
`round89-native-desktop-suite.log`, `round89-python-api-suite.log`,
`round89-graphical-api-suite.log`, `round89-typecheck-final.log`,
`round89-biome-final.log`; as reproduções ficam em `round89-*-red-final.log`.
