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
5. No computador, a barra lateral mostra conversas, atividade, aplicativos e
   configurações. No celular, use o botão de menu. O botão do computador do
   agente abre a tela remota; **Assumir controle** habilita entrada e **Devolver
   ao agente** encerra o controle manual.
6. Em **Settings / Configurações**, ajuste o idioma da interface, nome,
   personalidade e idioma das respostas. Escolha entre cinco avatares 3D
   animados ou personalize espécie, corpo, cores e acessórios. Salve as mudanças;
   preferências podem valer para todas as conversas ou apenas para a atual.

O navegador guarda o pareamento em cookie seguro e renova a sessão. Não use
janela anônima se quiser manter o acesso; apagar cookies exige novo pareamento.
Se abriu a versão anterior, use **Ctrl+Shift+R**. O endereço `/api/health` é apenas
diagnóstico, não a interface.

**Android:** baixe o [APK ARM64 assinado](https://app.okamibot.cloud/downloads/okamibot.apk?v=40390aa)
no telefone e instale. Ele usa o mesmo domínio público e não exige Tailscale.
Se já tiver o app, instale como atualização para preservar os dados. Caso o
Android recuse por assinatura diferente, não desinstale nem apague os dados para
contornar a recusa. Use a mesma chave na primeira entrada.

O APK tem 52.809.546 bytes e SHA256
`4923208c4255b2a99f6a45598ee80a81308043da1193befb66b10fa7e64a1557`.
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
sudo tailscale serve --bg --yes --set-path=/ /opt/okami-web/releases/40390aa-public
```

Mantenha os sufixos `/api` e `/executor` nos destinos: o Serve remove o prefixo
de montagem antes de encaminhar. A configuração anterior está guardada em
`/root/okami-deployment/serve.before-web.json` na VPS.

O túnel é `okamibot-app`, serviço `okami-cloudflared.service`, configurado em
`/etc/okami-cloudflared/`. Somente a credencial desse túnel fica na VPS; o
certificado administrativo do Cloudflare fica na máquina de administração.
O serviço roda com usuário próprio, limite de 128 MiB e reinício automático;
esse consumo utiliza a reserva do sistema no orçamento existente da VPS.
