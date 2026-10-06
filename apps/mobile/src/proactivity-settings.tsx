import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import type {
  ProactivityCycle,
  ProactivitySettingsRecord,
} from "../../../packages/domain/src/proactivity";
import { useI18n } from "./i18n";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Status = {
  settings: ProactivitySettingsRecord;
  paused: boolean;
  activeCycleId: string | null;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  latestCycle: ProactivityCycle | null;
  learning: {
    enabled: boolean;
    lastReviewedAt?: string;
    lastError?: string;
    changes?: number;
    activeTask?: { status: string; error?: string; nextRunAt?: string | null } | null;
  };
};

export function ProactivitySettings({ learningOnly = false }: { learningOnly?: boolean }) {
  const { api } = useWorkspace(),
    { t, locale } = useI18n(),
    { s } = useUI();
  const [status, setStatus] = useState<Status>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => setStatus(await api.request<Status>("/api/agent/proactivity/status"));
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .request<Status>("/api/agent/proactivity/status")
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch((cause) => {
          if (alive) setError(String(cause));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);
  const date = (value?: string | null) =>
    value ? new Date(value).toLocaleString(locale) : t("Not yet reviewed");
  async function change(
    patch: Partial<Pick<ProactivitySettingsRecord, "enabled" | "intervalHours">>,
  ) {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      await api.request("/api/agent/proactivity/settings", {
        ...patch,
        expectedRevision: status.settings.revision,
        requestId: `proactivity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/agent/proactivity/review", {});
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (learningOnly)
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.heading}>{t("Automatic learning")}</Text>
        <Text style={s.muted}>
          {t(
            "Useful facts and preferences are reviewed after conversations. Corrections update existing memories; verified methods become reusable procedures.",
          )}
        </Text>
        {status && (
          <Text style={s.small}>
            {t(status.learning.enabled ? "Learning enabled" : "Learning disabled")}
            {status.paused ? ` · ${t("Paused with the assistant")}` : ""}
            {status.learning.activeTask &&
            !["succeeded", "failed", "cancelled"].includes(status.learning.activeTask.status)
              ? ` · ${t("Review in progress")}`
              : ""}
          </Text>
        )}
        {status?.learning.lastReviewedAt && (
          <Text style={s.small}>
            {t("Last review: {date}", { date: date(status.learning.lastReviewedAt) })}
          </Text>
        )}
        {status?.learning.activeTask?.status === "waiting_provider" &&
          status.learning.activeTask.nextRunAt && (
            <Text style={s.small}>
              {t("Provider interrupted the review; automatic retry at {date}", {
                date: date(status.learning.activeTask.nextRunAt),
              })}
            </Text>
          )}
        <ErrorNotice
          error={error || status?.learning.lastError || status?.learning.activeTask?.error || ""}
        />
        {status?.learning.activeTask?.status === "failed" && (
          <Button
            small
            busy={busy}
            disabled={status.paused}
            onPress={() => {
              setBusy(true);
              setError("");
              void api
                .request("/api/agent/proactivity/learning/retry", {})
                .then(load)
                .catch((cause) => setError(String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {t("Retry learning review")}
          </Button>
        )}
      </View>
    );
  return (
    <Card style={{ gap: 16 }}>
      <Text style={s.muted}>
        {t(
          "Revisit unfinished plans and work, and flag important emails before their deadlines. Suggestions appear in your main conversation.",
        )}
      </Text>
      {status && (
        <>
          <View style={s.between}>
            <Text style={s.text}>{t("Proactive reviews")}</Text>
            <Switch
              accessibilityLabel={t("Proactive reviews")}
              value={status.settings.enabled}
              disabled={busy}
              onValueChange={(enabled) => void change({ enabled })}
            />
          </View>
          <Text style={s.text}>
            {status.settings.intervalHours === 1
              ? t("Review every hour")
              : t("Review every {hours} hours", { hours: status.settings.intervalHours })}
          </Text>
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {[0.25, 1, 4, 12].map((hours) => (
              <Button
                key={hours}
                small
                disabled={busy || status.settings.intervalHours === hours}
                onPress={() => void change({ intervalHours: hours })}
              >
                {hours < 1
                  ? t("15 minutes")
                  : hours === 1
                    ? t("1 hour")
                    : t("{hours} hours", { hours })}
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            {t("Last review: {date}", { date: date(status.lastReviewedAt) })}
          </Text>
          <Text style={s.small}>
            {status.paused
              ? t("Paused with the assistant")
              : status.activeCycleId
                ? t("Review in progress")
                : status.nextReviewAt
                  ? t("Next review: {date}", { date: date(status.nextReviewAt) })
                  : t("Proactive reviews disabled")}
          </Text>
          {status.latestCycle && (
            <View style={{ gap: 6 }}>
              <Text style={s.text}>{t("Sources checked")}</Text>
              {Object.entries(status.latestCycle.coverage).map(([name, coverage]) => (
                <View key={name} style={{ gap: 2 }}>
                  <Text style={s.small}>
                    {t(
                      (
                        {
                          mail: "Email",
                          calendar: "Calendar",
                          goals: "Plans",
                          tasks: "Tasks",
                          memories: "Memory",
                          reasoning: "Review",
                        } as Record<string, string>
                      )[name] ?? name,
                    )}{" "}
                    ·{" "}
                    {t(
                      coverage.complete
                        ? "Up to date"
                        : coverage.status === "partial"
                          ? "Partially reviewed"
                          : "Unavailable",
                    )}
                  </Text>
                  {!coverage.complete && coverage.detail && (
                    <Text style={s.small}>{t(coverage.detail)}</Text>
                  )}
                </View>
              ))}
            </View>
          )}
          <Button
            busy={busy}
            disabled={status.paused || !status.settings.enabled || !!status.activeCycleId}
            onPress={() => void review()}
          >
            {t("Review now")}
          </Button>
        </>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
