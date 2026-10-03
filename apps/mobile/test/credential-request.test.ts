import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime.ts";
import { CredentialSubmission, credentialFormError } from "../src/credential-state.ts";

const request: CredentialInteractionRequest = {
  id: "request-1",
  taskId: "task-1",
  revision: 2,
  kind: "credential",
  status: "waiting",
  createdAt: "2026-10-02T00:00:00Z",
  schema: {
    title: "Connect Portal X",
    serviceName: "Portal X",
    origin: "https://portal.example.test",
    purpose: "Read the latest account documents",
    fields: [
      { id: "username", label: "Email", type: "text", required: true },
      { id: "password", label: "Password", type: "password", required: true },
    ],
  },
};

test("credential form validates its trusted HTTPS destination and declared fields", () => {
  assert.equal(
    credentialFormError(request, { username: "owner@example.test", password: "secret" }),
    "",
  );
  assert.match(credentialFormError(request, { username: "", password: "secret" }), /Email/);
  assert.match(
    credentialFormError(request, { username: "owner@example.test", password: "" }),
    /Password/,
  );
  assert.match(
    credentialFormError(request, {
      username: "owner@example.test",
      password: "secret",
      destination: "https://evil.test",
    }),
    /unsupported/i,
  );
  assert.match(
    credentialFormError(
      { ...request, schema: { ...request.schema, origin: "http://portal.example.test" } },
      { username: "owner@example.test", password: "secret" },
    ),
    /destination/i,
  );
  assert.match(
    credentialFormError(
      { ...request, status: "saved" },
      { username: "owner@example.test", password: "secret" },
    ),
    /no longer open/i,
  );
});

test("double taps share one private submission and retries keep one response ID", async () => {
  let resolve!: (value: CredentialInteractionRequest) => void;
  const sent: string[] = [];
  const submission = new CredentialSubmission(request, "response-credential-1");
  const send = async (body: { clientResponseId: string }) => {
    sent.push(body.clientResponseId);
    return new Promise<CredentialInteractionRequest>((done) => {
      resolve = done;
    });
  };
  const values = { username: "owner@example.test", password: "secret" };
  const first = submission.submit(values, send);
  const second = submission.submit(values, send);
  assert.deepEqual(sent, ["response-credential-1"]);
  resolve({ ...request, status: "saved", credentialRef: { id: "ref-1", version: 1 } });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, "saved");
  assert.equal(two.status, "saved");
  const replay = await submission.submit(values, send);
  assert.equal(replay.status, "saved");

  const retry = new CredentialSubmission(request, "response-stable-2");
  await assert.rejects(
    retry.submit(values, async (body) => {
      sent.push(body.clientResponseId);
      throw new Error("ACK lost");
    }),
  );
  await retry.submit(values, async (body) => {
    sent.push(body.clientResponseId);
    return { ...request, status: "saved" };
  });
  assert.deepEqual(sent.slice(-2), ["response-stable-2", "response-stable-2"]);
});
