import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

const procedure = (id: string) => ({
  id,
  title: id,
  version: 1,
  steps: [`step ${id}`],
  inputs: [],
  lifecycle: "active",
});
function fixture(request: (path: string, body?: Record<string, unknown>) => Promise<unknown>) {
  let serial = 0;
  const api = { identityKey: "owner", request };
  const view = componentHarness(
    new URL("../apps/mobile/src/playbooks.tsx", import.meta.url),
    "PlaybooksPanel",
    {
      "expo-crypto": { randomUUID: () => `request-${++serial}` },
      "react-native": { Text: "Text", View: "View" },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./message-storage": { messageStorage: {} },
      "./ui": { Button: "Button", Card: "Card", ErrorNotice: "ErrorNotice", Field: "Field" },
      "./workspace": { useWorkspace: () => ({ api, ask: () => {} }) },
    },
  );
  view.render();
  return { view, api };
}

test("procedure management reuses the receipt when retrying a committed request whose response was lost", async () => {
  const requests: Record<string, unknown>[] = [];
  const value = procedure("a");
  const { view } = fixture(async (path, body) => {
    if (path.endsWith("/manage")) {
      assert.ok(body);
      requests.push(body);
      if (requests.length === 1) throw new Error("Connection lost after commit");
      assert.equal(
        body.requestId,
        requests[0].requestId,
        "retry must recover the committed result",
      );
      return { ...value, version: 2, pinned: true };
    }
    return [value];
  });
  try {
    await view.flush();
    view.button("a · v1").onPress();
    view.render();
    view.button("Pin procedure").onPress();
    await view.flush();
    view.button("Pin procedure").onPress();
    await view.flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.ok(view.button("Unpin procedure"));
  } finally {
    view.close();
  }
});

for (const operation of ["manage", "history"] as const) {
  test(`late procedure ${operation} response cannot replace another selected procedure`, async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const a = procedure("a"),
      b = procedure("b");
    const { view } = fixture(async (path) => (path.endsWith(`/${operation}`) ? pending : [a, b]));
    try {
      await view.flush();
      view.button("a · v1").onPress();
      view.render();
      view.button(operation === "manage" ? "Pin procedure" : "Version history").onPress();
      view.render();
      view.button("b · v1").onPress();
      view.render();
      finish(
        operation === "manage"
          ? { ...a, version: 2, pinned: true }
          : { entries: [{ value: { ...a, version: 0, steps: ["old a only"] } }] },
      );
      await view.flush();
      assert.match(view.text(), /step b/);
      assert.doesNotMatch(view.text(), /step a|old a only/);
      assert.equal(view.button("Version history").busy, false);
    } finally {
      view.close();
    }
  });
}
