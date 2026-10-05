import { z } from "zod";
import {
  type ConversationSocialState,
  type MessageQuote,
  type MessageReaction,
  reactionEmojiSchema,
  socialToolMessage,
} from "../../../packages/domain/src/conversation-social.ts";
import { runtimeId } from "../../../packages/domain/src/runtime.ts";
import { bindingHash, type InboxMessage } from "./conversation-inbox.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

export const reactionInput = z
  .object({
    requestId: runtimeId,
    messageId: runtimeId,
    emoji: reactionEmojiSchema.nullable(),
  })
  .strict();

export class ConversationSocial {
  constructor(
    readonly db: Store,
    readonly history: (
      owner: string,
      threadId: string,
    ) => Promise<
      {
        id: string;
        role: string;
        content?: unknown;
        toolCallId?: string;
        toolCalls?: { id: string; function: { name: string } }[];
      }[]
    >,
  ) {}

  private async requireThread(owner: string, threadId: string) {
    const thread = await this.db.get<{ deletedAt?: string }>(owner, "threads", threadId);
    if (!thread || thread.deletedAt) throw new AppError("Conversation not found", 404);
  }

  async quote(owner: string, threadId: string, messageId: string): Promise<MessageQuote> {
    runtimeId.parse(messageId);
    await this.requireThread(owner, threadId);
    const original = await this.db.get<InboxMessage>(
      owner,
      "conversation-inbox",
      `${threadId}:${messageId}`,
    );
    if (original?.threadId === threadId && original.messageId === messageId)
      return { messageId, role: "user", text: original.text.slice(0, 1000) };
    const history = await this.history(owner, threadId);
    const call = history
      .flatMap((item) => (item.role === "assistant" ? (item.toolCalls ?? []) : []))
      .find((item) => item.id === messageId);
    if (call) {
      const receipt = history.find((item) => item.role === "tool" && item.toolCallId === call.id);
      const message = socialToolMessage(call.function.name, receipt?.content);
      if (message) return { messageId, role: "assistant", text: message.text.slice(0, 1000) };
    }
    const source = history.find((item) => item.id === messageId);
    if (
      !source ||
      !["user", "assistant"].includes(source.role) ||
      typeof source.content !== "string"
    )
      throw new AppError("This message is no longer in this conversation", 404);
    return {
      messageId,
      role: source.role as MessageQuote["role"],
      text: source.content.slice(0, 1000),
    };
  }

  async react(owner: string, threadId: string, actor: MessageReaction["actor"], raw: unknown) {
    const input = reactionInput.parse(raw);
    const source = await this.quote(owner, threadId, input.messageId);
    if (actor === "assistant" && source.role !== "user")
      throw new AppError("React to a user message", 422);
    const id = `${threadId}:${input.messageId}:${actor}`;
    const reaction: MessageReaction = {
      id,
      threadId,
      messageId: input.messageId,
      actor,
      emoji: input.emoji,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.db.get<MessageReaction>(owner, "message-reactions", id);
      const result = await this.db.durableMutation(
        owner,
        `reaction:${actor}:${input.requestId}`,
        bindingHash({ threadId, messageId: input.messageId, actor, emoji: input.emoji }),
        [
          {
            kind: "message-reactions",
            id,
            mode: existing ? "merge" : "insert",
            value: reaction,
          },
        ],
      );
      if (result.status === "thread_deleted") throw new AppError("Conversation not found", 404);
      if (result.status === "applied" || result.status === "duplicate")
        return this.db.get<MessageReaction>(owner, "message-reactions", id);
      // Concurrent first reactions may both observe no row. Retry the losing insert as a merge.
      if (result.status !== "revision_conflict") break;
    }
    throw new AppError("This reaction request changed. Try again.", 409);
  }

  async state(owner: string, threadId: string): Promise<ConversationSocialState> {
    await this.requireThread(owner, threadId);
    const [reactions, messages] = await Promise.all([
      this.db.list<MessageReaction>(owner, "message-reactions"),
      this.db.list<InboxMessage>(owner, "conversation-inbox"),
    ]);
    return {
      reactions: reactions.filter((item) => item.threadId === threadId && item.emoji),
      messages: messages
        .filter((item) => item.threadId === threadId && (item.replyTo || item.stickerId))
        .map(({ messageId, text, replyTo, stickerId }) => ({
          messageId,
          text,
          replyTo,
          stickerId,
        })),
    };
  }
}
