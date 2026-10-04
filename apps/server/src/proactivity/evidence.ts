import { createHash } from "node:crypto";
import type { Mail } from "../../../../packages/domain/src/index.ts";
import type { ProactivityTarget } from "../../../../packages/domain/src/proactivity.ts";
import { AppError } from "../errors.ts";
import type { WorkspaceService } from "../workspace.ts";

export class ProactivitySourceUnavailableError extends AppError {
  constructor(
    detail = "The current source is unavailable; the decision is preserved until it can be read",
  ) {
    super(detail, 503, "PROACTIVITY_SOURCE_UNAVAILABLE");
  }
}
export class ProactivityEvidenceChangedError extends AppError {
  constructor(detail: string) {
    super(detail, 409, "PROACTIVITY_EVIDENCE_CHANGED");
  }
}
export function mailVersion(messages: Mail[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        messages.map(({ id, threadId, from, to, date, body, subject, systemLabels, label }) => ({
          id,
          threadId,
          from,
          to,
          date,
          body,
          subject,
          systemLabels,
          label,
        })),
      ),
    )
    .digest("hex");
}
const draft = (m: Mail) => m.systemLabels?.includes("DRAFT") || /^Draft\b/i.test(m.label);
const sent = (m: Mail, _account: string) =>
  !draft(m) && (m.systemLabels?.includes("SENT") || /^Sent\b/i.test(m.label));
/** Explicit reply/action cues only. Read/unread is unrelated to completion. */
export function unansweredRequest(messages: Mail[], account: string): Mail | undefined {
  const sorted = [...messages].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const request = sorted
    .filter(
      (m) =>
        !draft(m) &&
        !sent(m, account) &&
        m.from.toLowerCase() !== account.toLowerCase() &&
        !/(?:no (?:reply|response) (?:is )?(?:needed|required)|do not reply|n[aã]o (?:precisa|necessita) responder|keine antwort erforderlich)/i.test(
          m.body,
        ) &&
        /(?:\?|please[\s\S]{0,100}(?:reply|respond|confirm|complete|return|send)|por favor[\s\S]{0,100}(?:responda|confirme|envie|preencha)|bitte[\s\S]{0,100}(?:antworten|best[aä]tigen))/i.test(
          m.body,
        ),
    )
    .at(-1);
  if (!request) return undefined;
  // Another message ID in the same thread is the normal shape of a reply.
  if (sorted.some((m) => sent(m, account) && Date.parse(m.date) >= Date.parse(request.date)))
    return undefined;
  return request;
}
/** Notifications can deserve attention even when no reply was requested. */
export function unattendedMail(messages: Mail[], account: string): Mail | undefined {
  const incoming = [...messages]
    .filter((m) => !draft(m) && !sent(m, account) && m.from.toLowerCase() !== account.toLowerCase())
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .at(-1);
  return incoming &&
    !messages.some((m) => sent(m, account) && Date.parse(m.date) >= Date.parse(incoming.date))
    ? incoming
    : undefined;
}
export async function readMailEvidence(
  workspace: WorkspaceService,
  owner: string,
  target: Extract<ProactivityTarget, { kind: "mail" }>,
  signal?: AbortSignal,
) {
  let read: Awaited<ReturnType<WorkspaceService["proactivityThread"]>>;
  try {
    read = await workspace.proactivityThread(owner, target.threadId, target.connectionId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new ProactivitySourceUnavailableError(
      error instanceof Error ? `Current mail source unavailable: ${error.message}` : undefined,
    );
  }
  if (!read.complete || read.messages.some((m) => m.body.length > 12000))
    throw new ProactivitySourceUnavailableError(
      "The current mail thread read is partial; no unanswered decision can be made",
    );
  const request =
    target.purpose === "attention"
      ? unattendedMail(read.messages, read.authority.account)
      : unansweredRequest(read.messages, read.authority.account);
  if (!request)
    throw new ProactivityEvidenceChangedError(
      "This thread has been answered or no longer has an unanswered request",
    );
  if (read.version !== target.version || request.id !== target.messageId)
    throw new ProactivityEvidenceChangedError(
      "The selected mail thread changed; review its current request before starting work",
    );
  return read;
}
