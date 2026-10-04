import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Appearance, Platform } from "react-native";
import { messageStorage } from "./message-storage";
import { darkColors, lightColors, type ThemeColors } from "./theme-palette";
import { resolveTheme, ThemeStore } from "./theme-store";

const store = new ThemeStore(messageStorage);
const webThemeQuery = () =>
  Platform.OS === "web" && typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;
const systemTheme = () => {
  const query = webThemeQuery();
  return query ? (query.matches ? "dark" : "light") : Appearance.getColorScheme();
};
const subscribeSystemTheme = (notify: () => void) => {
  const query = webThemeQuery();
  if (query) {
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  }
  const subscription = Appearance.addChangeListener(notify);
  return () => subscription.remove();
};
export function useTheme() {
  const mode = useSyncExternalStore(store.subscribe, store.get, () => "system" as const);
  const system = useSyncExternalStore(subscribeSystemTheme, systemTheme, () => "light" as const);
  useEffect(() => {
    void store.restore();
  }, []);
  const scheme = resolveTheme(mode, system);
  return { mode, scheme, colors: scheme === "dark" ? darkColors : lightColors, setMode: store.set };
}
export function useThemedStyles<T>(create: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => create(colors), [create, colors]);
}
