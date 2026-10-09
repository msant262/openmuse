import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { nativeDownloadLimit } from "../../../packages/domain/src/browser-file.ts";
import { createBrowserManager } from "./browser.ts";
import { WorkerError } from "./errors.ts";
import { type NativeBrowserConfig, nativeLaunchOptions } from "./native-config.ts";

type Envelope = {
  executorEpoch: number;
  expiresAt: string;
  resourceFence: number;
  args: {
    sessionGeneration: string;
    browserSessionId: string;
    controlRevision: number;
    operation: string;
    body: Record<string, unknown>;
  };
};
const configuration: Buffer[] = [];
let configurationBytes = 0;
for await (const chunk of process.stdin) {
  configurationBytes += chunk.length;
  if (configurationBytes > 16_384) throw new Error("Native browser configuration exceeds limit");
  configuration.push(Buffer.from(chunk));
}
const config = JSON.parse(Buffer.concat(configuration).toString("utf8")) as {
  socket: string;
  token: string;
  dataDir: string;
  native: NativeBrowserConfig;
};
if (!config.socket.startsWith(`${config.native.runtime}/`) || !/^[a-f0-9]{64}$/.test(config.token))
  throw new Error("Invalid private native browser configuration");
const preflightDirectory = await mkdtemp(join(tmpdir(), "okami-browser-preflight-"));
try {
  const context = await chromium.launchPersistentContext(preflightDirectory, {
    ...nativeLaunchOptions(config.native),
    // Chromium exposes Browser.getBrowserCommandLine only with this switch.
    // Pin it in the isolated preflight instead of relying on Playwright defaults.
    args: ["--enable-automation"],
    timeout: 25_000,
  });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const command = (await cdp.send("Browser.getBrowserCommandLine")) as { arguments: string[] };
    if (
      command.arguments.includes("--no-sandbox") ||
      !command.arguments.includes("--remote-debugging-pipe")
    )
      throw new Error("Native browser sandbox/CDP pipe preflight failed");
    await page.goto("chrome://sandbox");
    const sandbox = await page.locator("body").innerText();
    if (!/adequately sandboxed/i.test(sandbox) || !/Seccomp-BPF/i.test(sandbox))
      throw new Error("Native Chromium sandbox is unavailable");
  } finally {
    await context.close();
  }
} finally {
  await rm(preflightDirectory, { recursive: true, force: true });
}
const scope = new AsyncLocalStorage<Envelope>();
let epoch = 0,
  gateOpen = false,
  reconciled = false,
  gateDeadline = 0,
  revision = 0,
  control: "agent" | "human" = "agent",
  fence = 0;
function guard() {
  const operation = scope.getStore();
  if (
    !operation ||
    !gateOpen ||
    !reconciled ||
    performance.now() >= gateDeadline ||
    operation.executorEpoch !== epoch ||
    operation.args.controlRevision !== revision ||
    operation.args.sessionGeneration !== config.native.sessionGeneration ||
    operation.args.browserSessionId !== config.native.sessionId ||
    operation.resourceFence < fence ||
    Date.parse(operation.expiresAt) <= Date.now() ||
    control !== "agent"
  )
    throw new WorkerError("BROWSER_CONTROLLED", "Native browser input authority changed", 409, {
      sessionId: config.native.sessionId,
    });
  fence = operation.resourceFence;
}
const MAX = 12 * 1024 * 1024;
async function protect(
  masks: [number, number, number, number][],
  state: { suspended: boolean; screenOffset?: { x: number; y: number; scale: number } },
) {
  const width = config.native.width ?? 1280,
    height = config.native.height ?? 720,
    offset = state.screenOffset;
  const valid =
    offset &&
    [offset.x, offset.y, offset.scale].every(Number.isFinite) &&
    offset.scale > 0 &&
    offset.scale <= 4;
  const rectangles =
    masks.length && !valid
      ? [[0, 0, width, height]]
      : masks
          .map(([x, y, w, h]) => {
            const left = Math.max(0, Math.floor((offset!.x + x) * offset!.scale)),
              top = Math.max(0, Math.floor((offset!.y + y) * offset!.scale));
            return [
              left,
              top,
              Math.min(width - left, Math.ceil(w * offset!.scale) + 2),
              Math.min(height - top, Math.ceil(h * offset!.scale) + 2),
            ];
          })
          .filter(([x, y, w, h]) => x < width && y < height && w > 0 && h > 0);
  const payload = Buffer.from(
    JSON.stringify({
      operation: "protect",
      token: config.token,
      sessionId: config.native.sessionId,
      sessionGeneration: config.native.sessionGeneration,
      masks: rectangles,
      suspended: state.suspended,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(`${config.native.runtime}/desktop.sock`);
    let buffer = Buffer.alloc(0),
      expected = 0;
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("Native protection acknowledgement timed out")),
    );
    socket.once("connect", () => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(payload.length);
      socket.write(Buffer.concat([size, payload]));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX + 4) {
        socket.destroy(new Error("Native protection response exceeds limit"));
        return;
      }
      if (!expected && buffer.length >= 4) expected = buffer.readUInt32BE();
      if (!expected || expected > MAX || buffer.length < expected + 4) return;
      try {
        const reply = JSON.parse(buffer.subarray(4, expected + 4).toString());
        if (reply.data?.protected !== true) throw new Error("Native protection unavailable");
        socket.end();
        resolve();
      } catch {
        socket.destroy(new Error("Native protection unavailable"));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!expected || buffer.length < expected + 4)
        reject(new Error("Native protection acknowledgement was lost"));
    });
  });
}
const browser = await createBrowserManager({
  dataDir: config.dataDir,
  maxSessions: 1,
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  native: config.native,
  beforeEffect: guard,
  protect,
});
type ProtectedBrowser = {
  credentials?: (id: string, input: unknown) => Promise<Record<string, unknown>>;
  refreshProtection?: (id: string) => Promise<unknown>;
};
async function handle(raw: Record<string, unknown>): Promise<unknown> {
  const token = typeof raw.token === "string" ? Buffer.from(raw.token) : Buffer.alloc(0),
    expected = Buffer.from(config.token);
  if (token.length !== expected.length || !timingSafeEqual(token, expected))
    throw new WorkerError("UNAUTHORIZED", "Private browser broker authentication required", 403);
  if (raw.operation === "status")
    return { state: "ready", reason: "Headed Chromium sandbox and CDP pipe verified" };
  if (raw.operation === "refresh-protection") {
    const hook = (browser as ProtectedBrowser).refreshProtection;
    if (!hook)
      throw new WorkerError(
        "PROTECTION_UNAVAILABLE",
        "Native sensitive region refresh is unavailable",
        503,
      );
    await hook(config.native.sessionId);
    return { protected: true };
  }
  if (raw.operation === "gate") {
    const gate = raw.gate as { epoch: number; open: boolean; reconciled: boolean; ttl: number };
    if (
      !Number.isSafeInteger(gate.epoch) ||
      gate.epoch < 1 ||
      !(gate.ttl > 0 && gate.ttl <= 2) ||
      typeof gate.open !== "boolean" ||
      typeof gate.reconciled !== "boolean"
    )
      throw new WorkerError("INVALID_GATE", "Invalid native browser gate permit");
    epoch = gate.epoch;
    gateOpen = gate.open;
    reconciled = gate.reconciled;
    gateDeadline = performance.now() + gate.ttl * 1000;
    if (!gateOpen && browser.list().some((value) => value.id === config.native.sessionId))
      await browser.resetInput(config.native.sessionId);
    return { accepted: true };
  }
  if (raw.operation === "reset") {
    if (
      (raw.control !== "agent" && raw.control !== "human") ||
      !Number.isSafeInteger(raw.controlRevision) ||
      Number(raw.controlRevision) <= revision
    )
      throw new WorkerError("INVALID_CONTROL", "Native control revision is stale", 409);
    control = raw.control;
    revision = Number(raw.controlRevision);
    if (browser.list().some((value) => value.id === config.native.sessionId)) {
      await browser.resetInput(config.native.sessionId);
      await browser.setControl(config.native.sessionId, control);
    }
    return { reset: true, cleanupConfirmed: true };
  }
  if (raw.operation !== "perform")
    throw new WorkerError("INVALID_INPUT", "Unsupported private browser operation");
  const operation = raw.envelope as Envelope;
  if (
    !operation ||
    operation.args.sessionGeneration !== config.native.sessionGeneration ||
    operation.args.browserSessionId !== config.native.sessionId ||
    operation.executorEpoch !== epoch ||
    !reconciled ||
    performance.now() >= gateDeadline
  )
    throw new WorkerError("STALE_SESSION", "Native browser generation/epoch is stale", 409);
  return scope.run(operation, async () => {
    const id = config.native.sessionId,
      body = operation.args.body;
    switch (operation.args.operation) {
      case "open":
        return browser.create(id, String(body.url), true);
      case "snapshot":
        return browser.snapshot(id);
      case "back":
        return browser.back(id);
      case "search":
        return browser.search(id, body);
      case "read":
        return browser.read(id);
      case "inspect":
        return browser.inspect(id, body);
      case "act":
        return browser.act(id, body);
      case "agent-screenshot":
        return browser.agentScreenshot(id);
      case "screenshot":
        return {
          image: (await browser.screenshot(id)).toString("base64"),
          mimeType: "image/png",
          width: config.native.width ?? 1280,
          height: config.native.height ?? 720,
        };
      case "control":
        return browser.control(id);
      case "close":
        guard();
        return browser.closeSession(id);
      case "upload":
        return browser.upload(id, body);
      case "downloads":
        return browser.downloads(id);
      case "challenge":
        return browser.challenge(id, body);
      case "download": {
        const result = await browser.download(id, String(body.downloadId));
        if (result.bytes.length > nativeDownloadLimit)
          throw new WorkerError(
            "DOWNLOAD_TOO_LARGE",
            "Native browser transfer exceeds 8 MiB.",
            413,
          );
        return { ...result.metadata, base64: result.bytes.toString("base64") };
      }
      case "credentials": {
        guard();
        const inject = (browser as ProtectedBrowser).credentials;
        if (!inject)
          throw new WorkerError(
            "PROTECTION_UNAVAILABLE",
            "Native credential helper is unavailable",
            503,
          );
        const result = await inject(id, body);
        return { ...result, sessionGeneration: config.native.sessionGeneration };
      }
      default:
        throw new WorkerError("INVALID_INPUT", "Unsupported native browser operation");
    }
  });
}
const server = createServer((connection) => {
  let buffer = Buffer.alloc(0),
    expected = 0,
    finished = false;
  connection.setTimeout(45_000, () => connection.destroy());
  connection.on("data", (chunk) => {
    if (finished) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX + 4) {
      finished = true;
      connection.destroy();
      return;
    }
    if (!expected && buffer.length >= 4) {
      expected = buffer.readUInt32BE();
      if (!expected || expected > MAX) {
        finished = true;
        connection.destroy();
        return;
      }
    }
    if (!expected || buffer.length < expected + 4) return;
    finished = true;
    const respond = (result: Record<string, unknown>) => {
      const bytes = Buffer.from(JSON.stringify(result));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(bytes.length);
      connection.end(Buffer.concat([prefix, bytes]));
    };
    void (async () => {
      try {
        respond({
          data: await handle(JSON.parse(buffer.subarray(4, expected + 4).toString("utf8"))),
        });
      } catch (error) {
        respond({
          error: {
            message: "Native browser operation failed",
            code: error instanceof WorkerError ? error.code : "BROWSER_FAILED",
            dispatched: true,
            cleanupConfirmed: false,
          },
        });
      }
    })();
  });
  connection.on("error", () => {});
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.socket, resolve);
});
await chmod(config.socket, 0o600);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  gateOpen = false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await browser.close();
  await rm(config.socket, { force: true });
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
