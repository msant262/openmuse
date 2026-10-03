# Correção após uso real: pesquisa, perguntas e anatomia dos avatares

O usuário rejeitou a experiência publicada em `f4eec06`: a consulta de promoções
de maquiagem na Alemanha abriu o navegador, encontrou bloqueios e repetiu
perguntas mesmo depois de o usuário responder que o resultado era suficiente.
Também relatou chifres/asas não pedidos nas novas criações e uma composição
desktop inconsistente. Esta revisão trata os três problemas conjuntamente.

## Evidência e causas

A inspeção autenticada preservou a conversa, a tarefa já cancelada, o controle
humano do desktop e o companheiro selecionado. As capturas privadas da conversa
ficam fora do repositório. A tarefa tinha quatro tentativas: resultados parciais
eram convertidos em `waiting_input`, a saída final sem `finish_task` criava outra
pergunta genérica e a retomada não reapresentava o histórico completo de
perguntas/respostas após as operações anteriores. Uma observação legível de loja
via `browser_research` também não entrava na evidência de conclusão.

Não existia `web_fetch`: a busca e as leituras públicas usavam Chromium. Agora
há um leitor HTTP com texto, links e dados estruturados de produto; a busca
pública não exige um desktop. Navegador fica disponível para conteúdo que
realmente precise de renderização ou interação. Falhas de fonte não justificam
um questionário de preferências ou uma conclusão sem evidências.

A direção de arte global dos avatares continha literalmente uma instrução para
dragões manterem chifres, asas e caudas, mesmo quando a descrição era de outra
espécie. Ela foi removida. A descrição do usuário precede a direção de arte
neutra de pelúcia; anatomia e acessórios não solicitados não devem ser
inventados. Espécies e características explicitamente pedidas continuam
permitidas. O ensaio isolado do adaptador real gerou quatro coelhos cientistas
rosas com jaleco fechado e objetos nas mãos: os quatro foram inspecionados sem
chifres ou asas. Nenhuma criação ou seleção foi gravada no perfil do usuário.

## Comportamento resultante

- Respostas anteriores são reapresentadas com a pergunta e os rótulos escolhidos.
  A mesma pergunta respondida não é recriada. Um pedido explícito de parar,
  respondido ao formulário, encerra a tarefa sem nova inferência.
- Resultados parciais permanecem disponíveis, mas não ganham sucesso fictício
  nem um formulário genérico de continuação. O relatório não é republicado a
  cada nova pergunta.
- A conversa mostra a pergunta atual e recolhe perguntas/respostas anteriores.
  O botão Parar tarefa funciona sem preencher uma resposta obrigatória.
- A composição completa do desktop e as prévias são documentadas em
  [desktop-workspace-correction](2026-10-03-desktop-workspace-correction.md).

## Verificação durante a revisão

Os testes de regressão reproduzem a falha do encerramento e do agrupamento de
perguntas. A suíte integrada de 989 testes passou antes do ensaio real de
pesquisa. Esse ensaio revelou um defeito adicional que os fixtures não cobriam:
uma página `Client Challenge` da loja foi aceita como evidência, enquanto a
busca HTTP não produziu ofertas. O resultado foi rejeitado para publicação; a
correção e um novo ensaio são necessários. O recibo inicial permanece em
`artifacts/product-correction/` para não apagar a evidência negativa.

Um segundo ensaio, desta vez no chat direto, expôs o limite antigo de seis etapas:
a resposta terminava com um pedido em inglês para dizer “continue”. A conversa
agora reserva a última rodada do orçamento para uma resposta sem ferramentas,
usando somente observações já obtidas. Tarefas em background conservam sua
política de continuação própria. Os testes exercitam a entrega final, parada
explícita, cancelamento e resposta natural antes do limite.

O primeiro processo isolado de teste excedeu o limite compartilhado do container
da API e foi encerrado. A API conservou seu processo original e respondeu ao
health check. Os ensaios seguintes usam um container separado, banco temporário
e limite próprio; somente os arquivos existentes do provedor são compartilhados
para manter o lock de renovação, sem copiar tokens ou abrir o banco da produção.

O contador de operações na manutenção também foi corrigido: recibos nativos
guardam `cleanupConfirmed` dentro de `data`. O reconhecimento exige envelope
compatível com a operação; não altera o resultado histórico `outcome_unknown`
nem dispensa recursos realmente mantidos pelo controle humano.

## Resultado da revisão e publicação

A fonte da interface foi congelada em `20c310d`; web e dois APKs foram
reconstruídos em checkout isolado e limpo. A API final usa `8171783`, incluindo
a data UTC do servidor no contexto do modelo e a orientação de excluir
promoções vencidas. Os recibos de builds, hashes públicos, inspeção visual
independente, teste Android e ensaios de pesquisa ficam em
`artifacts/product-correction/` e `artifacts/android/product-correction-release/`.

A suíte completa passou em 1.002 testes. O ajuste final da data passou em 15
testes focados e build; TypeScript e lint também passaram, com os avisos
registrados. A tarefa real isolada concluiu cinco ofertas a partir de Primor e
OTTO, sem sessões de navegador e sem perguntas. Leituras independentes
confirmaram três preços. No chat da imagem final, a consulta passou a usar
outubro de 2026 e entregou fontes e limitações sem solicitar continuação.
Esses ensaios não garantem que toda loja permitirá leitura ou que cada consulta
retornará preços de produtos; bloqueios são relatados sem virar questionários.

O upgrade no emulador preservou pareamento, avatar selecionado e rascunho. O
rascunho original foi restaurado e o emulador próprio encerrado. A inspeção web
pública abriu configurações, personalização, Feed, Ideias, Metas e Biblioteca em
desktop/móvel sem erros de página; sua sessão temporária foi revogada. Não houve
aceite em aparelho físico nem afirmação de identidade pixel a pixel com o Muse.

## Reconexão do computador durante a publicação

O reinício gracioso da API preservou a pausa desativada na revisão 16 e as duas
reservas do controle humano. Não foi feito backup com escritores parados nessa
janela. Após a desconexão, o supervisor nativo entrou em quarentena; os logs
existentes não identificam qual etapa de contenção inicial falhou. Portanto, a
causa desse problema de reconexão permanece indeterminada nesta revisão.

A recuperação reiniciou somente `okami-executor@lenovo-okami`, pelo fluxo normal
de reconciliação. O epoch avançou de 17 para 18; sessão gráfica, broker, Xvnc e
Xfce conservaram seus PIDs, assim como o ID/geração da sessão e o controle humano
na revisão 6. As 233 operações do journal conservaram status, sequência e hash
dos recibos. Não houve reset, descongelamento manual, alteração de banco ou
repetição de efeitos. A API voltou a informar computador pronto e conectado.
Provas: `native-recovery.json` e `state-preservation.json` no diretório de
artefatos desta revisão. O avatar escolhido permaneceu selecionado.
