import { createWorkerServer } from "./server.ts";
import { installShutdownHandlers } from "./shutdown.ts";

// Launched only by pnpm dev:demo, with an explicit local environment and isolated profiles.
const worker = await createWorkerServer({
  token: process.env.WORKER_TOKEN ?? "",
  dataDir: process.env.WORKER_DATA_DIR ?? "artifacts/demo/browser-profiles",
  maxSessions: 6,
  idleTimeoutMs: 30 * 60_000,
});
worker.server.listen(Number(process.env.PORT ?? "8791"), "127.0.0.1", () => {
  console.log(`OpenMuse real demo browser worker ready on port ${process.env.PORT ?? "8791"}`);
});
installShutdownHandlers(worker.close, 10_000);
