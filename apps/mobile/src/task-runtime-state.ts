import type { AgentTask } from "../../../packages/domain/src/agent";
import type { CompletionAssessment, TaskTiming } from "../../../packages/domain/src/runtime";

export type TimingDraft = {
  priority: TaskTiming["priority"];
  timezone: string;
  dueAt: string;
  validUntil: string;
};
export type TimingChange = {
  expectedRevision: number;
  requestId: string;
  priority?: TaskTiming["priority"];
  timezone?: string;
  dueAt?: string | null;
  validUntil?: string | null;
};
function editableInstant(value: string | undefined, timezone: string) {
  if (!value) return "";
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date(value))
        .map((part) => [part.type, part.value]),
    );
    const offset = parts.timeZoneName === "GMT" ? "Z" : parts.timeZoneName.replace("GMT", "");
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  } catch {
    return value;
  }
}
export function timingDraft(task: AgentTask): TimingDraft {
  const timezone = task.timing?.timezone ?? "Europe/Berlin";
  return {
    priority: task.timing?.priority ?? "normal",
    timezone,
    dueAt: editableInstant(task.timing?.dueAt, timezone),
    validUntil: editableInstant(task.timing?.validUntil, timezone),
  };
}
/** Keep a lost ACK bound to the original edit and revision. A new edit requires
 * an explicit reload; background task refreshes must never change a retry. */
export class TimingSubmission {
  readonly initial: TimingDraft;
  private readonly revision: number;
  private pending?: { fingerprint: string; body: TimingChange };
  constructor(
    task: AgentTask,
    private readonly newId: () => string,
  ) {
    this.initial = timingDraft(task);
    this.revision = Number(task.state.timingRevision ?? 0);
  }
  prepare(draft: TimingDraft): TimingChange {
    const fingerprint = JSON.stringify(draft);
    if (this.pending) {
      if (fingerprint !== this.pending.fingerprint)
        throw new Error("A timing change is pending. Retry or reload before editing.");
      return { ...this.pending.body };
    }
    const body: TimingChange = { expectedRevision: this.revision, requestId: this.newId() };
    if (draft.priority !== this.initial.priority) body.priority = draft.priority;
    if (draft.timezone !== this.initial.timezone) body.timezone = draft.timezone.trim();
    for (const field of ["dueAt", "validUntil"] as const) {
      if (draft[field] !== this.initial[field]) body[field] = draft[field].trim() || null;
    }
    this.pending = { fingerprint, body };
    return { ...body };
  }
}
export function completionLabel(completion?: CompletionAssessment) {
  if (!completion) return undefined;
  return {
    verified: "Delivery verified",
    partial: "Partial delivery",
    unverified: "Result not verified",
  }[completion.status];
}
