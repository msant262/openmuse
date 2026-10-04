import { KeyRound } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { CodexConnection } from "./codex-connection";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type SavedConnection = {
  id: string;
  kind: "api" | "browser";
  serviceName: string;
  origin: string;
  status: string;
  updatedAt?: string;
};

export function IntegrationSettings({ query = "" }: { query?: string }) {
  const { colors, s } = useUI();

  const { api, ask } = useWorkspace();
  const { t } = useI18n();
  const [items, setItems] = useState<SavedConnection[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string>();
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.request<{ connections: Omit<SavedConnection, "kind">[] }>("/api/service-credentials"),
      api.request<{ connections: Omit<SavedConnection, "kind">[] }>("/api/credentials"),
    ])
      .then(([apiConnections, browserConnections]) => {
        if (active) {
          const connections: SavedConnection[] = [
            ...apiConnections.connections.map((connection) => ({
              ...connection,
              kind: "api" as const,
            })),
            ...browserConnections.connections.map((connection) => ({
              ...connection,
              kind: "browser" as const,
            })),
          ].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
          setItems(connections.filter((connection) => connection.status !== "revoked"));
          setError("");
        }
      })
      .catch(() => {
        if (active) setError(t("Saved connections could not be loaded."));
      });
    return () => {
      active = false;
    };
  }, [api, attempt, t]);
  async function disconnect(connection: SavedConnection) {
    setBusy(connection.id);
    setError("");
    try {
      const prefix =
        connection.kind === "browser" ? "/api/credentials" : "/api/service-credentials";
      await api.request(`${prefix}/${encodeURIComponent(connection.id)}/revoke`, {});
      setConfirmDisconnect(undefined);
      setAttempt((value) => value + 1);
    } catch {
      setError(t("The connection could not be removed. Try again."));
    } finally {
      setBusy(undefined);
    }
  }
  const matching = items?.filter((item) =>
    `${item.serviceName} ${item.origin}`.toLowerCase().includes(query.toLowerCase()),
  );
  const showCodex =
    !query || "chatgpt codex openai assinatura subscription".includes(query.toLowerCase());
  if (items && !matching?.length && !showCodex) return null;
  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { gap: 9 }]}>
        <KeyRound size={19} color={colors.muted} />
        <Text style={s.heading}>{t("Connected services")}</Text>
      </View>
      {showCodex && <CodexConnection />}
      <Text style={s.muted}>
        {t(
          "When your agent needs a credential, a secure form opens automatically. Saved connections appear here.",
        )}
      </Text>
      {!items && !error && <ActivityIndicator color={colors.muted} />}
      {items?.length === 0 && <Text style={s.small}>{t("No saved service credentials yet.")}</Text>}
      {matching?.map((item) => (
        <View
          key={`${item.kind}:${item.id}`}
          style={{ padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.subtle }}
        >
          <View style={[s.row, { gap: 11 }]}>
            <KeyRound size={20} color={colors.text} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={s.heading}>{item.serviceName}</Text>
              <Text style={s.small}>{item.origin}</Text>
            </View>
          </View>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              disabled={!!busy}
              onPress={() =>
                ask(
                  t(
                    "Update the credential for {service} at {origin}. Open the secure credential form and continue when I save it.",
                    { service: item.serviceName, origin: item.origin },
                  ),
                )
              }
            >
              {t("Update credential")}
            </Button>
            <Button small danger disabled={!!busy} onPress={() => setConfirmDisconnect(item.id)}>
              {t("Disconnect")}
            </Button>
          </View>
          {confirmDisconnect === item.id && (
            <>
              <Text style={s.muted}>
                {t("Remove the saved credential for {service}?", { service: item.serviceName })}
              </Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button small disabled={!!busy} onPress={() => setConfirmDisconnect(undefined)}>
                  {t("Cancel")}
                </Button>
                <Button small danger busy={busy === item.id} onPress={() => void disconnect(item)}>
                  {t("Disconnect")}
                </Button>
              </View>
            </>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => setAttempt((value) => value + 1)}>
          {t("Retry")}
        </Button>
      )}
    </View>
  );
}
