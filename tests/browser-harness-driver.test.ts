import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import test from "node:test";

async function driverModule() {
  const path = new URL("../apps/worker/src/browser-harness-driver.ts", import.meta.url);
  assert.equal(
    await access(path).then(
      () => true,
      () => false,
    ),
    true,
    "The owned native CDP/meta driver is missing",
  );
  return import(path.href);
}

class RootCdp extends EventEmitter {
  replies = true;
  sent: { method: string; params: Record<string, unknown> }[] = [];
  async send(method: string, params: Record<string, unknown> = {}) {
    this.sent.push({ method, params });
    if (method === "Target.attachToTarget") return { sessionId: `wire-${params.targetId}` };
    if (method === "Target.getTargetInfo")
      return {
        targetInfo: { targetId: params.targetId, type: "page", title: "Owned", url: "about:blank" },
      };
    if (method === "Target.sendMessageToTarget" && this.replies) {
      const message = JSON.parse(String(params.message));
      queueMicrotask(() =>
        this.emit("Target.receivedMessageFromTarget", {
          sessionId: params.sessionId,
          message: JSON.stringify({ id: message.id, result: { observedMethod: message.method } }),
        }),
      );
    }
    return {};
  }
}

async function fixture() {
  const { BrowserHarnessDriver } = await driverModule();
  const cdp = new RootCdp(),
    created: string[] = [],
    authorized: unknown[] = [];
  let active = true;
  const driver = new BrowserHarnessDriver({
    cdp,
    createPage: async () => {
      const targetId = `owned-${created.length}`;
      created.push(targetId);
      let closed = false;
      return {
        targetId,
        page: {
          isClosed: () => closed,
          close: async () => {
            closed = true;
          },
          bringToFront: async () => {},
        },
      };
    },
    guard: () => assert.equal(active, true, "Program authority retired"),
    authorize: async (...args: unknown[]) => {
      authorized.push(args);
    },
    screenshot: async () => ({ data: "protected-pixels" }),
    redact: (value: unknown) => value,
  });
  return {
    driver,
    cdp,
    created,
    authorized,
    retire: () => {
      active = false;
    },
  };
}

const scope = { owner: "owner", conversation: "conversation", name: "research" };

test("copied helper meta and page commands use a persistent owned named session", async () => {
  const f = await fixture();
  try {
    const first = await f.driver.handle(scope, { meta: "session" });
    assert.equal(typeof first.session_id, "string");
    const response = await f.driver.handle(scope, {
      method: "Runtime.evaluate",
      params: { expression: "40+2" },
      session_id: null,
    });
    assert.deepEqual(response, { result: { observedMethod: "Runtime.evaluate" } });
    assert.deepEqual(await f.driver.handle(scope, { meta: "session" }), first);
    assert.equal(f.created.length, 1);
    assert.ok(f.authorized.length > 0);
    assert.ok(f.cdp.sent.some((request) => request.method === "Target.sendMessageToTarget"));
  } finally {
    await f.driver.close();
  }
});

test("one conversation cannot attach to another named session's target or session ID", async () => {
  const f = await fixture();
  try {
    const other = { ...scope, conversation: "other-conversation" };
    const first = await f.driver.handle(scope, { meta: "session" });
    await f.driver.handle(other, { meta: "session" });
    const targets = await f.driver.handle(other, { method: "Target.getTargets", params: {} });
    assert.deepEqual(
      targets.result.targetInfos.map((target: { targetId: string }) => target.targetId),
      ["owned-1"],
    );
    const before = f.cdp.sent.length;
    await assert.rejects(
      f.driver.handle(other, {
        method: "Target.attachToTarget",
        params: { targetId: "owned-0", flatten: true },
      }),
      /owned|another|foreign/i,
    );
    await assert.rejects(
      f.driver.handle(other, {
        method: "Runtime.evaluate",
        params: {},
        session_id: first.session_id,
      }),
      /owned|another|foreign/i,
    );
    assert.equal(f.cdp.sent.length, before, "Foreign requests must not reach CDP");
  } finally {
    await f.driver.close();
  }
});

test("screenshots pass through the protected image hook and retired programs send no command", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      await f.driver.handle(scope, { method: "Page.captureScreenshot", params: { format: "png" } }),
      { result: { data: "protected-pixels" } },
    );
    assert.equal(
      f.cdp.sent.some((request) =>
        String(request.params.message).includes("Page.captureScreenshot"),
      ),
      false,
    );
    const before = f.cdp.sent.length;
    f.retire();
    await assert.rejects(
      f.driver.handle(scope, { method: "Page.navigate", params: { url: "https://example.org" } }),
      /authority retired/i,
    );
    assert.equal(f.cdp.sent.length, before);
  } finally {
    await f.driver.close();
  }
});

test("closing the attached tab does not prevent browser-level creation of its replacement", async () => {
  const f = await fixture();
  try {
    const original = await f.driver.handle(scope, { meta: "current_tab" });
    await f.driver.handle(scope, {
      method: "Target.closeTarget",
      params: { targetId: original.targetId },
    });
    const next = await f.driver.handle(scope, {
      method: "Target.createTarget",
      params: { url: "about:blank", background: true },
    });
    const attached = await f.driver.handle(scope, {
      method: "Target.attachToTarget",
      params: { targetId: next.result.targetId, flatten: true },
    });
    await f.driver.handle(scope, {
      meta: "set_session",
      session_id: attached.result.sessionId,
      target_id: next.result.targetId,
    });
    assert.equal(
      (await f.driver.handle(scope, { meta: "current_tab" })).targetId,
      next.result.targetId,
    );
  } finally {
    await f.driver.close();
  }
});

test("switching back to a tab re-enables its event domains after background network disable", async () => {
  const f = await fixture();
  try {
    const original = await f.driver.handle(scope, { meta: "session" });
    const next = await f.driver.handle(scope, {
      method: "Target.createTarget",
      params: { url: "about:blank" },
    });
    const attached = await f.driver.handle(scope, {
      method: "Target.attachToTarget",
      params: { targetId: next.result.targetId, flatten: true },
    });
    await f.driver.handle(scope, {
      meta: "set_session",
      session_id: attached.result.sessionId,
      target_id: next.result.targetId,
    });
    await f.driver.handle(scope, {
      meta: "set_session",
      session_id: original.session_id,
      target_id: "owned-0",
    });
    const originalEnables = f.cdp.sent.filter(
      (request) =>
        request.method === "Target.sendMessageToTarget" &&
        request.params.sessionId === "wire-owned-0" &&
        JSON.parse(String(request.params.message)).method === "Network.enable",
    );
    assert.equal(
      originalEnables.length,
      2,
      "The resumed tab must receive network-idle events again",
    );
  } finally {
    await f.driver.close();
  }
});

test("event buffers are bounded and never expose another conversation's CDP events", async () => {
  const f = await fixture();
  try {
    const first = await f.driver.handle(scope, { meta: "session" });
    const other = { ...scope, conversation: "other" };
    await f.driver.handle(other, { meta: "session" });
    for (let index = 0; index < 510; index++)
      f.cdp.emit("Target.receivedMessageFromTarget", {
        sessionId: "wire-owned-0",
        message: JSON.stringify({ method: "Network.loadingFinished", params: { index } }),
      });
    f.cdp.emit("Target.receivedMessageFromTarget", {
      sessionId: "foreign",
      message: JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: { secret: "foreign" },
      }),
    });
    const captured = await f.driver.handle(scope, { meta: "drain_events" });
    assert.equal(captured.events.length, 500);
    assert.equal(captured.events[0].params.index, 10);
    assert.ok(
      captured.events.every(
        (event: { session_id: string }) => event.session_id === first.session_id,
      ),
    );
    assert.deepEqual(await f.driver.handle(other, { meta: "drain_events" }), { events: [] });
    assert.deepEqual(await f.driver.handle(scope, { meta: "drain_events" }), { events: [] });
  } finally {
    await f.driver.close();
  }
});

test("a lost CDP reply times out without replaying the command", async () => {
  const f = await fixture();
  try {
    await f.driver.handle(scope, { meta: "session" });
    const before = f.cdp.sent.length;
    f.cdp.replies = false;
    await assert.rejects(
      f.driver.handle(
        scope,
        { method: "Runtime.evaluate", params: { expression: "effect()" } },
        20,
      ),
      /outcome is unconfirmed/,
    );
    assert.equal(f.cdp.sent.length, before + 1);
  } finally {
    await f.driver.close();
  }
});
