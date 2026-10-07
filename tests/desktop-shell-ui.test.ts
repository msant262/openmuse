import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

function fixture(setLocale: (locale: "en" | "pt-BR") => Promise<void>) {
  return componentHarness(
    new URL("../apps/mobile/src/desktop-shell.tsx", import.meta.url),
    "AppLanguagePicker",
    {
      "@copilotkit/react-native/headless": {},
      "lucide-react-native": {},
      "react-native": {
        Text: "Text",
        View: "View",
        useWindowDimensions: () => ({ width: 1440 }),
      },
      "./agent-workspace": {},
      "./agent-identity-panel": {},
      "./avatar-presentation": {},
      "./avatar-thumbnail": {},
      "./computer": {},
      "./companion-heading": {},
      "./conversation-label": {},
      "./desktop-shell-styles": { desktopStyles: {} },
      "./i18n": { useI18n: () => ({ locale: "en", setLocale, t: (key: string) => key }) },
      "./google-actions-screen": {},
      "./muse-surfaces-model": {},
      "./thread-actions": {},
      "./task-removal": {},
      "./task-status": {},
      "./memory-settings": { MemorySettings: "MemorySettings" },
      "./message-storage": {},
      "./profile-settings": { ProfileSettings: "ProfileSettings" },
      "./threads": {},
      "./ui": {
        Button: "Button",
        Card: "Card",
        ErrorNotice: ({ error }: { error: string }) => error,
        s: {},
      },
      "./workspace": {},
    },
  );
}

test("sign-in and settings save the chosen app language and prevent overlapping writes", async () => {
  let resolve!: () => void;
  const changed: string[] = [];
  const view = fixture(async (locale) => {
    changed.push(locale);
    await new Promise<void>((done) => {
      resolve = done;
    });
  });
  try {
    view.render();
    view.button("Portuguese (Brazil)").onPress();
    view.render();
    assert.deepEqual(changed, ["pt-BR"]);
    assert.equal(view.button("English").disabled, true);
    assert.equal(view.button("Portuguese (Brazil)").disabled, true);
    resolve();
    await view.flush();
    assert.equal(view.button("English").disabled, false);
    assert.equal(view.button("Portuguese (Brazil)").disabled, false);
  } finally {
    view.close();
  }
});

test("failed language persistence leaves the settings controls usable for retry", async () => {
  const changed: string[] = [];
  const view = fixture(async (locale) => {
    changed.push(locale);
    throw new Error("Storage unavailable");
  });
  try {
    view.render();
    view.button("Portuguese (Brazil)").onPress();
    await view.flush();
    assert.equal(view.button("Portuguese (Brazil)").disabled, false);
    view.button("Portuguese (Brazil)").onPress();
    await view.flush();
    assert.deepEqual(changed, ["pt-BR", "pt-BR"]);
  } finally {
    view.close();
  }
});
