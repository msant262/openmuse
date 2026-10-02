import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { Files } from "../apps/server/src/files.ts";
import { verifyBrowserAuthorization } from "../packages/domain/src/browser-payment.ts";
import { browserFixture } from "./helpers/browser.ts";

for (const mode of ["succeeded", "drift", "unknown", "malformed", "cancelled"] as const)
  test(`native browser payment review ${mode} preserves exact private binding and one-use dispatch`, async (t) => {
    let id = "";
    let calls = 0;
    const action = { snapshotId: randomUUID(), element: 1, action: "click" as const };
    const binding = {
      snapshotId: action.snapshotId,
      element: 1,
      action,
      url: "https://shop.example/pay?secret=no-audit",
      frameUrl: "https://shop.example/pay",
      fingerprint: "private-binding-marker",
      formDigest: "digest",
      pageDigest: "digest",
    };
    const fixture = await browserFixture(t, (path, body) => {
      if (path === "/sessions") id = String(body.id);
      if (path.endsWith("/act"))
        return {
          status: 409,
          data: {
            error: {
              code: "PAYMENT_APPROVAL_REQUIRED",
              message: "Native approval needed",
              details: binding,
            },
          },
        };
      if (path.endsWith("/inspect"))
        return { data: { binding, label: "Pay now", requiresApproval: true } };
      if (path.endsWith("/reviewed-act")) {
        assert.ok(fixture.config.workerToken);
        const proof = verifyBrowserAuthorization(fixture.config.workerToken, body.authorization);
        assert.equal(proof.sessionId, id);
        assert.deepEqual(proof.binding, binding);
        if (mode === "drift")
          return {
            status: 409,
            data: { error: { code: "STALE_SNAPSHOT", message: "Page changed" } },
          };
        calls++;
        if (mode === "unknown")
          return {
            status: 409,
            data: { error: { code: "OUTCOME_UNKNOWN", message: "Response lost" } },
          };
        return {
          data: {
            id: proof.id,
            status: mode === "malformed" ? "invalid" : "succeeded",
            replayed: false,
          },
        };
      }
      return {
        data: {
          id,
          title: "Shop",
          url: binding.url,
          status: "active",
          control: "agent",
          updatedAt: new Date().toISOString(),
        },
      };
    });
    fixture.config.mode = "live";
    const createActions = () =>
      new ActionService(fixture.db, {
        policy: "money",
        connected: async () => false,
        execute: async () => "not Google",
      });
    let actions = createActions();
    fixture.service.configureActions(actions);
    id = await fixture.service.agentSession("owner");
    const taskId = mode === "cancelled" ? "financial-task" : undefined;
    if (taskId) await fixture.db.put("owner", "tasks", { id: taskId, status: "running" });
    const review = await fixture.service.act("owner", id, action, undefined, taskId);
    assert.ok("actionId" in review);
    assert.equal(calls, 0);
    const proposal = await fixture.db.get<import("../packages/domain/src/index.ts").ActionProposal>(
      "owner",
      "actions",
      review.actionId,
    );
    assert.ok(proposal);
    assert.equal(proposal.status, "awaiting_review");
    assert.equal(JSON.stringify(proposal).includes("private-binding-marker"), false);
    assert.equal(JSON.stringify(proposal).includes("secret=no-audit"), false);
    // API/service recreation preserves approval binding, without new browser targeting.
    actions = createActions();
    const auth = new Auth(fixture.db, fixture.config, "test-key");
    const restarted = new BrowserService(
      fixture.db,
      fixture.config,
      auth,
      new Files(fixture.db, fixture.config, auth),
    );
    restarted.configureActions(actions);
    if (taskId)
      await fixture.db.compareAndSwap("owner", "tasks", taskId, {}, { status: "cancelled" });
    if (mode === "cancelled")
      await assert.rejects(
        actions.decide("owner", proposal.id, proposal.hash, "approve"),
        /Cancelled tasks/,
      );
    else {
      const result = await actions.decide("owner", proposal.id, proposal.hash, "approve");
      assert.equal(
        result.status,
        mode === "succeeded"
          ? "succeeded"
          : mode === "unknown" || mode === "malformed"
            ? "outcome_unknown"
            : "failed",
      );
      await actions.decide("owner", proposal.id, proposal.hash, "approve");
    }
    assert.equal(calls, mode === "succeeded" || mode === "unknown" || mode === "malformed" ? 1 : 0);
    const audit = JSON.stringify(await fixture.db.actionLog("owner", 200));
    assert.equal(audit.includes("private-binding-marker"), false);
    assert.equal(audit.includes("secret=no-audit"), false);
  });

test("payment classification drift before review rejects promptly without reentering the session queue", {
  timeout: 3000,
}, async (t) => {
  let id = "";
  let dispatches = 0;
  const act = { snapshotId: randomUUID(), element: 1, action: "click" as const };
  const binding = {
    snapshotId: act.snapshotId,
    element: 1,
    action: act,
    url: "https://shop.example/",
    frameUrl: "https://shop.example/",
    fingerprint: "same",
    formDigest: "same",
    pageDigest: "changed",
  };
  const fixture = await browserFixture(t, (path, body) => {
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/act"))
      return {
        status: 409,
        data: {
          error: { code: "PAYMENT_APPROVAL_REQUIRED", message: "Payment form", details: binding },
        },
      };
    if (path.endsWith("/inspect"))
      return { data: { binding, label: "Continue", requiresApproval: false } };
    if (path.endsWith("/reviewed-act")) dispatches++;
    return {
      data: {
        id,
        title: "Shop",
        url: binding.url,
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  fixture.config.mode = "live";
  fixture.service.configureActions(
    new ActionService(fixture.db, {
      policy: "money",
      connected: async () => false,
      execute: async () => "unused",
    }),
  );
  id = await fixture.service.agentSession("owner");
  await assert.rejects(fixture.service.act("owner", id, act), { code: "STALE_SNAPSHOT" });
  assert.equal(dispatches, 0);
  assert.equal((await fixture.db.list("owner", "actions")).length, 0);
});
