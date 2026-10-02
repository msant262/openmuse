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
