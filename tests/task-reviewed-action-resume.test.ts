import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";
import {
  claimsPendingReview,
  REVIEWED_ACTION_REPORT,
} from "../apps/server/src/engine/reviewed-action-context.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const providerCheckpoint of [false, true])
  test(`resumed review replaces obsolete waiting tool data${providerCheckpoint ? " in a provider checkpoint" : " in saved history"}, preserving canonical receipts`, async (t) => {
    const server = await taskRuntime(t);
    const task = await server.agent.createTask("owner", {
      prompt: "Delete the document on this page: https://example.com/document",
    });
    const pending = { actionId: "review", approvalRequired: true, dispatched: false };
    const operation = {
      id: "dialog-operation",
      taskId: task.id,
      revision: 0,
      bindingHash: "a".repeat(64),
      executorId: "vps",
      executorEpoch: 1,
      resourceFence: 0,
      status: "succeeded" as const,
      toolName: "browser_dialog",
      toolCallId: "dialog-call",
      args: { dialogId: "actual-dialog", accept: true },
      effect: true,
      runToken: "fixture",
      resourceLeaseIds: [],
      createdAt: new Date().toISOString(),
      receipt: pending,
    };
    await server.agent.journal.prepare("owner", operation);
    const messages: Message[] = [
      {
        id: "saved-call",
        role: "assistant",
        toolCalls: [
          {
            id: "dialog-call",
            type: "function",
            function: {
              name: "browser_dialog",
              arguments: JSON.stringify(operation.args),
            },
          },
        ],
      },
      {
        id: "saved-result",
        role: "tool",
        toolCallId: "dialog-call",
        content: JSON.stringify(pending),
      },
    ];
    await server.db.put("owner", "task-checkpoints", {
      id: task.id,
      taskId: task.id,
      appliedRevision: 0,
      messages,
    });
    const resumed = providerCheckpoint
      ? {
          ...task,
          state: {
            ...task.state,
            providerCheckpoint: {
              version: 1,
              messages,
              code: "MODEL_CAPABILITY_UNAVAILABLE",
              accepted: false,
              rejectedModel: "openai/fixture",
              partialText: "",
            },
          },
        }
      : task;
    for (const status of ["succeeded", "denied", "failed", "outcome_unknown"] as const) {
      const action = {
        id: "review",
        taskId: task.id,
        status,
        preparedRevision: 0,
        dispatchedRevision: 0,
        result: JSON.stringify({
          text: "Document deleted. Deletions: 1.",
          response: { dialogId: "actual-dialog", accept: true },
        }),
        error: status === "failed" ? "The page rejected the change" : undefined,
      };
      await server.db.put("owner", "actions", action);
      const history = await server.agent.actor.history("owner", resumed);
      const content = history.find((m) => m.role === "tool")?.content;
      assert.equal(typeof content, "string");
      const receipt = JSON.parse(String(content));
      assert.equal(receipt.status, status);
      assert.equal(receipt.approvalRequired, false);
      assert.equal(receipt.result, action.result);
      assert.equal(receipt.error, action.error);
      assert.equal(
        receipt.dispatched,
        undefined,
        "an old pre-dispatch marker cannot describe the finished review",
      );
    }
    assert.deepEqual((await server.agent.journal.operations("owner", task.id))[0].receipt, pending);
    assert.deepEqual(
      (await server.db.get<{ messages: Message[] }>("owner", "task-checkpoints", task.id))
        ?.messages,
      messages,
    );
  });

test("review replay uses the canonical operation binding and never another owner, task or revision", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt: "Inspect the page" });
  const pending = { actionId: "bound-review", approvalRequired: true };
  await server.agent.journal.prepare("owner", {
    id: "bound-operation",
    taskId: task.id,
    revision: 0,
    bindingHash: "a".repeat(64),
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    status: "succeeded",
    toolName: "browser_dialog",
    toolCallId: "bound-call",
    args: {},
    effect: true,
    runToken: "fixture",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    receipt: pending,
  });
  const action = {
    id: "bound-review",
    taskId: task.id,
    status: "succeeded",
    preparedRevision: 0,
    dispatchedRevision: 0,
    result: "Owned actual result",
  };
  for (const [owner, patch] of [
    ["other-owner", {}],
    ["owner", { taskId: "other-task" }],
    ["owner", { dispatchedRevision: 1 }],
    ["owner", { status: "awaiting_review" }],
    ["owner", { status: "executing" }],
  ] as const) {
    await server.db.put(owner, "actions", { ...action, ...patch });
    const history = await server.agent.actor.history("owner", task);
    assert.deepEqual(JSON.parse(String(history.find((m) => m.role === "tool")?.content)), pending);
  }
});

test("live approval-waiting statements are distinguished from completed and historical reviews", () => {
  for (const text of [
    "A exclusão está aguardando sua aprovação no cartão.",
    "A alteração continua pendente de aprovação.",
    "The deletion is awaiting your approval.",
    "Waiting for confirmation before deleting the file.",
    "Die Änderung wartet auf deine Freigabe.",
  ])
    assert.equal(claimsPendingReview(text), true, text);
  for (const text of [
    "Não está mais aguardando aprovação: o documento foi excluído.",
    "A alteração estava aguardando aprovação; agora está concluída.",
    "The deletion was awaiting approval. It has now completed.",
    "The operation is no longer waiting for confirmation.",
    "O documento foi excluído e o resultado foi conferido.",
    "The deletion has not completed because the page rejected it.",
  ])
    assert.equal(claimsPendingReview(text), false, text);
});

test("the report guard does not turn a pending, denied, failed or unrelated review into a completed effect", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Delete the document on this page: https://example.com/document",
  });
  const action = {
    id: "current-review",
    taskId: task.id,
    dispatchedRevision: 0,
    preparedRevision: 0,
    kind: "external.action",
    data: { tool: "browser.dialog" },
    result: "Confirmed own result",
  };
  for (const [status, patch, expectedGuard] of [
    ["awaiting_review", {}, false],
    ["executing", {}, false],
    ["denied", {}, false],
    ["failed", {}, false],
    ["outcome_unknown", {}, false],
    ["succeeded", { taskId: "other-task" }, false],
    ["succeeded", { dispatchedRevision: 1 }, false],
    ["succeeded", {}, true],
  ] as const) {
    await server.db.put("owner", "actions", { ...action, status, ...patch });
    const assessment = await server.agent.verification.assess(
      "owner",
      task.id,
      0,
      "A exclusão está aguardando sua aprovação.",
    );
    assert.equal(
      assessment.checks.some((c) => c.criterionId === REVIEWED_ACTION_REPORT),
      expectedGuard,
    );
    assert.notEqual(
      assessment.status,
      "verified",
      "a report guard is not external-effect evidence",
    );
  }
  await server.db.put("owner", "actions", { ...action, status: "succeeded" });
  await server.db.put("owner", "actions", {
    ...action,
    id: "next-review",
    status: "awaiting_review",
  });
  const assessment = await server.agent.verification.assess(
    "owner",
    task.id,
    0,
    "A segunda ação está aguardando sua aprovação.",
  );
  assert.ok(!assessment.checks.some((c) => c.criterionId === REVIEWED_ACTION_REPORT));
});

test("a resumed model corrects obsolete approval prose without dispatching the completed change again", async (t) => {
  const fixture = await modelFixture(t, (index) => ({
    name: "finish_task",
    arguments: {
      summary:
        index === 0
          ? "A exclusão está aguardando sua aprovação no cartão. Ainda não foi excluído."
          : "Documento excluído; a página confirmou uma exclusão.",
    },
  }));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Delete the document on this page: https://example.com/document",
  });
  const action = {
    id: "approved-dialog",
    taskId: task.id,
    kind: "external.action",
    status: "succeeded",
    dispatchedRevision: 0,
    preparedRevision: 0,
    data: { tool: "browser.dialog" },
    result: JSON.stringify({
      sessionId: "own-session",
      snapshotId: "own-snapshot",
      url: "https://example.com/document",
      title: "Own document",
      text: "Document deleted. Deletions: 1.",
      response: { dialogId: "own-dialog", accept: true },
    }),
  };
  await server.db.put("owner", "actions", action);
  await server.db.put("owner", "tasks", { ...task, actionId: action.id });
  await server.agent.journal.prepare("owner", {
    id: "observed-page",
    taskId: task.id,
    revision: 0,
    bindingHash: "a".repeat(64),
    executorId: "vps",
    executorEpoch: 1,
    resourceFence: 0,
    status: "succeeded",
    toolName: "browser_snapshot",
    args: {},
    effect: false,
    runToken: "fixture",
    resourceLeaseIds: [],
    createdAt: new Date().toISOString(),
    receipt: JSON.parse(action.result),
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.result, "Documento excluído; a página confirmou uma exclusão.");
  assert.equal(fixture.requests.length, 2);
  const operations = await server.agent.journal.operations("owner", task.id);
  assert.equal(operations.filter((op) => op.toolName === "finish_task").length, 2);
  assert.equal(
    operations.filter((op) => op.toolName.startsWith("browser_") && op.effect).length,
    0,
  );
  const publications = await server.db.list<{ text: string }>("owner", "thread-publications");
  assert.ok(publications.every((p) => !/aguardando sua aprovação/.test(p.text)));
  assert.equal(
    (await server.db.get<ActionProposal>("owner", "actions", action.id))?.result,
    action.result,
  );
});
