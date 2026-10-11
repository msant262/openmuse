import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { ActionLog } from "./action-log.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { warmOpenclawHarness } from "./engine/openclaw-agent.ts";
import { startModelTokenMaintenance } from "./providers/maintenance.ts";
import { RequestDrain, shutdownServer } from "./shutdown.ts";
import { LocalThreads } from "./threads.ts";

let previousStartupMs = 0;
const startupCheckpoint = (phase: string) => {
  const elapsedMs = Math.round(process.uptime() * 1000);
  console.info(
    "[startup]",
    JSON.stringify({
      phase,
      elapsedMs,
      phaseMs: elapsedMs - previousStartupMs,
      rssBytes: process.memoryUsage().rss,
    }),
  );
  previousStartupMs = elapsedMs;
};
startupCheckpoint("modules-loaded");
const config = readConfig();
startupCheckpoint("configuration-read");
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
startupCheckpoint("store-ready");
await db.recoverInterruptedActions();
startupCheckpoint("interrupted-actions-recovered");
await new ActionLog(db).reconcile(true);
startupCheckpoint("actions-reconciled");
const { app, agent, actions, threads, executors, codexConnection } = await createApp(db, config);
startupCheckpoint("application-created");
if (config.agentBackend === "model") await warmOpenclawHarness(config.dataDir);
startupCheckpoint("harness-ready");
const stopTokenMaintenance = startModelTokenMaintenance(config);
if (config.taskWorkerEnabled) agent.start();
startupCheckpoint("background-services-started");
const requests = new RequestDrain();
const server = serve(
  {
    fetch: (request) => requests.fetch(app.fetch, request),
    port: config.port,
    hostname: config.host,
  },
  () => {
    startupCheckpoint("http-listening");
    console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`);
  },
) as Server;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    console.error("API shutdown timed out; database/action persistence is unconfirmed.");
    process.exit(1);
  }, 12000);
  try {
    await shutdownServer(
      server,
      requests,
      () => {
        executors.stopDispatch();
        return Promise.all([
          threads instanceof LocalThreads ? threads.close() : Promise.resolve(),
          agent.stop(),
          actions.close(),
          stopTokenMaintenance(),
          codexConnection.close(),
        ]);
      },
      async () => {
        // REST handlers may settle after the work drains; check their writes too.
        if (db.persistenceFailed) throw new Error("Database persistence is unconfirmed");
        await db.close();
      },
    );
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    clearTimeout(deadline);
    console.error("API shutdown failed; backup must not copy its data.");
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
