// Isolated sample API used only by the local Android smoke script.
import { writeFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";

const directory = process.env.ANDROID_SMOKE_DATA;
if (!directory) throw new Error("ANDROID_SMOKE_DATA is required");
const port = Number(process.env.ANDROID_SMOKE_PORT ?? 8787);
const db = await createStore({ dataDir: `${directory}/postgres` });
const service = await createApp(db, {
  mode: "sample",
  agentBackend: "sample",
  host: "127.0.0.1",
  port,
  publicUrl: `http://127.0.0.1:${port}`,
  dataDir: directory,
  googleRedirectUri: `http://127.0.0.1:${port}/api/google/callback`,
  allowedOrigins: [],
  computerEnabled: false,
  proactivityEnabled: false,
});
service.agent.start();
let pairRequests = 0;
let workspaceReads = 0;
const server = serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/session" && request.method === "POST") pairRequests++;
    if (path === "/api/workspace" && request.method === "GET") workspaceReads++;
    return service.app.fetch(request);
  },
});
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return;
  stopping = true;
  await service.agent.stop();
  if ("close" in service.threads) await service.threads.close();
  await service.actions.close();
  await writeFile(
    `${directory}/server-summary.json`,
    JSON.stringify({ pairRequests, workspaceReads }),
  );
  await db.close();
  server.close(() => process.exit(0));
});
