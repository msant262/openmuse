import { ChevronDown, ChevronRight, Globe2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, useUI } from "./ui";
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
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { api, notify } = useWorkspace();
  const [rows, setRows] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
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
    <View style={{ gap: 8 }}>
      <Text style={[s.muted, { fontSize: 13 }]}>{t("Connected apps")}</Text>
      {error ? <ErrorNotice error={error} /> : null}
      <View style={{ backgroundColor: colors.subtle, borderRadius: 16, paddingHorizontal: 16 }}>
        {visible.map((row, index) => (
          <View
            key={row.id}
            style={{
              borderBottomWidth: index < visible.length - 1 ? 1 : 0,
              borderBottomColor: colors.line,
            }}
          >
            <View style={[s.row, { minHeight: 49, gap: 8 }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Manage {name}", { name: row.id })}
                aria-expanded={expanded === row.id}
                onPress={() => setExpanded(expanded === row.id ? undefined : row.id)}
                style={[s.row, { flex: 1, minWidth: 0, gap: 11, paddingVertical: 10 }]}
              >
                <View
                  style={{
                    width: 27,
                    height: 27,
                    borderRadius: 7,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.card,
                  }}
                >
                  <Globe2 size={19} color={colors.text} strokeWidth={1.6} />
                </View>
                <Text numberOfLines={1} style={[s.text, { flex: 1, fontSize: 13 }]}>
                  {row.id}
                </Text>
                {expanded === row.id ? (
                  <ChevronDown size={16} color={colors.muted} />
                ) : (
                  <ChevronRight size={16} color={colors.muted} />
                )}
              </Pressable>
              {row.oauth && row.status !== "connected" && (
                <Button
                  small
                  busy={busy === row.id}
                  disabled={Boolean(busy)}
                  onPress={() => void change(row, "connect")}
                >
                  {t("Connect account")}
                </Button>
              )}
            </View>
            {expanded === row.id && (
              <View style={{ gap: 12, paddingBottom: 16, paddingLeft: 38 }}>
                <Text style={s.small}>
                  {row.origin} · {row.account}
                </Text>
                <Text style={[s.muted, { fontSize: 13 }]}>
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
                {row.oauth && row.status === "connected" && (
                  <Button
                    small
                    style={{ alignSelf: "flex-start" }}
                    busy={busy === row.id}
                    disabled={Boolean(busy)}
                    onPress={() => void change(row, "disconnect")}
                  >
                    {t("Disconnect")}
                  </Button>
                )}
              </View>
            )}
          </View>
        ))}
      </View>
      <Button
        small
        style={{ alignSelf: "flex-start" }}
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
