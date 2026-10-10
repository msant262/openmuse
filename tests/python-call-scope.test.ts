import assert from "node:assert/strict";
import test from "node:test";
import { withNativePythonHostCall } from "../apps/server/src/engine/python-call-scope.ts";
import {
  authorizeTaskEffect,
  TaskOutcomeUnknownError,
} from "../apps/server/src/engine/task-journal.ts";
import { pythonHostCallId } from "../apps/server/src/executors/python-protocol.ts";
import { pythonRuntime } from "./helpers/python-runtime.ts";

test("only the exact host tool call can run under its claimed Python parent, and replay preserves its receipt", async (t) => {
  await pythonRuntime(t, async ({ server, task, operation, rpc }) => {
    const journal = server.agent.journal;
    const request = await rpc("write_sample", { text: "owned" });
    const call = {
      id: "run:first",
      toolCallId: pythonHostCallId(operation.id, request),
      name: "write_sample",
      args: { text: "owned" },
    };
    let effects = 0;
    const execute = async () => {
      await authorizeTaskEffect();
      effects++;
      return { written: true };
    };
    await assert.rejects(journal.run("owner", task, call, execute, true), TaskOutcomeUnknownError);
    await withNativePythonHostCall(journal, "owner", operation, request, async () => {
      for (const invalid of [
        { ...call, id: "run:wrong", toolCallId: "child-selected-id" },
        { ...call, id: "run:changed", args: { text: "changed" } },
        { ...call, id: "run:another", name: "another_tool" },
      ])
        await assert.rejects(
          journal.run("owner", task, invalid, execute, true),
          /binding|scope|request/i,
        );
      assert.deepEqual(await journal.run("owner", task, call, execute, true), { written: true });
      assert.deepEqual(
        await journal.run("owner", task, { ...call, id: "another-provider-run" }, execute, true),
        { written: true },
      );
    });
    assert.equal(effects, 1);
    assert.equal(
      (await server.db.get<{ status: string }>("owner", "task-operations", operation.id))?.status,
      "running",
    );
  });
});

test("host call scope never exempts another uncertain effect or a receipt that advanced", async (t) => {
  await pythonRuntime(t, async ({ server, task, operation, rpc }) => {
    const journal = server.agent.journal;
    const request = await rpc("write_sample", {});
    const parent = await server.db.get<Record<string, unknown>>(
      "owner",
      "task-operations",
      operation.id,
    );
    assert.ok(parent);
    await journal.prepare("owner", {
      ...parent,
      id: "prior-uncertain",
      toolName: "prior_effect",
      parentOperationId: undefined,
      nativeEnvelope: undefined,
      status: "queued",
      args: {},
      physicalOperationId: undefined,
      sequence: undefined,
      receipt: undefined,
    } as Parameters<typeof journal.prepare>[1]);
    await journal.recordReceipt(
      "owner",
      "prior-uncertain",
      { outcomeUnknown: true },
      "outcome_unknown",
    );
    let effects = 0;
    const call = {
      id: "run:second",
      toolCallId: pythonHostCallId(operation.id, request),
      name: "write_sample",
      args: {},
    };
    await withNativePythonHostCall(journal, "owner", operation, request, async () => {
      await assert.rejects(
        journal.run(
          "owner",
          task,
          call,
          async () => {
            effects++;
          },
          true,
        ),
        (error: unknown) =>
          error instanceof TaskOutcomeUnknownError &&
          error.operationIds.includes("prior-uncertain") &&
          !error.operationIds.includes(operation.id),
      );
      await rpc("write_sample", { changed: true });
      await assert.rejects(
        journal.run(
          "owner",
          task,
          { ...call, id: "run:stale" },
          async () => {
            effects++;
          },
          true,
        ),
        /current|request|changed/i,
      );
    });
    assert.equal(effects, 0);
  });
});

test("a host scope requires canonical current ownership and an immutable allowed tool catalog", async (t) => {
  await pythonRuntime(t, async ({ server, operation, rpc }) => {
    let called = false;
    const execute = async () => {
      called = true;
    };
    const request = await rpc("write_sample", {});
    await assert.rejects(
      withNativePythonHostCall(server.agent.journal, "other", operation, request, execute),
    );
    await assert.rejects(
      withNativePythonHostCall(
        server.agent.journal,
        "owner",
        { ...operation, taskId: "other-task" },
        request,
        execute,
      ),
    );
    const unavailable = await rpc("not_in_catalog", {});
    await assert.rejects(
      withNativePythonHostCall(server.agent.journal, "owner", operation, unavailable, execute),
      /catalog|allowed/i,
    );
    assert.equal(called, false);
  });
});
