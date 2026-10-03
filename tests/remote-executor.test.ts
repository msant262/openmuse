import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import {
  auditedComputer,
  currentComputerResourceScope,
  reconcileComputerAudit,
} from "../apps/server/src/audited-computer.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { RemoteComputerBackend } from "../apps/server/src/executors/remote-computer.ts";
import {
  authority,
  context,
  hello,
  readiness,
  registration,
  request,
} from "./helpers/executors.ts";

test("native delivery requires authoritative dispatch authorization, reconciliation and concrete readiness", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const registered = await registry.register(hello);
    await registry.enqueue("owner", request(), context);
    assert.deepEqual(
      (await registry.claimOperations("lenovo-okami", registered.epoch)).operations,
      [],
    );
    await registry.reconcile("lenovo-okami", {
      epoch: registered.epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const batch = await registry.claimOperations("lenovo-okami", registered.epoch);
    assert.equal(batch.operations.length, 1);
    assert.equal(batch.operations[0].revision, 3);
    assert.equal(batch.operations[0].executorEpoch, registered.epoch);
    assert.equal(batch.operations[0].resourceFence, 7);
    assert.equal(
      (await db.get<{ status: string }>("owner", "fixture-authoritative-operations", request().id))
        ?.status,
      "dispatching",
    );
    await assert.rejects(
      registry.enqueue("owner", { ...request("a".repeat(64)), capability: "desktop" }, context),
      /capability/i,
    );
    const unavailable = new ExecutorRegistry(db, { registrations: [registration] });
    const native = new RemoteComputerBackend(unavailable, { executorId: "lenovo-okami" });
    assert.equal((await native.snapshot("owner")).status, "error");
    await assert.rejects(
      native.execute("owner", { command: "printf bad" }),
      /authority|authorization/i,
    );
  } finally {
    await db.close();
  }
});

test("terminal receipt beats stale snapshots, duplicate/out-of-order receipts and same-ID arguments are bound", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const op = await registry.enqueue("owner", request(), context);
    await registry.claimOperations("lenovo-okami", epoch);
    const receipt = { status: "succeeded" as const, data: { proof: "output" } };
    assert.equal(
      (await registry.submitReceipt("lenovo-okami", epoch, op.id, 2, receipt)).sequence,
      2,
    );
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, { status: "running" });
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 3, { status: "running" });
    assert.equal((await registry.delivery("owner", op.id))?.receipt?.status, "succeeded");
    assert.equal(
      (await registry.submitReceipt("lenovo-okami", epoch, op.id, 2, receipt)).sequence,
      2,
    );
    await assert.rejects(
      registry.submitReceipt("lenovo-okami", epoch, op.id, 2, { status: "failed" }),
      /sequence|conflict/i,
    );
    assert.equal((await registry.enqueue("owner", request(), context)).id, op.id);
    await assert.rejects(
      registry.enqueue("owner", { ...request(), args: { command: "different" } }, context),
      /binding/,
    );
  } finally {
    await db.close();
  }
});

test("new boot fences old epoch and missing claimed work becomes unknown without retransmission", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const first = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch: first.epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const operation = await registry.enqueue("owner", request(), context);
    await registry.claimOperations("lenovo-okami", first.epoch);
    const next = await registry.register({ ...hello, bootId: "boot-b", instanceId: "instance-b" });
    assert.equal(next.epoch, first.epoch + 1);
    await assert.rejects(registry.heartbeat("lenovo-okami", first.epoch, readiness), /epoch/);
    await assert.rejects(
      registry.submitReceipt("lenovo-okami", first.epoch, operation.id, 1, { status: "succeeded" }),
      /epoch/,
    );
    await registry.reconcile("lenovo-okami", {
      epoch: next.epoch,
      bootId: "boot-b",
      operations: [],
      contained: true,
    });
    assert.equal(
      (await registry.delivery("owner", operation.id))?.receipt?.status,
      "outcome_unknown",
    );
    assert.deepEqual((await registry.claimOperations("lenovo-okami", next.epoch)).operations, []);
    await assert.rejects(registry.register(hello), /retired|superseded/i);
  } finally {
    await db.close();
  }
});

test("new epoch retires never-claimed queued work with proof of no dispatch", async () => {
  const db = await createStore();
  try {
    const journal = authority(db);
    let failReceipt = true;
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: {
        ...journal,
        async recordReceipt(...args) {
          if (failReceipt) {
            failReceipt = false;
            throw new Error("authority write interrupted");
          }
          return journal.recordReceipt(...args);
        },
      },
    });
    await registry.register(hello);
    const queued = await registry.enqueue("owner", request(), context);
    const { epoch } = await registry.register({
      ...hello,
      bootId: "boot-b",
      instanceId: "instance-b",
    });
    const manifest = { epoch, bootId: "boot-b", operations: [], contained: true };
    await assert.rejects(
      registry.reconcile("lenovo-okami", manifest),
      /authority write interrupted/,
    );
    assert.equal((await registry.node("lenovo-okami"))?.reconciled, false);
    await registry.reconcile("lenovo-okami", manifest);
    const final = await registry.delivery("owner", queued.id);
    assert.equal(final?.receipt?.status, "rejected_not_dispatched");
    assert.equal(final?.receipt?.data?.cleanupConfirmed, true);
    assert.equal(
      (await db.get<{ status: string }>("owner", "fixture-authoritative-operations", queued.id))
        ?.status,
      "rejected_not_dispatched",
    );
    assert.deepEqual((await registry.claimOperations("lenovo-okami", epoch)).operations, []);
  } finally {
    await db.close();
  }
});

test("an old epoch retirement that loses its queued CAS retains physical uncertainty", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    await registry.register(hello);
    const queued = await registry.enqueue("owner", request(), context);
    const { epoch } = await registry.register({
      ...hello,
      bootId: "boot-b",
      instanceId: "instance-b",
    });
    const compareAndSwap = db.compareAndSwap.bind(db);
    let raced = false;
    Object.defineProperty(db, "compareAndSwap", {
      value: async (...args: Parameters<typeof db.compareAndSwap>) => {
        if (
          !raced &&
          args[1] === "deliveries" &&
          args[2] === queued.id &&
          args[4].state === "settled"
        ) {
          raced = true;
          await compareAndSwap(
            args[0],
            args[1],
            args[2],
            { state: "queued", sequence: 0 },
            { state: "claimed" },
          );
          return null;
        }
        return compareAndSwap(...args);
      },
    });
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-b",
      operations: [],
      contained: true,
    });
    assert.equal(raced, true);
    const final = await registry.delivery("owner", queued.id);
    assert.equal(final?.receipt?.status, "outcome_unknown");
    assert.notEqual(final?.receipt?.data?.cleanupConfirmed, true);
    assert.deepEqual((await registry.claimOperations("lenovo-okami", epoch)).operations, []);
  } finally {
    await db.close();
  }
});

test("lost receipt ACK reconciles local terminal proof and process/server restart retains delivery", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const operation = await registry.enqueue("owner", request(), context);
    await registry.claimOperations("lenovo-okami", epoch);
    const receipt = { status: "succeeded" as const, data: { proof: "durable" } };
    await registry.submitReceipt("lenovo-okami", epoch, operation.id, 2, receipt);
    const restarted = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const registrationAgain = await restarted.register(hello);
    assert.equal(registrationAgain.epoch, epoch);
    const result = await restarted.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      contained: true,
      operations: [
        {
          operationId: operation.id,
          bindingHash: operation.bindingHash,
          executorEpoch: epoch,
          sequence: 2,
          receipt,
        },
      ],
    });
    assert.deepEqual(result.acknowledged, [{ operationId: operation.id, sequence: 2 }]);
    assert.equal((await restarted.delivery("owner", operation.id))?.receipt?.status, "succeeded");
    assert.deepEqual((await restarted.claimOperations("lenovo-okami", epoch)).operations, []);
  } finally {
    await db.close();
  }
});

test("authoritative revision rejection prevents delivery and pause keeps inspection available", async () => {
  const db = await createStore();
  try {
    const state = { deny: true, paused: false };
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db, state),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const op = await registry.enqueue("owner", request(), context);
    assert.deepEqual((await registry.claimOperations("lenovo-okami", epoch)).operations, []);
    assert.equal(
      (await registry.delivery("owner", op.id))?.receipt?.status,
      "rejected_not_dispatched",
    );
    state.deny = false;
    state.paused = true;
    await registry.enqueue(
      "owner",
      {
        ...request("c".repeat(64)),
        kind: "file",
        capability: "files",
        inspection: true,
        args: { operation: "list", path: "/workspace" },
      },
      context,
    );
    const paused = await registry.claimOperations("lenovo-okami", epoch);
    assert.equal(paused.pause.paused, true);
    assert.equal(paused.operations.length, 1);
    assert.equal(paused.operations[0].inspection, true);
  } finally {
    await db.close();
  }
});

test("uncertain native physical job retains running hold until managed cleanup confirmation", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const op = await registry.enqueue("owner", request(), context);
    await registry.claimOperations("lenovo-okami", epoch);
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: false },
    });
    const backend = new RemoteComputerBackend(registry, { executorId: "lenovo-okami" });
    assert.equal((await backend.command("owner", op.id)).status, "running");
    assert.equal((await backend.command("owner", op.id)).outcomeUnknown, true);
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 2, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: true },
    });
    assert.equal((await backend.command("owner", op.id)).status, "interrupted");
    assert.equal((await backend.command("owner", op.id)).cleanupConfirmed, true);
  } finally {
    await db.close();
  }
});

test("native replay borrows existing physical audit holds and confirmed unknown cleanup releases them", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const resources = new ResourceLeases(db);
    const native = new RemoteComputerBackend(registry, {
      executorId: "lenovo-okami",
      context: async () => context,
    });
    const audited = auditedComputer(native, new ActionLog(db), "native", resources, "lenovo");
    const first = await audited.execute(
      "owner",
      { command: "printf test", background: true },
      { idempotencyKey: "native-replay" },
    );
    assert.equal((await resources.listForTask(first.id)).length, 2);
    const replay = await audited.execute(
      "owner",
      { command: "printf test", background: true },
      { idempotencyKey: "native-replay" },
    );
    assert.equal(replay.id, first.id);
    assert.equal((await registry.deliveries("owner", "lenovo-okami")).length, 1);
    await registry.claimOperations("lenovo-okami", epoch);
    await registry.submitReceipt("lenovo-okami", epoch, first.id, 1, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: false },
    });
    await audited.command?.("owner", first.id);
    assert.equal((await resources.listForTask(first.id)).length, 2);
    await registry.submitReceipt("lenovo-okami", epoch, first.id, 2, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: true },
    });
    const final = await audited.command?.("owner", first.id);
    assert.equal(final?.outcomeUnknown, true);
    assert.equal(final?.status, "interrupted");
    assert.equal((await resources.listForTask(first.id)).length, 0);
  } finally {
    await db.close();
  }
});

test("unknown native file work keeps its exact physical lease until confirmed cleanup", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const resources = new ResourceLeases(db),
      log = new ActionLog(db);
    let holdTaskId = "";
    const native = new RemoteComputerBackend(registry, {
      executorId: "lenovo-okami",
      fileWaitMs: 50,
      pollMs: 1,
      context: async (owner) => {
        holdTaskId = currentComputerResourceScope(owner)?.resourceHoldTaskId ?? "";
        return context;
      },
    });
    const audited = auditedComputer(native, log, "native", resources, "lenovo");
    const write = audited.write("owner", "/workspace/uncertain.txt", "data");
    const rejected = assert.rejects(write, /uncertain|unknown|confirmed/i);
    const [op] = (await registry.claimOperations("lenovo-okami", epoch, { waitMs: 1000 }))
      .operations;
    assert.ok(op);
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: false },
    });
    await rejected;
    assert.ok(holdTaskId);
    const leases = await resources.listForTask(holdTaskId);
    assert.equal(leases.length, 1);
    assert.equal(
      (await db.get<{ hold: boolean }>("__runtime__", "resource-leases", leases[0].id))?.hold,
      true,
    );
    await reconcileComputerAudit(audited, log);
    assert.equal((await resources.listForTask(holdTaskId)).length, 1);
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 2, {
      status: "outcome_unknown",
      data: { cleanupConfirmed: true },
    });
    await reconcileComputerAudit(audited, log);
    assert.equal((await resources.listForTask(holdTaskId)).length, 0);
  } finally {
    await db.close();
  }
});

test("manual provenance callback receives the exact parsed defaults used by the registry", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    await registry.register(hello);
    const inputs: unknown[] = [];
    const native = new RemoteComputerBackend(registry, {
      executorId: "lenovo-okami",
      manualContext: async (_owner, _id, input) => {
        assert.equal(input?.inspection, false);
        assert.equal(input?.capabilityVersion, 1);
        inputs.push(input);
        return context;
      },
    });
    const options = { idempotencyKey: "manual-defaults" };
    await native.execute(
      "owner",
      { command: "printf ok", background: true, timeoutMs: 1000 },
      options,
    );
    await native.execute(
      "owner",
      { command: "printf ok", background: true, timeoutMs: 1000, cwd: "/workspace" },
      options,
    );
    assert.deepEqual(inputs[0], inputs[1]);
    assert.equal((await registry.deliveries("owner", "lenovo-okami")).length, 1);
    await assert.rejects(
      native.execute(
        "owner",
        { command: "printf changed", background: true, timeoutMs: 1000 },
        options,
      ),
      /binding/i,
    );
  } finally {
    await db.close();
  }
});

test("ordinary native file reads get fresh receipts while explicit output reads remain idempotent", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const native = new RemoteComputerBackend(registry, {
      executorId: "lenovo-okami",
      context: async () => context,
      pollMs: 1,
    });
    const read = async (content: string, options: { idempotencyKey?: string } = {}) => {
      const pending = native.fileBytes("owner", "/workspace/transcript.txt", options);
      const claimed = await registry.claimOperations("lenovo-okami", epoch, { waitMs: 1000 });
      const [operation] = claimed.operations;
      assert.ok(operation);
      assert.equal(operation.args.operation, "read_binary");
      assert.equal(operation.args.path, "/workspace/transcript.txt");
      const bytes = Buffer.from(content);
      await registry.submitReceipt("lenovo-okami", epoch, operation.id, 1, {
        status: "succeeded",
        data: {
          path: "/workspace/transcript.txt",
          base64: bytes.toString("base64"),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      return { operationId: operation.id, result: await pending };
    };

    const first = await read("old transcript");
    const second = await read("edited transcript");
    assert.notEqual(first.operationId, second.operationId);
    assert.equal(Buffer.from(first.result.bytes).toString(), "old transcript");
    assert.equal(Buffer.from(second.result.bytes).toString(), "edited transcript");

    const stable = await read("published output", { idempotencyKey: "media-output:text-id" });
    const replay = await native.fileBytes("owner", "/workspace/transcript.txt", {
      idempotencyKey: "media-output:text-id",
    });
    assert.equal(
      (await registry.claimOperations("lenovo-okami", epoch, { waitMs: 0 })).operations.length,
      0,
    );
    assert.equal(
      stable.operationId,
      createHash("sha256").update("owner:media-output:text-id").digest("hex"),
    );
    assert.equal(Buffer.from(replay.bytes).toString(), "published output");
  } finally {
    await db.close();
  }
});
