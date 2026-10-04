import { Monitor, Moon, Sun } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import { ErrorNotice, useUI } from "./ui";

export function ThemePicker() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const { colors, s } = useUI();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.heading}>{t("App theme")}</Text>
      <Text style={s.muted}>
        {t("Choose a look, or follow your device. Saved on this device.")}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("App theme")}
        style={{ flexDirection: "row", gap: 8 }}
      >
        {(
          [
            { id: "light", label: "Light", Icon: Sun },
            { id: "dark", label: "Dark", Icon: Moon },
            { id: "system", label: "System", Icon: Monitor },
          ] as const
        ).map(({ id, label, Icon }) => (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={t(label)}
            aria-checked={mode === id}
            aria-disabled={busy}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError("");
              void setMode(id)
                .catch(() => setError(t("Could not save the theme. Try again.")))
                .finally(() => setBusy(false));
            }}
            style={{
              flex: 1,
              minHeight: 78,
              gap: 8,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 14,
              borderWidth: 1.5,
              borderColor: mode === id ? colors.selectedBorder : colors.line,
              backgroundColor: mode === id ? colors.selected : colors.card,
            }}
          >
            <Icon size={21} color={mode === id ? colors.selectedText : colors.muted} />
            <Text
              style={{
                color: mode === id ? colors.selectedText : colors.text,
                fontSize: 13,
                fontWeight: mode === id ? "700" : "500",
              }}
            >
              {t(label)}
            </Text>
          </Pressable>
        ))}
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
