import assert from "node:assert/strict";
import { test } from "node:test";
import { companionMotion } from "../apps/mobile/src/avatar-motion.ts";

test("only the selected owner's conversation can animate the companion", () => {
  assert.equal(
    companionMotion("owner/chat", { key: "owner/chat", state: "talking" }, "idle"),
    "talking",
  );
  assert.equal(
    companionMotion("owner/other", { key: "owner/chat", state: "talking" }, "idle"),
    "idle",
  );
  assert.equal(
    companionMotion("other/chat", { key: "owner/chat", state: "thinking" }, "idle"),
    "idle",
  );
  assert.equal(
    companionMotion("owner/chat", { key: "owner/chat", state: "idle" }, "thinking"),
    "thinking",
  );
  assert.equal(companionMotion(undefined, { key: "owner/chat", state: "talking" }, "idle"), "idle");
});
