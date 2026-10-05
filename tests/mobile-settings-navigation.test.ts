import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

function fixture(width = 390) {
  let closed = 0;
  const view = componentHarness(
    new URL("../apps/mobile/src/muse-settings.tsx", import.meta.url),
    "SettingsDialog",
    {
      "lucide-react-native": Object.fromEntries(
        [
          "Bell",
          "ChevronLeft",
          "ChevronRight",
          "Cpu",
          "Fingerprint",
          "Globe2",
          "LayoutGrid",
          "Moon",
          "Settings2",
          "ShieldCheck",
          "Sparkles",
          "X",
        ].map((key) => [key, key]),
      ),
      "react-native": {
        Pressable: "Button",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        useWindowDimensions: () => ({ width }),
      },
      "./agent-workspace": { useAgentWorkspace: () => ({ data: { identity: {} } }) },
      "./app-install": { AppInstall: "AppInstall" },
      "./avatar-studio": { AvatarStudio: "AvatarStudio" },
      "./desktop-shell": {
        AppLanguagePicker: "AppLanguagePicker",
        AssistantChatPreferences: "AssistantChatPreferences",
      },
      "./i18n": { useI18n: () => ({ t: (key: string) => key, locale: "en" }) },
      "./memory-settings": { MemorySettings: "MemorySettings" },
      "./model-settings": { ModelSettings: "ModelSettings" },
      "./native-push-settings": { NativePushSettings: "NativePushSettings" },
      "./proactivity-settings": { ProactivitySettings: "ProactivitySettings" },
      "./profile-settings": { ProfileSettings: "ProfileSettings" },
      "./screens": { ConnectionsScreen: "ConnectionsScreen" },
      "./theme-picker": { ThemePicker: "ThemePicker" },
      "./ui": {
        Button: "Button",
        IconButton: "IconButton",
        Mascot: "Mascot",
        ModalSurface: "ModalSurface",
        Sheet: "Sheet",
      },
      "./workspace": { useWorkspace: () => ({ workspace: { actions: [] }, open: () => {} }) },
    },
    {
      onClose: () => {
        closed++;
      },
      onCustomize: () => {},
    },
  );
  view.render();
  return {
    view,
    closed: () => closed,
    back: () => {
      const modal = view.nodes().find((node) => node.type === "ModalSurface");
      assert.ok(modal);
      const props = modal.props;
      (typeof props.onBack === "function" ? props.onBack : (props.onClose as () => void))();
      view.render();
    },
  };
}

test("mobile system Back returns from a settings section before closing the dialog", () => {
  const { view, back, closed } = fixture();
  try {
    view.button("Memory").onPress();
    view.render();
    assert.ok(view.nodes().some((node) => node.type === "MemorySettings"));
    back();
    assert.equal(closed(), 0);
    assert.ok(view.button("Models"));
    back();
    assert.equal(closed(), 1);
  } finally {
    view.close();
  }
});

test("desktop Escape closes settings without adding a mobile navigation step", () => {
  const { view, back, closed } = fixture(1280);
  try {
    back();
    assert.equal(closed(), 1);
  } finally {
    view.close();
  }
});
