import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AGENT_PROFILE } from "../packages/domain/src/brand.ts";
import { componentHarness } from "./helpers/component.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const profile = (language: string) => ({
  fields: { ...DEFAULT_AGENT_PROFILE, language },
  revisions: { global: 2, conversation: 2 },
  global: {},
  conversation: {},
});
const history = (entityId: string, language: string) => ({
  entries: [
    {
      id: `${entityId}:1`,
      entityId,
      revision: 1,
      action: "edit",
      changedAt: "2026-09-01",
      value: { fields: { language }, origin: { kind: "settings" } },
    },
  ],
});

function fixture(request: (path: string, body?: unknown) => Promise<unknown>) {
  const selection = { id: "a" };
  const api = { identityKey: "owner-one", request };
  const view = componentHarness(
    new URL("../apps/mobile/src/profile-settings.tsx", import.meta.url),
    "ProfileSettings",
    {
      "react-native": { Text: "Text", View: "View" },
      "../../../packages/domain/src/brand": { DEFAULT_AGENT_PROFILE },
      "./agent-workspace": {
        useAgentWorkspace: () => ({
          data: { identity: { profile: { revisions: { global: 2 } } } },
          refresh: async () => {},
        }),
      },
      "./threads": { useMuseThread: () => ({ selection, enabled: true }) },
      "./ui": {
        Button: "Button",
        Card: "Card",
        CheckRow: "CheckRow",
        ErrorNotice: "ErrorNotice",
        Field: "Field",
        s: {},
      },
      "./workspace": { useWorkspace: () => ({ api }) },
    },
  );
  return { view, selection, api };
}

test("ProfileSettings discards delayed history across scope and binds restore to the displayed entity", async () => {
  const old = deferred<unknown>();
  const calls: { path: string; body?: unknown }[] = [];
  const { view } = fixture(async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/agent/profile") return profile("en-US");
    if (path === "/api/agent/profile?threadId=a") return profile("pt-BR");
    if (path === "/api/agent/profile/history?limit=10") return old.promise;
    if (path === "/api/agent/profile/history?limit=10&threadId=a")
      return history("conversation:a", "es-ES");
    if (path === "/api/agent/profile/restore") return profile("es-ES");
    throw new Error(path);
  });
  try {
    view.render();
    await view.flush();
    view.button("Preference history").onPress();
    view.button("Current conversation").onPress();
    view.render();
    await view.flush();
    old.resolve(history("global", "fr-FR"));
    await view.flush();
    assert.doesNotMatch(view.text(), /fr-FR/);
    view.button("Preference history").onPress();
    await view.flush();
    assert.match(view.text(), /es-ES/);
    view.button("Restore revision 1").onPress();
    await view.flush();
    const restored = calls.find((entry) => entry.path.endsWith("/restore"));
    assert.ok(restored);
    assert.equal(
      JSON.stringify((restored.body as { scope: unknown }).scope),
      JSON.stringify({ kind: "conversation", threadId: "a" }),
    );
  } finally {
    view.close();
  }
});

test("ProfileSettings discards history and captured restore actions after thread or pairing identity changes", async () => {
  for (const changed of ["thread", "identity"] as const) {
    const old = deferred<unknown>();
    let pending = false;
    let restores = 0;
    const { view, selection, api } = fixture(async (path) => {
      if (path.startsWith("/api/agent/profile/history"))
        return pending ? old.promise : history(`conversation:${selection.id}`, "fr-FR");
      if (path.endsWith("/restore")) {
        restores++;
        return profile("fr-FR");
      }
      return profile(api.identityKey === "owner-one" ? "pt-BR" : "en-US");
    });
    try {
      view.render();
      await view.flush();
      view.button("Current conversation").onPress();
      view.render();
      await view.flush();
      view.button("Preference history").onPress();
      await view.flush();
      const captured = view.button("Restore revision 1").onPress;
      pending = true;
      view.button("Preference history").onPress();
      if (changed === "thread") selection.id = "b";
      else api.identityKey = "owner-two";
      view.render();
      await view.flush();
      captured();
      await view.flush();
      assert.equal(restores, 0, "a rendered action cannot mutate a different target later");
      old.resolve(history("conversation:a", "fr-FR"));
      await view.flush();
      assert.doesNotMatch(view.text(), /fr-FR/);
      assert.equal(view.field("Language / locale"), changed === "identity" ? "en-US" : "pt-BR");
    } finally {
      view.close();
    }
  }
});

test("ProfileSettings ignores in-flight restore responses when scope, thread or identity changed", async () => {
  for (const changed of ["scope", "thread", "identity"] as const) {
    const restored = deferred<unknown>();
    const { view, selection, api } = fixture(async (path) => {
      if (path.endsWith("/restore")) return restored.promise;
      if (path.startsWith("/api/agent/profile/history"))
        return history(changed === "scope" ? "global" : "conversation:a", "fr-FR");
      return profile(api.identityKey === "owner-one" ? "pt-BR" : "en-US");
    });
    try {
      view.render();
      await view.flush();
      if (changed !== "scope") {
        view.button("Current conversation").onPress();
        view.render();
        await view.flush();
      }
      view.button("Preference history").onPress();
      await view.flush();
      view.button("Restore revision 1").onPress();
      if (changed === "scope") view.button("Current conversation").onPress();
      else if (changed === "thread") selection.id = "b";
      else api.identityKey = "owner-two";
      view.render();
      await view.flush();
      restored.resolve(profile("fr-FR"));
      await view.flush();
      assert.equal(view.field("Language / locale"), changed === "identity" ? "en-US" : "pt-BR");
      assert.doesNotMatch(view.text(), /fr-FR/);
    } finally {
      view.close();
    }
  }
});
