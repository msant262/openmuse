import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { LocalThreads } from "../apps/server/src/threads.ts";
import type { AgentNotification, AgentTask, Routine } from "../packages/domain/src/agent.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

test("natural-language tools save memory and a routine; real worker posts once after busy chat and restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-routine-integration-"));
  let db = await createStore({ dataDir: join(directory, "db") });
  const calls: { name: string; arguments: object }[] = [
    { name: "remember_fact", arguments: { text: "I prefer my agenda in Portuguese" } },
    {
      name: "manage_routine",
      arguments: {
        operation: "create",
        title: "Today's agenda",
        prompt: "Read my calendar and send today's agenda in Portuguese",
        cron: "0 8 * * 1-5",
        timezone: "Europe/Berlin",
      },
    },
  ];
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(directory),
    routineTimezone: "Europe/Berlin",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  let server = await createApp(db, config);
  try {
    const session = await (
      await server.app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const main = await (await server.app.request("/api/main-thread", { headers })).json();
    assert.equal((await server.app.request("/api/agent/routines")).status, 401);
    const threads = server.threads as LocalThreads;
    await lastValueFrom(
      threads
        .withOwner("local-user", () =>
          threads.run({
            threadId: main.threadId,
            agent: new ConversationAgent(config, server.agent, "local-user"),
            input: {
              threadId: main.threadId,
              runId: "setup",
              messages: [
                {
                  id: "user-setup",
                  role: "user",
                  content:
                    "Remember that I prefer Portuguese. Every weekday at 8 in Berlin send me today's agenda.",
                },
              ],
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
            },
          }),
        )
        .pipe(toArray()),
    );
    const routines = (await (await server.app.request("/api/agent/routines", { headers })).json())
      .routines as Routine[];
    assert.equal(routines.length, 1);
    assert.equal(routines[0].timezone, "Europe/Berlin");
    const edit = async (patch: object) => {
      const response = await server.app.request(`/api/agent/routines/${routines[0].id}`, {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      assert.equal(response.status, 200);
      return server.agent.routines.get("local-user", routines[0].id);
    };
    assert.equal((await edit({ enabled: false })).enabled, false);
    assert.equal(
      (
        await edit({
          title: "Today's edited agenda",
          prompt: routines[0].prompt,
          cron: routines[0].cron,
          timezone: routines[0].timezone,
        })
      ).enabled,
      false,
    );
    assert.equal((await edit({ title: "Agent partial rename" })).enabled, false);
    assert.equal((await edit({ enabled: true })).enabled, true);
    assert.equal((await server.agent.memory.recall("local-user", "Portuguese")).length, 1);
    await db.compareAndSwap(
      "local-user",
      "routines",
      routines[0].id,
      {},
      { nextRunAt: new Date(Date.now() - 1000).toISOString() },
    );
    await db.claimThread("local-user", main.threadId, "phone-chat", 60000);
    await server.agent.routineTick();
    const tasks = await db.list<AgentTask>("local-user", "tasks");
    assert.equal(tasks.length, 1);
    calls.splice(
      0,
      calls.length,
      { name: "read_workspace", arguments: { section: "calendar" } },
      { name: "finish_task", arguments: { summary: "Today's agenda is ready in Portuguese" } },
    );
    requests.length = 0;
    await server.agent.worker.tick();
    assert.equal((await server.agent.getTask("local-user", tasks[0].id)).status, "succeeded");
    assert.match(requests[0].body, /I prefer my agenda in Portuguese/);
    const publication = (
      await db.list<{ id: string; status: string }>("local-user", "thread-publications")
    )[0];
    assert.equal(publication.status, "pending");
    assert.equal((await db.list("local-user", "notifications")).length, 0);
    const dispatched = requests.length;
    await server.agent.stop();
    await db.close();
    db = await createStore({ dataDir: join(directory, "db") });
    server = await createApp(db, config);
    await db.compareAndSwap(
      "local-user",
      "threads",
      main.threadId,
      { runToken: "phone-chat" },
      { runToken: null, leaseUntil: null },
    );
    // Reconstruct the exact crash boundary after posting but before creating a notice.
    await (server.threads as LocalThreads).appendBackground(
      "local-user",
      main.threadId,
      publication.id,
      "Today's agenda is ready in Portuguese",
    );
    await db.compareAndSwap(
      "local-user",
      "thread-publications",
      publication.id,
      {},
      { status: "posted" },
    );
    await server.agent.routineTick();
    await server.agent.routineTick();
    await server.agent.worker.tick();
    assert.equal(
      requests.length,
      dispatched,
      "recovery must publish without re-running the model or tools",
    );
    const history = await (server.threads as LocalThreads).history("local-user", main.threadId);
    assert.equal(
      history.messages.filter(
        (m) => m.role === "assistant" && m.content === "Today's agenda is ready in Portuguese",
      ).length,
      1,
    );
    const notifications = await db.list<{ nativeDelivery: string }>("local-user", "notifications");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].nativeDelivery, "not_configured");
    const originalNotice = (await db.list<AgentNotification>("local-user", "notifications"))[0];
    await db.compareAndSwap("local-user", "notifications", originalNotice.id, {}, { read: true });
    await server.agent.push.register("local-user", {
      installationId: "phone",
      platform: "ios",
      token: "a".repeat(64),
    });
    await server.agent.push.register("local-user", {
      installationId: "phone",
      platform: "ios",
      token: "b".repeat(64),
    });
    await server.agent.push.register("local-user", {
      installationId: "new-phone",
      platform: "ios",
      token: "c".repeat(64),
    });
    // Maintenance revisits terminal tasks; the frozen original intent stays empty.
    await db.compareAndSwap(
      "local-user",
      "thread-publications",
      publication.id,
      {},
      {
        notificationSent: false,
      },
    );
    await server.agent.routineTick();
    assert.deepEqual(
      (await db.get<{ targets: unknown[] }>("local-user", "push-intents", originalNotice.id))
        ?.targets,
      [],
    );
    assert.equal((await db.list("local-user", "push-deliveries")).length, 0);
    assert.equal(
      (await db.get<AgentNotification>("local-user", "notifications", originalNotice.id))?.read,
      true,
    );
    assert.ok(
      (await db.searchThreads("local-user", "agenda", 20, false)).some((match) =>
        String(match.excerpt).includes("agenda is ready"),
      ),
    );
    assert.deepEqual(await db.searchThreads("other", "agenda", 20, false), []);
    const fact = (await server.agent.memory.recall("local-user", "Portuguese"))[0];
    await server.agent.memory.forget("local-user", fact.id);
    assert.deepEqual(await server.agent.memory.recall("local-user", "Portuguese"), []);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
