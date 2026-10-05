import { z } from "zod";

export const reactionEmojis = ["❤️", "👍", "😂", "🎉", "😮", "😢"] as const;
export const reactionEmojiSchema = z
  .string()
  .max(32)
  .refine(
    (value) =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1 &&
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value),
    "Use one emoji",
  );
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

export const gifMessageSchema = z
  .object({
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Use a public HTTPS GIF URL"),
    alt: z.string().trim().min(1).max(300),
    caption: z.string().max(300).optional(),
  })
  .strict();
export type GifMessage = z.infer<typeof gifMessageSchema>;

/** Only successful, typed social receipts become visible conversation messages. */
export function socialToolMessage(
  name: string,
  raw: unknown,
):
  | {
      text: string;
      replyTo?: MessageQuote;
      stickerId?: StickerId;
      gif?: GifMessage;
    }
  | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (name === "reply_to_message") {
      const reply = z
        .object({ replyTo: messageQuoteSchema, text: z.string().min(1) })
        .strict()
        .parse(value);
      return reply;
    }
    if (name === "send_sticker") {
      const sticker = z
        .object({ stickerId: stickerIdSchema, caption: z.string().optional() })
        .strict()
        .parse(value);
      return {
        ...sticker,
        text: sticker.caption ?? companionStickers.find((s) => s.id === sticker.stickerId)!.label,
      };
    }
    if (name === "send_gif") {
      const gif = gifMessageSchema.parse(value);
      return { text: gif.caption ?? gif.alt, gif };
    }
  } catch {
    /* Incomplete/error receipts are not messages. */
  }
}
