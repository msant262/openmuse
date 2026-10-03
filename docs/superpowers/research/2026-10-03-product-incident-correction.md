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
