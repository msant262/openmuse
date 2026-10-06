import { Bell, ChevronDown, ChevronRight } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  ProactivityAction,
  ProactivitySuggestion,
} from "../../../packages/domain/src/proactivity";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { messageStorage } from "./message-storage";
import { ProactivitySubmission, proactivityTaskLabel } from "./proactivity-state";
import { Button, Card, ErrorNotice, Field, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

function latestSuggestions(
  suggestions: ProactivitySuggestion[],
  answered: Record<string, ProactivitySuggestion>,
) {
  return suggestions.map((suggestion) =>
    answered[suggestion.id]?.revision >= suggestion.revision ? answered[suggestion.id] : suggestion,
  );
}

/** One small entry point in the conversation; evidence mounts only when selected. */
export function ProactivityAlerts({
  suggestions,
  onAnswered,
}: {
  suggestions: ProactivitySuggestion[];
  onAnswered?: () => void;
}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [answered, setAnswered] = useState<Record<string, ProactivitySuggestion>>({});
  const pending = latestSuggestions(suggestions, answered).filter((s) => s.status === "pending");
  useEffect(() => {
    if (!pending.length) setOpened(false);
  }, [pending.length]);
  if (!pending.length) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Open alerts")}
        aria-expanded={opened}
        onPress={() => setOpened(true)}
        style={[
          s.row,
          {
            minHeight: 44,
            paddingHorizontal: 14,
            gap: 10,
            borderRadius: 16,
            backgroundColor: colors.subtle,
          },
        ]}
      >
        <Bell size={16} color={colors.blueDark} />
        <Text numberOfLines={1} style={[s.text, { flex: 1, fontSize: 13 }]}>
          {t("Alerts")} · {pending.length} · {pending[0].title}
        </Text>
        <ChevronRight size={16} color={colors.muted} />
      </Pressable>
      {opened && (
        <Sheet title="Alerts" onClose={() => setOpened(false)}>
          <ProactivityList
            suggestions={pending}
            onAnswered={(updated) => {
              setAnswered((previous) => ({ ...previous, [updated.id]: updated }));
              onAnswered?.();
            }}
          />
        </Sheet>
      )}
    </>
  );
}

function ProactivityList({
  suggestions,
  onAnswered,
}: {
  suggestions: ProactivitySuggestion[];
  onAnswered: (suggestion: ProactivitySuggestion) => void;
}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>();
  const labels = {
    pending: "Needs attention",
    accepted: "In progress",
    snoozed: "Snoozed",
    resolved: "Resolved",
    suppressed: "Don't remind me",
    obsolete: "Source changed; card closed",
  };
  return (
    <View style={{ gap: 8 }}>
      {[...suggestions].reverse().map((suggestion) => (
        <View key={suggestion.id}>
          <Pressable
            accessibilityRole="button"
            aria-expanded={selected === suggestion.id}
            onPress={() => setSelected(selected === suggestion.id ? undefined : suggestion.id)}
            style={[
              s.row,
              {
                gap: 12,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: colors.line,
              },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text numberOfLines={2} style={s.heading}>
                {suggestion.title}
              </Text>
              <Text style={s.small}>{t(labels[suggestion.status])}</Text>
            </View>
            {selected === suggestion.id ? (
              <ChevronDown size={17} color={colors.muted} />
            ) : (
              <ChevronRight size={17} color={colors.muted} />
            )}
          </Pressable>
          {selected === suggestion.id && (
            <ProactivityCard
              key={suggestion.requestId}
              suggestion={suggestion}
              onAnswered={onAnswered}
            />
          )}
        </View>
      ))}
    </View>
  );
}

/** Closed reminders remain available in Notifications, outside the transcript. */
export function ProactivityHistory() {
  const { api } = useWorkspace();
  const [suggestions, setSuggestions] = useState<ProactivitySuggestion[]>([]);
  const [error, setError] = useState("");
  const { s } = useUI();
  const { t } = useI18n();
  useEffect(() => {
    let active = true;
    void api
      .request<{ suggestions: ProactivitySuggestion[] }>("/api/agent/proactivity/suggestions")
      .then((result) => {
        if (active) setSuggestions(result.suggestions);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <View style={{ gap: 10 }}>
      {!!suggestions.length && <Text style={s.heading}>{t("Alerts")}</Text>}
      <ErrorNotice error={error} />
      <ProactivityList
        suggestions={suggestions}
        onAnswered={(updated) =>
          setSuggestions((previous) => previous.map((s) => (s.id === updated.id ? updated : s)))
        }
      />
    </View>
  );
}

export function ProactivityCard({
  suggestion,
  onAnswered,
}: {
  suggestion: ProactivitySuggestion;
  onAnswered?: (suggestion: ProactivitySuggestion) => void;
}) {
  const { s } = useUI();

  const { t, locale } = useI18n();
  const { api, open } = useWorkspace();
  const { data } = useAgentWorkspace();
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
    [api, suggestion.requestId, suggestion.revision],
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
      onAnswered?.(result.suggestion);
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
      const updated = await api.request<ProactivitySuggestion>(
        `/api/agent/proactivity/suggestions/${current.id}/unsuppress`,
        {
          expectedRevision: current.revision,
        },
      );
      setCurrent(updated);
      onAnswered?.(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const labels = {
    start: t("Start"),
    continue: t("Continue"),
    snooze: t("Snooze"),
    resolved: t("Resolved"),
    dismiss: t("Don't remind me"),
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
            ? new Date(e.acquiredAt).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")
            : t("date unknown")}
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
            label={t("Snooze until (date and timezone)")}
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
          {current.snoozeUntil
            ? new Date(current.snoozeUntil).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US")
            : ""}
        </Text>
      )}
      {current.status === "accepted" && (
        <Text style={s.small}>
          {task
            ? t(proactivityTaskLabel(task.status, "en"))
            : t("Queued; awaiting current task state")}
        </Text>
      )}
      {existingTask && current.status === "accepted" && (
        <Button small onPress={() => open({ type: "task", taskId: existingTask })}>
          {t("View task")}
        </Button>
      )}
      {!["pending", "accepted", "snoozed"].includes(current.status) && (
        <Text style={s.small}>
          {current.status === "resolved"
            ? labels.resolved
            : current.status === "suppressed"
              ? labels.dismiss
              : t("Source changed; card closed")}
        </Text>
      )}
      {current.status === "suppressed" && (
        <Button busy={busy} onPress={() => void restore()}>
          {t("Restore reminder")}
        </Button>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
