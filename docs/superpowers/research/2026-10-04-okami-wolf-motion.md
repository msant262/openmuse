# Animações do Lobinho Okami

O commit `bc2e04bea289a7748e8abb4f8f5dcf527ae54080` corrige o mascote padrão estático da versão anterior: o Lobinho Okami agora tem vídeos próprios de repouso, trabalho e resposta. O estado de trabalho mostra o mesmo lobinho digitando em um laptop com fones; repouso e resposta usam respiração, piscadas e pequenos movimentos da cabeça.

Foram gerados dois pôsteres com a ferramenta integrada `image_gen`, a partir do lobinho original, e três vídeos com Grok Imagine Video 1.5, usando o mesmo primeiro e último quadro. Arquivos e prompts estão documentados em [companions/README.md](../../../apps/mobile/assets/companions/README.md). Os vídeos H.264 têm aproximadamente seis segundos, 720 × 720, 24 fps e nenhum áudio, totalizando 3.926.052 bytes. A reprodução reutiliza o player existente, com loop, pausa ao sair de foco e pôster correspondente para movimento reduzido. Mini Muse e avatares personalizados permanecem disponíveis.

## Verificação

- Typecheck de servidor/mobile, Biome e `git diff --check` passaram.
- 23 testes existentes de mídia, estúdio, branding e seleção do estado da conversa passaram.
- FFmpeg decodificou integralmente os três exports; FFprobe confirmou um único stream H.264 por arquivo. Sequências de quadros foram inspecionadas para identidade e movimento.
- Chromium local: os três vídeos decodificaram e avançaram quadros nos temas claro/escuro, em loop e sem som; verificada a passagem pelo fim do loop, a remoção dos players ao ativar movimento reduzido, a troca para Mini Muse e a volta ao lobinho. Sem erros de runtime ou overflow no roteiro.
- Android 14 em AVD temporário: seis verificações, cobrindo os três estados nos dois temas. Capturas espaçadas dentro da região da prévia confirmaram mudanças de quadros em todos os casos. Capturas de trabalho também inspecionadas visualmente. Sem teste em aparelho físico.
- Produção: os três vídeos publicados decodificaram e reproduziram numa prévia aplicada somente ao navegador de teste. Nenhum POST de seleção foi feito; o GUMC salvo foi conferido e preservado. Backend não foi alterado.
- Evidências em `artifacts/okami-wolf-motion/`: `video-validation.json`, `web-check.json`, `native-check.json`, `live-check.json`, capturas, originais dos vídeos e recibos de geração/build/download. Servidor isolado e AVD temporário encerrados, AVD original preservado.

## Entrega

- [Web atualizada](https://app.okamibot.cloud/?v=bc2e04b): `/opt/okami-web/releases/bc2e04b-public`, substituindo `c8dd185-public`. Configuração anterior em `/root/okami-deployment/serve.before-wolf-bc2e04b.json`.
- HTML público idêntico ao export local: SHA-256 `cc4fac29544b888d191101296863b64483ede2a98adaa3398f126ece89b5e554`.
- APK ARM64 standalone de 68.757.815 bytes, API pública, pacote e assinatura existentes preservados. Certificado SHA-256 `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
- SHA-256 do APK: `eb1b29b93f18ec25acddf70cbf7ce776d0e9de6c5b8003ce5f767158f63d0940`.
- [Download no Drive da Dell](http://dell.local:8080/api/drive/download?path=okamibot-2026-10-04-bc2e04b-arm64.apk), em `/mnt/okami-storage/HubDrive/okamibot-2026-10-04-bc2e04b-arm64.apk`.
- [Download público](https://app.okamibot.cloud/downloads/okamibot.apk?v=bc2e04b), servido de `/opt/okami-web/downloads/okamibot-bc2e04b-arm64-v8a.apk`.

Os dois downloads completos foram conferidos por tamanho e SHA-256. Releases e APKs anteriores foram mantidos.
