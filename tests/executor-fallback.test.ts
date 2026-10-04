import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  type BrowserExecutor,
  CapabilityRouter,
  classifyBrowserOperation,
} from "../apps/server/src/executors/capability-router.ts";
import { verifyBrowserExecutor } from "../packages/domain/src/browser-executor.ts";
import { browserFixture } from "./helpers/browser.ts";
import { browserFallbackFixture } from "./helpers/browser-fallback.ts";

function executor(id: string, transport: "native" | "vps"): BrowserExecutor {
  return {
    executorId: id,
    hostId: id,
    transport,
    epoch: 1,
    sessionGeneration: `generation-${id}`,
    profileId: randomUUID(),
    sessionId: randomUUID(),
    ready: true,
    capabilities: [
      { name: "browser.dom", version: 1 },
      { name: "browser.screenshot", version: 1 },
    ],
  };
}
async function setup(t: import("node:test").TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const primary = executor("lenovo", "native"),
    fallback = executor("openmuse-server", "vps");
  let identity: { accountId: string; authenticatedAt: string } | undefined;
  const router = new CapabilityRouter(db, {
    executors: async () => [primary, fallback],
    authentication: async () => identity,
  });
  return {
    db,
    primary,
    fallback,
    router,
    login: (accountId: string) => {
      identity = { accountId, authenticatedAt: new Date().toISOString() };
    },
  };
}
const research = {
  owner: "owner",
  taskId: "research",
  capability: "browser.dom" as const,
  artifactVersions: [],
  operationClass: "public_read" as const,
};

test("a headless request never selects the native GUI, including after a VPS outage", async (t) => {
  const { router, fallback } = await setup(t);
  const request = { ...research, requiredTransport: "vps" as const };
  const binding = await router.choose(request);
  assert.equal(binding.executorId, "openmuse-server");
  fallback.ready = false;
  await assert.rejects(router.choose(request), { code: "BROWSER_EXECUTOR_UNAVAILABLE" });
});

test("concrete browser operations never classify an action, import or unknown endpoint as public reading", () => {
  assert.equal(classifyBrowserOperation("snapshot", true), "public_read");
  assert.equal(classifyBrowserOperation("open", true), "public_read");
  assert.equal(classifyBrowserOperation("search", true), "public_read");
  for (const operation of [
    "act",
    "reviewed-act",
    "credentials",
    "downloads",
    "close",
    "input",
    "unexpected",
  ])
    assert.equal(classifyBrowserOperation(operation, true), "mutable");
  assert.equal(classifyBrowserOperation("snapshot", false), "authenticated_read");
});
test("public research prefers Lenovo and migrates once to a new VPS session when offline", async (t) => {
  const { router, primary, fallback } = await setup(t);
  const initial = await router.choose(research);
  assert.equal(initial.executorId, "lenovo");
  primary.ready = false;
  const next = await router.choose(research);
  assert.equal(next.executorId, "openmuse-server");
  assert.equal(next.sessionId, fallback.sessionId);
  assert.notEqual(next.sessionId, initial.sessionId);
  assert(next.fence > initial.fence);
  await assert.rejects(router.assertCurrent("owner", initial), { code: "STALE_BROWSER_BINDING" });
  primary.ready = true;
  assert.deepEqual(await router.choose(research), next); // no silent return to the old profile
});
test("offline before first public read starts on VPS; screenshot support never grants pointer or desktop", async (t) => {
  const { router, primary } = await setup(t);
  primary.ready = false;
  assert.equal((await router.choose(research)).transport, "vps");
  await assert.rejects(
    router.choose({ ...research, taskId: "pointer", capability: "browser.pointer" }),
    { code: "BROWSER_EXECUTOR_UNAVAILABLE" },
  );
  await assert.rejects(router.choose({ ...research, taskId: "shell", capability: "command" }), {
    code: "CAPABILITY_NOT_MIGRATABLE",
  });
});
test("mutable work and uncertain dispatched browser operations do not migrate on partition or restart", async (t) => {
  const { router, primary, db } = await setup(t);
  const initial = await router.choose({ ...research, operationClass: "mutable" });
  primary.ready = false;
  await assert.rejects(router.choose({ ...research, operationClass: "mutable" }), {
    code: "BROWSER_EXECUTOR_UNAVAILABLE",
  });
  await db.put("owner", "task-operations", {
    id: "write",
    taskId: "research",
    effect: true,
    toolName: "browser_act",
    status: "outcome_unknown",
  });
  await assert.rejects(router.choose(research), { code: "BROWSER_OUTCOME_UNKNOWN" });
  primary.ready = true;
  primary.epoch++;
  await assert.rejects(router.choose({ ...research, operationClass: "mutable" }), {
    code: "BROWSER_OUTCOME_UNKNOWN",
  });
  assert.equal(
    (await db.get("owner", "browser-bindings", "research"))?.executorId,
    initial.executorId,
  );
});
test("destination authenticated identity comes from broker proof; missing and wrong identities await login", async (t) => {
  const { router, primary, login } = await setup(t);
  primary.ready = false;
  const request = {
    ...research,
    accountId: "saved-account",
    operationClass: "authenticated_read" as const,
  };
  await assert.rejects(router.choose(request), { code: "BROWSER_LOGIN_REQUIRED" });
  login("wrong-account");
  await assert.rejects(router.choose(request), { code: "BROWSER_ACCOUNT_MISMATCH" });
  login("saved-account");
  const binding = await router.choose(request);
  assert.equal(binding.authentication.status, "connected");
  assert.equal(binding.accountId, "saved-account");
});
test("local artifacts cannot move until exact required versions have a publication ACK", async (t) => {
  const { router, primary, db } = await setup(t);
  primary.ready = false;
  const request = {
    ...research,
    artifactVersions: [{ artifactId: "document", version: "a".repeat(64) }],
  };
  await db.put("owner", "native-artifacts", {
    id: "document",
    executorId: "lenovo",
    version: "a".repeat(64),
    published: false,
  });
  await assert.rejects(router.choose(request), { code: "BROWSER_ARTIFACT_UNAVAILABLE" });
  await db.put("owner", "native-artifacts", {
    id: "document",
    executorId: "lenovo",
    version: "b".repeat(64),
    published: true,
  });
  await assert.rejects(router.choose(request), { code: "BROWSER_ARTIFACT_UNAVAILABLE" });
  await db.put("owner", "native-artifacts", {
    id: "document",
    executorId: "lenovo",
    version: "a".repeat(64),
    published: true,
  });
  assert.equal((await router.choose(request)).transport, "vps");
});

test("real BrowserService research tool opens persistent VPS profile with signed actual lease fences", async (t) => {
  const calls: string[] = [];
  let id = "";
  const snapshotId = randomUUID();
  const fixture = await browserFixture(t, (path, body, request) => {
    calls.push(path);
    if (path === "/executor")
      return {
        data: {
          executorId: "openmuse-server",
          instanceId: "worker-generation",
          minProtocolVersion: 1,
          maxProtocolVersion: 1,
          capabilities: [
            { name: "browser.dom", version: 1 },
            { name: "browser.screenshot", version: 1 },
          ],
        },
      };
    const authority = verifyBrowserExecutor(
      "test-worker-token-at-least-32-characters",
      String(request.headers["x-openmuse-browser-authority"]),
    );
    assert(authority);
    assert(authority.fence > 0);
    assert.equal(authority.instanceId, "worker-generation");
    if (path === "/sessions") id = String(body.id);
    assert.equal(authority.sessionId, id);
    assert.equal(authority.operationClass, "public_read");
    if (path.endsWith("/snapshot"))
      return {
        data: {
          sessionId: id,
          snapshotId,
          url: "https://example.com/",
          title: "Research",
          text: "Fixture research evidence",
          truncated: false,
          truncatedElements: false,
          control: "agent",
          elements: [],
        },
      };
    return {
      data: {
        id,
        title: "Research",
        url: "https://example.com/",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  fixture.service.configureFallback(
    new CapabilityRouter(fixture.db, {
      executors: (owner, accountId) => fixture.service.fallbackExecutors(owner, accountId),
    }),
  );
  const tools = browserTools(fixture.service, "owner", { routingTaskId: "chat-research" });
  const tool = tools.find((tool) => tool.name === "browser_research");
  assert(tool);
  const result = (await (tool.execute as (args: unknown) => Promise<unknown>)({
    url: "https://example.com/",
  })) as { text: string; sessionId: string };
  assert.equal(result.text, "Fixture research evidence");
  assert.equal(
    (await fixture.db.get<{ executorId: string }>("owner", "browser-bindings", "chat-research"))
      ?.executorId,
    "openmuse-server",
  );
  const leases = await fixture.db.resourceLeasesForTask("chat-research");
  assert.equal(leases.length, 0); // ephemeral chat releases on completion
  assert(calls.includes("/sessions"));
  assert(calls.includes(`/sessions/${result.sessionId}/snapshot`));
  const action = tools.find((tool) => tool.name === "browser_act");
  assert(action);
  const denied = (await (action.execute as (args: unknown) => Promise<unknown>)({
    sessionId: result.sessionId,
    act: { snapshotId, element: 1, action: "click" },
  })) as { code: string };
  assert.equal(denied.code, "PUBLIC_RESEARCH_ONLY");
  assert(!calls.some((path) => path.endsWith("/act")));
});

test("production task starts public research on VPS when Lenovo is already offline", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  assert.equal(await server.agent.browser.reachable(), true);
  const task = await server.runTask(async (invoke) => {
    const result = await invoke("browser_research", { url: "https://example.com/offline" });
    assert.equal(result.text, "VPS evidence");
    assert.notEqual(result.sessionId, server.session.browserSessionId);
  });
  assert.equal(
    (await server.db.get<{ executorId: string }>("local-user", "browser-bindings", task.id))
      ?.executorId,
    "openmuse-server",
  );
  assert.equal(server.nativeCalls.length, 0);
  assert.equal(
    (await server.agent.journal.operations("local-user", task.id)).filter(
      (operation) => operation.toolName === "browser_research",
    )[0]?.status,
    "succeeded",
  );
});

test("explicit headless reading uses VPS even while the personal executor is online", async (t) => {
  const server = await browserFallbackFixture(t);
  const task = await server.runTask(async (_invoke, task, context) => {
    const page = await server.agent.browser.observe(
      "local-user",
      "https://example.com/live",
      undefined,
      task.id,
      context.trackResourceLeases,
      context.signal,
    );
    assert.equal(page.text, "VPS evidence");
    assert.notEqual(page.sessionId, server.session.browserSessionId);
  });
  const binding = await server.db.get<{ operationClass: string; executorId: string }>(
    "local-user",
    "browser-bindings",
    `public:${task.id}`,
  );
  assert.equal(binding?.operationClass, "public_read");
  assert.equal(binding?.executorId, "openmuse-server");
  assert.equal(server.nativeCalls.length, 0);
});

test("production research continues on VPS after native read disconnect with fresh snapshot and old session rejection", async (t) => {
  const server = await browserFallbackFixture(t);
  let nativeSnapshot = "",
    destinationSnapshot = "";
  const task = await server.runTask(async (invoke, task) => {
    const initial = await invoke("browser_research", { url: "https://example.com/research" });
    assert.equal(initial.text, "Lenovo evidence");
    assert.equal(initial.sessionId, server.session.browserSessionId);
    nativeSnapshot = initial.snapshotId;
    server.failNext("snapshot");
    const result = await invoke("browser_snapshot", { sessionId: initial.sessionId });
    assert.equal(result.text, "VPS evidence");
    assert.equal(result.url, "https://example.com/research");
    assert.notEqual(result.sessionId, initial.sessionId);
    assert.notEqual(result.snapshotId, initial.snapshotId);
    destinationSnapshot = result.snapshotId;
    const old = await invoke("browser_act", {
      sessionId: initial.sessionId,
      act: { snapshotId: initial.snapshotId, element: 1, action: "click" },
    });
    assert.equal(old.code, "STALE_BROWSER_BINDING");
    assert.equal(
      (await server.db.get<{ executorId: string }>("local-user", "browser-bindings", task.id))
        ?.executorId,
      "openmuse-server",
    );
  });
  assert.notEqual(nativeSnapshot, destinationSnapshot);
  assert.equal(
    server.nativeCalls.filter((operation) => operation.args.operation === "act").length,
    0,
  );
  assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/act")).length, 0);
  assert.equal(
    (await server.agent.journal.operations("local-user", task.id)).find(
      (operation) => operation.toolName === "browser_snapshot",
    )?.status,
    "succeeded",
  );
});

test("production mutable partition retains native binding and rejects old worker epoch without VPS replay", async (t) => {
  const server = await browserFallbackFixture(t);
  const task = await server.runTask(async (invoke) => {
    const initial = await invoke("browser_navigate", { url: "https://example.com/action" });
    assert.equal(initial.text, "Lenovo evidence");
    server.failNext("open");
    await assert.rejects(
      invoke("browser_navigate", {
        sessionId: initial.sessionId,
        url: "https://example.com/uncertain",
      }),
      { name: "TaskOutcomeUnknownError" },
    );
    const next = await invoke("browser_snapshot", { sessionId: initial.sessionId });
    assert.equal(next.code, "BROWSER_OUTCOME_UNKNOWN");
  });
  assert.equal(server.vpsCalls.length, 0);
  assert.equal(
    (await server.db.get<{ executorId: string }>("local-user", "browser-bindings", task.id))
      ?.executorId,
    "lenovo-okami",
  );
  await server.stopNative();
  const restarted = await server.node("register", {
    ...server.nativeHello,
    instanceId: "instance-b",
  });
  assert(restarted.epoch > server.epoch);
  await assert.rejects(
    server.executors.claimOperations("lenovo-okami", server.epoch, { waitMs: 0 }),
    /epoch/i,
  );
  const operations = await server.agent.journal.operations("local-user", task.id);
  assert(
    operations.some((operation) => operation.effect && operation.status === "outcome_unknown"),
  );
});

test("production tasks using native and VPS browser transports share four background admissions", async (t) => {
  const server = await browserFallbackFixture(t);
  let release = () => {},
    nativeReady = () => {};
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const primaryRead = new Promise<void>((resolve) => {
    nativeReady = resolve;
  });
  const observed = new Map<string, string>();
  const failures: unknown[] = [];
  server.agent.configureNativeExecution(async (owner, task, context) => {
    try {
      if (task.prompt === "mixed host 0") {
        const result = await server.invokeFor(
          owner,
          task,
          context,
        )("browser_research", { url: "https://example.com/native" });
        assert.equal(result.text, "Lenovo evidence");
        observed.set(task.id, result.sessionId);
        nativeReady();
      } else if (task.prompt === "mixed host 1") {
        await primaryRead;
        await server.offline();
        const result = await server.invokeFor(
          owner,
          task,
          context,
        )("browser_research", { url: "https://example.com/vps" });
        assert.equal(result.text, "VPS evidence");
        observed.set(task.id, result.sessionId);
      }
    } catch (error) {
      failures.push(error);
      nativeReady();
    }
    await busy;
    return { status: "waiting_input", question: "Fixture work released" };
  });
  const tasks = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      server.agent.createTask("local-user", { kind: "agent", prompt: `mixed host ${index}` }),
    ),
  );
  const tick = server.agent.worker.tick();
  try {
    for (let attempt = 0; attempt < 200 && observed.size < 2 && failures.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(failures, []);
    assert.equal(observed.size, 2);
    const saved = await server.db.list<import("../packages/domain/src/agent.ts").AgentTask>(
      "local-user",
      "tasks",
    );
    assert.equal(saved.filter((task) => task.status === "running").length, 4);
    assert.equal(saved.filter((task) => task.status === "queued").length, 1);
    const bindings = await server.db.list<{ taskId: string; transport: string }>(
      "local-user",
      "browser-bindings",
    );
    assert.equal(bindings.find((binding) => binding.taskId === tasks[0].id)?.transport, "native");
    assert.equal(bindings.find((binding) => binding.taskId === tasks[1].id)?.transport, "vps");
    const leases = await server.db.resourceLeasesForTask(tasks[1].id);
    const handles = await Promise.all(
      leases.map((lease) =>
        server.db.get<{ request: { key: string }; fence: number }>(
          "__runtime__",
          "resource-leases",
          lease.id,
        ),
      ),
    );
    assert(
      handles.some(
        (lease) =>
          lease &&
          lease.fence > 0 &&
          lease.request.key === `browser-profile:openmuse-server:${observed.get(tasks[1].id)}`,
      ),
    );
    assert(
      server.nativeCalls.some(
        (operation) =>
          operation.resourceFence > 0 &&
          operation.resourceKey === `desktop:lenovo-okami:${server.session.id}`,
      ),
    );
  } finally {
    release();
    await tick;
  }
});

test("production task with executor-local artifact waits until its exact publication becomes available", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  const artifactId = "a".repeat(64),
    version = "b".repeat(64);
  await server.db.put("local-user", "native-artifacts", {
    id: artifactId,
    executorId: "lenovo-okami",
    version,
    published: false,
  });
  await server.runTask(async (invoke, _task, context) => {
    await context.checkpoint({ artifactIds: [artifactId] });
    const waiting = await invoke("browser_research", { url: "https://example.com/artifact" });
    assert.equal(waiting.code, "BROWSER_ARTIFACT_UNAVAILABLE");
    assert.equal(server.vpsCalls.length, 0);
    await server.db.compareAndSwap(
      "local-user",
      "native-artifacts",
      artifactId,
      { version },
      { published: true },
    );
    const resumed = await invoke("browser_research", { url: "https://example.com/artifact" });
    assert.equal(resumed.text, "VPS evidence");
  });
});

test("production authenticated read reuses only the broker's exact validated VPS account profile", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  const ref = await server.saveCredential();
  const target = (await server.agent.browser.fallbackExecutors("local-user", ref.id))[0];
  await server.credentials.recordBrowserBinding("local-user", ref.id, {
    executorId: target.executorId,
    profileId: target.profileId,
    sessionId: target.sessionId,
    sessionGeneration: target.sessionGeneration,
    authenticatedAt: new Date().toISOString(),
  });
  await server.credentials.setConnectionStatus("local-user", ref.id, "connected");
  const task = await server.runTask(async (invoke, _task, context) => {
    await context.checkpoint({ state: { credentialRef: ref } });
    const result = await invoke("browser_snapshot", {});
    assert.equal(result.text, "VPS evidence");
    assert.equal(result.sessionId, target.sessionId);
  });
  assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/credentials")).length, 0);
  const binding = await server.db.get<
    import("../apps/server/src/executors/capability-router.ts").ExecutorBinding
  >("local-user", "browser-bindings", task.id);
  assert.equal(binding?.authentication.status, "connected");
  assert.equal(binding?.accountId, ref.id);
});

test("production wrong account proof triggers one trusted login on destination and publishes no secret", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  const ref = await server.saveCredential(),
    wrong = await server.saveCredential();
  const target = (await server.agent.browser.fallbackExecutors("local-user", ref.id))[0];
  await server.credentials.recordBrowserBinding("local-user", wrong.id, {
    executorId: target.executorId,
    profileId: target.profileId,
    sessionId: target.sessionId,
    sessionGeneration: target.sessionGeneration,
    authenticatedAt: new Date().toISOString(),
  });
  await server.credentials.setConnectionStatus("local-user", ref.id, "connected");
  const task = await server.runTask(async (invoke, _task, context) => {
    await context.checkpoint({ state: { credentialRef: ref } });
    const result = await invoke("browser_snapshot", {});
    assert.equal(result.text, "VPS evidence");
    assert.equal(result.sessionId, target.sessionId);
  });
  assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/credentials")).length, 1);
  assert.equal(
    (await server.credentials.browserBinding("local-user", ref.id, target))?.accountId,
    ref.id,
  );
  assert.equal(
    JSON.stringify({
      operations: await server.agent.journal.operations("local-user", task.id),
      log: await server.db.actionLog("local-user", 200),
      task: await server.db.get("local-user", "tasks", task.id),
    }).includes(server.canary),
    false,
  );
});

test("production missing login waits on a destination-bound secure challenge without reading authenticated data", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  server.credentialResponse("challenge");
  const ref = await server.saveCredential();
  const task = await server.runTask(async (invoke, _task, context) => {
    await context.checkpoint({ state: { credentialRef: ref } });
    const result = await invoke("browser_snapshot", {});
    assert.equal(result.code, "BROWSER_LOGIN_REQUIRED");
    assert.equal(JSON.stringify(result).includes(server.canary), false);
  });
  assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/snapshot")).length, 0);
  const saved = await server.db.get<import("../packages/domain/src/agent.ts").AgentTask>(
    "local-user",
    "tasks",
    task.id,
  );
  assert.equal(typeof saved?.state.credentialChallengeId, "string");
  const challenge = await server.db.get<
    import("../apps/server/src/credentials/contracts.ts").CredentialChallenge
  >("local-user", "credential-challenges", String(saved?.state.credentialChallengeId));
  assert(challenge);
  assert.equal(challenge?.executorId, "openmuse-server");
  assert.equal(challenge?.sessionGeneration, `fallback-instance:${challenge?.sessionId}`);
  assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt), 60_000);
  assert.equal(
    (await server.credentials.connection("local-user", ref.id)).status,
    "needs_challenge",
  );
});

for (const response of ["disconnect", "invalid", "truncated", "uncertain"] as const) {
  test(`production ${response} VPS login receipt holds admission/profile after task cleanup and allows observation without resubmission`, async (t) => {
    const server = await browserFallbackFixture(t);
    await server.offline();
    server.credentialResponse(response);
    const ref = await server.saveCredential();
    const task = await server.runTask(async (invoke, _task, context) => {
      await context.checkpoint({ state: { credentialRef: ref } });
      await assert.rejects(invoke("browser_snapshot", {}), { name: "TaskOutcomeUnknownError" });
    });
    const target = (await server.agent.browser.fallbackExecutors("local-user", ref.id))[0];
    const leases = await server.db.resourceLeasesForTask(task.id);
    assert(leases.length > 0);
    assert.equal(
      (await server.db.get<{ hold: boolean }>("__runtime__", "resource-leases", leases[0].id))
        ?.hold,
      true,
    );
    assert.equal(
      (await server.db.get<{ hold: boolean }>("__runtime__", "work-admissions", task.id))?.hold,
      true,
    );
    const observed = await server.agent.browser.snapshot("local-user", target.sessionId);
    assert.equal(observed.text, "VPS evidence");
    assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/credentials")).length, 1);
    assert.equal(
      (await server.credentials.connection("local-user", ref.id)).status,
      "outcome_unknown",
    );
  });
}

for (const interruption of ["pause", "steer", "resource_loss"] as const) {
  test(`production ${interruption} during VPS vault read prevents credential dispatch`, async (t) => {
    const server = await browserFallbackFixture(t);
    await server.offline();
    const ref = await server.saveCredential();
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeSecretRead(async () => {
      entered();
      await blocked;
    });
    let activeTaskId = "";
    const running = server.runTask(async (_invoke, _task, context) => {
      const task = await context.checkpoint({ state: { credentialRef: ref } });
      activeTaskId = task.id;
      await server.agent.journal.run(
        "local-user",
        task,
        {
          id: `blocked-login-${interruption}`,
          name: "credential_login",
          args: { credentialRefId: ref.id },
        },
        () => server.credentialLogin.authenticate("local-user", task.id, ref.id),
        true,
      );
    });
    await reading;
    try {
      if (interruption === "pause")
        await server.agent.runtimePause.set("local-user", { paused: true, expectedRevision: 0 });
      else if (interruption === "steer")
        await server.agent.mailbox.enqueue("local-user", activeTaskId, {
          clientMessageId: randomUUID(),
          text: "Stop signing in; inspect public pages only",
          expectedRevision: 0,
        });
      else {
        const leases = await server.db.resourceLeasesForTask(activeTaskId);
        assert(leases.length > 0);
        await server.db.releaseResourceLease(leases[0]);
      }
    } finally {
      release();
    }
    await running;
    assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/credentials")).length, 0);
    assert.notEqual(
      (await server.credentials.connection("local-user", ref.id)).status,
      "connected",
    );
    assert.equal(
      JSON.stringify(await server.agent.journal.operations("local-user", activeTaskId)).includes(
        server.canary,
      ),
      false,
    );
  });
}

test("production explicit credential login selects one destination and never submits twice through router authentication", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  const ref = await server.saveCredential();
  await server.runTask(async (invoke, _task, context) => {
    const task = await context.checkpoint({ state: { credentialRef: ref } });
    const result = (await server.agent.journal.run(
      "local-user",
      task,
      { id: "explicit-login", name: "credential_login", args: { credentialRefId: ref.id } },
      () => server.credentialLogin.authenticate("local-user", task.id, ref.id),
      true,
    )) as { status: string };
    assert.equal(result.status, "connected");
    assert.equal((await invoke("browser_snapshot", {})).text, "VPS evidence");
  });
  assert.equal(server.vpsCalls.filter((call) => call.path.endsWith("/credentials")).length, 1);
});

test("production search_web uses public VPS authority when Lenovo is offline", async (t) => {
  const server = await browserFallbackFixture(t);
  await server.offline();
  const { BrowserSearchBackend } = await import("../apps/server/src/search.ts");
  const task = await server.runTask(async (_invoke, task, context) => {
    const result = await server.agent.journal.run(
      "local-user",
      task,
      { id: randomUUID(), name: "search_web", args: { query: "source", limit: 3 } },
      () =>
        new BrowserSearchBackend(server.agent.browser).search(
          { query: "source", limit: 3 },
          {
            owner: "local-user",
            taskId: task.id,
            before: context.guard,
            signal: context.signal,
            trackResourceLeases: context.trackResourceLeases,
          },
        ),
      true,
    );
    assert.equal((result as { status: string }).status, "ok");
  });
  assert.equal(server.vpsCalls.filter((value) => value.path.endsWith("/search")).length, 1);
  assert.equal(server.nativeCalls.length, 0);
  assert.equal(
    (
      await server.db.get<{ executorId: string }>(
        "local-user",
        "browser-bindings",
        `search:${task.id}`,
      )
    )?.executorId,
    "openmuse-server",
  );
});
for (const receipt of ["authenticated", "invalid", "truncated"] as const) {
  test(`production CAPTCHA stays on the recorded VPS profile and handles ${receipt} receipt`, async (t) => {
    const server = await browserFallbackFixture(t);
    await server.offline();
    server.credentialResponse("captcha");
    server.challengeResponse(receipt);
    const ref = await server.saveCredential();
    const task = await server.runTask(async (invoke, _task, context) => {
      await context.checkpoint({ state: { credentialRef: ref } });
      await invoke("browser_snapshot", {});
      const current = await server.agent.getTask("local-user", _task.id);
      const id = String(current.state.credentialChallengeId);
      const run = () =>
        server.agent.journal.run(
          "local-user",
          current,
          { id: randomUUID(), name: "connection_challenge", args: { action: "check" } },
          () =>
            server.agent.credentialLogin!.captcha.step("local-user", current.id, id, {
              action: "check",
            }),
          true,
        );
      if (receipt === "authenticated")
        assert.equal(((await run()) as { status: string }).status, "authenticated");
      else await assert.rejects(run(), { code: "OUTCOME_UNKNOWN" });
    });
    const calls = server.vpsCalls.filter((value) => value.path.endsWith("/challenge"));
    assert.equal(calls.length, 1);
    assert.equal(server.nativeCalls.length, 0);
    const saved = await server.agent.getTask("local-user", task.id);
    const record = await server.db.get<{ sessionId: string; status: string }>(
      "local-user",
      "credential-challenges",
      String(saved.state.credentialChallengeId),
    );
    assert.equal(calls[0].path, `/sessions/${record?.sessionId}/challenge`);
    if (receipt === "authenticated") assert.equal(record?.status, "completed");
    else {
      assert.equal(
        (await server.agent.journal.operations("local-user", task.id)).find(
          (op) => op.toolName === "connection_challenge",
        )?.status,
        "outcome_unknown",
      );
      const leases = await server.db.resourceLeasesForTask(task.id);
      assert(leases.length > 0);
      assert.equal(
        (await server.db.get<{ hold: boolean }>("__runtime__", "resource-leases", leases[0].id))
          ?.hold,
        true,
      );
    }
  });
}
