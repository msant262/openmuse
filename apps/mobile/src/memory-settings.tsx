import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AgentMemory, RevisionEntry } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { ProactivitySettings } from "./proactivity-settings";
import { Button, Card, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Page<T> = { entries: T[]; nextCursor?: string };
export function MemorySettings({ document = false }: { document?: boolean } = {}) {
  const { s } = useUI();

  const { t } = useI18n();
  const { api } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const [page, setPage] = useState<Page<AgentMemory>>({ entries: [] });
  const [text, setText] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(cursor?: string) {
    const next = await api.request<Page<AgentMemory>>(
      `/api/agent/memories?includeInactive=true&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setPage((previous) => ({
      ...next,
      entries: cursor ? [...previous.entries, ...next.entries] : next.entries,
    }));
  }
  useEffect(() => {
    void load().catch((cause) => setError(String(cause)));
  }, [api]);
  async function remember() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/agent/memories", {
        text,
        ...(validUntil ? { validUntil, timezone: "Europe/Berlin" } : {}),
      });
      setText("");
      setValidUntil("");
      await load();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <Text style={s.heading}>{t(document ? "Saved memories" : "Memory")}</Text>
      <ProactivitySettings learningOnly />
      <Text style={s.muted}>
        {t("Inspect facts, corrections and forgotten entries. Restoring creates a new revision.")}
      </Text>
      {page.entries.map((memory) => (
        <MemoryRow
          key={memory.id}
          memory={memory}
          changed={async () => {
            await load();
            await refresh();
          }}
        />
      ))}
      {!!page.nextCursor && (
        <Button
          small
          onPress={() => void load(page.nextCursor).catch((cause) => setError(String(cause)))}
        >
          {t("More facts")}
        </Button>
      )}
      <Field
        label={t("Remember something about me")}
        value={text}
        onChangeText={setText}
        placeholder={t("I prefer morning meetings")}
      />
      <Field
        label={t("Valid until (optional, include UTC offset)")}
        value={validUntil}
        onChangeText={setValidUntil}
        placeholder="2026-10-25T18:00:00+01:00"
      />
      <Button busy={busy} disabled={!text.trim()} onPress={() => void remember()}>
        {t("Remember")}
      </Button>
      <ErrorNotice error={error} />
    </Card>
  );
}
function MemoryRow({ memory, changed }: { memory: AgentMemory; changed: () => Promise<void> }) {
  const { s } = useUI();

  const { t, locale } = useI18n();
  const { api } = useWorkspace();
  const [text, setText] = useState(memory.text);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<Page<RevisionEntry<AgentMemory>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ binding: string; id: string } | undefined>(undefined);
  useEffect(() => {
    if (!editing) setText(memory.text);
  }, [memory.text, editing]);
  async function loadHistory(cursor?: string) {
    const page = await api.request<Page<RevisionEntry<AgentMemory>>>(
      `/api/agent/memories/${memory.id}/history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setHistory((previous) => ({
      ...page,
      entries: cursor ? [...(previous?.entries ?? []), ...page.entries] : page.entries,
    }));
  }
  async function act(action: "edit" | "forget" | "restore", revision?: number) {
    const body = {
      expectedRevision: memory.revision ?? 0,
      ...(action === "edit" ? { text } : {}),
      ...(action === "restore" ? { revision } : {}),
    };
    const binding = JSON.stringify({ action, ...body });
    if (receipt.current?.binding !== binding)
      receipt.current = {
        binding,
        id: `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    setBusy(true);
    setError("");
    try {
      await api.request(
        `/api/agent/memories/${memory.id}${action === "edit" ? "" : `/${action}`}`,
        { ...body, requestId: receipt.current?.id },
      );
      receipt.current = undefined;
      setEditing(false);
      await changed();
      if (history) await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8, paddingBottom: 16 }}>
      {editing ? (
        <Field label={t("Memory correction")} value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {t("{source} · acquired {date} · revision {revision} · {origin}", {
          source: t(memory.source),
          date: new Date(memory.createdAt).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US"),
          revision: memory.revision ?? 0,
          origin: t(memory.origin?.kind ?? "legacy"),
        })}
      </Text>
      {memory.category && (
        <Text style={s.small}>
          {t(memory.category)}
          {memory.followUp ? ` · ${t(`Follow-up: ${memory.followUp.state}`)}` : ""}
        </Text>
      )}
      {memory.evidence?.map((e) => (
        <Text key={`${e.messageId}:${e.quote}`} style={s.small}>
          {t("Source quote")}: “{e.quote}”
        </Text>
      ))}
      {!!memory.updatedAt && (
        <Text style={s.small}>
          {t("Changed {date}", {
            date: new Date(memory.updatedAt).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US"),
          })}
        </Text>
      )}
      {!!memory.validUntil && (
        <Text style={s.small}>
          {t("Valid until {date} · {timezone}", {
            date: new Date(memory.validUntil).toLocaleString(
              locale === "pt-BR" ? "pt-BR" : "en-US",
            ),
            timezone: memory.timezone ?? t("explicit offset"),
          })}
        </Text>
      )}
      {memory.status === "forgotten" && (
        <Text style={s.muted}>{t("Forgotten · excluded from automatic recall")}</Text>
      )}
      <View style={[s.row, { gap: 8 }]}>
        {memory.status !== "forgotten" && (
          <>
            <Button
              small
              busy={busy}
              disabled={editing && !text.trim()}
              onPress={() => (editing ? void act("edit") : setEditing(true))}
            >
              {editing ? t("Save correction") : t("Edit")}
            </Button>
            <Button small danger busy={busy} onPress={() => void act("forget")}>
              {t("Forget")}
            </Button>
          </>
        )}
        <Button small onPress={() => void loadHistory().catch((cause) => setError(String(cause)))}>
          {t("History")}
        </Button>
      </View>
      {history?.entries.map((entry) => (
        <View key={entry.id} style={{ gap: 4 }}>
          <Text style={s.small}>
            {t("Revision {revision} · {action} · {date}", {
              revision: entry.revision,
              action: t(entry.action),
              date: new Date(entry.changedAt).toLocaleString(
                locale === "pt-BR" ? "pt-BR" : "en-US",
              ),
            })}
          </Text>
          <Text style={s.text}>{entry.value.text}</Text>
          {entry.value.status !== "forgotten" && entry.revision !== memory.revision && (
            <Button small busy={busy} onPress={() => void act("restore", entry.revision)}>
              {t("Restore revision {revision}", { revision: entry.revision })}
            </Button>
          )}
        </View>
      ))}
      {!!history?.nextCursor && (
        <Button
          small
          onPress={() =>
            void loadHistory(history.nextCursor).catch((cause) => setError(String(cause)))
          }
        >
          {t("Older changes")}
        </Button>
      )}
      {!!error && (
        <Button small onPress={() => void changed().catch((cause) => setError(String(cause)))}>
          {t("Reload current fact")}
        </Button>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
