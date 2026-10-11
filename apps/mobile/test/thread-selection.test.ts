import assert from "node:assert/strict";
import { test } from "node:test";
import {
  navigateFromThreadMenu,
  parseThreadSelection,
  unsavedThreadVisits,
} from "../src/thread-selection.ts";

test("a saved conversation missing from the server page never reappears as a local draft", () => {
  const visited = [
    { id: "retired", existing: true },
    { id: "older-outside-page", existing: true },
    { id: "unsent", existing: false },
    { id: "accepted-before-local-flag", existing: false },
    { id: "main", existing: false },
  ];
  assert.deepEqual(unsavedThreadVisits(visited, ["accepted-before-local-flag"], "main"), [
    { id: "unsent", existing: false },
  ]);
  assert.equal(visited.length, 5, "sidebar selection does not erase cache or persisted user data");
});

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
