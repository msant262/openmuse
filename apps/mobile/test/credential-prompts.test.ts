import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime.ts";
import {
  credentialPromptKey,
  credentialRequestPath,
  credentialStatusSummary,
  nextCredentialPrompt,
  pendingCredentialPrompts,
} from "../src/credential-prompts-state.ts";

test("technical connection receipts have one localizable summary", () => {
  assert.equal(
    credentialStatusSummary("Connect Atlas Reports using the secure form."),
    "A secure connection is needed to continue.",
  );
  assert.equal(
    credentialStatusSummary("Waiting for a secure Atlas Reports connection form."),
    "A secure connection is needed to continue.",
  );
  assert.equal(credentialStatusSummary("Atlas Reports has three new reports."), undefined);
});

const request = (id: string, fields = ["apiKey"]): CredentialInteractionRequest => ({
  id,
  taskId: `task-${id}`,
  revision: 1,
  kind: "credential",
  status: "waiting",
  createdAt: "2026-10-03T00:00:00.000Z",
  schema: {
    credentialKind: "api",
    title: "Connect a service",
    serviceName: "Any new service",
    origin: "https://api.example.test",
    purpose: "Continue the task the owner requested",
    fields: fields.map((id) => ({ id, label: id, type: "password", required: true })),
  },
});

test("a new credential opens once and repeated polls cannot reopen a dismissed form", () => {
  const one = request("one");
  const dismissed = new Set<string>();
  assert.equal(nextCredentialPrompt([one, { ...one }], dismissed)?.id, "one");
  dismissed.add(credentialPromptKey(one));
  assert.equal(nextCredentialPrompt([{ ...one }], dismissed), undefined);
  assert.equal(
    nextCredentialPrompt([one], dismissed, "one")?.id,
    "one",
    "manual reopen remains open",
  );
  assert.equal(nextCredentialPrompt([one, request("two")], dismissed)?.id, "two");
});

test("polling never replaces the active form with a second request", () => {
  const first = request("first");
  const second = request("second");
  assert.equal(nextCredentialPrompt([first, second], new Set(), "second")?.id, "second");
  assert.equal(
    nextCredentialPrompt([{ ...first, status: "saving" }, second], new Set(), "first")?.status,
    "saving",
    "an in-flight secure save keeps its modal until the result is known",
  );
  assert.deepEqual(pendingCredentialPrompts([first, { ...first, status: "connected" }, first]), []);
  assert.equal(
    nextCredentialPrompt([first, { ...first, status: "connected" }, first], new Set(), "first"),
    undefined,
    "a stale cached card cannot keep a completed modal open",
  );
});

test("the next verification challenge reopens once while finished requests cannot reopen", () => {
  const one = request("one", ["username", "password"]);
  const dismissed = new Set([credentialPromptKey(one)]);
  const challenge = {
    ...one,
    status: "needs_challenge",
    challengeId: "otp-1",
    challengeKind: "otp",
  } as const;
  assert.equal(nextCredentialPrompt([challenge], dismissed)?.challengeId, "otp-1");
  dismissed.add(credentialPromptKey(challenge));
  assert.equal(nextCredentialPrompt([challenge], dismissed), undefined);
  assert.equal(
    nextCredentialPrompt([{ ...one, status: "cancelled" }], dismissed, "one"),
    undefined,
  );
});

test("one dynamic form routes new services and preserves browser and legacy compatibility", () => {
  const one = request("new-service", ["clientId", "clientSecret"]);
  assert.equal(credentialRequestPath(one), "/api/service-credentials/requests/new-service");
  assert.equal(
    credentialRequestPath({ ...one, schema: { ...one.schema, credentialKind: undefined } }),
    "/api/credential-requests/new-service",
  );
  assert.equal(
    credentialRequestPath({
      ...one,
      schema: { ...one.schema, credentialKind: undefined, integrationId: "tavily" },
    }),
    "/api/integrations/tavily/requests/new-service",
  );
});

test("catalog authorization shares the modal queue and retains terminal recovery", () => {
  const one = request("catalog-request");
  one.schema = {
    ...one.schema,
    credentialKind: "composio",
    composio: { flowId: "flow", toolkitSlug: "new-provider" },
    fields: [],
  };
  assert.equal(credentialRequestPath(one), "/api/composio/requests/catalog-request");
  assert.equal(nextCredentialPrompt([request("other"), one], new Set(), one.id)?.id, one.id);
  assert.equal(
    nextCredentialPrompt([{ ...one, status: "expired" }], new Set(), one.id)?.status,
    "expired",
  );
  assert.equal(nextCredentialPrompt([{ ...one, status: "error" }], new Set())?.id, one.id);
  const dismissed = new Set([credentialPromptKey(one)]);
  assert.equal(nextCredentialPrompt([{ ...one, status: "expired" }], dismissed), undefined);
  assert.equal(pendingCredentialPrompts([{ ...one, status: "expired" }]).length, 1);
});
