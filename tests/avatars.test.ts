import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentIdentity, AgentWorkspace } from "../packages/domain/src/agent.ts";
import {
  AVATAR_PRESETS,
  type AvatarDesign,
  avatarDesignSchema,
  DEFAULT_AVATAR_DESIGN,
  resolveAvatarDesign,
} from "../packages/domain/src/avatar.ts";

test("five 3D designs are bounded appearance data and old tint identities get a default character", () => {
  assert.deepEqual(
    AVATAR_PRESETS.map((design) => design.species),
    ["capybara", "wolf", "fox", "cat", "robot"],
  );
  for (const design of AVATAR_PRESETS) assert.deepEqual(avatarDesignSchema.parse(design), design);
  assert.deepEqual(resolveAvatarDesign(undefined), DEFAULT_AVATAR_DESIGN);
  assert.deepEqual(resolveAvatarDesign("lilac"), DEFAULT_AVATAR_DESIGN);
  assert.equal(DEFAULT_AVATAR_DESIGN.species, "capybara");
  for (const invalid of [
    { ...DEFAULT_AVATAR_DESIGN, script: "alert(1)" },
    { ...DEFAULT_AVATAR_DESIGN, assetUrl: "https://example.com/avatar.js" },
    { ...DEFAULT_AVATAR_DESIGN, bodyColor: "red; background:url(https://example.com)" },
    { ...DEFAULT_AVATAR_DESIGN, eyeColor: "#fff" },
    { ...DEFAULT_AVATAR_DESIGN, version: 2 },
    { ...DEFAULT_AVATAR_DESIGN, preset: "wolf", species: "fox" },
    { ...DEFAULT_AVATAR_DESIGN, accessory: "untrusted" },
  ])
    assert.equal(avatarDesignSchema.safeParse(invalid).success, false);
});

test("custom 3D appearance edits persist across restart, remain owner scoped and preserve canonical profile history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-avatars-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  let server = await createApp(db, config);
  try {
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    const request = (path: string, body?: unknown) =>
      server.app.request(`/api/agent${path}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
    await server.agent.profiles.update("local-user", {
      scope: { kind: "global" },
      expectedRevision: 0,
      requestId: "avatar-profile-boundary",
      origin: { kind: "settings" },
      patch: { assistantName: "Luna", tone: "thoughtful", language: "pt-BR" },
    });
    const before = await server.agent.profiles.get("local-user");
    await server.agent.ensure("other-owner");
    const otherBefore = await db.get("other-owner", "agent-settings", "identity");
    const custom: AvatarDesign = {
      version: 1,
      preset: "custom",
      species: "wolf",
      bodyShape: "slender",
      bodyColor: "#9876AB",
      accentColor: "#FCEDCC",
      eyeColor: "#64BCDD",
      accessory: "glasses",
    };
    const saved = await request("/identity", {
      avatarDesign: custom,
      avatar: "lilac",
      showChatUpdates: false,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(((await saved.json()) as AgentIdentity).avatarDesign, custom);
    const snapshot = (await (await request("")).json()) as AgentWorkspace;
    assert.deepEqual(snapshot.identity.avatarDesign, custom);
    assert.equal(snapshot.identity.name, "Luna");
    assert.equal(snapshot.identity.tone, "thoughtful");
    assert.equal(snapshot.identity.avatar, "lilac");
    assert.equal(snapshot.identity.showChatUpdates, false);
    assert.deepEqual(await server.agent.profiles.get("local-user"), before);
    assert.deepEqual(await db.get("other-owner", "agent-settings", "identity"), otherBefore);
    const rejected = await request("/identity", {
      avatarDesign: { ...custom, assetUrl: "https://example.org/a.js" },
    });
    assert.equal(rejected.status, 422);
    assert.deepEqual(
      ((await (await request("")).json()) as AgentWorkspace).identity.avatarDesign,
      custom,
    );
    await server.agent.stop();
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    server = await createApp(db, config);
    const restarted = await server.agent.snapshot("local-user");
    assert.deepEqual(restarted.identity.avatarDesign, custom);
    assert.equal(restarted.identity.profile?.revisions.global, before.revisions.global);
    const edited = {
      ...custom,
      species: "fox" as const,
      bodyShape: "round" as const,
      accessory: "headphones" as const,
      bodyColor: "#ABCDEF",
    };
    const edit = await request("/identity", { avatarDesign: edited });
    assert.equal(edit.status, 200);
    assert.deepEqual((await server.agent.snapshot("local-user")).identity.avatarDesign, edited);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
