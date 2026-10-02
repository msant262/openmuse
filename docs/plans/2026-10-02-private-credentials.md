# Cofre, login e desafios no chat

Adendo solicitado em 2026-10-02 ao [plano híbrido](../../PLAN.md). Estado: planejamento, sem instalação nem coleta de credenciais. O usuário citou Composio como exemplo e esclareceu que prefere open source sem custo de licença, somente as duas máquinas existentes e os browsers do Lenovo e do VPS. A decisão posterior para o Lenovo é usar contas Linux nativas com RAM compartilhada, sem VM nem container.

## Decisão

Usar **OpenBao self-hosted** como cofre de novas senhas/chaves, com um **CredentialBroker** próprio e formulário confiável no OkamiBot, derivado do OpenMuse. OpenBao é MPL-2.0 e oferece KV v2 por API; não requer licença paga para executar sua distribuição aberta. Preservar seus avisos e MIT do OpenMuse. O adapter de armazenamento permanece substituível; a criptografia existente de Google continua funcionando sem migração obrigatória nesta entrega.

Comparação: Vaultwarden é alternativa open source voltada a gerenciador de senhas/clients Bitwarden, mas ainda exigiria um broker para automação. Ampliar o AES-GCM existente evita outro serviço, porém deixa políticas, versões, auditoria e rotação inteiramente sob nossa manutenção. OpenBao foi escolhido pela API e separação de políticas, considerando outros bots no futuro. Não instalar os três produtos. Não depender de Composio ou de plano pago.

**Cofre não substitui conectores.** OAuth/API seguem adapters nativos e MCP allowlisted. Composio documenta autenticação/execução de contas suportadas; não é mecanismo de autofill universal de sites. OpenBao guarda segredos, enquanto OpenMuse implementa uso autorizado e login de sites explicitamente suportados.

## Experiência da usuária

1. A tarefa precisa de conta e publica um cartão “Conectar serviço” **dentro do chat**, identificando finalidade, conta e domínio. Seguir o exemplo visual fornecido pelo usuário: título, explicação curta, controles de entrada e botão de envio no fluxo da conversa.
2. Para OAuth, o botão do cartão abre autorização oficial no navegador do sistema; não pedir senha Google/GitHub em caixa própria. Para senha/API key suportada, expandir campos nativos protegidos **no próprio cartão**, sem exigir ir a configurações ou assumir o computador. Estar visualmente no chat não significa serializar o valor no transcript.
3. Usuária preenche e escolhe salvar. Valor segue direto à rota autenticada de credenciais, sem chat, AG-UI, outbox de mensagens, memória, analytics, logs ou push. Não persistir rascunho de senha; erro de rede pode exigir redigitar o campo.
4. Broker grava no cofre e valida uso. Modelo recebe somente referência/identidade pública e `connected`, `needs_challenge`, `invalid_credentials` ou erro limitado. Salvar segredo não equivale a login validado.
5. Evento persistido acorda somente tarefas vinculadas à conexão/revisão. Outras tarefas e chat continuam. Submit/callback duplicado não duplica conexão nem retomada.
6. Se houver CAPTCHA, o agente tenta resolver primeiro pelos controles disponíveis, conforme o orçamento abaixo. Solicitar ajuda somente quando não concluir ou não puder executar o desafio. MFA usa seu fluxo próprio: OTP fornecido pela pessoa é efêmero e não salva semente TOTP por padrão; passkey ou confirmação no aparelho podem exigir presença humana. Não há promessa de login automático em qualquer site.

## Mesmo padrão para perguntas

Adotar `InteractionRequest` como envelope durável com requestId, kind, taskId/revisão, título, descrição, schema confiável de campos e estado. Kinds: `question`, `credential`, `oauth` e `approval`. A UI usa componentes React Native fixos, nunca HTML/JavaScript fornecido pelo modelo. Perguntas podem conter escolha única, múltipla, texto livre e resposta livre alternativa; listas têm labels claros, foco/teclado/acessibilidade e botão “Enviar resposta”. Copiar o padrão de interação da imagem, sem interpretar as opções de modelos nela como pedido de trocar o modelo desta conversa.

Para `question`, enviar resposta estruturada ao ator/mailbox; pode ser registrada no contexto e na outbox normal. Para `credential`, payload segue somente ao broker e o evento contém referência/status. Para `oauth`, renderizar botão confiável de autorização e estado verificado. `approval` sempre aponta a proposta real do ActionService: responder “sim” a uma pergunta comum não aprova uma compra. Modelos não podem transformar campos comuns em coleta de segredo ou inventar destino de credencial.

Estados visuais: aguardando, enviando, resposta recebida/credencial salva, conectando quando aplicável, concluída, expirada, cancelada e erro recuperável. “Credencial salva” só após confirmação durável do cofre; “conta conectada” só após login validado. Mudança de revisão/conclusão da tarefa invalida resposta velha com explicação; reenvio/duplo toque é idempotente.

Fechar/reabrir restaura cartão e status. Respostas comuns podem recuperar rascunho; segredo/OTP em edição não é persistido. Renovar um request de credencial expirado preserva a tarefa e permite preencher novamente. Teclado e campos não bloqueiam o composer geral; user pode continuar conversando. Só a tarefa que precisa da resposta entra em espera segura, liberando recursos quando não há operação em andamento. Outras tarefas continuam.

Exemplo textual de cartão de credencial:

```text
Conectar ao Portal X
Destino: https://portal.exemplo.com · Para consultar seus documentos
E-mail: [                     ]
Senha:  [ •••••••••••••••••• ]
[Salvar e continuar]
Seu dado é enviado ao cofre; a conversa guarda somente o status.
```

O exemplo usa domínio fictício e não representa conta conectada. O mesmo layout para pergunta usa alternativas e campo livre, sem o canal de credenciais.

## Duas máquinas e limite de confiança

**VPS:** API, banco, coordenação, OpenBao/broker e navegador headless de reserva. **Lenovo:** supervisor confiável e um UID Linux por bot, com home/perfil privados e sessão gráfica Xvnc + Xfce própria, Chromium, Playwright e arquivos de trabalho. Agente e pessoa usam o mesmo navegador e perfil da sessão daquele bot. Começar com a conta `okami-bot` e permitir até cinco contas/sessões conforme capacidade medida; isso não aumenta o limite global de quatro tarefas. Não criar browser protegido separado, VM, container ou terceira máquina.

Um programa executado no mesmo UID do navegador pode ler arquivos de perfil/cookies e acessar credenciais da própria sessão mesmo sem sudo, conforme os mecanismos usados pelo navegador. A proteção pretendida é manter segredos fora dos caminhos normais de conversa, modelo, logs e ferramentas e impedir acesso entre contas distintas. Não prometer que o segredo utilizado no browser é inacessível a programas do próprio bot. Máscaras de tela e filtros de ferramentas não mudam esse limite.

**Recomendação de privilégios a implementar e validar:** contas dos bots sem sudo amplo, sem grupo Docker e sem capacidade de alterar supervisor, firewall ou watchdog. Necessidades administrativas passam por helper pertencente a root, com operações fixas, argumentos validados e arquivos/configuração não graváveis pelos bots; não oferecer shell, `apt` genérico ou escolha arbitrária de executável como operação privilegiada. Instalação/configuração administrativa que exceda esse contrato fica com o operador. Esta recomendação não afirma que privilégios já foram removidos. Sudo amplo no host permitiria ao bot ler outras contas e modificar firewall/watchdog, eliminando a separação pretendida.

O cofre/broker fica no VPS fora do ambiente modificável pelo agente. Browser Lenovo ou VPS recebe somente a credencial necessária por canal privado autenticado para uma operação de login vinculada. Contas dos bots, ferramentas e MCP não recebem token OpenBao nem chave mestra, e não têm acesso direto à API do cofre. Não disponibilizar ferramenta `get_secret`; `SecretStore` permanece interno ao broker. Essa restrição não impede que um programa do mesmo UID recupere uma senha ou sessão já utilizada por seu browser. Acesso a contas continua sujeito ao ActionService; conexão não concede autorização de compra.

Broker, administradores dos hosts, navegador e site de destino entram na fronteira de confiança. O cofre cifrado protege o armazenamento, mas sua chave no mesmo VPS não protege contra comprometimento root desse VPS. Não alegar zero knowledge ou ausência absoluta de vazamentos. Contas Linux compartilham kernel e recursos: home/perfil privados, permissões de arquivos e sockets, autenticação X11 individual e regras de rede administradas no host devem ser verificadas para impedir acesso entre bots. Um UID diferente sozinho não isola rede nem equivale à fronteira de uma VM; root do Lenovo continua capaz de acessar todas as sessões.

## Contratos propostos

`CredentialRequest`: ID aleatório, owner derivado da sessão, taskId/revisão, adapterId, serviço, origem HTTPS exata, finalidade, campos previstos no adapter, nonce/expiração e estado. O modelo solicita um serviço; não fornece HTML de formulário, URL de coleta, domínio de exfiltração ou campos arbitrários. Serviços novos precisam de vínculo a origem conferida pela pessoa/operador.

`CredentialRef`: ID opaco e versão, sem valores. `ConnectionStatus`: identidade pública, estado e adapter. Propriedade, conta, destino e versão são validados a cada uso/revogação. IDs não são autorização suficiente.

`LoginGrant`: uso único com TTL inicial 60 s, vinculado a credentialRef/version, task/revision, accountId, executorId/epoch, profileId, fence e login adapter. Broker valida novamente ao consumir. Request de coleta vence em 10 min, pode ser renovado sem duplicar a conexão, e o valor nunca entra em journal de tarefas.

`SecretStore` é interface interna do broker, com put/update/delete e leitura somente para execução confiável; não é ferramenta do agente. Adapter OpenBao KV v2 usa paths por proprietário/bot, CAS para rotação, autenticação de serviço restrita e política distinta de administração. Não usar root token no OpenMuse. SecretStore não aparece nos schemas de tools ou MCP.

## Login por referência

Login é operação dedicada `authenticate_connection(connectionRef, sessionId)`, sem argumento password. Adapter confiável fixa fluxo, destinos e campos de autenticação; não permitir ao modelo escolher uma caixa de busca ou campo público para receber segredo, mesmo no domínio correto.

Reservar sessão e validar HTTPS, frame, origem, form action, redirects permitidos, conta, lease e grant. No estado `filling_credentials`, suspender observações do modelo, capturas, traces/HAR/replays e ações concorrentes. Retornar somente status validado, sem valores de inputs/cookies. Tratar erros de login com mensagens limitadas. Não colocar senha no argumento `browser_act.fill.value`, em argv/env ou no journal de tarefas.

Marcar campos/áreas preenchidos como sensíveis mesmo após mudar `type=password` para texto; screenshots/previews/assets e snapshots devem respeitar essa marca. Se aparecer CAPTCHA, transitar para `challenge_detected` e `agent_attempt`, liberando apenas observação sanitizada do desafio, com campos secretos mascarados e sem traces/HAR. Se não for possível separar desafio e dados sensíveis, pedir ajuda. Descartar autenticação intermediária antes de liberar observações normais; `authenticated` exige evidência de sessão válida. O código atual omite somente inputs enquanto são password; isso não basta para o novo contrato.

Cookies e arquivos de perfil também são segredos. Manter perfil em diretório próprio do UID do bot, fora do workspace publicado, excluído de exportações e sincronização comum e inacessível aos demais UIDs. Ferramentas oficiais de entrega de arquivos não o publicam; um programa do mesmo UID pode acessar o próprio perfil, conforme limite já registrado. Browser e desktop podem compartilhar arquivos de trabalho sem exportar o perfil. Redação de strings é defesa adicional.

## CAPTCHA: agente primeiro

Default configurável: até **três submissões de solução ou 60 segundos por desafio lógico**, parando no primeiro limite. Cliques que compõem uma solução não contam como várias submissões; o prazo limita também observações e ações. Persistir challengeId, contador, prazo e receipts. Retry, troca de modelo, restart ou fallback de executor não reiniciam o orçamento do mesmo desafio.

Usar DOM e visão com controles normais do navegador. O contrato atual de `browser_act` por elemento DOM não cobre todo canvas: implementar ação visual via Playwright também no browser headless VPS, vinculada a snapshotId, dimensões, região do desafio, lease e fence. Reobservar após mudança de frame. No Lenovo, as ferramentas visuais do marco 7 também atendem esse fluxo. Não considerar screenshot sozinho uma capacidade de clicar.

Verificar que o desafio terminou antes de retomar a tarefa. Parar antes do limite se houver sucesso, bloqueio/cooldown, perda de lease, takeover, cancelamento, falta de controles/visão ou exigência de presença pessoal. Não renovar a página ou trocar executor apenas para ganhar novas tentativas. Não inventar tokens de sucesso, alterar respostas de verificação, contratar solver SaaS ou adicionar rotação de proxies/stealth.

Quando não conseguir, publicar cartão vinculado à tarefa e manter a sessão disponível para Take control. Somente essa tarefa aguarda; chat e outras tarefas continuam. Ao devolver controle, confirmar estado atual e retomar do ponto seguro. No VPS, o Take control existente deve encaminhar imagem e entrada à mesma sessão headless. Uma submissão com resultado incerto exige reobservação/reconciliação, sem envio duplicado automático.

OTP, passkeys e confirmação no aparelho não são CAPTCHA. Usar fatores reais da pessoa, pelo cartão privado ou autorização apropriada; não tentar adivinhar códigos. A política de aprovação financeira continua valendo durante login e desafios.

## Fallback, revogação e operação

Browser bindings contêm executorId, botId, UID/sessão gráfica atribuídos pelo supervisor, profileId, accountId, epoch, fence e estado de autenticação. O agente não escolhe UID ou display de outro bot. Com Lenovo offline, usar sessão válida no VPS ou pedir ao broker novo login com a referência autorizada; MFA/IP/dispositivo podem exigir interação adicional. Não copiar diretório de perfil aberto entre executores. Queda durante ação externa exige contenção e reconciliação. No Lenovo, supervisor/watchdog confiáveis contêm o grupo de processos da sessão do bot, incluindo browser e subprocessos, sem depender da cooperação do agente; no VPS, o serviço de browser valida seus próprios leases. A contenção exige que a conta não possa reconfigurar o supervisor nem escapar do grupo administrado, o que deve ser validado antes de uso real.

Revogar ou trocar segredo invalida grants pendentes e futuras chamadas. Sessões de browser já autenticadas exigem encerramento/limpeza do perfil e, quando disponível, revogação no provedor; apagar a senha no cofre não desloga sites automaticamente. Preservar efeito já despachado e auditar resultado sem segredo.

OpenBao no VPS com armazenamento persistente integrado Raft de nó único, admitindo ausência de HA, snapshot consistente e restauração ensaiada. Não usar `-dev`, in-memory ou filesystem não transacional como deployment de produção. Não compartilhar PGlite com OpenBao.

Definir auto-unseal com mecanismo estático suportado pela versão fixada, chave protegida fora do DB/workspace e backup separado, sem KMS pago. Host root continua dentro da confiança; verificar proteção do disco/chave e não alegar que chave no mesmo host protege contra comprometimento root. Se cofre permanecer selado após reinício, tarefas dependentes mostram indisponibilidade e chat continua. Testar restart/restore antes de credenciais reais.

Medir memória/CPU e manter conjunto VPS abaixo de 7 GB, incluindo OpenBao e browser. No Lenovo, contas e aplicações compartilham a RAM física, sem reserva fixa de 8 GiB por bot nem multiplicação de orçamento pelo número de usuários. O supervisor aplica teto agregado aos processos dos bots e preserva folga para sistema, supervisor e recuperação, definidos após medir o hardware e as cargas. Uma aplicação pode ultrapassar 8 GiB quando as demais estiverem leves e houver capacidade dentro desse teto. Blender, Android Studio e emulador são usos ocasionais possíveis, não carga ou simultaneidade garantidas; medir seus picos e enfileirar trabalho pesado quando necessário. Backups cifrados cruzados entre VPS e Lenovo abrangem cofre e perfis, com chaves de recuperação administradas fora do agente. Não requer terceiro servidor; cópia offline adicional pode usar mídia já disponível. Nenhum serviço de licença paga é necessário; infraestrutura/operação continuam tendo seus custos existentes.

## Entrega 8 e aceites

Integrar depois do desktop compartilhado (marco 7) e antes do fallback entre executores (marco 9), usando os cartões do marco 2 e o journal do marco 4. Primeiro expor cofre/request/status; só habilitar uso real quando canal de credenciais, adapter de login e ocultação nos caminhos oficiais estiverem validados.

Arquivos novos propostos: `apps/server/src/credentials/{contracts,requests,broker,openbao-store,routes}.ts`, `apps/mobile/src/credential-request.tsx`, `apps/worker/src/credential-login.ts`, `apps/worker/src/challenge.ts`, `deploy/openbao/`, `tests/credential-broker.test.ts`, `tests/credential-login.test.ts`, `tests/browser-challenge.test.ts`, `apps/mobile/test/credential-request.test.ts`. Alterar worker snapshots/screenshots, ação visual, sessão/router, ActionService bindings, config/deploy e docs. Preservar cofre Google/adapters/MCP legados.

- [ ] Fixture de formulário nativo: valores nunca são enviados ao chat/outbox/modelo; conta/domínio/finalidade visíveis; campos derivam de adapter confiável.
- [ ] Cartão inline acessível funciona com teclado, seleção única/múltipla e texto livre; perguntas entram no contexto, segredos não. Reabrir restaura status sem senha; duplo toque não duplica uso; chat e outras tarefas continuam durante espera.
- [ ] Segredo-canário não aparece em transcript, payload de modelo, replay, audit, logs, erro, push, screenshot, assets, trace/HAR ou entregas pelas ferramentas oficiais, inclusive input revelado e falha de login. Não alegar que esse teste impede acesso ao próprio perfil por programa do mesmo UID ou inspeção pelo administrador.
- [ ] Rejeitar owner/task/revisão/domínio/frame/form action/redirect/versão alterados, grant expirado/repetido e coleta para campo público. Testar envio duplicado/resposta perdida com um receipt e uma retomada.
- [ ] Usar fixture real de login nos browsers Lenovo e VPS; conta do bot não alcança API direta do cofre, chave mestra ou token administrativo. Credencial de uso chega apenas à operação vinculada; documentar que o próprio UID pode acessar seu perfil e root pode inspecionar todas as sessões. Não expor tokens do broker em argv/env/arquivos dos bots.
- [ ] No modo recomendado, com duas contas Linux sintéticas, negar leitura do home/perfil, acesso ao display/socket e uso do grant da outra conta. Validar ausência de sudo amplo/grupo Docker e alteração de firewall/watchdog; helper recusa operação ou argumento fora da lista fixa. Suspender/conter uma sessão não afeta o browser da outra. Se configurado sudo amplo, testar indicação de confiança total e ausência de failover mutável baseado em contenção presumida; não alegar que root respeita a separação entre contas.
- [ ] Testar OAuth sem coleta própria de senha, OTP efêmero, MFA/passkey com retorno correto, suspensão de observação durante preenchimento e takeover na mesma sessão.
- [ ] CAPTCHA DOM e visual no Lenovo/VPS: sucesso do agente antes de pedir ajuda; falha por três submissões/60 segundos; incapacidade/cooldown; frame obsoleto; takeover/handback; desafio observado sem senha; restart/fallback sem zerar orçamento; ausência de replay de submissão incerta. OTP não é adivinhado.
- [ ] Testar revogação de segredo versus sessão já aberta, mudança de conta invalidando aprovação pendente e MONEY-only preservado.
- [ ] Lenovo offline: login elegível no VPS com conta/destino conferidos, nenhuma cópia de perfil aberto, nenhum replay de escrita incerta. Cofre selado: chat e tarefas independentes continuam.
- [ ] Reiniciar/restaurar OpenBao real com dados sintéticos; comprovar persistência, auto-unseal e ausência de segredos no backup público. Medir recursos, não só validar YAML.
- [ ] Medir uma e até cinco sessões nativas, com quatro tarefas globais e carga pesada representativa quando definida. Comprovar teto agregado e folga do host, alocação acima de 8 GiB para uma aplicação quando houver capacidade e espera explícita quando não houver; número de contas não implica cinco aplicações pesadas simultâneas.
- [ ] Rodar focais, `pnpm test`, tipos server/mobile/worker e testes reais necessários; documentar limites e commit `feat: collect credentials and handle login challenges inline`.

## Fontes primárias

- [OpenBao LICENSE](https://github.com/openbao/openbao/blob/main/LICENSE): MPL-2.0.
- [OpenBao KV v2 API](https://openbao.org/docs/api/secret/kv/kv-v2/): armazenamento, versões e CAS.
- [OpenBao storage](https://openbao.org/docs/configuration/storage/) e [seal](https://openbao.org/docs/configuration/seal/static/): persistência e operação após reinício.
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden): alternativa de password manager AGPL-3.0.
- [Composio autenticação](https://docs.composio.dev/docs/authentication) e [custódia](https://docs.composio.dev/docs/security/token-custody): comparação com conexões hospedadas, sem torná-las requisito.
- [Playwright autenticação](https://playwright.dev/docs/auth): estado autenticado também dá acesso à conta.

Esta revisão substitui as propostas intermediárias de browser protegido separado e VM no Lenovo: por decisão do usuário, login usa o browser da conta Linux nativa do bot ou o fallback existente no VPS. O acesso do próprio UID ao perfil e o alcance de root estão explicitados acima. Nenhuma senha real foi solicitada, salva ou usada nesta etapa.
