# Leitor PDF, paginação e medição da inicialização — 11/10/2026

Implementação `8415419b5f5a464a39b65a4e208a2beaea983aeb` e ajuste de
publicação web `e1fd91f93ef38f4122a6c4a8ba1ce5f1614d2eb9`, enviados à main.
API e web publicados. O harness completo continua sem aprovação.

## Leitor PDF publicado

O iframe anterior dependia do leitor de PDF do navegador e não mostrava os
pixels do documento no navegador usado para a verificação. A nova versão
carrega PDF.js 6.4.299 e seu worker, hospedados com o app, somente quando o
usuário abre um PDF. Desenha uma página por vez, mantém o download para
navegação/zoom, usa a contagem real de páginas e envia a autenticação do app.

Texto selecionável e links reais do PDF recebem camadas próprias. Trocar o
arquivo, receber um PDF inválido ou fechar o leitor cancela renderizações e
libera o bitmap anterior. Um quadro só aparece quando documento, página,
zoom e largura correspondem ao render concluído; o número da página não
pode avançar enquanto ainda aparecem os pixels da anterior.

O teste com Chromium real verifica páginas de cores distintas, texto, links,
worker real, autenticação, contagem correta, uma única transferência ao
navegar/redimensionar/aplicar zoom, recuperação de erro e liberação do
canvas ao fechar. A largura de 390 pixels é uma simulação de celular;
não foi feita verificação em aparelho físico nesta etapa.

O runtime separado tem 490.393 bytes e o worker 1.321.307 bytes. Não entram
no bundle principal nem carregam na abertura do chat. O conjunto de assets,
incluindo fontes, mapas de caracteres e wasm, tem cerca de 5,7 MiB.

## Publicação e recuperação de falha

A primeira publicação web encontrou HTTP 404 nos assets públicos e voltou
automaticamente ao release anterior. O mesmo runtime e worker funcionaram
na origem privada com SHA-256 idêntico ao export local. Na origem pública,
o 404 veio com `CF-Cache-Status: HIT`, inclusive usando uma query nova.
A origem inicial desse 404 não foi estabelecida.

Os assets passaram a usar o namespace versionado existente
`/_expo/static/pdf-reader/6.4.299-71c35f5575517f49/`. A publicação final
verificou HTML, bundle principal, runtime e worker na origem privada e na
pública, com igualdade de bytes/SHA-256. Não houve alteração global de proxy
ou CDN. O app publicado usa o release `harness80-20261011-e1fd91f9`.

Bundle principal: 5.873.034 bytes; SHA-256
`724b9f69280b865ad66d986faa8f0a80beee6ce36aeb886106abbce698385709`.
A API usa a imagem `f6212f30`, fixada na implementação `8415419b`.
Sete hashes compilados e treze conferências de preservação passaram.
Navegador, executor físico e APK permaneceram nas versões anteriores.

## Paginação: resultado específico e limite

Uma reprodução exata do PDF do teste anterior passou de três páginas para
duas, preservando texto, fontes e links. O título agora ocupa a largura
disponível quando não existem os metadados que justificavam uma coluna
vazia. As tabelas distribuem largura conforme cabeçalhos e conteúdo, em
vez de usar colunas iguais. Corrigir somente o título não resolveu a
terceira página da reprodução; a distribuição das colunas também foi
necessária.

Os bytes foram extraídos e as duas páginas rasterizadas e inspecionadas.
Essa reprodução não aprova todos os documentos possíveis nem os fatos da
pesquisa. No novo pedido normal, outro conteúdo ainda produziu três
páginas, e a revisão registrou uma última página quase vazia. A paginação
geral continua pendente.

## Verificação local

**47/47 testes relacionados passaram**, sem falhas, cancelamentos ou testes
ignorados, em 44,596 segundos. Incluem layouts, documentos, revisão,
design, leitor e preview. Testes específicos do leitor passaram novamente
após as correções de cancelamento, liberação do canvas e namespace dos
assets. Esses conjuntos se sobrepõem e não foram somados.

TypeScript raiz/mobile, build do servidor/harness, exportação web e lint
passaram. O teste do leitor gera assets em diretório temporário usando o
bundler de produção, sem depender dos arquivos ignorados da máquina local.

## Inicialização medida na VPS

Foram adicionados checkpoints monotônicos com duração da fase e RSS,
sem registrar credenciais ou conteúdo. Não mudou a ordem da recuperação
de efeitos nem o preparo do harness.

| Fase | Duração da fase |
| --- | ---: |
| Módulos carregados | 1,989s |
| Configuração lida | 0,008s |
| Store pronto | 0,967s |
| Ações interrompidas recuperadas | 0,019s |
| Ações reconciliadas | 0,347s |
| App criado | **58,376s** |
| Harness preparado | **8,249s** |
| Serviços de fundo iniciados | 0,001s |
| HTTP escutando | 1,779s |

HTTP ficou pronto em 71,735s desde o início do processo; a operação completa
de publicação levou 77,70s. A espera foi isolada principalmente em
`createApp`, mas sua causa interna ainda não foi provada. O próximo passo
precisa medir os construtores e recuperações internos; o número de
registros históricos, sozinho, não explica o tempo.

A consulta somente de leitura contou 49 sessões desktop fechadas, 144
itens de inbox, 57 sugestões proativas, 26 entregas push e 429 intents
push. Ela não executou novamente a recuperação nem mudou esses registros.
Durante o QA, uma amostra da API marcou 979,7 MiB de RAM e 16,84% de CPU.
Não é medição de pico, de GPU, de celular ou de estabilidade sustentada.

## Pedido normal e aceite restante

Foi enviada uma vez, em conversa nova no app público, a mesma mensagem:

> Pesquise três cursos gratuitos para começar em IA generativa e me entregue
> um PDF comparando conteúdo, idioma, duração e se o certificado é pago.
> Coloque os links das fontes.

Não foram indicadas ferramentas, respostas, cards, cursos específicos ou
procedimentos de reparo. O operador não respondeu perguntas nem resgatou
a execução. Acompanhar a tarefa e abrir seu arquivo não alimentam o modelo.

O teste começou às 18:32:18,961 UTC. Após **636,532 segundos
(10min36,532s)**, o operador cancelou somente esse QA depois do loop
observado. Foram **39 respostas exclusivamente de Luna**, dois PDFs
criados, três inspeções, três avaliações, seis tentativas de conclusão
parcial e uma pergunta bloqueada. Zero interações ou diretivas. **Nenhum
arquivo final foi entregue.** O status terminal `cancelled` decorre dessa
interrupção do teste; a reprovação do aceite decorre do comportamento
observado antes dela.

O último rascunho tem 56.704 bytes e três páginas, SHA-256
`fe53aa4465bb1565101eeabaa8f0a05d6873f1b295fb2748f69371aa96893a09`.
Os dois PDFs foram recuperados com autenticação e seus bytes conferidos.
Poppler extraiu o texto e rasterizou a página 3: contém somente o final de
uma nota no topo, com quase todo o restante vazio.

A última revisão nativa contradiz o próprio arquivo: afirma que Great
Learning está fora da comparação, embora seja a primeira linha da tabela;
menciona duração de curso IBM, embora esse curso não conste da comparação.
São defeitos observados na avaliação, mesmo com vínculo/hash válidos.
Não foi estabelecida ainda a causa completa no histórico enviado ao modelo.

O host devolveu continuação reparável nas seis tentativas de encerramento.
O guard de `ask_user` também funcionou: negou a pergunta sobre “retomar” uma
correção já autorizada, sem abrir interação para o usuário. O modelo voltou
a tentar concluir parcialmente, sem criar uma nova versão após a avaliação
final. Esse loop continua sem correção comprovada. A existência de guards
e instruções não aprovou a autonomia.

## Leitor público: verificação em arquivo existente

Como o QA não entregou seu PDF, a verificação do leitor abriu pela biblioteca
um arquivo real já existente, somente para leitura. As três páginas foram
desenhadas, com hashes de pixels distintos, texto selecionável e links.
Runtime e worker públicos responderam HTTP 200 com MIME de JavaScript.
Na largura de 390 pixels, o canvas no modo ajustar largura ficou dentro da
tela. Navegação e zoom no mesmo layout acrescentaram **zero downloads**.
Fechar o leitor deixou o bitmap capturado com largura/altura zero. Nenhum
erro JavaScript foi registrado desde o início da observação do QA.

A mudança entre os layouts desktop e celular reiniciou o leitor na página 1
e voltou a transferir o arquivo. A aplicação remonta essa apresentação;
o controle isolado do leitor não detecta esse comportamento da tela inteira.
Essa transição permanece pendente. A verificação do leitor não converteu
o rascunho do QA em entrega e não aprova os fatos do documento existente.

## Limpeza, preservação e disponibilidade

Oito registros próprios do QA foram recolhidos da apresentação: tarefa,
conversa, cinco arquivos/previews e inbox. **1.904 registros fora da seleção
permaneceram iguais.** Recibos canônicos mantidos. Não surgiu procedimento
novo que precisasse ser arquivado; os 35 anteriores mantêm suas versões.
O navegador de QA foi fechado e seu dispositivo temporário revogado.
A verificação inicial de fechamento do inspector, após 300ms, falhou;
a conferência posterior confirmou a recusa da conexão ao inspector fechado.

As **13 conferências finais** preservam companions/perfil, duas conversas,
58 arquivos, três memórias, 35 procedimentos e três contas Google
simultâneas. Nos arquivos, somente a assinatura/expiração dos links
temporários mudou; rotas e campos armazenados permaneceram iguais.

A imagem API antiga `763c49fc`, seu contexto de 11.916 arquivos e seu
release de 53.450.413 bytes foram retirados após verificação integral de
revisão, uso, mounts, processos e correspondência contexto/archive. Isso
liberou 435.310.592 bytes medidos na VPS. O candidato web descartado,
seus 232 arquivos conferidos e seu archive de 18.887.757 bytes também
foram retirados, liberando mais 46.018.560 bytes medidos. Total desta
rodada: **481.329.152 bytes (~459,0 MiB)** de aumento no espaço livre.
Localmente, os dois archives obsoletos tinham 72.338.170 bytes, e os 232
arquivos do export descartado somavam 26.440.989 bytes. Foram retirados
após conferir os hashes com os manifests; aumento medido de espaço livre
local: **99.520.512 bytes (~94,9 MiB)**. Os archives atuais/de recuperação
e o export web publicado foram mantidos.

API/web atuais e recuperação imediata, OpenBao, volumes, dados reais e
APK publicado preservados. Os APKs antigos retirados anteriormente estão
no relatório histórico; nenhum APK novo foi criado nesta etapa.

Às 18:46:44 UTC, página e API públicos responderam HTTP 200; os três
contêineres estavam saudáveis, manutenção desligada e seis contadores de
trabalho ativo em zero. As 44 operações históricas incertas permanecem
preservadas. A conferência pontual não aprova estabilidade sustentada.

Pesquisa factual suficiente, latência, consumo, celular físico, todas as
operações Workspace, memória/proatividade e equivalência integral com
Hermes/OpenClaw continuam pendentes no
[inventário de contratos](2026-10-09-harness-tool-inventory.json).

Evidências privadas em `artifacts/harness-parity-20261009/`, fora do Git:
logs locais `round80-*`; na VPS, publicação `deployment-harness80.json`,
`web-publication-harness80-static.json`, identidade/observações do pedido
e contagens de inicialização `harness80-startup-history-counts.json`.
**36 evidências remotas** foram copiadas para `private-round80-vps`, com
SHA-256 conferido, diretório 0700 e arquivos 0600. A auditoria independente
está em `round80-independent-audit.json`; a verificação do leitor publicado,
em `round80-public-reader-proof.json`.
