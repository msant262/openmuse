import { createHash } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import {
  reactionEmojiSchema,
  stickerIdSchema,
} from "../../../../packages/domain/src/conversation-social.ts";
import { runtimeId } from "../../../../packages/domain/src/runtime.ts";
import type { AgentService } from "./service.ts";

const reactionArgs = z
  .object({ messageId: runtimeId, emoji: reactionEmojiSchema.nullable() })
  .strict();
const stickerArgs = z
  .object({ stickerId: stickerIdSchema, caption: z.string().max(300).optional() })
  .strict();
const replyArgs = z
  .object({ messageId: runtimeId, text: z.string().trim().min(1).max(8000) })
  .strict();

export function companionSocialTools(
  service: AgentService,
  owner: string,
  threadId: string,
  requestKey: (name: string, value: unknown) => string,
) {
  return [
    defineTool({
      name: "react_to_message",
      description:
        "React to one of the user's messages in this conversation. Use naturally according to their SOUL/personality. A reaction is not task approval and does not replace a substantive answer. null removes your reaction.",
      parameters: reactionArgs,
      execute: async (raw) => {
        const args = reactionArgs.parse(raw);
        if (!service.social) throw new Error("Conversation reactions are unavailable");
        return service.social.react(owner, threadId, "assistant", {
          ...args,
          requestId: createHash("sha256").update(requestKey("reaction", args)).digest("hex"),
        });
      },
    }),
    defineTool({
      name: "send_sticker",
      description:
        "Send a companion sticker in this chat: hello, thanks, celebrate, agreed, working, cheer. Optional caption in the user's language and SOUL style. Be selective. The working sticker is not proof a job started; check its receipt. Do not repeat the caption in a second text reply.",
      parameters: stickerArgs,
      execute: async (args) => stickerArgs.parse(args),
    }),
    defineTool({
      name: "reply_to_message",
      description:
        "Answer an earlier message using a visible quote. The source must belong to this conversation. Write the answer in text following the person's SOUL and language. Do not repeat the answer outside this quoted reply.",
      parameters: replyArgs,
      execute: async (raw) => {
        const args = replyArgs.parse(raw);
        if (!service.social) throw new Error("Quoted replies are unavailable");
        return {
          replyTo: await service.social.quote(owner, threadId, args.messageId),
          text: args.text,
        };
      },
    }),
  ];
}
