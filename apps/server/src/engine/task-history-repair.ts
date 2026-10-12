import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/core";
import { bindingHash } from "../conversation-inbox.ts";
import { publicJournalValue, publicToolArguments } from "./task-history.ts";
import type { JournalOperation } from "./task-journal.ts";

/** Pinned OpenClaw strict ID transformation. Colliding aliases are deliberately
 * not resolved by argument/result equality: they may represent distinct effects. */
function nativeAlias(id: string) {
  if (/^functions\.[A-Za-z0-9_-]+:\d+$/.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "sanitizedtoolid";
}
function nativeAliases(id: string, observed: Set<string>) {
  const base = nativeAlias(id);
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  const collision = `${base.slice(0, 32)}${hash}`;
  const aliases = new Set([id, base]);
  if (observed.has(collision)) aliases.add(collision);
  // Earlier imports of the canonical ID can themselves have been normalized
  // again. Match only the pinned allocator's exact hash/suffix, not a prefix or
  // an equal result from a different call.
  for (const candidate of observed) {
    const match = /x(\d+)$/.exec(candidate);
    const occurrence = match ? Number(match[1]) : 0;
    if (occurrence < 2 || occurrence >= 1000) continue;
    const suffix = `x${occurrence}`;
    if (candidate === `${collision.slice(0, 40 - suffix.length)}${suffix}`) aliases.add(candidate);
  }
  return aliases;
}

/** Recover an old model view from the owner's canonical journal. Original
 * checkpoints, intentions, receipts and effect statuses are never rewritten. */
export function restoreJournalIdentities(messages: Message[], operations: JournalOperation[]) {
  const observed = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls?.map((call) => call.id) ?? []) : [],
    ),
  );
  const identities = new Map<string, JournalOperation[]>();
  const fingerprints = new Map<string, { args: string; receipt: string }>();
  for (const operation of operations) {
    if (operation.parentOperationId || operation.nativeEnvelope || operation.receipt === undefined)
      continue;
    const id = operation.toolCallId ?? operation.id;
    for (const key of new Set([operation.id, ...nativeAliases(id, observed)])) {
      const candidates = identities.get(key) ?? [];
      candidates.push(operation);
      identities.set(key, candidates);
    }
    fingerprints.set(operation.id, {
      args: bindingHash(publicToolArguments(operation.toolName, operation.args)),
      receipt: bindingHash(publicJournalValue(operation.receipt)),
    });
  }
  const receipts = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const queue = receipts.get(message.toolCallId) ?? [];
    queue.push(index);
    receipts.set(message.toolCallId, queue);
  });
  const pairs: Array<{
    message: number;
    call: number;
    receipt: number;
    id: string;
    operation?: JournalOperation;
  }> = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    message.toolCalls?.forEach((call, part) => {
      const queue = receipts.get(call.id);
      while (queue?.length && queue[0] <= index) queue.shift();
      const receiptIndex = queue?.shift();
      if (receiptIndex === undefined) return;
      let operation: JournalOperation | undefined;
      const candidates = identities.get(call.id);
      const receipt = messages[receiptIndex];
      if (candidates?.length === 1 && receipt.role === "tool") {
        const candidate = candidates[0];
        const fingerprint = fingerprints.get(candidate.id);
        try {
          if (
            candidate.toolName === call.function.name &&
            fingerprint?.args ===
              bindingHash(
                publicToolArguments(candidate.toolName, JSON.parse(call.function.arguments)),
              ) &&
            fingerprint.receipt ===
              bindingHash(publicJournalValue(JSON.parse(String(receipt.content))))
          )
            operation = candidate;
        } catch {
          // A changed, malformed or incomplete result cannot prove an alias.
        }
      }
      pairs.push({ message: index, call: part, receipt: receiptIndex, id: call.id, operation });
    });
  });
  const calls = new Map<string, { id: string; drop: boolean }>();
  const results = new Map<number, { id: string; drop: boolean }>();
  const owners = new Map<string, Set<string | undefined>>();
  for (const pair of pairs) {
    const known = owners.get(pair.id) ?? new Set<string | undefined>();
    known.add(pair.operation?.id);
    owners.set(pair.id, known);
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!pair.operation) continue;
    const operation = pair.operation;
    const id = operation.toolCallId ?? operation.id;
    // Do not introduce a collision with a historical result whose identity or
    // content cannot be established from the current canonical receipt.
    const known = owners.get(id);
    if (known && (known.size !== 1 || !known.has(operation.id))) continue;
    const binding = { id, drop: seen.has(operation.id) };
    seen.add(operation.id);
    calls.set(`${pair.message}:${pair.call}`, binding);
    results.set(pair.receipt, binding);
  }
  return messages.flatMap((message, index): Message[] => {
    if (message.role === "tool") {
      const binding = results.get(index);
      return binding?.drop ? [] : [{ ...message, toolCallId: binding?.id ?? message.toolCallId }];
    }
    if (message.role !== "assistant" || !message.toolCalls) return [message];
    return [
      {
        ...message,
        toolCalls: message.toolCalls.flatMap((call, part) => {
          const binding = calls.get(`${index}:${part}`);
          return binding?.drop ? [] : [{ ...call, id: binding?.id ?? call.id }];
        }),
      },
    ];
  });
}
