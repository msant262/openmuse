import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { BrowserAssets } from "./browser-assets.ts";
import { browserConsole } from "./browser-console.ts";
import { BrowserError, browserActionSchema, snapshotSchema } from "./browser-contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
  control: z.enum(["agent", "human"]).optional(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly assets: BrowserAssets;
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {
    this.assets = new BrowserAssets(db, config.dataDir);
  }
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new BrowserError(
        typeof payload?.error?.code === "string" ? payload.error.code : "BROWSER_FAILED",
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        response.status === 409 ? 409 : 502,
        typeof payload?.error?.details?.sessionId === "string"
          ? payload.error.details.sessionId
          : /^\/sessions\/([^/]+)/.exec(path)?.[1],
        payload?.error?.details,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string) {
    const id = (await this.defaultProfile(owner)).sessionId;
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url);
  }
  private async openOwned(
    owner: string,
    id: string,
    url?: string,
    signal?: AbortSignal,
    human = false,
  ) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.request(
        human ? "/sessions/human" : "/sessions",
        { id, url: target },
        signal,
      );
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "BROWSER_CONTROLLED") throw error;
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url, undefined, true));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (await this.request(`/sessions/${id}/read`, undefined, signal)).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string) {
    const id = existingId ?? (await this.agentSession(owner, undefined, url));
    return this.serial(id, async () => {
      if (existingId) await this.openOwned(owner, id, url);
      return { sessionId: id, ...(await this.readOwned(owner, id)) };
    });
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const old = await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId);
    const association = await this.defaultProfile(owner, old?.sessionId);
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    await this.db.put(owner, "chat-browsers", { id: threadId, sessionId: id });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  private async defaultProfile(owner: string, migratedId?: string): Promise<ChatBrowser> {
    const profile =
      (await this.db.get<ChatBrowser>(owner, "browser-default", "personal")) ??
      (await this.db.insertIfAbsent(owner, "browser-default", {
        id: "personal",
        sessionId: migratedId ?? randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "browser-default", "personal"));
    if (!profile) throw new AppError("Could not reserve the personal browser profile", 500);
    return profile;
  }
  async agentSession(owner: string, sessionId?: string, url?: string, signal?: AbortSignal) {
    const id = sessionId ?? (await this.defaultProfile(owner)).sessionId;
    if (sessionId) await this.get(owner, id);
    else
      await this.db.insertIfAbsent(owner, "browsers", {
        id,
        url: url ?? "https://example.com/",
        title: "Personal browser",
        status: "idle",
        control: "agent",
        updatedAt: new Date().toISOString(),
      });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      let saved = await this.get(owner, id);
      if (!url && saved.status === "active") saved = await this.control(owner, id);
      if (url || saved.status !== "active") await this.openOwned(owner, id, url, signal);
      return id;
    });
  }
  async snapshot(owner: string, id: string, signal?: AbortSignal) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const value = snapshotSchema.parse(
        await (await this.request(`/sessions/${id}/snapshot`, undefined, signal)).json(),
      );
      if (value.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "The browser returned a different session.");
      await this.save(
        owner,
        {
          id,
          title: value.title,
          url: value.url,
          status: "active",
          control: value.control,
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return value;
    });
  }
  async act(
    owner: string,
    id: string,
    action: z.infer<typeof browserActionSchema>,
    signal?: AbortSignal,
  ) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      const value = snapshotSchema.parse(
        await (
          await this.request(`/sessions/${id}/act`, browserActionSchema.parse(action), signal)
        ).json(),
      );
      if (value.sessionId !== id)
        throw new BrowserError("INVALID_SESSION", "The browser returned a different session.");
      await this.save(
        owner,
        {
          id,
          title: value.title,
          url: value.url,
          status: "active",
          control: value.control,
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return value;
    });
  }
  async control(owner: string, id: string, mode?: "agent" | "human") {
    await this.get(owner, id);
    return this.save(
      owner,
      await (
        await this.request(`/sessions/${id}/control`, mode ? { control: mode } : undefined)
      ).json(),
      id,
    );
  }
  async screenshotForAgent(owner: string, id: string, signal?: AbortSignal) {
    await this.get(owner, id);
    const value = z
      .object({
        sessionId: z.uuid(),
        title: z.string(),
        url: z.url(),
        image: z.string().max(1_398_104),
        mimeType: z.literal("image/jpeg"),
        width: z.literal(1280),
        height: z.literal(800),
      })
      .parse(
        await (await this.request(`/sessions/${id}/agent-screenshot`, undefined, signal)).json(),
      );
    if (value.sessionId !== id || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.image))
      throw new BrowserError("INVALID_SCREENSHOT", "The browser returned an invalid screenshot.");
    const { image, ...safe } = value;
    const asset = await this.assets.save(owner, Buffer.from(image, "base64"));
    return {
      ...safe,
      screenshotId: asset.id,
      browserScreenshot: true,
      imageInput: "model-dependent",
    };
  }
  screenshotImage(owner: string, screenshotId: string) {
    return this.assets.image(owner, screenshotId);
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(owner, await (await this.request(`/sessions/${id}/close`, {})).json(), id);
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.request(`/sessions/${id}/screenshot`);
  }
  async input(owner: string, id: string, value: unknown) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.request(`/sessions/${id}/input`, value)).json(),
        id,
      );
    });
  }
  async imports(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.request(`/sessions/${id}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}
