import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Frame, Page } from "playwright";
import {
  browserCdpInputSchema,
  browserConsoleInputSchema,
} from "../../../packages/domain/src/browser-diagnostics.ts";
import { browserUploadSchema } from "../../../packages/domain/src/browser-file.ts";
import { browserImagesInputSchema } from "../../../packages/domain/src/browser-images.ts";
import { defaultSearchEndpoint, searchInputSchema } from "../../../packages/domain/src/search.ts";
import { AgentPage, browserAction } from "./agent-page.ts";
import { BrowserDiagnostics } from "./browser-diagnostics.ts";
import { BrowserChallenge } from "./challenge.ts";
import {
  type CredentialLoginInput,
  type CredentialLoginResult,
  credentialLogin,
  credentialLoginInputSchema,
} from "./credential-login.ts";
import {
  capturePdfDownload,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  readDownloadFailures,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import { type NativeBrowserConfig, nativeLaunchOptions } from "./native-config.ts";
import { validatePublicUrl } from "./network.ts";
import { observationContent } from "./observation-content.ts";
import { startEgressProxy } from "./proxy.ts";
import { observePublicDataRequests, readPublicContent } from "./public-read.ts";
import { ReviewedActions } from "./reviewed-actions.ts";
import { extractSearch } from "./search.ts";

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
  control?: "agent" | "human";
}
type Running = {
  publicData: ReturnType<typeof observePublicDataRequests>;
  context: BrowserContext;
  page: Page;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
  agent: AgentPage;
  challenge: BrowserChallenge;
  diagnostics: BrowserDiagnostics;
  captchaActive?: boolean;
  interruptions: {
    popupsBlocked: number;
    dialogsDismissed: number;
    last?: "POPUP_BLOCKED" | "DIALOG_DISMISSED";
  };
  unsafeSurface?: boolean;
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

/** A closed tab has no browser input to release. Physical desktop input is
 * reset separately by the desktop broker before it confirms a control change. */
export async function resetBrowserInput(page: Pick<Page, "isClosed" | "keyboard" | "mouse">) {
  if (page.isClosed()) return;
  try {
    await Promise.all([
      ...["Shift", "Control", "Alt", "Meta"].map((key) => page.keyboard.up(key)),
      page.mouse.up(),
    ]);
  } catch (error) {
    // The user can close the window while a control change releases input.
    // A still-open page with a failed release remains an unconfirmed operation.
    if (!page.isClosed()) throw error;
  }
}

export async function createBrowserManager(options: {
  token?: string;
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  native?: NativeBrowserConfig;
  beforeEffect?: () => void;
  /** Trusted constructor configuration only; callers cannot select an index URL. */
  searchEndpoint?: string;
  protect?: (
    masks: [number, number, number, number][],
    state: { suspended: boolean; screenOffset?: { x: number; y: number; scale: number } },
  ) => Promise<void>;
}) {
  const { dataDir, maxSessions = 3, idleTimeoutMs = 30 * 60_000 } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const closeFailures = new Map<string, Error>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const proxy = await startEgressProxy(options.native?.proxyPort);
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    try {
      const stored = JSON.parse(
        await readFile(join(dataDir, id, "session.json"), "utf8"),
      ) as Session;
      sessions.set(id, { ...stored, id, control: stored.control ?? "agent", status: "closed" });
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
    }
    if (sessions.has(id)) await readDownloadFailures(join(dataDir, id), true);
  }
  const directory = (id: string) => {
    const checked = validateSessionId(id);
    if (options.native && checked !== options.native.sessionId)
      throw new WorkerError(
        "INVALID_SESSION",
        "Native browser profile belongs to its fixed registered desktop",
        403,
      );
    return join(dataDir, checked);
  };
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (closing)
      throw new WorkerError("WORKER_STOPPING", "The browser worker is shutting down.", 503);
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.page.isClosed())
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    if (value.unsafeSurface)
      throw new WorkerError(
        "BROWSER_SURFACE_UNSAFE",
        "A popup or dialog could not be contained; close this session before continuing.",
        409,
      );
    value.touched = Date.now();
    return value;
  }
  async function refresh(id: string) {
    const instance = active(id);
    if (instance.page.url() !== "about:blank") await validatePage(instance);
    const session: Session = {
      id,
      title: (await instance.page.title()).slice(0, 300),
      url: instance.page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
      control: sessions.get(id)?.control ?? "agent",
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(join(folder, name), "utf8")) as PdfDownload;
      list.push(item);
    }
    return list;
  }
  function guardAgent(id: string) {
    options.beforeEffect?.();
    if (sessions.get(id)?.control === "human")
      throw new WorkerError(
        "BROWSER_CONTROLLED",
        "The browser is under your control. Hand it back to resume the agent.",
        409,
        { sessionId: id },
      );
  }
  async function navigate(id: string, url: string, agent = true) {
    if (agent && running.get(id)?.captchaActive)
      throw new WorkerError(
        "CHALLENGE_TOOL_REQUIRED",
        "Resolve the current challenge or hand back control; navigation cannot reset its attempt budget.",
        409,
      );
    if (agent) guardAgent(id);
    await running.get(id)?.agent.invalidate();
    const target = await validatePublicUrl(url);
    const { page } = active(id);
    active(id).publicData.reset();
    if (agent) guardAgent(id);
    try {
      await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url());
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
      }
      // A successful attachment intentionally aborts page navigation.
      if (!(error instanceof Error && /Download is starting/.test(error.message))) {
        throw new WorkerError(
          "NAVIGATION_FAILED",
          "The page could not be loaded. It may be unreachable or contain a blocked destination.",
          502,
        );
      }
    }
    return refresh(id);
  }
  async function validatePage(instance: Running) {
    if (instance.unsafeSurface)
      throw new WorkerError(
        "BROWSER_SURFACE_UNSAFE",
        "A popup or dialog could not be contained; close this session before continuing.",
        409,
      );
    for (const frame of instance.page.frames()) {
      if (["about:blank", "about:srcdoc"].includes(frame.url())) continue;
      await validatePublicUrl(frame.url());
    }
  }
  async function closeSession(id: string) {
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    let failed = !instance && closeFailures.has(id);
    if (instance) {
      const statePath = join(directory(id), "storage.json");
      try {
        await instance.agent.invalidate();
        await instance.context.storageState({ path: `${statePath}.tmp` });
        await rename(`${statePath}.tmp`, statePath);
      } catch {
        failed = true;
      } finally {
        // A failed state save must still release Chromium and the profile lock.
        try {
          await instance.context.close();
        } catch {
          failed = true;
        }
        await Promise.allSettled(instance.pending);
        running.delete(id);
        await rm(`${statePath}.tmp`, { force: true }).catch(() => {});
      }
    }
    const result: Session = {
      ...stored,
      status: failed ? "error" : "closed",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, result);
    const failure = new WorkerError(
      "SESSION_CLOSE_FAILED",
      "The browser profile could not be fully saved while closing.",
      500,
      { sessionId: id },
    );
    try {
      await persist(result);
    } catch {
      closeFailures.set(id, failure);
      throw failure;
    }
    if (failed) {
      closeFailures.set(id, failure);
      throw failure;
    }
    // A failed earlier close is repaired only by saving an opened profile again.
    if (instance) closeFailures.delete(id);
    return result;
  }
  async function createSession(id: string, url: string, agent = true) {
    if (agent) guardAgent(id);
    await validatePublicUrl(url);
    const closed = running.get(id);
    if (closed?.page.isClosed()) {
      await closed.agent.invalidate();
      await closed.context.close();
      await Promise.allSettled(closed.pending);
      running.delete(id);
    }
    if (running.has(id)) return navigate(id, url, agent);
    if (running.size >= maxSessions)
      throw new WorkerError(
        "SESSION_LIMIT",
        `Close an active session before opening another (limit ${maxSessions}).`,
        409,
      );
    if (!sessions.has(id) && sessions.size >= 20)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 20 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileDir = join(directory(id), "profile");
    const tempDirectory = join("/tmp", `openmuse-downloads-${id}`);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(profileDir, {
        // Chromium does not need the worker API credential in its environment.
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
        headless: true,
        ...(options.native ? nativeLaunchOptions(options.native) : {}),
        // The worker flushes profile state before it closes Chromium on signals.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        viewport: options.native
          ? { width: options.native.width ?? 1280, height: options.native.height ?? 720 }
          : { width: 1280, height: 800 },
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        serviceWorkers: "block",
        acceptDownloads: true,
        downloadsPath: tempDirectory,
        timeout: 25_000,
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-extensions",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        ],
      });
    } catch {
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(directory(id), "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        try {
          await validatePublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      // Headed Chromium exits when its last window closes. Keep the new tab
      // alive before retiring the startup/restored tabs.
      const oldPages = context.pages();
      const page = await context.newPage();
      for (const old of oldPages) await old.close();
      page.setDefaultTimeout(10_000);
      const instance: Running = {
        publicData: observePublicDataRequests(page),
        context,
        page,
        touched: Date.now(),
        pending: new Set(),
        agent: new AgentPage(page, options.protect),
        challenge: new BrowserChallenge(page),
        diagnostics: new BrowserDiagnostics(page),
        interruptions: { popupsBlocked: 0, dialogsDismissed: 0 },
      };
      running.set(id, instance);
      context.on("page", (popup) => {
        instance.interruptions.popupsBlocked = Math.min(
          1000,
          instance.interruptions.popupsBlocked + 1,
        );
        instance.interruptions.last = "POPUP_BLOCKED";
        void instance.agent.invalidate();
        void popup.close().catch(() => {
          instance.unsafeSurface = true;
        });
      });
      page.on("dialog", (dialog) => {
        instance.interruptions.dialogsDismissed = Math.min(
          1000,
          instance.interruptions.dialogsDismissed + 1,
        );
        instance.interruptions.last = "DIALOG_DISMISSED";
        void instance.agent.invalidate();
        void dialog.dismiss().catch(() => {
          instance.unsafeSurface = true;
        });
      });
      page.on("download", (download) => {
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            tempDirectory,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => instance.pending.delete(pending),
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        control: previous?.control ?? (agent ? "agent" : "human"),
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url, agent);
    } catch (error) {
      await context.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        await rm(directory(id), { recursive: true, force: true });
      }
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running)
      if (Date.now() - instance.touched > idleTimeoutMs) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  return {
    list: () => [...sessions.values()],
    resetInput: async (id: string) => {
      const instance = running.get(id);
      if (!instance) return;
      await instance.agent.invalidate();
      await resetBrowserInput(instance.page);
    },
    create: (id: string, url: string, agent = true) => {
      const session = sessions.get(id);
      if (!agent && session) {
        sessions.set(id, { ...session, control: "human" });
        void running.get(id)?.agent.invalidate();
      }
      return serial("create", () => serial(id, () => createSession(id, url, agent)));
    },
    navigate: (id: string, url: string, agent = true) => {
      const session = sessions.get(id);
      if (!agent && session) {
        sessions.set(id, { ...session, control: "human" });
        void running.get(id)?.agent.invalidate();
      }
      return serial(id, () => navigate(id, url, agent));
    },
    back: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        guardAgent(id);
        if (instance.captchaActive)
          throw new WorkerError(
            "CHALLENGE_TOOL_REQUIRED",
            "Resolve the current challenge or hand back control before navigating history.",
            409,
          );
        await validatePage(instance);
        await instance.agent.invalidate();
        instance.publicData.reset();
        guardAgent(id);
        let historyMoved = false;
        const navigation = (frame: Frame) => {
          if (frame === instance.page.mainFrame()) historyMoved = true;
        };
        instance.page.on("framenavigated", navigation);
        try {
          await instance.page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 });
        } finally {
          instance.page.off("framenavigated", navigation);
        }
        try {
          await validatePage(instance);
        } catch (error) {
          if (error instanceof WorkerError && error.code === "BLOCKED_URL")
            await instance.page.goto("about:blank", { timeout: 5000 });
          throw error;
        }
        const result = await instance.agent.snapshot();
        await refresh(id);
        return {
          sessionId: id,
          control: sessions.get(id)?.control ?? "agent",
          ...result,
          historyMoved,
          interruptions: { ...instance.interruptions },
        };
      }),
    control: (id: string) =>
      serial(id, async () => {
        const session = sessions.get(id);
        if (!session) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
        return session;
      }),
    setControl: (id: string, control: "agent" | "human") => {
      const session = sessions.get(id);
      if (!session) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
      // Close the gate immediately; actions queued before this request re-check on dispatch.
      sessions.set(id, { ...session, control, updatedAt: new Date().toISOString() });
      const invalidated = running.get(id)?.agent.invalidate();
      return serial(id, async () => {
        await invalidated;
        const latest = sessions.get(id);
        if (!latest) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
        await persist(latest);
        return latest;
      });
    },
    snapshot: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        await validatePage(instance);
        const result = await instance.agent.snapshot();
        await refresh(id);
        return {
          sessionId: id,
          control: sessions.get(id)?.control ?? "agent",
          ...result,
          interruptions: { ...instance.interruptions },
        };
      }),
    console: (id: string, raw: unknown = {}) =>
      serial(id, async () => {
        const checked = browserConsoleInputSchema.safeParse(raw);
        if (!checked.success)
          throw new WorkerError(
            "INVALID_BROWSER_DIAGNOSTICS",
            "Use console after, limit and clear; caller scripts are not console reads.",
            422,
          );
        const instance = active(id);
        await validatePage(instance);
        await instance.agent.prepareProgrammaticObservation();
        const result = instance.diagnostics.console(checked.data);
        return {
          sessionId: id,
          url: instance.page.url(),
          observedAt: new Date().toISOString(),
          ...result,
        };
      }),
    cdp: (id: string, raw: unknown) =>
      serial(id, async () => {
        const checked = browserCdpInputSchema.safeParse(raw);
        if (!checked.success)
          throw new WorkerError(
            "INVALID_BROWSER_DIAGNOSTICS",
            "Choose a supported CDP inspection command. Use browser actions for site changes.",
            422,
          );
        guardAgent(id);
        const instance = active(id);
        await validatePage(instance);
        await instance.agent.prepareProgrammaticObservation();
        const result = await instance.diagnostics.cdp(checked.data);
        await validatePage(instance);
        await instance.agent.prepareProgrammaticObservation();
        return {
          sessionId: id,
          url: instance.page.url(),
          observedAt: new Date().toISOString(),
          method: checked.data.method,
          result,
        };
      }),
    images: (id: string, raw: unknown = {}) =>
      serial(id, async () => {
        const checked = browserImagesInputSchema.safeParse(raw);
        if (!checked.success)
          throw new WorkerError(
            "INVALID_IMAGES",
            "Use only a bounded image offset and limit.",
            422,
          );
        const instance = active(id);
        await validatePage(instance);
        await instance.agent.prepareObservation();
        const images: {
          src: string;
          alt: string;
          width: number;
          height: number;
          frameUrl: string;
        }[] = [];
        let total = 0,
          partial = false;
        for (const frame of instance.page.frames()) {
          if (frame.isDetached()) {
            partial = true;
            continue;
          }
          if (frame !== instance.page.mainFrame()) {
            const element = await frame.frameElement().catch(() => undefined);
            const visible = element && (await element.isVisible());
            await element?.dispose();
            if (!visible) continue;
          }
          try {
            const page = await frame.evaluate(
              ({ offset, limit }) => {
                const images: { src: string; alt: string; width: number; height: number }[] = [];
                let total = 0;
                const nodes = document.images;
                for (let index = 0; index < nodes.length; index++) {
                  const image = nodes.item(index);
                  if (!image) continue;
                  if (image.closest('[data-openmuse-credential-sensitive="true"]')) continue;
                  const src = image.currentSrc || image.src;
                  if (!/^https?:\/\//i.test(src) || src.length > 8192) continue;
                  if (total >= offset && images.length < limit)
                    images.push({
                      src,
                      alt: image.alt.slice(0, 500),
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    });
                  total++;
                }
                return { images, total };
              },
              {
                offset: Math.max(0, checked.data.offset - total),
                limit: checked.data.limit - images.length,
              },
            );
            images.push(...page.images.map((image) => ({ ...image, frameUrl: frame.url() })));
            total += page.total;
          } catch {
            // A changing frame is incomplete coverage, never proof of absence.
            partial = true;
          }
        }
        await refresh(id);
        const next = checked.data.offset + images.length;
        return {
          sessionId: id,
          url: instance.page.url(),
          observedAt: new Date().toISOString(),
          images,
          total,
          nextOffset: next < total ? next : null,
          partial,
        };
      }),
    search: (id: string, raw: unknown) =>
      serial(id, async () => {
        const input = searchInputSchema.parse(raw);
        guardAgent(id);
        const url = new URL(options.searchEndpoint ?? defaultSearchEndpoint);
        url.searchParams.set("q", input.query);
        await navigate(id, url.href);
        const instance = active(id);
        await validatePage(instance);
        guardAgent(id);
        const result = await extractSearch(instance.page, input);
        return { ...result, provenance: { ...result.provenance, sessionId: id } };
      }),
    upload: (id: string, raw: unknown) =>
      serial(id, async () => {
        const checked = browserUploadSchema.safeParse(raw);
        if (!checked.success)
          throw new WorkerError(
            "INVALID_UPLOAD",
            "A bounded file and current numbered file input are required.",
            422,
          );
        const file = checked.data,
          bytes = Buffer.from(file.base64, "base64");
        if (
          bytes.length !== file.size ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256
        )
          throw new WorkerError("INVALID_UPLOAD", "Upload size or digest changed.", 422);
        guardAgent(id);
        const instance = active(id);
        await validatePage(instance);
        await instance.agent.upload(
          file,
          { name: file.name, mimeType: file.mimeType, buffer: bytes },
          () => guardAgent(id),
        );
        guardAgent(id);
        await validatePage(instance);
        await refresh(id);
        return {
          sessionId: id,
          control: sessions.get(id)?.control ?? "agent",
          ...(await instance.agent.snapshot()),
          interruptions: { ...instance.interruptions },
          uploaded: { name: file.name, size: file.size, sha256: file.sha256 },
        };
      }),
    challenge: (id: string, raw: unknown) =>
      serial(id, async () => {
        guardAgent(id);
        options.beforeEffect?.();
        const instance = active(id);
        await validatePage(instance);
        const result = await instance.challenge.execute(
          raw,
          () => {
            guardAgent(id);
            options.beforeEffect?.();
          },
          (selectors) => instance.agent.protect(selectors, false),
        );
        if (result.status === "authenticated") instance.captchaActive = false;
        return { ...result, sessionId: id };
      }),
    credentials: (id: string, raw: unknown): Promise<CredentialLoginResult> =>
      serial(id, async () => {
        guardAgent(id);
        options.beforeEffect?.();
        const instance = active(id);
        await validatePage(instance);
        const input: CredentialLoginInput = credentialLoginInputSchema.parse(raw);
        instance.diagnostics.protectSecrets(input.fields.map((field) => field.value));
        const result = await credentialLogin(instance.page, input, {
          sessionId: id,
          ...(options.native ? { sessionGeneration: options.native.sessionGeneration } : {}),
          guard: () => {
            guardAgent(id);
            options.beforeEffect?.();
          },
          protect: (selectors, suspended) => instance.agent.protect(selectors, suspended),
        });
        instance.captchaActive =
          result.status === "challenge" && result.challengeKind === "captcha";
        // Persist only safe session metadata. Any failed confirmation after the
        // fixed submit point is reported as uncertain; callers never replay it.
        if (result.status === "outcome_unknown") return result;
        try {
          await validatePage(instance);
          await refresh(id);
          return result;
        } catch {
          return {
            status: "outcome_unknown",
            origin: input.origin,
            sessionId: id,
            ...(options.native ? { sessionGeneration: options.native.sessionGeneration } : {}),
            reasonCode: "POST_LOGIN_REFRESH_UNCONFIRMED",
          };
        }
      }),
    reviewedAct: (id: string, authorization: unknown) =>
      serial(id, async () => {
        if (!options.token)
          throw new WorkerError("INVALID_APPROVAL", "Review executor is not configured.", 403);
        const instance = active(id);
        await validatePage(instance);
        const receipt = await new ReviewedActions(dataDir, options.token).execute(
          id,
          authorization,
          instance.agent,
          () => guardAgent(id),
        );
        try {
          await validatePage(instance);
          await refresh(id);
        } catch {
          throw new WorkerError(
            "OUTCOME_UNKNOWN",
            "The approved action executed but page verification failed. Check the site.",
            409,
          );
        }
        return receipt;
      }),
    inspect: (id: string, value: Record<string, unknown>) =>
      serial(id, async () => {
        guardAgent(id);
        const instance = active(id);
        await validatePage(instance);
        const inspected = await instance.agent.inspect(browserAction(value));
        return {
          binding: inspected.binding,
          label: inspected.live.label,
          requiresApproval: inspected.requiresApproval,
        };
      }),
    act: (id: string, value: Record<string, unknown>) => {
      const action = browserAction(value);
      return serial(id, async () => {
        guardAgent(id);
        const instance = active(id);
        if (instance.captchaActive)
          throw new WorkerError(
            "CHALLENGE_TOOL_REQUIRED",
            "Use the bounded connection_challenge tool for this verification.",
            409,
          );
        await validatePage(instance);
        await instance.agent.act(action, () => guardAgent(id));
        try {
          await validatePage(instance);
        } catch (error) {
          await instance.page.goto("about:blank", { timeout: 5000 });
          throw error;
        }
        guardAgent(id);
        await refresh(id);
        return {
          sessionId: id,
          control: sessions.get(id)?.control ?? "agent",
          ...(await instance.agent.snapshot()),
          interruptions: { ...instance.interruptions },
        };
      });
    },
    agentScreenshot: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        await validatePage(instance);
        await instance.agent.prepareObservation();
        const bytes = await instance.page.screenshot({
          type: "jpeg",
          quality: 60,
          timeout: 10_000,
        });
        if (bytes.length > 1024 * 1024)
          throw new WorkerError("SCREENSHOT_TOO_LARGE", "The screenshot exceeds 1 MiB.", 413);
        return {
          sessionId: id,
          ...(await refresh(id)),
          mimeType: "image/jpeg",
          image: bytes.toString("base64"),
          width: instance.page.viewportSize()?.width ?? 1280,
          height: instance.page.viewportSize()?.height ?? 800,
        };
      }),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    screenshot: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        await instance.agent.prepareObservation();
        return instance.page.screenshot({ type: "png", timeout: 10_000 });
      }),
    read: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        await instance.agent.prepareObservation();
        const { page } = instance;
        await validatePublicUrl(page.url());
        const result = await readPublicContent(page, instance.publicData);
        await validatePublicUrl(result.url);
        const session: Session = {
          id,
          url: result.url,
          title: result.title,
          control: sessions.get(id)?.control ?? "agent",
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        await persist(session);
        return {
          url: result.url,
          title: result.title,
          ...observationContent(result),
          links: result.links,
          dataSources: result.dataSources,
          extraction: result.extraction,
        };
      }),
    refreshProtection: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        await instance.agent.refreshProtection();
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        if (sessions.get(id)?.control !== "human")
          throw new WorkerError(
            "CONTROL_REQUIRED",
            "Take control before sending browser input.",
            409,
          );
        const instance = active(id);
        await instance.agent.invalidate();
        const { page } = instance;
        const { type, x, y, key, text, deltaY } = input;
        if (
          type === "click" &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x < 1280 &&
          y >= 0 &&
          y < 800
        )
          await page.mouse.click(x, y);
        else if (type === "text" && typeof text === "string" && text.length <= 10_000)
          await page.keyboard.insertText(text);
        else if (
          type === "key" &&
          typeof key === "string" &&
          /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/.test(
            key,
          )
        )
          await page.keyboard.press(key);
        else if (
          type === "scroll" &&
          typeof deltaY === "number" &&
          Number.isFinite(deltaY) &&
          Math.abs(deltaY) <= 5000
        )
          await page.mouse.wheel(0, deltaY);
        else throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
        return refresh(id);
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return {
        downloads: saved,
        failures: await readDownloadFailures(directory(id)),
        pending: running.get(id)?.pending.size ?? 0,
      };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata)
        throw new WorkerError("DOWNLOAD_NOT_FOUND", "Browser download not found.", 404);
      const path = join(
        directory(id),
        "downloads",
        `${downloadId}.${metadata.storageExtension === "bin" ? "bin" : "pdf"}`,
      );
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The download exceeds 10 MiB.", 413);
      const bytes = await readFile(path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== metadata.size || (metadata.sha256 && metadata.sha256 !== digest))
        throw new WorkerError(
          "DOWNLOAD_CHANGED",
          "Stored download bytes changed; download again before publication.",
          409,
        );
      return { metadata: { ...metadata, sha256: digest }, bytes };
    },
    close: () => {
      closing = true;
      closePromise ??= (async () => {
        clearInterval(sweeper);
        // Existing queued operations finish; newly requested work is rejected.
        await Promise.allSettled([...queues.values()]);
        const outcomes = await Promise.allSettled([...running.keys()].map(closeSession));
        const failures = outcomes
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
          .map((outcome) => outcome.reason);
        for (const failure of closeFailures.values())
          if (!failures.includes(failure)) failures.push(failure);
        try {
          await proxy.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "Browser worker shutdown failed to save all profiles.",
          );
      })();
      return closePromise;
    },
  };
}
