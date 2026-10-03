# OkamiBot: instalação e aceite em 3 de outubro de 2026

O código dos doze marcos está implementado. A instalação técnica usa a VPS e a
Lenovo existentes; o aceite de uso diário pela esposa ainda depende de
conectores, push e ensaio no celular físico. ChatGPT e Grok estão conectados. Este documento registra
resultados observados, sem equiparar testes com fixtures a contas reais.

**Acesso ao produto:** [primeira entrada pelo navegador e Android](FIRST-ACCESS.md).
A raiz HTTPS agora serve a interface web; `/api` e `/executor` preservam o backend.
O export web foi reconstruído com cache limpo e URL HTTPS de produção, sem novo
container e sem reiniciar a API.

Atualização após o primeiro aceite real: o domínio público
`https://app.okamibot.cloud` está acessível via Cloudflare Tunnel, sem Tailscale no
aparelho do usuário. Entrada web com chave e cookie seguro verificada nesse
domínio. API sem autenticação retorna 401; rotas de executor e manutenção
retornam 404 no gateway público. O hostname privado continua disponível.
O retrabalho de produto está descrito no
[plano de implementação](superpowers/plans/2026-10-03-product-rework.md) e no
[registro da retomada](superpowers/plans/2026-10-03-product-rework-resume.md).

A versão anterior da web e dos APKs usava a fonte mobile `40390aa`: navegação desktop, EN/PT-BR,
configurações de nome/personalidade, cinco avatares 3D animados e editor de
aparência. O visualizador mantém a imagem durante polling e entrada manual.
O build anterior permanece em `/opt/okami-web/releases/40390aa-public` para rollback.

A revisão visual inspirada no Muse usa a fonte mobile `abb6f84` e o build web
`/opt/okami-web/releases/abb6f84-public`. Refez os cinco personagens locais,
poses de trabalho/resposta, retrato na conversa, personalização visual, previews
sem despejo de JSON, histórico de navegador e recibos compactos com detalhes
preservados. A suíte no pin passou **928/928 testes**, além de TypeScript,
build web/servidor e verificações focais de interface. O backend permaneceu
na mesma imagem durante essa publicação. Evidências e referências estão no
[registro da revisão Muse](superpowers/plans/2026-10-03-muse-experience.md) e
em `artifacts/muse-rework/` e `artifacts/android/muse-release-evidence/`.
A API continua na imagem `openmuse-server:product-d6fa127`, com fonte registrada
em `/root/okami-deployment/source-pin`. A publicação anterior dessa imagem drenou o trabalho ativo e
preservou a pausa na revisão 16, desativada; ao terminar, manutenção encerrada e
contadores de tarefas, admissões, recursos, operações, entregas e HTTP zerados.

A validação final em `d6fa127` passou **908/908 testes Node**, TypeScript e build
do servidor. Biome terminou sem erros (189 avisos existentes e duas informações).
O renderizador 3D e os fluxos reais de web/Android foram verificados separadamente;
recibos e logs estão em `artifacts/resume-recovery/` e `artifacts/android/`.

O aceite real da retomada concluiu cinco tarefas: quatro planos em texto com
artefatos da revisão atual e uma consulta `computer_status` com observação nova.
Quatro tarefas foram observadas em execução simultânea enquanto o chat respondeu
“chat disponível”. Os pedidos foram retomados por diretivas normais, preservando
recibos anteriores, sem repetir comandos ou efeitos externos. Evidência local:
`artifacts/resume-recovery/live-tasks-verified.json`.


Na implantação técnica anterior, passaram 867/867 testes Node, os três projetos
TypeScript, 92/92 testes Python do computador e 49/49 testes de scripts, incluindo
criptografia age real. A fonte instalada na Lenovo continua `985b51d`; esses
resultados são do aceite anterior e não equivalem a uma nova execução nesta retomada.
O limite operacional de contexto em ChatGPT/Grok é 131072: orçamento de admissão
do app, não medição da janela máxima do modelo.

## Instalação observada

| Máquina | Serviços e dados |
| --- | --- |
| VPS `100.113.59.40` | API e único escritor PGlite, worker de tarefas embutido, Chromium de reserva, OpenBao 2.7.1/Raft; código em `/opt/openmuse`, configuração privada `.env`, volumes persistentes. Hermes existente preservado. |
| Lenovo `100.91.96.14` | Supervisor `okami-executor@lenovo-okami`, sessão `okami-session@lenovo-okami`, Xfce/X11 e Chromium, workspace/home persistentes, LibreOffice, ferramentas de arquivos e Whisper small CPU/int8. Código de execução root-owned em `/opt/okami-computer`. |
| Aoostar | Máquina administrativa já existente: build Android, evidências e recuperação cifrada. Não é um terceiro servidor necessário ao funcionamento do bot. |

A conta nativa `okami-bot` conserva sudo e grupos existentes, SSH e RDP. Não há VM
nem limite individual fixo de 8 GB. É uma conta de confiança total: sudo amplo
permite contornar controles locais; não se promete isolamento contra esse usuário.
A RAM física medida foi 15.887.069.184 bytes; o orçamento agregado dos bots deixa
4 GiB para o host, resultando em 11.592.101.888 bytes. Aplicativos acima de 8 GB
continuam sujeitos à admissão e a um ensaio real de capacidade.

Na VPS, API 1 GiB + Chromium 2 GiB + OpenBao 256 MiB + reserva Hermes 2.304 MiB +
sistema 1 GiB totalizam **6.979.321.856 bytes**, abaixo de 7 GB decimais. Swap de
4 GiB foi instalado e persistido. Limites não representam consumo medido contínuo.
O serviço fica em `100.113.59.40:8787`, acessível pela tailnet; nenhuma porta pública
do bot nem Tailscale Funnel foi habilitado. O HTTPS privado está ativo em
`https://srv1667308.tail107988.ts.net`: HTTP 200, certificado validado sem bypass
e TLS 1.3 verificados da Aoostar. Serve/Funnel indica acesso somente pela tailnet.

O OpenBao foi inicializado com selo estático, testado com gravação/leitura/exclusão,
e usa tokens periódicos distintos para broker e snapshot. A renovação real passou;
o timer renova de hora em hora. O token root inicial foi revogado depois de guardar
recuperação/selo cifrados na Aoostar. O cofre não tem senhas pessoais cadastradas.

## Verificações reais concluídas

- Take control pela API: assumir 264 ms, captura 311 ms, confirmação de input
  266 ms, devolver ao agente 156 ms. São amostras pontuais, não percentis de carga.
- Comando nativo em background; leitura/escrita Unicode no workspace; criação
  de DOCX, PPTX e XLSX e preview DOCX → PDF pelo LibreOffice.
- Exportação e download pela API dos quatro arquivos: DOCX 36.600 bytes,
  PPTX 28.104, XLSX 4.828 e PDF 13.379; assinaturas ZIP/PDF, tamanho e hashes
  conferidos. Recibos privados em `/root/okami-deployment/media-smoke-result.json`
  na VPS. A publicação tem autorização própria, independente do bloqueio da
  leitura já concluída na Lenovo.
- Whisper small processou um WAV silencioso de dois segundos pela API, com saída
  de texto e SRT. O pin `av==18.1.0` corrigiu a incompatibilidade real do decoder
  com PyAV 19. Isto não mede reconhecimento de fala em português/inglês/alemão.
- O encerramento da API libera consultas nativas longas sem ultrapassar o limite
  de parada. Testes cobrem HTTP real, entrega ainda não autorizada e preservação
  de operações pendentes para recuperação após reinício.
- Retomada da Lenovo após parada para backup: a espera limitada pelo socket
  gráfico evita colocar a sessão recém-iniciada em quarentena. Na instalação
  do ensaio de retomada, a pausa foi liberada na revisão 12; `FreezerState=running`, display,
  captura, entrada e navegador prontos, sem erros novos no supervisor.
- Reinício controlado da API com saída 0 e sem OOM; após os testes, os contadores
  de tarefas, operações, recursos, entregas nativas e HTTP em andamento estavam
  todos em zero. Não foi simulado corte físico de energia.

Dois pedidos de aceite que falharam durante correções foram conciliados
individualmente com provas de não despacho ou leitura concluída/publicação ausente.
O estado anterior e o registro de operador foram preservados no banco. Nenhum
resultado externo incerto foi convertido genericamente em sucesso nem repetido.
O pareamento temporário usado pelo operador nesses testes foi revogado; os arquivos
locais com seus tokens foram removidos. Isso não revoga o acesso do futuro telefone.

## Backup e observação prolongada

As conexões de backup usam chaves SSH distintas, com comando forçado e origem
Tailscale fixa. Tentativas de comando arbitrário foram recusadas. As identidades
age privadas ficam na Aoostar, fora dos dois hosts de execução. Selo/recuperação
OpenBao, assinatura Android e configuração administrativa foram cifrados e suas
cópias de recuperação foram verificadas em `/root/okami-recovery`.

O backup coordenado do banco, perfis, cofre e workspace concluiu com saída 0:
VPS com 4.788.210 bytes e Lenovo com 642.848 bytes, ambas as cópias cifradas e
transferidas ao outro host com checksum. API e navegador confirmaram parada limpa.
A restauração real passou em diretórios privados da Aoostar, sem iniciar o app,
executor ou cron restaurados. O lote `f30ef47d-4247-427c-bd6d-09beb9df0f9f` preserva
a pausa histórica 9; ciphertexts e checksums coincidiram entre origem, peer e
Aoostar. PGlite: 305 registros, 36 tipos e uma publicação cujo tamanho/hash
corresponde ao workspace restaurado. Na Lenovo, sete bancos SQLite passaram na
checagem de integridade; 14 links internos foram preservados e 42 externos foram
omitidos com registro. Um cache Tracker não pôde ser verificado porque depende
de um tokenizer específico; isso não foi tratado como prova de corrupção.

O snapshot Raft de 24.601 bytes foi restaurado no OpenBao 2.7.1 isolado por loopback:
permissões dos dois tokens periódicos órfãos e revogação do root inicial preservadas,
reinício com abertura automática pela chave correta e recusa com chave incorreta.
O processo de inspeção foi encerrado e sua chave temporária removida. As provas
ficam em `/root/okami-recovery/coordinated-backup-proof.json` e
`/root/okami-recovery/raft-inspection-20261003T061807Z-c826989b/proof.json` na Aoostar.

O timer diário está habilitado, com persistência, às 03:30 Europe/Berlin e atraso
aleatório de até 15 minutos; próxima execução observada: **4/10/2026 às 03:38:10**
(01:38:10 UTC). Nenhum ciclo extra foi iniciado ao habilitá-lo.

A observação de 24 horas começou em 3/10 às **06:25:09 UTC na VPS** e
**06:25:59 UTC na Lenovo**; término previsto no dia 4 nos mesmos horários.
Amostras de metadados são coletadas a cada minuto, sem telas, conteúdo ou segredos.
Primeira amostra: API acessível nos dois hosts; 5,29 GiB livres na VPS e 11,64 GiB
na Lenovo, com métricas de cgroups disponíveis. As capturas ficam em:

- VPS: `/var/lib/okami-soak/soak-vps-20261003T062509Z.jsonl`.
- Lenovo: `/var/lib/okami-soak/soak-lenovo-20261003T062559Z.jsonl`.

Cada captura terá relatório `.report.json` ao terminar, privado de root.
São jobs únicos, sem autostart.
**A coleta foi iniciada, ainda não concluída**; não se infere estabilidade
prolongada dos testes curtos nem latência de chat a partir do healthcheck.

## Android

Fonte mobile final: `40390aa`; identificador técnico `app.openmuse.mobile` e scheme
`openmuse` preservados. Os APKs usam a chave persistente privada do projeto,
assinatura verificada, release não debuggable e certificado SHA256
`e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.
Ambos usam `https://app.okamibot.cloud`, sem Tailscale no aparelho.

- [ARM64 para o telefone](https://app.okamibot.cloud/downloads/okamibot.apk?v=40390aa):
  52.809.546 bytes; SHA256
  `4923208c4255b2a99f6a45598ee80a81308043da1193befb66b10fa7e64a1557`.
  O download público foi comparado ao build local assinado.
- [x86_64 para o emulador](../artifacts/android/public-release/okamibot-release-x86_64.apk):
  54.554.385 bytes; SHA256
  `755d6981c5fa1cabdc46920b9d0331987e46368550ba5888acb1473f7df5dff2`.
- Recibos de assinatura/proveniência ficam junto dos APKs em
  `artifacts/android/public-release/`. Evidências de interface ficam em
  `artifacts/android/public-preflight-evidence/` e
  `artifacts/android/public-release-evidence/`. Esses artefatos são locais e
  ignorados pelo Git.

A atualização no emulador preservou pareamento e rascunho e acessou o workspace
real por HTTPS público. Nome, personalidade e avatar foram salvos e conferidos
após reinício; os valores anteriores foram restaurados e relidos. O log final
filtrado do processo não apresentou erros. O recibo de aceite é
`artifacts/android/public-release-evidence/receipt.json`. A verificação nativa cobriu seleção persistente de idioma,
menu, configurações, cinco espécies, animação 3D e controles do editor; cor
inválida impede salvar. No navegador, a verificação real cobriu salvar e recarregar
nome/personalidade, preset e aparência personalizada, além de assumir controle,
entrada de teclado/mouse e devolução ao agente sem remover a imagem da tela.

Instale o ARM64 como atualização se já houver app compatível, preservando dados.
Se a assinatura não corresponder, interrompa sem desinstalar/limpar dados para
contornar o problema. Keystore e senhas não são necessários para instalar o APK.

## Ativação que ainda depende de contas ou aparelho

1. Instalar o APK ARM64 pelo link público acima e parear com a chave privada do
   workspace. O telefone não precisa entrar na tailnet.
2. ChatGPT e Grok já foram autorizados: OAuth oficial com permissão de assinatura
   no ChatGPT, arquivo importado preservando a identidade própria da VPS, e device
   flow no Grok. A cópia temporária com tokens do laptop foi removida após importar.
   Por solicitação do usuário, o padrão é **`chatgpt/gpt-6-luna`**. Apesar de esse
   identificador não aparecer no catálogo inicial, a chamada real retornou HTTP 200,
   resposta completa e chamada de ferramenta no namespace `openmuse`. O fallback
   **`grok/grok-4.6`** também respondeu de fato, sem recorrer a outro provedor.
   A API está saudável com `agentConfigured:true`; a manutenção terminou sem pausa
   ativa (revisão 16). MiMo permanece configurado depois do Grok, aguardando sua chave
   Token Plan. As credenciais continuam privadas, sob o usuário da API, e a renovação
   automática está habilitada. Para reautorizar ou adicionar MiMo, seguir
   [MODEL-BACKENDS.md](MODEL-BACKENDS.md). Assinaturas Anthropic/Cursor não foram integradas.
3. Para e-mail/agenda reais, configurar Google OAuth e conectar pelo app; o fuso
   do deployment é `Europe/Berlin`. MCP/Composio são opcionais. Segredos entram
   somente nos arquivos/campos privados apropriados, nunca no chat de conversa.
4. Configurar credenciais de push Android/FCM e verificar recepção com o app fechado.
   API de notificações e testes com fixtures não comprovam entrega física.
5. Parear o telefone com a chave privada do deployment e testar três tarefas reais,
   incluindo orientação durante trabalho, quatro trabalhos concorrentes e tomada
   de controle. Falhas transitórias não devem exigir novo pareamento.

Ainda sem aceite físico: Wi-Fi/energia/reboot, cinco sessões leves, Blender/Android
Studio/emulador ou carga acima de 8 GB, persistência de login real no navegador,
senha/OTP de uma conta real e 24 horas completas de observação. Contas remotas,
qualidade dos modelos e seus limites não são dedutíveis dos testes automatizados.

## Operação

Na VPS, o procedimento ativo é o híbrido (não o computador Docker legado):

```sh
cd /opt/openmuse
docker compose -f docker-compose.yml -f deploy/compose.hybrid.yml ps
curl --fail http://100.113.59.40:8787/api/health
systemctl status okami-openbao-renew.timer okami-hybrid-backup.timer
```

Na Lenovo, use `systemctl status okami-executor@lenovo-okami.service
okami-session@lenovo-okami.service` e o [guia híbrido](../deploy/HYBRID.md).
Não abrir dois escritores no diretório PGlite nem iniciar executores restaurados
contra a API ativa. Restaurações ficam em diretórios isolados para inspeção.

MIT e avisos das dependências foram preservados. Não foi adicionada dependência
SaaS obrigatória nem licença paga para o cofre.
