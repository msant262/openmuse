import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import { nativeComponentFixture } from "./native-component-fixture.ts";

test("new task approvals become visible without reload, unchanged polls stay quiet and failed refreshes retry", async () => {
  let tasks: unknown[] = [];
  let refreshes = 0;
  let offline = false;
  const api = { request: async () => ({ tasks }) };
  const refreshWorkspace = async () => {
    refreshes++;
    if (offline) throw new Error("offline");
  };
  const fixture = await nativeComponentFixture(
    new URL("../src/agent-workspace.tsx", import.meta.url),
    "AgentWorkspaceProvider",
    {
      "react-native": {
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
        Platform: { OS: "web" },
      },
      "./display-date": { setDisplayLocale() {} },
      "./i18n": { useI18n: () => ({ locale: "en-US" }) },
      "./native-push": { startNativePush: () => () => {} },
      "./workspace": {
        useWorkspace: () => ({
          api,
          open() {},
          navigate() {},
          refresh: refreshWorkspace,
        }),
      },
    },
    {},
  );
  try {
    await fixture.settle();
    const initial = refreshes;
    tasks = [{ id: "delete", actionId: "approval", status: "waiting_approval", updatedAt: "one" }];
    fixture.poll();
    await fixture.settle();
    assert.equal(
      refreshes,
      initial + 1,
      "the native confirmation must enter the live approval list",
    );
    tasks = [
      { id: "delete", actionId: "approval", status: "waiting_approval", updatedAt: "heartbeat" },
    ];
    fixture.poll();
    await fixture.settle();
    assert.equal(refreshes, initial + 1, "heartbeats must not refetch the workspace");
    offline = true;
    tasks = [{ id: "delete", actionId: "approval", status: "succeeded" }];
    fixture.poll();
    await fixture.settle();
    assert.equal(refreshes, initial + 2);
    offline = false;
    fixture.poll();
    await fixture.settle();
    assert.equal(refreshes, initial + 3, "a transient read failure cannot strand the action card");
    fixture.poll();
    await fixture.settle();
    assert.equal(refreshes, initial + 3);
  } finally {
    fixture.unmount();
  }
});
