import { z } from "zod";
import {
  type ConversationSocialState,
  type MessageQuote,
  messageQuoteSchema,
  type StickerId,
  stickerIdSchema,
} from "../../../packages/domain/src/conversation-social";
import {
  CHAT_EVENT_CACHE_SIZE,
  CHAT_HISTORY_PAGE_SIZE,
} from "../../../packages/domain/src/conversation-window";
import {
  type AcceptedMessageInput,
  acceptedMessageSchema,
  type ConversationAcceptance,
  type ConversationEvent,
  type ConversationReplay,
  conversationEventSchema,
} from "../../../packages/domain/src/runtime";
import { ApiError } from "./api-errors";
import { hashMessageContent } from "./message-hash";
import type { MessageStorage } from "./message-storage";

export type OutboxMessage = Omit<AcceptedMessageInput, "clientMessageId"> & {
  id: string;
  attempts: number;
  delivery?: "uncertain" | "rejected";
  retryAt?: number;
};
type Persisted = {
  version: 1;
  pending: OutboxMessage[];
  cursor: number;
  events: ConversationEvent[];
  draft: {
    text: string;
    attachmentIds: string[];
    annotations: AcceptedMessageInput["annotations"];
    revision: number;
    replyTo?: MessageQuote;
  };
  messages: unknown[];
  unconfirmedIds: string[];
  messageDetails: ConversationSocialState["messages"];
};
type Snapshot = Persisted & { loaded: boolean; running: boolean; paused: boolean; error: string };
/** Durable dispositions remain visible after the accepted entry leaves the local outbox. */
export function conversationDeliveryError(events: readonly ConversationEvent[]): string {
  const failures = new Map<string, string>();
  for (const event of events) {
    if (
      event.kind !== "agui" ||
      !event.runId ||
      !event.payload ||
      typeof event.payload !== "object"
    )
      continue;
    const payload = event.payload as {
      type?: string;
      name?: string;
      value?: { message?: unknown };
    };
    if (
      payload.type === "CUSTOM" &&
      payload.name === "conversation_delivery_error" &&
      typeof payload.value?.message === "string"
    )
      failures.set(event.runId, payload.value.message);
    else if (payload.type === "RUN_STARTED" || payload.type === "RUN_FINISHED")
      failures.delete(event.runId);
  }
  return failures.values().next().value ?? "";
}
const empty = (): Snapshot => ({
  version: 1,
  pending: [],
  cursor: 0,
  events: [],
  draft: { text: "", attachmentIds: [], annotations: [], revision: 0 },
  messages: [],
  unconfirmedIds: [],
  messageDetails: [],
  loaded: false,
  running: false,
  paused: false,
  error: "",
});
const messageDetailsSchema = z.object({
  messageId: z.string(),
  text: z.string(),
  replyTo: messageQuoteSchema.optional(),
  stickerId: stickerIdSchema.optional(),
});
const savedOutboxSchema = z
  .object({
    version: z.literal(1),
    pending: z.array(
      acceptedMessageSchema.omit({ clientMessageId: true }).extend({
        id: acceptedMessageSchema.shape.clientMessageId,
        attempts: z.number().int().min(0),
        delivery: z.enum(["uncertain", "rejected"]).optional(),
        retryAt: z.number().finite().nonnegative().optional(),
      }),
    ),
    cursor: z.number().int().min(0),
    events: z.array(conversationEventSchema),
    draft: z.object({
      text: z.string(),
      attachmentIds: z.array(acceptedMessageSchema.shape.clientMessageId),
      annotations: acceptedMessageSchema.shape.annotations,
      revision: z.number().int().min(0),
      replyTo: messageQuoteSchema.optional(),
    }),
    messages: z.array(z.unknown()),
    unconfirmedIds: z.array(z.string()).default([]),
    messageDetails: z.array(messageDetailsSchema.strict()).default([]),
  })
  .strict();
function boundedPersisted(parsed: Persisted): Persisted {
  const unconfirmedIds = Array.from(
    new Set([...parsed.unconfirmedIds, ...parsed.pending.map((message) => message.id)]),
  );
  const local = new Set(unconfirmedIds);
  const messages = mergeOutboxMessages(
    parsed.messages.slice(-CHAT_HISTORY_PAGE_SIZE),
    parsed.messages.filter((message) => local.has(messageId(message) ?? "")),
  );
  const ids = new Set(
    parsed.messageDetails.slice(-CHAT_EVENT_CACHE_SIZE).map((message) => message.messageId),
  );
  for (const id of local) ids.add(id);
  return {
    ...parsed,
    unconfirmedIds,
    messages,
    events: parsed.events.slice(-CHAT_EVENT_CACHE_SIZE),
    messageDetails: parsed.messageDetails.filter((message) => ids.has(message.messageId)),
  };
}
export class MessageOutbox {
  private state = empty();
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private pendingMessages?: readonly unknown[];
  private savingMessages?: Promise<void>;
  private opening?: Promise<void>;
  private automaticRetry = false;
  constructor(
    private readonly storage: MessageStorage,
    private readonly key: string,
    private readonly threadId: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private decode(raw: string | null): Persisted {
    const parsed = raw === null ? empty() : savedOutboxSchema.parse(JSON.parse(raw));
    if (parsed.pending.some((message) => message.threadId !== this.threadId))
      throw new Error(
        "Saved messages belong to a different conversation; preserve the data and retry",
      );
    const { version, pending, cursor, events, draft, messages, unconfirmedIds, messageDetails } =
      parsed;
    return boundedPersisted({
      version,
      pending,
      cursor,
      events,
      draft: { ...draft, annotations: draft.annotations ?? [] },
      messages,
      unconfirmedIds,
      messageDetails,
    });
  }
  open() {
    this.opening ??= this.storage
      .read(this.key)
      .then((raw) => {
        if (raw) {
          const parsed = this.decode(raw);
          this.automaticRetry = parsed.pending[0]?.retryAt !== undefined;
          this.update({ ...parsed, paused: this.automaticRetry });
        }
        this.update({ loaded: true, error: "" });
      })
      .catch((error) => {
        this.opening = undefined;
        this.update({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      });
    return this.opening;
  }
  private async commit(change: (previous: Snapshot) => Partial<Persisted>) {
    await this.open();
    const result = this.writes.then(async () => {
      const raw = await this.storage.update(this.key, (saved) => {
        const current = { ...this.state, ...this.decode(saved) };
        const { loaded, running, paused, error, ...record } = { ...current, ...change(current) };
        return JSON.stringify(boundedPersisted(record));
      });
      const record = this.decode(raw);
      this.update({ ...record, error: "" });
    });
    this.writes = result.catch(() => {});
    try {
      await result;
    } catch (error) {
      this.update({
        error: `Messages were not saved: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }
  async enqueue(message: {
    id: string;
    text: string;
    attachmentIds?: string[];
    targetTaskId?: string;
    annotations?: AcceptedMessageInput["annotations"];
    clearDraft?: boolean;
    clearReply?: boolean;
    replyToMessageId?: string;
    stickerId?: StickerId;
    /** Local preview only. The server resolves the quote from replyToMessageId. */
    displayReplyTo?: MessageQuote;
  }) {
    const { clearDraft, clearReply, displayReplyTo, ...input } = message;
    const value: OutboxMessage = {
      ...input,
      threadId: this.threadId,
      attachmentIds: message.attachmentIds ?? [],
      annotations: message.annotations ?? [],
      contentHash: hashMessageContent(message),
      attempts: 0,
    };
    await this.commit((previous) => {
      const existing = previous.pending.find((item) => item.id === value.id);
      if (existing) {
        if (existing.contentHash !== value.contentHash)
          throw new Error("This message ID already belongs to another draft");
        return {};
      }
      return {
        pending: [...previous.pending, value],
        unconfirmedIds: [...previous.unconfirmedIds, value.id],
        messages: mergeOutboxMessages(previous.messages, [
          { id: value.id, role: "user", content: value.text },
        ]),
        messageDetails: [
          ...previous.messageDetails.filter((item) => item.messageId !== value.id),
          {
            messageId: value.id,
            text: value.text,
            ...(displayReplyTo && { replyTo: displayReplyTo }),
            ...(value.stickerId && { stickerId: value.stickerId }),
          },
        ],
        ...(clearDraft
          ? {
              draft: {
                text: "",
                attachmentIds: [],
                annotations: [],
                revision: previous.draft.revision + 1,
              },
            }
          : clearReply && previous.draft.replyTo?.messageId === value.replyToMessageId
            ? {
                draft: {
                  ...previous.draft,
                  replyTo: undefined,
                  revision: previous.draft.revision + 1,
                },
              }
            : {}),
      };
    });
  }
  async remove(id: string) {
    let removed = false;
    await this.commit((previous) => {
      const message = previous.pending.find((message) => message.id === id);
      if (!message) return {};
      if (message?.attempts && message.delivery !== "rejected")
        throw new Error("Delivery may already be accepted. Retry to confirm it before removing.");
      removed = true;
      return {
        pending: previous.pending.filter((message) => message.id !== id),
        unconfirmedIds: previous.unconfirmedIds.filter((value) => value !== id),
        messages: previous.messages.filter((message) => messageId(message) !== id),
        messageDetails: previous.messageDetails.filter((message) => message.messageId !== id),
      };
    });
    return removed;
  }
  async saveDraft(
    text: string,
    attachmentIds: string[],
    annotations?: AcceptedMessageInput["annotations"],
    replyTo?: MessageQuote,
  ) {
    if (
      this.state.loaded &&
      this.state.draft.text === text &&
      JSON.stringify([
        this.state.draft.attachmentIds,
        this.state.draft.annotations,
        this.state.draft.replyTo,
      ]) === JSON.stringify([attachmentIds, annotations ?? this.state.draft.annotations, replyTo])
    )
      return;
    await this.commit((previous) => ({
      draft: {
        text,
        attachmentIds,
        annotations: annotations ?? previous.draft.annotations,
        replyTo,
        revision: previous.draft.revision + 1,
      },
    }));
  }
  saveMessages(messages: readonly unknown[]): Promise<void> {
    this.pendingMessages = messages;
    this.savingMessages ??= (async () => {
      await this.open();
      // Streaming snapshots supersede each other. Drain the latest snapshot
      // rather than queueing a complete disk read/write for every token.
      while (this.pendingMessages) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const latest = this.pendingMessages;
        this.pendingMessages = undefined;
        await this.commit((previous) => {
          const confirmed = new Set(latest.map(messageId));
          const unconfirmedIds = previous.unconfirmedIds.filter((id) => !confirmed.has(id));
          const unconfirmed = new Set(unconfirmedIds);
          return {
            unconfirmedIds,
            messages: mergeOutboxMessages(
              latest.slice(-CHAT_HISTORY_PAGE_SIZE),
              previous.messages.filter((message) => {
                const id = messageId(message);
                return id !== undefined && unconfirmed.has(id);
              }),
            ),
          };
        });
      }
    })().finally(() => {
      this.savingMessages = undefined;
    });
    return this.savingMessages;
  }
  async saveMessageDetails(messages: ConversationSocialState["messages"]) {
    const wanted = new Map(this.state.messageDetails.map((item) => [item.messageId, item]));
    for (const message of messages) wanted.set(message.messageId, message);
    const next = boundedPersisted({
      ...this.state,
      messageDetails: [...wanted.values()],
    }).messageDetails;
    if (JSON.stringify(next) === JSON.stringify(this.state.messageDetails)) return;
    await this.commit((previous) => {
      const details = new Map(previous.messageDetails.map((item) => [item.messageId, item]));
      for (const message of messages) details.set(message.messageId, message);
      return { messageDetails: [...details.values()] };
    });
  }
  async applyReplay(replay: ConversationReplay) {
    if (
      !replay.snapshotRequired &&
      !replay.events.length &&
      replay.nextCursor === this.state.cursor
    )
      return;
    await this.commit((previous) => {
      const records = new Map(
        (replay.snapshotRequired ? [] : previous.events).map((event) => [event.id, event]),
      );
      for (const event of replay.events) if (!records.has(event.id)) records.set(event.id, event);
      const events = [...records.values()].sort((a, b) => a.seq - b.seq);
      let cursor = replay.snapshotRequired ? 0 : previous.cursor;
      for (const event of events) {
        if (event.seq > cursor + 1) break;
        if (event.seq === cursor + 1) cursor = event.seq;
      }
      const details = new Map(previous.messageDetails.map((item) => [item.messageId, item]));
      for (const event of replay.events) {
        if (event.kind !== "accepted") continue;
        const parsed = messageDetailsSchema.safeParse(event.payload);
        if (parsed.success) details.set(parsed.data.messageId, parsed.data);
      }
      return {
        events: events.slice(-CHAT_EVENT_CACHE_SIZE),
        cursor,
        messageDetails: [...details.values()],
      };
    });
  }
  /** An explicit server checkpoint follows a recent canonical transcript restore. */
  async checkpointReplay(replay: ConversationReplay) {
    await this.commit((previous) => {
      const details = new Map(previous.messageDetails.map((item) => [item.messageId, item]));
      for (const event of replay.events)
        if (event.kind === "accepted") {
          const parsed = messageDetailsSchema.safeParse(event.payload);
          if (parsed.success) details.set(parsed.data.messageId, parsed.data);
        }
      return {
        cursor: replay.nextCursor,
        events: replay.events.slice(-CHAT_EVENT_CACHE_SIZE),
        messageDetails: [...details.values()],
      };
    });
  }
  pause() {
    this.automaticRetry = false;
    this.update({ paused: true });
  }
  resume(automatic = false) {
    if (automatic && !this.automaticRetry) return;
    if ((this.state.pending[0]?.retryAt ?? 0) > Date.now()) return;
    this.automaticRetry = false;
    if (this.state.paused) this.update({ paused: false });
  }
  async flush(send: (message: OutboxMessage) => Promise<ConversationAcceptance | void>) {
    await this.open();
    if (
      this.state.running ||
      this.state.paused ||
      (this.state.pending[0]?.retryAt ?? 0) > Date.now()
    )
      return;
    this.update({ running: true });
    let pendingId: string | undefined;
    let priorUncertain = false;
    try {
      while (this.state.pending.length && !this.state.paused) {
        const message = this.state.pending[0];
        pendingId = message.id;
        let exists = false;
        await this.commit((previous) => ({
          pending: previous.pending.map((item) => {
            if (item.id !== message.id) return item;
            exists = true;
            // Read the persisted disposition: a retry rejection cannot resolve
            // an earlier request whose acknowledgement was lost.
            priorUncertain = item.attempts > 0 && item.delivery !== "rejected";
            return {
              ...item,
              retryAt: undefined,
              attempts: item.attempts + 1,
              delivery: "uncertain" as const,
            };
          }),
        }));
        if (!exists) continue;
        await send(message);
        // A lost ACK leaves this entry plus all later entries available after restart.
        await this.commit((previous) => ({
          pending: previous.pending.filter((item) => item.id !== message.id),
        }));
      }
    } catch (error) {
      const transient =
        !(error instanceof ApiError) ||
        [408, 425, 429].includes(error.status) ||
        error.status >= 500;
      const attempts =
        this.state.pending.find((message) => message.id === pendingId)?.attempts ?? 1;
      const delay =
        error instanceof ApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6));
      const retryAt = transient ? Date.now() + Math.max(1000, delay) : undefined;
      const delivery =
        !priorUncertain && error instanceof ApiError && error.status >= 400 && error.status < 500
          ? ("rejected" as const)
          : ("uncertain" as const);
      await this.commit((previous) => ({
        pending: previous.pending.map((message) =>
          message.id === pendingId ? { ...message, delivery, retryAt } : message,
        ),
      }));
      this.automaticRetry = transient;
      this.update({ paused: true });
      throw error;
    } finally {
      this.update({ running: false });
    }
  }
}

function messageId(message: unknown): string | undefined {
  return message && typeof message === "object" && "id" in message && typeof message.id === "string"
    ? message.id
    : undefined;
}

/** Prefer stream messages and append local messages missing from a stale snapshot. */
export function mergeOutboxMessages<T>(messages: readonly T[], local: readonly T[]): T[] {
  const ids = new Set(messages.map(messageId));
  const merged = [...messages];
  for (const message of local) {
    const id = messageId(message);
    if (id && !ids.has(id)) {
      ids.add(id);
      merged.push(message);
    }
  }
  return merged;
}

/** Set the in-flight guard synchronously, before asynchronous disk persistence starts. */
export class ComposerSubmission {
  private pending?: Promise<void>;
  submit(persistAndClear: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve()
      .then(persistAndClear)
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
export function composerKeyIsSubmit(event: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
