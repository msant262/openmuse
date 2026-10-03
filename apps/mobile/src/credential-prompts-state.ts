import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime.ts";

/** Normalize engine receipts without rewriting user content or service names. */
export function credentialStatusSummary(value: string) {
  return /^(?:Connect .+ using the secure form\.?|Waiting for a secure .+ connection form\.?)$/.test(
    value,
  )
    ? "A secure connection is needed to continue."
    : undefined;
}

export function credentialRequestPath(request: CredentialInteractionRequest) {
  const id = encodeURIComponent(request.id);
  if (request.schema.credentialKind === "composio") return `/api/composio/requests/${id}`;
  if (request.schema.credentialKind === "api") return `/api/service-credentials/requests/${id}`;
  if (request.schema.integrationId)
    return `/api/integrations/${encodeURIComponent(request.schema.integrationId)}/requests/${id}`;
  return `/api/credential-requests/${id}`;
}

export function credentialNeedsInput(request: CredentialInteractionRequest) {
  return (
    request.status === "waiting" ||
    request.status === "needs_challenge" ||
    (request.schema.credentialKind === "composio" && ["expired", "error"].includes(request.status))
  );
}

/** A repeated poll never becomes a new prompt; an OTP challenge does. */
export function credentialPromptKey(request: CredentialInteractionRequest) {
  return `${request.id}:${request.revision}:${request.challengeId ?? "credential"}`;
}

function latestCredentialRequests(requests: CredentialInteractionRequest[]) {
  const latest = new Map<string, CredentialInteractionRequest>();
  for (const request of requests) {
    const previous = latest.get(request.id);
    if (
      !previous ||
      request.revision > previous.revision ||
      (request.revision === previous.revision &&
        (previous.status === "waiting" || request.status !== "waiting"))
    )
      latest.set(request.id, request);
  }
  return [...latest.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function pendingCredentialPrompts(requests: CredentialInteractionRequest[]) {
  return latestCredentialRequests(requests).filter(credentialNeedsInput);
}

export function nextCredentialPrompt(
  requests: CredentialInteractionRequest[],
  dismissed: ReadonlySet<string>,
  activeId?: string,
) {
  const latest = latestCredentialRequests(requests);
  const pending = latest.filter(credentialNeedsInput);
  const active = latest.find(
    (request) =>
      request.id === activeId &&
      (request.schema.credentialKind === "composio" ||
        ["waiting", "needs_challenge", "saving", "connecting", "outcome_unknown"].includes(
          request.status,
        )),
  );
  return active ?? pending.find((request) => !dismissed.has(credentialPromptKey(request)));
}
