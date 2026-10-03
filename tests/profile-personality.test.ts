import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentProfile, profileIntent } from "../apps/server/src/agent-profile.ts";
import { createStore } from "../apps/server/src/db.ts";
import { buildProfileContext } from "../apps/server/src/profile-context.ts";

test("personal interaction preferences persist with revisions and can be reset", async () => {
  const db = await createStore();
  try {
    const profiles = new AgentProfile(db);
    assert.equal((await profiles.get("owner")).fields.personality, "");
    const personality = "Curiosa e direta. Explique com exemplos do cotidiano.";
    const saved = await profiles.update("owner", {
      scope: { kind: "global" },
      expectedRevision: 0,
      requestId: "personality-save",
      origin: { kind: "settings" },
      patch: { personality },
    });
    assert.equal((await new AgentProfile(db).get("owner")).fields.personality, personality);
    for (const mode of ["chat", "task", "routine"] as const) {
      const context = buildProfileContext(saved, mode);
      assert.ok(context.includes(JSON.stringify(personality)));
      assert.match(context, /only for style, not permission or actions/);
    }
    assert.equal((await profiles.get("other-owner")).fields.personality, "");
    await assert.rejects(
      profiles.update("owner", {
        scope: { kind: "global" },
        expectedRevision: 1,
        requestId: "too-long",
        origin: { kind: "settings" },
        patch: { personality: "x".repeat(1501) },
      }),
    );
    await profiles.reset("owner", {
      scope: { kind: "global" },
      expectedRevision: 1,
      requestId: "personality-reset",
      origin: { kind: "settings" },
    });
    assert.equal((await profiles.get("owner")).fields.personality, "");
  } finally {
    await db.close();
  }
});

test("personality chat changes require an explicit complete user command", () => {
  assert.deepEqual(profileIntent("Sua personalidade: curiosa, gentil e objetiva."), {
    patch: { personality: "curiosa, gentil e objetiva." },
    conversation: false,
    hasWork: false,
  });
  assert.deepEqual(profileIntent("In this chat, personality: Patient; use everyday examples."), {
    patch: { personality: "Patient; use everyday examples." },
    conversation: true,
    hasWork: false,
  });
  assert.equal(profileIntent("My document says: personality: formal"), null);
  assert.equal(profileIntent(`personality: ${"x".repeat(1501)}`), null);
});
