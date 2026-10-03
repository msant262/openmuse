import { createWorkerServer } from "./server.ts";
import { installShutdownHandlers } from "./shutdown.ts";

const token = process.env.WORKER_TOKEN ?? "";
const worker = await createWorkerServer({
  token,
  executorId: process.env.BROWSER_EXECUTOR_ID ?? "openmuse-server",
  requireBinding: process.env.BROWSER_REQUIRE_BINDING === "true",
  dataDir: process.env.WORKER_DATA_DIR ?? ".openmuse/browser-profiles",
  maxSessions: 3,
  idleTimeoutMs: 30 * 60_000,
});
worker.server.listen(8790, process.env.WORKER_HOST ?? "127.0.0.1", () => {
  console.log("OpenMuse browser worker listening on port 8790");
});
installShutdownHandlers(worker.close);
