import type { AgentTask } from "../../../packages/domain/src/agent";
import {
  type ProactivityAction,
  type ProactivityResponse,
  type ProactivitySuggestion,
  proactivityResponseSchema,
} from "../../../packages/domain/src/proactivity";
import type { InteractionRequest } from "../../../packages/domain/src/runtime";
import type { MessageStorage } from "./message-storage";

export type ProactivityResult = {
  suggestion: ProactivitySuggestion;
  task?: Pick<AgentTask, "id" | "status">;
  message?: string;
};
export function suggestionsFromRequests(requests: InteractionRequest[]) {
  const latest = new Map<string, ProactivitySuggestion>();
  for (const request of requests) {
    const suggestion = request.kind === "proactivity" ? request.suggestion : undefined;
    if (
      suggestion &&
      (!latest.has(suggestion.id) || latest.get(suggestion.id)!.revision < suggestion.revision)
    )
      latest.set(suggestion.id, suggestion);
  }
  return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function proactivityTaskLabel(status: AgentTask["status"], language = "en") {
  if (status === "running")
    return language.startsWith("pt")
      ? "Em execução"
      : language.startsWith("de")
        ? "Wird ausgeführt"
        : "Running";
  if (status === "queued")
    return language.startsWith("pt")
      ? "Na fila"
      : language.startsWith("de")
        ? "In der Warteschlange"
        : "Queued";
  return status.replaceAll("_", " ");
}
/** Uses M2's persistent storage adapter. The exact answer is saved before network dispatch. */
export class ProactivitySubmission {
  private pending?: Promise<ProactivityResult>;
  private readonly key: string;
  constructor(
    private readonly storage: MessageStorage,
    identity: string,
    private readonly suggestion: ProactivitySuggestion,
  ) {
    this.key = `${identity}\nproactivity:${suggestion.requestId}`;
  }
  submit(
    action: ProactivityAction,
    snoozeUntil: string | undefined,
    send: (body: ProactivityResponse) => Promise<ProactivityResult>,
  ): Promise<ProactivityResult> {
    if (this.pending) return this.pending;
    this.pending = this.perform(action, snoozeUntil, send).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async perform(
    action: ProactivityAction,
    snoozeUntil: string | undefined,
    send: (body: ProactivityResponse) => Promise<ProactivityResult>,
  ) {
    if (this.suggestion.status !== "pending")
      throw new Error("This card is closed; open its current pending revision");
    const newBody = proactivityResponseSchema.parse({
      action,
      ...(snoozeUntil ? { snoozeUntil } : {}),
      requestId: this.suggestion.requestId,
      expectedRevision: this.suggestion.revision,
      clientResponseId: `proactivity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    let body!: ProactivityResponse;
    let result: ProactivityResult | undefined;
    await this.storage.update(this.key, (previous) => {
      if (previous) {
        const saved = JSON.parse(previous) as {
          body: ProactivityResponse;
          result?: ProactivityResult;
          rejected?: boolean;
        };
        if (!saved.rejected || saved.result) {
          body = proactivityResponseSchema.parse(saved.body);
          if (
            body.action !== action ||
            body.snoozeUntil !== snoozeUntil ||
            body.requestId !== this.suggestion.requestId ||
            body.expectedRevision !== this.suggestion.revision
          )
            throw new Error("Another decision is awaiting confirmation; retry that answer first");
          result = saved.result;
          return previous;
        }
      }
      // Validate new answers only: an uncertain old snooze must retain its receipt after expiry.
      if (action === "snooze" && Date.parse(newBody.snoozeUntil!) <= Date.now())
        throw new Error("Choose a future snooze time");
      body = newBody;
      return JSON.stringify({ body });
    });
    if (result) return result;
    let response: ProactivityResult;
    try {
      response = await send(body);
    } catch (error) {
      // This server code is issued before an answer mutation. Other HTTP/transport failures
      // can follow a committed answer and must retain the exact receipt for reconciliation.
      if (
        body.action === "snooze" &&
        error instanceof Error &&
        "status" in error &&
        error.status === 422 &&
        "code" in error &&
        error.code === "PROACTIVITY_INVALID_SNOOZE"
      )
        await this.storage.update(this.key, (saved) => {
          if (!saved) throw new Error("The saved response is unavailable");
          const record = JSON.parse(saved);
          return record.body.clientResponseId === body.clientResponseId && !record.result
            ? JSON.stringify({ body, rejected: true })
            : saved;
        });
      throw error;
    }
    await this.storage.update(this.key, (saved) => {
      if (!saved || JSON.parse(saved).body.clientResponseId !== body.clientResponseId)
        throw new Error("The saved response changed before acknowledgement");
      return JSON.stringify({ body, result: response });
    });
    return response;
  }
}
