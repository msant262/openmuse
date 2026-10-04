import { createHash } from "node:crypto";
import type { ModelMessage } from "@tanstack/ai";
import { resolveLiveToolResultMaxChars } from "./openclaw/tool-result-limits.ts";

// Recognize only this known procedural instruction. Future warnings or page-
// specific guidance in the field must remain verbatim, even for an older draft.
const historicalInspectionInstruction =
  "Examine the actual page image for clipping, overlap, readability, hierarchy and data accuracy. Use confirm_document_review in the next turn. Correct a failed draft with create_document.replaceFileId and a fresh operationId, then inspect its new bytes.";

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
  private projectionDependencies: { toolCallId: string; dependsOnToolCallId: string }[] = [];
  dependencies(): readonly { toolCallId: string; dependsOnToolCallId: string }[] {
    return this.projectionDependencies;
  }
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
  private duplicateSkills(messages: readonly ModelMessage[], required: readonly string[]) {
    const requiredIds = new Set(required),
      mandatoryCalls = new Set<string>();
    const calls = new Map<string, string>();
    for (const message of messages) {
      if (message.toolCalls?.some((call) => requiredIds.has(call.id)))
        for (const call of message.toolCalls) mandatoryCalls.add(call.id);
      for (const call of message.toolCalls ?? []) {
        if (call.function.name !== "skills_read") continue;
        try {
          calls.set(call.id, JSON.parse(call.function.arguments).id);
        } catch {
          /* Invalid calls are unchanged. */
        }
      }
    }
    const groups = new Map<
      string,
      { id: string; raw: string; receipt: Record<string, unknown> }[]
    >();
    for (const message of messages) {
      if (message.role !== "tool" || !message.toolCallId || !calls.has(message.toolCallId))
        continue;
      const raw = this.outputs.get(message.toolCallId);
      if (!raw) continue;
      try {
        const receipt = JSON.parse(raw);
        if (
          receipt?.error ||
          receipt.skipped ||
          receipt.outcomeUnknown ||
          receipt.paused ||
          receipt.dispatched === false ||
          (receipt.status !== undefined && receipt.status !== "succeeded") ||
          receipt.id !== calls.get(message.toolCallId) ||
          !/^(builtin|operator):[a-z0-9][a-z0-9-]{0,63}$/.test(receipt.id) ||
          receipt.source !== receipt.id.split(":")[0] ||
          receipt.authority !== "workflow_guidance" ||
          receipt.truncated !== false ||
          typeof receipt.content !== "string" ||
          Buffer.byteLength(receipt.content) > 32768 ||
          createHash("sha256").update(receipt.content).digest("hex") !== receipt.sha256
        )
          continue;
        // Byte-identical whole receipts also preserve policy/provenance changes.
        const key = createHash("sha256").update(raw).digest("hex");
        const group = groups.get(key) ?? [];
        group.push({ id: message.toolCallId, raw, receipt });
        groups.set(key, group);
      } catch {
        /* Unverified or projected content is never deduplicated. */
      }
    }
    const duplicates = new Map<string, string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Do not increase mandatory context by pulling in a formerly optional group.
      const keeper = group.findLast((entry) => mandatoryCalls.has(entry.id)) ?? group.at(-1);
      if (!keeper) continue;
      for (const entry of group) {
        if (entry.id === keeper.id) continue;
        const content = JSON.stringify({
          ...entry.receipt,
          content: `[Identical complete workflow retained at toolCallId ${keeper.id}. Read the original result with read_tool_output if needed.]`,
          _historyProjection: {
            kind: "duplicate_skill_read",
            identicalToToolCallId: keeper.id,
            sourceBytes: Buffer.byteLength(String(entry.receipt.content)),
          },
        });
        if (Buffer.byteLength(content) >= Buffer.byteLength(entry.raw)) continue;
        duplicates.set(entry.id, content);
        this.projectionDependencies.push({ toolCallId: entry.id, dependsOnToolCallId: keeper.id });
      }
    }
    return duplicates;
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
    this.projectionDependencies = [];
    const duplicates = this.duplicateSkills(messages, required);
    const protectedCalls = new Set(required);
    const inspectionCalls = new Map<string, string>();
    for (const message of messages)
      for (const call of message.toolCalls ?? [])
        if (call.function.name === "inspect_document") {
          try {
            inspectionCalls.set(call.id, JSON.parse(call.function.arguments).fileId);
          } catch {
            /* Leave invalid calls untouched. */
          }
        }
    const documents = this.documents(messages);
    const created = new Map<string, Set<string>>();
    const superseded = new Set<string>();
    const supersededFiles = new Set<string>();
    for (const document of documents) {
      const previous = document.replacesFileId && created.get(document.replacesFileId);
      if (previous && document.fileId !== document.replacesFileId) {
        for (const id of previous) superseded.add(id);
        supersededFiles.add(document.replacesFileId as string);
      }
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
      if (message.role === "tool" && message.toolCallId) {
        const duplicate = duplicates.get(message.toolCallId);
        if (duplicate) return { ...message, content: duplicate };
        const fileId = inspectionCalls.get(message.toolCallId);
        if (fileId && supersededFiles.has(fileId) && typeof message.content === "string") {
          try {
            const receipt = JSON.parse(message.content);
            const instruction = "Superseded draft; inspect the current document before delivery.";
            if (
              receipt?.documentFileId === fileId &&
              receipt.fileImage === true &&
              receipt.attachment === false &&
              receipt.mimeType === "image/png" &&
              !receipt.error &&
              !receipt.skipped &&
              !receipt.outcomeUnknown &&
              !receipt.paused &&
              receipt.dispatched !== false &&
              (receipt.status === undefined || receipt.status === "succeeded") &&
              /^[a-f0-9]{64}$/i.test(receipt.fileId ?? "") &&
              /^[a-f0-9]{64}$/i.test(receipt.receiptId ?? "") &&
              /^[a-f0-9]{64}$/i.test(receipt.documentSha256 ?? "") &&
              Array.isArray(receipt.pages) &&
              receipt.pages.every((page: unknown) => Number.isInteger(page) && Number(page) > 0) &&
              receipt.instruction === historicalInspectionInstruction
            )
              return { ...message, content: JSON.stringify({ ...receipt, instruction }) };
          } catch {
            /* Preserve every field of unrecognized inspection receipts. */
          }
        }
      }
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
