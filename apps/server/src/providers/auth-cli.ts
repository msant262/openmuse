import "../config.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  beginChatGPTSignIn,
  CHATGPT_RESOURCE,
  chatGPTAccessToken,
  completeChatGPTSignIn,
  importChatGPTCredential,
} from "./chatgpt-auth.ts";
import { modelProviderConfig } from "./config.ts";
import { hostId, readProtected } from "./credential-store.ts";
import { grokDeviceLogin } from "./grok-auth.ts";

/** Laptop loopback only. Every token remains in server-side memory/protected files. */
export async function laptopSignIn(file: string, authDir: string, port = 1455, openBrowser = true) {
  let attempt: Awaited<ReturnType<typeof beginChatGPTSignIn>>;
  let resolveResult: () => void;
  let rejectResult: (error: unknown) => void;
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || callback.pathname !== "/auth/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    void completeChatGPTSignIn(file, attempt, callback.searchParams)
      .then(() => {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
        });
        response.end("<p>OpenMuse sign-in completed. You can close this window.</p>");
        resolveResult();
      })
      .catch((error) => {
        response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Sign-in could not be validated. Return to the terminal.");
        rejectResult(error);
      });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the sign-in callback.");
  const timeout = setTimeout(
    () => rejectResult(new Error("ChatGPT sign-in timed out. Start a fresh login.")),
    10 * 60000,
  );
  try {
    attempt = await beginChatGPTSignIn(
      file,
      authDir,
      `http://127.0.0.1:${address.port}/auth/callback`,
    );
    console.log("Continue with ChatGPT: open this link on this laptop to authorize OpenMuse:");
    console.log(attempt.url); // Optional token hints are deliberately omitted.
    if (openBrowser) {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer.exe"
            : "xdg-open";
      const browser = spawn(command, [attempt.url], { stdio: "ignore" });
      browser.on("error", () => {});
      browser.unref();
    }
    await result;
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const usage =
  "Usage: pnpm auth chatgpt host|login|import FILE|models|status [--file PATH] [--port 1455] [--no-browser]; pnpm auth grok login|status [--file PATH]";

export async function authCLI(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const [provider, command, ...rest] = args;
  const settings = modelProviderConfig(resolve(process.env.DATA_DIR ?? ".openmuse"));
  const fileOption = rest.indexOf("--file");
  const file =
    fileOption >= 0
      ? resolve(rest[fileOption + 1] ?? "")
      : provider === "chatgpt"
        ? settings.chatgptFile
        : settings.grokFile;
  if (provider === "chatgpt" && command === "host") {
    console.log(await hostId(settings.authDir));
    return;
  }
  if (provider === "chatgpt" && command === "login") {
    const portOption = rest.indexOf("--port");
    const port = portOption >= 0 ? Number(rest[portOption + 1]) : 1455;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("--port must be an available integer port.");
    await laptopSignIn(file, settings.authDir, port, !rest.includes("--no-browser"));
    console.log("Protected ChatGPT registration saved. The VM should own refresh after import.");
    return;
  }
  if (provider === "chatgpt" && command === "import" && rest[0] && !rest[0].startsWith("--")) {
    await importChatGPTCredential(resolve(rest[0]), file, settings.authDir);
    console.log("Registration imported; this VM's host identity was preserved.");
    return;
  }
  if (provider === "chatgpt" && command === "models") {
    const token = await chatGPTAccessToken(file);
    const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`ChatGPT model catalog was unavailable (HTTP ${response.status}).`);
    const catalog = (await response.json()) as {
      models?: { visibility?: string; slug?: string; display_name?: string }[];
    };
    console.log(
      JSON.stringify(
        catalog.models
          ?.filter((m) => m.visibility === "list")
          .map((m) => ({ id: m.slug, name: m.display_name })) ?? [],
        null,
        2,
      ),
    );
    return;
  }
  if ((provider === "grok" || provider === "xai-oauth") && command === "login") {
    await grokDeviceLogin(file, ({ url, code }) => {
      console.log(
        `Open ${url} on your phone or laptop and enter ${code}. Waiting for device authorization…`,
      );
    });
    console.log("Protected Grok subscription credentials saved.");
    return;
  }
  if (["chatgpt", "grok", "xai-oauth"].includes(provider) && command === "status") {
    const record = (await readProtected(file)) as Record<string, unknown> | undefined;
    console.log(
      JSON.stringify(
        {
          provider,
          connected: Boolean(record?.access_token && record?.refresh_token),
          ...(provider === "chatgpt" && {
            clientId: record?.client_id,
            account: record?.email,
            planUsage:
              Array.isArray(record?.scopes) && record.scopes.includes("chatgpt.tokens.use.direct"),
          }),
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(usage);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  authCLI(process.argv.slice(2)).catch((error) => {
    // Never print raw network errors or provider payloads.
    console.error(
      error instanceof Error && error.name !== "TypeError"
        ? error.message
        : "Authentication failed. Check connectivity and the protected file format.",
    );
    process.exitCode = 1;
  });
}
