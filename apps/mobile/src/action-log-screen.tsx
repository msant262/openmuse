import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ActionLogEntry } from "../../../packages/domain/src";
import { useI18n } from "./i18n";
import { Button, Card, Chip, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function ActionLogScreen() {
  const { s } = useUI();

  const { t, locale } = useI18n();
  const { api } = useWorkspace();
  const [entries, setEntries] = useState<ActionLogEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(next?: string) {
    setBusy(true);
    setError("");
    try {
      const page = await api.request<{ entries: ActionLogEntry[]; nextCursor?: string }>(
        `/api/action-log?limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setEntries((previous) =>
        next
          ? [
              ...previous,
              ...page.entries.filter((entry) => !previous.some((old) => old.id === entry.id)),
            ]
          : page.entries,
      );
      setCursor(page.nextCursor);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Action log is unavailable"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [api]);
  return (
    <Card style={{ gap: 16 }}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={s.heading}>{t("Action log")}</Text>
        <Button small busy={busy} onPress={() => void load()}>
          {t("Refresh")}
        </Button>
      </View>
      <Text style={s.small}>
        {t(
          "A permanent record of tool calls and outcomes. Command contents, passwords and message bodies are omitted.",
        )}
      </Text>
      <ErrorNotice error={error} />
      {entries.map((entry) => (
        <View key={entry.id} style={{ gap: 5, borderTopWidth: 1, paddingTop: 14 }}>
          <View style={[s.row, { gap: 8 }]}>
            <Text style={[s.text, { flex: 1 }]}>{entry.summary}</Text>
            <Chip>{t(entry.result.replaceAll("_", " "))}</Chip>
          </View>
          <Text selectable style={s.muted}>
            {entry.tool} · {entry.target}
          </Text>
          <Text style={s.small}>
            {new Date(entry.time).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")} ·{" "}
            {entry.actor}
          </Text>
        </View>
      ))}
      {!busy && !entries.length && (
        <Text style={s.muted}>{t("External actions will appear here.")}</Text>
      )}
      {cursor && (
        <Button busy={busy} onPress={() => void load(cursor)}>
          {t("Load earlier actions")}
        </Button>
      )}
    </Card>
  );
}
