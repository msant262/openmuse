# Conferência factual na revisão nativa — 11/10/2026

O pedido comum anterior criou um PDF, mas a revisão registrou somente
`passed: true` e `issues: []`. A conclusão comprovou bytes e revisão visual;
não havia um registro de cada campo solicitado. Idioma/preço da credencial
Google e duração Microsoft permaneceram sem confirmação.

Na configuração padrão, a mesma resposta do executor que avalia as páginas
agora precisa registrar `requestAudit`: requisito, satisfação e evidência.
O requisito identifica o item e o campo; a evidência compara a afirmação
real do documento com a fonte observada ou identifica a lacuna e a leitura
útil restante. Não adiciona chamada de modelo ou revisor. Quando a revisão
independente está explicitamente habilitada, seu protocolo factual existente
continua responsável pelo audit, sem duplicar a exigência.

O host valida o esquema da resposta exigida, incluindo o recibo específico.
Antes, esse esquema era anunciado ao provedor, mas apenas o esquema comum
da ferramenta era validado na execução. Um campo pendente do audit impede
aprovação mesmo se o booleano agregado disser `true`; a lacuna fica salva
nos mesmos bytes, proprietário, tarefa e revisão e orienta a correção.

Isso verifica consistência e registra uma avaliação do modelo; não prova
semanticamente que todos os requisitos foram enumerados nem que uma
citação é verdadeira. O pedido comum e suas fontes ainda precisam de
conferência independente antes de considerar o problema factual resolvido.

Duas reproduções falharam antes da implementação. O worker real rejeita
aprovação sem o audit obrigatório, mantém pendente um PDF com duração não
confirmada, permite ler o syllabus e substituir o rascunho, e entrega só o
arquivo corrigido, sem revisor separado. A API interna de revisão mantém
compatibilidade com registros anteriores e documentos sem pesquisa.

A verificação final passou com **40/40 testes** de documentos, revisão padrão,
executor copiado e contexto. Cinco casos específicos da revisão independente
opcional também passaram; não são somados com grupos intermediários que
repetiram testes. TypeScript e lint passaram (o lint mantém oito avisos
preexistentes). O teste controlado não comprova a seleção autônoma de fontes
ou a precisão do modelo real.

Publicação e pedido comum serão registrados abaixo.
Evidências privadas: `artifacts/harness-parity-20261009/round85-*.log`.
