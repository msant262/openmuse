import { useState } from "react";
import { Text, View } from "react-native";
import { enableNativePush } from "./native-push";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";
export function NativePushSettings() {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      setStatus(await enableNativePush(api, enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.heading}>{t("Phone notifications")}</Text>
      <Text style={s.small}>
        {t("Native delivery is optional. Results always stay in Activity. Delivery requires your phone's permission and server platform credentials.")}
      </Text>
      <View style={[s.row, { gap: 8 }]}>
        <Button small busy={busy} onPress={() => void change(true)}>
          {t("Enable")}
        </Button>
        <Button small disabled={busy} onPress={() => void change(false)}>
          {t("Disable")}
        </Button>
      </View>
      {status && <Text style={s.small}>{t(status)}</Text>}
      <ErrorNotice error={error} />
    </View>
  );
}
