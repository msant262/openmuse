import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { MessageQuote } from "../../../packages/domain/src/conversation-social.ts";
import {
  type AcceptedMessageInput,
  acceptedMessageSchema,
  type ConversationAcceptance,
  type ConversationReplay,
  conversationEventSchema,
  type TaskMailbox,
  taskMailboxSchema,
} from "../../../packages/domain/src/runtime.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const bindingHash = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
/** Shared with the mobile SHA-256 implementation; excludes client/thread IDs and the claimed hash. */
export function messageContentHash(value: {
  text: string;
  attachmentIds?: string[];
  targetTaskId?: string;
  annotations?: AcceptedMessageInput["annotations"];
  replyToMessageId?: string;
  stickerId?: string;
}) {
  return bindingHash({
    text: value.text.trim(),
    attachmentIds: value.attachmentIds ?? [],
    targetTaskId: value.targetTaskId ?? null,
    annotations: value.annotations ?? [],
    ...(value.replyToMessageId && { replyToMessageId: value.replyToMessageId }),
    ...(value.stickerId && { stickerId: value.stickerId }),
  });
}
export type InboxMessage = AcceptedMessageInput & {
  replyTo?: MessageQuote;
  id: string;
  messageId: string;
  runId: string;
  createdAt: string;
  status: "accepted" | "dispatching" | "finished" | "interrupted";
  retryAfter?: string | null;
  dispatchFailures?: number;
  lastDeliveryError?: {
    code: string;
    message: string;
    retryable: boolean;
    runId: string;
    messageId: string;
  };
};
export class ConversationInbox {
  resolveQuote?: (owner: string, threadId: string, messageId: string) => Promise<MessageQuote>;
  /** Scheduler/mailbox adapter: acceptance stays durable if delivery is interrupted. */
  onAccepted?: (owner: string, message: InboxMessage) => void;
  private readonly acceptedListeners = new Set<(owner: string, message: InboxMessage) => void>();
  private validateAnnotations?: (
    owner: string,
    threadId: string,
    clientMessageId: string,
    attachmentIds: string[],
    annotations: NonNullable<AcceptedMessageInput["annotations"]>,
  ) => Promise<NonNullable<AcceptedMessageInput["annotations"]>>;
  configureAnnotationValidator(validator: NonNullable<ConversationInbox["validateAnnotations"]>) {
    this.validateAnnotations = validator;
  }
  subscribeAccepted(listener: (owner: string, message: InboxMessage) => void) {
    this.acceptedListeners.add(listener);
    return () => this.acceptedListeners.delete(listener);
  }
  private accepted(owner: string, message: InboxMessage) {
    this.onAccepted?.(owner, message);
    for (const listener of this.acceptedListeners) listener(owner, message);
  }
  constructor(
    private readonly db: Store,
    private readonly validateAttachment?: (owner: string, id: string) => Promise<unknown>,
  ) {}
  async acceptMessage(
    owner: string,
    raw: unknown,
    attempt = 0,
    expectedRevision?: number,
  ): Promise<ConversationAcceptance> {
    const input = acceptedMessageSchema.parse(raw);
    if (messageContentHash(input) !== input.contentHash)
      throw new AppError("Message content hash does not match", 422);
    const id = `${input.threadId}:${input.clientMessageId}`;
    // ACK-loss confirmation uses the accepted binding even after referenced objects change.
    const previous = await this.db.get<InboxMessage>(owner, "conversation-inbox", id);
    if (previous) {
      if (previous.contentHash !== input.contentHash)
        throw new AppError("This message ID was already accepted with different content", 409);
      this.accepted(owner, previous);
      return { messageId: previous.messageId, runId: previous.runId, duplicate: true };
    }
    for (const attachmentId of input.attachmentIds)
      await this.validateAttachment?.(owner, attachmentId);
    let targetTask: { id: string; status: string; state: Record<string, unknown> } | undefined;
    if (input.targetTaskId) {
      const foundTask = await this.db.get<{
        id: string;
        status: string;
        state: Record<string, unknown>;
      }>(owner, "tasks", input.targetTaskId);
      if (!foundTask) throw new AppError("Task not found", 404);
      targetTask = foundTask;
      if (
        expectedRevision !== undefined &&
        Number(targetTask.state?.desiredRevision ?? 0) !== expectedRevision
      )
        throw new AppError("Task direction changed; refresh before sending", 409);
    }
    const validatedAnnotations = await this.validateAnnotations?.(
      owner,
      input.threadId,
      input.clientMessageId,
      input.attachmentIds,
      input.annotations,
    );
    if (validatedAnnotations) input.annotations = validatedAnnotations;
    const replyTo = input.replyToMessageId
      ? await this.resolveQuote?.(owner, input.threadId, input.replyToMessageId)
      : undefined;
    if (input.replyToMessageId && !replyTo)
      throw new AppError("Quoted replies are unavailable", 409);
    const message: InboxMessage = {
      ...input,
      ...(replyTo && { replyTo }),
      id,
      messageId: input.clientMessageId,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "accepted",
    };
    const mutations: Parameters<Store["durableMutation"]>[3] = [
      { kind: "conversation-inbox", id, mode: "insert", value: message },
    ];
    const events: Parameters<Store["durableMutation"]>[4] = [
      {
        id: `accepted:${id}`,
        threadId: input.threadId,
        runId: message.runId,
        origin: "user",
        kind: "accepted",
        payload: message,
      },
    ];
    if (input.targetTaskId) {
      const task = targetTask;
      if (!task) throw new AppError("Task not found", 404);
      const existingMail = (await this.db.list<TaskMailbox>(owner, "task-mailbox")).filter(
        (item) => item.taskId === task.id,
      );
      const seq = Math.max(0, ...existingMail.map((item) => item.seq)) + 1;
      const directive: TaskMailbox = taskMailboxSchema.parse({
        id: `directive:${id}`,
        directiveId: `directive:${id}`,
        taskId: task.id,
        clientMessageId: input.clientMessageId,
        messageId: message.messageId,
        threadId: input.threadId,
        seq,
        desiredRevision:
          Math.max(
            Number(task.state?.desiredRevision ?? 0),
            ...existingMail.map((item) => item.desiredRevision),
            0,
          ) + 1,
        status: ["succeeded", "failed", "cancelled"].includes(task.status)
          ? "completed_before_apply"
          : "received",
        text: input.text,
        attachmentIds: input.attachmentIds,
        annotations: input.annotations,
      });
      // Task state is the mailbox sequence CAS. Retry admission if another directive won.
      mutations.push({
        kind: "tasks",
        id: task.id,
        mode: "merge",
        expected: { state: task.state, status: task.status },
        value: {
          state: { ...task.state, desiredRevision: directive.desiredRevision, mailboxSeq: seq },
        },
      });
      mutations.push({ kind: "task-mailbox", id: directive.id, mode: "insert", value: directive });
      events.push({
        id: directive.id,
        threadId: input.threadId,
        runId: message.runId,
        origin: "user",
        kind: "directive",
        payload: directive,
      });
    }
    const result = await this.db.durableMutation<InboxMessage>(
      owner,
      `message:${id}`,
      bindingHash(input),
      mutations,
      events,
    );
    if (result.status === "thread_deleted")
      throw new AppError("This conversation was deleted. Start a new conversation.", 410);
    if (result.status === "binding_conflict")
      throw new AppError("This message ID was already accepted with different content", 409);
    if (result.status === "revision_conflict") {
      // A concurrent mailbox revision can be retried without accepting two messages.
      const previous = await this.db.get<InboxMessage>(owner, "conversation-inbox", id);
      if (previous) throw new AppError("Message changed; retry with its original content", 409);
      if (attempt >= 7)
        throw new AppError(
          "Task is changing rapidly; your message was not yet accepted. Retry shortly.",
          409,
        );
      return this.acceptMessage(owner, input, attempt + 1, expectedRevision);
    }
    const saved = result.values[0];
    this.accepted(owner, saved);
    return {
      messageId: saved.messageId,
      runId: saved.runId,
      duplicate: result.status === "duplicate",
    };
  }
  async eventsAfter(
    owner: string,
    threadId: string,
    rawCursor = 0,
    options: { latest?: boolean; summary?: boolean } = {},
  ): Promise<ConversationReplay> {
    const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(rawCursor);
    const result = await this.db.conversationEvents(
      owner,
      threadId,
      cursor,
      options.summary ? 200 : 500,
      options,
    );
    const events = result.events.map((event) => conversationEventSchema.parse(event));
    return {
      events,
      nextCursor: options.latest
        ? result.head
        : (events.at(-1)?.seq ?? Math.min(cursor, result.head)),
      snapshotRequired: !options.latest && cursor > result.head,
    };
  }
  pending() {
    return this.db.pendingInbox<InboxMessage>(new Date().toISOString());
  }
  async get(owner: string, threadId: string, messageId: string) {
    return this.db.get<InboxMessage>(owner, "conversation-inbox", `${threadId}:${messageId}`);
  }
  async mark(
    owner: string,
    id: string,
    expected: InboxMessage["status"],
    status: InboxMessage["status"],
  ) {
    return this.db.compareAndSwap<InboxMessage>(
      owner,
      "conversation-inbox",
      id,
      { status: expected },
      { status },
    );
  }
}
