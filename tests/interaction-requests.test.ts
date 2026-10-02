import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { InteractionRequests } from "../apps/server/src/interaction-requests.ts";

test("literal credential titles, choice metadata and Portuguese named answers cannot enter generic question storage", async () => {
  const db = await createStore();
  const requests = new InteractionRequests(db);
  try {
    await db.put("owner", "tasks", {
      id: "task",
      status: "waiting_input",
      state: {},
      input: {},
      attempts: 1,
      originThreadId: "chat",
    });
    const schemas = [
      {
        title: "Password for this login",
        fields: [{ id: "reply", label: "Your answer", type: "text" }],
      },
      { title: "Details", fields: [{ id: "senha", label: "Your answer", type: "text" }] },
      {
        title: "Details",
        fields: [
          {
            id: "reply",
            label: "Credencial",
            type: "single",
            options: [{ id: "yes", label: "Yes" }],
          },
        ],
      },
      {
        title: "Details",
        fields: [
          {
            id: "reply",
            label: "Choice",
            type: "single",
            options: [{ id: "yes", label: "API key" }],
          },
        ],
      },
    ];
    for (const schema of schemas)
      await assert.rejects(
        requests.create("owner", { taskId: "task", revision: 1, kind: "question", schema }),
      );
    // Older/foreign rows also pass through validation when answered, not just creation.
    await db.put("owner", "interaction-requests", {
      id: "old-card",
      taskId: "task",
      revision: 1,
      kind: "question",
      status: "waiting",
      createdAt: new Date().toISOString(),
      threadId: "chat",
      schema: {
        title: "Password for this login",
        fields: [
          { id: "reply", label: "Your answer", type: "text", required: true, multiline: false },
        ],
      },
    });
    await assert.rejects(
      requests.answer("owner", "old-card", {
        clientResponseId: "unsafe-old",
        revision: 1,
        answer: { reply: "FAKE_PASSWORD_SENTINEL" },
      }),
    );
    const ordinary = await requests.create("owner", {
      taskId: "task",
      revision: 1,
      kind: "question",
      schema: { title: "Details", fields: [{ id: "reply", label: "Your answer", type: "text" }] },
    });
    for (const id of ["senha", "segredo", "credencial", "access_token", "password"])
      await assert.rejects(
        requests.answer("owner", ordinary.id, {
          clientResponseId: `unsafe-${id}`,
          revision: 1,
          answer: { [id]: "FAKE_PASSWORD_SENTINEL" },
        }),
      );
    assert.equal(
      (await db.get<{ status: string }>("owner", "tasks", "task"))?.status,
      "waiting_input",
    );
    assert.equal(
      JSON.stringify(await db.list("owner", "tasks")).includes("FAKE_PASSWORD_SENTINEL"),
      false,
    );
    assert.equal(
      JSON.stringify(await db.list("owner", "interaction-requests")).includes(
        "FAKE_PASSWORD_SENTINEL",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(await db.conversationEvents("owner", "chat", 0)).includes(
        "FAKE_PASSWORD_SENTINEL",
      ),
      false,
    );
  } finally {
    await db.close();
  }
});

test("question double submit is idempotent and answer atomically resumes only its task", async () => {
  const db = await createStore();
  const requests = new InteractionRequests(db);
  try {
    await db.put("owner", "tasks", {
      id: "task",
      status: "waiting_input",
      state: {},
      input: {},
      question: "Pick dates",
      attempts: 1,
      originThreadId: "chat",
    });
    await db.put("owner", "tasks", { id: "other", status: "running" });
    const request = await requests.create("owner", {
      taskId: "task",
      revision: 1,
      kind: "question",
      schema: {
        title: "Pick dates",
        fields: [
          {
            id: "choice",
            label: "Date",
            type: "single",
            required: true,
            options: [
              { id: "fri", label: "Friday" },
              { id: "sat", label: "Saturday" },
            ],
          },
        ],
      },
    });
    const body = { clientResponseId: "response1", revision: 1, answer: { choice: "fri" } };
    await Promise.all([
      requests.answer("owner", request.id, body),
      requests.answer("owner", request.id, body),
    ]);
    assert.equal((await requests.status("owner", request.id)).status, "answered");
    const task = await db.get<{ status: string; state: { answer: string } }>(
      "owner",
      "tasks",
      "task",
    );
    assert.equal(task?.status, "queued");
    assert.match(task?.state.answer ?? "", /fri/);
    assert.equal((await db.get<{ status: string }>("owner", "tasks", "other"))?.status, "running");
    await assert.rejects(
      requests.answer("owner", request.id, {
        ...body,
        clientResponseId: "response2",
        answer: { choice: "sat" },
      }),
      { status: 409 },
    );
    await assert.rejects(requests.status("other", request.id), { status: 404 });
  } finally {
    await db.close();
  }
});

test("generic cards reject credentials/approval, unknown options, stale revision and late task answers", async () => {
  const db = await createStore();
  const requests = new InteractionRequests(db);
  try {
    await db.put("owner", "tasks", {
      id: "task",
      status: "waiting_input",
      state: {},
      input: {},
      attempts: 2,
    });
    await assert.rejects(
      requests.create("owner", {
        taskId: "task",
        revision: 2,
        kind: "credential" as never,
        schema: { title: "Login", fields: [{ id: "password", label: "Password", type: "text" }] },
      }),
    );
    await assert.rejects(
      requests.create("owner", {
        taskId: "task",
        revision: 2,
        kind: "question",
        schema: {
          title: "Enter your password",
          fields: [{ id: "reply", label: "Your answer", type: "text" }],
        },
      }),
    );
    const request = await requests.create("owner", {
      taskId: "task",
      revision: 2,
      kind: "question",
      schema: { title: "Details", fields: [{ id: "reply", label: "Your answer", type: "text" }] },
    });
    await assert.rejects(
      requests.answer("owner", request.id, {
        clientResponseId: "wrong",
        revision: 1,
        answer: { reply: "hi" },
      }),
      { status: 409 },
    );
    await assert.rejects(
      requests.answer("owner", request.id, {
        clientResponseId: "secret",
        revision: 2,
        answer: { password: "x" },
      }),
    );
    await db.compareAndSwap("owner", "tasks", "task", {}, { status: "succeeded" });
    await assert.rejects(
      requests.answer("owner", request.id, {
        clientResponseId: "late",
        revision: 2,
        answer: { reply: "hi" },
      }),
      { status: 409 },
    );
  } finally {
    await db.close();
  }
});

test("question answer ACK loss survives disk restart without approving a money action or resuming another task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "question-restart-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  try {
    const action = {
      id: "money",
      status: "awaiting_review",
      hash: "trusted-review-binding",
      operation: "payment",
    };
    await db.put("owner", "actions", action);
    await db.put("owner", "tasks", {
      id: "task",
      status: "waiting_input",
      state: {},
      input: {},
      attempts: 1,
      actionId: action.id,
    });
    await db.put("owner", "tasks", { id: "other", status: "running", state: {} });
    let requests = new InteractionRequests(db);
    const request = await requests.create("owner", {
      taskId: "task",
      revision: 1,
      kind: "question",
      schema: {
        title: "Which note should be used?",
        fields: [{ id: "note", type: "text", label: "Note", required: true }],
      },
    });
    const body = { clientResponseId: "ack-lost", revision: 1, answer: { note: "Yes" } };
    const answer = await requests.answer("owner", request.id, body);
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    requests = new InteractionRequests(db);
    assert.deepEqual(await requests.answer("owner", request.id, body), answer);
    assert.deepEqual(await db.get("owner", "actions", "money"), action);
    assert.equal((await db.get<{ status: string }>("owner", "tasks", "other"))?.status, "running");
    assert.equal((await db.get<{ attempts: number }>("owner", "tasks", "task"))?.attempts, 1);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted document bindings preserve optional blanks and do not invent an unchecked consent value", async () => {
  const db = await createStore();
  const requests = new InteractionRequests(db);
  try {
    await db.put("owner", "tasks", {
      id: "document",
      kind: "document",
      title: "Trip document",
      status: "waiting_input",
      input: {},
      attempts: 1,
      state: {
        missingFields: [
          { name: "name", type: "text" },
          { name: "emergency_contact", type: "text" },
          { name: "consent", type: "checkbox" },
        ],
      },
    });
    const task = await db.get<import("../packages/domain/src/agent.ts").AgentTask>(
      "owner",
      "tasks",
      "document",
    );
    const request = await requests.forTask("owner", task!);
    await requests.answer("owner", request.id, {
      clientResponseId: "document-answer",
      revision: 1,
      answer: { field0: "Ana" },
    });
    assert.deepEqual(
      (await db.get<{ input: { fields: unknown } }>("owner", "tasks", "document"))?.input.fields,
      { name: "Ana" },
    );
  } finally {
    await db.close();
  }
});
