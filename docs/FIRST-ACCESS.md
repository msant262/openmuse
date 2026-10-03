# Abrir e testar o OkamiBot

A instalação atual já está na VPS. Para usar, não precisa instalar Node, Docker
ou executar o projeto na sua máquina.

1. Use um navegador atualizado no computador ou celular. Não precisa de Tailscale.
2. Abra **https://app.okamibot.cloud**.
3. Na primeira entrada, escolha **English** ou **Português (Brasil)**. Cole a chave
   em **Workspace access key / Chave de acesso** e clique em **Open workspace / Entrar**.
   Na Aoostar, a chave está no arquivo privado
   `/home/marcos/.local/share/okamibot/access-key.txt`. Abra esse arquivo no editor
   ou execute no terminal da Aoostar:

   ```bash
   cat /home/marcos/.local/share/okamibot/access-key.txt
   ```

   Copie a chave somente para a tela de entrada; não envie em conversas.
4. O app abre em **Chat / Conversa**. Experimente: “Olá, me explique o que você
   consegue fazer”. O modelo padrão é GPT-6 Luna pela assinatura ChatGPT; Grok
   está conectado como fallback. MiMo ainda depende de uma chave.
5. No computador, use a barra lateral para Conversa, Feed, Ideias, Metas e
   Biblioteca. O menu no canto inferior esquerdo abre **Settings / Configurações**.
   No celular, abra o menu de conversas, toque em **Mais opções** e depois em
   **Configurações**. O botão do computador do agente abre a tela remota;
   **Assumir controle** habilita entrada e **Devolver ao agente** encerra o
   controle manual.
6. As configurações têm categorias para idioma, modelos, conexões, personalização,
   permissões, memória e notificações. Toque no lápis junto ao avatar ou em
   **Personalizar seu companheiro**, dentro de **Geral**, para abrir aparência
   e personalidade. No estúdio do companheiro, descreva o
   personagem que quiser, incluindo cores e acessórios. A criação gera quatro
   opções com acabamento de pelúcia; escolha uma para aplicar o retrato e gerar
   as animações de repouso, trabalho com notebook e resposta. O progresso aparece
   no estúdio. Os personagens ficam salvos na galeria e podem ser reutilizados,
   assim como o companheiro padrão. A criação usa a conta Grok conectada,
   independentemente do modelo escolhido para conversar.

Em **Configurações → Modelos**, escolha um modelo disponível na conta conectada;
a preferência vale para as próximas conversas e tarefas. Em **Conexões → Imagens
com ChatGPT**, a assinatura já está conectada por Codex OAuth. Pedidos de imagens
e infográficos podem usar GPT Image sem depender do Grok nem de uma chave de API
paga. Se desconectar, o app oferece um código para autorizar no site oficial da
OpenAI. Essa conexão é independente do modelo usado para conversar.

Para Tavily, use **Conexões → Conectar Tavily** ou peça a conexão na conversa.
O agente abre um formulário privado; insira a API key nesse campo. A chave é
validada e guardada no cofre, fora do histórico enviado ao modelo. Tavily ainda
não está configurado com uma chave real nesta instalação.

O menu de cada conversa permite renomear, arquivar, restaurar e excluir.
**Arquivadas** mostra as conversas guardadas. Excluir remove a transcrição;
arquivos, tarefas e memórias salvos têm seu próprio ciclo de vida. Tarefas ativas
precisam ser encerradas antes de excluir sua conversa.

A pesquisa pública agora usa busca HTTP e `web_fetch` antes de recorrer ao
navegador. Perguntas anteriores ficam recolhidas no histórico; **Parar tarefa**
encerra a tarefa sem exigir outra resposta. No desktop, computador e navegador
abrem ao lado da conversa; documentos usam o leitor no espaço de trabalho.

O navegador guarda o pareamento em cookie seguro e renova a sessão. Não use
janela anônima se quiser manter o acesso; apagar cookies exige novo pareamento.
Se abriu a versão anterior, use **Ctrl+Shift+R**. O endereço `/api/health` é apenas
diagnóstico, não a interface.

**Android:** baixe o [APK ARM64 assinado](https://app.okamibot.cloud/downloads/okamibot.apk?v=7ec9235)
no telefone e instale. Ele usa o mesmo domínio público e não exige Tailscale.
Se já tiver o app, instale como atualização para preservar os dados. Caso o
Android recuse por assinatura diferente, não desinstale nem apague os dados para
contornar a recusa. Use a mesma chave na primeira entrada.

O APK tem 58.926.425 bytes e SHA256
`c56278eda5b318686739c999918b9f655f44a54099bc78b921a2ea6ad62f0fff`.
O parâmetro da versão no link evita que o cache entregue o APK anterior.
Gmail/Calendar e push ainda precisam da configuração das contas correspondentes;
não são necessários para abrir o chat.

## Como a interface foi publicada

O Tailscale Serve entrega o export estático do app na raiz HTTPS interna. `/api` e
`/executor` continuam encaminhados à API privada. O Cloudflare Tunnel entrega o
domínio público sem abrir portas de entrada na VPS. Seu filtro público bloqueia
`/executor` e `/api/deployment`; os endpoints do aplicativo mantêm autenticação.
O diretório publicado contém apenas o build web, nunca `.env` ou credenciais.

Para reconstruir em uma máquina de desenvolvimento:

```bash
EXPO_PUBLIC_API_URL=https://app.okamibot.cloud EXPO_PUBLIC_WEB_SAME_ORIGIN=true pnpm --filter @openmuse/mobile build:web
```

O script limpa o cache Metro: um export sem limpeza reutilizou a URL de
desenvolvimento `localhost:8787` durante o aceite. Verifique a URL no bundle antes
de copiar `apps/mobile/dist/web/` para um novo diretório de release na VPS.

Rotas da instalação atual (comandos na VPS):

```bash
sudo tailscale serve --bg --yes --set-path=/api http://100.113.59.40:8787/api
sudo tailscale serve --bg --yes --set-path=/executor http://100.113.59.40:8787/executor
sudo tailscale serve --bg --yes --set-path=/ /opt/okami-web/releases/7ec9235-public
sudo tailscale serve --bg --yes --set-path=/downloads/okamibot.apk /opt/okami-web/downloads/okamibot-7ec9235-arm64-v8a.apk
```

Mantenha os sufixos `/api` e `/executor` nos destinos: o Serve remove o prefixo
de montagem antes de encaminhar. A configuração anterior está guardada em
`/root/okami-deployment/serve.before-web.json` na VPS.

O túnel é `okamibot-app`, serviço `okami-cloudflared.service`, configurado em
`/etc/okami-cloudflared/`. Somente a credencial desse túnel fica na VPS; o
certificado administrativo do Cloudflare fica na máquina de administração.
O serviço roda com usuário próprio, limite de 128 MiB e reinício automático;
esse consumo utiliza a reserva do sistema no orçamento existente da VPS.
