import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActionLog } from "../apps/server/src/action-log.ts";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { auditedComputer } from "../apps/server/src/audited-computer.ts";
import { ComputerService } from "../apps/server/src/computer.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AgentService } from "../apps/server/src/engine/service.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { config, fixture, ok } from "./helpers/computer.ts";

test("command, filesystem and failed calls are audited without command/output/file payloads", async () => {
  const db = await createStore();
  const adapter = fixture();
  const backend = auditedComputer(
    new ComputerService(db, config, adapter.runner),
    new ActionLog(db),
  );
  try {
    const result = await backend.execute(
      "owner",
      { command: "echo credential-marker", cwd: "/workspace" },
      { idempotencyKey: "operation" },
    );
    await backend.execute(
      "owner",
      { command: "echo credential-marker", cwd: "/workspace" },
      { idempotencyKey: "operation" },
    );
    assert.equal(result.status, "succeeded");
    const filesAdapter = fixture({
      command: async () => ok(JSON.stringify({ path: "/workspace", entries: [] })),
    });
    const fileBackend = auditedComputer(
      new ComputerService(db, config, filesAdapter.runner),
      new ActionLog(db),
    );
    await fileBackend.list("owner", "/workspace");
    await assert.rejects(backend.read("owner", "/outside"));
    const page = await db.actionLog("owner", 200);
    assert.equal(page.entries.filter((e) => e.tool === "computer.command").length, 2);
    assert.ok(page.entries.some((e) => e.tool === "computer.read" && e.result === "failed"));
    assert.equal(JSON.stringify(page).includes("credential-marker"), false);
    const first = await db.actionLog("owner", 2);
    assert.equal(first.entries.length, 2);
    assert.ok(first.nextCursor);
    const next = await db.actionLog("owner", 2, first.nextCursor);
    assert.equal(
      next.entries.some((e) => first.entries.some((p) => p.id === e.id)),
      false,
    );
  } finally {
    await db.close();
  }
});

test("automatic document reply finishes from receipt; application sample still requires its scripted reviews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auto-document-"));
  const db = await createStore();
  const server = await createApp(db, {
    ...config,
    dataDir: directory,
    computerEnabled: false,
    intelligenceApiKey: undefined,
  });
  const owner = "document-owner";
  let autonomous: AgentService | undefined;
  try {
    await server.workspace.ensureSample(owner, server.actions);
    assert.ok(
      (await db.list("document-owner", "actions")).some(
        (action) => action.status === "awaiting_review",
      ),
    );
    const workspace = server.workspace;
    const actions = new ActionService(db, {
      policy: "money",
      connected: (owner) => workspace.connected(owner),
      connection: (owner) => workspace.connection(owner),
      prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
      execute: (owner, input, connectionId, targetVersion) =>
        workspace.execute(owner, input, connectionId, targetVersion),
    });
    autonomous = new AgentService(
      db,
      { ...config, dataDir: directory },
      workspace,
      server.files,
      actions,
      server.agent.browser,
      server.computer,
    );
    const mail = (await workspace.snapshot(owner)).mail.find((mail) => mail.attachments.length);
    assert.ok(mail);
    const task = await autonomous.createTask(owner, {
      kind: "document",
      prompt: "Return completed school form",
      input: {
        messageId: mail.id,
        fields: {
          participant_name: "Student",
          guardian_name: "Guardian",
          permission_granted: true,
        },
      },
    });
    await autonomous.worker.tick();
    const finished = await autonomous.getTask(owner, task.id);
    assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
    assert.equal(finished.actionId, null);
    assert.ok(finished.result?.includes("local sent mail"));
    assert.equal(
      (await db.list<AgentTask>(owner, "tasks")).filter(
        (task) => task.status === "waiting_approval",
      ).length,
      0,
    );
    assert.equal(
      (await workspace.snapshot(owner)).mail.filter((mail) => mail.subject.startsWith("Re:"))
        .length,
      1,
    );
    await autonomous.worker.tick();
    assert.equal(
      (await workspace.snapshot(owner)).mail.filter((mail) => mail.subject.startsWith("Re:"))
        .length,
      1,
    );
  } finally {
    await autonomous?.stop();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
