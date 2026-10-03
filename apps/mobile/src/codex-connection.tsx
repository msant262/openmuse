import { CheckCircle2, ExternalLink, Image as ImageIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

type Connection = {
  connected: boolean;
  account?: string;
  flow?: {
    id: string;
    status: "starting" | "waiting" | "connected" | "cancelled" | "expired" | "error";
    url?: string;
    code?: string;
    expiresAt?: string;
    message?: string;
  };
};
export function CodexConnection() {
  const { api } = useWorkspace();
  const { t } = useI18n();
  const [data, setData] = useState<Connection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(false);
  const waiting = data?.flow?.status === "waiting" || data?.flow?.status === "starting";
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api
        .request<Connection>("/api/connections/codex")
        .then((value) => {
          if (active) {
            setData(value);
            setError("");
          }
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        });
    void refresh();
    const timer = waiting ? setInterval(() => void refresh(), 3000) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [api, waiting, attempt]);
  async function action(kind: "start" | "cancel" | "disconnect") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<Connection>(
        `/api/connections/codex/${kind}`,
        kind === "cancel" ? { flowId: data?.flow?.id } : {},
      );
      setData(result);
      setRemoving(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const flow = data?.flow;
  const verificationUrl =
    flow?.url && /^https:\/\/(?:auth\.openai\.com|chatgpt\.com)\//.test(flow.url)
      ? flow.url
      : undefined;
  return (
    <View style={{ backgroundColor: "#F3F3F4", borderRadius: 18, padding: 16, gap: 13 }}>
      <View style={[s.row, { gap: 11 }]}>
        <ImageIcon size={20} color={colors.text} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.heading}>{t("ChatGPT images")}</Text>
          <Text style={s.small}>
            {data?.connected ? t("Connected with Codex") : t("Your ChatGPT subscription")}
          </Text>
        </View>
        {data?.connected && <CheckCircle2 size={18} color="#519270" />}
      </View>
      <Text style={s.muted}>
        {t(
          data?.connected
            ? "Image requests can use this connected ChatGPT account."
            : waiting
              ? "Sign in on OpenAI’s page using the code below."
              : "Connect your ChatGPT account through Codex to generate images.",
        )}
      </Text>
      {!data && !error && <ActivityIndicator color={colors.muted} />}
      {data?.connected && !waiting && (
        <View style={{ gap: 10 }}>
          {!!data.account && <Text style={s.small}>{data.account}</Text>}
          {removing ? (
            <>
              <Text style={s.muted}>
                {t(
                  "Disconnect image generation? Your conversation model connection stays available.",
                )}
              </Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button small onPress={() => setRemoving(false)}>
                  {t("Cancel")}
                </Button>
                <Button small danger busy={busy} onPress={() => void action("disconnect")}>
                  {t("Disconnect")}
                </Button>
              </View>
            </>
          ) : (
            <Button small disabled={busy} onPress={() => setRemoving(true)}>
              {t("Disconnect")}
            </Button>
          )}
        </View>
      )}
      {waiting && (
        <View style={{ gap: 12 }}>
          {!!flow?.code && (
            <View
              style={{
                backgroundColor: "#FFF",
                borderRadius: 12,
                padding: 17,
                alignItems: "center",
                gap: 6,
              }}
            >
              <Text style={s.small}>{t("Your connection code")}</Text>
              <Text
                selectable
                style={{ fontSize: 24, letterSpacing: 3, fontWeight: "600", color: colors.text }}
              >
                {flow.code}
              </Text>
            </View>
          )}
          {verificationUrl && (
            <Button
              small
              primary
              icon={ExternalLink}
              onPress={() =>
                void Linking.openURL(verificationUrl).catch((cause) => setError(String(cause)))
              }
            >
              {t("Open OpenAI sign-in")}
            </Button>
          )}
          <Text accessibilityLiveRegion="polite" style={s.small}>
            {t("Waiting for you to finish connecting. This screen updates automatically.")}
          </Text>
          <Button small disabled={busy} onPress={() => void action("cancel")}>
            {t("Cancel connection")}
          </Button>
        </View>
      )}
      {!waiting && !data?.connected && data && (
        <Button small primary busy={busy} onPress={() => void action("start")}>
          {t("Connect ChatGPT for images")}
        </Button>
      )}
      {flow?.status === "expired" && (
        <Text style={s.muted}>{t("This code expired. Start a new connection.")}</Text>
      )}
      {flow?.status === "error" && (
        <Text style={s.muted}>{t("Could not connect this account. Try again.")}</Text>
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
