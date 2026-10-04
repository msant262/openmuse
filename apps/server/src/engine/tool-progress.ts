import { createHash } from "node:crypto";
import type { ModelMessage } from "@tanstack/ai";
import type { ToolCallRecord } from "./openclaw/tool-call-record.ts";
import { getArgumentChurnNoProgressStreak } from "./openclaw/tool-loop-argument-churn.ts";
import { getNoProgressStreak } from "./openclaw/tool-loop-no-progress.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function parsed(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(parsed(value))) ?? "null")
    .digest("hex");

/** OpenClaw's pure streak classifiers over this run's canonical receipts. */
export class ToolProgress {
  private history: ToolCallRecord[] = [];
  private pending = new Map<string, Promise<unknown>>();
  /** Identical parallel calls must see the preceding outcome before admission. */
  exclusive<T>(toolName: string, args: unknown, execute: () => Promise<T>): Promise<T> {
    const key = `${toolName}:${hash(args)}`;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(execute);
    this.pending.set(key, pending);
    void pending
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  observe(messages: readonly ModelMessage[]) {
    this.history = [];
    // A fresh user instruction can legitimately retry an earlier failed operation.
    const turn = messages.slice(
      Math.max(
        0,
        messages.findLastIndex((message) => message.role === "user"),
      ),
    );
    const calls = new Map(
      turn.flatMap((message) =>
        (message.toolCalls ?? []).map((call) => [call.id, call.function] as const),
      ),
    );
    for (const message of turn) {
      if (message.role !== "tool") continue;
      const call = calls.get(message.toolCallId ?? "");
      if (call) this.record(call.name, call.arguments, message.content);
    }
  }
  record(toolName: string, args: unknown, result: unknown) {
    const argsHash = hash(args);
    const receipt = parsed(result);
    const veto = Boolean(
      receipt &&
        typeof receipt === "object" &&
        "code" in receipt &&
        receipt.code === "TOOL_NO_PROGRESS",
    );
    const resultHash = veto ? undefined : hash(receipt);
    const previous = [...this.history]
      .reverse()
      .find((item) => item.toolName === toolName && item.argsHash === argsHash && item.resultHash);
    this.history.push({
      toolName,
      argsHash,
      resultHash,
      ...(veto ? { outcomeKind: "tool-loop-veto" as const } : {}),
      noProgress: resultHash !== undefined && resultHash === previous?.resultHash,
    });
    this.history = this.history.slice(-60);
  }
  check(toolName: string, args: unknown): { blocked: boolean; message: string } | undefined {
    // Completion/recovery must remain possible, including repeated failed finish attempts.
    if (
      [
        "finish_task",
        "ask_user",
        "delegate_task",
        "read_tool_output",
        "AGUISendStateSnapshot",
        "AGUISendStateDelta",
      ].includes(toolName)
    )
      return;
    const argsHash = hash(args);
    const repeated = getNoProgressStreak(this.history, toolName, argsHash);
    if (repeated.count >= 20)
      return {
        blocked: true,
        message: `${toolName} returned the same outcome for the same arguments ${repeated.count} times. This call was not executed. Use the existing result, try a materially different approach, or deliver the completed work and explain a concrete remaining blocker.`,
      };
    const churn = getArgumentChurnNoProgressStreak(this.history, toolName, argsHash);
    if (repeated.count >= 10 || churn.count >= 10)
      return {
        blocked: false,
        message: `WARNING: ${toolName} is repeating unchanged outcomes. Stop polling or researching the same result; use the evidence already available and perform the next useful action. Changed arguments and completion tools remain available.`,
      };
  }
}
