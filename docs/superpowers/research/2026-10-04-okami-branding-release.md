# Identidade OkamiBot e mascote padrão

O commit `c8dd185368d37abc1e596e3019d52087af1d81ae` aplica o logo fornecido pelo proprietário ao ícone, favicon, splash nativo e telas de carregamento/entrada, com versões clara e escura. A abertura acompanha autenticação e carregamento reais; não adiciona uma espera artificial. Os indicadores respeitam a preferência de movimento reduzido.

O Lobinho Okami foi adicionado como padrão para quem não tem um avatar escolhido. Mini Muse continua disponível com seus três vídeos originais. A seleção de um mascote incluído é persistida na identidade, sem apagar a galeria. Um avatar personalizado escolhido continua tendo prioridade. O lobinho é, nesta versão, uma imagem estática transparente.

Pacote Android, deep links, armazenamento de credenciais e assinatura existentes foram preservados. Os registros dos assets e avisos de atribuição foram atualizados, mantendo o material anterior.

## Validação

- Typecheck do servidor e mobile, Biome nos arquivos alterados e `git diff --check` passaram.
- 36 testes de seleção, estúdio, mídia, modelos e branding passaram. O backend isolado para publicação passou no typecheck e em 12 testes de avatar. A suíte completa não foi repetida nesta retomada.
- Chromium: telas de carregamento e HTML anterior ao JavaScript nos dois temas; seleção e persistência após recarregar em 320, 390 e 768 px. Mini Muse decodifica e reproduz vídeo; nenhum overflow horizontal ou erro de runtime no roteiro.
- Android 14, AVD descartável: abertura, configurações, troca entre os dois mascotes e persistência após reinício do processo nos dois temas. Splash claro/escuro presente nos recursos nativos e carregamento personalizado conferido com a API de teste temporariamente suspensa. Sem teste em aparelho físico.
- Produção: login, temas, galeria e presença dos dois novos seletores conferidos. O GUMC selecionado, os IDs da galeria e os registros pendentes da tarefa cancelada permaneceram iguais. Nenhum mascote de produção foi trocado durante a aceitação.
- Evidências e roteiros em `artifacts/okami-branding/`, incluindo `web-check.json`, `native-check.json`, `live-check.json`, capturas, logs e recibos dos APKs. Servidor de teste e AVD temporário encerrados; AVD original preservado.

## Publicação

- [Web atualizada](https://app.okamibot.cloud/?v=c8dd185): `/opt/okami-web/releases/c8dd185-public`. Anterior: `/opt/okami-web/releases/dff64c2-public`. Configuração Serve anterior preservada em `/root/okami-deployment/serve.before-branding-c8dd185.json`.
- HTML público conferido com o export local por SHA-256: `586e64c74943160e935cb6264d8c0c4c9f447a412f8ba1f377d8aa63aa9f35a6`.
- API: commit `35a8a36`, contendo somente a seleção dos mascotes incluídos sobre o pin de produção `6760f5e`. Imagem `openmuse-server:product-35a8a36`; anterior preservada como `openmuse-server:before-product-35a8a36`. A troca foi feita sob manutenção, com zero tarefas ativas, admissões e requisições em curso.
- O primeiro preflight recusou a troca porque existiam seis registros pendentes de tentativas de controle de desktop numa tarefa já cancelada, com dois recibos nativos de resultado desconhecido. Após inspeção pela API autenticada, a substituição do processo preservou esses registros e os dois controles humanos duráveis. Nenhuma operação foi repetida ou marcada como limpa. Contagens e estados foram conferidos depois; manutenção encerrada. Não foi um backup com escritores parados.
- APK ARM64 standalone, API `https://app.okamibot.cloud`, pacote `app.openmuse.mobile`, versão `0.1.0`/código `1`, 61.544.479 bytes.
- Certificado SHA-256 original: `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
- SHA-256 do APK: `2ea91a555f6efce2e05cb03606c17f571c042d91cead3958310de26f78c92e44`.
- [APK no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-c8dd185-arm64.apk), salvo em `/mnt/okami-storage/HubDrive/okamibot-2026-10-04-c8dd185-arm64.apk`.
- [APK público](https://app.okamibot.cloud/downloads/okamibot.apk?v=c8dd185), servido de `/opt/okami-web/downloads/okamibot-c8dd185-arm64-v8a.apk`.

Os dois downloads completos foram comparados por tamanho e SHA-256 com o APK local assinado. Releases e APKs anteriores foram preservados. `.orca/drops/` contém as referências locais fornecidas pelo usuário e permanece fora dos commits.
