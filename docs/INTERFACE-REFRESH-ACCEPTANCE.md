# Interface web e Android — 4 de outubro de 2026

Fonte dos builds: `3e1f3ac2c770f7397c0f63c915439718a7b24799`, com árvore limpa.

- O criador de companheiro inicia sem restaurar opções antigas aguardando seleção.
  Gerações anteriores são abertas explicitamente pelo histórico; o companheiro
  salvo permanece ativo. Gerações em andamento continuam recuperáveis.
- O painel do agente oferece cartões SOUL e MEMORY que abrem os editores reais,
  com persistência e histórico. No desktop, os documentos usam a área central;
  no Android e telas estreitas, abrem em um painel com rolagem.
- Claro, Escuro e Automático são escolhas persistidas por dispositivo. A paleta
  compartilhada cobre chat, formulários, menus, resultados e navegação. A web usa
  eventos de media query para acompanhar mudanças do sistema sem remontar o app.
- Conversa principal, outras conversas e nova conversa têm hierarquia explícita,
  seleção com fundo/borda contrastantes e botão de criação no topo.

O aceite local da web executa 13 verificações reais no navegador contra uma API
sample isolada: persistência do tema e pareamento, rascunhos, tema automático,
edição/histórico de SOUL e memória, criação/retorno de conversas e viewport de
390 px. A API sample é o único destino das alterações de dados de teste.

No Android API 34, o APK x86_64 assinado foi instalado com `-r` sobre o APK
assinado `ef147e3` da mesma fixture, sem desinstalar ou limpar os dados. O
rascunho com chave vinculada ao pareamento sobreviveu à atualização, troca de
tema, force-stop/reabertura e visita a uma nova conversa. SOUL e memória foram
editados pelos controles nativos; o histórico de memória e a mudança automática
de tema foram conferidos nas capturas. Nenhum marcador fatal de JavaScript ou
Android apareceu no recorte de logcat do aceite. Não houve teste em telefone físico.

O APK ARM64 usa `https://app.okamibot.cloud`; o x86_64 de aceite usa exclusivamente
`http://10.0.2.2:8793`. Ambos mantêm o pacote `app.openmuse.mobile`, esquema
`openmuse` e certificado SHA-256
`e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.

| Artefato | Bytes | SHA-256 |
| --- | ---: | --- |
| ARM64 | 58.975.577 | `d319b4b9038b8015c0fa5167432ee257ad90b15640b1e242f7cf0e45ba011035` |
| x86_64 (fixture) | 60.720.416 | `97de9ef9e63fe6d9762d9aec606b2bd4d553e93490f0476eced6a946da45596c` |
| JavaScript web principal | 5.585.229 | `2bd9cd3420c614c6b819dbc150341f80c3162e791ec42b09d7a7e1b3ac41edea` |

A suíte completa passou na fonte exata dos builds: **1.211 testes, zero falhas**.
TypeScript de servidor/mobile passou; Biome terminou sem erros, com 245 avisos e
quatro informações. O aceite público executou nove verificações no desktop e em
390 px, incluindo português, SOUL/memória, persistência do tema e abertura do
histórico de avatar. A verificação do campo vazio aguardou o carregamento real
do estúdio. Perfil, memórias e avatar ativo tiveram digest idêntico antes e depois.
Não houve escrita de produto ou exceção JavaScript; o pareamento temporário foi
revogado. Uma tentativa anterior encontrou ambiguidade durante o redimensionamento;
o ensaio final aguarda a desmontagem da barra lateral antes de usar o menu móvel.

A publicação trocou somente os arquivos estáticos, mantendo a API `7f81a03`
saudável. A raiz pública carrega o novo bundle; JavaScript e APK baixados por
HTTPS retornaram 200 e os mesmos tamanhos e hashes da tabela. Assets antigos com
nomes por hash continuam disponíveis para clientes que ainda tenham o HTML anterior.

- Web: <https://app.okamibot.cloud>
- APK ARM64: <https://app.okamibot.cloud/downloads/okamibot.apk?v=3e1f3ac>
- Release web: `/opt/okami-web/releases/3e1f3ac-public`.
- APK publicado: `/opt/okami-web/downloads/okamibot-3e1f3ac-arm64-v8a.apk`.
- Backup do Serve: `/root/okami-deployment/serve.before-interface-3e1f3ac.json`.
- Rollback: reativar a raiz `/opt/okami-web/releases/7529b63-public` e o handler
  de download `/opt/okami-web/downloads/okamibot-7529b63-arm64-v8a.apk`.

Recibos e capturas locais estão em `artifacts/interface-refresh/`: `verification.json`,
`web-acceptance.json`, `native-acceptance.json`, `public/checks.json`,
`public-downloads.json` e `activation.log`. Os recibos dos APKs estão em
`artifacts/android/interface-refresh/`. Os logs de diagnóstico do tema automático
e o aceite final permanecem separados. As gravações de SOUL e memória ocorreram
somente na API sample isolada; o aceite público consultou os dados existentes.
