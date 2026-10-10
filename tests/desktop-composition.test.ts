import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import type { ExecutorOperation } from "../apps/server/src/executors/protocol.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { DesktopFrame } from "../packages/domain/src/desktop.ts";
import { hello, nodeToken, registration } from "./helpers/executors.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function fixture(t: Parameters<typeof taskRuntime>[0]) {
  const runtimeCleanup: (() => Promise<void>)[] = [];
  const server = await taskRuntime(
    { after: (close: () => Promise<void>) => runtimeCleanup.push(close) } as unknown as Parameters<
      typeof taskRuntime
    >[0],
    {
      computerEnabled: true,
      computerBackend: "native",
      nativeExecutorId: registration.executorId,
      nativeExecutors: [{ ...registration, owner: "local-user" }],
      taskWorkerEnabled: false,
    },
  );
  const session = {
    id: randomUUID(),
    sessionGeneration: randomUUID(),
    browserSessionId: randomUUID(),
    profileId: "personal",
    width: 640,
    height: 360,
  };
  const nativeHello = {
    ...hello,
    capabilities: [
      ...hello.capabilities,
      { name: "desktop", version: 1 },
      { name: "browser.dom", version: 1 },
    ],
    readiness: {
      ...hello.readiness,
      display: { state: "ready" },
      capture: { state: "ready" },
      input: { state: "ready" },
      browser: { state: "ready" },
      desktopSession: session,
    },
  };
  const node = async (route: string, body: unknown) => {
    const response = await server.app.request(`/executor/${registration.executorId}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const registered = await node("register", nativeHello),
    epoch = registered.epoch;
  await node("reconcile", { epoch, bootId: hello.bootId, operations: [], contained: true });
  const auth = await server.auth.session();
  const post = async (path: string, body: unknown, token = auth.token) => {
    const response = await server.app.request(`/api/desktop${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };
  const child = spawn(
    "/usr/bin/python3",
    [
      "-u",
      resolve("tests/helpers/desktop-executor.py"),
      `${server.directory}/desktop-journal.sqlite`,
      JSON.stringify(session),
      JSON.stringify({
        executorId: registration.executorId,
        hostId: registration.hostId,
        epoch,
        serverTime: registered.serverTime,
      }),
    ],
    {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONPATH: resolve("apps/computer") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const calls = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  let next = 0,
    readyResolve = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const read = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  read.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.ready) readyResolve();
    else if (value.rpc)
      void node(value.route, value.body).then(
        (data) => child.stdin.write(`${JSON.stringify({ response: value.rpc, data })}\n`),
        (error) =>
          child.stdin.write(`${JSON.stringify({ response: value.rpc, error: String(error) })}\n`),
      );
    else if (value.call) {
      const pending = calls.get(value.call);
      calls.delete(value.call);
      if (value.error) pending?.reject(new Error(value.error));
      else pending?.resolve(value.result);
    }
  });
  child.once("exit", (code) => {
    for (const pending of calls.values())
      pending.reject(new Error(`Python fixture exited ${code}: ${stderr}`));
    readyResolve();
  });
  const call = (command: string, body: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      calls.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ call: id, command, ...body })}\n`);
    });
  await ready;
  assert.equal(child.exitCode, null, stderr);
  let stop = false;
  const executions = new Set<Promise<unknown>>();
  const pump = (async () => {
    while (!stop) {
      const batch = await node("claim", { epoch, waitMs: 0 });
      for (const operation of batch.operations as ExecutorOperation[]) {
        const pending = call("perform", { operation });
        executions.add(pending);
        void pending.finally(() => executions.delete(pending)).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  void pump.catch(() => {});
  t.after(async () => {
    stop = true;
    await pump.catch(() => {});
    await Promise.allSettled([...executions]);
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    read.close();
    for (const close of runtimeCleanup) await close();
  });
  return { ...server, node, post, epoch, auth, session, call };
}

test("native browser history traverses the real typed transport and records its guarded effect", async (t) => {
  const server = await fixture(t);
  assert.ok(server.desktop);
  const desktop = server.desktop;
  server.agent.configureNativeExecution(async (owner, task) => {
    const receipt = await server.agent.journal.run(
      owner,
      task,
      { id: "back", name: "browser_back", args: { operationId: "previous-page" } },
      async () =>
        (
          await desktop.browserRequest(
            owner,
            `/sessions/${server.session.browserSessionId}/back`,
            {},
          )
        ).json(),
      true,
    );
    assert.equal((receipt as { historyMoved: boolean }).historyMoved, true);
    return { status: "succeeded" };
  });
  const task = await server.agent.createTask("local-user", {
    prompt: "Native browser history transport fixture",
  });
  await server.agent.worker.tick();
  const operations = await server.agent.journal.operations("local-user", task.id);
  const native = operations.find((operation) => operation.nativeEnvelope?.kind === "browser");
  assert.ok(native, "Actual native browser delivery must be created");
  assert.equal((native.args as { operation: string }).operation, "back");
  assert.equal(native.effect, true);
  assert.equal(native.status, "succeeded");
});

test("native browser images traverse the typed supervisor as an inspection, without mutable effect authority", async (t) => {
  const server = await fixture(t);
  assert.ok(server.desktop);
  const desktop = server.desktop;
  server.agent.configureNativeExecution(async (owner, task) => {
    const result = await server.agent.journal.run(
      owner,
      task,
      {
        id: "images",
        name: "browser_get_images",
        args: { offset: 0, limit: 2 },
      },
      async () =>
        (
          await desktop.browserRequest(
            owner,
            `/sessions/${server.session.browserSessionId}/images`,
            { offset: 0, limit: 2 },
          )
        ).json(),
      false,
    );
    assert.equal((result as { images: { alt: string }[] }).images[0].alt, "Course cover");
    return { status: "succeeded" };
  });
  const task = await server.agent.createTask("local-user", {
    prompt: "Native page image observation fixture",
  });
  await server.agent.worker.tick();
  const operations = await server.agent.journal.operations("local-user", task.id);
  const native = operations.find((operation) => operation.nativeEnvelope?.kind === "browser");
  assert.ok(native);
  assert.equal((native.args as { operation: string }).operation, "images");
  assert.equal(native.effect, false);
  assert.equal(native.status, "succeeded");
});

test("invalid browser operations are rejected before acquiring native dispatch authority", async (t) => {
  const server = await fixture(t);
  assert.ok(server.desktop);
  const before = await server.call("state");
  for (const [operation, body] of [
    ["back", { approved: true }],
    ["images", { expression: "fetch('/delete')" }],
    ["images", { offset: -1 }],
    ["unsupported-operation", {}],
  ] as const) {
    await assert.rejects(
      server.desktop.browserRequest(
        "local-user",
        `/sessions/${server.session.browserSessionId}/${operation}`,
        body,
      ),
      { code: "INVALID_BROWSER_OPERATION" },
    );
  }
  const after = await server.call("state");
  assert.deepEqual(after.browserEnvelopes, before.browserEnvelopes);
});

test("production desktop viewer uses interactive admission with four busy tasks, private frames and device-bound human input", async (t) => {
  const server = await fixture(t);
  let release = () => {};
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.agent.configureNativeExecution(async () => {
    await busy;
    return { status: "waiting_input", question: "fixture finished" };
  });
  const tasks = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      server.agent.createTask("local-user", { kind: "agent", prompt: `busy ${i}` }),
    ),
  );
  const tick = server.agent.worker.tick();
  const running = async () =>
    (await server.db.list<AgentTask>("local-user", "tasks")).filter(
      (task) => task.status === "running",
    ).length;
  for (let i = 0; i < 100 && (await running()) < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await running(), 4);
  try {
    const opened = await server.post("/viewers", { sessionId: server.session.id });
    assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
    const viewer = opened.data.viewerId;
    assert.equal(await running(), 5);
    const observed = await server.post(`/viewers/${viewer}/observe`, {
      sessionId: server.session.id,
    });
    assert.equal(observed.response.status, 200, JSON.stringify(observed.data));
    assert.equal(typeof observed.data.image, "string");
    const operations = await server.agent.journal.operations("local-user", viewer);
    assert.equal(
      JSON.stringify(operations).includes(observed.data.image),
      false,
      "pixels must never enter task journal",
    );
    const control = await server.post(`/viewers/${viewer}/take-control`, {
      sessionId: server.session.id,
      operationId: randomUUID(),
    });
    assert.equal(control.response.status, 200, JSON.stringify(control.data));
    assert.equal(control.data.control, "human");
    const frame = (
      await server.post(`/viewers/${viewer}/observe`, { sessionId: server.session.id })
    ).data as DesktopFrame;
    const secret = "ação ☕ fixture-private-text";
    const input = {
      sessionGeneration: frame.sessionGeneration,
      frameId: frame.frameId,
      width: frame.width,
      height: frame.height,
      action: { action: "type", text: secret },
    };
    const operationId = randomUUID();
    const typed = await server.post(`/viewers/${viewer}/input`, {
      sessionId: server.session.id,
      grantId: control.data.grantId,
      operationId,
      input,
    });
    assert.equal(typed.response.status, 200, JSON.stringify(typed.data));
    const state = await server.call("state");
    assert.ok(state.events.some((event: unknown[]) => event[0] === "text"));
    assert.equal(
      JSON.stringify(state.journal).includes(secret),
      false,
      "native SQLite envelope must not contain human text",
    );
    assert.equal(
      JSON.stringify(await server.agent.journal.operations("local-user", viewer)).includes(secret),
      false,
      "server task journal must not contain human text",
    );
    const replay = await server.post(`/viewers/${viewer}/input`, {
      sessionId: server.session.id,
      grantId: control.data.grantId,
      operationId,
      input,
    });
    assert.equal(replay.response.status, 200);
    assert.equal(
      (await server.call("state")).events.filter((event: unknown[]) => event[0] === "text").length,
      state.events.filter((event: unknown[]) => event[0] === "text").length,
    );
    assert.equal(
      (
        await server.post(`/viewers/${viewer}/input`, {
          sessionId: server.session.id,
          grantId: control.data.grantId,
          operationId,
          input: { ...input, action: { action: "type", text: "changed" } },
        })
      ).response.status,
      409,
    );
    const handed = await server.post(`/viewers/${viewer}/release-control`, {
      sessionId: server.session.id,
      grantId: control.data.grantId,
      operationId: randomUUID(),
    });
    assert.equal(handed.response.status, 200, JSON.stringify(handed.data));
    await server.post(`/viewers/${viewer}/close`, {});
    release();
    await tick;
    assert.ok(tasks.every((task) => task.id !== viewer));
    const record = await server.db.get<AgentTask>("local-user", "tasks", viewer);
    assert.ok(record);
  } finally {
    release();
    await tick;
  }
});

test("every viewer operation rejects another owned session before journaling or dispatch", async (t) => {
  const server = await fixture(t);
  assert.ok(server.desktop && server.desktopViewers);
  const opened = await server.post("/viewers", { sessionId: server.session.id });
  assert.equal(opened.response.status, 201);
  const viewerId = opened.data.viewerId;
  const other = {
    ...(await server.desktop.session("local-user")),
    id: randomUUID(),
    browserSessionId: randomUUID(),
  };
  // A second owned/resolvable session still cannot be targeted by this viewer.
  const resolveSession = server.desktop.session.bind(server.desktop);
  server.desktop.session = async (owner, id) =>
    id === other.id ? other : resolveSession(owner, id);
  const before = await server.agent.journal.operations("local-user", viewerId);
  const frame = {
    sessionGeneration: server.session.sessionGeneration,
    frameId: randomUUID(),
    width: 640,
    height: 360,
  };
  for (const operation of [
    "observe",
    "take-control",
    "open-browser",
    "import-downloads",
    "heartbeat",
    "release-control",
    "input",
  ]) {
    const args = {
      sessionId: other.id,
      ...(operation === "observe" ? {} : { operationId: randomUUID() }),
      ...(operation === "open-browser" ? { url: "https://example.com" } : {}),
      ...(["heartbeat", "release-control", "input"].includes(operation)
        ? { grantId: randomUUID() }
        : {}),
      ...(operation === "input"
        ? { input: { ...frame, action: { action: "click", x: 10, y: 10 } } }
        : {}),
    };
    const result = await server.post(`/viewers/${viewerId}/${operation}`, args);
    assert.equal(result.response.status, 403, `${operation}: ${JSON.stringify(result.data)}`);
    assert.match(result.data.error, /another viewer session/);
  }
  assert.deepEqual(await server.agent.journal.operations("local-user", viewerId), before);
  assert.equal((await server.call("state")).events.length, 0);
  await server.post(`/viewers/${viewerId}/close`, {});
});

for (const kind of ["desktop", "browser"] as const)
  test(`uncertain native ${kind} input retains the same task admission and GUI/profile/admin leases`, async (t) => {
    const server = await fixture(t);
    assert.ok(server.desktop);
    const desktop = server.desktop;
    server.agent.configureNativeExecution(async (owner, task) => {
      if (kind === "desktop") {
        const frame = (await server.agent.journal.run(
          owner,
          task,
          { id: "frame", name: "desktop_observe", args: {} },
          () => desktop.observeForAgent(owner),
          false,
        )) as Awaited<ReturnType<typeof desktop.observeForAgent>>;
        await server.call("failure", { reset: true });
        await server.agent.journal.run(
          owner,
          task,
          { id: "input", name: "desktop_act", args: {} },
          () =>
            desktop.act(owner, server.session.id, {
              sessionGeneration: frame.sessionGeneration,
              frameId: frame.frameId,
              width: frame.width,
              height: frame.height,
              action: { action: "click", x: 10, y: 10 },
            }),
          true,
        );
      } else {
        await server.call("failure", { browser: true });
        await server.agent.journal.run(
          owner,
          task,
          { id: "input", name: "browser_open", args: {} },
          async () => {
            await desktop.browserRequest(owner, "/sessions", {
              id: server.session.browserSessionId,
              url: "https://example.com",
            });
          },
          true,
        );
      }
      return { status: "succeeded" };
    });
    const task = await server.agent.createTask("local-user", {
      kind: "agent",
      prompt: "native uncertain input fixture",
    });
    await server.agent.worker.tick();
    const operations = await server.agent.journal.operations("local-user", task.id);
    const native = operations.find((entry) => entry.nativeEnvelope && entry.effect);
    assert.ok(native);
    assert.equal(native.status, "outcome_unknown");
    assert.equal(
      (native.receipt as { data: { cleanupConfirmed: boolean } }).data.cleanupConfirmed,
      false,
    );
    assert.equal(
      (await server.db.get<{ hold: boolean }>("__runtime__", "work-admissions", task.id))?.hold,
      true,
    );
    const holds = await server.db.list<{ id: string; complete: boolean; leases: { id: string }[] }>(
      "local-user",
      "desktop-operation-holds",
    );
    assert.equal(holds.length, 1);
    assert.equal(holds[0].complete, false);
    assert.equal(holds[0].leases.length, 3);
    const resources = new ResourceLeases(server.db);
    assert.equal(
      await resources.acquire(
        "local-user",
        "competing-dom",
        desktop.inputResources(await desktop.session("local-user")),
      ),
      null,
    );
    assert.equal(
      await resources.acquire("local-user", "competing-admin", [
        { key: `system-admin:${registration.hostId}`, units: 1, mode: "exclusive" },
      ]),
      null,
    );
  });

test("viewer recovery retains an uncertain human input slot and temporary admin hold until native cleanup", async (t) => {
  const server = await fixture(t);
  assert.ok(server.desktop && server.desktopViewers);
  const opened = await server.post("/viewers", { sessionId: server.session.id });
  const viewerId = opened.data.viewerId;
  const control = await server.post(`/viewers/${viewerId}/take-control`, {
    sessionId: server.session.id,
    operationId: randomUUID(),
  });
  const observed = await server.post(`/viewers/${viewerId}/observe`, {
    sessionId: server.session.id,
  });
  await server.call("failure", { reset: true });
  const result = await server.post(`/viewers/${viewerId}/input`, {
    sessionId: server.session.id,
    grantId: control.data.grantId,
    operationId: randomUUID(),
    input: {
      sessionGeneration: observed.data.sessionGeneration,
      frameId: observed.data.frameId,
      width: observed.data.width,
      height: observed.data.height,
      action: { action: "click", x: 10, y: 10 },
    },
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.data));
  await server.post(`/viewers/${viewerId}/close`, {});
  for (
    let i = 0;
    i < 100 && (await server.agent.getTask("local-user", viewerId)).status === "running";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const resources = new ResourceLeases(server.db);
  const gui = server.desktop.inputResources(await server.desktop.session("local-user"));
  assert.equal(await resources.acquire("local-user", "competing-dom", gui), null);
  assert.equal(
    await resources.acquire("local-user", "competing-admin", [
      { key: `system-admin:${registration.hostId}`, units: 1, mode: "exclusive" },
    ]),
    null,
  );
  await server.desktopViewers.recover();
  assert.equal(
    (await server.db.get<{ hold: boolean }>("__runtime__", "work-admissions", viewerId))?.hold,
    true,
  );
  assert.equal(
    (await server.agent.getTask("local-user", viewerId)).state.nativeAdmissionPending,
    true,
  );
  // A confirmed reset may release physical occupancy, while outcome_unknown
  // remains in the journal and input is never replayed.
  await server.call("failure");
  const reconnected = await server.post("/viewers", { sessionId: server.session.id });
  assert.equal(reconnected.response.status, 201);
  const released = await server.post(`/viewers/${reconnected.data.viewerId}/release-control`, {
    sessionId: server.session.id,
    grantId: control.data.grantId,
    operationId: randomUUID(),
  });
  assert.equal(released.response.status, 200, JSON.stringify(released.data));
  assert.ok(await resources.acquire("local-user", "after-cleanup-dom", gui));
  assert.ok(
    await resources.acquire("local-user", "after-cleanup-admin", [
      { key: `system-admin:${registration.hostId}`, units: 1, mode: "exclusive" },
    ]),
  );
  const unknown = (await server.agent.journal.operations("local-user", viewerId)).find(
    (entry) => entry.nativeEnvelope && entry.effect,
  );
  assert.ok(unknown);
  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(
    (unknown.receipt as { data: { cleanupConfirmed: boolean } }).data.cleanupConfirmed,
    true,
  );
  await server.desktopViewers.recover();
  assert.equal(await server.db.get("__runtime__", "work-admissions", viewerId), null);
  await server.post(`/viewers/${reconnected.data.viewerId}/close`, {});
});

test("paused desktop inspection returns the last masked frame with its actual timestamp and blocks takeover", async (t) => {
  const server = await fixture(t);
  const opened = await server.post("/viewers", { sessionId: server.session.id });
  const viewerId = opened.data.viewerId;
  const frame = await server.post(`/viewers/${viewerId}/observe`, { sessionId: server.session.id });
  assert.equal(frame.response.status, 200);
  const before = (await server.call("state")).journal.length;
  await server.agent.runtimePause.set("local-user", { paused: true, expectedRevision: 0 });
  const paused = await server.post(`/viewers/${viewerId}/observe`, {
    sessionId: server.session.id,
  });
  assert.equal(paused.response.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.paused, true);
  assert.equal(paused.data.observedAt, frame.data.observedAt);
  assert.equal(paused.data.frameId, frame.data.frameId);
  assert.equal(paused.data.image, frame.data.image);
  assert.equal((await server.call("state")).journal.length, before);
  const takeover = await server.post(`/viewers/${viewerId}/take-control`, {
    sessionId: server.session.id,
    operationId: randomUUID(),
  });
  assert.equal(takeover.response.status, 409, JSON.stringify(takeover.data));
  assert.equal(await server.db.get("local-user", "desktop-control", server.session.id), null);
  await server.post(`/viewers/${viewerId}/close`, {});
});

test("native search and workspace upload/download use the same admitted journal, private one-use bytes and guarded file publication", async (t) => {
  const server = await fixture(t);
  const expected = createHash("sha256").update("owned native workspace content").digest("hex");
  server.agent.configureNativeExecution(async (owner, task, context) => {
    const result = await server.agent.journal.run(
      owner,
      task,
      { id: "file-workflow", name: "browser-files", args: {} },
      async () => {
        return server.agent.browser.runAutomated(
          owner,
          task.id,
          undefined,
          undefined,
          context.signal,
          true,
          async (id) => {
            const search = await server.agent.browser.search(
              owner,
              id,
              { query: "fixture source", limit: 2 },
              context.signal,
            );
            const snapshot = await server.agent.browser.snapshot(owner, id, context.signal);
            const upload = await server.agent.browser.uploadFromWorkspace(
              owner,
              id,
              {
                snapshotId: snapshot.snapshotId,
                element: 1,
                path: "/workspace/source.txt",
                expectedSha256: expected,
              },
              server.computer,
              context.signal,
            );
            const downloaded = await server.agent.browser.downloadToWorkspace(
              owner,
              id,
              "22222222-2222-4222-8222-222222222222",
              "/workspace/download.csv",
              server.computer,
              context.signal,
            );
            const bytes = await server.computer.fileBytes(owner, "/workspace/download.csv");
            assert.equal(Buffer.from(bytes.bytes).toString(), "name,value\nfixture,42\n");
            return { search, upload, downloaded };
          },
          () => context.guard(),
          context.trackResourceLeases,
        );
      },
      true,
    );
    return {
      status: "waiting_input",
      question: "Fixture completed; inspect its exact receipts",
      state: { nativeFileProof: result },
    };
  });
  const task = await server.agent.createTask("local-user", {
    kind: "agent",
    prompt: "Run the fixed native file fixture",
  });
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("local-user", task.id);
  assert.ok(completed.state.nativeFileProof, JSON.stringify(completed));
  const proof = completed.state.nativeFileProof as {
    downloaded: { attachment: { fileId: string } };
  };
  const bytes = await server.files.bytes("local-user", proof.downloaded.attachment.fileId);
  assert.equal(Buffer.from(bytes).toString(), "name,value\nfixture,42\n");
  await assert.rejects(server.files.bytes("foreign", proof.downloaded.attachment.fileId), {
    status: 404,
  });
  const state = await server.call("state");
  assert.equal(state.uploaded, expected);
  const journal = await server.agent.journal.operations("local-user", task.id);
  const uploads = journal.filter(
    (op) =>
      op.nativeEnvelope?.kind === "browser" &&
      (op.args as { operation?: string }).operation === "upload",
  );
  assert.equal(uploads.length, 1);
  assert.ok(
    !JSON.stringify(uploads).includes(
      Buffer.from("owned native workspace content").toString("base64"),
    ),
  );
  const envelope = { ...uploads[0].nativeEnvelope!, args: uploads[0].args } as ExecutorOperation;
  const reference = (envelope.args.body as { fileReference: string }).fileReference;
  const consumed = await server.app.request(
    `/executor/${registration.executorId}/browser-files/${reference}/consume`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        epoch: server.epoch,
        operationId: envelope.id,
        sessionId: server.session.browserSessionId,
        sessionGeneration: server.session.sessionGeneration,
      }),
    },
  );
  assert.notEqual(consumed.status, 200, "one-use upload payload is unavailable after completion");
  assert.ok(
    state.browserEnvelopes.every(
      (op: { args: { operation?: string; body?: object } }) =>
        op.args.operation !== "upload" || !JSON.stringify(op.args.body).includes("base64"),
    ),
  );
  assert.equal((await server.db.list("local-user", "file-publications")).length, 2);
});

test("trusted native viewer imports completed browser files under its existing interactive task and replays the same publication", async (t) => {
  const server = await fixture(t);
  const opened = await server.post("/viewers", { sessionId: server.session.id });
  assert.equal(opened.response.status, 201);
  const viewerId = opened.data.viewerId;
  const browser = await server.post(`/viewers/${viewerId}/open-browser`, {
    sessionId: server.session.id,
    operationId: randomUUID(),
    url: "https://example.org/upload",
  });
  assert.equal(browser.response.status, 200, JSON.stringify(browser.data));
  const control = await server.post(`/viewers/${viewerId}/take-control`, {
    sessionId: server.session.id,
    operationId: randomUUID(),
  });
  assert.equal(control.response.status, 200);
  const args = { sessionId: server.session.id, operationId: randomUUID() };
  const imported = await server.post(`/viewers/${viewerId}/import-downloads`, args);
  assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.files[0].mimeType, "text/csv");
  assert.deepEqual(
    (await server.post(`/viewers/${viewerId}/import-downloads`, args)).data,
    imported.data,
  );
  assert.equal((await server.db.list("local-user", "tasks")).length, 1);
  assert.equal((await server.db.list("local-user", "file-publications")).length, 1);
  const bytes = await server.files.bytes("local-user", imported.data.files[0].id);
  assert.equal(Buffer.from(bytes).toString(), "name,value\nfixture,42\n");
  await server.post(`/viewers/${viewerId}/release-control`, {
    sessionId: server.session.id,
    grantId: control.data.grantId,
    operationId: randomUUID(),
  });
  await server.post(`/viewers/${viewerId}/close`, {});
});

for (const decision of ["approve", "deny"] as const)
  test(`native browser dialog ${decision} executes from a real admitted task and never repeats the decision`, async (t) => {
    const server = await fixture(t);
    const browser = server.agent.browser;
    const dialogId = randomUUID();
    await server.call("pendingDialog", {
      dialog: {
        id: dialogId,
        type: "confirm",
        message: "Excluir documento de teste?",
        defaultValue: "",
        truncated: false,
        requiresApproval: true,
      },
    });
    server.agent.configureNativeExecution(async (owner, task) => {
      const pending = await server.agent.journal.run(
        owner,
        task,
        {
          id: "prepare-dialog",
          name: "browser_dialog",
          args: { sessionId: server.session.browserSessionId, dialogId, accept: true },
        },
        () =>
          browser.runAutomated(
            owner,
            task.id,
            server.session.browserSessionId,
            undefined,
            undefined,
            true,
            (id) => browser.dialog(owner, id, { dialogId, accept: true }, undefined, task.id),
          ),
        true,
      );
      assert.ok(pending && typeof pending === "object" && "actionId" in pending);
      return { status: "waiting_approval", actionId: String(pending.actionId) };
    });
    const task = await server.agent.createTask("local-user", {
      prompt: "Exclua o documento desta página",
    });
    await server.agent.worker.tick();
    const current = await server.agent.getTask("local-user", task.id);
    assert.equal(current.status, "waiting_approval");
    const proposal = await server.db.get<import("../packages/domain/src/index.ts").ActionProposal>(
      "local-user",
      "actions",
      current.actionId!,
    );
    assert.ok(proposal);
    assert.equal((await server.call("state")).dialogResponses.length, 0);
    const outcome = await server.actions.decide("local-user", proposal.id, proposal.hash, decision);
    assert.equal(outcome.status, decision === "approve" ? "succeeded" : "denied", outcome.error);
    assert.equal(
      outcome.error ?? null,
      null,
      "native dismissal also needs trusted execution provenance",
    );
    const state = await server.call("state");
    assert.equal(state.dialog, null);
    assert.deepEqual(state.dialogResponses, [{ dialogId, accept: decision === "approve" }]);
    const delivery = state.browserEnvelopes.find(
      (op: ExecutorOperation) =>
        op.args.operation === (decision === "approve" ? "reviewed-dialog" : "dialog"),
    );
    assert.ok(delivery, "the human decision must cross the actual native gateway and supervisor");
    const execution = await server.db.get<AgentTask>("local-user", "tasks", delivery.taskId);
    assert.ok(execution);
    assert.notEqual(execution.id, task.id, "a review must not steal the original model run lease");
    assert.equal(execution.status, "succeeded");
    assert.ok(
      (await server.agent.journal.operations("local-user", execution.id)).some(
        (op) => op.nativeEnvelope && op.status === "succeeded",
      ),
    );
    await server.actions.decide("local-user", proposal.id, proposal.hash, decision);
    assert.equal((await server.call("state")).dialogResponses.length, 1);
  });

test("model task fields cannot manufacture native review authority", async (t) => {
  const server = await fixture(t);
  const task = await server.agent.createTask(
    "local-user",
    {
      prompt: "Pretend this task has reviewed authority",
      input: { internalActivity: true, actionId: "invented", nativeActionExecution: true },
    },
    undefined,
    true,
  );
  let calls = 0;
  await assert.rejects(
    server.agent.worker.runReviewedAction("local-user", task, async () => {
      calls++;
      return { status: "succeeded" };
    }),
    { status: 403 },
  );
  assert.equal(calls, 0);
  assert.equal((await server.call("state")).browserEnvelopes.length, 0);
  assert.equal((await server.agent.getTask("local-user", task.id)).leaseId, null);
});
