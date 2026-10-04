import { createHash } from "node:crypto";
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
  private documentArguments = new Map<string, string>();
  observe(messages: readonly ModelMessage[]) {
    for (const message of messages)
      if (message.role === "tool" && message.toolCallId && typeof message.content === "string")
        this.outputs.set(message.toolCallId, message.content);
    for (const document of this.documents(messages))
      if (!document.args._historyProjection)
        this.documentArguments.set(document.id, document.arguments);
  }
  /** Both the call and its successful server artifact receipt must agree. An
   * attempted replacement or another tool's similarly shaped output is no proof. */
  private documents(messages: readonly ModelMessage[]) {
    const calls = new Map<string, { arguments: string; args: Record<string, unknown> }>();
    const documents: Array<{
      id: string;
      fileId: string;
      replacesFileId?: string;
      arguments: string;
      args: Record<string, unknown>;
    }> = [];
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.function.name !== "create_document") continue;
        try {
          const args = JSON.parse(call.function.arguments);
          if (args && typeof args === "object" && typeof args.content === "string")
            calls.set(call.id, { arguments: call.function.arguments, args });
        } catch {
          /* Incomplete or invalid arguments are never projected. */
        }
      }
      if (message.role !== "tool" || !message.toolCallId || typeof message.content !== "string")
        continue;
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      try {
        const receipt = JSON.parse(message.content);
        if (
          receipt?.attachment !== true ||
          receipt.error ||
          receipt.skipped ||
          receipt.outcomeUnknown ||
          receipt.paused ||
          receipt.dispatched === false ||
          (receipt.status !== undefined && receipt.status !== "succeeded") ||
          !/^[a-f0-9]{64}$/i.test(receipt.fileId ?? "") ||
          ![
            "application/pdf",
            "text/plain",
            "text/markdown",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ].includes(receipt.mimeType)
        )
          continue;
        documents.push({
          id: message.toolCallId,
          ...call,
          fileId: receipt.fileId,
          ...(typeof call.args.replaceFileId === "string" &&
          receipt.replacesFileId === call.args.replaceFileId
            ? { replacesFileId: receipt.replacesFileId }
            : {}),
        });
      } catch {
        /* Only structured successful receipts establish a replacement. */
      }
    }
    return documents;
  }
  read(args: { toolCallId: string; part?: "result" | "arguments"; offset: number; limit: number }) {
    const text = (args.part === "arguments" ? this.documentArguments : this.outputs).get(
      args.toolCallId,
    );
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
      ...(args.part === "arguments"
        ? {
            part: "arguments",
            source: "recorded_call_arguments",
            note: "Public arguments preserved in this task. Older journal versions may have bounded authoring text; this read does not recover text absent from the record.",
          }
        : {}),
    };
  }
  project(
    messages: ModelMessage[],
    required: readonly string[],
    contextTokens = 32768,
  ): ModelMessage[] {
    const protectedCalls = new Set(required);
    const documents = this.documents(messages);
    const created = new Map<string, Set<string>>();
    const superseded = new Set<string>();
    for (const document of documents) {
      const previous = document.replacesFileId && created.get(document.replacesFileId);
      if (previous && document.fileId !== document.replacesFileId)
        for (const id of previous) superseded.add(id);
      const ids = created.get(document.fileId) ?? new Set<string>();
      ids.add(document.id);
      created.set(document.fileId, ids);
    }
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
        message.role === "assistant" &&
        message.toolCalls?.some((call) => superseded.has(call.id))
      ) {
        return {
          ...message,
          toolCalls: message.toolCalls.map((call) => {
            if (!superseded.has(call.id)) return call;
            const source = this.documentArguments.get(call.id);
            if (!source) return call;
            const args = JSON.parse(source);
            if (args.content.length <= 1024) return call;
            return {
              ...call,
              function: {
                ...call.function,
                arguments: JSON.stringify({
                  ...args,
                  content:
                    "[Superseded document source omitted from this history view; canonical arguments remain available with read_tool_output(part=arguments).]",
                  _historyProjection: {
                    kind: "superseded_document_source",
                    toolCallId: call.id,
                    sourceCharacters: args.content.length,
                    sourceSha256: createHash("sha256").update(args.content).digest("hex"),
                  },
                }),
              },
            };
          }),
        };
      }
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
