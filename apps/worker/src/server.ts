import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createBrowserManager, validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";
import { BrowserExecutorGate } from "./executor-gate.ts";

const bodies = new WeakMap<IncomingMessage, { raw: string; body: Record<string, unknown> }>();
async function readBody(
  request: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const cached = bodies.get(request);
  if (cached) return cached.body;
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new WorkerError("INVALID_BODY", "A JSON request body is required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes)
      throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds its operation limit.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    const result: unknown = JSON.parse(raw);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    bodies.set(request, { raw, body: result as Record<string, unknown> });
    return result as Record<string, unknown>;
  } catch {
    throw new WorkerError("INVALID_BODY", "A JSON object is required.");
  }
}

function requiredUrl(body: Record<string, unknown>): string {
  if (typeof body.url !== "string" || body.url.length > 8192)
    throw new WorkerError("INVALID_URL", "A URL of at most 8192 characters is required.");
  return body.url;
}

export async function createWorkerServer(options: {
  token: string;
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  searchEndpoint?: string;
  executorId?: string;
  requireBinding?: boolean;
}) {
  if (options.token.length < 32)
    throw new Error("WORKER_TOKEN must contain at least 32 characters.");
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const browser = await createBrowserManager(options);
  const executorId = options.executorId ?? "openmuse-server",
    instanceId = randomUUID();
  const gate = new BrowserExecutorGate({
    token: options.token,
    dataDir: options.dataDir,
    executorId,
    instanceId,
  });
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://worker").pathname;
      if (request.method === "GET" && pathname === "/health") {
        respond(200, { status: "ok" });
        return;
      }
      const headerHash = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(headerHash, tokenHash))
        throw new WorkerError("UNAUTHORIZED", "Worker authentication is required.", 401);
      if (pathname === "/executor" && request.method === "GET") {
        respond(200, {
          executorId,
          instanceId,
          minProtocolVersion: 1,
          maxProtocolVersion: 1,
          capabilities: [
            { name: "browser.dom", version: 1 },
            { name: "browser.screenshot", version: 1 },
          ],
        });
        return;
      }
      const execute = async () => {
        let result: { status: number; data: unknown } = { status: 200, data: null };
        const json = (status: number, data: unknown) => {
          result = { status, data };
        };
        if (pathname === "/sessions" && request.method === "GET") {
          json(200, browser.list());
          return result;
        }
        if (["/sessions", "/sessions/human"].includes(pathname) && request.method === "POST") {
          const body = await readBody(request);
          json(
            201,
            await browser.create(
              validateSessionId(body.id),
              requiredUrl(body),
              pathname !== "/sessions/human",
            ),
          );
          return result;
        }
        const match =
          /^\/sessions\/([^/]+)\/(navigate|agent-navigate|back|close|screenshot|agent-screenshot|snapshot|images|act|inspect|reviewed-act|control|read|input|downloads|credentials|credential-challenge|challenge|search|upload)(?:\/([^/]+))?$/.exec(
            pathname,
          );
        if (!match) throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
        const id = validateSessionId(match[1]);
        const action = match[2];
        const downloadId = match[3];
        if (action === "navigate" && !downloadId && request.method === "POST")
          json(200, await browser.navigate(id, requiredUrl(await readBody(request)), false));
        else if (action === "agent-navigate" && !downloadId && request.method === "POST")
          json(200, await browser.navigate(id, requiredUrl(await readBody(request))));
        else if (action === "back" && !downloadId && request.method === "POST")
          json(200, await browser.back(id));
        else if (action === "snapshot" && !downloadId && request.method === "GET")
          json(200, await browser.snapshot(id));
        else if (action === "agent-screenshot" && !downloadId && request.method === "GET")
          json(200, await browser.agentScreenshot(id));
        else if (action === "inspect" && !downloadId && request.method === "POST")
          json(200, await browser.inspect(id, await readBody(request)));
        else if (action === "reviewed-act" && !downloadId && request.method === "POST") {
          const body = await readBody(request);
          if (Object.keys(body).some((key) => key !== "authorization"))
            throw new WorkerError("INVALID_APPROVAL", "Unsupported approval fields.", 403);
          json(200, await browser.reviewedAct(id, body.authorization));
        } else if (action === "act" && !downloadId && request.method === "POST")
          json(200, await browser.act(id, await readBody(request)));
        else if (action === "upload" && !downloadId && request.method === "POST")
          json(200, await browser.upload(id, await readBody(request, 7 * 1024 * 1024)));
        else if (action === "images" && !downloadId && request.method === "POST")
          json(200, await browser.images(id, await readBody(request)));
        else if (action === "search" && !downloadId && request.method === "POST")
          json(200, await browser.search(id, await readBody(request)));
        else if (action === "challenge" && !downloadId && request.method === "POST")
          json(200, await browser.challenge(id, await readBody(request)));
        else if (action === "control" && !downloadId && request.method === "GET")
          json(200, await browser.control(id));
        else if (action === "control" && !downloadId && request.method === "POST") {
          const body = await readBody(request);
          if (body.control !== "agent" && body.control !== "human")
            throw new WorkerError("INVALID_CONTROL", "Control must be agent or human.");
          json(200, await browser.setControl(id, body.control));
        } else if (action === "close" && !downloadId && request.method === "POST")
          json(200, await browser.closeSession(id));
        else if (action === "input" && !downloadId && request.method === "POST")
          json(200, await browser.input(id, await readBody(request)));
        else if (action === "read" && !downloadId && request.method === "GET")
          json(200, await browser.read(id));
        else if (action === "credentials" && !downloadId && request.method === "POST")
          json(200, await browser.credentials(id, await readBody(request)));
        else if (action === "credential-challenge" && !downloadId && request.method === "POST")
          json(200, await browser.credentials(id, await readBody(request)));
        else if (action === "screenshot" && !downloadId && request.method === "GET") {
          const bytes = await browser.screenshot(id);
          response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
          response.end(bytes);
        } else if (action === "downloads" && request.method === "GET") {
          if (!downloadId) json(200, await browser.downloads(id));
          else {
            const result = await browser.download(id, downloadId);
            response.writeHead(200, {
              "content-type": result.metadata.mimeType,
              "content-length": result.bytes.length,
              "content-disposition": `attachment; filename="${result.metadata.name}"`,
            });
            response.end(result.bytes);
          }
        } else throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
        return result;
      };
      const encoded = request.headers["x-openmuse-browser-authority"];
      if (options.requireBinding && typeof encoded !== "string")
        throw new WorkerError(
          "INVALID_BROWSER_AUTHORITY",
          "Hybrid browser requests require bound authority.",
          409,
        );
      let result: { status: number; data: unknown };
      if (typeof encoded === "string") {
        const body =
          request.method === "POST"
            ? await readBody(request, pathname.endsWith("/upload") ? 7 * 1024 * 1024 : 64 * 1024)
            : undefined;
        const id = validateSessionId(body?.id ?? /^\/sessions\/([^/]+)/.exec(pathname)?.[1]);
        result = await gate.run(
          encoded,
          {
            sessionId: id,
            method: request.method ?? "GET",
            path: pathname,
            body: bodies.get(request)?.raw ?? "",
          },
          execute,
        );
      } else result = await execute();
      if (!response.headersSent) respond(result.status, result.data);
    } catch (error) {
      const safe =
        error instanceof WorkerError
          ? error
          : new WorkerError(
              "WORKER_FAILURE",
              "The browser operation failed. Check worker health and reopen the session.",
              500,
            );
      if (!response.headersSent && !response.destroyed)
        respond(safe.status, {
          error: { code: safe.code, message: safe.message, details: safe.details },
        });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
    },
  };
}
