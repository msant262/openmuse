// Port of Hermes _repair_invalid_tool_call_arguments in agent/agent_runtime_helpers.py
// at 1298c8e. MIT, copyright 2025 Nous Research; third_party/hermes-learning/LICENSE.
// Repair a projection only. Never rewrite the canonical transcript or dispatch old calls.
import type { Message } from "@ag-ui/core";
export function repairHistoricalArguments(source: Message[]): Message[] {
  const messages = structuredClone(source);
  const marker =
    "[Historical tool arguments were incomplete; this receipt is context only and must not be replayed.]";
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    let insertAt = index + 1;
    for (const call of message.toolCalls ?? []) {
      const args = call.function.arguments;
      if (!args?.trim()) {
        call.function.arguments = "{}";
        continue;
      }
      try {
        JSON.parse(args);
        continue;
      } catch {
        /* Repair the wire projection below. */
      }
      call.function.arguments = "{}";
      const existing = messages
        .slice(index + 1)
        .find((item) => item.role === "tool" && item.toolCallId === call.id);
      if (existing && existing.role === "tool")
        existing.content = marker + "\n" + (existing.content ?? "");
      else
        messages.splice(insertAt++, 0, {
          id: `historical-repair:${call.id}`,
          role: "tool",
          toolCallId: call.id,
          content: marker,
        });
    }
  }
  return messages;
}
