import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpRequestPreview } from "../apps/server/src/mcp-preview.ts";

test("money review preserves business destinations ahead of oversized detail and redacts nested authentication", () => {
  const preview = mcpRequestPreview(
    {
      description: "x".repeat(30000),
      recipientAccount: "DE123456789",
      amount: 42,
      currency: "EUR",
      recipient: "Ticket shop",
      product: "Concert ticket",
      auth: { password: "private-password" },
      authorization: "Bearer configured-credential",
      note: "configured-credential",
      items: Array.from({ length: 100 }, (_, i) => ({
        product: `item${i}`,
        token: "nested-token",
      })),
    },
    ["Bearer configured-credential"],
  );
  assert.ok(preview.length <= 8000);
  assert.match(preview, /Preview truncated/);
  for (const detail of ["DE123456789", "42", "EUR", "Ticket shop", "Concert ticket"])
    assert.ok(preview.includes(detail));
  for (const secret of ["private-password", "configured-credential", "nested-token"])
    assert.ok(!preview.includes(secret));
});

test("configured secrets in keys and across truncation boundaries are scrubbed before serialization", async () => {
  const { configuredSecretScrubber, scrubConfiguredValue } = await import(
    "../apps/server/src/configured-secrets.ts"
  );
  const secret = 'credential-with-"quotes\\and-newline\n';
  const scrub = configuredSecretScrubber([`Bearer ${secret}`]);
  const value = { [secret]: `prefix ${secret} suffix`, nearBoundary: `x${secret}`.repeat(5000) };
  const cleaned = JSON.stringify(scrubConfiguredValue(value, scrub)).slice(0, 30000);
  assert.ok(!cleaned.includes("credential-with"));
  assert.match(cleaned, /redacted/);
  const preview = mcpRequestPreview(value, [`Bearer ${secret}`]);
  assert.ok(!preview.includes("credential-with"));
});
