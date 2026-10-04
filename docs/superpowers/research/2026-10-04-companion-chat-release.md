# Conversa disponível durante tarefas e interações do companheiro

O commit `d7d2a22` libera a conversa depois de admitir uma tarefa em segundo plano. Pesquisa, apresentações, documentos, navegação e integrações seguem para o worker; o turno do chat confirma a admissão e termina sem pesquisar, preparar o documento ou aguardar a tarefa. Novas mensagens podem conversar, orientar o trabalho existente ou iniciar outro trabalho independente. Emojis, reações, figurinhas e respostas com citação são capacidades disponíveis por padrão. O SOUL de cada pessoa continua definindo personalidade, tom, idioma e extensão das respostas; preferências explícitas, como desativar emojis, são respeitadas.

## Incidente observado

No pedido da apresentação sobre Harness Engineering, o chat executou 21 chamadas de ferramentas antes de responder, incluindo pesquisa, leitura de skills e preparação de documento. A tarefa só foi admitida cerca de 157 segundos depois da mensagem. A indicação de reinício era imprecisa: o container não reiniciou nem sofreu OOM. O registro era `Conversation run lease expired` durante transmissão de argumentos de ferramenta.

Cada fragmento transmitido provocava gravação do histórico completo crescente, competindo com a renovação da lease. A correção persiste os eventos incrementalmente e grava a fotografia final uma vez, sem devolver o registro inteiro a cada append. O teste com histórico de 400 KB e 266 eventos reproduziu a falha anterior e verificou renovação real, reconstituição após reinício e uma única fotografia final. A prontidão operacional agora também contabiliza conversas ativas.

A tarefa existente `2c02cd53162291f1ed8c2597201dfa1e644fa76d64a5133ede11a6d6b5afbe6b` posteriormente ficou em `waiting_provider`: o conjunto de contexto e ferramentas ultrapassou a janela configurada do modelo. A API de produção recebeu também o backport da descoberta de ferramentas já existente no checkout principal, projetando schemas necessários antes da admissão do modelo. Isso reduz a carga de schemas; não altera os limites declarados dos provedores. A tarefa e seus artefatos foram preservados sem reiniciar, duplicar ou entregar uma apresentação sem revisão concluída.

## Interações e persistência

- Usuário e agente podem reagir, citar uma mensagem existente e enviar o pacote inicial de seis figurinhas do Okami. O seletor permite inserir emojis no texto. As ferramentas sociais usam IDs reais da conversa; o modelo recebe referências limitadas às mensagens recentes.
- Reações do usuário e do agente são independentes. Repetir um pedido antigo não sobrescreve uma reação posterior. Citações são resolvidas pelo servidor, respeitam o dono da conversa e não autorizam ações.
- Citações e figurinhas persistem na fila offline, aceitação e replay, inclusive após fechar o app. O hash de mensagens antigas permanece compatível. O texto de transporte não aparece nas bolhas nem vira título de tarefa.
- A mensagem aparece localmente ao enviar. A confirmação de recebimento aparece após HTTP 202; a resposta gerada continua sujeita à latência do provedor. Erros de conversa explicam o estado salvo e não reiniciam tarefas automaticamente.
- No Android, o teclado deixa a caixa de mensagem, a citação e o botão de envio acessíveis. O seletor tem altura limitada e rolagem.

## Verificação

- Typecheck do servidor e mobile passou; `git diff --check` limpo. Biome nos arquivos centrais passou.
- Suíte integrada final: 71/71 testes, cobrindo perfil/SOUL, handoff, ferramentas sociais, persistência, identidade, citações e fila de mensagens. Após os ajustes visuais finais, 25/25 testes de UI passaram.
- Regressões de API, conclusão/revisão, modelos e rotinas: 36/36. Persistência de conversas e manutenção: 22/22. JEV: 20/20. Fixtures de documentos, pesquisa, busca e Composio foram adaptadas para que trabalho pesado siga pelo worker, mantendo evidências verificáveis.
- Chromium em API/modelo isolados: reação preservada após recarregar e removível, citação real, inserção de emoji, figurinha persistida e ausência de anotações de transporte. Capturas claro/escuro a 390 px conferidas; sem overflow horizontal nem erro de página.
- Android 14 em AVD temporário: teclado, confirmação de recebimento, seletor com rolagem, reação, cancelar citação, resposta citada e figurinha citada. Estado reaparece após force-stop/reabertura, sem duplicar submissões. Teste nativo usa fixture local; não é teste em aparelho físico. O APK ARM64 acrescenta ao build x86_64 testado apenas a cor explícita de fallback dos emojis, também conferida no navegador.
- Produção, com o modelo configurado: recebimento em 143–159 ms e resposta simples em 2,65 s no teste final. O modelo executou `react_to_message`, `send_sticker` e `reply_to_message`; as três interações apareceram na interface. Reação do usuário persistiu após reload; seletor e inserção de emoji funcionaram. Sem erro de página nem overflow a 390 px. São medições pontuais, não garantia de latência. Nenhuma tarefa nova foi criada; o estado e `updatedAt` da apresentação permaneceram idênticos. A conversa temporária foi excluída e seu pareamento revogado.

## Publicação

- API isolada: `770d988`, imagem `openmuse-server:product-770d988`, pin anterior `de61f16`. Deploy verificou ausência de tarefas/conversas ativas e encerrou a manutenção. Os registros previamente conhecidos da tarefa cancelada `188f252c-df97-47e0-95dd-8012d0160c32` permaneceram intactos: duas reservas humanas, seis operações pendentes e dois recibos nativos. Nenhuma limpeza ou retomada desses registros.
- Web: `/opt/okami-web/releases/d7d2a22-public`, em [app.okamibot.cloud](https://app.okamibot.cloud/?v=d7d2a22). HTML público idêntico ao export, SHA-256 `3d6fb5917fbd485c7072bd9d893f8d48bd633094fb8c9e9e9b366b3ccc540263`. Configuração anterior preservada em `/root/okami-deployment/serve.before-chat-d7d2a22.json`.
- APK ARM64 standalone, 68.778.295 bytes, fonte `d7d2a22ccacd962c0fa9d1e818ec3ce3c7b573f7`. Pacote e assinatura existentes preservados. Certificado SHA-256 `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`; APK SHA-256 `d0da7a811d13b309ecdccadfa9afd5ad68d48aa8e1ff5bde9c72b3badda1f609`. O indicador `sourceDirty` do build vem apenas de `.orca/` e deste documento ainda não versionado; o diff de código estava limpo.
- [APK no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-d7d2a22-arm64.apk) e [download público](https://app.okamibot.cloud/downloads/okamibot.apk?v=d7d2a22). O download público serve `/opt/okami-web/downloads/okamibot-d7d2a22-arm64-v8a.apk`. Releases anteriores mantidas.

Os dois downloads completos foram conferidos por tamanho e SHA-256; ambos correspondem ao APK local assinado. Recibo: `artifacts/companion-chat/delivery-receipt.json`.

As evidências ficam em `artifacts/companion-chat/`. O AVD temporário `okami_chat_review` foi removido e o emulador encerrado; o AVD anterior `orca_api34` foi preservado. Os dois servidores locais de fixture foram encerrados. O lobinho animado, Mini Muse, outros personagens e a edição de nomes da release anterior permanecem preservados.
