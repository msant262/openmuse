# Retomada do harness: IDs de recibos e revisão do documento atual

O aceite integral permanece aberto. Esta correção trata duas falhas reproduzidas
após o teste público da rodada 94; um teste controlado não aprova o desempenho
nem a qualidade factual do modelo em produção.

## Causa confirmada

A árvore ativa da sessão isolada de QA continha 272 mensagens, com 2.672.827
bytes serializados. Foram identificados 23 pares de resultados com o ID original
e seu equivalente normalizado pelo runtime. As cópias adicionais somavam
560.526 bytes de conteúdo de ferramentas, além das chamadas correspondentes.
Esses valores não são uma estimativa de tokens ou do tamanho total do payload HTTP.

Ao reseedar a sessão a partir do checkpoint autorizado, o adaptador não restaurava
o mapa entre IDs nativos normalizados e IDs das operações do host. O checkpoint
seguinte usava o ID normalizado; o journal não encontrava a operação original e
reinseria seu resultado. A inspeção usou `SessionManager.buildSessionContext()`;
não se baseou apenas em entradas históricas de ramos abandonados. O inspector
foi fechado e os hooks temporários removidos ao final.

O adaptador agora aplica o normalizador original ao histórico admitido e preserva
a associação de cada chamada com seu ID do host. Ferramentas diretas e descobertas
mantêm essa identidade nos checkpoints e na árvore nativa. A correção não une
operações por igualdade de argumentos ou resultado e não reduz a janela do modelo.
Ela impede a nova duplicação; não migra automaticamente históricos antigos já
contaminados.

## Revisão e conclusão de documentos

A orientação de retomada mandava continuar pesquisa mesmo quando o recibo exigia
apenas corrigir redação ou layout. Além disso, o aviso genérico de conclusão
continuava apontando para defeitos de um rascunho já substituído e aprovado.

A próxima inferência agora recebe a revisão dos arquivos ativos na revisão atual
da tarefa: correção, inspeção ou avaliação das páginas, com os problemas e recibos
vigentes. A orientação de rascunho limita novas pesquisas a fatos concretos ainda
sem suporte. Requisitos de revisão antigos são substituídos pela verificação atual;
outros requisitos de execução continuam presentes. Os critérios de entrega,
auditoria factual e aprovação de efeitos permanecem exigidos.

## Verificação local

- Dois testes com runtime copiado, journal e transportes reais reproduziram a
  duplicação antes da correção. Ambos passaram depois: um resultado por operação,
  ID original preservado e nenhuma nova execução do host durante a restauração.
- Um teste produziu e substituiu um PDF real, inspecionou seus pixels e confirmou
  a revisão. Reproduziu a ausência da correção no contexto e, depois, a referência
  indevida ao rascunho antigo. As duas verificações passaram após os ajustes.
  A tarefa concluiu com dez inferências do endpoint de teste, uma leitura pública
  e nenhuma interação solicitada ao usuário. Isso não mede Luna em produção.
- Regressão selecionada: 53 testes passaram, zero falhas, em 103,469s.
- Verificação posterior de fontes e recuperação de documentos: 16 testes passaram,
  zero falhas, em 34,842s. Há sobreposição entre esses conjuntos; não somar como
  casos distintos.
- TypeScript e build da API/harness passaram. Biome terminou sem erros; sinalizou
  dois avisos preexistentes de asserção não nula fora das linhas alteradas.

Implementação: `0d07e448`. Evidências locais privadas em
`artifacts/harness-parity-20261009/round95-*` e `private-round95-vps/`.

## Publicação e caso comum

A API `0d07e448` foi publicada na imagem `76267ee4`, com 11 hashes compilados
conferidos. A troca levou 24,39s; as 13 verificações de preservação passaram.
O navegador e o executor físico permaneceram nas versões anteriores: esta
publicação não disponibiliza o contrato completo de `browser_exec`.

O mesmo pedido comum da rodada 94 foi enviado uma vez pelo compositor público,
sem orientar ferramentas ou responder ao agente. Luna entregou um PDF real de
duas páginas com 12 respostas, uma geração e uma chamada de conclusão. Foram
3min27s do envio ao registro final da tarefa; 3min17s era apenas a medição até
a última resposta do modelo. Bytes, hash, texto e pixels foram conferidos.

A sessão ativa terminou sem pares de IDs duplicados: 26 mensagens e 237.172
bytes. As 12 respostas do executor com usage preservado somaram 639.913 tokens,
com pico de 72.871 tokens de entrada. Isso não inclui o roteamento inicial da
conversa e não estima preço. Não houve nova geração ou repetição de conclusão.

O aceite factual continua reprovado. O documento coloca idioma da página nas
células de idioma de dois cursos, enquanto a autoavaliação marcou seus 13 itens
como satisfeitos. As páginas de [Google Skills](https://www.skills.google/course_templates/536)
e [Great Learning](https://www.mygreatlearning.com/academy/learn-for-free/courses/generative-ai-for-beginners)
foram conferidas independentemente: o texto consultado não basta para confirmar
o idioma das aulas. A FAQ da Great Learning confirma conteúdo gratuito e taxa
de certificado, e apresenta a divergência de duração que o PDF registrou. O
[repositório da Microsoft](https://github.com/microsoft/generative-ai-for-beginners)
e sua [tradução PT-BR](https://github.com/microsoft/generative-ai-for-beginners/blob/main/translations/pt-BR/README.md)
também foram abertos. A entrega de um arquivo correto em formato não aprova
automaticamente todas as informações solicitadas.

Foram recolhidos seis registros próprios do caso; 1.970 registros fora da seleção
ficaram iguais. As 13 comparações finais de preservação passaram, mantendo 58
arquivos, duas conversas, três memórias, 35 procedimentos e três contas Google.
O dispositivo isolado foi revogado, o navegador de QA encerrado e os hooks de
inspeção removidos. Foi removida uma imagem obsoleta de API anterior ao rollback
imediato e cache de build antigo. O aumento medido de espaço livre foi 8,40 GiB;
API atual/rollback, navegador/recuperação, volumes, perfis e backups ficaram
preservados. Página/API responderam 200 e os três containers estavam saudáveis
às 00:47 UTC.
