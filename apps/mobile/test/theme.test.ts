import assert from "node:assert/strict";
import { test } from "node:test";
import { darkColors, lightColors } from "../src/theme-palette.ts";
import { resolveTheme, ThemeStore } from "../src/theme-store.ts";

test("system theme follows the device while explicit choices override it", () => {
  assert.equal(resolveTheme("system", "dark"), "dark");
  assert.equal(resolveTheme("system", null), "light");
  assert.equal(resolveTheme("light", "dark"), "light");
  assert.equal(resolveTheme("dark", "light"), "dark");
});

test("a delayed restored preference cannot replace the user's new theme choice", async () => {
  let restore!: (value: string) => void;
  const writes: string[] = [];
  const store = new ThemeStore({
    read: () =>
      new Promise((resolve) => {
        restore = resolve;
      }),
    write: async (_key, value) => {
      writes.push(value);
    },
  });
  const loading = store.restore();
  await store.set("dark");
  restore("light");
  await loading;
  assert.equal(store.get(), "dark");
  assert.deepEqual(writes, ["dark"]);
});

test("theme persistence failures retain the last saved mode and allow retry", async () => {
  let fail = true;
  const store = new ThemeStore({
    read: async () => "light",
    write: async () => {
      if (fail) throw new Error("Offline storage");
    },
  });
  await store.restore();
  await assert.rejects(store.set("dark"), /Offline storage/);
  assert.equal(store.get(), "light");
  fail = false;
  await store.set("dark");
  assert.equal(store.get(), "dark");
});

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("body, secondary and selected conversation text have readable contrast in both themes", () => {
  for (const colors of [lightColors, darkColors]) {
    for (const surface of [colors.canvas, colors.card, colors.subtle]) {
      assert.ok(contrast(colors.text, surface) >= 4.5);
      assert.ok(contrast(colors.muted, surface) >= 4.5);
    }
    assert.ok(contrast(colors.selectedText, colors.selected) >= 4.5);
    assert.ok(contrast(colors.onAccent, colors.accent) >= 4.5);
    assert.ok(contrast(colors.selectedBorder, colors.canvas) >= 3);
  }
});
