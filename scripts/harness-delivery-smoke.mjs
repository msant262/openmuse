// Run inside the candidate server image with its normal provider configuration.
// Uses an isolated temporary database; never reads or mutates production conversations.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/apps/server/src/app.js";
import { readConfig } from "../dist/apps/server/src/config.js";
import {
  configuredSecretScrubber,
  scrubConfiguredValue,
} from "../dist/apps/server/src/configured-secrets.js";
import { createStore } from "../dist/apps/server/src/db.js";
import { ConversationAgent } from "../dist/apps/server/src/engine/conversation.js";
import { modelProviderConfig } from "../dist/apps/server/src/providers/config.js";
import {
  readProtected,
  writeProtected,
} from "../dist/apps/server/src/providers/credential-store.js";
import { LocalThreads } from "../dist/apps/server/src/threads.js";
import { rasterMime } from "../dist/packages/domain/src/attachments.js";
import { inspectPdf } from "../dist/packages/integrations/src/pdf.js";
import { readPdfText } from "../dist/packages/integrations/src/pdf-text.js";

const mode = process.argv[2] ?? "pdf";
if (!["pdf", "image"].includes(mode)) throw new Error("Use pdf or image");
const evidence = process.env.HARNESS_EVIDENCE_DIR ?? "/evidence";
const directory = await mkdtemp(join(tmpdir(), "okami-harness-delivery-"));
const owner = "isolated-harness-delivery",
  threadId = randomUUID();
const events = [],
  files = [],
  blockedRefresh = new Set();
const secrets = Object.entries(process.env)
  .filter(([name]) => /(?:TOKEN|KEY|SECRET|PASSWORD)/i.test(name))
  .map(([, value]) => value)
  .filter(Boolean);
const safe = (value) => scrubConfiguredValue(value, configuredSecretScrubber(secrets));
const prompt =
  mode === "pdf"
    ? "obrigado gata, agora preciso que voce me gere um pdf sobre como voce funciona, harness, skills e tudo mais"
    : "Crie um infográfico bonito em português com estes dados definidos: Rotina de estudos, total 60 minutos. Leitura: 20 minutos. Exercícios: 30 minutos. Revisão: 10 minutos. Use os valores exatamente como fornecidos, layout vertical com três blocos e gráfico de divisão do tempo. Me entregue a imagem pronta aqui.";
let task, cancelChat, db, server, config, failure;
const upstream = globalThis.fetch;
const authEndpoints = new Map([
  ["https://auth.openai.com/api/accounts/oauth/token", "chatgpt"],
  ["https://auth.openai.com/oauth/token", "codex"],
]);
// A copied refresh token can still rotate the production grant remotely. Refuse
// every OAuth refresh before network dispatch, even though only copies are writable.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const provider = authEndpoints.get(`${url.origin}${url.pathname}`);
  const body = init?.body;
  const refresh =
    body instanceof URLSearchParams
      ? body.get("grant_type") === "refresh_token"
      : typeof body === "string" && new URLSearchParams(body).get("grant_type") === "refresh_token";
  if (provider || refresh) {
    blockedRefresh.add(provider ?? "oauth");
    throw new Error("HARNESS_OAUTH_REFRESH_BLOCKED: fresh production credentials are required");
  }
  return upstream(input, init);
};
const timer = setTimeout(() => {
  if (task) server?.agent.worker.abort(task.id);
  cancelChat?.();
}, 900000);
await mkdir(evidence, { recursive: true });
try {
  const original = readConfig();
  const sourceProviders = original.modelProviders ?? modelProviderConfig(original.dataDir);
  const modelProviders = { ...sourceProviders, authDir: join(directory, "credentials") };
  for (const [field, provider] of [
    ["chatgptFile", "chatgpt"],
    ["grokFile", "grok"],
    ["codexFile", "codex"],
  ]) {
    const source = sourceProviders[field];
    modelProviders[field] = join(modelProviders.authDir, `${provider}.json`);
    const credential = source ? await readProtected(source) : undefined;
    if (credential === undefined) continue;
    for (const [key, value] of Object.entries(credential))
      if (/(?:token|secret)/i.test(key) && typeof value === "string") secrets.push(value);
    if (provider === "grok" && typeof credential.token_endpoint === "string") {
      const url = new URL(credential.token_endpoint);
      authEndpoints.set(`${url.origin}${url.pathname}`, provider);
    }
    await writeProtected(modelProviders[field], credential);
  }
  config = {
    ...original,
    dataDir: directory,
    databaseUrl: undefined,
    modelProviders,
    intelligenceApiKey: undefined,
    agentBackend: "model",
    taskWorkerEnabled: false,
    proactivityEnabled: false,
    workerUrl: undefined,
    workerToken: undefined,
    browserFallbackEnabled: false,
    computerEnabled: false,
    computerBackend: "docker",
    computerUrl: undefined,
    computerToken: undefined,
    nativeExecutors: [],
    nativeExecutorId: undefined,
    mcpServers: [],
    push: undefined,
    jevMode: "off",
    googleClientId: undefined,
    googleClientSecret: undefined,
    credentialsOpenBaoAddress: undefined,
    credentialsOpenBaoToken: undefined,
  };
  db = await createStore({ dataDir: join(directory, "postgres") });
  server = await createApp(db, config, {
    credentialSecretStore: {
      async read() {
        return null;
      },
      async write() {
        throw new Error("Credential writes are disabled in isolated smoke");
      },
      async delete() {
        throw new Error("Credential deletes are disabled in isolated smoke");
      },
    },
  });
  if (!(server.threads instanceof LocalThreads)) throw new Error("Expected isolated local threads");
  await server.threads.ensure(owner, threadId);
  const conversation = new ConversationAgent(config, server.agent, owner);
  await new Promise((resolve, reject) => {
    const subscription = conversation
      .run({
        threadId,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: prompt }],
        tools: [],
        context: [],
        state: {},
      })
      .subscribe({
        next(event) {
          events.push(event);
          if (event.type === "TOOL_CALL_START")
            console.log(JSON.stringify({ stage: "chat-tool", tool: event.toolCallName }));
        },
        error: reject,
        complete: resolve,
      });
    cancelChat = () => {
      subscription.unsubscribe();
      reject(new Error("Chat deadline exceeded"));
    };
  });
  cancelChat = undefined;
  const tasks = await db.list(owner, "tasks");
  if (tasks.length !== 1)
    throw new Error(`Expected one real delegated task, received ${tasks.length}`);
  task = tasks[0];
  if (task.originThreadId !== threadId) throw new Error("Originating conversation lost");
  for (let attempt = 0; attempt < 6; attempt++) {
    await server.agent.worker.tick();
    task = await server.agent.getTask(owner, task.id);
    console.log(
      JSON.stringify({
        stage: "worker",
        attempt,
        status: task.status,
        artifacts: task.artifactIds.length,
      }),
    );
    if (task.status !== "queued") break;
  }
  for (const id of task.artifactIds) {
    const file = await server.files.get(owner, id),
      bytes = await server.files.bytes(owner, id);
    const extension =
      file.mimeType === "application/pdf"
        ? "pdf"
        : file.mimeType === "image/png"
          ? "png"
          : file.mimeType === "image/jpeg"
            ? "jpg"
            : file.mimeType === "image/webp"
              ? "webp"
              : "bin";
    await writeFile(join(evidence, `${mode}-${files.length}.${extension}`), bytes);
    let inspection;
    if (file.mimeType === "application/pdf") {
      const metadata = await inspectPdf(bytes);
      const text = await readPdfText(bytes);
      await writeFile(join(evidence, `${mode}-${files.length}.txt`), safe(text));
      inspection = { pages: metadata.pageCount, textCharacters: text.length };
      if (!text.trim()) throw new Error("Published PDF contains no readable page text");
    } else if (file.mimeType.startsWith("image/")) {
      if (rasterMime(bytes) !== file.mimeType)
        throw new Error("Published image bytes do not match MIME type");
      inspection = { signatureVerified: true };
    }
    files.push({
      id,
      name: file.name,
      mimeType: file.mimeType,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      inspection,
    });
  }
} catch (error) {
  failure = safe({
    name: error?.name,
    code: error?.code,
    message: String(error?.message ?? error),
  });
  process.exitCode = 2;
} finally {
  clearTimeout(timer);
  if (task && server) task = await server.agent.getTask(owner, task.id).catch(() => task);
  const publication =
    task && db ? await db.get(owner, "thread-publications", `task:${task.id}`) : undefined;
  const history =
    server?.threads instanceof LocalThreads
      ? await server.threads.history(owner, threadId).catch(() => undefined)
      : undefined;
  const detail =
    task && server ? await server.agent.detail(owner, task.id).catch(() => undefined) : undefined;
  const receipt = safe({
    mode,
    prompt,
    status: task?.status ?? "smoke_failed",
    failure,
    blockedCredentialRefresh: [...blockedRefresh],
    ...(blockedRefresh.size
      ? {
          blocker:
            "Fresh provider credentials required; isolated smoke refused to rotate production grants.",
        }
      : {}),
    model: config?.model,
    fallbacks: config?.modelFallbacks,
    error: task?.error,
    question: task?.question,
    result: task?.result,
    completion: task?.completion,
    files,
    chatTools: events
      .filter((event) => event.type === "TOOL_CALL_START")
      .map((event) => event.toolCallName),
    chatErrors: events.filter((event) => event.type === "RUN_ERROR").map((event) => event.message),
    operations: (task && server ? await server.agent.journal.operations(owner, task.id) : []).map(
      (operation) => ({
        tool: operation.toolName,
        status: operation.status,
      }),
    ),
    publication: {
      status: publication?.status,
      correctThread: publication?.threadId === threadId,
      messagePresent: Boolean(
        publication &&
          history?.messages.some(
            (message) => message.role === "assistant" && message.content === publication.text,
          ),
      ),
      filesPresent:
        files.length > 0 &&
        files.every((file) => detail?.files.some((item) => item.id === file.id)),
    },
  });
  await writeFile(join(evidence, `${mode}-receipt.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (
    failure ||
    blockedRefresh.size ||
    task?.status !== "succeeded" ||
    !files.some((file) =>
      mode === "pdf" ? file.mimeType === "application/pdf" : file.mimeType.startsWith("image/"),
    ) ||
    publication?.status !== "posted" ||
    publication?.threadId !== threadId ||
    !receipt.publication.messagePresent ||
    !receipt.publication.filesPresent
  )
    process.exitCode = 2;
  if (server) {
    await server.codexConnection.close();
    await server.agent.stop();
    await server.threads.close();
    await server.actions.close();
  }
  await db?.close();
  await rm(directory, { recursive: true, force: true });
  globalThis.fetch = upstream;
}
