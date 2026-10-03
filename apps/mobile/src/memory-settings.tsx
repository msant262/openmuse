import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AgentMemory, RevisionEntry } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { Button, Card, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

type Page<T> = { entries: T[]; nextCursor?: string };
export function MemorySettings() {
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
      <Text style={s.heading}>Memory</Text>
      <Text style={s.muted}>
        Inspect facts, corrections and forgotten entries. Restoring creates a new revision.
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
          More facts
        </Button>
      )}
      <Field
        label="Remember something about me"
        value={text}
        onChangeText={setText}
        placeholder="I prefer morning meetings"
      />
      <Field
        label="Valid until (optional, include UTC offset)"
        value={validUntil}
        onChangeText={setValidUntil}
        placeholder="2026-10-25T18:00:00+01:00"
      />
      <Button busy={busy} disabled={!text.trim()} onPress={() => void remember()}>
        Remember
      </Button>
      <ErrorNotice error={error} />
    </Card>
  );
}
function MemoryRow({ memory, changed }: { memory: AgentMemory; changed: () => Promise<void> }) {
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
        <Field label="Memory correction" value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {memory.source} · acquired {memory.createdAt} · revision {memory.revision ?? 0} ·{" "}
        {memory.origin?.kind ?? "legacy"}
      </Text>
      {!!memory.updatedAt && <Text style={s.small}>Changed {memory.updatedAt}</Text>}
      {!!memory.validUntil && (
        <Text style={s.small}>
          Valid until {memory.validUntil} · {memory.timezone ?? "explicit offset"}
        </Text>
      )}
      {memory.status === "forgotten" && (
        <Text style={s.muted}>Forgotten · excluded from automatic recall</Text>
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
              {editing ? "Save correction" : "Edit"}
            </Button>
            <Button small danger busy={busy} onPress={() => void act("forget")}>
              Forget
            </Button>
          </>
        )}
        <Button small onPress={() => void loadHistory().catch((cause) => setError(String(cause)))}>
          History
        </Button>
      </View>
      {history?.entries.map((entry) => (
        <View key={entry.id} style={{ gap: 4 }}>
          <Text style={s.small}>
            Revision {entry.revision} · {entry.action} · {entry.changedAt}
          </Text>
          <Text style={s.text}>{entry.value.text}</Text>
          {entry.value.status !== "forgotten" && entry.revision !== memory.revision && (
            <Button small busy={busy} onPress={() => void act("restore", entry.revision)}>
              Restore revision {entry.revision}
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
          Older changes
        </Button>
      )}
      {!!error && (
        <Button small onPress={() => void changed().catch((cause) => setError(String(cause)))}>
          Reload current fact
        </Button>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
