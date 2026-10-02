import { z } from "zod";
import {
  type AcceptedMessageInput,
  acceptedMessageSchema,
  type ConversationAcceptance,
  type ConversationEvent,
  type ConversationReplay,
  conversationEventSchema,
} from "../../../packages/domain/src/runtime";
import { hashMessageContent } from "./message-hash";
import type { MessageStorage } from "./message-storage";

export type OutboxMessage = Omit<AcceptedMessageInput, "clientMessageId"> & {
  id: string;
  attempts: number;
};
type Persisted = {
  version: 1;
  pending: OutboxMessage[];
  cursor: number;
  events: ConversationEvent[];
  draft: { text: string; attachmentIds: string[]; revision: number };
  messages: unknown[];
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
  draft: { text: "", attachmentIds: [], revision: 0 },
  messages: [],
  loaded: false,
  running: false,
  paused: false,
  error: "",
});
const savedOutboxSchema = z
  .object({
    version: z.literal(1),
    pending: z.array(
      acceptedMessageSchema.omit({ clientMessageId: true }).extend({
        id: acceptedMessageSchema.shape.clientMessageId,
        attempts: z.number().int().min(0),
      }),
    ),
    cursor: z.number().int().min(0),
    events: z.array(conversationEventSchema),
    draft: z.object({
      text: z.string(),
      attachmentIds: z.array(acceptedMessageSchema.shape.clientMessageId),
      revision: z.number().int().min(0),
    }),
    messages: z.array(z.unknown()),
  })
  .strict();
export class MessageOutbox {
  private state = empty();
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private opening?: Promise<void>;
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
    const { version, pending, cursor, events, draft, messages } = parsed;
    return { version, pending, cursor, events, draft, messages };
  }
  open() {
    this.opening ??= this.storage
      .read(this.key)
      .then((raw) => {
        if (raw) {
          const parsed = this.decode(raw);
          this.update(parsed);
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
        return JSON.stringify(record);
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
  }) {
    const { clearDraft, ...input } = message;
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
        ...(clearDraft
          ? { draft: { text: "", attachmentIds: [], revision: previous.draft.revision + 1 } }
          : {}),
      };
    });
  }
  async remove(id: string) {
    await this.commit((previous) => {
      if (previous.pending.find((message) => message.id === id)?.attempts)
        throw new Error("Delivery may already be accepted. Retry to confirm it before removing.");
      return { pending: previous.pending.filter((message) => message.id !== id) };
    });
  }
  async saveDraft(text: string, attachmentIds: string[]) {
    await this.commit((previous) => ({
      draft: { text, attachmentIds, revision: previous.draft.revision + 1 },
    }));
  }
  async saveMessages(messages: readonly unknown[]) {
    await this.commit(() => ({ messages: [...messages] }));
  }
  async applyReplay(replay: ConversationReplay) {
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
      return { events, cursor };
    });
  }
  pause() {
    this.update({ paused: true });
  }
  resume() {
    this.update({ paused: false });
  }
  async flush(send: (message: OutboxMessage) => Promise<ConversationAcceptance | void>) {
    await this.open();
    if (this.state.running || this.state.paused) return;
    this.update({ running: true });
    try {
      while (this.state.pending.length && !this.state.paused) {
        const message = this.state.pending[0];
        await this.commit((previous) => ({
          pending: previous.pending.map((item) =>
            item.id === message.id ? { ...item, attempts: item.attempts + 1 } : item,
          ),
        }));
        await send(message);
        // A lost ACK leaves this entry plus all later entries available after restart.
        await this.commit((previous) => ({
          pending: previous.pending.filter((item) => item.id !== message.id),
        }));
      }
    } catch (error) {
      this.update({ paused: true });
      throw error;
    } finally {
      this.update({ running: false });
    }
  }
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
