# Nomes dos companheiros

O commit `e8c34bfe9d3a32f090eccf3d2171cba0fc248bca` adiciona **Renomear** abaixo de cada companheiro salvo e um campo opcional de nome na criação. O editor permite salvar ou cancelar, limita o nome a 80 caracteres, remove espaços nas extremidades e mantém o texto quando há falha de rede. A repetição de uma tentativa usa o mesmo identificador do pedido.

A API faz uma mutação persistente, restrita ao dono do personagem, apenas em `label` e `updatedAt`. Retrato, animações, geração e seleção permanecem preservados. Repetir um pedido antigo não desfaz um nome salvo posteriormente. Renomear durante a geração dos vídeos também preserva o nome ao concluir a animação. A prévia e os candidatos já carregados recebem o nome atualizado.

## Verificação

- Typecheck do servidor e mobile e Biome passaram; `git diff --check` limpo.
- 16 testes de UI passaram, incluindo salvar, cancelar, nome vazio, nome inicial, falha de rede, repetição e isolamento de respostas após trocar de conta.
- 13 testes de API passaram no checkout isolado da release, incluindo persistência, autorização, validação, repetição e conclusão das animações após renomear. No checkout principal, a única falha inicial foi a expectativa de HTTP 400 no teste de nome inválido; corrigida para o HTTP 422 usado pela aplicação, o caso passou novamente.
- Chromium a 390 px: salvamento de nome com emoji, recarregamento, cancelar, falha de rede e repetição do mesmo pedido; capturas em claro/escuro, sem overflow nem erro de runtime.
- Android 14 em AVD temporário: edição com teclado, salvamento, fechamento forçado e reabertura, nome persistido e cancelamento. APK x86_64 standalone com API isolada; sem teste em aparelho físico.
- Produção: controles publicados, editor aberto e cancelado, nome vazio rejeitado pela API com HTTP 422. Os 28 assets, seus nomes, referências de mídia e a seleção existente foram comparados antes/depois e preservados.
- Evidências em `artifacts/companion-names/`. Servidor isolado e AVD temporário encerrados; AVD original preservado.

## Publicação

- Web: `/opt/okami-web/releases/e8c34bf-public`, disponível em [app.okamibot.cloud](https://app.okamibot.cloud/?v=e8c34bf). HTML público idêntico ao export, SHA-256 `2f02433252d756df2856a588a00ff5f32523cab42e96f5d80185c9e095d1a1e8`.
- API: commit isolado `de61f16`, sobre o pin `35a8a36`, com apenas schema, serviço/rota de renomeação e testes. Imagem `openmuse-server:product-de61f16`. Deploy com manutenção, healthcheck e rollback disponível. Os registros pendentes já conhecidos da tarefa cancelada `188f252c-df97-47e0-95dd-8012d0160c32` foram reinspecionados e estavam inalterados; duas reservas humanas, seis operações pendentes e dois recibos nativos permaneceram intactos. Nenhuma tentativa de execução ou limpeza desses registros. Manutenção encerrada.
- APK ARM64 standalone, 68.761.911 bytes, pacote e assinatura existentes preservados. Certificado SHA-256 `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`; APK SHA-256 `59ca56c8f1d2949e248f77e14aa44cc820ec745b998177ad357b7f58ce1aa19e`.
- [APK no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-e8c34bf-arm64.apk), arquivo `/mnt/okami-storage/HubDrive/okamibot-2026-10-04-e8c34bf-arm64.apk`.
- [Download público](https://app.okamibot.cloud/downloads/okamibot.apk?v=e8c34bf), servido de `/opt/okami-web/downloads/okamibot-e8c34bf-arm64-v8a.apk`.

Os dois downloads completos foram conferidos por tamanho e SHA-256. Configuração anterior do Serve em `/root/okami-deployment/serve.before-names-e8c34bf.json`; releases anteriores mantidas.
