import assert from "node:assert/strict";
import { test } from "node:test";
import { modelUsageUrl } from "../src/model-errors.ts";

test("subscription usage errors expose only the fixed ChatGPT usage destination", () => {
  assert.equal(
    modelUsageUrl("Usage limit reached. Manage at https://chatgpt.com/settings/usage"),
    "https://chatgpt.com/settings/usage",
  );
  assert.equal(modelUsageUrl("Go to https://untrusted.example/usage"), undefined);
});
