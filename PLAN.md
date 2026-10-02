# OkamiBot pessoal: VPS + Lenovo

Plano revisado em 2026-10-02, sobre o código `a9fe722`. **Planejamento; implementação ainda não iniciada.**

Versão consolidada com revisão dos **65 PRs abertos** no upstream nessa data, incluindo diffs, comentários/reviews disponíveis e estado de CI. Main upstream observado: `9ec439f`, apenas uma alteração de link no README acima da base `6c56494`. PR aberto/CI verde não significa validação no nosso fork; incorporar correções seletivas e regressões dentro dos marcos abaixo.

**Nome previsto do produto: OkamiBot**, derivado do OpenMuse. A marca pública, o nome que a usuária dá ao assistente e a conta Linux são conceitos separados. Preparar a identidade visual sem renomear agora pacotes, IDs do app, volumes ou dados existentes; preservar a origem e os avisos MIT.

## Objetivo acordado

Uma usuária conversa pelo celular enquanto até quatro tarefas avançam em background. Novas mensagens não cancelam tarefas; orientações alteram a tarefa escolhida no próximo ponto seguro. O app permanece pareado. O Lenovo i7-1255U, 16 GB, SSD 512 GB e Ubuntu 26.04 fica ligado 24/7 por Wi-Fi e fornece um computador gráfico próprio ao agente. O VPS continua atendendo chat e pode executar navegação de reserva quando o notebook cair. **Somente as duas máquinas existentes; sem navegador adicional separado do ambiente do bot.**

## Arquitetura recomendada

- **VPS 2 vCPU / 8 GB:** API, chat, modelos e fallbacks, banco, memória, agenda, scheduler, recibos, arquivos publicados e push. Manter o browser Playwright de reserva, com perfil próprio. Um processo continua sendo o único escritor PGlite.
- **Lenovo sem VM:** uma conta Linux nativa por bot, começando por `okami-bot`, com home, workspace, perfil Chromium e sessão gráfica próprios. Supervisor no Ubuntu conectado ao VPS por Tailscale. Cinco contas/sessões simultâneas são possíveis; concorrência de programas depende de RAM/CPU/GPU disponíveis.
- **Privilégios propostos:** conta de trabalho sem sudo irrestrito e serviço administrativo com operações fixas para manutenção permitida. Sudo amplo foi cogitado pelo usuário e continua uma opção de confiança total: permitiria alterar o host, outros usuários e as próprias restrições; não combina com prometer isolamento entre bots. Nada foi configurado nesta revisão.
- **Credenciais sem licença paga:** OpenBao no mesmo VPS, formulário inline no chat com envio direto ao cofre e broker que faz login no browser Lenovo ou VPS. Senha fica fora do caminho normal de transcript/contexto/logs, mas processos do próprio usuário podem acessar sua sessão/perfil mesmo sem sudo. Sudo amplo alcança também outros usuários. Composio continua opcional.
- **RAM compartilhada:** sem reserva ou teto fixo de 8 GB por usuário. CPU/RAM são geridas em conjunto por systemd/cgroups; um aplicativo pode passar de 8 GB quando houver espaço. Teto agregado calculado sobre RAM realmente utilizável, deixando margem inicial de 3–4 GiB para sistema/serviços e ajustando por medição. Um limite não pré-aloca memória.
- **Desktop por conta:** Xfce + Xvnc/X11, Chromium com interface, Office, terminal e workspace persistente. É uma tela virtual do mesmo Ubuntu, sem outro sistema operacional. Blender/Android Studio/emulador são possibilidades futuras; GPU, aceleração e capacidade real precisam de ensaio específico.
- **Concorrência:** quatro unidades de trabalho em background no total entre hosts; chat tem admissão prioritária própria. Um controlador por desktop/perfil autenticado; trabalhos independentes de API, pesquisa e arquivos podem avançar simultaneamente. Uma carga pesada local por vez inicialmente.
- **Fallback de execução:** navegação pública elegível pode seguir no VPS; sessão autenticada precisa existir no executor de destino. Queda durante uma ação externa exige reconciliação antes de repetir. Arquivos publicados ficam disponíveis no VPS; arquivos ainda somente locais dependem de transferência/reconexão.
- **Fallback de modelo:** cadeia configurável de rotas já suportadas, por exemplo ChatGPT → Grok/xAI → MiMo, filtrada por visão/ferramentas/contexto. Local é opcional após medição. Retomar checkpoints sem repetir efeitos externos.
- **Celular:** pareamento persistente por aparelho, tokens curtos renovados silenciosamente, fila local, replay por cursor e cartões de tarefa com orientação recebida/aplicada.
- **Interações no chat:** cartões nativos com pergunta, alternativas, seleção múltipla ou texto livre. Credenciais usam campos protegidos no próprio cartão: o valor vai direto ao cofre e o agente recebe somente confirmação. Cartões pendentes não bloqueiam novas mensagens nem outras tarefas.
- **Personalização por conversa:** “me chame de Ana”, “seu nome é Luna”, “responda de forma curta, em português, sem emojis” alteram o perfil persistente quando esse for o pedido. Estilo de um texto/tarefa permanece local. Chat, tarefas e rotinas usam o mesmo serviço de perfil, independente do modelo; mudança de personalidade não interrompe trabalho nem muda permissões. Configurações permitem consultar, editar e restaurar o padrão.
- **Proatividade por heartbeat:** revisar e-mails sem resposta, trabalho humano incompleto e planos ainda não iniciados a cada intervalo configurado; proposta inicial de quatro horas, ajustável por conversa. Usar evidências do chat, tarefas, arquivos e conectores autorizados; sugerir próximos passos em cartões e push. Retomar trabalho já delegado dentro do escopo; propor início de novos objetivos. O ciclo roda no VPS, usa os mesmos quatro slots e continua útil com Lenovo offline. Esse heartbeat de produto é diferente da sonda de saúde do executor.
- **Entregas verificadas e prazos:** conferir resultado antes de marcar sucesso, explicitar entrega parcial e revalidar prazo obrigatório antes de efeitos externos, inclusive após queda. Prioridade pode ser alterada pelo chat sem cancelar outras tarefas.
- **Recuperação e controle explícito:** versões anteriores/lixeira para alterações gerenciadas de arquivos e pausa global persistente de automações, independente do modelo. Mostrar confirmação por executor; só retomar quando a usuária pedir. Conversar normalmente não aciona pausa.
- **CAPTCHA:** agente tenta primeiro com DOM/visão e controles disponíveis, até três submissões ou 60 segundos por desafio lógico, valores configuráveis. Ajuda humana quando não resolver, faltar capacidade ou o site exigir intervenção. Preservar sessão e progresso; MFA/OTP/passkey não são códigos para adivinhar.
- **Referência OpenMausBot:** incorporar fila/orientação com recibos explícitos, reserva do computador somente quando necessária, observação visual econômica, memória com versões/desfazer e procedimentos reutilizáveis. Adaptar ao motor OpenMuse e à UI móvel; análise e limites no documento abaixo.
- **Referência Noodle:** separar personalidade, preferências e memória; reunir arquivos/sessões por conversa; permitir comentar texto ou uma região de captura; negociar capacidades entre VPS e Lenovo e melhorar viewer/transferências em rede lenta. Aproveitar conceitos, sem migrar para Swift/macOS nem adicionar máquinas. O desktop nativo analisado ainda não oferece cliques/digitação ao agente.
- **Revisão upstream:** priorizar correções de sessão/chave, replay após erro, concorrência/cancelamento, datas de calendário, parsing de e-mail e artefatos idempotentes. Aproveitar contratos de busca, progresso de metas e conexões MCP; preservar nosso storage/backend/policy. Excluir E2B como computador obrigatório, Parallel como busca padrão, stdio arbitrário no VPS e bypass da chave de acesso. A matriz de PRs indica casos já cobertos e testes ainda necessários.

## Entregas, em ordem

| Marco | Resultado verificável |
| --- | --- |
| 1 | Sessão durável e app abre mesmo com Google indisponível. |
| 2 | Mensagens/outbox, perguntas duráveis e personalidade editável pelo chat; conversa não depende da vida de uma tarefa. |
| 3 | Scheduler com quatro slots, prioridades, recursos exclusivos e pausa global explícita. |
| 4 | Orientações/checkpoints/recibos, prazos e conclusão verificada; retomada de jobs e rotinas. |
| 5 | Fallback de modelos com prioridades, capacidades e limites por provedor. |
| 6 | Supervisor remoto, usuários Linux nativos, recursos compartilhados, pausa e arquivos recuperáveis. |
| 7 | Desktop gráfico, observação por DOM/imagem conforme necessidade e assumir/devolver controle no celular. |
| 8 | Cofre no VPS, login por referência, cartão inline e tentativa de CAPTCHA antes de pedir ajuda. |
| 9 | Roteamento Lenovo/VPS com fallback de navegador, perfis independentes e proteção contra execução duplicada. |
| 10 | Histórico compacto, memória/perfil com versões e desfazer, recuperação dentro do limite de contexto. |
| 11 | Anexos, voz, procedimentos e rotinas; heartbeat proativo com sugestões no chat e notificações. |
| 12 | Cenários de comportamento, instalação real, push físico, quedas, restauração e medição dos dois hosts. |

Cada marco tem commit próprio, documentação e `pnpm test` passando; testes de integração específicos complementam a suíte. Preservar MIT, demo, adapters atuais e estrutura upstream. A política live continua pedindo aprovação para dinheiro; permissões e recibos não dependem apenas de instruções ao modelo. Não há nova dependência SaaS obrigatória.

Revisão de produto aceita: verificar entregas, respeitar prazos, recuperar arquivos e oferecer pausa global. O usuário substituiu a proposta de horário de silêncio por iniciativa periódica do assistente; heartbeat proativo entra no marco 11, sem um horário de silêncio imposto. Validação inclui três tarefas reais da usuária com resultado utilizável pelo celular.

## Documentos de execução

- [Arquitetura, decisões e limites](docs/plans/2026-10-02-lenovo-agent-design.md)
- [Plano de implementação e aceites por marco](docs/plans/2026-10-02-lenovo-agent-implementation.md)
- [Cofre, login e CAPTCHA sem licença paga](docs/plans/2026-10-02-private-credentials.md)
- [Aproveitamento do OpenMausBot e prioridades](docs/plans/2026-10-02-openmausbot-review.md)
- [Aproveitamento do Noodle, personalização e limites](docs/plans/2026-10-02-noodle-review.md)
- [Revisão dos PRs upstream e decisões de integração](docs/plans/2026-10-02-upstream-pr-review.md)
- [Plano anterior concluído e evidências históricas](docs/plans/2026-10-02-vps-milestones-completed.md)

Não houve acesso ao notebook, provisionamento, alteração de permissões/Tailscale ou validação de contas reais nesta revisão. A disponibilidade 24/7 por Wi-Fi foi confirmada pelo usuário. RAM utilizável, GPU, sessões simultâneas, espaço livre e recuperação após energia serão verificados na instalação. KVM só é relevante se um futuro emulador Android precisar dele; não haverá VM hospedando o bot.
