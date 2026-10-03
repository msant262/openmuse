# Abrir e testar o OkamiBot

A instalação atual já está na VPS. Para usar, não precisa instalar Node, Docker
ou executar o projeto na sua máquina.

1. Use um navegador atualizado no computador ou celular. Não precisa de Tailscale.
2. Abra **https://app.okamibot.cloud**.
3. Na primeira entrada, cole a chave no campo **Workspace access key** e clique
   em **Open workspace**. Na Aoostar, a chave está no arquivo privado
   `/home/marcos/.local/share/okamibot/access-key.txt`. Você pode abrir esse arquivo
   no editor ou, no terminal da Aoostar, executar:

   ```bash
   cat /home/marcos/.local/share/okamibot/access-key.txt
   ```

   Copie a chave somente para a tela de entrada; não envie em conversas.
4. O app abre em **Chat**. Experimente: “Olá, me explique o que você consegue
   fazer”. O modelo padrão é GPT-6 Luna pela assinatura ChatGPT; Grok está
   conectado como fallback. MiMo ainda depende de uma chave.
5. O botão **Computer · ready**, no topo, abre o computador do agente.
   **Apps** reúne conexões; **Activity** mostra tarefas e andamento.

O navegador guarda o pareamento em cookie seguro e renova a sessão. Não use
janela anônima se quiser manter o acesso; apagar cookies exige novo pareamento.
Se abriu a versão anterior com erro de conexão, use **Ctrl+Shift+R**. O endereço
`/api/health` é apenas diagnóstico, não a interface.

O APK Android anterior foi construído com o endereço privado e ainda exige
Tailscale. Ele será substituído por um build com o endereço público e a interface
revisada; até lá, o navegador já permite testar o acesso público. Gmail/Calendar e push ainda precisam da configuração das
contas correspondentes; não são necessários para abrir o chat.

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
sudo tailscale serve --bg --yes --set-path=/ /opt/okami-web/releases/111ba4e-public
```

Mantenha os sufixos `/api` e `/executor` nos destinos: o Serve remove o prefixo
de montagem antes de encaminhar. A configuração anterior está guardada em
`/root/okami-deployment/serve.before-web.json` na VPS.

O túnel é `okamibot-app`, serviço `okami-cloudflared.service`, configurado em
`/etc/okami-cloudflared/`. Somente a credencial desse túnel fica na VPS; o
certificado administrativo do Cloudflare fica na máquina de administração.
O serviço roda com usuário próprio, limite de 128 MiB e reinício automático;
esse consumo utiliza a reserva do sistema no orçamento existente da VPS.
