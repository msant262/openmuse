import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
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
        notify("Conclua a autorização no navegador e volte para atualizar a conexão.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível conectar o aplicativo.");
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
      <Text style={s.heading}>Aplicativos conectados</Text>
      {error ? <ErrorNotice error={error} /> : null}
      {visible.map((row) => (
        <Card key={row.id} style={{ gap: 8 }}>
          <Text style={s.heading}>{row.id}</Text>
          <Text style={s.small}>
            {row.origin} · {row.account}
          </Text>
          <Text style={s.muted}>
            {row.status === "configured"
              ? "Configurado no servidor"
              : row.status === "connected"
                ? "Conectado"
                : row.status === "connecting"
                  ? "Aguardando autorização"
                  : "Precisa conectar"}
          </Text>
          <Text style={s.small}>
            {row.tools.length} ferramentas permitidas: {row.tools.join(", ")}
          </Text>
          {row.oauth ? (
            <Button
              busy={busy === row.id}
              disabled={Boolean(busy)}
              onPress={() =>
                void change(row, row.status === "connected" ? "disconnect" : "connect")
              }
            >
              {row.status === "connected" ? "Desconectar" : "Conectar conta"}
            </Button>
          ) : null}
        </Card>
      ))}
      <Button
        disabled={Boolean(busy)}
        onPress={() =>
          void load().catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Falha ao atualizar"),
          )
        }
      >
        Atualizar conexões
      </Button>
    </View>
  );
}
