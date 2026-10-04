import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { writeProtected } from "../apps/server/src/providers/credential-store.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const url = "https://example.org/article";
const input = (text = `Summarize ${url}`) => ({
  threadId: "browser-chat",
  runId: randomUUID(),
  messages: [{ id: randomUUID(), role: "user" as const, content: text }],
  tools: [],
  context: [],
  state: {},
});
const run = (agent: ConversationAgent, text?: string) =>
  lastValueFrom(agent.run(input(text)).pipe(toArray()));
const delegate = {
  name: "delegate_task",
  arguments: { kind: "agent", title: "Read the article", prompt: `Summarize ${url}` },
};

test("a spoken handoff ends after its durable receipt without a second status paragraph", async (t) => {
  const fixture = await modelFixture(t, (index) => (index === 0 ? delegate : undefined), {
    text: (index) =>
      index === 0
        ? "Vou conferir os números e já te trago o resumo."
        : "A checagem foi encaminhada.",
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const events = await run(new ConversationAgent(server.agent.config, server.agent, "owner"));
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  assert.ok(events.some((event) => event.type === EventType.TOOL_CALL_RESULT));
  assert.equal(
    fixture.requests.length,
    1,
    "admission plus an existing reply needs no extra model turn",
  );
  const text = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => event.delta)
    .join("");
  assert.match(text, /Vou conferir/);
  assert.doesNotMatch(text, /encaminhada/);
});

test("a subscription response buffered until its terminal receipt still acknowledges a handoff only once", async (t) => {
  const fixture = await modelFixture(t, (index) => (index === 0 ? delegate : undefined), {
    toolNamespace: "openmuse",
    text: (index) => (index === 0 ? "Vou conferir os números." : "A checagem foi encaminhada."),
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "chatgpt/gpt-6-luna" });
  const providers = modelProviderConfig(server.agent.config.dataDir, {});
  server.agent.config.modelProviders = providers;
  await writeProtected(providers.chatgptFile, {
    issuer: "https://auth.openai.com",
    subject: "account",
    client_id: "oaiapp_fixture",
    ext_agent_host_id: "urn:uuid:12345678-1234-4123-8123-123456789abc",
    access_token: "subscription-access",
    refresh_token: "subscription-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    scopes: ["chatgpt.tokens.use.direct"],
    saved_at: new Date().toISOString(),
  });
  const originalFetch = globalThis.fetch;
  const inferenceUrl = process.env.OPENAI_BASE_URL;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    return originalFetch(`${inferenceUrl}/responses`, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
    });
  });
  const events = await run(new ConversationAgent(server.agent.config, server.agent, "owner"));
  assert.ok(!events.some((e) => e.type === EventType.RUN_ERROR), JSON.stringify(events));
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  assert.equal(
    fixture.requests.length,
    1,
    "buffered text must count before another inference starts",
  );
});

test("research runs in the worker while another chat message gets its own reply", {
  timeout: 15000,
}, async (t) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  t.after(() => release());
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? delegate
        : index === 2
          ? { name: "web_fetch", arguments: { url } }
          : index === 4
            ? {
                name: "finish_task",
                arguments: { summary: "The article explains how to plant basil." },
              }
            : undefined,
    {
      text: (index) =>
        index === 1
          ? "The article task is running. We can keep chatting."
          : index === 3
            ? "Yes, I am here."
            : undefined,
    },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0;
  t.mock.method(server.agent.web, "read", async () => {
    reads++;
    enter();
    await gate;
    return {
      url,
      title: "Planting basil",
      text: "The article explains how to plant basil.",
      links: [],
      truncated: false,
    };
  });
  const agent = new ConversationAgent(server.agent.config, server.agent, "owner");
  const first = await run(agent);
  assert.equal(reads, 0, "no remote research in the foreground");
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(JSON.parse(fixture.requests[1].body).tools ?? [], []);
  assert.ok(
    first.some(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK && String(e.delta).includes("keep chatting"),
    ),
    JSON.stringify(first),
  );
  const worker = server.agent.worker.tick();
  await entered;
  const before = Date.now();
  const reply = await run(agent, "Are you still here?");
  assert.ok(
    Date.now() - before < 2000,
    "synthetic fast provider must not wait for the worker gate",
  );
  assert.ok(
    reply.some((e) => e.type === EventType.TEXT_MESSAGE_CHUNK && e.delta === "Yes, I am here."),
  );
  const tasks = await server.agent.snapshot("owner");
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].status, "running");
  release();
  await worker;
  assert.ok(fixture.requests[4].body.includes("how to plant basil"));
  assert.equal((await server.agent.getTask("owner", tasks.tasks[0].id)).status, "succeeded");
});

test("external tools cannot accidentally block the foreground or trigger connector discovery", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0 ? { name: "browse_web", arguments: { url } } : undefined,
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0,
    discovery = 0;
  t.mock.method(server.agent.browser, "observeForThread", async () => {
    reads++;
    throw Error("Should run in worker");
  });
  t.mock.method(server.agent.mcp, "tools", async () => {
    discovery++;
    throw Error("Offline connector");
  });
  const events = await run(new ConversationAgent(server.agent.config, server.agent, "owner"));
  assert.equal(reads, 0);
  assert.equal(discovery, 0);
  assert.doesNotMatch(
    fixture.requests[0].body,
    /"name":"(?:browse_web|web_fetch|create_document|search_mail)"/,
  );
  const receipt = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  assert.ok(receipt && receipt.type === EventType.TOOL_CALL_RESULT);
  assert.match(String(receipt.content), /Unknown tool/);
});

test("delegated mail reads preserve owner isolation and never send mail", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        {
          name: "delegate_task",
          arguments: {
            kind: "agent",
            title: "Check school mail",
            prompt: "Read my aquarium school trip email and summarize the time",
          },
        },
        undefined,
        { name: "read_workspace", arguments: { section: "mail" } },
        { name: "read_mail_thread", arguments: { threadId: "trip-thread" } },
        { name: "finish_task", arguments: { summary: "The school trip leaves at 8:15 AM." } },
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await server.workspace.ensureSample("owner", server.actions);
  await server.workspace.ensureSample("another-owner", server.actions);
  const foreign = (await server.workspace.thread("another-owner", "trip-thread"))[0];
  await server.db.put("another-owner", "mail", { ...foreign, body: "PRIVATE FOREIGN DETAILS" });
  const actions = await server.db.list("owner", "actions");
  await run(
    new ConversationAgent(server.agent.config, server.agent, "owner"),
    "Check my aquarium school trip email",
  );
  assert.equal(fixture.requests.length, 2);
  await server.agent.worker.tick();
  assert.ok(fixture.requests[4].body.includes("8:15 AM"));
  assert.ok(!fixture.requests.some((r) => r.body.includes("PRIVATE FOREIGN DETAILS")));
  assert.deepEqual(await server.db.list("owner", "actions"), actions);
});

test("delegated mail cannot read another owner's thread", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      [
        {
          name: "delegate_task",
          arguments: { kind: "agent", prompt: "Read my school trip email" },
        },
        undefined,
        { name: "read_mail_thread", arguments: { threadId: "trip-thread" } },
        undefined,
      ][index],
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await server.workspace.ensureSample("another-owner", server.actions);
  await run(
    new ConversationAgent(server.agent.config, server.agent, "owner"),
    "Read my school trip email",
  );
  await server.agent.worker.tick();
  assert.match(fixture.requests[3].body, /not found/);
  assert.ok(!fixture.requests[3].body.includes("8:15 AM"));
});

test("the admitted handoff writes with the current SOUL and receipt without replaying old status prose", async (t) => {
  const fixture = await modelFixture(t, (index) => (index === 0 ? delegate : undefined), {
    text: (index) => (index === 1 ? "Já vejo isso, gata." : undefined),
  });
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await server.agent.profiles.update("owner", {
    scope: { kind: "global" },
    patch: { personality: "Afetuosa, divertida, com energia de diva." },
    expectedRevision: 0,
    requestId: "voice",
    origin: { kind: "settings" },
  });
  const request = input();
  const events = await lastValueFrom(
    new ConversationAgent(server.agent.config, server.agent, "owner")
      .run({
        ...request,
        messages: [
          {
            id: "old-status",
            role: "assistant",
            content: "LEGACY_STATUS_PROSE: A checagem foi encaminhada. Ainda não tenho dados.",
          },
          ...request.messages,
        ],
      })
      .pipe(toArray()),
  );
  assert.ok(!events.some((e) => e.type === EventType.RUN_ERROR));
  assert.equal((await server.agent.snapshot("owner")).tasks.length, 1);
  assert.equal(fixture.requests.length, 2);
  assert.match(fixture.requests[0].body, /LEGACY_STATUS_PROSE/);
  const confirmation = JSON.parse(fixture.requests[1].body);
  assert.doesNotMatch(fixture.requests[1].body, /LEGACY_STATUS_PROSE/);
  assert.match(fixture.requests[1].body, /Afetuosa, divertida, com energia de diva/);
  assert.match(fixture.requests[1].body, /Read the article/);
  assert.ok(JSON.stringify(confirmation.input).includes(url));
  assert.deepEqual(confirmation.tools ?? [], []);
});
