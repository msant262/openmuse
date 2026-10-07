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

### Regressões reproduzidas e corrigidas durante a aceitação

- O termo “arquivo” no pedido de criar documento podia ativar o critério de arquivamento de e-mails. O reconhecimento agora exige os verbos próprios de arquivamento.
- Retomar um lote lento podia consumir todo o tempo disponível relendo recibos e devolver o mesmo cursor. A retomada precisa avançar pelo menos um lote pendente antes de devolver outro cursor. O teste com 205 mensagens confirmou avanço 100 → 200 → 205, com três escritas.
- O agente pedia uma confirmação textual antes de preparar o card, ou tentava uma chamada paralela por mensagem e era interrompido pelo primeiro card. As instruções agora deixam explícito que preparar a ação não executa a exclusão; o lote vai para um card com conta, quantidade, assuntos e destino Lixeira.
- A descoberta de ferramentas rejeitava `schemaPath: ["parameters"]` em leituras que não têm corpo. Ela agora descreve os parâmetros de consulta/caminho e aceita o prefixo `body` para os schemas de escrita. Caminhos desconhecidos continuam sendo rejeitados.
- Uma exclusão aprovada e confirmada no Gmail podia entregar o texto anterior “Preparei… após aprovação”. A entrega final agora se baseia exclusivamente nos recibos nativos verificados das ações daquela tarefa, informando conta, quantidade e assuntos realmente enviados à Lixeira/excluídos.
- Uma segunda conversa nova encontrou dois e-mails, mas o modelo, após tentar um campo de schema inexistente, preparou uma chamada individual de lixeira para apenas um. O card foi recusado. `prepare_gmail_trash` agora recebe conta e consulta, seleciona todas as páginas no servidor e congela os IDs antes de preparar uma única aprovação. Pedidos explícitos de “todos” rejeitam chamadas destrutivas diretas sem essa seleção e exigem um recibo de seleção completa para terminar. Acima de 1.000 mensagens, a aprovação continua única; somente as chamadas ao Google são divididas pelo limite oficial da API. O resumo para o modelo limita exemplos a 12, mantendo IDs e recibos completos no servidor. Busca vazia é um no-op verificado, sem card nem alegação de alterações.

### Testes automatizados

Nova execução da suíte completa: **1.622 testes passaram; zero falhas**, em 610,8 s, com Node 24.21.0 e concorrência 4. Os últimos ajustes de descoberta de schema e entrega foram cobertos também por **41 testes direcionados**, zero falhas, e pelo teste isolado da entrega final após aprovação. Os typechecks do servidor e do mobile e os builds do servidor, web e APK passaram. A suíte completa começou no commit `915c082f`; os dois ajustes seguintes foram validados adicionalmente pelos testes direcionados, sem alegação de nova execução completa em `310c80c2`.

Na execução completa anterior houve aborto interno do processo Node/V8 no arquivo de versões. Os oito testes desse arquivo passaram na repetição isolada e a nova suíte completa terminou sem o aborto. As falhas de fixtures antigas descobertas na primeira execução foram corrigidas antes da execução verde.

Regressões relevantes incluem: Google devolver sucesso sem aplicar rótulos; falha de leitura posterior; lista de rótulos vazia; paginação completa; cursor repetido; interrupção após escrita; retomada sem repetir efeitos; pesquisa ou criação de marcador não satisfazer organização; criação automática do relatório; lixeira via `modify` exigir aprovação; recusa não executar; assuntos e destino no card; resumo baseado no efeito confirmado.

Depois da descoberta da seleção parcial, **74 testes direcionados** de Gmail, Google Workspace, conclusão e conectores passaram. Após o último ajuste de saída compacta, os **18 testes de Gmail** passaram novamente, incluindo seleção de 1.005 mensagens, dois pedidos Google e uma única aprovação, retomada sem duplicação e busca vazia. O typecheck, build TypeScript e Biome passaram.

### Publicação e limites da verificação

| Artefato | Versão publicada | Evidência |
| --- | --- | --- |
| API | `310c80c2c9515407d1f238ae7150f7a1d03af302` | Imagem `sha256:4560401a0eaaeef80d0aaeadf2d063428fef350a77d6ef831f14bd7d4f9fa12c`, container saudável. |
| Web | `915c082f679ea99a0e914cfb0004e2689b0b93f6` | Bundle público `index-c3c5cb4bd02ad4408016401a79c8a6c9.js`; SHA-256 do índice `563c6d145a1111991ca935dc6416aad814717387f178e2920521c47e3430abbe`. |
| APK arm64 | `915c082f679ea99a0e914cfb0004e2689b0b93f6` | SHA-256 `20874f4638b39124defb32110e05381da3d91a9285e308d0cd6cf384e156ebe7`, 67.217.381 bytes, assinatura verificada e push nativo configurado. |

Os dois commits depois do build mobile alteram apenas o servidor/schema das ferramentas. O APK disponível é [okamibot.apk](https://app.okamibot.cloud/downloads/okamibot.apk?v=915c082f). O build registra `sourceDirty: true` por causa de `.orca/` não rastreado; os arquivos rastreados estavam limpos. O signatário tem SHA-256 `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.

A interface foi exercitada no domínio público em viewport mobile de 390 × 844 e desktop. A prévia nativa não abriu por erro explícito de AppArmor; o emulador Android também não iniciou e iOS não está disponível neste Linux. **Não houve aceitação em aparelho físico nem em APK instalado**; a verificação de instalação não deve ser inferida dos testes web ou da assinatura.

O deploy foi feito com drenagem de admissões, parada confirmada do único escritor e troca apenas da imagem. Na primeira tentativa, 45 s eram insuficientes para a inicialização e houve rollback somente de código, preservando o mesmo volume. O orçamento de saúde passou para 180 s; a inicialização observada ficou próxima de 90 s. O backup completo foi capturado com o escritor parado. Não houve restauração/substituição do banco, segundo escritor, alteração do ambiente, desconexão das contas Google ou mudança da pausa escolhida pelo usuário. As 30 operações antigas incertas encontradas antes do trabalho foram preservadas, sem apagar evidência para permitir o deploy.

### Confirmação de segurança do Google

O desafio “Sim, fui eu” pertence à proteção da conta Google e é distinto do card de aprovação do OkamiBot. Sem o registro específico do alerta original não é possível atribuir seu gatilho exato. Os testes nativos desta rodada usam o OAuth conectado no servidor, com `gmail.modify` para Lixeira, e não abrem login Google nem solicitam escopo de exclusão permanente. A descrição oficial dos alertas e do fluxo de reconhecimento está em [Google: responder a alertas de segurança](https://support.google.com/accounts/answer/2590353?hl=pt-BR). O sucesso vazio de `batchModify` é documentado na [referência oficial Gmail](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify); por isso o executor verifica o estado posterior.
