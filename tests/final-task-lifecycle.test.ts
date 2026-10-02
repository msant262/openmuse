import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

for (const interruption of ["takeover", "crash", "uncertain"] as const) {
  test(`ordinary browser receipt survives ${interruption} and fresh snapshot references`, async (t) => {
    let sessionId = "",
      snapshotId = crypto.randomUUID(),
      human = false,
      effects = 0;
    const browser = await browserFixture(t, (path, body) => {
      if (path === "/sessions") sessionId = String(body.id);
      if (path.endsWith("/act")) {
        effects++;
        snapshotId = crypto.randomUUID();
        if (interruption === "uncertain")
          return {
            status: 502,
            data: {
              error: { code: "WORKER_UNAVAILABLE", message: "Connection lost after dispatch" },
            },
          };
      }
      if (path.endsWith("/snapshot") && human)
        return {
          status: 409,
          data: {
            error: { code: "BROWSER_CONTROLLED", message: "Hand back", details: { sessionId } },
          },
        };
      if (path.endsWith("/snapshot") || path.endsWith("/act"))
        return {
          data: {
            sessionId,
            snapshotId,
            url: "https://example.com/",
            title: "Form",
            text: effects ? "Sent form receipt unique123" : "Submit once",
            truncated: false,
            truncatedElements: false,
            control: "agent",
            elements: [
              {
                number: 1,
                tag: "button",
                role: "button",
                label: "Submit",
                disabled: false,
                frameUrl: "https://example.com/",
              },
            ],
          },
        };
      return {
        data: {
          id: sessionId,
          url: "https://example.com/",
          title: "Form",
          status: "active",
          control: human ? "human" : "agent",
          updatedAt: new Date().toISOString(),
        },
      };
    });
    let phase = 0,
      resumed = false;
    const model = await modelFixture(t, () => {
      if (resumed) {
        if (phase++ === 0)
          return { name: "browser_navigate", arguments: { url: "https://example.com/" } };
        if (phase === 2)
          return {
            name: "browser_act",
            arguments: { act: { action: "click", snapshotId, element: 1 } },
          };
        if (phase === 3)
          return { name: "finish_task", arguments: { summary: "Submission complete" } };
        return undefined;
      }
      if (phase++ === 0)
        return { name: "browser_navigate", arguments: { url: "https://example.com/" } };
      if (phase === 2)
        return {
          name: "browser_act",
          arguments: { act: { action: "click", snapshotId, element: 1 } },
        };
      if (phase === 3) {
        human = interruption === "takeover";
        return {
          name: human ? "browser_snapshot" : "ask_user",
          arguments: human ? {} : { question: "Continue after restart" },
        };
      }
      return undefined;
    });
    let app = await createApp(browser.db, {
      ...browser.config,
      mode: "live",
      agentBackend: "model",
      model: "openai/fixture",
      modelProviders: richChatFixtureProviders(browser.config.dataDir),
    });
    t.after(() => app.agent.stop());
    const task = await app.agent.createTask("owner", { prompt: "Submit the form once" });
    await app.agent.worker.tick();
    assert.equal(effects, 1);
    if (interruption !== "takeover") {
      await app.agent.stop();
      app = await createApp(browser.db, {
        ...browser.config,
        mode: "live",
        agentBackend: "model",
        model: "openai/fixture",
        modelProviders: richChatFixtureProviders(browser.config.dataDir),
      });
      await browser.db.compareAndSwap(
        "owner",
        "tasks",
        task.id,
        {},
        { status: "queued", leaseId: null, leaseUntil: null },
      );
    }
    human = false;
    resumed = true;
    phase = 0;
    snapshotId = crypto.randomUUID();
    const offset = model.requests.length;
    await app.agent.worker.tick();
    if (interruption === "uncertain") {
      assert.equal(
        model.requests.length,
        offset,
        "unconfirmed action fences automatic resumed inference/actions",
      );
      assert.equal((await app.agent.getTask("owner", task.id)).status, "waiting_input");
      assert.equal(effects, 1);
      return;
    }
    assert.ok(
      model.requests[offset].body.includes("Sent form receipt unique123"),
      "original result must enter resumed model context",
    );
    assert.equal(effects, 1, "fresh snapshot IDs cannot replay an already completed logical act");
    assert.equal((await app.agent.getTask("owner", task.id)).status, "succeeded");
  });
}

test("task inference deadline does not expire while a 30-minute foreground command owns execution", async (t) => {
  const browser = await browserFixture(t, () => ({ data: {} }));
  const calls = [
    {
      name: "run_command",
      arguments: { operationId: "long", command: "sleep 600", timeoutMs: 1800000 },
    },
    { name: "finish_task", arguments: { summary: "Long command finished" } },
  ];
  await modelFixture(t, (i) => calls[i]);
  const app = await createApp(browser.db, {
    ...browser.config,
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());
  let release!: () => void, began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  let signal: AbortSignal | undefined;
  app.agent.computer.execute = async (_owner, _input, options) => {
    signal = options?.signal;
    began();
    await held;
    return { id: "long", status: "succeeded" } as Awaited<
      ReturnType<typeof app.agent.computer.execute>
    >;
  };
  const timers = new Set<() => void>();
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const handles = new Map<unknown, () => void>();
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    const handle = originalSet(callback, ms, ...args);
    if (ms === 300000) {
      timers.add(callback);
      handles.set(handle, callback);
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const callback = handles.get(handle);
    if (callback) timers.delete(callback);
    return originalClear(handle);
  }) as typeof clearTimeout;
  try {
    const task = await app.agent.createTask("owner", { prompt: "Run a long bounded command" });
    const tick = app.agent.worker.tick();
    await started;
    for (const callback of [...timers]) callback();
    await new Promise((r) => originalSet(r, 25));
    const during = await app.agent.getTask("owner", task.id);
    release();
    await tick;
    assert.equal(during.status, "running");
    assert.equal(signal?.aborted, false);
    assert.equal((await app.agent.getTask("owner", task.id)).status, "succeeded");
  } finally {
    release?.();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test("accepted but unconfirmed browser action is fenced after a fresh executor recovers", async (t) => {
  const { TaskBrowserHistory } = await import("../apps/server/src/engine/browser-history.ts");
  const browser = await browserFixture(t, () => ({ data: {} }));
  const model = await modelFixture(t, () => ({
    name: "browser_act",
    arguments: { act: { action: "click", snapshotId: crypto.randomUUID(), element: 1 } },
  }));
  let app = await createApp(browser.db, {
    ...browser.config,
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());
  const task = await app.agent.createTask("owner", { prompt: "Submit once" });
  const history = await TaskBrowserHistory.load(browser.db, "owner", task.id);
  let effects = 0;
  await assert.rejects(
    history.run(
      "browser_act",
      {
        operationId: "submit",
        act: { action: "click", snapshotId: crypto.randomUUID(), element: 1 },
      },
      async () => {
        effects++;
        throw new Error("Process interrupted after remote submission before local result");
      },
    ),
    /interrupted/,
  );
  await app.agent.stop();
  app = await createApp(browser.db, {
    ...browser.config,
    mode: "live",
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_input");
  assert.match(saved.question ?? "", /unconfirmed outcome/);
  assert.equal(model.requests.length, 0);
  assert.equal(effects, 1);
  assert.ok(
    (await TaskBrowserHistory.load(browser.db, "owner", task.id))
      .messages()
      .some((m) => "content" in m && String(m.content).includes("outcomeUnknown")),
  );
});

test("task cancellation propagates and joins foreground receipt before releasing the run", async (t) => {
  const browser = await browserFixture(t, () => ({ data: {} }));
  await modelFixture(t, () => ({
    name: "run_command",
    arguments: { operationId: "cancel", command: "sleep 600", timeoutMs: 1800000 },
  }));
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  let began!: () => void, settle!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const receipt = new Promise<void>((r) => {
    settle = r;
  });
  let signal: AbortSignal | undefined;
  app.agent.computer.execute = async (_owner, _input, options) => {
    signal = options?.signal;
    began();
    await receipt;
    await browser.db.put("owner", "computer-commands", { id: "cancel", status: "interrupted" });
    return { id: "cancel", status: "interrupted" } as Awaited<
      ReturnType<typeof app.agent.computer.execute>
    >;
  };
  const task = await app.agent.createTask("owner", { prompt: "Run long bounded command" });
  const tick = app.agent.worker.tick();
  await started;
  let stopped = false;
  const stopping = app.agent.worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(signal?.aborted, true);
  assert.equal(stopped, false);
  assert.equal((await app.agent.getTask("owner", task.id)).status, "running");
  settle();
  await stopping;
  await tick;
  assert.equal(
    (await browser.db.get("owner", "computer-commands", "cancel"))?.status,
    "interrupted",
  );
  assert.equal((await app.agent.getTask("owner", task.id)).status, "queued");
  await app.agent.stop();
});

test("idle inference deadline fails promptly without cancelling an explicit background receipt", async (t) => {
  const browser = await browserFixture(t, () => ({ data: {} }));
  let stalled!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    stalled = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  await modelFixture(t, async (i) => {
    if (i === 0)
      return {
        name: "run_command",
        arguments: {
          operationId: "background",
          command: "sleep 600",
          timeoutMs: 1800000,
          background: true,
        },
      };
    stalled();
    await held;
    return undefined;
  });
  const app = await createApp(browser.db, {
    ...browser.config,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
  });
  t.after(() => app.agent.stop());
  app.agent.computer.execute = async (_owner, args) => {
    assert.equal((args as { background: boolean }).background, true);
    await browser.db.put("owner", "computer-commands", {
      id: "background",
      status: "running",
      background: true,
    });
    return { id: "background", status: "running", background: true } as Awaited<
      ReturnType<typeof app.agent.computer.execute>
    >;
  };
  const original = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers = new Set<() => void>(),
    handles = new Map<unknown, () => void>();
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    const handle = original(callback, ms, ...args);
    if (ms === 300000) {
      timers.add(callback);
      handles.set(handle, callback);
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const callback = handles.get(handle);
    if (callback) timers.delete(callback);
    return originalClear(handle);
  }) as typeof clearTimeout;
  try {
    const task = await app.agent.createTask("owner", {
      prompt: "Start background job then explain",
    });
    const tick = app.agent.worker.tick();
    await started;
    // Quota admission also uses five-minute timers, which are cleared before dispatch.
    assert.equal(timers.size, 1, "only the task idle deadline remains armed after admission");
    const [expire] = timers;
    assert.ok(expire);
    expire();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        tick,
        new Promise<never>((_, reject) => {
          deadline = original(
            () => reject(new Error("Task did not settle promptly after its idle deadline")),
            5000,
          );
        }),
      ]);
    } finally {
      if (deadline) originalClear(deadline);
    }
    assert.equal((await app.agent.getTask("owner", task.id)).status, "failed");
    assert.match((await app.agent.getTask("owner", task.id)).error ?? "", /inference timed out/);
    assert.equal(
      (await browser.db.get("owner", "computer-commands", "background"))?.status,
      "running",
    );
  } finally {
    release();
    globalThis.setTimeout = original;
    globalThis.clearTimeout = originalClear;
  }
});
