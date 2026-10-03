import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AVATAR_PRESETS,
  avatarDesignSchema,
  resolveAvatarDesign,
} from "../packages/domain/src/avatar.ts";
import { componentHarness } from "./helpers/component.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(request: (path: string, body?: unknown) => Promise<unknown>) {
  const api = { identityKey: "owner-one", request };
  const notifications: string[] = [];
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-studio.tsx", import.meta.url),
    "AvatarStudio",
    {
      "react-native": {
        Text: "Text",
        Platform: { OS: "web" },
        useWindowDimensions: () => ({ width: 1440 }),
        View: "View",
        Pressable: "Button",
        StyleSheet: { create: (value: unknown) => value },
      },
      "../../../packages/domain/src/avatar": {
        AVATAR_PRESETS,
        avatarDesignSchema,
        resolveAvatarDesign,
      },
      "./agent-workspace": { useAgentWorkspace: () => ({ refresh: async () => {} }) },
      "./avatar-renderer": { AvatarRenderer: "AvatarRenderer" },
      "./avatar-thumbnail": { AvatarThumbnail: "AvatarThumbnail" },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./ui": { Button: "Button", ErrorNotice: "ErrorNotice", Field: "Field" },
      "./workspace": {
        useWorkspace: () => ({ api, notify: (message: string) => notifications.push(message) }),
      },
    },
  );
  return { view, api, notifications };
}

test("avatar studio describes actual renderer readiness instead of the loaded profile", async () => {
  const { view } = fixture(async () => ({ identity: { avatarDesign: AVATAR_PRESETS[0] } }));
  try {
    view.render();
    await view.flush();
    assert.match(view.text(), /Loading your companion…/);
    const renderer = view.nodes().find((node) => node.type === "AvatarRenderer");
    assert.ok(renderer);
    (renderer.props.onReady as (kind: string) => void)("webgl");
    view.render();
    assert.match(view.text(), /Your companion, in motion/);
    assert.doesNotMatch(view.text(), /Loading your companion…/);
  } finally {
    view.close();
  }
});

test("avatar studio saves actual custom parameters and ignores a delayed save after pairing changes", async () => {
  const oldSave = deferred<unknown>();
  const calls: { path: string; body?: unknown }[] = [];
  const { view, api, notifications } = fixture(async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/agent/identity") return oldSave.promise;
    return {
      identity: {
        avatarDesign: api.identityKey === "owner-one" ? AVATAR_PRESETS[0] : AVATAR_PRESETS[4],
      },
    };
  });
  try {
    view.render();
    await view.flush();
    view.button("Create your ownStart from the current companion and make it yours.").onPress();
    view.render();
    view.button("Fine-tune appearance").onPress();
    view.render();
    view.button("Slender").onPress();
    view.render();
    const capturedSave = view.button("Save companion").onPress;
    capturedSave();
    view.render();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
      path: "/api/agent/identity",
      body: { avatarDesign: { ...AVATAR_PRESETS[0], preset: "custom", bodyShape: "slender" } },
    });
    api.identityKey = "owner-two";
    view.render();
    await view.flush();
    capturedSave();
    assert.equal(calls.filter((call) => call.path === "/api/agent/identity").length, 1);
    oldSave.resolve({
      avatarDesign: { ...AVATAR_PRESETS[0], preset: "custom", bodyShape: "slender" },
    });
    await view.flush();
    assert.equal(notifications.length, 0);
    assert.equal(view.button("Save companion").disabled, true);
    view.button("Create your ownStart from the current companion and make it yours.").onPress();
    view.render();
    assert.equal(view.field("Custom body color"), AVATAR_PRESETS[4].bodyColor);
  } finally {
    view.close();
  }
});

test("avatar studio keeps edits when saving fails and a retry saves the same design", async () => {
  let saveCalls = 0;
  const { view, notifications } = fixture(async (path, body) => {
    if (path === "/api/agent/identity") {
      saveCalls++;
      if (saveCalls === 1) throw new Error("offline");
      return { avatarDesign: (body as { avatarDesign: unknown }).avatarDesign };
    }
    return { identity: { avatarDesign: AVATAR_PRESETS[0] } };
  });
  try {
    view.render();
    await view.flush();
    view.button("Fox").onPress();
    view.render();
    view.button("Save companion").onPress();
    await view.flush();
    assert.equal(view.button("Save companion").disabled, false);
    assert.match(view.text(), /Changes are not saved yet/);
    view.button("Save companion").onPress();
    await view.flush();
    assert.equal(saveCalls, 2);
    assert.equal(view.button("Save companion").disabled, true);
    assert.deepEqual(notifications, ["Companion saved"]);
  } finally {
    view.close();
  }
});

test("avatar selection and motion expose their checked state to web accessibility", async () => {
  const { view } = fixture(async () => ({ identity: { avatarDesign: AVATAR_PRESETS[0] } }));
  try {
    view.render();
    await view.flush();
    assert.equal(Reflect.get(view.button("Fox"), "aria-checked"), false);
    view.button("Fox").onPress();
    view.render();
    assert.equal(Reflect.get(view.button("Fox"), "aria-checked"), true);
    assert.equal(Reflect.get(view.button("Capybara"), "aria-checked"), false);
    view.button("Thinking").onPress();
    view.render();
    assert.equal(Reflect.get(view.button("Thinking"), "aria-checked"), true);
    assert.equal(Reflect.get(view.button("Idle"), "aria-checked"), false);
  } finally {
    view.close();
  }
});
