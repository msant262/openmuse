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
A tarefa normal foi repetida no aplicativo publicado; seus resultados e
limites seguem abaixo.

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
contas ou conteúdo. A medição posterior localizou 60,580s na recuperação
do desktop; os checkpoints não são uma otimização. A correção separada
está documentada em [recuperação do desktop](2026-10-11-desktop-startup-recovery.md).

Logs em `artifacts/harness-parity-20261009/`: `round81-vision-chronology-red.log`,
`round81-vision-chronology-green.log`, `round81-vision-document-native.log`,
`round81-vision-final.log`, `round81-typecheck-final.log` e `round81-biome.log`.

## Publicação e pedido normal

`e331b56c` foi publicado na API, imagem `0805f55a`, com seis hashes
compilados conferidos e 13 comparações de preservação aprovadas.
A API posterior `73a633cf` mantém essa correção.

Pedido comum, enviado uma vez em conversa nova, sem nomes de ferramentas
nem orientação para exibir cards:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.

A tarefa `85238dc2e1cb3663d0b4f772231f70299a220f497bc972feba124aded0133f16`
concluiu sozinha: **38 respostas somente de Luna**, sem fallback, perguntas,
direções do operador ou retomada manual. Criou três versões, inspecionou e
confirmou cada uma; chamou a conclusão uma vez e entregou um arquivo final.

Tempo: **605,348s** entre criação da tarefa às 19:09:09,446 UTC e resultado
às 19:19:14,794 UTC. O observador inicial procurava a rota errada, embora
a mensagem já estivesse aceita; não houve reenvio. Não há tempo exato de
cliente para essa rodada.

PDF final: **47.308 bytes, duas páginas**, SHA-256
`723101f5a148d1968348374b423660e3081f66a361281996cf8b9f892f1e5b62`.
Foi aberto no leitor público: duas páginas com pixels distintos e quatro
links de fontes na segunda página. Uma captura prematura da página 2 foi
descartada e refeita após os quatro links renderizarem. Celular físico não
foi verificado.

**Entrega física e autonomia aprovadas neste caso; rapidez e comprovação
factual integral reprovadas.** Os idiomas de Simplilearn e Great Learning
foram qualificados pelo idioma da página/conteúdo consultados, o que ainda
não comprova o idioma dos cursos. O preço da credencial IBM não ficou
estabelecido integralmente. Houve pesquisa e regeneração excessivas, com
exigências diferentes de prova de gratuidade ao longo das revisões.
Não atribuo a mudança de resultado exclusivamente à correção de transporte.

Dez registros próprios do QA foram recolhidos da apresentação;
1.914 registros fora da seleção ficaram iguais. Recibos canônicos,
58 arquivos reais, duas conversas reais, três contas Google, três memórias
e 35 procedimentos foram preservados. Inspector fechado e dispositivo
temporário do navegador revogado. O aceite integral continua pendente.
