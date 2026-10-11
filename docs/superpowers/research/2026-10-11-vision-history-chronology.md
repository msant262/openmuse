# Ordem das imagens no histórico — 11/10/2026

## Defeito reproduzido

O adaptador `browserImageMessages` carregava o último screenshot ou preview de
arquivo verificado e o acrescentava como uma mensagem de usuário ao final de
**cada** requisição ao modelo. Isso deslocava evidência histórica para depois
de revisões, respostas de reparo e mensagens reais posteriores do usuário.
Não era uma repetição no histórico persistido; acontecia no transporte.

A reprodução conferiu os corpos HTTP reais de Responses, Chat Completions e
ChatGPT Responses. Uma quarta reprodução usou o executor OpenClaw copiado,
um PNG realmente salvo, uma revisão reprovada e um recibo de continuação:
os pixels antigos eram enviados depois da revisão e do reparo. Os quatro
controles falharam antes da alteração, por essa ordem incorreta.

## Correção e limites

A imagem agora permanece imediatamente depois do recibo que a produziu.
Resultados consecutivos de ferramentas permanecem juntos, para não quebrar
o protocolo de chamadas paralelas. Revisões e mensagens posteriores continuam
posteriores. O carregamento continua limitado ao último arquivo verificado
do proprietário; não grava pixels no histórico nem executa outra ferramenta.

**Isso comprova um defeito de transporte. Ainda não comprova que explica
todo o loop ou a avaliação factual contraditória do pedido anterior.**
É necessário repetir a tarefa normal no aplicativo publicado.

## Verificação local

- Reprodução anterior: quatro falhas esperadas, zero erros de preparação.
- Nove testes de transporte passaram após a correção; incluem arquivo
  gerado/upload, validação de identificadores e lote de chamadas paralelas.
- Conjunto de visão, revisão de documentos e executor copiado: **40/40**
  passaram, zero falhas, cancelamentos ou ignorados, em 86,088s.
- Os nove controles foram repetidos depois da limpeza de estilo e passaram.
- TypeScript e build do servidor/harness passaram. Lint sem erros; um aviso de asserção não nula
  preexistente em `app.ts` permanece. Grupos sobrepostos não foram somados.

Também acrescentados checkpoints dentro de `createApp`, sem alterar a
recuperação: autenticação, serviços, recuperação do desktop, inicialização
do agente e inbox. Eles medem duração e RSS, sem registrar credenciais,
contas ou conteúdo. A causa interna dos 58,376s anteriores permanece por
medir; os checkpoints não são uma otimização.

Logs em `artifacts/harness-parity-20261009/`: `round81-vision-chronology-red.log`,
`round81-vision-chronology-green.log`, `round81-vision-document-native.log`,
`round81-vision-final.log`, `round81-typecheck-final.log` e `round81-biome.log`.

Publicação, pedido natural e aceite integral ainda pendentes nesta conferência.
