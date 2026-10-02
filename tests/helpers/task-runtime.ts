import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createApp } from "../../apps/server/src/app.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { createStore } from "../../apps/server/src/db.ts";
import { richChatFixtureProviders } from "./model.ts";

export async function taskRuntime(t: TestContext, config: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "okami-task-runtime-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...(config.model === "openai/fixture" && {
      modelProviders: richChatFixtureProviders(directory),
    }),
    ...config,
  });
  t.after(async () => {
    if (server.threads && "close" in server.threads) await server.threads.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, db, directory };
}
