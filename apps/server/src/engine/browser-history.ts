import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/core";
import type { Store } from "../db.ts";

type Entry = {
  id: string;
  name: string;
  args: unknown;
  key?: string;
  status: "started" | "completed" | "uncertain" | "skipped";
  result?: unknown;
};
function knownSkip(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as { skipped?: boolean; paused?: boolean; error?: string; code?: string };
  return (
    result.skipped === true ||
    (result.paused === true && !result.error) ||
    Boolean(
      result.error &&
        [
          "BROWSER_CONTROLLED",
          "STALE_SNAPSHOT",
          "INVALID_REFERENCE",
          "PAYMENT_APPROVAL_REQUIRED",
        ].includes(result.code ?? ""),
    )
  );
}
const unconfirmed = (entry: Entry) => entry.status === "started" || entry.status === "uncertain";
type Journal = { id: string; entries: Entry[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Owned receipts survive loss of the task lease, including result-before-checkpoint crashes.
 * Only browser tool data is stored: screenshot results already use bounded asset references.
 */
export class TaskBrowserHistory {
  private constructor(
    private readonly db: Store,
    private readonly owner: string,
    private readonly journal: Journal,
  ) {}
  static async load(db: Store, owner: string, taskId: string) {
    const journal = (await db.get<Journal>(owner, "task-browser-history", taskId)) ?? {
      id: taskId,
      entries: [],
    };
    // Native reviewed actions have their own durable receipt. Refresh their tool
    // context after review rather than replaying an obsolete approval request.
    for (const entry of journal.entries) {
      // Also repair persisted pre-upgrade stopped receipts: they never dispatched.
      if (knownSkip(entry.result)) {
        entry.status = "skipped";
        entry.result = { ...(entry.result as object), skipped: true, dispatched: false };
      }
      const result = entry.result as { actionId?: string } | undefined;
      if (!result?.actionId) continue;
      const action = await db.get<{ status: string; result?: string; error?: string }>(
        owner,
        "actions",
        result.actionId,
      );
      if (!action || ["awaiting_review", "executing"].includes(action.status)) continue;
      entry.result = {
        actionId: result.actionId,
        status: action.status,
        result: action.result,
        error: action.error,
        approvalRequired: false,
      };
      if (action.status === "outcome_unknown") entry.status = "uncertain";
    }
    return new TaskBrowserHistory(db, owner, journal);
  }
  get unconfirmedAction() {
    return this.journal.entries.some((entry) => entry.name === "browser_act" && unconfirmed(entry));
  }
  messages(): Message[] {
    return this.journal.entries.flatMap((entry): Message[] => [
      {
        id: `browser-call-${entry.id}`,
        role: "assistant",
        toolCalls: [
          {
            id: entry.id,
            type: "function",
            function: { name: entry.name, arguments: JSON.stringify(entry.args) },
          },
        ],
      },
      {
        id: `browser-result-${entry.id}`,
        role: "tool",
        toolCallId: entry.id,
        content: JSON.stringify(
          !unconfirmed(entry)
            ? entry.result
            : {
                outcomeUnknown: true,
                reason:
                  "This browser operation was dispatched but its result was not confirmed. Do not resubmit it. Ask the user to inspect the site.",
              },
        ),
      },
    ]);
  }
  private actKey(args: Record<string, unknown>) {
    if (typeof args.operationId === "string") return `intent:${args.operationId}`;
    const act = args.act as Record<string, unknown>;
    // Compatibility for callers without a logical operationId: bind to semantic control
    // metadata, never just a transient snapshot ID/number. A new intended repetition
    // must explicitly use a new operationId.
    let target: unknown;
    for (const entry of [...this.journal.entries].reverse()) {
      const result = entry.result as
        | { snapshotId?: string; url?: string; elements?: { number: number }[] }
        | undefined;
      if (!result || result.snapshotId !== act.snapshotId) continue;
      const element = result.elements?.find((element) => element.number === act.element);
      if (element) {
        const { number: _number, ...semantic } = element;
        target = { url: result.url, ...semantic };
      }
      break;
    }
    const { snapshotId: _snapshot, element: _element, ...operation } = act;
    return target ? digest({ target, operation }) : digest(args);
  }
  async run(name: string, args: Record<string, unknown>, operation: () => Promise<unknown>) {
    const key = name === "browser_act" ? this.actKey(args) : undefined;
    if (key) {
      const previous = this.journal.entries.find(
        (entry) =>
          entry.key === key &&
          entry.status === "completed" &&
          !(entry.result as { error?: string })?.error,
      );
      if (previous) return previous.result;
      if (this.journal.entries.some((entry) => entry.name === "browser_act" && unconfirmed(entry)))
        return {
          outcomeUnknown: true,
          error:
            "An earlier browser action has an unconfirmed outcome. Automatic browser actions are blocked for this task. Inspect the site with Take control before starting any new task.",
        };
    }
    const entry: Entry = { id: randomUUID(), name, args, key, status: "started" };
    this.journal.entries.push(entry);
    await this.db.put(this.owner, "task-browser-history", this.journal);
    const result = await operation(); // Throw/termination leaves the durable started intent.
    const failure = result as { error?: string; code?: string } | undefined;
    entry.result = result;
    entry.status = knownSkip(result)
      ? "skipped"
      : name === "browser_act" && failure?.error
        ? "uncertain"
        : "completed";
    if (entry.status === "skipped")
      entry.result = { ...(result as object), skipped: true, dispatched: false };
    await this.db.put(this.owner, "task-browser-history", this.journal);
    return entry.status === "uncertain" ? { ...(result as object), outcomeUnknown: true } : result;
  }
}
