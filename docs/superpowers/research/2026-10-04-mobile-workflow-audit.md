# Configurações mobile e revisão dos fluxos — 4 de outubro de 2026

A sessão anterior encerrou a revisão do harness no commit `a654622`. Esta revisão trata do acesso às configurações e dos fluxos do aplicativo, preservando as mudanças de memória, SOUL e proatividade.

## Defeitos corrigidos

| Problema reproduzido | Correção |
| --- | --- |
| Configurações escondidas em Conversas → Mais opções no mobile | Botão com engrenagem e texto no cabeçalho compartilhado entre web mobile e Android, disponível nas cinco abas. |
| Voltar/Escape fechava todo o diálogo ao visualizar uma seção mobile | Retorna à lista de configurações primeiro; o próximo Voltar fecha. Fechar continua explícito. |
| Resposta atrasada de um procedimento substituía a seleção ou mostrava o histórico de outro | Respostas vinculadas à identidade e à seleção; troca de procedimento limpa estados transitórios. |
| Repetir uma alteração cujo resultado se perdeu criava outro requestId e conflitava com a revisão já salva | Reutilização do recibo para a mesma operação durante a permanência no painel. |
| Estado de controles funcionava visualmente, mas não chegava à árvore acessível da web | Uso dos atributos `aria-checked`, `aria-selected`, `aria-expanded`, `aria-busy` e `aria-disabled`, aceitos pelo React Native instalado e pelo React Native Web. Removidas declarações antigas redundantes. |
| Memória manual com validade recebia sempre o fuso Europe/Berlin | Preserva o horário com offset explicitamente informado, sem inventar um fuso geográfico. |

As regressões de Voltar, resposta atrasada e repetição após perda de resposta falharam antes das correções e passaram depois. A falha de acessibilidade foi observada no DOM real: o tema persistia, mas os controles `role=radio` não tinham `aria-checked`.

## Verificação realizada

Backend e banco temporários, sem acesso aos dados ou contas reais. Web exportada com API na mesma origem, em `127.0.0.1:8797`. APK Android standalone x86_64 com API `10.0.2.2:8797`, instalado em AVD descartável Android 14. A instalação existente no AVD original foi preservada.

| Área | Evidência exercitada |
| --- | --- |
| Navegação | Chat, Feed, Ideias, Objetivos e Biblioteca; configurações acessíveis de todas as abas; web 320/390/768 px e desktop 1440 px. |
| Configurações | Abertura e fechamento das nove seções: Geral, tema, modelos, conectores, personalização, permissões, memória, proatividade, notificações. Voltar em seção e lista. |
| Tema e idioma | Tema escuro persiste após recarga web e reinício Android; controles expõem a seleção. Troca português/inglês e botão “Configurações” visível em 320 px. |
| Conversas | Rascunho preservado ao abrir/fechar configurações; nova conversa mantém rascunho separado após recarga; rascunho Android preservado após reinício do processo. |
| Memória | Correção, esquecimento, consulta ao histórico, restauração explícita e criação com validade/offset. A política de não recuperar automaticamente fatos esquecidos continua ativa. |
| Proatividade | Cadência alterada e confirmada após reabrir. Fontes externas e execução real de revisão não foram simuladas como sucesso. |
| Objetivos | Cadastro com marcos, pausa, retomada e conclusão confirmada na interface. |
| Arquivos | PDF de duas páginas abre com controles de navegação, zoom e campos do formulário; retorno à Biblioteca. |
| Rotinas | Criar, pausar, editar e excluir uma rotina de teste. |
| Procedimentos | Fixar, arquivar, restaurar e voltar a versão anterior; arquivado não oferece nova execução. Regressões controlam respostas atrasadas e resultado perdido. |
| Permissões | Pedido de revisão aberto pelas configurações, negado e encerrado sem travar a navegação. Apenas ação local de teste. |
| Android | Todas as seções/abas, hardware Back, reinício, tema, rascunho e configurações com fonte ampliada. Nenhum erro ReactNativeJS/AndroidRuntime registrado durante o roteiro. |

Resultados:

- Suíte completa: **1.266 testes aprovados**, zero falhas, ignorados ou cancelados.
- Regressões de interface repetidas após os ajustes: **18 testes aprovados**.
- Typecheck servidor/mobile aprovado.
- Lint sem erros; **271 warnings e 7 infos**, iguais ao baseline anterior.
- Builds web e Android concluídos. APK verificado quanto a assinatura local, pacote, ABI, bundle standalone e URL embutida.
- Roteiros no navegador: 18 verificações de navegação/layout, 8 de operações e 5 complementares; sem exceções de runtime.
- Roteiro nativo: 18 verificações.

## Evidências e limites

Evidências locais em `artifacts/mobile-workflow-audit/`: `web-audit.json`, `web-flows.json`, `web-extras.json`, `native-audit.json`, logs, roteiros e capturas. Os seletores dos roteiros foram ajustados durante a exploração; operações já concluídas puderam ser retomadas sem repetir mutações. Os resultados finais confirmam o estado salvo, incluindo restauração de memória e conclusão do objetivo.

Não houve publicação, alteração da instalação real, envio de emails, uso de credenciais externas ou alteração de dados pessoais. O APK usa assinatura de desenvolvimento e endpoint de laboratório; não é um APK de distribuição para o telefone. iOS/Safari, aparelho físico, OAuth com contas reais, entrega de push, geração por provedor real e controle remoto de computador não receberam aceitação end-to-end nesta execução. Os testes existentes dessas integrações passaram na suíte, mas não substituem a validação com serviços reais.

### Observação residual: alteração do tamanho da fonte com o app aberto

Ao mudar o `font_scale` do Android de 1.0 para 1.3 durante a execução, alguns textos já montados mantiveram medidas antigas e ficaram cortados, inclusive atalhos da tela inicial. As configurações continuaram abrindo. Reiniciar o processo com a mesma escala 1.3 restaurou o layout correto; evidências `android-final.png` e `android-large-text-restart.png`. Esse comportamento de atualização dinâmica de medidas não foi corrigido nesta alteração e precisa de investigação separada; o resultado de fonte ampliada não deve ser interpretado como aprovação dessa transição em execução.
