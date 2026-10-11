# Base de scripts do navegador e transporte pendente — 11/10/2026

Implementação na main: **`a404b96d905309676e69074c84da5dab98c06e66`**.
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

**152/152 testes do executor e 36/36 testes de protocolo/integração passaram**,
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
reais no navegador, Google, disponibilidade da ferramenta para Luna ou
conclusão de uma tarefa comum por `browser_exec`.

## Limite indevido reproduzido antes da publicação

O helper original `fill_input` envia eventos de tecla para cada caractere.
Na adaptação atual, cada evento vira uma chamada ao host e consome a quota
geral de ferramentas Python. Preencher **120 caracteres**, com um receptor
controlado, atingiu **200 chamadas** e falhou com:

> RuntimeError: Python tool call budget reached for this cell

O processo foi encerrado corretamente. O receptor era uma fixture; não foi
medida latência de produção e não houve preenchimento de página real.
O recibo está em `round87-browser-granularity-proof.json`.

Além da quota, a leitura de `NativePythonJobs._rpc` mostra que a versão
atual publica e aguarda uma resposta via API para cada comando. Isso não
é o transporte local do daemon original. Projetar a latência desse caminho
sem medição seria incorreto, mas a quantidade de viagens e recibos é real.

**Essa adaptação não deve ser anunciada como o contrato completo.** A próxima
implementação precisa executar comandos CDP dentro do broker local do
computador, com sessão, prazo e controle vinculados ao programa. A API deve
continuar responsável pelas ferramentas externas e aprovações, sem tratar
cada tecla como uma nova ferramenta do modelo. O orçamento de ferramentas
externas não pode limitar comandos internos de um helper.

## Restante necessário para `browser_exec`

1. Transporte local com os comandos/meta do SDK, sem o teto indevido de
   comandos internos, mantendo memória e saída limitadas pelo programa.
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
Às **21:40:55 UTC**, página/API responderam HTTP 200 e os três containers
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
