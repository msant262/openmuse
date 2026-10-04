# Correção do acesso às configurações e auditoria dos fluxos

Pedido: configurações acessíveis no app Android e web mobile; nova verificação ampla do aplicativo. Continuar na branch existente, preservando o trabalho do harness.

- Reproduzir o acesso escondido em uma versão web com banco isolado. Identificar também barreiras de navegação, retorno e recuperação de erros nas configurações.
- Expor um acesso direto e legível às configurações no cabeçalho mobile, compartilhado por React Native e web. Preservar rascunhos e conversa selecionada ao abrir/fechar.
- Conferir configurações (idioma, tema, modelos, conectores, personalidade, memória, proatividade e notificações), conversas, feed, ideias, objetivos, arquivos, procedimentos, rotinas e aprovações. Usar dados de teste locais; classificar integrações desconectadas como limites, não sucesso.
- Corrigir defeitos reproduzidos, com regressões comportamentais quando necessárias. Conferir layouts estreitos, teclado/voltar e persistência após recarregar/reiniciar.
- Validar Android em emulador com APK local, além de web mobile/desktop; rodar checagens de tipos, lint, builds e suíte relevante/completa.
- Registrar evidências, falhas corrigidas e áreas que não puderam ser exercitadas. Não confundir build local com publicação.

Concluído: acesso direto compartilhado, retorno por seção, correções de procedimentos, validade de memória e estados acessíveis. Validação web/Android, suíte completa e limites registrados em [relatório da revisão](../research/2026-10-04-mobile-workflow-audit.md). Há uma observação residual sobre alteração dinâmica de escala de fonte Android; a inicialização com fonte ampliada funciona. Nenhuma publicação realizada.
