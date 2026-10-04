import assert from "node:assert/strict";
import test from "node:test";
import { darkColors, lightColors } from "../apps/mobile/src/theme-palette.ts";
import { componentHarness } from "./helpers/component.ts";

function contrast(a: string, b: string) {
  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
for (const [theme, colors] of Object.entries({ light: lightColors, dark: darkColors })) {
  test(`checkbox checked mark and unchecked boundary remain visible in ${theme}`, () => {
    const view = componentHarness(
      new URL("../apps/mobile/src/ui.tsx", import.meta.url),
      "CheckRow",
      {
        "lucide-react-native": { Check: "Check" },
        "react-native": {
          Pressable: "Pressable",
          View: "View",
          Text: "Text",
          StyleSheet: { create: (s: unknown) => s },
        },
        "react-native-safe-area-context": {},
        "react-native-svg": {},
        "./avatar-presentation": {},
        "./avatar-renderer": {},
        "./credential-prompts-state": {},
        "./i18n": { useI18n: () => ({ t: (s: string) => s }) },
        "./display-date": {},
        "./theme": { useTheme: () => ({ colors }) },
      },
    );
    try {
      view.render({ label: "Choice", checked: true, onPress: () => {} });
      const box = view.nodes().find((n) => n.type === "View")?.props.style as Record<
        string,
        string
      >;
      const check = view.nodes().find((n) => n.type === "Check");
      assert.ok(check);
      assert.ok(
        contrast(String(check.props.color), box.backgroundColor) >= 4.5,
        "check must contrast against its own fill",
      );
      view.render({ label: "Choice", checked: false, onPress: () => {} });
      const unchecked = view.nodes().find((n) => n.type === "View")?.props.style as Record<
        string,
        string
      >;
      assert.ok(
        contrast(unchecked.borderColor, colors.card) >= 3,
        "unselected control must remain discoverable",
      );
      assert.equal(view.nodes()[0].props["aria-checked"], false);
    } finally {
      view.close();
    }
  });
}
