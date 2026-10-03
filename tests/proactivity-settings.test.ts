import assert from "node:assert/strict";
import { test } from "node:test";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { fixture } from "./proactivity-fixture.ts";

test("global pause persists and blocks new scans while allowing chat admission and inspection", async (t) => {
  const f = await fixture(t);
  assert.ok(f.server.agent.proactivity);
  await f.server.agent.setRuntimePause("local-user", { paused: true, expectedRevision: 0 });
  assert.equal(await f.server.agent.proactivity.scheduleDue("local-user", Date.now()), undefined);
  // Interactive chat admission is owned by the M2 inbox, independently of paused background work.
  const accepted = await f.server.inbox.acceptMessage("local-user", {
    threadId: "chat",
    clientMessageId: "paused-chat",
    text: "Status please",
    attachmentIds: [],
    contentHash: (await import("../apps/server/src/conversation-inbox.ts")).messageContentHash({
      text: "Status please",
      attachmentIds: [],
    }),
  });
  assert.ok(accepted.messageId);
  await f.restart();
  assert.equal(
    await f.server.agent.proactivity.scheduleDue("local-user", Date.now() + 86400000),
    undefined,
  );
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
  await f.server.agent.setRuntimePause("local-user", { paused: false, expectedRevision: 1 });
  assert.ok(await f.server.agent.proactivity.scheduleDue("local-user", Date.now()));
});

test("chat settings use a current authenticated source and a revision instead of connector instructions", async (t) => {
  const f = await fixture(t);
  const source = { messageId: "user-message", threadId: "chat", runId: "user-run" };
  await f.db.put("local-user", "conversation-inbox", {
    id: "chat:setting",
    ...source,
    text: "Revise meus e-mails a cada 2 horas",
    status: "finished",
  });
  const tools = personalTools(f.server.agent, "local-user", "chat:test", { profileSource: source });
  assert.ok(
    tools.find((tool) => tool.name === "update_proactivity_settings"),
    "Chat must be connected to persisted heartbeat settings",
  );
  const saved = await f.server.agent.proactivity.settings.update(
    "local-user",
    { expectedRevision: 0, intervalHours: 2, requestId: "interval-two" },
    source,
  );
  assert.equal(saved.intervalHours, 2);
  await assert.rejects(
    () =>
      f.server.agent.proactivity.settings.update("local-user", {
        expectedRevision: 0,
        enabled: false,
        requestId: "stale-change",
      }),
    /changed|revision/,
  );
  await assert.rejects(
    () =>
      f.server.agent.proactivity.settings.update(
        "local-user",
        { expectedRevision: 1, intervalHours: 8, requestId: "source-forged" },
        source,
      ),
    /authenticated|explicit/,
  );
  await f.restart();
  assert.equal((await f.server.agent.proactivity.settings.get("local-user")).intervalHours, 2);
});
