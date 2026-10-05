# Humanização da conversa e preferências visíveis

> A conversa real voltou a apresentar voz genérica e texto duplicado após esta
> publicação. A validação abaixo não cobria esse caso. O diagnóstico e a correção
> posterior estão em [SOUL no runtime](2026-10-05-soul-runtime.md).

A retomada concluiu a validação e a publicação iniciadas na sessão anterior.
Fonte: `94b47bc`, com ajuste de tipagem de teste em `acd7093`. API publicada:
`0b0122c`, aplicada sobre a base em produção `87719d9`. Web e APK: `94b47bc`.

## Comportamento

A skill própria `apps/server/skills/humanizer/SKILL.md` entra automaticamente no
contexto da conversa e das tarefas. O SOUL continua escolhendo a voz. A skill
orienta atenção à mensagem concreta, celebrações, humor, desabafo, reações reais,
entregas úteis e revisão da linguagem, sem catálogo de respostas prontas. Nos
workers sem ferramentas sociais, a personalidade aparece no texto entregue.

O harness exigia confirmação antes e depois da delegação. Agora uma confirmação
basta; quando o agente já falou, o recibo da tarefa encerra o turno. Se ainda não
falou, há uma rodada curta de confirmação. O ensaio conectado revelou que observar
apenas o evento externo de texto era insuficiente: o consumidor pode recebê-lo
depois da decisão do loop. A observação passou para `onChunk` no middleware, antes
do buffering da saída. A resposta final de handoff também deixou de exigir uma
explicação sobre pesquisa ainda pendente.

O pedido original tem prioridade sobre especulações no resumo delegado. Para
pesquisas públicas entregues em texto, uma revisão sem ferramentas compara o
rascunho, o pedido e observações do journal. Pode exigir reparos, mas não aprovar
efeitos externos. Após três avaliações incompletas, a entrega fica parcial, sem
conclusão verificada. Encerrar por texto livre passa pela mesma revisão.

O perfil salvo agora tem instruções explícitas de linguagem, extensão, humor,
emojis e apresentação. A revisão distingue suficiência dos fatos de apresentação
e pode pedir apenas reformatação quando os dados já bastam.

## Referências examinadas

Foram consultadas as cópias locais de auditoria do Hermes e do OpenClaw:
`/tmp/harness-audit-20261004-hermes/agent/prompt_builder.py` (identidade,
conclusão e handoff assíncrono) e
`/tmp/harness-audit-20261004-openclaw/src/agents/system-prompt.ts` e
`system-prompt-context-files.ts` (reações e papel do SOUL).
Esses princípios orientaram o ajuste; não foi importado outro harness inteiro.

## Interface

Os controles de humor, emojis e respostas estruturadas têm posição, marca e texto
de estado. Escolhas de idioma, tom, formalidade e extensão têm check e estado
pressionado acessível. O check usa a cor de contraste do próprio preenchimento;
o controle desmarcado tem borda visível em ambos os temas. As opções quebram linha
em telas estreitas. O formulário rola enquanto o botão de salvar permanece visível.
As escolhas continuam sendo persistidas pelas mesmas APIs e revisões de perfil.

## Validação

- Suíte completa antes do último ajuste no streaming: **1.334 testes**, sem falhas.
- Após o ajuste: **37 testes focados**, sem falhas, incluindo assinatura,
  handoff, ferramentas sociais, humanizer e revisão de pesquisa.
- TypeScript servidor/mobile e build da API passaram. Biome terminou sem erros,
  com 257 avisos e sete informações existentes no conjunto verificado.
- A skill passou pelo validador; seu corpo integral e hash são testados nos
  contextos da conversa e do worker.
- Doze verificações da interface local passaram em inglês/português e temas
  claro/escuro: persistência dos switches, seleção acessível, largura de 390 px
  e botão de salvar visível. Nenhuma exceção JavaScript.
- Com o modelo configurado em produção e uma cópia isolada do perfil, celebração
  e brincadeira receberam reações visíveis; o desabafo não virou tarefa. Um perfil
  sem emojis produziu resposta sem emojis, stickers ou reações.
- A pergunta eleitoral original foi repetida pelo chat, sem URL fornecida. O
  worker trouxe votos, percentuais, horário e fontes e concluiu sem perguntas ao
  usuário após três avaliações. A versão final inclui lista; as tentativas e
  recusas anteriores foram preservadas.

Os ensaios de modelo usaram banco e conversas isolados. Credenciais foram lidas
por uma montagem somente leitura, copiadas para diretório privado temporário e
não tiveram renovação permitida pela cópia de teste. Nenhuma mensagem foi enviada
nas conversas reais do usuário.

## Publicação e evidências

A troca da API ocorreu com zero tarefas e conversas ativas. Manutenção encerrada,
pausa preservada na revisão 16 e os registros retidos preservados: duas reservas,
seis operações e dois recibos nativos. SOUL, revisões do perfil, seleção de modelo
e avatar tiveram o mesmo digest antes e depois. API pública saudável.

O aceite público confirmou os controles com os valores salvos, seleção móvel,
ausência de alterações no perfil e de exceções JavaScript. O pareamento temporário
foi revogado. Bundle web e download público do APK tiveram hashes iguais aos
builds locais. Os recursos estáticos antigos continuam disponíveis para páginas
que ainda tenham um entrypoint em cache.

- Skill publicada: SHA-256
  `97700cf6c0b1a6f5659eca310d5ffc4cbd41617ee7f08c69ded7326d9a4c33e1`.
- Bundle web: SHA-256
  `e7ded047ad8fcf97e082da8ec2e290b44b6307aedf6bae64e94725dc11037a5d`.
- APK ARM64: 68.782.391 bytes, SHA-256
  `c829af54bf5572a81dfdb26747cd95539114651f1dcbb24c05415f519ad29f88`.
- Certificado Android existente preservado. O recibo marca `sourceDirty: true`
  no checkout que contém `.orca/` não rastreado; os arquivos mobile rastreados
  correspondem a `94b47bc`.

Recibos, diálogos, versões recusadas e capturas ficam em
`artifacts/companion-polish/`, principalmente `verification.json`,
`live-social-summary.json`, `live-final/election.json`, `ui-acceptance.json`
e `public-acceptance.json`. APK e recibo de assinatura ficam em
`artifacts/android/companion-polish/`.

Não houve novo teste de execução em emulador Android ou aparelho físico nesta
retomada. Conversa natural e revisão factual dependem de decisões do modelo;
estes ensaios não garantem qualidade uniforme em toda resposta futura.
