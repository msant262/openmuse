import { Check, Cpu } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Preferences = {
  selected: string | null;
  effective: string | null;
  models: { id: string; label: string; provider: string; available: boolean }[];
  fallbacks: string[];
};
export function ModelSettings() {
  const { colors, s } = useUI();

  const { api } = useWorkspace();
  const { t } = useI18n();
  const [data, setData] = useState<Preferences>();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api
      .request<Preferences>("/api/models/preferences")
      .then((value) => {
        if (active) {
          setData(value);
          setSelected(value.selected);
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const value = await api.request<Preferences>(
        "/api/models/preferences",
        { model: selected },
        "PUT",
      );
      setData(value);
      setSelected(value.selected);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { gap: 9 }]}>
        <Cpu size={20} color={colors.muted} />
        <Text style={s.heading}>{t("Conversation model")}</Text>
      </View>
      <Text style={s.muted}>
        {t(
          "Choose the model for new replies and tasks. Your connected accounts determine what is available.",
        )}
      </Text>
      {!data && !error && <ActivityIndicator color={colors.muted} />}
      {data && (
        <>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("Conversation model")}
            style={{ backgroundColor: colors.subtle, borderRadius: 18, overflow: "hidden" }}
          >
            {[
              {
                id: null,
                label: t("Automatic"),
                provider: t("Use the default model and available fallbacks"),
                available: true,
              },
              ...data.models,
            ].map((model, index) => (
              <Pressable
                key={model.id ?? "automatic"}
                accessibilityRole="radio"
                aria-checked={selected === model.id}
                accessibilityLabel={model.label}
                accessibilityState={{
                  checked: selected === model.id,
                  disabled: !model.available || busy,
                }}
                disabled={!model.available || busy}
                onPress={() => {
                  setSelected(model.id);
                  setSaved(false);
                }}
                style={[
                  s.row,
                  {
                    gap: 12,
                    padding: 15,
                    borderTopWidth: index ? 1 : 0,
                    borderColor: colors.line,
                    opacity: model.available ? 1 : 0.5,
                  },
                ]}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.text}>{model.label}</Text>
                  <Text style={s.small}>
                    {model.available ? model.provider : t("Account not connected")}
                  </Text>
                </View>
                <View
                  style={{
                    width: 21,
                    height: 21,
                    borderRadius: 11,
                    borderWidth: selected === model.id ? 0 : 1,
                    borderColor: colors.line,
                    backgroundColor: selected === model.id ? colors.blueDark : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected === model.id && <Check size={14} color={colors.onFeature} />}
                </View>
              </Pressable>
            ))}
          </View>
          {data.effective && (
            <Text style={s.small}>
              {t("Currently using: {model}", {
                model:
                  data.models.find((model) => model.id === data.effective)?.label || data.effective,
              })}
            </Text>
          )}
          <Button
            primary
            busy={busy}
            disabled={selected === data.selected}
            onPress={() => void save()}
          >
            {t("Save model")}
          </Button>
          {saved && (
            <Text accessibilityLiveRegion="polite" style={s.muted}>
              {t("Model saved. Your next reply will use this preference.")}
            </Text>
          )}
        </>
      )}
      <ErrorNotice error={error} />
      {!!error && !data && (
        <Button small onPress={() => setAttempt((value) => value + 1)}>
          {t("Retry")}
        </Button>
      )}
    </View>
  );
}
