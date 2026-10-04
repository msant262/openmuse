import { z } from "zod";

export const reactionEmojis = ["❤️", "👍", "😂", "🎉", "😮", "😢"] as const;
export const reactionEmojiSchema = z.enum(reactionEmojis);
export const companionStickers = [
  { id: "hello", emoji: "👋", label: "Hello!", motion: "idle" },
  { id: "thanks", emoji: "❤️", label: "Thank you!", motion: "idle" },
  { id: "celebrate", emoji: "🎉", label: "Nice!", motion: "responding" },
  { id: "agreed", emoji: "👍", label: "Deal!", motion: "idle" },
  { id: "working", emoji: "💻", label: "On it", motion: "working" },
  { id: "cheer", emoji: "💪", label: "You got this!", motion: "responding" },
] as const;
export const stickerIdSchema = z.enum([
  "hello",
  "thanks",
  "celebrate",
  "agreed",
  "working",
  "cheer",
]);
export type StickerId = z.infer<typeof stickerIdSchema>;
export const messageQuoteSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    text: z.string().max(1000),
    role: z.enum(["user", "assistant"]),
  })
  .strict();
export type MessageQuote = z.infer<typeof messageQuoteSchema>;
export type MessageReaction = {
  id: string;
  threadId: string;
  messageId: string;
  actor: "user" | "assistant";
  emoji: z.infer<typeof reactionEmojiSchema> | null;
};
export type ConversationSocialState = {
  reactions: MessageReaction[];
  messages: { messageId: string; text: string; replyTo?: MessageQuote; stickerId?: StickerId }[];
};
