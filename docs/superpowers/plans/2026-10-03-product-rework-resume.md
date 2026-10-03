# Retomada do retrabalho do produto

Referência: [plano aprovado](2026-10-03-product-rework.md). Sessão retomada em
2026-10-03 a partir de `9e4b3a6`, após interrupção da sessão anterior.

## Estado recuperado

- Domínio público: `https://app.okamibot.cloud`; túnel Cloudflare ativo.
- API publicada: imagem `product-786ffe4`; web publicada: `fc8b6f0-product`.
- Código posterior de navegação, visualizador e tradução já integrado, mas ainda
  sem publicação final. Build web e suíte da sessão anterior foram interrompidos.
- Traduções adicionais preservadas no worktree `/tmp/okami-ui-localization`.
- Android publicado ainda aponta para o endereço privado; substituir pelo build
  assinado com o endereço público.
- Falha real pendente: chamada `computer_status` encerrou o run sem executar a
  ferramenta nem produzir resposta. Diagnóstico e regressão em andamento.

## Execução desta retomada

- Correção do runtime: subagente `finish_tool_execution`, worktree isolado.
- Traduções restantes e fixtures: subagente `finish_localization`, worktree
  recuperado, preservando alterações anteriores.
- Android assinado e emulador: subagente `finish_android`.
- Integração, publicação, testes completos e aceite web: agente principal.

O método de trabalho paralelo e a implantação foram autorizados na sessão
anterior. Não reiniciar o plano dos doze marcos nem repetir entregas concluídas.
Preservar controle humano ativo e tarefas durante a implantação.

## Correções integradas

- `5310b0e`: seletor de idioma da entrada Android respeita a área segura.
- `13ca80a` / `d671bfe`: catálogo PT-BR e fixtures de tradução concluídos.
- `7f3ef52`: ChatGPT com function call completo e output terminal vazio passa a
  executar a ferramenta uma vez e continuar o run. EOF, falha e stream incompleto
  continuam sem execução.
- `40390aa`: mudar idioma preserva seleção de conversa e rascunho, inclusive
  quando a gravação da seleção está pendente ou a rede caiu.
- `7d4c291`: prazos de desafio usam o mesmo timestamp, eliminando diferença
  intermitente de um milissegundo no TTL.
- `08306bd`: manutenção desconsidera somente o recibo histórico completo de
  computer_status incorretamente marcado running; não reescreve o histórico e
  continua bloqueada por operações realmente ativas.
- `948ffa5`: uma consulta concluída não herda o estado running do computador;
  computer_status é evidência de observação. Planos solicitados como texto com
  passos numerados são persistidos como artefatos da revisão antes da verificação.
  Alegações sem entrega, efeitos pendentes e ausência de recibo externo continuam
  recusados.
- `d6fa127`: a resposta textual final de um plano também passa pela gravação e
  verificação da entrega, mesmo sem chamada explícita a finish_task. Texto de
  stream interrompido não vira entrega concluída. Caso reproduzido no modelo real
  e coberto por duas regressões adicionais.

## Aceite web e Android

- Domínio público: entrada com chave e sessão autenticada, API protegida e rotas
  internas bloqueadas pelo gateway. Web final `40390aa` publicada.
- Navegação desktop/menu, configurações e EN/PT-BR exercitados na instalação real.
  Um rascunho de conversa nova sobreviveu à troca de idioma e retorno à conversa.
- Nome e personalidade salvos e conferidos após recarregar; preset e aparência
  personalizada também. Valores temporários de teste restaurados.
- Cinco avatares com animação 3D real, editor, movimento reduzido, pausa fora da
  tela e descarte de recursos verificados no renderizador. No Android, animação
  nativa e controles de aparência também exercitados.
- Assumir controle, tecla Escape, clique na área de trabalho e devolução ao agente
  passaram na Lenovo real. Observador do DOM registrou zero remoções da imagem
  durante atualização/entrada.
- APKs assinados ARM64 e x86_64 usam fonte `40390aa` e HTTPS público. Download ARM64
  conferido por tamanho e SHA256. Atualização no emulador preservou pareamento e
  rascunho; entrada EN/PT-BR respeita a barra de status.
- Evidências locais em `artifacts/resume-recovery/` e
  `artifacts/android/public-release-evidence/`; instruções e hashes em
  [FIRST-ACCESS](../../FIRST-ACCESS.md) e
  [DEPLOYMENT-ACCEPTANCE](../../DEPLOYMENT-ACCEPTANCE.md).

## Validação e publicação final

TypeScript e build do servidor passaram em `d6fa127`. Biome: zero erros,
189 avisos preexistentes e duas informações. As regressões de conclusão somaram
59 testes focados; os três testes de manutenção passaram após reproduzir a falha.
A última correção acrescentou duas regressões e passou nos 17 testes relacionados.

A suíte integral final passou **908/908** em `d6fa127`, em dois lotes isolados
(433 e 475 testes; ambos com saída 0). A rodada anterior em `948ffa5` passou
906/906. Uma execução interrompida por SIGTERM após 600 aprovações não foi
considerada aprovação integral; não houve OOM registrado no kernel. Os logs e
listas completas de arquivos estão em `artifacts/resume-recovery/`.

O gateway público final retornou 200 para interface e health, 401 para a API sem
sessão e 404 para executor/manutenção. Browser de aceite fechado; emuladores de
teste encerrados. Nenhum erro foi registrado no console da verificação web.

API final publicada: `openmuse-server:product-d6fa127`. Os cinco pedidos reais
concluíram com status succeeded e completion verified: os quatro planos possuem
artefatos da revisão atual e computer_status possui uma consulta nova concluída.
Quatro tarefas foram observadas running ao mesmo tempo, enquanto o chat respondeu
“chat disponível”. As diretivas preservaram o histórico; não houve edição manual
do banco nem repetição de efeitos externos.

A implantação final drenou todos os contadores ativos, encerrou manutenção e
preservou pausa desativada na revisão 16. O primeiro reinício teve exceção restrita
para um único recibo completo legado de computer_status já comprovado como leitura;
a nova contagem corrigiu essa ocupação sem alterar o recibo. No último reinício,
todos os contadores estavam em zero antes e depois da troca de imagem.
Os recibos estão em `artifacts/resume-recovery/deployment-*.log`.

## Limites e limpeza

Os worktrees integrados foram removidos; resta apenas o checkout principal.
Cópias locais excedentes de catálogo e diffs recuperados foram arquivados antes
na pasta `artifacts/resume-recovery/`. Nenhuma chave foi incluída no código,
bundle ou registros públicos.

Google OAuth, FCM, chave MiMo e aceite em telefone físico continuam dependentes
das contas/aparelho correspondentes. A observação de 24 horas iniciada às 06:25
UTC termina em 4/10/2026; esta retomada não equivale à conclusão desse ensaio.
