/** Static OAuth result page: never interpolate provider errors, codes or account data. */
export function googleCallbackPage(result: "connected" | "cancelled" | "failed") {
  const title =
    result === "connected"
      ? "Google conectado"
      : result === "cancelled"
        ? "Conexão cancelada"
        : "Não foi possível conectar";
  const message =
    result === "connected"
      ? "Sua conta está conectada. A tela de conexões do Okami será atualizada automaticamente."
      : result === "cancelled"
        ? "Você cancelou a autorização. Pode voltar ao Okami e tentar novamente quando quiser."
        : "A autorização expirou ou o Google não conseguiu concluí-la. Volte ao Okami e toque em Conectar novamente.";
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · OkamiBot</title><style>body{font:18px/1.6 system-ui;background:#17191d;color:#f5f5f7;margin:0;padding:24px}main{max-width:480px;margin:12vh auto}h1{font-size:28px}p{color:#c5c7d0}a{display:inline-block;background:#635bff;color:white;padding:12px 24px;border-radius:12px;text-decoration:none}</style><main><h1>${title}</h1><p>${message}</p><a href="/">Voltar ao Okami</a><p>Se abriu esta página pelo aplicativo, você também pode fechar esta janela e voltar para ele.</p></main></html>`;
}
