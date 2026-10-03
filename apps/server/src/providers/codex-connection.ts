import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { codexDeviceLogin, codexStatus, disconnectCodex } from "./codex-auth.ts";
import type { ModelProviderConfig } from "./config.ts";

type Code = { url: string; code: string; expiresAt: number; intervalSeconds: number };
type Flow = {
  id: string;
  status: "starting" | "waiting" | "connected" | "cancelled" | "expired" | "error";
  url?: string;
  code?: string;
  expiresAt?: string;
  message?: string;
};
type ActiveFlow = {
  owner: string;
  public: Flow;
  abort: AbortController;
  done: Promise<void>;
  ready: Promise<void>;
};
type AuthOperations = {
  login: (file: string, onCode: (code: Code) => void, signal: AbortSignal) => Promise<void>;
  status: (file: string) => Promise<{ connected: boolean }>;
  disconnect: (file: string) => Promise<void>;
};

/** Device auth is ephemeral. Only the validated protected credential reaches disk. */
export class CodexConnection {
  private flow?: ActiveFlow;
  private disconnecting = false;
  private closed = false;
  private readonly file: string;
  private readonly operations: AuthOperations;
  constructor(providers: ModelProviderConfig, operations?: AuthOperations) {
    this.file = providers.codexFile ?? resolve(providers.authDir, "codex.json");
    this.operations = operations ?? {
      login: (file, onCode, signal) => codexDeviceLogin(file, onCode, {}, signal),
      status: codexStatus,
      disconnect: disconnectCodex,
    };
  }
  async status(owner: string) {
    const status = await this.operations.status(this.file).catch(() => ({
      connected: false,
      message: "The saved ChatGPT connection could not be read. Connect again to repair it.",
    }));
    const flow = this.flow?.owner === owner ? this.flow.public : undefined;
    return { ...status, ...(flow ? { flow: { ...flow } } : {}) };
  }
  async start(owner: string) {
    if (this.closed || this.disconnecting)
      throw new AppError("ChatGPT connection is busy. Try again.", 409);
    const existing = this.flow;
    if (existing && ["starting", "waiting"].includes(existing.public.status)) {
      if (existing.owner !== owner)
        throw new AppError("A ChatGPT connection is already in progress", 409);
      await existing.ready;
      return this.status(owner);
    }
    const abort = new AbortController();
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const active: ActiveFlow = {
      owner,
      public: { id: randomUUID(), status: "starting" },
      abort,
      ready,
      done: Promise.resolve(),
    };
    this.flow = active;
    const initialTimeout = setTimeout(() => abort.abort(), 30_000);
    active.done = this.operations
      .login(
        this.file,
        (code) => {
          if (abort.signal.aborted || this.flow !== active) return;
          // A malicious or misconfigured auth backend cannot turn the trusted link into arbitrary navigation.
          const url = new URL(code.url);
          if (url.origin !== "https://auth.openai.com" || url.username || url.password || url.hash)
            throw new Error("Unexpected device authorization destination");
          if (!Number.isFinite(code.expiresAt) || code.expiresAt <= Date.now())
            throw new Error("Device authorization is expired");
          clearTimeout(initialTimeout);
          active.public = {
            id: active.public.id,
            status: "waiting",
            url: url.href,
            code: code.code,
            expiresAt: new Date(code.expiresAt).toISOString(),
          };
          readyResolve();
        },
        abort.signal,
      )
      .then(() => {
        if (!abort.signal.aborted) active.public = { id: active.public.id, status: "connected" };
      })
      .catch(() => {
        // Auth protocol errors can contain private exchange details; never serialize them to the UI.
        const expired =
          active.public.expiresAt && Date.parse(active.public.expiresAt) <= Date.now();
        const status = abort.signal.aborted ? "cancelled" : expired ? "expired" : "error";
        active.public = {
          id: active.public.id,
          status,
          ...(status === "error"
            ? { message: "Could not connect ChatGPT. Start a new connection and try again." }
            : {}),
        };
      })
      .finally(() => {
        clearTimeout(initialTimeout);
        if (active.public.status === "connected") readyResolve();
        else if (active.public.status !== "waiting")
          readyReject(new AppError("ChatGPT connection was not completed. Try again.", 409));
      });
    await ready;
    return this.status(owner);
  }
  async cancel(owner: string, id: string) {
    const active = this.flow;
    if (!active || active.owner !== owner || active.public.id !== id)
      throw new AppError("ChatGPT connection request not found", 404);
    if (["starting", "waiting"].includes(active.public.status)) {
      active.abort.abort();
      await active.done;
      active.public = { id, status: "cancelled" };
    }
    return this.status(owner);
  }
  async disconnect(owner: string) {
    if (this.disconnecting) throw new AppError("ChatGPT disconnection is already in progress", 409);
    this.disconnecting = true;
    try {
      const active = this.flow;
      if (active && ["starting", "waiting"].includes(active.public.status)) {
        if (active.owner !== owner)
          throw new AppError("A ChatGPT connection is already in progress", 409);
        active.abort.abort();
        // Wait for the token exchange to settle before removing the protected file.
        await active.done;
      }
      await this.operations.disconnect(this.file);
      this.flow = undefined;
      return this.status(owner);
    } finally {
      this.disconnecting = false;
    }
  }
  async close() {
    this.closed = true;
    this.flow?.abort.abort();
    await this.flow?.done;
  }
}
export function codexConnectionRoutes(connection: CodexConnection) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/connections/codex", async (c) => c.json(await connection.status(c.get("owner"))));
  app.post("/connections/codex/start", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(await connection.start(c.get("owner")));
  });
  app.post("/connections/codex/cancel", async (c) => {
    const { flowId } = z
      .object({ flowId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(await connection.cancel(c.get("owner"), flowId));
  });
  app.post("/connections/codex/disconnect", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(await connection.disconnect(c.get("owner")));
  });
  return app;
}
