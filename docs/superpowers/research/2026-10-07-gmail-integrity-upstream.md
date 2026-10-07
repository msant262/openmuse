# Organização do Gmail e comparação com o upstream

## Incidente observado

As duas contas conectadas tinham `gmail.modify`, `gmail.send`, Agenda e Drive autorizados. A tarefa real “Começar organização do Gmail” arquivou 11 mensagens de uma amostra da caixa de entrada, sem percorrer a seleção completa. A tarefa posterior “Separar promoções do Gmail” criou o rótulo “Promoções”, encontrou uma página com 500 mensagens e paginação restante, mas não aplicou o rótulo. Houve timeouts de leitura e tentativas de recuperar saídas usando `operationId` em lugar do identificador de chamada. O modelo fez buscas irrelevantes e encerrou como entrega parcial.

O verificador não reconhecia a organização/limpeza como uma obrigação de alterar a caixa: uma pesquisa bem-sucedida podia satisfazer o critério genérico de observação. O executor aceitava a resposta vazia de `batchModify` como confirmação das alterações, sem ler os rótulos posteriores. Remover `INBOX` era classificado como destrutivo; adicionar `TRASH` por `modify` não recebia a mesma proteção de `messages.trash`.

## Correção

`organize_gmail` recebe conta, consulta, nomes de marcadores e opção de arquivar. O servidor percorre todas as páginas antes das alterações, congela os IDs e aplica lotes de 100 mensagens. Esse tamanho limita cada entrega de trabalho, sem limitar a seleção total. As mensagens e os IDs ficam no servidor. Cada lote usa o executor de ações existente e um identificador estável; retomadas reutilizam recibos confirmados, sem repetir efeitos. Trabalho ainda pendente retorna um cursor e a quantidade restante.

Modificações diretas em mensagens/conversas, arquivamento, lixeira e exclusão fazem leitura dos metadados antes e depois. O recibo contém conta, mensagens, assuntos, rótulos, quantidade processada e alterações confirmadas. Uma resposta HTTP bem-sucedida sem o estado solicitado fica inconclusiva. Arquivar/remover marcadores preserva mensagens; adicionar `TRASH`, enviar à lixeira e excluir exige aprovação humana. Excluir mensagens permanentemente continua dependendo dos escopos oficiais do Google.

A organização só pode terminar após todos os lotes selecionados terem recibos verificados ligados à tarefa/revisão atual. Criar um marcador ou consultar e-mails não satisfaz essa obrigação. Consultar marcadores e criar uma pasta vazia continuam sendo operações próprias. Uma organização concluída gera automaticamente um relatório com conta, consulta, destino, quantidade e exemplos de mensagens; não depende de o usuário pedir um card. Os cards de ação mostram contagens, marcadores, destino e assuntos, mantendo JSON recolhido.

## Upstream

Comparação com `CopilotKit/openmuse`, base comum `9ec439fbaa878197d9d44c2aa982cca55676dd68`, referência `upstream/main` em `1ac68f3909f2478ab6280883f1ab5ea65eb5719d`: 64 commits além da ancestralidade local. A divergência inclui implementações próprias, portanto a ausência de equivalência literal de patches não significa ausência da correção.

| Commit / assunto | Avaliação no fork |
| --- | --- |
| `ad989b44` / leitura Gmail | Incorporados os trechos faltantes: charset com idioma RFC2231 e exclusão de texto aninhado em anexos nomeados. Charset desconhecido, endereços entre aspas, endereço sem nome e anexos `message/rfc822` já tinham tratamento próprio. |
| `6abdb93d` / parar após resultado decidido | Já equivalente: `shouldContinue: () => !outcome` no executor e verificações no harness OpenClaw. |
| `5b583f3d` / cancelamento durante preparação | Já equivalente: verificação de sinal antes da admissão de ferramentas e antes de iniciar o agente, inclusive sinal já cancelado. |
| `de8c2324` / ação após cancelamento | Já equivalente: barreiras após claim e imediatamente antes do despacho, ligadas à autoridade da tarefa. |
| `e333eb64` / comando interrompido | Incorporado: preservar o recibo de interrupção por compare-and-swap e impedir execução quando o comando já foi marcado como encerrado. Os dois testes originais reproduziram a falha antes do patch e passaram depois. |
| `98354220` / gateway compatível | O fork já tem seleção por capacidade/provedor e adaptadores separados; copiar o adapter antigo substituiria a arquitetura própria. |
| `c911000c` / quotas HTTP | O fork já usa quotas limitadas por proprietário/dispositivo autenticados, reserva para controle e admissão de trabalho; não confia em forwarding headers. O mapa vulnerável do upstream não existe aqui. |
| `09eaab25`, `695e998d`, `f760f711`, `2cb5907f` / calendário | Tratamentos próprios já cobrem fuso, datas civis inválidas, limites da consulta, paginação e gaps de DST, com regressões. |
| `010d3a0c` / teclado Android | O fork já aplica `padding` no Android e offset de safe area. O bug upstream tinha `behavior` indefinido. Sem nova alegação de teste físico. |
| `76a4678a` / resposta em curso após reload | O fork possui fila durável, retomada e admissão de mensagens; não usa mais o fluxo antigo de replay do upstream. |
| `b06caad7` / desktop E2B | Não adotado: nosso desktop usa o executor nativo no VPS. |
| Demais alterações de browser, imagens, documentos, observadores e tarefas | Mantidas para avaliação por subsistema; nenhuma fusão integral da branch upstream. O relatório completo de commits está nos artefatos de diagnóstico. |

As fontes copiadas do OpenClaw continuam no pin e passam pela verificação de integridade do build; não foram alteradas por esses patches.

## Validação

Logs e recibos: `artifacts/gmail-integrity-20261007/` e `/root/okami-deployment/gmail-integrity-20261007/`. A aceitação real usa Luna no chat publicado e mensagens sintéticas com prefixo explícito, nas duas contas conectadas. Leituras reais iniciais de marcadores responderam em 0,38 s e 0,27 s, pelo OAuth do servidor. O aviso de segurança do Google não é contornado: autenticação inicial e desafios de conta são controlados pelo Google; as operações nativas não dependem de login pelo desktop.
