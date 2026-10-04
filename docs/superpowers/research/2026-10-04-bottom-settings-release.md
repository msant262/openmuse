# Configurações na barra inferior — 4 de outubro de 2026

A captura do usuário mostrava a web pública ainda na versão anterior à revisão mobile. O commit `3981113b04f504edf3bcb086d64c0433cce124a6` coloca a engrenagem de configurações na extremidade direita da barra inferior compartilhada entre web e Android, mantendo as cinco abas existentes. O acesso no cabeçalho introduzido em `a80d64f` foi substituído por esse botão.

## Verificação

- Typecheck servidor/mobile, Biome no arquivo alterado e `git diff --check` aprovados.
- Três testes de navegação/rascunho/Voltar aprovados. A suíte completa de 1.266 testes pertence à revisão anterior; não foi repetida para esta mudança de posição.
- Chromium com build local e site público autenticado: abertura em 320, 390 e 768 px, alvo de toque de pelo menos 44 px e acesso pelas cinco abas. Nenhuma exceção de runtime nos roteiros.
- Android 14 em emulador descartável: sete verificações aprovadas, incluindo acesso pelas cinco abas, Voltar da seção para a lista, preservação do rascunho e abertura após reinício do processo. O teclado foi dispensado antes de tocar na barra inferior; não foi validado acesso à barra com o teclado aberto.
- Builds standalone x86_64 de teste e arm64-v8a de distribuição concluídos. O primeiro usou API isolada; o segundo contém `https://app.okamibot.cloud`, com assinatura privada do projeto verificada. Não houve teste em aparelho físico.

Roteiros, capturas, logs e recibos ficam em `artifacts/mobile-bottom-settings/`, especialmente `live-web-check.json`, `native-check.json`, `live-bottom-gear.png`, `native-settings-open.png` e `delivery-receipt.json`. O servidor/banco de teste e o AVD `okami_bottom_settings` foram encerrados e removidos; o AVD original foi preservado.

## Publicação e entrega

Web publicada em `/opt/okami-web/releases/3981113-public`. O HTML público foi baixado e comparado ao build local; a interface foi exercitada no próprio domínio após a publicação. Release anterior: `/opt/okami-web/releases/8e5eec0-public`. Configuração de Serve anterior salva em `/root/okami-deployment/serve.before-bottom-settings-3981113.json`.

APK de distribuição: `artifacts/mobile-bottom-settings/android-release/okamibot-release-arm64-v8a.apk`, pacote `app.openmuse.mobile`, versão `0.1.0`/código `1`, com 58.987.865 bytes.

- SHA-256: `151cfdf97cd5c46e4f958c0dba1d60ffaf63bfae6602625ed8aca39208c8ab1d`.
- Certificado SHA-256: `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
- Dell Samsung: `/mnt/okami-storage/HubDrive/okamibot-2026-10-04-3981113-arm64.apk`.
- [Download no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-3981113-arm64.apk).
- [Download público atualizado](https://app.okamibot.cloud/downloads/okamibot.apk?v=3981113), servido de `/opt/okami-web/downloads/okamibot-3981113-arm64-v8a.apk`.
- [Web atualizada](https://app.okamibot.cloud/?v=3981113).

Os dois downloads completos foram conferidos por tamanho e SHA-256. APKs anteriores foram preservados. Não houve novo deploy do backend, envio de mensagens ou alteração de dados pessoais durante a aceitação em produção.
