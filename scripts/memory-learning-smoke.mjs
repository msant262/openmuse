// Connected-model acceptance. Isolated records and copied credentials; no real mail or user chats.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/apps/server/src/app.js";
import { readConfig } from "../dist/apps/server/src/config.js";
import { messageContentHash } from "../dist/apps/server/src/conversation-inbox.js";
import { createStore } from "../dist/apps/server/src/db.js";
import { ConversationAgent } from "../dist/apps/server/src/engine/conversation.js";
import { mailVersion } from "../dist/apps/server/src/proactivity/evidence.js";
import { ProactivityService } from "../dist/apps/server/src/proactivity/service.js";
import { modelProviderConfig } from "../dist/apps/server/src/providers/config.js";
import {
  readProtected,
  writeProtected,
} from "../dist/apps/server/src/providers/credential-store.js";

const directory = await mkdtemp(join(tmpdir(), "okami-learning-smoke-"));
const output =
  process.env.HARNESS_EVIDENCE_DIR ??
  join(process.cwd(), "artifacts", "memory-heartbeat", `connected-${Date.now()}`);
await mkdir(output, { recursive: true });
let db, server;
const report = { model: null, checks: [], phases: [] };
const upstream = globalThis.fetch;
const authEndpoints = new Set([
  "https://auth.openai.com/api/accounts/oauth/token",
  "https://auth.openai.com/oauth/token",
]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init?.body;
  const refresh =
    body instanceof URLSearchParams
      ? body.get("grant_type") === "refresh_token"
      : typeof body === "string" && new URLSearchParams(body).get("grant_type") === "refresh_token";
  if (authEndpoints.has(`${url.origin}${url.pathname}`) || refresh)
    throw new Error("Isolated acceptance cannot rotate the production OAuth grant");
  return upstream(input, init);
};
try {
  const original = readConfig(),
    sourceProviders = original.modelProviders ?? modelProviderConfig(original.dataDir);
  const providers = { ...sourceProviders, authDir: join(directory, "credentials") };
  for (const [field, name] of [
    ["chatgptFile", "chatgpt"],
    ["grokFile", "grok"],
    ["codexFile", "codex"],
  ]) {
    const credential = sourceProviders[field]
      ? await readProtected(sourceProviders[field])
      : undefined;
    if (typeof credential?.token_endpoint === "string") {
      const url = new URL(credential.token_endpoint);
      authEndpoints.add(`${url.origin}${url.pathname}`);
    }
    providers[field] = join(providers.authDir, `${name}.json`);
    if (credential) await writeProtected(providers[field], credential);
  }
  const config = {
    ...original,
    dataDir: directory,
    databaseUrl: undefined,
    modelProviders: providers,
    mode: "live",
    agentBackend: "model",
    taskWorkerEnabled: false,
    memoryLearningEnabled: true,
    semanticProactivityEnabled: true,
    proactivityEnabled: true,
    intelligenceApiKey: undefined,
    googleClientId: undefined,
    googleClientSecret: undefined,
    workerUrl: undefined,
    workerToken: undefined,
    browserFallbackEnabled: false,
    computerEnabled: false,
    nativeExecutors: [],
    nativeExecutorId: undefined,
    mcpServers: [],
    push: undefined,
    jevMode: "off",
    credentialsOpenBaoAddress: undefined,
    credentialsOpenBaoToken: undefined,
  };
  report.model = config.model;
  db = await createStore({ dataDir: join(directory, "db") });
  console.log(JSON.stringify({ stage: "isolated-database-ready" }));
  server = await createApp(db, config);
  const owner = "isolated-learning-acceptance";
  await server.agent.ensure(owner);
  await server.agent.profiles.update(owner, {
    scope: { kind: "global" },
    expectedRevision: 0,
    requestId: "smoke-language",
    origin: { kind: "settings" },
    patch: { language: "pt-BR" },
  });
  let sequence = 0;
  const add = async (text, threadId = "memory-smoke", at = Date.now()) => {
    const messageId = `evidence-${++sequence}`,
      value = { threadId, clientMessageId: messageId, text, attachmentIds: [], annotations: [] };
    await db.put(owner, "conversation-inbox", {
      ...value,
      id: `${threadId}:${messageId}`,
      messageId,
      runId: `run-${messageId}`,
      createdAt: new Date(at + sequence).toISOString(),
      contentHash: messageContentHash(value),
      status: "finished",
    });
  };
  const review = async (name) => {
    console.log(JSON.stringify({ stage: "review-start", name }));
    const id = await server.agent.learning.scheduleDue(owner);
    assert.ok(id);
    await server.agent.worker.tick();
    const task = await server.agent.getTask(owner, id),
      memories = await server.agent.memory.recall(owner);
    report.phases.push({
      name,
      status: task.status,
      error: task.error,
      summary: task.state.learningSummary,
      sources: task.input.learningSources,
      memories,
      operations: (await server.agent.journal.operations(owner, id)).map((o) => ({
        name: o.toolName,
        args: o.args,
        status: o.status,
        receipt: o.receipt,
      })),
    });
    await writeFile(join(output, "learning.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase: name, status: task.status, memories: memories.length }));
    assert.equal(
      task.status,
      "succeeded",
      `${name}: ${task.error ?? task.question ?? "review did not finish"}`,
    );
    return memories;
  };
  const before = Date.now() - 86400000;
  await add("Prefiro hotéis pequenos e silenciosos, longe de festas.", undefined, before);
  await add("Todo domingo de manhã eu caminho no parque.", undefined, before + 1000);
  await add(
    "Quero viajar para Lisboa daqui a duas semanas. Ainda não escolhi hotel nem passagem; depois retomamos os preparativos.",
    undefined,
    before + 2000,
  );
  await add(
    "Pesquise agora um preço de batom para presentear minha irmã; é só este presente.",
    undefined,
    before + 3000,
  );
  await add(
    "Exemplo fictício para um texto: uma personagem mora em Tóquio e gosta de sushi. Não sou eu.",
    undefined,
    before + 4000,
  );
  await add("Obrigado, ficou bom.", undefined, before + 5000);
  const first = await review("capture-and-noise-filter");
  const taste = first.find((m) => /hot[eé](?:is|l)/i.test(m.text) && m.category === "preference");
  assert.ok(taste, "explicit hotel preference learned");
  assert.ok(
    first.some((m) => m.category === "habit" && /parque|caminh/i.test(m.text)),
    "explicit recurring habit learned",
  );
  const trip = first.find((m) => m.category === "plan" && /Lisboa/i.test(m.text));
  assert.ok(trip?.followUp?.state === "open", "unfinished trip learned");
  assert.ok(
    first.every((m) => !/T[oó]quio|sushi|batom|irm[aã]|agradec/i.test(m.text)),
    "one-off requests, fiction and acknowledgements are not personal facts",
  );
  report.checks.push("automatic preference/habit/plan capture", "one-off and fiction exclusion");
  const conversation = new ConversationAgent(config, server.agent, owner);
  conversation.threadId = "fresh-chat";
  conversation.setMessages([
    {
      id: "fresh-question",
      role: "user",
      content:
        "Pelas minhas preferências que você já conhece, que tipo de hospedagem devo procurar? Responda brevemente, sem pesquisar nem criar tarefa.",
    },
  ]);
  await conversation.runAgent({ runId: "fresh-recall" });
  const answer = conversation.messages
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  assert.match(answer, /silencios|tranquil|quiet|fest/i, "fresh conversation uses saved taste");
  report.checks.push("fresh conversation recall");
  report.phases.push({ name: "fresh-recall", answer });
  const followUpTime = Math.max(Date.now(), Date.parse(trip.followUp.after)) + 60000;
  server.agent.proactivity = new ProactivityService(server.agent, () => followUpTime);
  await server.agent.proactivity.scheduleDue(owner);
  await server.agent.worker.tick();
  const cards = await server.agent.proactivity.list(owner);
  assert.ok(
    cards.some(
      (c) => c.target.kind === "memory" && c.target.memoryId === trip.id && c.status === "pending",
    ),
    "due travel plan produces an actionable follow-up",
  );
  report.phases.push({ name: "proactive-trip", cards });
  report.checks.push("proactive travel follow-up");
  await add("Desisti daquela viagem para Lisboa. Não vou mais e não quero lembretes dela.");
  const corrected = await review("cancel-same-plan");
  assert.equal(
    corrected.find((m) => m.id === trip.id)?.followUp?.state,
    "cancelled",
    "cancellation changes same plan",
  );
  assert.ok(
    !(await server.agent.proactivity.list(owner)).some(
      (c) => c.target.kind === "memory" && c.target.memoryId === trip.id && c.status === "pending",
    ),
    "old reminder retired",
  );
  report.checks.push("same-plan cancellation and reminder retirement");
  // Only the external source boundary is a fixture; the connected model makes the selection.
  const authority = { id: "synthetic-mail", account: "acceptance@example.test" };
  const mail = (id, subject, body) => ({
    id,
    threadId: id,
    from: "notice@example.test",
    to: [authority.account],
    sender: "Travel notice",
    subject,
    body,
    date: new Date(followUpTime).toISOString(),
    label: "Inbox",
    systemLabels: ["INBOX"],
    attachments: [],
  });
  const incoming = [
    mail(
      "flight",
      "Check-in deadline",
      `Your flight check-in closes at ${new Date(followUpTime + 18 * 3600000).toISOString()}. Complete it before the deadline to avoid losing your seat. No reply needed.`,
    ),
    mail(
      "newsletter",
      "Our weekly newsletter",
      "Discover this week's lifestyle articles. No action required.",
    ),
  ];
  server.workspace.proactivityMailCandidates = async () => ({
    authority,
    messages: incoming,
    complete: true,
    observedAt: new Date(followUpTime).toISOString(),
  });
  server.workspace.proactivityThread = async (_owner, id) => {
    const messages = incoming.filter((m) => m.threadId === id);
    return {
      authority,
      messages,
      complete: true,
      observedAt: new Date(followUpTime).toISOString(),
      version: mailVersion(messages),
    };
  };
  await server.agent.learning.scheduleDue(owner);
  await server.agent.proactivity.scheduleDue(owner, followUpTime, true);
  await server.agent.worker.tick();
  const mailCards = (await server.agent.proactivity.list(owner)).filter(
    (c) => c.target.kind === "mail",
  );
  assert.ok(
    mailCards.some((c) => c.target.threadId === "flight"),
    "connected model selects consequential no-reply notification",
  );
  assert.ok(
    !mailCards.some((c) => c.target.threadId === "newsletter"),
    "connected model leaves newsletter quiet",
  );
  report.phases.push({ name: "synthetic-mail-real-model", cards: mailCards });
  report.checks.push("important notification selected; newsletter suppressed");
  await server.agent.memory.forget(owner, taste.id);
  await add("Tudo certo, obrigado.");
  const forgotten = await review("forgotten-not-reintroduced");
  assert.ok(
    !forgotten.some((m) => /hot[eé](?:is|l)/i.test(m.text) && m.category === "preference"),
    "forgotten preference never reintroduced from old conversation",
  );
  report.checks.push("forgotten provenance suppression");
  // Successful-work fixture exercises the connected reviewer's procedural selection.
  const worked = await server.agent.taskRecord(
    owner,
    {
      title: "Repair an editable document workflow",
      prompt:
        "Create an editable slide deck. A reliable fix was verified: split dense prose into native text and tables, render every slide, inspect all pages after each layout revision, and attach only the final version. Never flatten the entire slide to a screenshot.",
    },
    "verified-document-method",
  );
  await db.put(owner, "tasks", {
    ...worked,
    status: "succeeded",
    result:
      "Verified method: preserve native editable objects; split dense prose before rendering; inspect all rendered pages at the latest revision after each layout change. Earlier page receipts cannot validate a changed layout. Final file is attached only after all current pages pass.",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  for (const [index, name] of [
    "create_document",
    "inspect_document",
    "confirm_document_review",
  ].entries())
    await db.put(owner, "task-operations", {
      id: `document-receipt-${index}`,
      taskId: worked.id,
      toolName: name,
      status: "succeeded",
      createdAt: new Date().toISOString(),
      receipt: {
        success: true,
        revision: 2,
        pages: 4,
        allPagesReviewed: true,
        nativeEditableText: true,
      },
    });
  await review("verified-procedure-learning");
  const procedures = await server.agent.playbooks.list(owner);
  assert.ok(
    procedures.some((p) => p.learned && p.sourceTaskId === worked.id),
    "verified reusable method is learned",
  );
  const reuse = new ConversationAgent(config, server.agent, owner);
  reuse.threadId = "procedure-reuse";
  reuse.setMessages([
    {
      id: "method-question",
      role: "user",
      content:
        "Consulte o procedimento que você aprendeu para documentos editáveis e explique brevemente como verificaria uma nova apresentação. Só explique; não crie arquivo nem tarefa agora.",
    },
  ]);
  await reuse.runAgent({ runId: "procedure-reuse" });
  assert.ok(
    reuse.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls?.some((c) => c.function?.name?.endsWith("list_procedures")),
    ),
    "fresh conversation actually reads the learned method",
  );
  report.phases.push({
    name: "procedure-reuse",
    procedures,
    answer: reuse.messages.filter((m) => m.role === "assistant").map((m) => m.content),
  });
  report.checks.push("verified procedure learning and actual reuse");
  // A new owner has only low-value conversation, so the connected reviewer must stay empty.
  const quietOwner = "isolated-noise-acceptance";
  await server.agent.ensure(quietOwner);
  await db.put(quietOwner, "conversation-inbox", {
    id: "quiet:thanks",
    messageId: "thanks",
    threadId: "quiet",
    text: "Ok, obrigado. Até logo!",
    status: "finished",
    createdAt: new Date().toISOString(),
  });
  const quietId = await server.agent.learning.scheduleDue(quietOwner);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask(quietOwner, quietId)).status, "succeeded");
  assert.equal((await server.agent.memory.recall(quietOwner)).length, 0);
  report.checks.push("quiet review saves nothing");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = upstream;
  await writeFile(join(output, "learning.json"), JSON.stringify(report, null, 2));
  if (server?.threads && "close" in server.threads) await server.threads.close();
  if (server) await server.agent.stop();
  if (db) await db.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure }),
);
