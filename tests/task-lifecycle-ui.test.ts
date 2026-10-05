import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LocalThreads } from "../apps/server/src/threads.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an unfinished saved plan continues from its receipts when the model ends with a progress note", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 0
        ? {
            name: "todo_list",
            arguments: {
              todos: [
                { id: "collect", content: "Ler fontes", status: "completed" },
                { id: "compare", content: "Comparar resultados", status: "in_progress" },
              ],
            },
          }
        : i === 2
          ? {
              name: "finish_task",
              arguments: {
                summary:
                  "O primeiro formato privilegia a leitura; o segundo facilita comparar os números.",
              },
            }
          : undefined,
    { text: () => "Ainda estou comparando os resultados." },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    taskWorkerEnabled: false,
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Escreva um texto comparando dois formatos de apresentação.",
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "queued");
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(
    result.status,
    "succeeded",
    JSON.stringify({ error: result.error, completion: result.completion, result: result.result }),
  );
  assert.match(
    fixture.requests[2]?.body ?? "",
    /latest successfully saved plan still has unfinished steps/,
  );
});

test("accepted research is not rejected for absent literal labels, but stale reviews cannot certify another answer", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const task = await f.agent.createTask("owner", {
    prompt: "Como está a apuração?",
    criteria: [
      {
        id: "status",
        kind: "response",
        description: "Current status with time and sources",
        requiredItems: ["estado atual", "data/horário", "fontes verificáveis"],
      },
    ],
  });
  const summary =
    "O painel informou 99% das urnas às 08:01 UTC. Fonte: https://example.com/results";
  await f.db.put("owner", "task-operations", {
    id: "read",
    taskId: task.id,
    revision: 0,
    toolName: "web_fetch",
    status: "succeeded",
    effect: false,
    args: { url: "https://example.com/results" },
    receipt: {
      url: "https://example.com/results",
      text: "99% counted at 08:01 UTC",
      extraction: { status: "readable" },
    },
    createdAt: task.createdAt,
  });
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      researchDeliveryReview: {
        complete: true,
        missing: [],
        revision: 0,
        deliveryHash: createHash("sha256").update(summary).digest("hex"),
      },
    },
  });
  assert.equal(
    (await f.agent.verification.assess("owner", task.id, 0, summary)).status,
    "verified",
  );
  assert.notEqual(
    (await f.agent.verification.assess("owner", task.id, 0, "Um palpite diferente sem fonte"))
      .status,
    "verified",
  );
  assert.notEqual(
    (await f.agent.verification.assess("owner", task.id, 1, summary)).status,
    "verified",
  );
});

test("task detail follows actual running, successful and failed operations without model todo calls", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const task = await f.agent.createTask("owner", {
    prompt: "Pesquisar preços e entregar comparação",
  });
  await f.db.put("owner", "tasks", { ...task, status: "running" });
  const op = {
    id: "search",
    taskId: task.id,
    toolName: "search_web",
    args: { query: "preços" },
    status: "dispatching",
    createdAt: "2026-10-05T08:00:00Z",
  };
  await f.db.put("owner", "task-operations", op);
  let detail = await f.agent.detail("owner", task.id);
  assert.ok(
    detail.task.plan.some((step) => step.status === "running" && /Searching/.test(step.title)),
  );
  await f.db.put("owner", "task-operations", {
    ...op,
    status: "succeeded",
    receipt: { sources: [{ url: "https://example.com" }] },
  });
  const read = {
    ...op,
    id: "read",
    toolName: "web_fetch",
    args: { url: "https://example.com" },
    createdAt: "2026-10-05T08:00:01Z",
  };
  await f.db.put("owner", "task-operations", read);
  detail = await f.agent.detail("owner", task.id);
  assert.equal(detail.task.plan.find((step) => /Searching/.test(step.title))?.status, "succeeded");
  assert.equal(detail.task.plan.find((step) => /Reading/.test(step.title))?.status, "running");
  await f.db.put("owner", "task-operations", {
    ...read,
    status: "succeeded",
    receipt: { error: "Source unavailable" },
  });
  detail = await f.agent.detail("owner", task.id);
  assert.equal(detail.task.plan.find((step) => /Reading/.test(step.title))?.status, "failed");
  assert.notEqual(
    detail.task.plan.at(-1)?.status,
    "succeeded",
    "reads alone do not complete delivery",
  );
  await f.db.put("owner", "task-operations", {
    ...op,
    id: "finish-attempt",
    toolName: "finish_task",
    status: "succeeded",
    receipt: { complete: false },
  });
  assert.equal(
    (await f.agent.detail("owner", task.id)).task.plan.length,
    3,
    "delivery attempts do not duplicate the final delivery milestone",
  );
  await f.db.put("owner", "task-operations", {
    ...op,
    id: "finish-current",
    toolName: "finish_task",
    status: "dispatching",
  });
  assert.equal((await f.agent.detail("owner", task.id)).task.plan.at(-1)?.status, "running");
});

test("removing unfinished work requires cancellation, hides its notices, and preserves files and receipts", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const session = await (
    await f.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  const owner = "local-user",
    headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const task = await f.agent.createTask(owner, { prompt: "An old waiting task" });
  await f.db.put(owner, "tasks", { ...task, status: "waiting_input" });
  await f.db.put(owner, "notifications", {
    id: "notice",
    taskId: task.id,
    title: "Old work",
    createdAt: task.createdAt,
  });
  await f.db.put(owner, "files", { id: "retained-file", name: "Saved result" });
  await f.db.put(owner, "task-operations", {
    id: "receipt",
    taskId: task.id,
    status: "outcome_unknown",
  });
  const request = (cancelActive: boolean) =>
    f.app.request(`/api/agent/tasks/${task.id}/remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cancelActive }),
    });
  assert.equal((await request(false)).status, 409);
  assert.equal((await request(true)).status, 200);
  assert.equal((await request(true)).status, 200, "lost acknowledgement is retryable");
  const snapshot = await f.agent.snapshot(owner);
  assert.ok(!snapshot.tasks.some((t) => t.id === task.id));
  assert.ok(!snapshot.notifications.some((n) => n.taskId === task.id));
  assert.equal((await f.db.get(owner, "tasks", task.id))?.status, "cancelled");
  assert.ok(await f.db.get(owner, "files", "retained-file"));
  assert.equal((await f.db.get(owner, "task-operations", "receipt"))?.status, "outcome_unknown");
  await assert.rejects(f.agent.control(owner, task.id, "resume"));
});

test("confirmed conversation deletion cancels its unfinished work without affecting another conversation", async (t) => {
  const f = await taskRuntime(t, { taskWorkerEnabled: false });
  const session = await (
    await f.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  const owner = "local-user";
  assert.ok(f.threads instanceof LocalThreads);
  await f.threads.ensure(owner, "delete-me");
  await f.threads.ensure(owner, "keep-me");
  const old = await f.agent.createTask(owner, { prompt: "Old work", originThreadId: "delete-me" });
  const other = await f.agent.createTask(owner, {
    prompt: "Other work",
    originThreadId: "keep-me",
  });
  await f.db.put(owner, "tasks", { ...old, status: "waiting_input" });
  const response = await f.app.request("/api/copilotkit/threads/delete-me?stopActive=true", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await f.db.get(owner, "tasks", old.id))?.status, "cancelled");
  assert.equal((await f.agent.getTask(owner, other.id)).status, "queued");
  assert.ok((await f.db.get(owner, "threads", "delete-me"))?.deletedAt);
});
