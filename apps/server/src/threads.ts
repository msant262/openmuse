import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
  type LocalThreadEndpointRecord,
} from "@copilotkit/runtime/v2";
import { Observable, of, ReplaySubject } from "rxjs";
import { z } from "zod";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

type Thread = LocalThreadEndpointRecord & {
  runToken: string | null;
  leaseUntil: string | null;
  stopRunToken?: string | null;
};
type Run = {
  id: string;
  threadId: string;
  runId: string;
  createdAt: string;
  status: "running" | "finished" | "interrupted";
  events: BaseEvent[];
  messages: Message[];
  state: Record<string, unknown>;
  inputMessages?: Message[];
  initialState?: Record<string, unknown>;
};
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.-]+$/);
const mutation = z.object({
  agentId: z.literal("default"),
  name: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});

/** Store-backed AG-UI runner. Request identity never comes from client thread/user arguments. */
export class LocalThreads extends AgentRunner {
  private readonly context = new AsyncLocalStorage<string>();
  private readonly active = new Map<string, { runId: string; token: string; stop: () => void }>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private closing = false;
  private drainFailed = false;
  /** Abort replies and join their durable checkpoints before closing the database. */
  async close() {
    this.closing = true;
    for (const run of this.active.values()) run.stop();
    await Promise.all([...this.pendingRuns]);
    if (this.drainFailed) throw new Error("Conversation shutdown could not confirm persistence");
  }
  constructor(
    private readonly db: Store,
    private readonly leaseMs = 30_000,
  ) {
    super();
  }
  withOwner<T>(owner: string, action: () => T): T {
    return this.context.run(owner, action);
  }
  private owner() {
    const owner = this.context.getStore();
    if (!owner) throw new AppError("Sign in to OpenMuse", 401);
    return owner;
  }
  private key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  private summary(thread: Thread): LocalThreadEndpointRecord {
    const { runToken, leaseUntil, stopRunToken, ...record } = thread;
    return record;
  }
  async ensure(owner: string, threadId: string): Promise<Thread> {
    identifier.parse(threadId);
    const now = new Date().toISOString();
    await this.db.insertIfAbsent(owner, "threads", {
      id: threadId,
      name: null,
      agentId: "default",
      organizationId: "",
      createdById: owner,
      archived: false,
      createdAt: now,
      updatedAt: now,
      runToken: null,
      leaseUntil: null,
    });
    return this.get(owner, threadId);
  }
  private async get(owner: string, id: string): Promise<Thread> {
    identifier.parse(id);
    const value = await this.db.get<Thread>(owner, "threads", id);
    if (!value) throw new AppError("Conversation not found", 404);
    return value;
  }
  private async runs(owner: string, id: string): Promise<Run[]> {
    return (await this.db.threadSnapshot<Run>(owner, id)).runs;
  }
  private async replaySnapshot(run: Run, events = run.events) {
    class ReplayAgent extends AbstractAgent {
      run() {
        return of(...events);
      }
    }
    const reader = new ReplayAgent();
    reader.setMessages(run.inputMessages ?? []);
    reader.setState(run.initialState ?? {});
    reader.threadId = run.threadId;
    try {
      await reader.runAgent({ runId: run.runId });
    } catch {
      /* RUN_ERROR still leaves the applied partial snapshot. */
    }
    return { messages: reader.messages, state: reader.state };
  }
  /** Close expired runs without restarting tools or presenting interruption as success. */
  private async recover(owner: string, threadId: string) {
    const snapshot = await this.db.threadSnapshot<Run>(owner, threadId);
    // Also recover orphan records left by a prior crash or a replaced expired lease.
    for (const run of snapshot.runs.filter(
      (run) => run.status === "running" && run.id !== snapshot.activeRunToken,
    )) {
      const events = [...run.events];
      finalizeRunEvents(events, {
        interruptionMessage:
          "Server restarted or lost its run lease. Review partial results before continuing.",
      });
      // The event comparison fences a concurrent final append; a fresh read retries it.
      await this.db.recoverThreadRun(owner, threadId, run.id, run.events, {
        events,
        status: "interrupted",
        ...(await this.replaySnapshot(run, events)),
      });
    }
  }
  async history(owner: string, id: string) {
    const thread = await this.get(owner, id);
    await this.recover(owner, thread.id);
    const runs = await this.runs(owner, id);
    const events = compactEvents(runs.flatMap((run) => run.events));
    const last = runs.at(-1);
    // Messages in a running/interrupted run are also recoverable from its durable events.
    const snapshot =
      last?.status === "running"
        ? await this.replaySnapshot(last)
        : { messages: last?.messages ?? [], state: last?.state ?? {} };
    return { events: this.canonicalEvents(events, snapshot), ...snapshot };
  }
  // AG-UI snapshots retain existing message order. Clear before restoring the canonical
  // transcript so old user inputs remain correctly interleaved with assistant/tool receipts.
  private canonicalEvents(
    events: BaseEvent[],
    snapshot: { messages: Message[]; state: Record<string, unknown> },
  ) {
    const values: BaseEvent[] = [
      { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot.messages },
      { type: EventType.STATE_SNAPSHOT, snapshot: snapshot.state },
    ];
    if (!events.length) return events;
    const last = events.at(-1);
    return last &&
      [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(last.type as EventType.RUN_FINISHED)
      ? [...events.slice(0, -1), ...values, last]
      : [...events, ...values];
  }
  /** Busy chats defer publication. The task never runs again merely to retry its message. */
  async appendBackground(
    owner: string,
    threadId: string,
    key: string,
    text: string,
  ): Promise<boolean> {
    const id = createHash("sha256").update(`publication:${owner}:${threadId}:${key}`).digest("hex");
    if (await this.db.get(owner, "thread-runs", id)) return true;
    await this.ensure(owner, threadId);
    await this.recover(owner, threadId);
    const token = randomUUID();
    if (!(await this.db.claimThread(owner, threadId, token, this.leaseMs))) return false;
    try {
      await this.recover(owner, threadId);
      const latest = (await this.runs(owner, threadId)).at(-1);
      const messageId = `publication-${id}`;
      const createdAt = new Date(
        Math.max(Date.now(), Date.parse(latest?.createdAt ?? "") + 1 || 0),
      ).toISOString();
      const state = latest?.state ?? {};
      return await this.db.insertThreadPublication(owner, threadId, token, {
        id,
        threadId,
        runId: id,
        createdAt,
        status: "finished",
        state,
        messages: [
          ...(latest?.messages ?? []),
          { id: messageId, role: "assistant", content: text },
        ],
        events: [
          { type: EventType.RUN_STARTED, threadId, runId: id },
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          { type: EventType.RUN_FINISHED, threadId, runId: id },
        ],
      });
    } finally {
      await this.db.compareAndSwap(
        owner,
        "threads",
        threadId,
        { runToken: token },
        { runToken: null, leaseUntil: null },
      );
    }
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const owner = this.owner();
    const subject = new ReplaySubject<BaseEvent>();
    if (this.closing) {
      subject.error(new AppError("Server is shutting down", 503));
      return subject.asObservable();
    }
    const pending = this.execute(owner, request, subject).catch(() => {
      if (this.closing) this.drainFailed = true;
      subject.next({
        type: EventType.RUN_ERROR,
        message: "Could not save the conversation. Please retry.",
      });
      subject.complete();
    });
    this.pendingRuns.add(pending);
    void pending.finally(() => this.pendingRuns.delete(pending));
    return subject.asObservable();
  }
  private async execute(
    owner: string,
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
  ) {
    const { threadId, input, agent } = request;
    const thread = await this.ensure(owner, threadId);
    await this.recover(owner, thread.id);
    const token = randomUUID();
    if (!(await this.db.claimThread(owner, threadId, token, this.leaseMs))) {
      subject.next({
        type: EventType.RUN_ERROR,
        code: "THREAD_BUSY",
        message:
          "This conversation is already replying. Wait or stop that reply before sending another.",
      });
      subject.complete();
      return;
    }
    // A competing claimant may have replaced an expired run while its recovery was pending.
    await this.recover(owner, threadId);
    const historic = await this.runs(owner, threadId);
    const previous = historic.at(-1);
    const previousSnapshot =
      previous?.status === "running" ? await this.replaySnapshot(previous) : previous;
    const messages = [...(previousSnapshot?.messages ?? [])];
    const ids = new Set(messages.map((message) => message.id));
    for (const message of input.messages) {
      if (!ids.has(message.id)) {
        messages.push(message);
        ids.add(message.id);
      }
    }
    const authoritative = { ...input, messages, state: previousSnapshot?.state ?? input.state };
    agent.setMessages(messages);
    agent.setState(authoritative.state);
    const run: Run = {
      id: token,
      threadId,
      runId: input.runId,
      createdAt: new Date(
        Math.max(Date.now(), Date.parse(previous?.createdAt ?? "") + 1 || 0),
      ).toISOString(),
      status: "running",
      events: [],
      messages,
      inputMessages: messages,
      state: authoritative.state,
      initialState: authoritative.state,
    };
    await this.db.put(owner, "thread-runs", run);
    let stopped = false;
    let leaseLost = false;
    let pending = Promise.resolve();
    const persist = (event: BaseEvent) => {
      run.events.push(event);
      pending = pending.then(async () => {
        await this.db.appendRecordEvent(owner, token, event);
        // Each streamed receipt is durable before the phone sees it.
        subject.next(event);
      });
      return pending;
    };
    const abort = () => {
      agent.abortRun();
      void agent.detachActiveRun().catch(() => {});
    };
    this.active.set(this.key(owner, threadId), {
      runId: input.runId,
      token,
      stop: () => {
        stopped = true;
        abort();
      },
    });
    let renewing = false;
    let renewal: Promise<void> | undefined;
    let error: string | undefined;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        renewal = this.db
          .renewThread(owner, threadId, token, this.leaseMs)
          .then(async (renewed) => {
            if (!renewed) {
              leaseLost = true;
              abort();
            } else if ((await this.get(owner, threadId)).stopRunToken === token) {
              stopped = true;
              abort();
            }
          })
          .catch(() => {
            leaseLost = true;
            abort();
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(10, Math.min(1000, Math.floor(this.leaseMs / 3))),
    );
    heartbeat.unref();
    const checkpoint = () => {
      const snapshot = structuredClone({ messages: agent.messages, state: agent.state });
      pending = pending.then(async () => {
        await this.db.compareAndSwap(owner, "thread-runs", token, { status: "running" }, snapshot);
      });
      void pending.catch(() => {});
    };
    try {
      if (this.closing) stopped = true;
      else
        await agent.runAgent(authoritative, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & { input?: typeof input };
              event = { ...started, input: authoritative };
            }
            if (event.type === EventType.RUN_ERROR)
              error = (event as BaseEvent & { message: string }).message;
            return persist(event);
          },
          onMessagesChanged: checkpoint,
          onStateChanged: checkpoint,
        });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Reply interrupted";
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
    try {
      const additions = finalizeRunEvents(run.events, {
        stopRequested: stopped,
        ...(leaseLost
          ? {
              interruptionMessage:
                "Conversation lease expired. Please reconnect before continuing.",
            }
          : error && !stopped
            ? { interruptionMessage: error }
            : {}),
      });
      // finalizeRunEvents mutates the event buffer; persist additions without adding twice.
      for (const event of additions) {
        pending = pending.then(async () => {
          await this.db.appendRecordEvent(owner, token, event);
          subject.next(event);
        });
      }
      await pending;
      await this.db.compareAndSwap(
        owner,
        "thread-runs",
        token,
        { status: "running" },
        {
          // Synthesized stopped-tool receipts must match replay and next-turn context.
          ...(await this.replaySnapshot(run)),
          status: stopped || error || leaseLost ? "interrupted" : "finished",
        },
      );
      await this.db.compareAndSwap(
        owner,
        "threads",
        threadId,
        { runToken: token },
        {
          runToken: null,
          leaseUntil: null,
          updatedAt: new Date().toISOString(),
        },
      );
    } catch {
      this.drainFailed = true;
      subject.next({
        type: EventType.RUN_ERROR,
        message: "Could not save the conversation. Reconnect before continuing.",
      });
    } finally {
      const active = this.active.get(this.key(owner, threadId));
      if (active?.token === token) this.active.delete(this.key(owner, threadId));
      subject.complete();
    }
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const owner = this.owner();
    return new Observable((subscriber) => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = new Map<string, number>();
      let first = true;
      const poll = async () => {
        try {
          const thread = await this.get(owner, request.threadId);
          await this.recover(owner, thread.id);
          const snapshot = await this.db.threadSnapshot<Run>(owner, request.threadId);
          const runs = snapshot.runs;
          if (cancelled) return;
          if (first) {
            const last = runs.at(-1);
            const canonical =
              last?.status === "running"
                ? await this.replaySnapshot(last)
                : { messages: last?.messages ?? [], state: last?.state ?? {} };
            for (const event of this.canonicalEvents(
              compactEvents(runs.flatMap((run) => run.events)),
              canonical,
            ))
              subscriber.next(event);
            for (const run of runs) seen.set(run.id, run.events.length);
            first = false;
          } else
            for (const run of runs) {
              for (const event of run.events.slice(seen.get(run.id) ?? 0)) subscriber.next(event);
              seen.set(run.id, run.events.length);
            }
          if (snapshot.activeRunToken || runs.some((run) => run.status === "running"))
            timer = setTimeout(() => void poll(), 150);
          else subscriber.complete();
        } catch (cause) {
          if (!cancelled) {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message:
                cause instanceof AppError ? cause.message : "Could not replay the conversation",
            });
            subscriber.complete();
          }
        }
      };
      void poll();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    });
  }
  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const thread = await this.get(this.owner(), request.threadId);
    await this.recover(this.owner(), thread.id);
    return this.db.threadLeaseActive(this.owner(), thread.id);
  }
  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const owner = this.owner();
    const thread = await this.get(owner, request.threadId);
    const active = this.active.get(this.key(owner, request.threadId));
    if (active) {
      if (request.runId && active.runId !== request.runId) return false;
      active.stop();
      return true;
    }
    if (!thread.runToken || !(await this.db.threadLeaseActive(owner, thread.id))) return false;
    const run = await this.db.get<Run>(owner, "thread-runs", thread.runToken);
    if (request.runId && run?.runId !== request.runId) return false;
    return Boolean(
      await this.db.compareAndSwap(
        owner,
        "threads",
        thread.id,
        { runToken: thread.runToken },
        { stopRunToken: thread.runToken },
      ),
    );
  }
  /** Async REST shim because 1.70's runner thread endpoints only accept synchronous RAM storage. */
  async handle(request: Request, owner: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/copilotkit/, "");
    if (path === "/threads" && request.method === "GET") {
      z.literal("default").parse(url.searchParams.get("agentId"));
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(url.searchParams.get("limit") ?? 20);
      const all = (await this.db.list<Thread>(owner, "threads"))
        .filter((item) => url.searchParams.get("includeArchived") === "true" || !item.archived)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
      if (cursor && start === 0) throw new AppError("Conversation cursor is invalid", 422);
      const page = all.slice(start, start + limit);
      return Response.json({
        threads: page.map((thread) => this.summary(thread)),
        nextCursor: start + limit < all.length ? page.at(-1)?.id : null,
      });
    }
    // No joinCode/wsUrl is returned, so useThreads stays entirely on this server's REST API.
    const match = /^\/threads\/([^/]+)(?:\/(messages|events|state|archive))?$/.exec(path);
    if (!match) return undefined;
    const id = identifier.parse(decodeURIComponent(match[1]));
    await this.get(owner, id);
    if (request.method === "GET" && match[2] && match[2] !== "archive") {
      const history = await this.history(owner, id);
      return Response.json({ [match[2]]: history[match[2] as "messages" | "events" | "state"] });
    }
    if (
      (request.method === "PATCH" && !match[2]) ||
      (request.method === "POST" && match[2] === "archive")
    ) {
      const body = mutation.parse(await request.json());
      const archived = match[2] === "archive" ? true : body.archived;
      const main = await this.db.get<{ threadId: string }>(owner, "conversation-settings", "main");
      if (archived && main?.threadId === id)
        throw new AppError(
          "Your main conversation stays available. Archive a side chat instead.",
          409,
        );
      const updated = await this.db.compareAndSwap<Thread>(
        owner,
        "threads",
        id,
        {},
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(archived !== undefined ? { archived } : {}),
          updatedAt: new Date().toISOString(),
        },
      );
      if (!updated) throw new AppError("Conversation not found", 404);
      return Response.json(this.summary(updated));
    }
    return Response.json({ error: "Conversation operation is unavailable" }, { status: 405 });
  }
}
