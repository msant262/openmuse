import { randomUUID } from "node:crypto";
import { type Message, MessageSchema } from "@ag-ui/core";
import type { ModelMessage } from "@tanstack/ai";
import { z } from "zod";
import { modelAdmissionSchema } from "../providers/admission-diagnostics.ts";

/** Public tool history only: credentials, model thinking, media bytes and metadata
 * are deliberately absent. Images are reacquired by owned reference when needed. */
export function publicJournalValue(value: unknown, maxStringCharacters = 32000): unknown {
  if (Array.isArray(value))
    return value.slice(0, 1000).map((item) => publicJournalValue(item, maxStringCharacters));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/password|senha|secret|segredo|credential|credencial|(?:access|refresh|auth|api)[_-]?(?:token|key)|cookie|authorization|thinking|reasoning|base64/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, publicJournalValue(item, maxStringCharacters)]),
    );
  if (typeof value !== "string") return value;
  let text = value.slice(0, maxStringCharacters);
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      secret &&
      secret.length >= 8 &&
      /password|secret|(?:access|refresh|auth|api)[_-]?(?:token|key)|computer_token/i.test(key)
    )
      text = text.replaceAll(secret, "[redacted]");
  }
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]");
}
/** Only local document authoring accepts a 120k source. Other argument strings
 * retain their existing bound; source text still receives normal secret scrubbing. */
export function publicToolArguments(name: string, args: unknown): unknown {
  const value = publicJournalValue(args);
  if (
    name === "create_document" &&
    args &&
    typeof args === "object" &&
    "content" in args &&
    typeof args.content === "string" &&
    value &&
    typeof value === "object"
  )
    return { ...value, content: publicJournalValue(args.content, 120000) };
  return value;
}
export function completedMessages(raw: unknown): Message[] {
  const input = z.array(z.unknown()).parse(raw);
  const messages = input.map((value): Message => {
    const parsed = MessageSchema.parse(value);
    if (!["user", "assistant", "tool"].includes(parsed.role))
      throw new Error("Invalid task history role");
    let content = Array.isArray(parsed.content)
      ? parsed.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : parsed.content;
    if (parsed.role === "tool" && content) {
      if (typeof content !== "string") content = JSON.stringify(publicJournalValue(content));
      else
        try {
          content = JSON.stringify(publicJournalValue(JSON.parse(content)));
        } catch {
          /* Text receipts are bounded below. */
        }
    }
    return MessageSchema.parse({
      id: parsed.id,
      role: parsed.role,
      content: typeof content === "string" ? publicJournalValue(content) : content,
      ...(parsed.role === "assistant" && parsed.toolCalls
        ? {
            toolCalls: parsed.toolCalls.map((call) => {
              let args: unknown;
              try {
                args = JSON.parse(call.function.arguments);
              } catch {
                throw new Error("Incomplete tool arguments cannot enter a checkpoint");
              }
              return {
                id: call.id,
                type: "function",
                function: {
                  name: call.function.name,
                  arguments: JSON.stringify(publicToolArguments(call.function.name, args)),
                },
              };
            }),
          }
        : {}),
      ...(parsed.role === "tool" ? { toolCallId: parsed.toolCallId } : {}),
    });
  });
  const calls = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls?.map((call) => call.id) ?? []) : [],
    ),
  );
  const receipts = new Set(
    messages.flatMap((message) =>
      message.role === "tool" && calls.has(message.toolCallId) ? [message.toolCallId] : [],
    ),
  );
  return messages
    .filter((message) => message.role !== "tool" || calls.has(message.toolCallId))
    .map((message) =>
      message.role === "assistant" && message.toolCalls
        ? { ...message, toolCalls: message.toolCalls.filter((call) => receipts.has(call.id)) }
        : message,
    )
    .filter(
      (message) =>
        message.role !== "assistant" ||
        Boolean(message.content) ||
        Boolean(message.toolCalls?.length),
    );
}
export function modelHistory(messages: ModelMessage[]): Message[] {
  return completedMessages(
    messages.map((message) => ({
      id: message.id ?? randomUUID(),
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => ("content" in part ? part.content : ""))
              .join("\n"),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
    })),
  );
}
/** Exact additive M5 v1 envelope. Producer reuses/re-exports this seam after merge. */
export const providerContinuationCheckpointSchema = z
  .object({
    version: z.literal(1),
    messages: z.unknown().transform(completedMessages),
    partialText: z.string().transform((value) => publicJournalValue(value) as string),
    rejectedModel: z.string().min(1),
    accepted: z.boolean(),
    code: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    retryAt: z.iso.datetime().optional(),
    admission: modelAdmissionSchema.optional(),
  })
  .strict();
export type ProviderContinuationCheckpoint = z.infer<typeof providerContinuationCheckpointSchema>;
