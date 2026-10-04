# Acabamento do avatar nos temas claro e escuro

O cabeçalho exibia o arquivo do avatar com cantos retos, deixando o fundo branco da mídia muito evidente no tema escuro. O commit `dff64c24254eb8ad0156e2928d18faa73f014e35` apresenta o avatar em uma moldura circular de 60 px, com recorte interno de 54 px, borda e superfície do tema. O nome ganhou espaçamento próprio e uma borda discreta. As prévias de corpo inteiro também têm cantos arredondados, e o aviso de mídia indisponível usa a superfície do tema.

Essa solução mantém a imagem e as animações escolhidas pelo usuário. Não houve remoção de fundo ou alteração do avatar salvo; o acabamento é aplicado pelo componente compartilhado entre web e Android.

## Aceitação

- Typecheck servidor/mobile, Biome nos três arquivos alterados e `git diff --check` aprovados.
- 24 testes existentes de mídia, estúdio do avatar e tema aprovados.
- Chromium local e produção autenticada: temas claro/escuro em 320, 390, 768 e 1440 px, máscara circular e bordas conferidas, sem rolagem horizontal ou exceções de runtime. Abertura do painel do agente e das configurações confirmada. No desktop, o painel lateral foi fechado para exercitar o cabeçalho flutuante.
- Android 14 em AVD temporário: capturas dos dois temas com o pôster real do GUMC, abertura do painel do agente e acesso às configurações. O teste nativo usou API/banco isolados e uma cópia do pôster; as animações reais foram carregadas pela web pública. Não houve aceitação em aparelho físico.
- Evidências locais em `artifacts/avatar-dark-polish/`: `local-web-check.json`, `live-web-check.json`, `native-check.json`, capturas, logs e recibos dos builds. O servidor e o AVD temporários foram encerrados e removidos.

## Publicação

- Web: `/opt/okami-web/releases/dff64c2-public`, anterior `/opt/okami-web/releases/3981113-public`. Backup da configuração Serve: `/root/okami-deployment/serve.before-avatar-dff64c2.json`.
- [Site atualizado](https://app.okamibot.cloud/?v=dff64c2). HTML público conferido com o build local por SHA-256: `5e751e6fe72fca36fad79216c4f9b30d0f1729ee19607c0cccdaabc3c120d8e6`.
- APK arm64-v8a standalone, API pública, mesma assinatura privada do projeto: `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`. Pacote `app.openmuse.mobile`, versão `0.1.0`, código `1`.
- Arquivo no disco Dell Samsung: `/mnt/okami-storage/HubDrive/okamibot-2026-10-04-dff64c2-arm64.apk`.
- [APK no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-dff64c2-arm64.apk) e [APK público](https://app.okamibot.cloud/downloads/okamibot.apk?v=dff64c2).
- SHA-256 do APK: `93effbfb73f2d222785cef1d1e8ca0389dcd8f8a531b6665c39bde5f8b8d4866`; tamanho: 58.987.865 bytes. Conferência dos downloads registrada em `delivery-receipt.json`.

Backend e dados pessoais não foram alterados. Releases e APKs anteriores foram preservados.
