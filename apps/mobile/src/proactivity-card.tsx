import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type {
  ProactivityAction,
  ProactivitySuggestion,
} from "../../../packages/domain/src/proactivity";
import { useAgentWorkspace } from "./agent-workspace";
import { messageStorage } from "./message-storage";
import { ProactivitySubmission, proactivityTaskLabel } from "./proactivity-state";
import { Button, Card, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ProactivityCard({
  suggestion,
  onAnswered,
}: {
  suggestion: ProactivitySuggestion;
  onAnswered?: () => void;
}) {
  const { api, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const language = data?.identity.profile?.fields.language ?? "en";
  const pt = language.startsWith("pt"),
    de = language.startsWith("de");
  const [current, setCurrent] = useState(suggestion);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [choosingTime, setChoosingTime] = useState(false),
    [until, setUntil] = useState("");
  const submission = useMemo(
    () =>
      new ProactivitySubmission(
        messageStorage,
        `${api.identityKey}/${suggestion.threadId}`,
        suggestion,
      ),
    [api, suggestion.requestId],
  );
  useEffect(() => setCurrent(suggestion), [suggestion]);
  const task = data?.tasks.find((t) => t.id === current.taskId);
  const pending = current.status === "pending";
  async function respond(action: ProactivityAction) {
    setBusy(true);
    setError("");
    try {
      const result = await submission.submit(
        action,
        action === "snooze" ? until : undefined,
        (body) => api.request(`/api/agent/proactivity/suggestions/${current.id}/respond`, body),
      );
      setCurrent(result.suggestion);
      if (result.message) setError(result.message);
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError("");
    try {
      setCurrent(
        await api.request(`/api/agent/proactivity/suggestions/${current.id}/unsuppress`, {
          expectedRevision: current.revision,
        }),
      );
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const labels = pt
    ? {
        start: "Iniciar",
        continue: "Continuar",
        snooze: "Adiar",
        resolved: "Resolvido",
        dismiss: "Não lembrar",
      }
    : de
      ? {
          start: "Starten",
          continue: "Fortsetzen",
          snooze: "Später",
          resolved: "Erledigt",
          dismiss: "Nicht erinnern",
        }
      : {
          start: "Start",
          continue: "Continue",
          snooze: "Snooze",
          resolved: "Resolved",
          dismiss: "Don't remind me",
        };
  const existingTask =
    current.taskId ??
    (current.target.kind === "task" || current.target.kind === "goal"
      ? current.target.taskId
      : undefined);
  return (
    <Card style={{ gap: 10 }}>
      <Text accessibilityRole="header" style={s.heading}>
        {current.title}
      </Text>
      <Text style={s.text}>{current.reason}</Text>
      {current.evidence.map((e) => (
        <Text key={e.id} style={s.small}>
          {e.title} ·{" "}
          {e.acquiredAt
            ? new Date(e.acquiredAt).toLocaleString()
            : pt
              ? "data desconhecida"
              : "date unknown"}
          {"\n"}
          {e.excerpt}
        </Text>
      ))}
      {pending && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            primary
            busy={busy}
            onPress={() => void respond(existingTask ? "continue" : "start")}
          >
            {existingTask ? labels.continue : labels.start}
          </Button>
          <Button
            disabled={busy}
            onPress={() => {
              setChoosingTime(!choosingTime);
              if (!until) setUntil(new Date(Date.now() + 4 * 3600000).toISOString());
            }}
          >
            {labels.snooze}
          </Button>
          <Button disabled={busy} onPress={() => void respond("resolved")}>
            {labels.resolved}
          </Button>
          <Button disabled={busy} onPress={() => void respond("dismiss")}>
            {labels.dismiss}
          </Button>
        </View>
      )}
      {pending && choosingTime && (
        <>
          <Field
            label={
              pt
                ? "Adiar até (data e fuso)"
                : de
                  ? "Später bis (Datum und Zeitzone)"
                  : "Snooze until (date and timezone)"
            }
            value={until}
            onChangeText={setUntil}
            placeholder="2026-10-03T08:00:00+02:00"
          />
          <Button disabled={busy} onPress={() => void respond("snooze")}>
            {labels.snooze}
          </Button>
        </>
      )}
      {current.status === "snoozed" && (
        <Text style={s.small}>
          {labels.snooze}:{" "}
          {current.snoozeUntil ? new Date(current.snoozeUntil).toLocaleString() : ""}
        </Text>
      )}
      {current.status === "accepted" && (
        <Text style={s.small}>
          {task
            ? proactivityTaskLabel(task.status, language)
            : pt
              ? "Na fila; aguardando estado atual"
              : "Queued; awaiting current task state"}
        </Text>
      )}
      {existingTask && current.status === "accepted" && (
        <Button small onPress={() => open({ type: "task", taskId: existingTask })}>
          {pt ? "Ver tarefa" : de ? "Aufgabe öffnen" : "View task"}
        </Button>
      )}
      {!["pending", "accepted", "snoozed"].includes(current.status) && (
        <Text style={s.small}>
          {current.status === "resolved"
            ? labels.resolved
            : current.status === "suppressed"
              ? labels.dismiss
              : pt
                ? "A fonte mudou; cartão encerrado"
                : "Source changed; card closed"}
        </Text>
      )}
      {current.status === "suppressed" && (
        <Button busy={busy} onPress={() => void restore()}>
          {pt ? "Voltar a lembrar" : de ? "Wieder erinnern" : "Restore reminder"}
        </Button>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
