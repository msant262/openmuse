# SOUL como instrução de fala

A captura enviada após a versão `0b0122c` mostrou que a validação anterior não
cobria a conversa real: o SOUL estava salvo e chegava ao modelo, mas a resposta
continuava burocrática. O perfil global e o efetivo da conversa eram iguais,
na revisão global 9; não havia uma preferência local substituindo a personalidade.

## Diagnóstico

O ensaio com o histórico anterior à pergunta reproduziu a confirmação seguida
de um aviso genérico. Os eventos brutos mostraram duas mensagens na mesma
inferência Responses: `commentary` e `final_answer`. O adaptador as achatava
em uma mensagem AG-UI, concatenando o último caractere de uma com o primeiro da
outra. Portanto, observar texto antes da próxima inferência, como fazia a correção
anterior, não resolvia esse caso.

O SOUL também estava serializado como dado de perfil, acompanhado de várias
regras universais de linguagem. Apenas simplificar essas regras e mudar a ordem
do prompt ainda deixou o modelo imitar avisos antigos. A confirmação usava o
histórico de pesquisa e todas as instruções operacionais para escrever uma frase.

As cópias locais consultadas do Hermes (`agent/prompt_builder.py`,
`load_soul_md`) e OpenClaw (`system-prompt-context-files.ts`) tratam o SOUL como
identidade/instrução de personalidade. Essa distinção orientou o ajuste.

## Implementação

- O SOUL aparece por inteiro como instrução de fala, em uma seção própria no fim
  do contexto. Os campos de idioma, tom, extensão e apresentação complementam a
  personalidade. A humanizer ficou menor e não prescreve uma voz universal.
- O perfil efetivo continua sendo lido a cada rodada. Uma confirmação após a
  aceitação da tarefa relê o perfil e usa somente o pedido atual, os títulos e
  estados aceitos e as instruções de voz. O histórico canônico permanece salvo.
- Resultados de tarefas com SOUL personalizado passam por uma composição de voz
  sem ferramentas, antes da revisão de pesquisa e da verificação existentes.
  Essa etapa relê o perfil; não executa trabalho nem altera permissões. Preserva
  fatos e limitações e rejeita alterações de números ou destinos de links.
  Em falha, saída vazia ou timeout, mantém o rascunho. Há uma inferência adicional
  por tentativa de entrega com personalidade personalizada, limitada a 30 segundos.
- O transporte preserva uma separação de parágrafo entre mensagens Responses
  distintas. Deltas de uma mesma mensagem continuam concatenados normalmente.

A personalidade não foi alterada na conta. Não existe identidade LGBT, apelido
ou grau de entusiasmo fixo no código; o texto salvo pelo usuário define isso.

## Validação

API publicada: `4e2f858`, aplicada sobre a API anterior `0b0122c` sem incorporar
as demais alterações de servidor existentes na branch principal.

Os testes de regressão reproduziram a junção sem espaço e o uso do histórico
antigo na composição da confirmação antes das correções. Testes adicionais
cobrem a composição do resultado e o retorno ao rascunho quando números/URLs são
alterados. Dois testes antigos precisaram acompanhar o novo contexto: a leitura
do JSON de evidências não pode presumir que ele encerra todo o prompt, e a
confirmação não deve receber fatos não verificados do resumo delegado.

O ensaio com o modelo conectado e o histórico real usou banco e credenciais
copiadas de forma isolada, sem renovar grants e sem enviar mensagens à conversa
real. Na candidata final, as duas repetições da pergunta eleitoral geraram uma
confirmação cada, sem relatório provisório ou link para o usuário pesquisar.
O mesmo pedido com SOUL formal não usou apelidos nem emojis. Uma tarefa de
redação curta foi entregue com sucesso e na voz personalizada. Os payloads
confirmam o SOUL em todas as rodadas, e zero ferramentas na composição.

Esse ensaio verifica personalidade e início da tarefa; não é uma nova validação
da apuração eleitoral. Os primeiros ensaios de redação também expuseram uma
limitação anterior do classificador de critérios: a expressão negativa
“não precisa criar arquivo” ainda pode exigir um arquivo. Essa regra não foi
alterada nesta correção. Os registros dessas tentativas foram preservados.

As evidências privadas ficam em `artifacts/soul-runtime/`: diagnóstico da
produção, reproduções anteriores, testes, payloads e `live-verification.json`.

Na árvore final passaram **1.339 testes**, sem falhas, além de 50 testes focados,
TypeScript de servidor/mobile e build da API. Biome nos arquivos alterados
terminou sem erros, com quatro avisos de non-null assertion já existentes nos
testes de provedores. O ensaio conectado final terminou com código 0.

Imagem publicada: `sha256:4cf07964b0dc0c0de38bef70614387f762a8003ae2e47cd3b7f222d3ffd61d9d`.
Skill humanizer: `00e149befceecebfe361908892937e38656cabb8b26b06210cdef4eb2a4c0da6`.


## Publicação

Fonte principal: `9736ba3`; API publicada: `4e2f858`. A troca ocorreu com zero
tarefas e conversas ativas. A manutenção foi encerrada, a pausa permaneceu
inalterada na revisão 16 e os registros retidos foram preservados. A imagem
publicada e o hash da skill correspondem aos artefatos testados. A API pública
retornou HTTP 200 e o container ficou saudável.

SOUL, revisões do perfil, modelo e avatar conservaram o mesmo digest antes e
depois: `f0e9bfb1b824e2f020869fc086ebb7cc300c7d924e3b2eff3fd26864740029ff`.
O pareamento temporário usado na verificação foi revogado. Web e APK permanecem
em `94b47bc`: esta alteração é de servidor e não exige reinstalar o aplicativo.
