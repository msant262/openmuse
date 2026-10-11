# Recuperação do desktop e inicialização — 11/10/2026

## Causa medida

Os checkpoints publicados em `e331b56c` separaram a espera anteriormente
atribuída a `createApp`: **60.580 ms foram gastos em `DesktopViewers.recover`**.
A inicialização do agente levou 16 ms; o inbox, 3 ms. HTTP começou em
79.188 ms, incluindo 10.190 ms de preparo do harness. A publicação levou
87,04s e suas 13 conferências de preservação passaram.

O servidor tinha 49 registros de visualizadores de desktop, todos fechados.
A implementação transferia todos eles do banco, reescrevia `closed: true`,
lia suas tarefas e operações e tentava liberar permissões de execução
novamente, em cada reinicialização. O custo do loop foi medido; a divisão
do tempo entre cada consulta individual ainda não foi medida.

## Reprodução e correção

Uma reprodução com o banco real e 50 visualizadores fechados/tarefas
encerradas falhou antes da correção: houve 100 comandos de escrita
desnecessários. O teste também confere os timestamps persistidos e observa
as linhas realmente transferidas, sem substituir a execução das consultas.

`desktopViewerRecoveryCandidates` seleciona no banco apenas visualizadores
abertos, tarefas não encerradas, flags de recuperação, permissões de execução
retidas ou entradas nativas sem confirmação de limpeza. A recuperação
continua usando o mesmo protocolo para esses casos. A seleção inclui uma
entrada incerta mesmo sem flags; respeita o proprietário das operações.

Histórico fechado e resolvido permanece no banco, sem transferência de seus
registros completos e sem reescrita. A seleção não apaga tarefas, recibos,
entradas incertas nem perfis de desktop.

## Verificação e limites

**19/19 testes relacionados passaram**, zero falhas, cancelamentos ou
ignorados, em 19,223s. Incluem a integração HTTP com executor nativo,
permissões/ocupação retidas até limpeza confirmada, interrupções do desktop,
histórico resolvido sem escrita, isolamento de proprietário e polling do
inbox. TypeScript passou. Lint sem erros; permanece um aviso de asserção não
nula preexistente em `desktop-viewers.ts`.

A primeira execução ampliada teve 18 acertos e um erro no teste novo:
o teste usava `Store.all`, que não existe. Corrigido para `Store.list`;
TypeScript e os 19 testes foram executados novamente e passaram.

Logs privados em `artifacts/harness-parity-20261009/`:
`round81-desktop-recovery-red.log`, `round81-desktop-recovery-green.log`,
`round81-desktop-native-suite.log`, `round81-desktop-native-final.log`,
`round81-desktop-typecheck-final.log` e `round81-desktop-biome.log`.

## Publicação e medição na VPS

`73a633cf` está na main local/remota e na API publicada, imagem `5d076f4f`.
Seis hashes compilados conferidos; 13 comparações de preservação passaram.
Publicação em **24,88s**, com parada limpa e manutenção encerrada.

| Checkpoint | Antes: `e331b56c` | Depois: `73a633cf` |
| --- | --- | --- |
| Recuperação do desktop | 60.580 ms | **1.300 ms** |
| Inicialização do agente | 16 ms | 18 ms |
| Inicialização do inbox | 3 ms | 2 ms |
| Preparo do harness | 10.190 ms | 10.110 ms |
| HTTP escutando desde o início do processo | 79.188 ms | **18.784 ms** |

A conferência das 19:30 UTC encontrou os três containers saudáveis e os
endpoints públicos HTTP 200 por curl. Companions, contas, arquivos,
memórias e conversas reais permaneceram iguais após a limpeza. Não houve
replay de operações incertas para produzir essa melhora.

São duas inicializações observadas, sem alegação de benchmark repetido.
O preparo do harness continua em cerca de dez segundos. A amostra final da
API foi **916,6 MiB / 17,65% CPU**; não é pico nem prova de consumo reduzido
em todas as tarefas. Pesquisa, GPU, celular e carga sustentada permanecem
pendentes. O aceite integral do harness continua pendente.

Recibos privados: `deployment-harness82.json`,
`harness82-startup-observation.json`, `harness82-final-production.json` e
`harness81-final-preservation.json`.
