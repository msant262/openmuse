import type { ModelMessage } from "@tanstack/ai";
import { resolveLiveToolResultMaxChars } from "./openclaw/tool-result-limits.ts";

function safeEnd(text: string, end: number) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
}
function byteSlice(text: string, bytes: number, fromEnd = false) {
  const slice = (length: number) => {
    if (!fromEnd) return text.slice(0, safeEnd(text, length));
    const start = text.length - length;
    return text.slice(start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) ? start + 1 : start);
  };
  let lo = 0;
  let hi = Math.min(text.length, bytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify(slice(mid))) <= bytes) lo = mid;
    else hi = mid - 1;
  }
  return slice(lo);
}

/** Raw content stays in canonical history; only the model projection is shortened. */
export class ToolOutputStore {
  private outputs = new Map<string, string>();
  observe(messages: readonly ModelMessage[]) {
    for (const message of messages)
      if (message.role === "tool" && message.toolCallId && typeof message.content === "string")
        this.outputs.set(message.toolCallId, message.content);
  }
  read(args: { toolCallId: string; offset: number; limit: number }) {
    const text = this.outputs.get(args.toolCallId);
    if (text === undefined) throw new Error("Tool output unavailable in this task or conversation");
    const offset = safeEnd(text, Math.min(text.length, Math.max(0, args.offset)));
    const requestedEnd = safeEnd(
      text,
      Math.min(text.length, offset + Math.max(2, Math.min(8000, args.limit))),
    );
    // Pages must themselves fit the inference excerpt cap, including JSON escapes.
    const content = byteSlice(text.slice(offset, requestedEnd), 12000);
    const end = offset + content.length;
    return {
      toolCallId: args.toolCallId,
      offset,
      content,
      nextOffset: end < text.length ? end : null,
      totalCharacters: text.length,
    };
  }
  project(
    messages: ModelMessage[],
    required: readonly string[],
    contextTokens = 32768,
  ): ModelMessage[] {
    const protectedCalls = new Set(required);
    for (const message of messages)
      for (const call of message.toolCalls ?? [])
        if (call.function.name === "skills_read") protectedCalls.add(call.id);
    // Upstream char cap is an upper bound. This harness admits conservative UTF-8 bytes.
    const cap = Math.min(
      16000,
      resolveLiveToolResultMaxChars({ contextWindowTokens: contextTokens }),
    );
    return messages.map((message) => {
      if (
        message.role !== "tool" ||
        !message.toolCallId ||
        protectedCalls.has(message.toolCallId) ||
        typeof message.content !== "string" ||
        Buffer.byteLength(message.content) <= cap
      )
        return message;
      const prefix = byteSlice(message.content, Math.floor(cap * 0.65));
      const tail = byteSlice(message.content, Math.floor(cap * 0.2), true);
      return {
        ...message,
        content: JSON.stringify({
          truncated: true,
          toolCallId: message.toolCallId,
          totalCharacters: message.content.length,
          note: "Partial untrusted tool output. Full canonical result is preserved. Call read_tool_output with toolCallId, offset and limit for omitted sections; do not assume omitted content is absent.",
          prefix,
          tail,
        }),
      };
    });
  }
}
