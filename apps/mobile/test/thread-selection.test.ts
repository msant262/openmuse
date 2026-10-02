import assert from "node:assert/strict";
import { test } from "node:test";
import { navigateFromThreadMenu, parseThreadSelection } from "../src/thread-selection.ts";

test("restored thread selection preserves independent side-chat drafts and menu dismissal precedes navigation", () => {
  const saved = {
    mainId: "main",
    selection: { id: "side", existing: true },
    visited: [{ id: "side", existing: true }],
  };
  assert.deepEqual(parseThreadSelection(JSON.stringify(saved)), saved);
  assert.equal(parseThreadSelection('{"selection":{"id":"../../other"}}'), null);
  let screen = "menu";
  navigateFromThreadMenu(
    () => {
      screen = "old";
    },
    () => {
      screen = "side";
    },
  );
  assert.equal(screen, "side");
});
