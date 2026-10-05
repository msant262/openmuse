import { createHash } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import {
  gifMessageSchema,
  reactionEmojiSchema,
  stickerIdSchema,
} from "../../../../packages/domain/src/conversation-social.ts";
import { runtimeId } from "../../../../packages/domain/src/runtime.ts";
import { findConversationGifs } from "../companion-gifs.ts";
import type { AgentService } from "./service.ts";

const reactionArgs = z
  .object({ messageId: runtimeId.optional(), emoji: reactionEmojiSchema.nullable() })
  .strict();
const stickerArgs = z
  .object({ stickerId: stickerIdSchema, caption: z.string().max(300).optional() })
  .strict();
const replyArgs = z
  .object({ messageId: runtimeId.optional(), text: z.string().trim().min(1).max(8000) })
  .strict();

export function companionSocialTools(
  service: AgentService,
  owner: string,
  threadId: string,
  requestKey: (name: string, value: unknown) => string,
  currentMessageId?: string,
  signal?: AbortSignal,
) {
  return [
    defineTool({
      name: "react_to_message",
      description:
        "React to a message with a single emoji, like a tapback. Defaults to the user's current message; supply messageId for an earlier one. Reach for it when a person would: warmth, humor, agreement, acknowledgment, following the SOUL. The emoji appears on the bubble: never narrate or explain the reaction. One reaction per message; another replaces yours, null removes it. This does not approve work or replace requested results.",
      parameters: reactionArgs,
      execute: async (raw) => {
        const args = reactionArgs.parse(raw);
        if (!service.social) throw new Error("Conversation reactions are unavailable");
        return service.social.react(owner, threadId, "assistant", {
          ...args,
          messageId: runtimeId.parse(args.messageId ?? currentMessageId),
          requestId: createHash("sha256").update(requestKey("reaction", args)).digest("hex"),
        });
      },
    }),
    defineTool({
      name: "send_sticker",
      description:
        "Send an animated companion sticker in this chat: hello, thanks, celebrate, agreed, working, cheer. Express yourself according to the SOUL using a sticker when it fits the conversation. Optional caption in the user's language. The working sticker is not proof a job started; check its receipt. Do not repeat the caption in a second text reply.",
      parameters: stickerArgs,
      execute: async (args) => stickerArgs.parse(args),
    }),
    defineTool({
      name: "search_gifs",
      description:
        "Find a few GIFs that match a reaction or mood. Returns actual public image URLs for send_gif. Choose expressive media according to the SOUL; no need to ask the user to find the URL.",
      parameters: z.object({ query: z.string().trim().min(1).max(150) }).strict(),
      execute: ({ query }) =>
        findConversationGifs(service.search, service.web, owner, query, signal),
    }),
    defineTool({
      name: "send_gif",
      description:
        "Send a GIF in this conversation from a public HTTPS image URL supplied by the user or found in an actual source. Include an accessible description and optional SOUL-style caption. Never invent a GIF URL. Animated companion stickers are available without a URL through send_sticker.",
      parameters: gifMessageSchema,
      execute: async (raw) => {
        const gif = gifMessageSchema.parse(raw);
        await service.web.validate(gif.url);
        return gif;
      },
    }),
    defineTool({
      name: "reply_to_message",
      description:
        "Reply with a visible quote of the user's current message, or supply messageId to answer an earlier message. Write the answer in the SOUL's voice. This sends the answer itself: do not repeat it outside this quoted reply.",
      parameters: replyArgs,
      execute: async (raw) => {
        const args = replyArgs.parse(raw);
        if (!service.social) throw new Error("Quoted replies are unavailable");
        return {
          replyTo: await service.social.quote(
            owner,
            threadId,
            runtimeId.parse(args.messageId ?? currentMessageId),
          ),
          text: args.text,
        };
      },
    }),
  ];
}
