import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  consumePythonReply,
  releasePythonReply,
  stagePythonReply,
} from "../apps/server/src/executors/python-replies.ts";
import { executorRoutes } from "../apps/server/src/executors/routes.ts";
import { nodeToken } from "./helpers/executors.ts";
import { pythonRuntime } from "./helpers/python-runtime.ts";

test("full private RPC replies leave no duplicate result payload in either canonical control journal", async (t) => {
  await pythonRuntime(t, async ({ server, registry, operation, context, rpc }) => {
    const request = await rpc("write_sample", {});
    const value = { values: Array.from({ length: 20_000 }, (_, n) => n) };
    const args = await stagePythonReply(registry, "owner", operation, request, {
      result: value,
      continue: true,
    });
    const reply = await registry.enqueue(
      "owner",
      {
        id: "private-reply",
        executorId: operation.executorId,
        kind: "session",
        capability: "python",
        capabilityVersion: 1,
        inspection: true,
        args,
      },
      context,
    );
    const [claimed] = (
      await registry.claimOperations(operation.executorId, operation.executorEpoch)
    ).operations;
    assert.equal(claimed?.id, reply.id);
    const body = {
      epoch: operation.executorEpoch,
      operationId: reply.id,
      parentOperationId: operation.id,
      requestSequence: request.sequence,
    };
    const payload = await consumePythonReply(
      registry,
      operation.executorId,
      args.replyReference,
      body,
    );
    assert.deepEqual(JSON.parse(payload.json), { result: value, continue: true });
    assert.equal(Buffer.byteLength(payload.json), args.replyBytes);
    assert.equal(createHash("sha256").update(payload.json).digest("hex"), args.replyHash);
    assert.deepEqual(
      await consumePythonReply(registry, operation.executorId, args.replyReference, body),
      payload,
      "the same claimed control may recover a dropped response without rerunning the host effect",
    );
    const stored = await server.db.get<{ args: unknown }>("owner", "task-operations", reply.id);
    assert.deepEqual(stored?.args, args);
    assert.ok(!JSON.stringify(stored?.args).includes('"values"'));
    releasePythonReply(registry, args.replyReference);
    await assert.rejects(
      consumePythonReply(registry, operation.executorId, args.replyReference, body),
      /expired|unavailable|retired/i,
    );
  });
});

test("node-only HTTP consumption refuses another request, epoch, owner and unclaimed reply", async (t) => {
  await pythonRuntime(t, async ({ registry, operation, context, rpc }) => {
    const request = await rpc("write_sample", {});
    await assert.rejects(
      stagePythonReply(registry, "other", operation, request, { result: {}, continue: true }),
    );
    const args = await stagePythonReply(registry, "owner", operation, request, {
      result: { observed: true },
      continue: false,
    });
    const reply = await registry.enqueue(
      "owner",
      {
        id: "http-reply",
        executorId: operation.executorId,
        kind: "session",
        capability: "python",
        capabilityVersion: 1,
        inspection: true,
        args,
      },
      context,
    );
    const body = {
      epoch: operation.executorEpoch,
      operationId: reply.id,
      parentOperationId: operation.id,
      requestSequence: request.sequence,
    };
    const route = executorRoutes(registry),
      url = `/lenovo-okami/python-replies/${args.replyReference}/consume`;
    const invoke = (input: unknown, token = nodeToken) =>
      route.request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    assert.equal((await invoke(body, "wrong-node-token")).status, 401);
    assert.equal((await invoke(body)).status, 403);
    await registry.claimOperations(operation.executorId, operation.executorEpoch);
    for (const invalid of [
      { ...body, epoch: body.epoch + 1 },
      { ...body, requestSequence: 2 },
      { ...body, parentOperationId: "other-cell" },
    ])
      assert.notEqual((await invoke(invalid)).status, 200);
    const response = await invoke(body);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(JSON.parse(((await response.json()) as { json: string }).json), {
      result: { observed: true },
      continue: false,
    });
    releasePythonReply(registry, args.replyReference);
  });
});

test("a native receipt changing during host execution retires its old grant and control authority", async (t) => {
  await pythonRuntime(t, async ({ registry, operation, context, rpc }) => {
    const request = await rpc("write_sample", {});
    const args = await stagePythonReply(registry, "owner", operation, request, {
      result: {},
      continue: true,
    });
    const reply = await registry.enqueue(
      "owner",
      {
        id: "stale-reply",
        executorId: operation.executorId,
        kind: "session",
        capability: "python",
        capabilityVersion: 1,
        inspection: true,
        args,
      },
      context,
    );
    await registry.claimOperations(operation.executorId, operation.executorEpoch);
    await rpc("write_sample", { changed: true });
    await assert.rejects(
      consumePythonReply(registry, operation.executorId, args.replyReference, {
        epoch: operation.executorEpoch,
        operationId: reply.id,
        parentOperationId: operation.id,
        requestSequence: request.sequence,
      }),
      /changed|current|binding|request/i,
    );
    releasePythonReply(registry, args.replyReference);
  });
});
