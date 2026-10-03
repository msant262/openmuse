import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { type TaskBudget, taskBudgetSchema } from "../../../packages/domain/src/runtime";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { completionLabel, TimingSubmission } from "./task-runtime-state";
import { Button, Card, colors, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export function TaskCompletion({ task }: { task: AgentTask }) {
  const { t } = useI18n();
  if (!task.completion && !task.criteria?.length) return null;
  return (
    <Card
      style={{
        gap: 10,
        backgroundColor: task.completion?.status === "verified" ? colors.green : colors.sky,
      }}
    >
      <Text style={s.heading}>{t(completionLabel(task.completion) ?? "Delivery criteria")}</Text>
      {task.criteria?.map((criterion) => {
        const check = task.completion?.checks.find((item) => item.criterionId === criterion.id);
        return (
          <Text key={criterion.id} style={s.text}>
            {check?.passed ? "✓" : "○"} {criterion.description}
          </Text>
        );
      })}
      {!!task.completion?.remaining.length && <Text style={s.heading}>{t("Still needed")}</Text>}
      {[...new Set(task.completion?.remaining ?? [])].map((item) => (
        <Text key={item} selectable style={s.muted}>
          {item}
        </Text>
      ))}
      {task.completion?.status !== "verified" && (
        <Text style={s.small}>
          {t("Available files and results remain below while the remaining work is resolved.")}
        </Text>
      )}
    </Card>
  );
}

export function TaskTimingControls({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  // Changing task/account discards only this view, never mutates another task.
  return <TimingControls key={`${api.identityKey}:${task.id}`} task={task} />;
}
function TimingControls({ task }: { task: AgentTask }) {
  const { t, locale } = useI18n();
  const { api } = useWorkspace();
  const { mutate } = useAgentWorkspace();
  const [editor, setEditor] = useState(() => new TimingSubmission(task, Crypto.randomUUID));
  const [draft, setDraft] = useState(editor.initial);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const latest = await api.request<{ task: AgentTask }>(`/api/agent/tasks/${task.id}`);
      if (!mounted.current) return;
      if (latest.task.id !== task.id) throw new Error(t("The server returned a different task."));
      const next = new TimingSubmission(latest.task, Crypto.randomUUID);
      setEditor(next);
      setDraft(next.initial);
      setPending(false);
      setNotice("");
      setExpanded(true);
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = editor.prepare(draft);
      setPending(true);
      await mutate(`/tasks/${task.id}/timing`, body);
      if (!mounted.current) return;
      setExpanded(false);
      setNotice("Timing saved.");
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const zone = task.timing?.timezone ?? "Europe/Berlin";
  function date(value: string) {
    try {
      return new Date(value).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en-US", { timeZone: zone, timeZoneName: "short" });
    } catch {
      return value;
    }
  }
  const overdue =
    task.timing?.dueAt &&
    Date.parse(task.timing.dueAt) < Date.now() &&
    !["succeeded", "cancelled"].includes(task.status);
  const expired = task.timing?.validUntil && Date.parse(task.timing.validUntil) < Date.now();
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.heading}>{t("Priority and timing")}</Text>
      <Text style={s.muted}>
        {t("Priority: {priority} · {zone}", { priority: t(task.timing?.priority ?? "normal"), zone })}
      </Text>
      {task.timing?.dueAt && (
        <Text style={s.text}>
          {t("Desired deadline: {date}", { date: date(task.timing.dueAt) })}
          {overdue ? ` · ${t("overdue")}` : ""}
        </Text>
      )}
      {task.timing?.validUntil && (
        <Text style={s.text}>
          {t("Authorized until: {date}", { date: date(task.timing.validUntil) })}
          {expired ? ` · ${t("expired")}` : ""}
        </Text>
      )}
      {expired && (
        <Text style={s.muted}>
          {t("Saved work is preserved. Confirm a new validity before further actions are sent.")}
        </Text>
      )}
      <Text style={s.small}>
        {t("The desired deadline is a target. Authorization expiry prevents new actions after that time; it does not undo actions already sent.")}
      </Text>
      <ErrorNotice error={error} />
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={s.muted}>
          {t(notice)}
        </Text>
      )}
      {!expanded ? (
        <Button small busy={busy} onPress={() => void reload()}>
          {t("Edit timing")}
        </Button>
      ) : (
        <>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {(["low", "normal", "high"] as const).map((priority) => (
              <Button
                key={priority}
                small
                primary={draft.priority === priority}
                disabled={busy || pending}
                onPress={() => setDraft({ ...draft, priority })}
              >
                {t(priority)}
              </Button>
            ))}
          </View>
          <Field
            label={t("Time zone")}
            value={draft.timezone}
            autoCapitalize="none"
            editable={!busy && !pending}
            onChangeText={(timezone) => setDraft({ ...draft, timezone })}
          />
          <Field
            label={t("Desired deadline (optional)")}
            placeholder={t("DD/MM/YYYY HH:mm")}
            value={draft.dueAt}
            autoCapitalize="none"
            editable={!busy && !pending}
            onChangeText={(dueAt) => setDraft({ ...draft, dueAt })}
          />
          <Field
            label={t("Authorization expiry (optional)")}
            placeholder={t("DD/MM/YYYY HH:mm")}
            value={draft.validUntil}
            autoCapitalize="none"
            editable={!busy && !pending}
            onChangeText={(validUntil) => setDraft({ ...draft, validUntil })}
          />
          <Text style={s.small}>
            {t("Use DD/MM/YYYY HH:mm in the selected zone, or an ISO date with an explicit offset. If clocks repeat an hour, include the offset. Clear a field to remove that limit.")}
          </Text>
          {pending && (
            <Text style={s.small}>
              {t("This submitted change is kept for a retry. Reload to inspect the server before making another edit.")}
            </Text>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button primary busy={busy} onPress={() => void save()}>
              {pending ? t("Retry change") : t("Save timing")}
            </Button>
            <Button busy={busy} onPress={() => void reload()}>
              {t("Reload latest")}
            </Button>
          </View>
        </>
      )}
    </Card>
  );
}

export function TaskBudgetControls({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  return <BudgetControls key={`${api.identityKey}:${task.id}`} task={task} />;
}
function BudgetControls({ task }: { task: AgentTask }) {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const { mutate } = useAgentWorkspace();
  const parsed = taskBudgetSchema.safeParse(task.state.budget);
  const [latestBudget, setLatestBudget] = useState<TaskBudget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<
    | {
        expectedRevision: number;
        requestId: string;
        additionalSteps: number;
        additionalMilliseconds: number;
      }
    | undefined
  >(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!parsed.success) return null;
  const budget =
    latestBudget && latestBudget.revision > parsed.data.revision ? latestBudget : parsed.data;
  const extraSteps = Math.min(24, 10000 - budget.maxSteps);
  async function reloadBudget() {
    setBusy(true);
    setError("");
    try {
      const detail = await api.request<{ task: AgentTask }>(`/api/agent/tasks/${task.id}`);
      if (!mounted.current) return;
      if (detail.task.id !== task.id) throw new Error(t("The server returned a different task."));
      setLatestBudget(taskBudgetSchema.parse(detail.task.state.budget));
      pending.current = undefined;
      setNotice("Latest work budget loaded.");
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function extend() {
    if (!pending.current)
      pending.current = {
        expectedRevision: budget.revision,
        requestId: Crypto.randomUUID(),
        additionalSteps: extraSteps,
        additionalMilliseconds: 30 * 60_000,
      };
    setBusy(true);
    setError("");
    try {
      const saved = await mutate<TaskBudget>(`/tasks/${task.id}/budget`, pending.current);
      if (mounted.current) {
        if (taskBudgetSchema.safeParse(saved).success) setLatestBudget(saved);
        setNotice("Extra work authorized.");
        pending.current = undefined;
      }
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.heading}>{t("Work budget")}</Text>
      <Text style={s.muted}>
        {t("{used} of {max} steps · {usedMinutes} of {maxMinutes} minutes used", {
          used: budget.usedSteps,
          max: budget.maxSteps,
          usedMinutes: Math.ceil(budget.usedMilliseconds / 60_000),
          maxMinutes: Math.ceil(budget.maxMilliseconds / 60_000),
        })}
      </Text>
      <Text style={s.small}>
        {t("This limit is shared with subtasks and stays in place across model changes.")}
      </Text>
      <ErrorNotice error={error} />
      {!!notice && <Text style={s.muted}>{t(notice)}</Text>}
      {!["succeeded", "cancelled"].includes(task.status) && (pending.current || extraSteps > 0) && (
        <Button small busy={busy} onPress={() => void extend()}>
          {pending.current
            ? t("Retry authorization")
            : t("Allow {steps} more steps and 30 minutes", { steps: extraSteps })}
        </Button>
      )}
      <Button small busy={busy} onPress={() => void reloadBudget()}>
        {t("Reload work budget")}
      </Button>
    </Card>
  );
}
