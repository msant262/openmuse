// Copied from OpenClaw b56ae70, src/agents/embedded-agent-runner/history.ts.
// MIT; see third_party/openclaw/LICENSE. Only the host message type is generalized.
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/**
 * Limits conversation history to recent user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 *
 * Leading non-conversation messages (e.g. compactionSummary, branchSummary)
 * placed at index 0 by buildSessionContext are always preserved, since they
 * carry summarized pre-compaction context that history limiting must not drop.
 */
export function limitHistoryTurns<AgentMessage extends { role: string }>(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  const conversationStart = messages.findIndex(
    (message) =>
      !(message as AgentMessage & { [SESSION_HISTORY_PRELUDE]?: true })?.[
        SESSION_HISTORY_PRELUDE
      ] &&
      (message?.role === "user" || message?.role === "assistant"),
  );
  if (conversationStart < 0) {
    return messages;
  }
  let userCount = 0;
  for (let i = conversationStart; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      userCount++;
    }
  }

  // Allow a 50% cushion, then evict a full batch so the prompt-cache prefix stays
  // stable between cuts; up to 1.5x turns trades strictness for amortized cache reuse.
  const targetUserTurns = Math.floor(limit);
  const maxUserTurns = Math.ceil(targetUserTurns * 1.5);
  if (userCount <= maxUserTurns) {
    return messages;
  }
  const evictionBatchSize = maxUserTurns - targetUserTurns + 1;
  const userTurnsToKeep = targetUserTurns + ((userCount - targetUserTurns) % evictionBatchSize);

  let turnsRemaining = userTurnsToKeep;
  const firstKeptIndex = messages.findLastIndex(
    (message, index) =>
      index >= conversationStart && message?.role === "user" && --turnsRemaining === 0,
  );
  return [
    ...messages.slice(0, conversationStart),
    ...messages.slice(firstKeptIndex < 0 ? messages.length : firstKeptIndex),
  ];
}
