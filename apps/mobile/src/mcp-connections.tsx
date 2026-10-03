import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

type Connection = {
  id: string;
  origin: string;
  account: string;
  transport: string;
  tools: string[];
  oauth: boolean;
  status: string;
};
export function McpConnections({ query = "" }: { query?: string }) {
  const { t } = useI18n();
  const { api, notify } = useWorkspace();
  const [rows, setRows] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string>();
  const load = async () => setRows(await api.request<Connection[]>("/api/mcp/connections"));
  useEffect(() => {
    let active = true;
    void api
      .request<Connection[]>("/api/mcp/connections")
      .then((value) => {
        if (active) setRows(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  async function change(row: Connection, operation: "connect" | "disconnect") {
    setBusy(row.id);
    setError("");
    try {
      const result = await api.request<{ url?: string }>(
        `/api/mcp/connections/${row.id}/${operation}`,
        {},
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify(t("Finish authorization in your browser, then refresh the connection."));
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not connect the app."));
    } finally {
      setBusy(undefined);
    }
  }
  const visible = rows.filter((row) =>
    `${row.id} ${row.account} ${row.origin}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (!visible.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.heading}>{t("Connected apps")}</Text>
      {error ? <ErrorNotice error={error} /> : null}
      {visible.map((row) => (
        <Card key={row.id} style={{ gap: 8 }}>
          <Text style={s.heading}>{row.id}</Text>
          <Text style={s.small}>
            {row.origin} · {row.account}
          </Text>
          <Text style={s.muted}>
            {row.status === "configured"
              ? t("Configured on server")
              : row.status === "connected"
                ? t("Connected")
                : row.status === "connecting"
                  ? t("Waiting for authorization")
                  : t("Needs connection")}
          </Text>
          <Text style={s.small}>
            {t("{count} allowed tools: {tools}", {
              count: row.tools.length,
              tools: row.tools.join(", "),
            })}
          </Text>
          {row.oauth ? (
            <Button
              busy={busy === row.id}
              disabled={Boolean(busy)}
              onPress={() =>
                void change(row, row.status === "connected" ? "disconnect" : "connect")
              }
            >
              {row.status === "connected" ? t("Disconnect") : t("Connect account")}
            </Button>
          ) : null}
        </Card>
      ))}
      <Button
        disabled={Boolean(busy)}
        onPress={() =>
          void load().catch((cause) =>
            setError(cause instanceof Error ? cause.message : t("Could not refresh")),
          )
        }
      >
        {t("Refresh connections")}
      </Button>
    </View>
  );
}
