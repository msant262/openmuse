import { ExternalLink, KeyRound } from "lucide-react-native";
import { useState } from "react";
import { Linking, Text, TextInput, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ComposioSetup({ onConnected }: { onConnected: () => void }) {
  const { api } = useWorkspace();
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request("/api/composio/setup", { apiKey: apiKey.trim() }, "PUT");
      setApiKey("");
      onConnected();
    } catch {
      setError(t("The key could not be verified. Check your Composio project key and try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ padding: 18, gap: 14, borderRadius: 18, backgroundColor: "#F3F3F4" }}>
      <View style={[s.row, { gap: 9 }]}>
        <KeyRound size={19} color={colors.muted} />
        <Text style={[s.heading, { flex: 1 }]}>{t("Activate the app catalog")}</Text>
      </View>
      <Text style={s.muted}>
        {t(
          "Connect your Composio project to browse apps and authorize accounts here. Your project key is stored securely, outside the chat.",
        )}
      </Text>
      <Button
        small
        icon={ExternalLink}
        onPress={() =>
          void Linking.openURL("https://dashboard.composio.dev").catch(() =>
            setError(t("Could not open the Composio dashboard.")),
          )
        }
      >
        {t("Open Composio dashboard")}
      </Button>
      <View style={{ gap: 7 }}>
        <Text style={s.small}>{t("Composio project key")}</Text>
        <TextInput
          accessibilityLabel={t("Composio project key")}
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          editable={!busy}
          placeholder={t("Paste your project key")}
          placeholderTextColor={colors.muted}
          style={[s.input, { minWidth: 0, backgroundColor: "#FFF" }]}
        />
      </View>
      <ErrorNotice error={error} />
      <Button primary busy={busy} disabled={!apiKey.trim() || busy} onPress={() => void save()}>
        {t("Activate catalog")}
      </Button>
    </View>
  );
}
