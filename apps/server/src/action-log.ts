import { createHash, randomUUID } from "node:crypto";
import type { ActionLogEntry } from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { backgroundFailure } from "./log.ts";

export type LogAction = Pick<ActionLogEntry, "tool" | "target" | "summary"> & {
  actor?: ActionLogEntry["actor"];
  operationId?: string;
};
export function unknownOutcome(error: unknown) {
  return (
    error instanceof Error &&
    (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
      ("code" in error && ["outcome_unknown", "OUTCOME_UNKNOWN"].includes(String(error.code))))
  );
}
/** URLs are logged only as origins: no passwords, path/query tokens or fragments. */
export function auditTarget(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "configured service";
  }
}
export class ActionLog {
  constructor(readonly db: Store) {}
  async append(owner: string, action: LogAction, result: ActionLogEntry["result"]) {
    const operationId = action.operationId ?? randomUUID();
    await this.db.appendActionLog(owner, {
      id: createHash("sha256").update(`${operationId}:${result}`).digest("hex"),
      operationId,
      time: new Date().toISOString(),
      actor: action.actor ?? "agent",
      tool: action.tool,
      target: action.target,
      summary: action.summary,
      result,
    });
  }
  /** Terminal audit failure cannot change an external receipt into retryable failure. */
  async finish(owner: string, action: LogAction, result: ActionLogEntry["result"]) {
    const bound = { ...action, operationId: action.operationId ?? randomUUID() };
    const id = createHash("sha256").update(`${bound.operationId}:${result}`).digest("hex");
    try {
      await this.db.put(owner, "audit-completions", { id, action: bound, result });
      await this.append(owner, bound, result);
      await this.db.remove(owner, "audit-completions", id);
    } catch (error) {
      backgroundFailure("external action audit completion", error);
    }
  }
  async reconcile(startup = false) {
    const cutoff = new Date().toISOString();
    for (const { owner, value } of await this.db.scan<{
      id: string;
      action: LogAction;
      result: ActionLogEntry["result"];
    }>("audit-completions")) {
      await this.append(owner, value.action, value.result);
      await this.db.remove(owner, "audit-completions", value.id);
    }
    let cursor: { time: string; owner: string; id: string } | undefined;
    while (true) {
      const batch = await this.db.unfinishedActionLog(cutoff, cursor);
      if (!batch.length) break;
      for (const { owner, value } of batch) {
        cursor = { time: value.time, owner, id: value.id };
        const action = await this.db.get<{ status: string }>(owner, "actions", value.operationId);
        const command = await this.db.get<{ status: string }>(
          owner,
          "computer-commands",
          value.operationId,
        );
        const image = value.operationId.startsWith("image:")
          ? await this.db.get<{ status: string }>(
              owner,
              "image-generations",
              value.operationId.slice(6),
            )
          : null;
        const push = value.operationId.startsWith("push:")
          ? await this.db.get<{ status: string }>(
              owner,
              "push-deliveries",
              value.operationId.slice(5),
            )
          : null;
        const status = action?.status ?? command?.status ?? image?.status ?? push?.status;
        if (status && ["executing", "awaiting_review", "running", "sending"].includes(status))
          continue;
        const result: ActionLogEntry["result"] | undefined = ["succeeded", "accepted"].includes(
          status ?? "",
        )
          ? "succeeded"
          : ["failed", "rejected", "invalid_token"].includes(status ?? "")
            ? "failed"
            : ["denied", "suppressed"].includes(status ?? "")
              ? "denied"
              : status === "cancelled"
                ? "cancelled"
                : status === "expired"
                  ? "expired"
                  : status &&
                      [
                        "outcome_unknown",
                        "interrupted",
                        "timed_out",
                        "uncertain",
                        "pending",
                      ].includes(status)
                    ? "outcome_unknown"
                    : startup
                      ? "outcome_unknown"
                      : undefined;
        if (result) await this.append(owner, value, result);
      }
    }
  }
  async run<T>(
    owner: string,
    action: LogAction,
    operation: () => Promise<T>,
    classify: (value: T) => ActionLogEntry["result"] = () => "succeeded",
  ): Promise<T> {
    const bound = { ...action, operationId: action.operationId ?? randomUUID() };
    await this.append(owner, bound, "started");
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      await this.finish(owner, bound, unknownOutcome(error) ? "outcome_unknown" : "failed");
      throw error;
    }
    await this.finish(owner, bound, classify(value));
    return value;
  }
}
