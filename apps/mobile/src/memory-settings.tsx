import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { AgentMemory, RevisionEntry } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { ProactivitySettings } from "./proactivity-settings";
import { Button, Card, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Page<T> = { entries: T[]; nextCursor?: string };
type Filter = "active" | "forgotten" | "expired" | "all";
export function MemorySettings({ document = false }: { document?: boolean } = {}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const { api } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const [page, setPage] = useState<Page<AgentMemory>>({ entries: [] });
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const currentView = useRef({ filter, query });
  currentView.current = { filter, query };
  async function load(cursor?: string) {
    const { filter, query } = currentView.current;
    const current = ++generation.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      limit: "20",
      query,
      includeInactive: String(filter !== "active"),
    });
    if (filter !== "all") params.set("status", filter);
    if (cursor) params.set("cursor", cursor);
    try {
      const next = await api.request<Page<AgentMemory>>(`/api/agent/memories?${params}`);
      if (current === generation.current)
        setPage((previous) => ({
          ...next,
          entries: cursor ? [...previous.entries, ...next.entries] : next.entries,
        }));
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    ++generation.current;
    setPage({ entries: [] });
    setLoading(true);
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      ++generation.current;
    };
  }, [api, filter, query]);
  async function remember() {
    setBusy(true);
    setError("");
    try {
      let validUntil: string | undefined;
      if (expiry) {
        const date = new Date(`${expiry}T23:59:59`);
        const parts = expiry.split("-").map(Number);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
          date.getFullYear() !== parts[0] ||
          date.getMonth() + 1 !== parts[1] ||
          date.getDate() !== parts[2] ||
          date.getTime() <= Date.now()
        )
          throw new Error(t("Choose a future date in YYYY-MM-DD format."));
        validUntil = date.toISOString();
      }
      await api.request("/api/agent/memories", { text, ...(validUntil ? { validUntil } : {}) });
      setText("");
      setExpiry("");
      setAdding(false);
      if (filter !== "active" || query) {
        setFilter("active");
        setQuery("");
      } else await load();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 18 }}>
      <View style={[s.between, { gap: 12, flexWrap: "wrap" }]}>
        <View style={{ flex: 1, minWidth: 160, gap: 5 }}>
          <Text style={s.heading}>{t(document ? "Saved memories" : "Memory")}</Text>
          <Text style={s.muted}>
            {t("Review what your assistant remembers. You decide what stays.")}
          </Text>
        </View>
        <Button small primary onPress={() => setAdding(true)}>
          {t("Add memory")}
        </Button>
      </View>
      {adding && (
        <Card style={{ gap: 12 }}>
          <Field
            label={t("What should I remember?")}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            placeholder={t("I prefer morning meetings")}
          />
          <Field
            label={t("Expiration date (optional)")}
            value={expiry}
            onChangeText={setExpiry}
            placeholder={t("YYYY-MM-DD · leave empty to keep it")}
          />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              busy={busy}
              disabled={!text.trim() || busy}
              onPress={() => void remember()}
            >
              {t("Save memory")}
            </Button>
            <Button
              disabled={busy}
              onPress={() => {
                setAdding(false);
                setText("");
                setExpiry("");
                setError("");
              }}
            >
              {t("Cancel")}
            </Button>
          </View>
        </Card>
      )}
      <Field
        label={t("Search memories")}
        value={query}
        onChangeText={setQuery}
        placeholder={t("Search facts, preferences or plans")}
      />
      <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
        {(
          [
            ["active", "Saved"],
            ["forgotten", "Forgotten"],
            ["expired", "Expired"],
            ["all", "All"],
          ] as const
        ).map(([value, label]) => (
          <Button key={value} small primary={filter === value} onPress={() => setFilter(value)}>
            {t(label)}
          </Button>
        ))}
      </View>
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => void load()}>
          {t("Try again")}
        </Button>
      )}
      {loading && (
        <ActivityIndicator accessibilityLabel={t("Loading memories")} color={colors.muted} />
      )}
      {!loading && !error && !page.entries.length && (
        <Card style={{ gap: 8 }}>
          <Text style={s.heading}>
            {t(
              query
                ? "No matching memories"
                : filter === "active"
                  ? "No saved memories yet"
                  : "No memories here",
            )}
          </Text>
          <Text style={s.muted}>
            {t(
              query
                ? "Try a different search or another filter."
                : filter === "active"
                  ? "Add a memory, or open Forgotten to restore something you removed."
                  : "Memories in this category will appear here.",
            )}
          </Text>
        </Card>
      )}
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
        <Button busy={loading} disabled={loading} onPress={() => void load(page.nextCursor)}>
          {t("Load more memories")}
        </Button>
      )}
      <Card style={{ gap: 12 }}>
        <ProactivitySettings learningOnly />
      </Card>
    </View>
  );
}

export function MemoryRow({
  memory,
  changed,
}: {
  memory: AgentMemory;
  changed: () => Promise<void>;
}) {
  const { colors, s } = useUI();
  const { t, locale } = useI18n();
  const { api } = useWorkspace();
  const [text, setText] = useState(memory.text);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [history, setHistory] = useState<Page<RevisionEntry<AgentMemory>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ binding: string; id: string } | undefined>(undefined);
  const forgotten = memory.status === "forgotten";
  const expired = !forgotten && !!memory.validUntil && Date.parse(memory.validUntil) <= Date.now();
  const date = (value: string) => new Date(value).toLocaleString(locale);
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
    return page;
  }
  async function act(action: "edit" | "forget" | "restore", revision?: number) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "restore" && revision === undefined) {
        let page = await loadHistory();
        let prior = page.entries.find((entry) => entry.value.status !== "forgotten");
        while (!prior && page.nextCursor) {
          page = await loadHistory(page.nextCursor);
          prior = page.entries.find((entry) => entry.value.status !== "forgotten");
        }
        if (!prior) throw new Error(t("No saved version is available to restore."));
        revision = prior.revision;
      }
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
      await api.request(
        `/api/agent/memories/${memory.id}${action === "edit" ? "" : `/${action}`}`,
        { ...body, requestId: receipt.current.id },
      );
      receipt.current = undefined;
      setEditing(false);
      setConfirmForget(false);
      await changed();
      if (details) await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12, borderWidth: 1, borderColor: colors.line }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[s.small, { fontWeight: "600" }]}>
          {t(forgotten ? "Forgotten" : expired ? "Expired" : "Saved")}
        </Text>
        <Text style={s.small}>{t(memory.category ?? "fact")}</Text>
      </View>
      {editing ? (
        <Field
          label={t("Memory correction")}
          value={text}
          onChangeText={setText}
          multiline
          autoFocus
        />
      ) : (
        <Text style={[s.text, { lineHeight: 24 }]}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {t("Changed {date}", { date: date(memory.updatedAt ?? memory.createdAt) })}
      </Text>
      {forgotten && (
        <Text style={s.muted}>
          {t("Your assistant no longer uses this memory. Restore it to remember it again.")}
        </Text>
      )}
      {!!memory.validUntil && (
        <Text style={s.small}>
          {t("Valid until {date} · {timezone}", {
            date: date(memory.validUntil),
            timezone: memory.timezone ?? t("local time"),
          })}
        </Text>
      )}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {forgotten ? (
          <Button small primary busy={busy} onPress={() => void act("restore")}>
            {t("Restore memory")}
          </Button>
        ) : editing ? (
          <>
            <Button
              small
              primary
              busy={busy}
              disabled={!text.trim() || busy}
              onPress={() => void act("edit")}
            >
              {t("Save correction")}
            </Button>
            <Button
              small
              disabled={busy}
              onPress={() => {
                setEditing(false);
                setText(memory.text);
              }}
            >
              {t("Cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button small onPress={() => setEditing(true)}>
              {t("Edit")}
            </Button>
            <Button small danger onPress={() => setConfirmForget(true)}>
              {t("Forget")}
            </Button>
          </>
        )}
        <Button
          small
          onPress={() => {
            setDetails(!details);
            if (!details) void loadHistory().catch((cause) => setError(String(cause)));
          }}
        >
          {t(details ? "Hide details" : "Details and history")}
        </Button>
      </View>
      {confirmForget && (
        <View style={{ gap: 8 }}>
          <Text style={s.text}>{t("Forget this memory? You can restore it later.")}</Text>
          <View style={[s.row, { gap: 8 }]}>
            <Button small danger busy={busy} onPress={() => void act("forget")}>
              {t("Confirm forget")}
            </Button>
            <Button small disabled={busy} onPress={() => setConfirmForget(false)}>
              {t("Cancel")}
            </Button>
          </View>
        </View>
      )}
      {details && (
        <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12 }}>
          <Text style={s.small}>
            {t(memory.source)} · {t(memory.origin?.kind ?? "legacy")}
          </Text>
          {memory.evidence?.map((e) => (
            <Text key={`${e.messageId}:${e.quote}`} style={s.small}>
              {t("Source quote")}: “{e.quote}”
            </Text>
          ))}
          {history?.entries.map((entry) => (
            <View key={entry.id} style={{ gap: 5 }}>
              <Text style={s.small}>
                {t("Revision {revision} · {action} · {date}", {
                  revision: entry.revision,
                  action: t(entry.action),
                  date: date(entry.changedAt),
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
        </View>
      )}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => void changed().catch((cause) => setError(String(cause)))}>
          {t("Reload current fact")}
        </Button>
      )}
    </Card>
  );
}
