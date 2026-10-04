# Direção visual dos documentos

O pedido foi corrigir a repetição visual apesar do catálogo de referências já instalado.
A investigação encontrou dois limites: a busca exigia todas as palavras literalmente,
e só oito perfis chegavam ao renderizador, alterando sobretudo paleta e família de fonte.
A revisão visual verificava legibilidade, mas não cobrava a intenção da composição.

## Mudanças

- `design_references.recommend` compara até três direções por padrão. A busca pondera
  nome, descrição, características principais, tipografia e composição. Reconhece
  vocabulário de design em português, incluindo a expressão “sem serifa”. Nomes
  explícitos têm prioridade; uma consulta desconhecida não recebe uma marca aleatória.
- As recomendações incluem trechos limitados da fonte, hash e página para leitura.
  As 74 fontes continuam verificadas contra a revisão fixada do catálogo. São dados
  de referência, sem autoridade para conceder permissões ou executar código.
- Qualquer referência do catálogo pode orientar uma entrega. Fontes sem preset
  exigem paleta completa, composição e família tipográfica explícitas. Essas escolhas
  são realmente aplicadas; IDs inventados e adaptações incompletas são rejeitados.
- PDF, DOCX e PPTX oferecem composição editorial, briefing e signal. Alteram abertura,
  posição dos títulos, largura e recuo do texto, hierarquia e organização de métricas.
  Títulos podem usar serif, sans ou mono. Texto, tabelas e gráficos Office permanecem
  nativos editáveis. Paletas personalizadas exigem contraste legível.
- Recibos de geração e inspeção incluem a direção aplicada e sua justificativa.
  Os cinco trabalhos recentes do mesmo proprietário fornecem um sinal suave contra
  repetição; revisões do mesmo trabalho contam uma vez. Identidade visual solicitada
  e continuidade de uma série continuam tendo prioridade.
- As skills exigem escolha por público e propósito e uma revisão da hierarquia,
  composição e função dos elementos visuais. O SOUL da conversa não impõe uma
  estética global aos documentos.

## Problemas encontrados na verificação

A comparação com conteúdo e paleta idênticos demonstrou mudanças de composição nos
três formatos. No Word, uma linha de tabela podia se dividir entre páginas, separando
rótulo e explicação. As linhas agora permanecem inteiras, com cabeçalho repetido.

O primeiro ensaio conectado escolheu espontaneamente Voltagent, sem preset, para um
briefing de engenharia: fundo escuro, verde contido e títulos sans. A revisão rejeitou
o excesso de slides. O ensaio revelou subtítulos imediatamente anteriores a figuras
que viravam slides separados; agora compartilham a hierarquia da figura. Também havia
separadores Markdown sem linha vazia antes deles, promovendo parágrafos a títulos
setext repetidos. A skill esclarece as quebras, preservando a semântica do Markdown.

Esse primeiro ensaio não foi aprovado: a cópia da credencial expirou antes do reparo.
O harness recusou sua renovação para não rotacionar uma concessão da produção a
partir da cópia. A renovação foi feita pela função normal do servidor, sob o bloqueio
compartilhado de credenciais. Nenhuma credencial foi exportada nos recibos.

## Evidências e limites

- Suíte completa antes dos últimos ajustes: 1.312 testes, sem falhas.
- Busca em português após o ajuste: 8 testes; regressões finais de renderização,
  composição e edição: 38 testes, sem falhas.
- TypeScript do servidor e builds da imagem passaram.
- Evidências, arquivos, imagens e tentativas anteriores ficam em
  `artifacts/design-taste-continuation/`.

As três composições são recursos combináveis, não reproduções automáticas de 74 sites.
As famílias tipográficas são as fontes livres disponíveis no renderizador. Planejamento,
densidade e escolha de conteúdo ainda dependem do modelo; ausência de cortes não prova
qualidade estética. A fixture DOCX signal ainda exemplifica uma continuação final curta
que o autor deve corrigir. Ela não é uma entrega aprovada de uma tarefa de usuário.

## Ensaio conectado de PDF

Na imagem candidata `e507b8d`, o modelo configurado (`chatgpt/gpt-6-luna`) adaptou
a fonte Wired com paleta explícita, composição editorial e títulos serifados.
Rejeitou o primeiro rascunho por quebra da sequência e continuação isolada, corrigiu
o conteúdo, revisou as três páginas e entregou apenas o PDF final na conversa isolada
correta. A tarefa terminou em `succeeded/verified`, sem intervenção editorial.

A inspeção independente das imagens confirmou hierarquia, tabela legível, sequência
inteira e ausência de cortes ou sobreposição. O PDF final tem 60.498 bytes e SHA-256
`00f4007232c25969f193b375ad4c7cf703ff50283c707873b87581d79a3f06cd`.
Recibos, arquivo e imagens: `artifacts/design-taste-continuation/pdf-wired/`.

## Ensaio conectado de PPTX

Na mesma imagem, a escolha livre para engenharia foi novamente Voltagent, com
composição briefing, títulos sans, fundo carvão e verde contido. O modelo rejeitou
três rascunhos, corrigiu o conteúdo e concluiu com cinco slides, texto editável,
uma tabela nativa e um processo de três macroetapas. Todas as páginas tiveram
observação visual e confirmação vinculadas aos bytes finais; a publicação ocorreu
na conversa isolada correta, com estado `succeeded/verified`.

Conferi as cinco páginas: títulos, texto, tabela e sequência estão legíveis, sem
cortes nem sobreposição. O arquivo tem 26.916 bytes e SHA-256
`4a324337b46dad196c6796a70f1cc3ae3e8ce1b482e2ec8f708de44c04d142f8`.
Evidências: `artifacts/design-taste-continuation/final/pptx-engineering/`.

Limitação observada: o pedido do ensaio indicava aproximadamente 6–8 slides e o
modelo terminou com cinco, após reduzir os rascunhos. O gate de revisão comprova
cobertura visual e integridade, não cumprimento automático da faixa solicitada.
O ensaio valida escolha de referência, aplicação efetiva, edição, reparo e entrega;
não demonstra atendimento perfeito a todas as restrições de extensão.

## Publicação

A API foi atualizada de `770d988` para `e507b8d`, aplicando apenas esta mudança
sobre a base anteriormente publicada. Fonte principal: `9add902`, `1e22364`,
`64080e0` e `a3acb3b`. Imagem:
`sha256:99793c1739ea796b97898f759e15549264a812de69f103f69ef2ae76023cde98`.

O deploy confirmou zero tarefas e conversas ativas antes da troca, encerrou a
manutenção e preservou a pausa na revisão 16 e os registros retidos conhecidos:
duas reservas, seis operações e dois recibos nativos. O endpoint público de saúde
respondeu `ok: true`. Catálogo, composição de subtítulos e hashes das três skills
foram conferidos dentro do container publicado e correspondem à imagem testada.
Não foi necessária mudança na web ou no APK.
