import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { WorkAdmission } from "../apps/server/src/engine/work-admission.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { hello, nodeToken, registration } from "./helpers/executors.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function nativeRuntime(t: Parameters<typeof taskRuntime>[0], config: Partial<Config> = {}) {
  const server = await taskRuntime(t, {
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [{ ...registration, owner: "local-user" }],
    taskWorkerEnabled: false,
    ...config,
  });
  const node = async (route: string, body: unknown) => {
    const response = await server.app.request(`/executor/${registration.executorId}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const { epoch } = await node("register", hello);
  await node("reconcile", { epoch, bootId: hello.bootId, operations: [], contained: true });
  const session = await server.auth.session();
  const post = async (path: string, body: unknown, key: string) =>
    server.app.request(`/api/computer${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  return { ...server, epoch, node, session, post };
}

test("production native API creates admitted device-bound task and preserves one command across lost response", async (t) => {
  const server = await nativeRuntime(t);
  const body = { command: "printf fixture", background: true, timeoutMs: 1000 };
  const response = await server.post("/commands", body, "manual-command");
  const first = await response.json();
  assert.equal(response.status, 200, JSON.stringify(first));
  assert.equal(first.status, "running");
  const retry = await server.post("/commands", body, "manual-command");
  assert.deepEqual(await retry.json(), first);
  assert.equal(
    (await server.post("/commands", { ...body, command: "changed" }, "manual-command")).status,
    409,
  );
  const tasks = await server.db.list<AgentTask>("local-user", "tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "waiting_job");
  assert.equal(tasks[0].state.nativeManualReady, true);
  assert.equal(tasks[0].state.waitingComputerCommandId, first.id);
  const batch = await server.node("claim", { epoch: server.epoch, waitMs: 0 });
  assert.equal(
    batch.operations.length,
    1,
    JSON.stringify(await server.executors.deliveries("local-user", registration.executorId)),
  );
  const operation = batch.operations[0];
  assert.equal(operation.taskId, tasks[0].id);
  assert.equal(operation.resourceBudget.memoryBytes, 3072 * 1024 ** 2);
  const manual = await server.db.get<{ deviceId: string }>(
    "local-user",
    "manual-executor-requests",
    operation.id,
  );
  assert.equal(manual?.deviceId, server.session.deviceId);
  await server.node("receipt", {
    epoch: server.epoch,
    operationId: operation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        ...first,
        status: "succeeded",
        exitCode: 0,
        stdout: "fixture",
        completedAt: new Date().toISOString(),
        cleanupConfirmed: true,
      },
    },
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("local-user", tasks[0].id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(finished.completion?.status, "verified");
  const final = await (await server.post("/commands", body, "manual-command")).json();
  assert.equal(final.status, "succeeded");
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    0,
  );
});

test("the production model tool dispatches through current task authority without injected callbacks", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "run_computer_command",
          arguments: {
            operationId: "inspect-workspace",
            command: "pwd",
            background: true,
            timeoutMs: 1000,
          },
        }
      : { name: "finish_task", arguments: { summary: "Inspected the working directory" } },
  );
  const server = await nativeRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("local-user", {
    prompt: "Run command pwd",
  });
  await server.agent.worker.tick();
  const waiting = await server.agent.getTask("local-user", task.id);
  assert.equal(waiting.status, "waiting_job", waiting.error ?? waiting.question);
  const batch = await server.node("claim", { epoch: server.epoch, waitMs: 0 });
  assert.equal(batch.operations.length, 1);
  const operation = batch.operations[0];
  assert.equal(operation.taskId, task.id);
  assert.equal(operation.kind, "command");
  assert.equal(await server.db.get("local-user", "manual-executor-requests", operation.id), null);
  const running = await server.computer.command!("local-user", operation.id);
  await server.node("receipt", {
    epoch: server.epoch,
    operationId: operation.id,
    sequence: 1,
    receipt: {
      status: "succeeded",
      data: {
        ...running,
        status: "succeeded",
        exitCode: 0,
        stdout: "/workspace",
        cleanupConfirmed: true,
      },
    },
  });
  await server.agent.worker.tick();
  const finished = await server.agent.getTask("local-user", task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    0,
  );
});

test("an accepted native request survives disk restart with its paired device and original intention", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "okami-native-restart-"));
  const config: Config = {
    mode: "sample",
    agentBackend: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerBackend: "native",
    nativeExecutorId: registration.executorId,
    nativeExecutors: [{ ...registration, owner: "local-user" }],
    taskWorkerEnabled: false,
  };
  let db = await createStore({ dataDir: join(directory, "db") });
  let server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    if (server.threads && "close" in server.threads) await server.threads.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = await server.auth.session();
  const request = {
    method: "execute",
    args: { command: "printf durable", background: true, timeoutMs: 1000 },
  };
  const accepted = await server.manualNative!.enqueue(
    "local-user",
    session.deviceId,
    "disk-request",
    request,
  );
  await server.agent.stop();
  if (server.threads && "close" in server.threads) await server.threads.close();
  await db.close();
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, config);
  assert.equal((await server.auth.devices.identity(session.token))?.deviceId, session.deviceId);
  const node = async (route: string, body: unknown) => {
    const response = await server.app.request(`/executor/${registration.executorId}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const { epoch } = await node("register", hello);
  await node("reconcile", { epoch, bootId: hello.bootId, operations: [], contained: true });
  const replay = await server.manualNative!.enqueue(
    "local-user",
    session.deviceId,
    "disk-request",
    request,
  );
  assert.equal(replay.taskId, accepted.taskId);
  await server.agent.worker.tick();
  const batch = await node("claim", { epoch, waitMs: 0 });
  assert.equal(batch.operations.length, 1);
  assert.equal(batch.operations[0].taskId, accepted.taskId);
  assert.equal(batch.operations[0].args.command, "printf durable");
  assert.equal((await db.list("local-user", "tasks")).length, 1);
});

test("native manual requests cannot revive user pause or dispatch after device revocation", async (t) => {
  const server = await nativeRuntime(t);
  assert.ok(server.manualNative);
  const request = {
    method: "execute",
    args: { command: "true", background: true, timeoutMs: 1000 },
  };
  const accepted = await server.manualNative.enqueue(
    "local-user",
    server.session.deviceId,
    "held",
    request,
  );
  await server.agent.control("local-user", accepted.taskId, "pause");
  await server.manualNative.enqueue("local-user", server.session.deviceId, "held", request);
  assert.equal((await server.agent.getTask("local-user", accepted.taskId)).status, "paused");
  const other = await server.manualNative.enqueue(
    "local-user",
    server.session.deviceId,
    "revoked",
    request,
  );
  await server.auth.devices.revoke("local-user", server.session.deviceId);
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("local-user", other.taskId)).status, "failed");
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    0,
  );
});

test("production native file API waits for origin publication and rejects stale cached publication receipts", async (t) => {
  const server = await nativeRuntime(t);
  const body = { path: "/workspace/report.txt", text: "Actual report" };
  let replied = false;
  const pending = server.post("/files/write", body, "write-once").then((response) => {
    replied = true;
    return response;
  });
  const batch = await server.node("claim", { epoch: server.epoch, waitMs: 5000 });
  assert.equal(batch.operations.length, 1);
  const operation = batch.operations[0];
  const sha = createHash("sha256").update(body.text).digest("hex");
  const file = {
    artifactId: createHash("sha256").update(body.path).digest("hex"),
    path: body.path,
    version: sha,
    sha256: sha,
    size: Buffer.byteLength(body.text),
    mimeType: "text/plain",
    executorLocal: true,
    published: false,
    generation: 1,
  };
  await server.node("receipt", {
    epoch: server.epoch,
    operationId: operation.id,
    sequence: 1,
    receipt: { status: "succeeded", data: file },
  });
  assert.equal(
    replied,
    false,
    "an operation receipt cannot replace the separate origin publication ACK",
  );
  await server.node("artifact", { epoch: server.epoch, ...file });
  const response = await pending;
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.path, body.path);
  assert.equal(
    (await server.db.get<{ published: boolean }>("local-user", "native-artifacts", file.artifactId))
      ?.published,
    true,
  );
  assert.equal(
    (await server.agent.getTask("local-user", operation.taskId)).completion?.status,
    "verified",
  );
  const nodeState = await server.executors.node(registration.executorId);
  assert.ok(nodeState);
  await server.node("heartbeat", {
    epoch: server.epoch,
    readiness: {
      ...nodeState.hello.readiness,
      publicationConflicts: [
        {
          artifactId: file.artifactId,
          path: file.path,
          version: sha,
          sha256: sha,
          generation: 1,
          reason: "Origin changed before it received publication ACK",
          observedAt: Date.now() / 1000,
        },
      ],
    },
  });
  const replay = await server.post("/files/write", body, "write-once");
  assert.equal(replay.status, 409, JSON.stringify(await replay.json()));
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    0,
  );
});

test("paired manual cancellation reuses owned command authority while globally paused", async (t) => {
  const server = await nativeRuntime(t);
  const first = await (
    await server.post(
      "/commands",
      { command: "sleep 30", background: true, timeoutMs: 30000 },
      "cancel-owned",
    )
  ).json();
  const batch = await server.node("claim", { epoch: server.epoch, waitMs: 0 });
  assert.equal(batch.operations.length, 1);
  await server.agent.runtimePause.set("local-user", { paused: true, expectedRevision: 0 });
  const pending = server.post(`/commands/${first.id}/cancel`, {}, "cancel");
  const cancellation = await server.node("claim", { epoch: server.epoch, waitMs: 5000 });
  assert.equal(cancellation.operations.length, 1);
  assert.equal(cancellation.operations[0].kind, "cancel");
  await server.node("receipt", {
    epoch: server.epoch,
    operationId: first.id,
    sequence: 1,
    receipt: {
      status: "failed",
      data: { ...first, status: "failed", exitCode: 130, cleanupConfirmed: true },
    },
  });
  await server.node("receipt", {
    epoch: server.epoch,
    operationId: cancellation.operations[0].id,
    sequence: 1,
    receipt: { status: "succeeded", data: { stopped: true } },
  });
  const response = await pending;
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(
    (await server.db.list("local-user", "tasks")).length,
    1,
    "cancellation does not create another background task",
  );
});

for (const source of ["manual-command", "manual-file", "model-file"] as const)
  test(`${source} holds its background slot before native claim across controller restart`, async (t) => {
    const path = "/workspace/admission.txt",
      text = "Durable fixture";
    if (source === "model-file")
      await modelFixture(t, (index) =>
        index === 0
          ? { name: "write_computer_file", arguments: { path, text } }
          : { name: "finish_task", arguments: { summary: "Wrote the note" } },
      );
    const server = await nativeRuntime(
      t,
      source === "model-file" ? { agentBackend: "model", model: "openai/fixture" } : {},
    );
    assert.ok(server.manualNative);
    const taskId =
      source === "model-file"
        ? (await server.agent.createTask("local-user", { prompt: "Save the supplied note" })).id
        : (
            await server.manualNative.enqueue(
              "local-user",
              server.session.deviceId,
              source,
              source === "manual-command"
                ? {
                    method: "execute",
                    args: { command: "sleep 30", timeoutMs: 30000, background: false },
                  }
                : { method: "write", args: { path, text } },
            )
          ).taskId;
    const pending = server.agent.worker.tick();
    const batch = await server.node("claim", { epoch: server.epoch, waitMs: 5000 });
    assert.equal(batch.operations.length, 1);
    const operation = batch.operations[0];
    assert.equal(
      (await server.db.get<{ hold: boolean }>("__runtime__", "work-admissions", taskId))?.hold,
      true,
    );
    const replacement = new WorkAdmission(server.db, { now: () => Date.now() + 120000 });
    const admitted = [];
    for (let i = 0; i < 4; i++)
      admitted.push(await replacement.claim(`${source}-${i}`, "background", `${source}-${i}`));
    assert.deepEqual(admitted, [true, true, true, false]);
    if (source === "manual-command") {
      // A local abort cannot release the slot of an already claimed physical command.
      await server.agent.control("local-user", taskId, "pause");
      const cancellation = await server.node("claim", { epoch: server.epoch, waitMs: 5000 });
      assert.equal(cancellation.operations.length, 1);
      assert.equal(cancellation.operations[0].kind, "cancel");
      await server.node("receipt", {
        epoch: server.epoch,
        operationId: cancellation.operations[0].id,
        sequence: 1,
        receipt: { status: "failed", message: "Fixture cannot confirm cancellation" },
      });
      await pending;
      assert.equal(
        (await server.db.get<{ hold: boolean }>("__runtime__", "work-admissions", taskId))?.hold,
        true,
      );
      assert.equal((await server.agent.getTask("local-user", taskId)).status, "paused");
      assert.equal(await replacement.claim("after-pause", "background", "after-pause"), false);
      const receipt = await server.computer.command?.("local-user", operation.id);
      await server.node("receipt", {
        epoch: server.epoch,
        operationId: operation.id,
        sequence: 1,
        receipt: {
          status: "failed",
          data: { ...receipt, status: "failed", exitCode: 130, cleanupConfirmed: true },
        },
      });
    } else {
      const sha = createHash("sha256").update(text).digest("hex");
      const file = {
        artifactId: createHash("sha256").update(path).digest("hex"),
        path,
        version: sha,
        sha256: sha,
        size: Buffer.byteLength(text),
        mimeType: "text/plain",
        executorLocal: true,
        published: false,
        generation: 1,
      };
      await server.node("receipt", {
        epoch: server.epoch,
        operationId: operation.id,
        sequence: 1,
        receipt: { status: "succeeded", data: file },
      });
      await server.node("artifact", { epoch: server.epoch, ...file });
      await pending;
      assert.equal(await server.db.get("__runtime__", "work-admissions", taskId), null);
    }
  });

test("paired native request status exposes pending separately and returns only its device's retained result", async (t) => {
  const server = await nativeRuntime(t);
  const accepted = await server.manualNative!.enqueue(
    "local-user",
    server.session.deviceId,
    "queued-status",
    {
      method: "execute",
      args: { command: "printf queued", background: true, timeoutMs: 1000 },
    },
  );
  const status = (token: string) =>
    server.app.request(`/api/computer/requests/${accepted.taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const pending = await status(server.session.token);
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), {
    taskId: accepted.taskId,
    status: "queued",
    pending: true,
  });
  const other = await server.auth.session();
  assert.equal((await status(other.token)).status, 404);
  await server.agent.worker.tick();
  const response = await status(server.session.token);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.taskId, accepted.taskId);
  assert.equal(value.result.status, "running");
  assert.equal(value.result.command, "printf queued");
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    1,
  );
});

test("missing native media capability rejects before dispatch without leaving uncertain operations", async (t) => {
  const server = await nativeRuntime(t);
  const response = await server.post(
    "/transcribe",
    {
      path: "/workspace/voice.m4a",
      background: true,
    },
    "missing-transcription-capability",
  );
  assert.ok(response.status >= 400, await response.text());
  const tasks = await server.db.list<AgentTask>("local-user", "tasks");
  assert.equal(tasks.length, 1);
  const operations = await server.agent.journal.operations("local-user", tasks[0].id);
  assert.equal(operations.length, 2);
  assert.ok(operations.every((operation) => operation.status === "rejected_not_dispatched"));
  assert.ok(operations.every((operation) => !operation.nativeEnvelope));
  assert.equal(
    (await server.executors.deliveries("local-user", registration.executorId)).length,
    0,
  );
  assert.equal(
    (await server.node("claim", { epoch: server.epoch, waitMs: 0 })).operations.length,
    0,
  );
});

for (const kind of ["preview", "transcribe"] as const)
  test(`production native ${kind} shares job admission, exact media receipt and replay identity`, async (t) => {
    const server = await nativeRuntime(t);
    const mediaHello = {
      ...hello,
      capabilities: [...hello.capabilities, { name: "transcribe", version: 1 }],
    };
    const { epoch } = await server.node("register", mediaHello);
    await server.node("reconcile", {
      epoch,
      bootId: hello.bootId,
      operations: [],
      contained: true,
    });
    const body = {
      path: kind === "preview" ? "/workspace/report.docx" : "/workspace/voice.m4a",
      background: true,
      language: "auto",
    };
    const response = await server.post(`/${kind}`, body, `media-${kind}`);
    const running = await response.json();
    assert.equal(response.status, 200, JSON.stringify(running));
    assert.equal(running.kind, kind);
    assert.equal(running.status, "running");
    const batch = await server.node("claim", { epoch, waitMs: 0 });
    assert.equal(batch.operations.length, 1);
    const operation = batch.operations[0];
    assert.equal(operation.kind, "media");
    assert.equal(operation.capability, kind === "transcribe" ? "transcribe" : "command");
    assert.equal(operation.args.parameters.path, body.path);
    assert.equal(operation.resourceBudget.memoryBytes, 3072 * 1024 ** 2);
    const result =
      kind === "transcribe"
        ? {
            text: "Olá, hello, guten Tag",
            language: "pt",
            textPath: operation.args.parameters.textPath,
          }
        : { previewPath: operation.args.parameters.outputPath };
    await server.node("receipt", {
      epoch,
      operationId: operation.id,
      sequence: 1,
      receipt: {
        status: "succeeded",
        data: {
          ...running,
          status: "succeeded",
          exitCode: 0,
          cleanupConfirmed: true,
          completedAt: new Date().toISOString(),
          result,
        },
      },
    });
    await server.agent.worker.tick();
    const replay = await server.post(`/${kind}`, body, `media-${kind}`);
    const completed = await replay.json();
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    if (kind === "transcribe") {
      // A durable command receipt contains output metadata. Complete text is
      // published from its file; the bounded native stdout is not the document.
      const { text: _boundedText, ...metadata } = result;
      assert.deepEqual(completed.result, metadata);
      assert.equal(completed.stdout, "");
    } else assert.deepEqual(completed.result, result);
    assert.equal((await server.node("claim", { epoch, waitMs: 0 })).operations.length, 0);
  });
