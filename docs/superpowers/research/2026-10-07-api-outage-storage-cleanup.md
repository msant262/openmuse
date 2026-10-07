# Recuperação da API e limpeza da VPS

Executada em 7 de outubro de 2026 no domínio público `app.okamibot.cloud` e na
VPS existente. As conexões, companions, arquivos pessoais, histórico de
auditoria e volumes ativos foram preservados.

## Causa e correção

O HTML respondia 200, mas `/api/health` não respondia dentro de 8–20 segundos,
tanto pelo domínio público quanto diretamente pela rede Tailscale. O servidor
estava `unhealthy`, sem tarefas ou conversas ativas, com CPU ocupada mesmo em
repouso. O disco tinha aproximadamente 30 GiB livres; falta de armazenamento
não causou a indisponibilidade.

Perf, o perfil de CPU do Node e uma inspeção temporária do processo existente
identificaram a consulta `Store.unfinishedActionLog` em execução dentro do
PGlite. Para cada início de operação, o plano percorria novamente o histórico
do proprietário para procurar o recibo final. Havia aproximadamente 18,9 mil
entradas; a consulta tinha custo quadrático e bloqueava o event loop da API.

Foram adicionados dois índices parciais: recibos finais por proprietário e ID
de operação, e inícios por data/proprietário/ID. Primeiro os índices foram
instalados pelo próprio PGlite já aberto no processo existente. Não foi aberto
um segundo escritor, nem restaurado ou substituído o banco. A API respondeu
200 em cerca de 100 ms após essa alteração. O plano real passou a usar os dois
índices, e `EXPLAIN ANALYZE` da consulta completa mediu **45,853 ms**.

A migração permanente está no commit `4d55948e`. O teste de regressão, com
4.002 entradas e IDs de operação iguais em proprietários diferentes, falhou
antes da correção: foram examinadas 4.006.002 linhas. Depois passou, junto das
verificações de paginação, cutoff e reconciliação. Nenhuma operação externa é
repetida ou considerada concluída apenas por essa otimização.

## Publicação e memória

A publicação drenou admissões e confirmou ausência de trabalho em execução.
O primeiro escritor encerrou com código zero. A imagem publicada é:

- Fonte da API: `4d55948eaa909a229ff3c68fed0c55e1659bcea8`.
- Tag: `openmuse-server:audit-index-4d55948`.
- Imagem: `sha256:4590e7a8e47001fcb3893059d95199fe2b992cd5bbd881233cf47295a181e059`.
- Rollback retido: `sha256:351c1956d93e237e15749c6c3f701edec54c57b390edb6a8b57a5dba99da94fe`.

A primeira inicialização levou cerca de 110 segundos e sofreu um OOM de
cgroup logo após ficar disponível. O kernel confirmou que o limite antigo
de 1.280 MiB havia sido excedido. O contêiner reiniciou automaticamente uma vez.
Foi aplicado ao contêiner existente o limite de **2 GiB**, sem swap de
contêiner, e esse limite foi persistido no overlay hybrid no commit `52b815fd`.
A inspeção/porta do Node usada no diagnóstico desapareceu com a recriação.

O verificador medido aprovou o orçamento: 8.053.063.680 bytes reservados em
8.326.631.424 bytes de RAM física, incluindo 2 GiB para o browser, 256 MiB para
OpenBao, 2.304 MiB para Hermes e 1 GiB para o sistema. O teto nominal de 8 GiB
continua limitado também por `MemTotal`; swap não conta como RAM disponível.
O profile legado não é admitido nesse orçamento. A configuração base para o
desktop Docker legado permanece com seu orçamento próprio.

Após o ajuste não houve novos reinícios na janela de verificação. O pico
observado do cgroup foi 1.476.587.520 bytes, abaixo do novo limite, e os três
serviços ficaram saudáveis. O pause do usuário permaneceu na revisão 16 e a
manutenção foi encerrada. As 30 operações históricas incertas continuam
preservadas, sem limpeza ou alteração de seus resultados.

## Limpeza e retenção

Um plano de caminhos e IDs foi conferido antes das remoções. Foram removidos:

- Seis imagens antigas da API, sem contêiner associado; dez imagens únicas
  após a publicação passaram a quatro: API atual, rollback, browser e OpenBao.
- Cache de build Docker sem uso: 1,185 GB reportado como removido. Permanecem
  19 registros compartilhados/ativos; não houve prune de volumes.
- 38 artefatos: dois releases web, dois APKs obsoletos, dez cópias antigas de
  fontes/builds, contextos e arquivos duplicados de build, e três backups frios
  substituídos por backups completos mais recentes.

Foram retidos o web/APK atual `gmail-integrity-final-20261007-915c082f` e o
rollback distinto `session-key-entry-20261006-93d6da6f`, além de:

- `gmail-integrity-20261007/server-data-before`.
- `memory-cleanup-20261006/server-data-before-retry`.
- `memory-cleanup-20261006/postgres-before-session-recovery`.

Os dois backups completos têm `PG_VERSION`, controle/WAL, credenciais, arquivos
e chave de sessão. A chave no backup mais recente continua igual à chave ativa.
O snapshot histórico de recuperação foi preservado porque não é uma cópia
idêntica do diretório histórico contido nos backups completos.

**11.234.795.520 bytes foram liberados**, aproximadamente **11,2 GB**. O espaço
livre medido passou de 31.396.675.584 para 42.631.471.104 bytes, e o disco passou
de 70% para 59% ocupado. Os contêineres, IDs, horários de início, montagens,
hash do ambiente, rotas públicas e arquivos retidos permaneceram iguais durante
a limpeza.

## Validação final

- 30 testes de auditoria, política de ações, operador e shutdown: passaram.
- Cinco testes de implantação: passaram.
- 20 contratos Python de implantação/budget: passaram.
- Typecheck e compilação do servidor: passaram.
- Verificação de orçamento e OpenBao no VPS: `ready: true`, vault inicializado
  e não selado, sem erros.
- Seis leituras públicas consecutivas da saúde: 200, entre 70 e 174 ms.
- Após a limpeza: HTML, bundle JavaScript, saúde e APK baixados pelo domínio
  público com status 200. HTML e APK conferidos por SHA-256.
- HTML: `563c6d145a1111991ca935dc6416aad814717387f178e2920521c47e3430abbe`.
- APK: `20874f4638b39124defb32110e05381da3d91a9285e308d0cd6cf384e156ebe7`.
- A branch local e `origin/main` receberam as duas correções. `.orca/` foi
  preservado.

Planos, recibos, perfis privados e resultados ficam em
`artifacts/outage-storage-20261007/` e
`/root/okami-deployment/outage-storage-20261007/`. O recibo de publicação foi
confirmado por estado final e saúde pública: seu último GET de diagnóstico
perdeu a conexão durante o OOM inicial, depois da publicação já confirmada.
