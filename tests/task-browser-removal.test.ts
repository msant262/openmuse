import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { bindingHash } from "../apps/server/src/conversation-inbox.ts";
import { browserRemovalRequest } from "../apps/server/src/engine/browser-removal.ts";
import { taskCriteria } from "../apps/server/src/engine/task-verification.ts";
import { reviewedRemoval } from "./helpers/browser-removal.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const prompt = "Exclua o documento desta página: https://example.com/document";

test("page deletion is mandatory; names, links, negation and connector requests are not new browser instructions", () => {
  for (const text of [
    prompt,
    "Delete the document on this page: https://example.com/document",
    "Lösche die Datei auf dieser Webseite: https://example.com/document",
  ])
    assert.ok(
      taskCriteria({ kind: "agent", prompt: text }).some(
        (c) => c.id === "requested-browser-deletion",
      ),
    );
  for (const text of [
    "Leia a página https://example.com/delete/document",
    "Não exclua o documento desta página: https://example.com/document",
    "Do not delete the document on this page: https://example.com/document",
    "Abra o documento “delete” nesta página: https://example.com/document",
    "Exclua o documento no Google Drive: https://drive.google.com/file/d/test/view",
    "Exclua o documento nesta página: https://docs.google.com/document/d/test/edit",
    "Exclua o compromisso no calendário da conta a@gmail.com.",
  ])
    assert.equal(browserRemovalRequest(text), undefined, text);
});

test("a premature plain-text finish resumes from the missing effect instead of publishing a successful deletion", async (t) => {
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? undefined
        : {
            name: "finish_task",
            arguments: {
              summary: "A página foi apenas consultada; não foi possível executar a exclusão.",
              outcome: "partial",
            },
          },
    { text: (index) => (index === 0 ? "Documento excluído." : undefined) },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", { prompt });
  await server.agent.journal.prepare("owner", reviewedRemoval(task.id).operations[0]);
  await server.agent.worker.tick();
  const initial = JSON.parse(fixture.requests[0].body);
  const visible = initial.tools.flatMap(
    (tool: { name?: string; tools?: { name: string }[] }) =>
      tool.tools?.map((child) => child.name) ?? [tool.name],
  );
  for (const name of ["browser_navigate", "browser_snapshot", "browser_act", "browser_dialog"])
    assert.ok(visible.includes(name), `${name} must be callable on the first model turn`);
  assert.match(initial.instructions, /supplied URL identifies the target location/);
  assert.match(initial.instructions, /native connectors for Google Drive/);
  const continued = await server.agent.getTask("owner", task.id);
  assert.equal(continued.status, "queued", continued.error ?? continued.result);
  assert.ok(Array.isArray(continued.state.completionFollowup));
  assert.equal(continued.result ?? null, null);
  await server.agent.worker.tick();
  const saved = await server.agent.getTask("owner", task.id);
  assert.notEqual(saved.status, "succeeded");
  assert.equal(fixture.requests.length, 2);
  assert.match(fixture.requests[1].body, /Missing requirements:/);
  assert.equal(
    (await server.agent.journal.operations("owner", task.id)).filter(
      (op) => op.toolName === "browser_act",
    ).length,
    0,
  );
});

test("opening or reading a page cannot certify a requested deletion, even with successful-looking page content", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt });
  const fixture = reviewedRemoval(task.id);
  for (const toolName of ["browser_navigate", "browser_snapshot"]) {
    await server.agent.journal.prepare("owner", {
      ...fixture.operations[0],
      id: toolName,
      toolName,
      receipt: fixture.result,
    });
    const assessment = await server.agent.verification.assess(
      "owner",
      task.id,
      0,
      "Documento excluído.",
    );
    assert.notEqual(assessment.status, "verified", JSON.stringify(assessment));
  }
});

test("the actual approved dialog and changed page complete deletion using its action receipt, never the initial read", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt });
  const fixture = reviewedRemoval(task.id);
  for (const op of fixture.operations) await server.agent.journal.prepare("owner", op);
  await server.db.put("owner", "actions", fixture.action);
  await server.db.put("owner", "external-action-bindings", fixture.privateBinding);
  const assessment = await server.agent.verification.assess(
    "owner",
    task.id,
    0,
    "Documento excluído.",
  );
  assert.equal(assessment.status, "verified", JSON.stringify(assessment));
  assert.deepEqual(
    assessment.checks.find((c) => c.criterionId === "requested-browser-deletion")?.evidenceIds,
    [fixture.action.id],
  );
  assert.deepEqual(
    (await server.agent.journal.operations("owner", task.id)).find(
      (op) => op.id === "prepared-delete",
    )?.receipt,
    fixture.operations[2].receipt,
  );
});

test("pending, refused, failed, unrelated or stale reviews and mismatched dialog responses cannot prove deletion", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt });
  const original = reviewedRemoval(task.id);
  const cases: [string, (f: typeof original) => void][] = [
    ...["awaiting_review", "denied", "failed", "outcome_unknown"].map(
      (status) =>
        [
          status,
          (f: typeof original) => {
            f.action.status = status as typeof f.action.status;
          },
        ] as [string, (f: typeof original) => void],
    ),
    [
      "other task",
      (f) => {
        f.action.taskId = "other-task";
      },
    ],
    [
      "old revision",
      (f) => {
        f.action.dispatchedRevision = 1;
      },
    ],
    [
      "changed private binding",
      (f) => {
        f.privateBinding.hash = "b".repeat(64);
      },
    ],
    [
      "wrong page",
      (f) => {
        f.privateBinding.binding.url = "https://example.com/other";
      },
    ],
    [
      "different SPA resource",
      (f) => {
        f.result.url += "#other-document";
      },
    ],
    [
      "wrong session",
      (f) => {
        f.result.sessionId = randomUUID();
      },
    ],
    [
      "wrong dialog",
      (f) => {
        f.result.response.dialogId = randomUUID();
      },
    ],
    [
      "dismissed dialog",
      (f) => {
        f.result.response.accept = false;
      },
    ],
    [
      "unchanged page",
      (f) => {
        f.result.text = f.before.text;
      },
    ],
    [
      "unrelated change",
      (f) => {
        f.result.text = "Document saved successfully.";
      },
    ],
    [
      "future promise",
      (f) => {
        f.result.text = "Document will be deleted after approval.";
      },
    ],
    [
      "possibility rather than confirmation",
      (f) => {
        f.result.text = "Document can be deleted.";
      },
    ],
    [
      "negated result",
      (f) => {
        f.result.text = "Document was not deleted.";
      },
    ],
    [
      "old deletion marker",
      (f) => {
        f.before.text = f.result.text;
        f.operations[0].receipt = f.before;
      },
    ],
    [
      "truncated observation",
      (f) => {
        f.result.truncated = true;
      },
    ],
    [
      "new unanswered dialog",
      (f) => {
        Object.assign(f.result, {
          dialog: { ...f.privateBinding.binding.dialog, id: randomUUID() },
        });
      },
    ],
    [
      "unbound prepared call",
      (f) => {
        f.operations[2].bindingHash = "c".repeat(64);
      },
    ],
    [
      "wrong opening control",
      (f) => {
        f.before.elements[0].label = "Save document";
        f.operations[0].receipt = f.before;
      },
    ],
    [
      "wrong opening call",
      (f) => {
        const args = f.operations[1].args as { act: { snapshotId: string } };
        args.act.snapshotId = randomUUID();
        f.operations[1].bindingHash = bindingHash({ name: "browser_act", args });
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const fixture = structuredClone(original);
    mutate(fixture);
    fixture.action.result = JSON.stringify(fixture.result);
    for (const op of fixture.operations) await server.db.put("owner", "task-operations", op);
    await server.db.put("owner", "actions", fixture.action);
    await server.db.put("owner", "external-action-bindings", fixture.privateBinding);
    const assessment = await server.agent.verification.assess(
      "owner",
      task.id,
      0,
      "Documento excluído.",
    );
    assert.notEqual(assessment.status, "verified", label);
  }
});

test("another owner's private approval binding is never evidence for this owner", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt });
  const fixture = reviewedRemoval(task.id);
  for (const op of fixture.operations) await server.agent.journal.prepare("owner", op);
  await server.db.put("owner", "actions", fixture.action);
  await server.db.put("other-owner", "external-action-bindings", fixture.privateBinding);
  assert.notEqual((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("approval of another named document cannot fulfill the requested document deletion", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", {
    prompt: "Delete the document “Budget” on this page: https://example.com/document",
  });
  const fixture = reviewedRemoval(task.id);
  for (const op of fixture.operations) await server.agent.journal.prepare("owner", op);
  await server.db.put("owner", "actions", fixture.action);
  await server.db.put("owner", "external-action-bindings", fixture.privateBinding);
  assert.notEqual((await server.agent.verification.assess("owner", task.id, 0)).status, "verified");
});

test("an asynchronous deletion needs a fresh read after its bound approved response; earlier or unrelated reads cannot certify it", async (t) => {
  const server = await taskRuntime(t);
  const task = await server.agent.createTask("owner", { prompt });
  const fixture = reviewedRemoval(task.id);
  fixture.action.result = JSON.stringify({ ...fixture.result, text: fixture.before.text });
  for (const op of fixture.operations) await server.agent.journal.prepare("owner", op);
  await server.db.put("owner", "actions", fixture.action);
  await server.db.put("owner", "external-action-bindings", fixture.privateBinding);
  const observation = {
    ...fixture.operations[0],
    id: "after-deletion",
    toolName: "browser_snapshot",
    createdAt: "2026-10-10T00:00:05Z",
    receipt: fixture.result,
  };
  for (const patch of [
    { createdAt: "2026-10-10T00:00:01Z" },
    { revision: 1 },
    { receipt: { ...fixture.result, sessionId: randomUUID() } },
    { receipt: { ...fixture.result, url: "https://example.com/other" } },
  ]) {
    await server.db.put("owner", "task-operations", { ...observation, ...patch });
    assert.notEqual(
      (await server.agent.verification.assess("owner", task.id, 0)).status,
      "verified",
    );
  }
  await server.db.put("owner", "task-operations", observation);
  const assessment = await server.agent.verification.assess("owner", task.id, 0);
  assert.equal(assessment.status, "verified", JSON.stringify(assessment));
  assert.deepEqual(assessment.checks[0].evidenceIds, [fixture.action.id, observation.id]);
});
