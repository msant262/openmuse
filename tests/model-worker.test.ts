import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";
import { fixture as computerFixture } from "./helpers/computer.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

test("CopilotKit model worker executes server tools and persists the confirmed outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-"));
  const db = await createStore();
  const calls: { name: string; arguments: object }[] = [
    {
      name: "set_plan",
      arguments: { steps: ["Inspect available sources", "Save a practical plan"] },
    },
    { name: "read_workspace", arguments: { section: "files" } },
    {
      name: "run_computer_command",
      arguments: { operationId: "check-working-directory", command: "pwd", cwd: "/workspace" },
    },
    {
      name: "save_artifact",
      arguments: {
        kind: "plan",
        title: "Weekend plan",
        summary: "A walk and time to read",
        data: { steps: ["Take a walk", "Read for 30 minutes"] },
      },
    },
    { name: "finish_task", arguments: { summary: "Saved your weekend plan with two steps." } },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(
    db,
    {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: directory,
      agentBackend: "model",
      intelligenceApiKey: "test-project-key-never-sent",
      model: "openai/fixture",
      modelProviders: richChatFixtureProviders(directory),
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      computerEnabled: true,
    },
    { docker: computerFixture().runner },
  );
  try {
    const task = await server.agent.createTask("owner", {
      prompt: "Make a weekend plan",
      kind: "plan",
    });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.result, "Saved your weekend plan with two steps.");
    assert.ok(result.artifacts.some((a) => a.title === "Weekend plan"));
    assert.ok(
      result.events.some((event) => event.title === "Read the authorized workspace sources"),
    );
    assert.ok(requests.length >= 4 && requests.length <= 6);
    assert.ok(requests.every((request) => request.path === "/v1/responses"));
    assert.ok(requests[0].body.includes('"name":"prepare_email"'));
    assert.ok(requests[0].body.includes('"name":"run_computer_command"'));
    assert.ok(
      requests.some(
        (request) => request.body.includes("succeeded") && request.body.includes("hello"),
      ),
    );
    assert.equal((await server.computer.snapshot("owner")).commands[0]?.status, "succeeded");
    assert.ok(!requests[0].body.includes('"name":"approve"'));
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "prepare_event",
      arguments: {
        title: "Sample walk",
        start: "2026-10-10T10:00:00-07:00",
        end: "2026-10-10T11:00:00-07:00",
      },
    });
    const appointment = await server.agent.createTask("owner", {
      prompt: "Prepare a sample walk on my calendar",
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("owner", appointment.id);
    assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
    assert.ok(pending.actionId);
    const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId);
    assert.ok(proposal);
    await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
    requests.length = 0;
    calls.splice(0, calls.length, {
      name: "finish_task",
      arguments: { summary: "The reviewed sample event is on the calendar." },
    });
    await server.agent.worker.tick();
    const finished = await server.agent.getTask("owner", appointment.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.ok(requests[0].body.includes("approvalResult"));
    assert.equal(
      (await db.list<ActionProposal>("owner", "actions")).filter((a) => a.taskId === appointment.id)
        .length,
      1,
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model worker keeps the text a model replies with when it calls no tool", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-text-"));
  const db = await createStore();
  const mock = createDemoModel({ latency: 0, firstByteDelay: 0 });
  await mock.start();
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-demo-test";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await mock.stop();
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: demoModel,
    modelProviders: richChatFixtureProviders(directory, [demoModel]),
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
    await server.agent.worker.tick();
    const result = await server.agent.detail("owner", task.id);
    assert.equal(result.task.status, "failed");
    assert.match(String(result.task.state.lastUpdate), /Find cool stuff on Hacker News/);
    assert.ok(
      result.events.some(
        (event) =>
          event.title === "Partial delivery" && /Find cool stuff on Hacker News/.test(event.detail),
      ),
      "the reply is recorded in the task timeline",
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaying a completed prepared action returns its receipt without reopening approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-replay-"));
  const db = await createStore();
  const draft = {
    title: "Sample walk",
    start: "2026-10-10T10:00:00-07:00",
    end: "2026-10-10T11:00:00-07:00",
  };
  let calls: ({ name: string; arguments: object } | undefined)[] = [
    { name: "prepare_event", arguments: draft },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(directory),
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  try {
    const task = await server.agent.createTask("replay-owner", {
      prompt: "Put a sample walk on my calendar",
    });
    await server.agent.worker.tick();
    const pending = await server.agent.getTask("replay-owner", task.id);
    assert.equal(pending.status, "waiting_approval");
    assert.ok(pending.actionId);
    const proposal = await db.get<ActionProposal>("replay-owner", "actions", pending.actionId);
    assert.ok(proposal);
    const completed = await server.actions.decide(
      "replay-owner",
      proposal.id,
      proposal.hash,
      "approve",
    );
    assert.equal(completed.status, "succeeded");

    requests.length = 0;
    calls = [
      { name: "prepare_event", arguments: draft },
      { name: "finish_task", arguments: { summary: "The reviewed event is already complete." } },
    ];
    await server.agent.worker.tick();

    const finished = await server.agent.getTask("replay-owner", task.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.equal(finished.state.approvalResult, completed.result);
    const actions = (await db.list<ActionProposal>("replay-owner", "actions")).filter(
      (action) => action.taskId === task.id,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, "succeeded");
    assert.ok(requests.some((request) => request.body.includes(String(completed.result))));
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser reads keep observation identity distinct while reusing one session", async (t) => {
  let currentUrl = "https://example.com/one";
  const sessionIds = new Set<string>();
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      const id = String(body.id);
      currentUrl = String(body.url);
      sessionIds.add(id);
      return {
        data: {
          id,
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read")) {
      return {
        data: {
          url: currentUrl,
          title: currentUrl.endsWith("/one") ? "Source one" : "Source two",
          text: `Evidence from ${currentUrl}`,
          truncated: false,
        },
      };
    }
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls: { name: string; arguments: object }[] = [
    { name: "read_web", arguments: { url: "https://example.com/one" } },
    { name: "read_web", arguments: { url: "https://example.com/two" } },
    { name: "finish_task", arguments: { summary: "Compared both public sources." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());

  const task = await app.agent.createTask("owner", {
    prompt: "Read both public sources and compare them.",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  const webEvidence = saved.evidence.filter((item) => item.kind === "web");
  assert.equal(webEvidence.length, 2);
  assert.deepEqual(
    webEvidence.map((item) => item.url),
    ["https://example.com/one", "https://example.com/two"],
  );
  assert.equal(sessionIds.size, 1, "both reads should reuse the same browser session");
  assert.equal(new Set(webEvidence.map((item) => item.id)).size, 2);
});

test("model browser takeover pauses without later tools and handback resumes the saved profile", async (t) => {
  let human = true;
  let sessionId = "";
  let navigations = 0;
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      sessionId = String(body.id);
      if (human)
        return {
          status: 409,
          data: {
            error: {
              code: "BROWSER_CONTROLLED",
              message: "Hand the browser back",
              details: { sessionId },
            },
          },
        };
      navigations++;
    }
    if (path.endsWith("/snapshot"))
      return {
        data: {
          sessionId,
          snapshotId: crypto.randomUUID(),
          url: "https://example.com/",
          title: "Observed",
          text: "Page ready",
          truncated: false,
          truncatedElements: false,
          control: "agent",
          elements: [],
        },
      };
    return {
      data: {
        id: sessionId,
        url: "https://example.com/",
        title: "Observed",
        status: "active",
        control: human ? "human" : "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  let calls: { name: string; arguments: object }[] = [
    { name: "browser_navigate", arguments: { url: "https://example.com/" } },
    { name: "finish_task", arguments: { summary: "Should never finish while controlled" } },
  ];
  let offset = 0;
  const model = await modelFixture(t, (index) => calls[index - offset]);
  const server = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => server.agent.stop());
  const task = await server.agent.createTask("owner", {
    prompt: "Use the browser and complete the requested task.",
  });
  await server.agent.worker.tick();
  const paused = await server.agent.getTask("owner", task.id);
  assert.equal(paused.status, "paused", paused.error ?? paused.question);
  assert.equal(paused.state.awaitingBrowserSessionId, sessionId);
  assert.equal(navigations, 0);
  assert.equal(paused.artifactIds.length, 0, "finish_task after takeover has no effects");
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", task.id)).attempts, 1);
  human = false;
  offset = model.requests.length;
  calls = [
    { name: "browser_navigate", arguments: { url: "https://example.com/" } },
    { name: "finish_task", arguments: { summary: "Completed after handback" } },
  ];
  await server.agent.worker.tick();
  const resumed = await server.agent.getTask("owner", task.id);
  assert.equal(resumed.status, "succeeded", resumed.error ?? resumed.question);
  assert.equal(resumed.state.browserId, sessionId);
  assert.equal(navigations, 1);
  assert.equal(resumed.attempts, 2);
});

test("browser research fallback records real offers and excludes access-denied pages", async (t) => {
  let currentUrl = "https://shop.example/denied";
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      currentUrl = String(body.url);
      return {
        data: {
          id: body.id,
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/snapshot")) {
      const denied = currentUrl.endsWith("denied");
      return {
        data: {
          sessionId: path.split("/")[2],
          snapshotId: randomUUID(),
          url: currentUrl,
          title: denied ? "Access Denied" : "Make-up Sale",
          text: denied
            ? "Access Denied. You do not have permission."
            : "Batom por €12 em estoque na Alemanha",
          truncated: false,
          truncatedElements: false,
          control: "agent",
          elements: [],
        },
      };
    }
    throw new Error(`Unexpected browser route ${path}`);
  });
  const calls = [
    { name: "browser_research", arguments: { url: "https://shop.example/denied" } },
    { name: "browser_research", arguments: { url: "https://shop.example/sale" } },
    { name: "finish_task", arguments: { summary: "Batom por €12; a outra loja bloqueou acesso." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", {
    prompt: "Pesquisar promoções de maquiagem",
    criteria: [
      {
        id: "offers",
        kind: "observation",
        description: "Ofertas verificadas",
        requiredItems: ["Batom", "€12"],
      },
    ],
  });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.question ?? saved.error ?? undefined);
  assert.deepEqual(
    saved.evidence.map((item) => item.url),
    ["https://shop.example/sale"],
  );
  assert.match(saved.evidence[0].excerpt, /€12/);
  assert.equal((await browser.db.list("owner", "interaction-requests")).length, 0);
});
