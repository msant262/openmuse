import assert from "node:assert/strict";
import test from "node:test";
import { ConditionalJson } from "../src/conditional-json.ts";

test("unchanged workspace reads retain object identity; mutations and account changes clear it", () => {
  const first = new ConditionalJson();
  const other = new ConditionalJson();
  const workspace = { tasks: [{ id: "research" }] };
  first.save("/api/agent", '"revision-1"', workspace);
  assert.equal(first.get("/api/agent")?.value, workspace);
  assert.equal(other.get("/api/agent"), undefined);
  first.clear();
  assert.equal(first.get("/api/agent"), undefined);
  first.save("/api/agent", null, workspace);
  assert.equal(
    first.get("/api/agent"),
    undefined,
    "legacy servers must never return a stale checkpoint",
  );
});
