import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSelectionNotice, modelUsageUrl } from "../src/model-errors.ts";

test("subscription usage errors expose only the fixed ChatGPT usage destination", () => {
  assert.equal(
    modelUsageUrl("Usage limit reached. Manage at https://chatgpt.com/settings/usage"),
    "https://chatgpt.com/settings/usage",
  );
  assert.equal(modelUsageUrl("Go to https://untrusted.example/usage"), undefined);
});

test("model notices display only a validated public selection", () => {
  assert.match(
    modelSelectionNotice({
      provider: "grok",
      model: "fixture",
      fallback: true,
      token: "private",
    }) ?? "",
    /grok/,
  );
  assert.doesNotMatch(
    modelSelectionNotice({
      provider: "grok",
      model: "fixture",
      fallback: true,
      token: "private",
    }) ?? "",
    /private/,
  );
  assert.equal(
    modelSelectionNotice({
      provider: "grok",
      model: "https://host/?token=private",
      fallback: true,
    }),
    undefined,
  );
  assert.equal(
    modelSelectionNotice({ provider: "grok\nprivate", model: "fixture", fallback: false }),
    undefined,
  );
});
