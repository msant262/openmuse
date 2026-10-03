import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cachedConversationTitle,
  isEmptyConversationCache,
} from "../apps/mobile/src/conversation-label.ts";

test("conversation labels use the first actual user message, never a draft or tool payload", () => {
  assert.equal(
    cachedConversationTitle(
      JSON.stringify({
        messages: [
          { role: "tool", content: "internal result" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "  A weekend\n in Lisbon  " },
          { role: "user", content: "Different later topic" },
        ],
        draft: { text: "Unsent private draft" },
      }),
    ),
    "A weekend in Lisbon",
  );
  assert.equal(
    cachedConversationTitle(JSON.stringify({ messages: [], draft: { text: "Unsent" } })),
    undefined,
  );
  assert.equal(cachedConversationTitle("invalid json"), undefined);
  assert.equal(
    cachedConversationTitle(
      JSON.stringify({ messages: [{ role: "user", content: { text: "invalid" } }] }),
    ),
    undefined,
  );
  assert.equal(
    cachedConversationTitle(
      JSON.stringify({ messages: [{ role: "user", content: "a".repeat(100) }] }),
    )?.length,
    65,
  );
});

test("only a complete empty cache can be hidden from the recent conversation list", () => {
  const cache = {
    version: 1,
    messages: [],
    pending: [],
    draft: { text: "", attachmentIds: [], annotations: [] },
  };
  assert.equal(isEmptyConversationCache(JSON.stringify(cache)), true);
  assert.equal(isEmptyConversationCache(null), false);
  assert.equal(isEmptyConversationCache("{}"), false);
  assert.equal(
    isEmptyConversationCache(JSON.stringify({ ...cache, pending: [{ text: "queued" }] })),
    false,
  );
  assert.equal(
    isEmptyConversationCache(
      JSON.stringify({ ...cache, draft: { ...cache.draft, text: "unsent" } }),
    ),
    false,
  );
  assert.equal(
    isEmptyConversationCache(
      JSON.stringify({ ...cache, draft: { ...cache.draft, attachmentIds: ["file"] } }),
    ),
    false,
  );
  assert.equal(
    isEmptyConversationCache(
      JSON.stringify({
        ...cache,
        draft: { ...cache.draft, annotations: [{ comment: "remember" }] },
      }),
    ),
    false,
  );
});
