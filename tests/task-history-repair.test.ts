import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { Message } from "@ag-ui/core";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import type { JournalOperation, TaskCheckpoint } from "../apps/server/src/engine/task-journal.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const pair = (id: string, args: object, receipt: unknown): Message[] => [
  {
    id: randomUUID(),
    role: "assistant",
    toolCalls: [
      { id, type: "function", function: { name: "lookup", arguments: JSON.stringify(args) } },
    ],
  },
  { id: randomUUID(), role: "tool", toolCallId: id, content: JSON.stringify(receipt) },
];

for (const kind of [
  "alias-only",
  "gateway-alias",
  "duplicate",
  "collision-suffixes",
  "different-operations",
  "ambiguous-alias",
  "different-result",
  "different-arguments",
  "unknown-effect",
] as const)
  test(`legacy journal history repair preserves authoritative operations: ${kind}`, async (t) => {
    const f = await taskRuntime(t);
    const task = await f.agent.createTask("owner", { prompt: "Continue from the saved sources." });
    const args = { query: "course" };
    const receipt = { title: "Observed course", duration: "2 hours" };
    const make = (id: string): JournalOperation => ({
      id: `tool:${task.id}:${id}`,
      taskId: task.id,
      revision: 0,
      bindingHash: bindingHash({ name: "lookup", args }),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "succeeded",
      toolName: "lookup",
      toolCallId: id,
      args,
      receipt,
      effect: false,
      runToken: "legacy",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
    });
    const operations = [make("call_ABC")];
    let messages = pair("callABC", args, { duration: "2 hours", title: "Observed course" });
    let expected = ["call_ABC"];
    if (kind === "gateway-alias") {
      const id = "tool_call:call_abcdefghi123456789012345:okami_lookup:1";
      operations[0] = make(id);
      messages = [
        ...pair(id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40), args, receipt),
        ...pair(id, args, receipt),
      ];
      expected = [id];
    }
    if (kind === "duplicate") messages.push(...pair("call_ABC", args, receipt));
    if (kind === "collision-suffixes") {
      const alias = `callABC${createHash("sha256").update("call_ABC").digest("hex").slice(0, 8)}`;
      messages.push(...pair(alias, args, receipt), ...pair(`${alias}x2`, args, receipt));
    }
    if (kind === "different-operations") {
      operations.push(make("call_DEF"));
      messages.push(...pair("callDEF", args, receipt));
      expected = ["call_ABC", "call_DEF"];
    }
    if (kind === "ambiguous-alias") {
      operations.splice(0, 1, make("call_A_BC"), make("call_AB_C"));
      expected = ["callABC", "call_A_BC", "call_AB_C"];
    }
    if (kind === "different-result") {
      messages = pair("callABC", args, { ...receipt, duration: "3 hours" });
      expected = ["callABC", "call_ABC"];
    }
    if (kind === "different-arguments") {
      messages = pair("callABC", { query: "different source" }, receipt);
      expected = ["callABC", "call_ABC"];
    }
    if (kind === "unknown-effect") {
      operations[0] = {
        ...operations[0],
        status: "outcome_unknown",
        receipt: undefined,
        effect: true,
      };
      expected = ["callABC", "call_ABC"];
    }
    const prose: Message = {
      id: randomUUID(),
      role: "assistant",
      content: "The saved source will be reused.",
    };
    messages.splice(2, 0, prose);
    const checkpoint: TaskCheckpoint = {
      id: task.id,
      taskId: task.id,
      appliedRevision: 0,
      mailboxSeq: 0,
      pendingOperationIds: [],
      messages,
    };
    await f.db.put("owner", "task-checkpoints", checkpoint);
    for (const operation of operations) await f.db.put("owner", "task-operations", operation);
    const before = structuredClone(checkpoint);
    const operationsBefore = await f.agent.journal.operations("owner", task.id);
    const history = await f.agent.journal.history("owner", task.id);
    const results = history.filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.toolCallId).sort(), expected.sort());
    assert.ok(
      history.some((message) => message.id === prose.id && message.content === prose.content),
    );
    assert.deepEqual(
      await f.db.get("owner", "task-checkpoints", task.id),
      before,
      "recovery changes the model view, never the original checkpoint",
    );
    assert.deepEqual(
      await f.agent.journal.operations("owner", task.id),
      operationsBefore,
      "actual effects and receipts remain untouched",
    );
    if (kind === "unknown-effect") {
      const unknown = JSON.parse(String(results.at(-1)?.content));
      assert.equal(unknown.outcomeUnknown, true);
      assert.equal(unknown.operationId, operations[0].id);
    }
  });
