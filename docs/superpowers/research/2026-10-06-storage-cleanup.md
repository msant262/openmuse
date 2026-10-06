# Limpeza de armazenamento após a entrega de memória e acesso

Executada em 6 de outubro de 2026. A branch local `main` e `origin/main` já
continham todas as alterações em `fab9bb60`; o fetch confirmou zero commits
pendentes em qualquer direção. Este registro é uma alteração documental,
sem nova publicação ou reinicialização da aplicação.

## Retenção

Foram preservados:

- Web atual `session-key-entry-20261006-93d6da6f` e rollback
  `memory-cleanup-20261006-ca1324ff`.
- APK atual `okamibot-session-key-entry-93d6da6f-arm64-v8a.apk` e rollback
  `okamibot-memory-cleanup-ca1324ff-arm64-v8a.apk`, localmente e no VPS.
- Imagem da API em produção `sha256:e473590b8d2b642615e76dac8f56a99a08e233a7d80b71a2941c5e9674b2526a`
  e rollback `sha256:45a719539fde80e26025a0270451807dceee7a5221f8251b8b7d35cf31bac061`.
  As imagens do browser e OpenBao também permanecem em uso.
- Backups de recuperação `server-data-before`, `server-data-before-retry` e
  `postgres-before-session-recovery`, além dos backups anteriores de outras
  entregas. O banco ativo, seus volumes, credenciais, companions e dados pessoais
  não foram alvos da limpeza.
- Histórico Git, fontes versionadas, relatórios, logs e recibos de validação.
  A pasta local de orquestração `.orca/` continua preservada.

## Remoções

Na máquina de desenvolvimento foram removidos 67 APKs antigos, 110 arquivos de
distribuição/build e 120 diretórios gerados: cópias de fontes, compilações,
candidatos de imagem, exports web e uma extração antiga do runtime. As fontes
reais do harness permanecem em `third_party/openclaw/harness` e sua recompilação
foi executada com sucesso depois da limpeza. Nenhum arquivo Git rastreado estava
nesses artefatos removidos.

No VPS foram removidos cinco releases web, sete APKs da pasta de downloads,
três APKs duplicados do operador, 17 diretórios de candidatos, cinco arquivos de
build, duas imagens antigas da API sem contêineres associados e o cache de build
Docker sem uso. As três rotas versionadas para APKs obsoletos foram retiradas;
`/`, `/api`, `/executor` e `/downloads/okamibot.apk` foram preservadas.

Também foram removidas seis cópias descartáveis do banco, usadas em inspeção,
preflight e testes: `inspection-postgres`, `auth-inspection-pre-recovery`,
`startup-preflight-postgres`, `bounded-test-postgres`,
`auth-inspection-pre-retry` e `auth-inspection-pre-deploy`. Não eram os backups
de recuperação retidos nem estavam montadas nos contêineres. Os relatórios e
recibos derivados dessas inspeções continuam disponíveis.

## Espaço e verificação

- Local: **18.326.614.016 bytes** liberados de artefatos, aproximadamente
  **18,3 GB**. Ocupação da pasta `artifacts`: 19,42 GiB → 2,36 GiB.
- VPS: **16.389.263.360 bytes** adicionais disponíveis, aproximadamente
  **16,4 GB**. O disco passou de 78% para 62% ocupado, com aproximadamente
  37 GiB disponíveis. O diretório do operador passou de 30 GiB para 15 GiB.
- Docker: seis → quatro imagens; cache de build 116 → 19 registros, com
  471,6 MB reportados como removidos. Os três volumes ativos foram preservados.

Antes de remover, os planos foram conferidos e a produção e o rollback foram
protegidos por caminho, ID de imagem e hash. Depois, IDs, horários de início,
estado saudável e montagens dos três contêineres permaneceram iguais: não houve
reinicialização. O hash do ambiente do servidor também permaneceu igual.

HTML e APK atuais foram novamente baixados pelo domínio público e conferidos:

- HTML: `bfcd1e92b9096f6fdfd7dbd3c8d98f9832ed49c377bde3bb2d5610b9f6ae4693`.
- APK: `26e109e8eb842ebbe1ce129c35d7d827df6847bf260e42dadff69f344e07ed30`.
- APK de rollback preservado:
  `790670ae13d5ad5a19d81cf0f126e6c64613dbd3e24f640da14708b05ddf84eb`.

Não foi utilizado prune de volumes nem remoção forçada de imagens em uso.
Planos completos, scripts e recibos ficam em
`artifacts/storage-cleanup-20261006/` e
`/root/okami-deployment/storage-cleanup-20261006/` no VPS.
