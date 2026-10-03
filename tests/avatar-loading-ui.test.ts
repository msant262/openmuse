import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAvatarDesign } from "../packages/domain/src/avatar.ts";
import { componentHarness } from "./helpers/component.ts";

function fixture() {
  const ready: string[] = [];
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-renderer.native.tsx", import.meta.url),
    "AvatarRenderer",
    {
      "react-native": {
        View: "View",
        Text: "Text",
        ActivityIndicator: "ActivityIndicator",
        StyleSheet: { absoluteFill: {} },
        AccessibilityInfo: {
          isReduceMotionEnabled: async () => false,
          addEventListener: () => ({ remove() {} }),
        },
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
        Dimensions: { get: () => ({ width: 400, height: 800 }) },
      },
      "react-native-webview": { WebView: "WebView" },
      "../../../packages/domain/src/avatar": { resolveAvatarDesign },
      "./avatar/native-document": {
        avatarNativeDocument: () => "<html></html>",
        avatarUpdateScript: () => "true;",
      },
      "./avatar-thumbnail": { AvatarThumbnail: "AvatarThumbnail" },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
    },
    { active: false, onReady: (renderer: string) => ready.push(renderer) },
  );
  const has = (type: string) => view.nodes().some((node) => node.type === type);
  const message = (data: unknown) => {
    const webview = view.nodes().find((node) => node.type === "WebView");
    assert.ok(webview);
    (webview.props.onMessage as (event: unknown) => void)({
      nativeEvent: { data: JSON.stringify(data) },
    });
    view.render();
  };
  return { view, ready, has, message };
}

test("native avatar keeps a local preview until the renderer reports readiness", async () => {
  const { view, ready, has, message } = fixture();
  try {
    view.render();
    await view.flush();
    assert.equal(has("AvatarThumbnail"), true);
    assert.equal(has("ActivityIndicator"), true);
    assert.equal(has("WebView"), true);
    assert.equal(view.nodes()[0].props["aria-busy"], true);
    message({ type: "other-message", renderer: "webgl" });
    assert.equal(has("ActivityIndicator"), true);
    assert.deepEqual(ready, []);
    message({ type: "avatar-ready", renderer: "webgl" });
    assert.equal(has("AvatarThumbnail"), false);
    assert.equal(has("ActivityIndicator"), false);
    assert.equal(has("WebView"), true);
    assert.equal(view.nodes()[0].props["aria-busy"], false);
    assert.deepEqual(ready, ["webgl"]);
  } finally {
    view.close();
  }
});

test("native avatar failure replaces loading with an explicit static preview", async () => {
  const { view, ready, has, message } = fixture();
  try {
    view.render();
    await view.flush();
    message({ type: "avatar-ready", renderer: "fallback" });
    assert.equal(has("AvatarThumbnail"), true);
    assert.equal(has("ActivityIndicator"), false);
    assert.equal(has("WebView"), false);
    assert.equal(view.nodes()[0].props["aria-busy"], false);
    assert.match(view.text(), /Static preview · 3D unavailable on this device/);
    assert.deepEqual(ready, ["fallback"]);
  } finally {
    view.close();
  }
});
