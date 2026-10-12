# Limpeza dos testes e do armazenamento — 12 de outubro de 2026

Limpeza aplicada no aplicativo publicado em `https://app.okamibot.cloud`.
As verificações autenticadas na URL pública terminaram às 06:26 UTC.

## Registros retirados da aplicação

Foram retirados 57 registros pertencentes aos testes:

| Tipo | Quantidade |
| --- | ---: |
| Conversas de teste | 4 |
| Tarefas de teste | 4 |
| Ações e respectivas revisões | 8 |
| Atividades | 19 |
| Relatórios de teste | 2 |
| Rascunho de e-mail | 1 |
| Notificações de teste | 8 |
| Solicitações de interação antigas | 7 |
| Entradas de mensagens dos testes | 4 |

Os históricos de teste foram arquivados e excluídos das listas do produto.
Os recibos de execução e auditoria foram preservados. Nenhum novo e-mail foi enviado
e nenhum documento real do Google Workspace foi excluído durante esta limpeza.

Restaram as duas conversas reais, três tarefas reais, duas ações reais e cinco
atividades associadas a essas ações. As três contas Google continuam conectadas.
Foram preservados os companions, os 58 arquivos existentes, as três memórias e os
35 procedimentos. Os outros 861 registros dentro do inventário de apresentação
permaneceram idênticos. A comparação de companions desconsidera somente URLs
assinadas temporárias, que mudam a cada consulta.

## Armazenamento

- VPS: duas imagens Docker obsoletas, quatro releases web antigas, sete arquivos
  de publicação e um APK antigo removidos; cache de builds sem uso há mais de uma
  hora eliminado. Recuperados aproximadamente **11,3 GiB**.
- Workspace local: dois APKs antigos ou gerados e três arquivos de publicação
  antigos removidos. Liberados aproximadamente **285 MiB**.
- Não havia containers antigos parados: os três containers existentes estavam
  ativos e saudáveis e foram mantidos.
- Mantidos a versão publicada, uma versão anterior para recuperação, o APK de
  produção, o APK atual do emulador e a imagem da correção de memória ainda não
  publicada. Volumes, perfis e backups foram preservados.

## Verificação

As consultas autenticadas na URL pública confirmaram ausência das conversas,
tarefas, ações, atividades, relatórios e rascunho dos testes selecionados.
O site e `/api/health` responderam HTTP 200 tanto no domínio público quanto no
endereço Tailscale. O acesso de navegador utilizado nos testes foi revogado;
os demais dispositivos foram preservados. O inspector usado na manutenção foi
fechado e seus hooks removidos.

Os recibos detalhados estão no diretório privado
`artifacts/harness-parity-20261009/`, em `cleanup-final-integrity.json`,
`cleanup-final-storage-receipt.json` e `cleanup-final-public-origin-proof.json`.
Este relatório confirma a limpeza; não certifica a conclusão das correções
pendentes do harness.
