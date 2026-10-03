import { KeyRound, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime";
import { CodexConnection } from "./codex-connection";
import { CredentialRequestCard } from "./credential-request";
import { useI18n } from "./i18n";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

type Integration = {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "invalid_credentials" | "unavailable";
  origin: string;
  description: string;
};
export function IntegrationSettings() {
  const { api } = useWorkspace();
  const { t } = useI18n();
  const [items, setItems] = useState<Integration[]>();
  const [request, setRequest] = useState<CredentialInteractionRequest>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .request<Integration[]>("/api/integrations")
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      setRequest(
        await api.request<CredentialInteractionRequest>("/api/integrations/tavily/request", {}),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/integrations/tavily/disconnect", {});
      setRequest(undefined);
      setConfirmDisconnect(false);
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { gap: 9 }]}>
        <KeyRound size={19} color={colors.muted} />
        <Text style={s.heading}>{t("Connected services")}</Text>
      </View>
      <CodexConnection />
      {!items && !error && <ActivityIndicator color={colors.muted} />}
      {items?.map((item) => (
        <View
          key={item.id}
          style={{ padding: 16, gap: 12, borderRadius: 18, backgroundColor: "#F3F3F4" }}
        >
          <View style={[s.row, { gap: 11 }]}>
            <Search size={20} color={colors.text} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={s.heading}>{item.name}</Text>
              <Text style={s.small}>
                {t(
                  item.status === "connected"
                    ? "Connected"
                    : item.status === "unavailable"
                      ? "Not available"
                      : item.status === "invalid_credentials"
                        ? "Update your API key"
                        : "Not connected",
                )}
              </Text>
            </View>
          </View>
          <Text style={s.muted}>{t("Search the web with Tavily using your own API key.")}</Text>
          {item.status === "connected" ? (
            <View style={{ gap: 8 }}>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Button small busy={busy} onPress={() => void connect()}>
                  {t("Update key")}
                </Button>
                <Button small danger disabled={busy} onPress={() => setConfirmDisconnect(true)}>
                  {t("Disconnect")}
                </Button>
              </View>
              {confirmDisconnect && (
                <>
                  <Text style={s.muted}>
                    {t(
                      "Remove the saved Tavily key? Web search will use the other available sources.",
                    )}
                  </Text>
                  <View style={[s.row, { gap: 8 }]}>
                    <Button small onPress={() => setConfirmDisconnect(false)}>
                      {t("Cancel")}
                    </Button>
                    <Button small danger busy={busy} onPress={() => void disconnect()}>
                      {t("Disconnect Tavily")}
                    </Button>
                  </View>
                </>
              )}
            </View>
          ) : (
            <Button
              small
              icon={KeyRound}
              busy={busy}
              disabled={item.status === "unavailable"}
              onPress={() => void connect()}
            >
              {t("Connect Tavily")}
            </Button>
          )}
        </View>
      ))}
      {request && (
        <CredentialRequestCard request={request} onSaved={() => setAttempt((value) => value + 1)} />
      )}
      <ErrorNotice error={error} />
      {!!error && !items && (
        <Button
          small
          onPress={() => {
            setError("");
            setAttempt((value) => value + 1);
          }}
        >
          {t("Retry")}
        </Button>
      )}
    </View>
  );
}
