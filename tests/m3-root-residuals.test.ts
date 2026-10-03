import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { auditedComputer, reconcileComputerAudit } from "../apps/server/src/audited-computer.ts";
import { RpcComputerService } from "../apps/server/src/computer-rpc.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { RuntimePause } from "../apps/server/src/engine/runtime-pause.ts";
import { browserFixture } from "./helpers/browser.ts";
import { config as offline } from "./helpers/computer.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const rpcConfig: Config = {
  ...offline,
  dataDir: "/tmp/okami-m3-correction-review",
  computerEnabled: true,
  computerBackend: "rpc",
  computerProfile: "open",
  computerUrl: "http://local-probe.invalid",
  computerToken: "x".repeat(32),
  computerCommandTimeoutMs: 1800000,
  workerToken: "x".repeat(32),
  resourceHostId: "review-host",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("persisted pause prevents an audited file write after tool admission", async () => {
  const db = await createStore();
  const pause = new RuntimePause(db);
  const log = new ActionLog(db);
  const append = log.append.bind(log);
  log.append = async (owner, action, result) => {
    await append(owner, action, result);
    if (action.tool === "computer.write" && result === "started")
      await pause.set(owner, { paused: true, expectedRevision: 0 });
  };
  let dispatches = 0;
  const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/rpc/files");
    assert.equal((await pause.get("owner")).paused, true);
    dispatches++;
    return Response.json({ path: JSON.parse(String(init?.body)).path });
  });
  const computer = auditedComputer(
    rpc,
    log,
    "rpc",
    new ResourceLeases(db),
    "file-pause-host",
    pause,
  );
  try {
    const tool = computerTools(computer, {} as never, "owner", "file-pause-fixture", {
      before: async () => {
        await pause.assertResumed("owner");
      },
      effectBefore: async () => {
        await pause.assertResumed("owner");
      },
    }).find((tool) => tool.name === "write_file");
    assert.ok(tool);
    await assert.rejects(
      (tool.execute as (args: unknown) => Promise<unknown>)({
        path: "/workspace/paused-write.txt",
        text: "new effect",
      }),
      /globally paused/,
    );
    assert.equal(dispatches, 0);
  } finally {
    await db.close();
  }
});

test("recovery preserves a live preflight and blocks competing dispatch", async () => {
  const db = await createStore();
  const resources = new ResourceLeases(db);
  const log = new ActionLog(db);
  const entered = deferred(),
    release = deferred();
  const firstId = hash("owner:live-preflight-first");
  const secondId = hash("owner:live-preflight-second");
  const append = log.append.bind(log);
  log.append = async (owner, action, result) => {
    if (action.operationId === firstId && result === "started") {
      entered.resolve();
      await release.promise;
    }
    return append(owner, action, result);
  };
  const dispatches: { id: string; ownedLeases: number }[] = [];
  const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/rpc/jobs");
    const body = JSON.parse(String(init?.body));
    dispatches.push({ id: body.id, ownedLeases: (await resources.listForTask(body.id)).length });
    return Response.json({
      ...body,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date().toISOString(),
    });
  });
  const computer = auditedComputer(rpc, log, "rpc", resources, "live-preflight-host");
  const first = computer.execute(
    "owner",
    { command: "echo first", background: true },
    { idempotencyKey: "live-preflight-first" },
  );
  try {
    await entered.promise;
    assert.equal((await resources.listForTask(firstId)).length, 2);
    await reconcileComputerAudit(computer, new ActionLog(db));
    assert.equal((await resources.listForTask(firstId)).length, 2);
    await assert.rejects(
      computer.execute(
        "owner",
        { command: "echo second", background: true },
        { idempotencyKey: "live-preflight-second" },
      ),
      /currently leased/,
    );
    assert.equal((await resources.listForTask(secondId)).length, 0);
    release.resolve();
    assert.equal((await first).status, "running");
    assert.deepEqual(
      dispatches.map((x) => x.ownedLeases),
      [2],
    );
    assert.equal((await resources.listForTask(firstId)).length, 2);
  } finally {
    release.resolve();
    await first.catch(() => {});
    await db.close();
  }
});

test("unclassified reviewed browser HTTP errors retain profile ownership", async (t) => {
  const browser = await browserFixture(t, (path) => {
    assert.ok(path.endsWith("/reviewed-act"));
    return {
      status: 500,
      data: {
        error: {
          code: "WORKER_FAILURE",
          message: "The browser operation failed. Check worker health and reopen the session.",
        },
      },
    };
  });
  const sessionId = randomUUID();
  const resources = new ResourceLeases(browser.db);
  const actions = new ActionService(browser.db, {
    policy: "all",
    connected: async () => true,
    execute: async () => "unused",
  });
  t.after(() => actions.close());
  await browser.db.put("owner", "browsers", {
    id: sessionId,
    title: "probe",
    url: "https://example.com/",
    status: "active",
    control: "agent",
    updatedAt: new Date().toISOString(),
  });
  browser.service.configureActions(actions);
  const proposal = await actions.proposeExternal(
    "owner",
    {
      tool: "browser.act",
      target: "https://example.com",
      summary: "reviewed fixture",
      money: true,
      binding: { sessionId, binding: { url: "https://example.com/" } },
    },
    "generic-browser-failure",
  );
  const result = await actions.decide("owner", proposal.id, proposal.hash, "approve", "human");
  assert.equal(result.status, "outcome_unknown");
  assert.equal((await resources.listForTask(`browser-review:${proposal.id}`)).length, 1);
  const competitor = await resources.acquire("owner", "later-work", [
    {
      key: `browser-profile:${browser.config.resourceHostId ?? "openmuse-server"}:${sessionId}`,
      units: 1,
      mode: "exclusive",
    },
  ]);
  assert.equal(competitor, null);
});

test("command replay borrows and preserves the running command resources", async () => {
  const db = await createStore();
  const resources = new ResourceLeases(db);
  const log = new ActionLog(db);
  let submissions = 0;
  const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/rpc/jobs/"))
      return Response.json(
        await db.get("owner", "computer-commands", path.split("/").at(-1) ?? "missing"),
      );
    assert.equal(path, "/rpc/jobs");
    const body = JSON.parse(String(init?.body));
    submissions++;
    return Response.json({
      ...body,
      status: "running",
      stdout: "",
      stderr: "",
      truncated: false,
      startedAt: new Date().toISOString(),
    });
  });
  const computer = auditedComputer(rpc, log, "rpc", resources, "replay-preflight-host");
  const id = hash("owner:replay-preflight");
  try {
    assert.equal(
      (
        await computer.execute(
          "owner",
          { command: "echo running", background: true },
          { idempotencyKey: "replay-preflight" },
        )
      ).status,
      "running",
    );
    assert.equal((await resources.listForTask(id)).length, 2);
    log.append = async () => {
      throw new Error("injected replay audit write failure");
    };
    assert.equal(
      (
        await computer.execute(
          "owner",
          { command: "echo running", background: true },
          { idempotencyKey: "replay-preflight" },
        )
      ).status,
      "running",
    );
    assert.equal(submissions, 1);
    assert.equal(
      (await db.get<{ status: string }>("owner", "computer-commands", id))?.status,
      "running",
    );
    assert.equal((await resources.listForTask(id)).length, 2);
    assert.equal(
      await resources.acquire("owner", "competing-command", [
        { key: "cpu-heavy:replay-preflight-host", units: 1, mode: "exclusive" },
      ]),
      null,
    );
  } finally {
    await db.close();
  }
});

test("failed dispatch and recovery claims cannot send or release resources", async () => {
  {
    const db = await createStore();
    let failedDispatchClaims = 0,
      submissions = 0;
    const cas = db.compareAndSwap.bind(db);
    db.compareAndSwap = async (...args: Parameters<typeof cas>) => {
      if (args[1] === "computer-audit" && args[4]?.phase === "dispatching") {
        failedDispatchClaims++;
        return null;
      }
      return cas(...args);
    };
    const rpc = new RpcComputerService(db, rpcConfig, async (_url, init) => {
      submissions++;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...body,
        status: "running",
        stdout: "",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
      });
    });
    const computer = auditedComputer(
      rpc,
      new ActionLog(db),
      "rpc",
      new ResourceLeases(db),
      "failed-claim-host",
    );
    try {
      await assert.rejects(
        computer.execute(
          "owner",
          { command: "echo x", background: true },
          { idempotencyKey: "failed-dispatch-claim" },
        ),
        /ownership/,
      );
      assert.equal(failedDispatchClaims, 1);
      assert.equal(submissions, 0);
    } finally {
      await db.close();
    }
  }
  {
    const db = await createStore(),
      resources = new ResourceLeases(db);
    const id = "failed-recovery-claim";
    await resources.acquire("owner", id, [
      { key: "cpu-heavy:failed-recovery-host", units: 1, mode: "exclusive" },
    ]);
    await resources.holdTask(id);
    await db.put("owner", "computer-audit", {
      id,
      operationId: id,
      tool: "computer.command",
      target: "Private workspace",
      summary: "Computer command",
      phase: "prepared",
    });
    let failedRecoveryClaims = 0,
      releasedBeforeClaim = false;
    const cas = db.compareAndSwap.bind(db),
      release = db.releaseResourceLease.bind(db);
    db.compareAndSwap = async (...args: Parameters<typeof cas>) => {
      if (args[1] === "computer-audit" && args[4]?.phase === "abandoned") {
        failedRecoveryClaims++;
        return null;
      }
      return cas(...args);
    };
    db.releaseResourceLease = async (lease) => {
      releasedBeforeClaim = failedRecoveryClaims === 0;
      return release(lease);
    };
    try {
      await reconcileComputerAudit({} as never, new ActionLog(db));
      assert.equal(failedRecoveryClaims, 1);
      assert.equal(releasedBeforeClaim, false);
      assert.equal((await resources.listForTask(id)).length, 1);
    } finally {
      await db.close();
    }
  }
});

test("model read_web releases its tracked profile on task completion", async (t) => {
  let currentUrl = "https://example.com/one";
  const browser = await browserFixture(t, (path, body) => {
    if (path === "/sessions") {
      currentUrl = String(body.url);
      return {
        data: {
          id: String(body.id),
          title: currentUrl,
          url: currentUrl,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    if (path.endsWith("/read"))
      return {
        data: {
          url: currentUrl,
          title: "Source one",
          text: "Local review evidence",
          truncated: false,
        },
      };
    throw new Error(`Unexpected browser path: ${path}`);
  });
  const calls = [
    { name: "read_web", arguments: { url: currentUrl } },
    { name: "finish_task", arguments: { summary: "Read the source." } },
  ];
  await modelFixture(t, (index) => calls[index]);
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Read the public source." });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  const resources = new ResourceLeases(browser.db);
  assert.equal((await resources.listForTask(task.id)).length, 0);
  const competitor = await resources.acquire("owner", "later-work", [
    {
      key: `browser-profile:${browser.config.resourceHostId ?? "openmuse-server"}:${saved.state.browserId}`,
      units: 1,
      mode: "exclusive",
    },
  ]);
  assert.ok(competitor);
});

for (const barrier of ["acquired", "audit_append"] as const) {
  test(`same-key recovery preserves a live attempt at ${barrier}`, async () => {
    const db = await createStore();
    const resources = new ResourceLeases(db);
    const log = new ActionLog(db);
    const entered = deferred();
    const resume = deferred();
    const id = hash(`owner:same-key-${barrier}`);
    const acquire = resources.acquire.bind(resources);
    const append = log.append.bind(log);
    resources.acquire = async (...args) => {
      const handles = await acquire(...args);
      if (barrier === "acquired") {
        entered.resolve();
        await resume.promise;
      }
      return handles;
    };
    log.append = async (owner, action, result) => {
      if (barrier === "audit_append" && result === "started") {
        entered.resolve();
        await resume.promise;
      }
      return append(owner, action, result);
    };
    let posts = 0;
    const rpc = new RpcComputerService(db, rpcConfig, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith("/rpc/jobs/"))
        return Response.json(await db.get("owner", "computer-commands", id));
      posts++;
      assert.equal((await resources.listForTask(id)).length, 2);
      return Response.json({
        ...JSON.parse(String(init?.body)),
        status: "running",
        stdout: "",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
      });
    });
    const computer = auditedComputer(rpc, log, "rpc", resources, "same-key-host");
    const execute = () =>
      computer.execute(
        "owner",
        { command: "echo intended", background: true },
        { idempotencyKey: `same-key-${barrier}` },
      );
    const first = execute();
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Missed barrier");
        }),
      ]);
      const handles = await resources.listForTask(id);
      await reconcileComputerAudit(computer, new ActionLog(db));
      assert.equal(
        (await db.get<{ phase: string }>("owner", "computer-audit", id))?.phase,
        "prepared",
      );
      await assert.rejects(execute(), /preflight ownership is already claimed/);
      assert.deepEqual(await resources.listForTask(id), handles);
      resume.resolve();
      assert.equal((await first).status, "running");
      assert.equal((await execute()).status, "running");
      assert.equal(posts, 1);
      assert.deepEqual(await resources.listForTask(id), handles);
    } finally {
      resume.resolve();
      await first.catch(() => {});
      await db.close();
    }
  });
}

test("different preflight generations never borrow each other's resource handles", async () => {
  const db = await createStore();
  const resources = new ResourceLeases(db);
  const requests = [{ key: "cpu-heavy:generation-host", units: 1, mode: "exclusive" as const }];
  try {
    const first = await resources.acquire("owner", "same-receipt", requests, "attempt-a");
    assert.ok(first);
    assert.equal(await resources.acquire("owner", "same-receipt", requests, "attempt-b"), null);
    await Promise.all(first.map((handle) => resources.release(handle)));
    const second = await resources.acquire("owner", "same-receipt", requests, "attempt-b");
    assert.ok(second);
    assert.notEqual(second[0].id, first[0].id);
    await Promise.all(first.map((handle) => resources.release(handle)));
    assert.deepEqual(await resources.listForTask("same-receipt"), second);
  } finally {
    await db.close();
  }
});
