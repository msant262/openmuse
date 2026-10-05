import { Download, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, Sheet, useUI } from "./ui";

export function AppInstall({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { s } = useUI();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  if (Platform.OS !== "web") return null;
  return (
    <>
      <Button small={compact} icon={Smartphone} onPress={() => setOpen(true)}>
        {t("Install app")}
      </Button>
      {open && (
        <Sheet title={t("Okami on your phone")} onClose={() => setOpen(false)}>
          <View style={{ gap: 18 }}>
            <Text style={s.heading}>Android</Text>
            <Text style={s.text}>
              {t(
                "Download the Android app and open the file to install it. Your conversations stay in the same workspace.",
              )}
            </Text>
            <Button
              primary
              icon={Download}
              onPress={() => {
                setError("");
                void Linking.openURL(
                  `https://app.okamibot.cloud/downloads/okamibot.apk?v=${Date.now()}`,
                ).catch(() => setError(t("Could not open the download. Try again.")));
              }}
            >
              {t("Download Android app")}
            </Button>
            <Text style={s.small}>
              {t("Android may ask you to allow installation from your browser.")}
            </Text>
            <Text style={s.heading}>iPhone / iPad</Text>
            <Text style={s.text}>
              {t(
                "Open this site in Safari, tap Share, then Add to Home Screen. There is no iOS store download yet.",
              )}
            </Text>
            <ErrorNotice error={error} />
          </View>
        </Sheet>
      )}
    </>
  );
}
