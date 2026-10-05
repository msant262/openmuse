import * as Crypto from "expo-crypto";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDollarSign,
  Clock3,
  FileText,
  Globe2,
  Heart,
  Info,
  Lightbulb,
  ListChecks,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Users,
  X,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type {
  AgentArtifact,
  AgentTask,
  Evidence,
  Goal,
  Idea,
  Monitor,
  RunEvent,
} from "../../../packages/domain/src/agent";
import { attachmentLabel } from "../../../packages/domain/src/attachments";
import type { FileRecoverySnapshot } from "../../../packages/domain/src/file-versions";
import type { InteractionRequest } from "../../../packages/domain/src/runtime";
import { useAgentWorkspace } from "./agent-workspace";
import { ArtifactResultCard } from "./artifact-result-card";
import { AssistantResponse } from "./assistant-response";
import { t as translate, useI18n } from "./i18n";
import { InteractionCard } from "./interaction-card";
import { MemorySettings } from "./memory-settings";
import { SubjectIllustration } from "./muse-surfaces-illustration";
import {
  buildFeed,
  feedExcerpt,
  ideaCategory,
  isProductTask,
  orderedTaskEvents,
  productNotifications,
  taskPreview,
} from "./muse-surfaces-model";
import { NativePushSettings } from "./native-push-settings";
import { PlaybooksPanel } from "./playbooks";
import { useInlinePreview } from "./preview";
import { ProfileSettings } from "./profile-settings";
import { RoutinesPanel } from "./routines";
import { ActivityScreen, ConnectionsScreen } from "./screens";
import { ClearFinishedTasksButton, TaskRemoveButton } from "./task-removal";
import { TaskBudgetControls, TaskCompletion, TaskTimingControls } from "./task-runtime-controls";
import { TaskStatusBadge } from "./task-status";
import { useMuseThread } from "./threads";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  LinkRow,
  Mascot,
  resultSummary,
  SectionHeading,
  Sheet,
  useUI,
} from "./ui";
import { useWorkspace } from "./workspace";

export function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function stamp(value?: string) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : translate("Not checked yet");
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function activeTask(task: AgentTask) {
  return !["succeeded", "failed", "cancelled"].includes(task.status);
}
export function AgentStatus() {
  const { colors, s } = useUI();

  const { data, error, refresh } = useAgentWorkspace();
  const { t } = useI18n();
  if (data?.worker.running && !error) return null;
  return (
    <View style={{ gap: 8 }}>
      <ErrorNotice error={error ? `${t("Agent updates unavailable.")} ${error}` : ""} />
      {!!error && (
        <Button small onPress={() => void refresh().catch(() => {})}>
          {t("Reconnect agent")}
        </Button>
      )}
      {!data && !error && <ActivityIndicator color={colors.blueDark} />}
      {data && !data.worker.running && (
        <Text style={s.small}>
          {t("Your assistant is reconnecting. Saved work will continue when it is available.")}
        </Text>
      )}
    </View>
  );
}
export function TaskCard({
  task,
  compact = false,
  onOpen,
}: {
  task: AgentTask;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { colors, s } = useUI();

  const { open } = useWorkspace();
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("Open task")}: ${task.title}`}
        onPress={() => {
          onOpen?.();
          open({ type: "task", taskId: task.id });
        }}
        style={({ pressed }) => ({
          paddingVertical: compact ? 13 : 19,
          flexDirection: "row",
          gap: 13,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
          opacity: pressed ? 0.6 : 1,
          flex: 1,
        })}
      >
        <View style={{ width: 30, paddingTop: 2 }}>
          <TaskStatusBadge task={task} iconOnly />
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[s.text, { fontWeight: "500" }]}>{task.title}</Text>
          <Text numberOfLines={compact ? 2 : 3} style={s.muted}>
            {t(resultSummary(taskPreview(task)))}
          </Text>
          <TaskStatusBadge task={task} />
          <Text style={s.small}>{stamp(task.updatedAt)}</Text>
        </View>
        <ChevronRight size={16} color={colors.muted} style={{ marginTop: 5 }} />
      </Pressable>
      <TaskRemoveButton task={task} />
    </View>
  );
}
export function ChatWork() {
  const { data } = useAgentWorkspace();
  const tasks = [...(data?.tasks || [])]
    .filter((task) => activeTask(task) && isProductTask(task))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2);
  if (!tasks.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {tasks.map((task) => (
        <TaskCard task={task} key={task.id} compact />
      ))}
    </View>
  );
}
export function AgentActivityScreen() {
  const { colors, s } = useUI();

  const { data, mutate } = useAgentWorkspace();
  const { ask, open } = useWorkspace();
  const { t, locale } = useI18n();
  const [panel, setPanel] = useState<"tasks" | "reviews" | "automations">();
  const [filter, setFilter] = useState("All");
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);
  const allEntries = buildFeed(data?.tasks || [], data?.notifications || [], data?.artifacts || []);
  const entries = allEntries.slice(0, visibleCount);
  const tasks = [...(data?.tasks || [])]
    .filter(
      (task) =>
        filter === "All" || (filter === "In progress" ? activeTask(task) : !activeTask(task)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const dayHeading = (date: string) =>
    new Date(date).toLocaleDateString(locale === "pt-BR" ? "pt-BR" : "en", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  return (
    <View style={{ gap: 12 }}>
      <AgentStatus />
      <ClearFinishedTasksButton />
      <View style={s.between}>
        <Text style={[s.title, { fontSize: 23, flex: 1 }]}>{t("For you")}</Text>
        <IconButton
          icon={Settings2}
          label={t("Feed activity and settings")}
          onPress={() => setPanel("tasks")}
        />
      </View>
      {entries.map((entry, index) => (
        <View key={entry.id}>
          {(index === 0 || dayHeading(entry.date) !== dayHeading(entries[index - 1].date)) && (
            <Text
              style={[
                s.small,
                { marginTop: index ? 18 : 0, marginBottom: 13, textTransform: "capitalize" },
              ]}
            >
              {dayHeading(entry.date)}
            </Text>
          )}
          <View
            style={{
              flexDirection: "row",
              gap: 14,
              paddingTop: 7,
              paddingBottom: 25,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.subtle,
              }}
            >
              {entry.artifact ? (
                <FileText size={18} color={colors.muted} />
              ) : entry.status === "succeeded" ? (
                <CheckCircle2 size={18} color={colors.success} />
              ) : (
                <Clock3 size={18} color={colors.muted} />
              )}
            </View>
            <View style={{ flex: 1, gap: 10 }}>
              <Text style={[s.heading, { fontSize: 17, lineHeight: 24 }]}>{entry.title}</Text>
              {!!entry.status && entry.status !== "succeeded" && (
                <Text
                  style={[
                    s.small,
                    { color: entry.status === "failed" ? colors.danger : colors.muted },
                  ]}
                >
                  {t(statusLabel(entry.status))}
                </Text>
              )}
              <Text selectable numberOfLines={3} style={[s.muted, { lineHeight: 22 }]}>
                {t(resultSummary(feedExcerpt(entry.body)))}
              </Text>
              {entry.artifact && <ArtifactCard artifact={entry.artifact} />}
              <View style={[s.row, { gap: 20, marginTop: 4 }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    ask(
                      t("Let's discuss: {title}\n\n{body}", {
                        title: entry.title,
                        body: entry.body,
                      }),
                    )
                  }
                  style={[s.row, { gap: 7, minHeight: 34 }]}
                >
                  <MessageCircle size={19} color={colors.text} />
                  <Text style={[s.text, { fontSize: 13 }]}>{t("Discuss")}</Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("View details")}
                  onPress={() =>
                    entry.taskId
                      ? open({ type: "task", taskId: entry.taskId })
                      : open({ type: "notifications" })
                  }
                  style={{ padding: 7 }}
                >
                  <Info size={18} color={colors.muted} />
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      ))}
      {allEntries.length > visibleCount && (
        <Button small onPress={() => setVisibleCount((count) => count + 12)}>
          {t("Show more updates")}
        </Button>
      )}
      {!entries.length && (
        <Empty
          icon={MessageCircle}
          title={t("Your day, coming together")}
          detail={t("Updates from your tasks and the things you follow will appear here.")}
        />
      )}
      {panel && (
        <Sheet title={t("Activity")} onClose={() => setPanel(undefined)}>
          <View style={[s.row, { gap: 7, marginBottom: 18, flexWrap: "wrap" }]}>
            {(["tasks", "reviews", "automations"] as const).map((item) => (
              <Button key={item} small primary={panel === item} onPress={() => setPanel(item)}>
                {t(
                  item === "tasks"
                    ? "Tasks"
                    : item === "reviews"
                      ? "Reviews & receipts"
                      : "Automations",
                )}
              </Button>
            ))}
          </View>
          {panel === "tasks" && (
            <>
              <View style={[s.row, { gap: 7 }]}>
                {["All", "In progress", "Finished"].map((item) => (
                  <Button
                    key={item}
                    small
                    primary={filter === item}
                    onPress={() => setFilter(item)}
                  >
                    {t(item)}
                  </Button>
                ))}
              </View>
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} onOpen={() => setPanel(undefined)} />
              ))}
              {!tasks.length && (
                <Text style={[s.muted, { paddingVertical: 20 }]}>{t("No tasks here yet.")}</Text>
              )}
            </>
          )}
          {panel === "reviews" && <ActivityScreen />}
          {panel === "automations" && (
            <View style={{ gap: 20 }}>
              <ErrorNotice error={pauseError} />
              {data && (
                <>
                  <Button
                    icon={data.runtimePause.paused ? Play : Pause}
                    busy={pauseBusy}
                    onPress={() => {
                      setPauseBusy(true);
                      setPauseError("");
                      void mutate("/runtime-pause", {
                        paused: !data.runtimePause.paused,
                        expectedRevision: data.runtimePause.revision,
                      })
                        .catch((error) => setPauseError(errorText(error)))
                        .finally(() => setPauseBusy(false));
                    }}
                  >
                    {t(data.runtimePause.paused ? "Resume automations" : "Pause automations")}
                  </Button>
                  {data.runtimePause.paused && (
                    <View style={{ gap: 7 }}>
                      <Text style={s.heading}>{t("Global pause saved")}</Text>
                      <Text style={s.muted}>
                        {t(
                          "New automation is paused. Operations already in progress may still finish.",
                        )}
                      </Text>
                      <Text style={s.small}>
                        {stamp(data.runtimePause.changedAt)} ·{" "}
                        {data.runtimeStatus.executorConfirmation} · {data.runtimeStatus.activeTasks}{" "}
                        {t("tasks")} · {data.runtimeStatus.activeOperations}{" "}
                        {t("operations active")} · {data.runtimeStatus.uncertainOperations}{" "}
                        {t("uncertain")}
                      </Text>
                    </View>
                  )}
                </>
              )}
              <RoutinesPanel />
              <PlaybooksPanel />
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  const { colors, s } = useUI();

  const { workspace, open } = useWorkspace();
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {items.map((item) => (
        <View
          key={item.id}
          style={{ borderLeftWidth: 2, borderLeftColor: colors.blue, paddingLeft: 12, gap: 4 }}
        >
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{item.title}</Text>
          <Text selectable style={s.small}>
            {item.excerpt}
          </Text>
          {item.url && /^https?:\/\//i.test(item.url) && (
            <Button
              small
              onPress={() =>
                void Linking.openURL(item.url || "").catch((e) => setError(errorText(e)))
              }
            >
              Open source
            </Button>
          )}
          {item.kind === "mail" && workspace.mail.some((mail) => mail.id === item.id) && (
            <Button
              small
              onPress={() => {
                const mail = workspace.mail.find((m) => m.id === item.id);
                if (mail) open({ type: "mail", mail });
              }}
            >
              View email
            </Button>
          )}
          {item.kind === "file" && workspace.files.some((file) => file.id === item.id) && (
            <Button
              small
              onPress={() => {
                const file = workspace.files.find((f) => f.id === item.id);
                if (file) open({ type: "file", file });
              }}
            >
              View file
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
export function TaskDetail({ taskId }: { taskId: string }) {
  const { api } = useWorkspace();
  return <TaskDetailContent key={`${api.identityKey}:${taskId}`} taskId={taskId} />;
}
function TaskDetailContent({ taskId }: { taskId: string }) {
  const { colors, s } = useUI();

  const previewVisible = useInlinePreview();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const wide = width >= 780;
  const [selected, setSelected] = useState("summary");
  const [manage, setManage] = useState(false);
  const { api, workspace, close, open, refresh: refreshWorkspace } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [detail, setDetail] = useState<{
    task: AgentTask;
    events: RunEvent[];
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
    interactions?: InteractionRequest[];
    executionSteps?: AgentTask["plan"];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fieldJson, setFieldJson] = useState("");
  const [showFieldJson, setShowFieldJson] = useState(false);
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const snapshotTask = data?.tasks.find((item) => item.id === taskId);
  const task = detail?.task || snapshotTask;
  useEffect(() => {
    let active = true;
    const load = () =>
      void api
        .request<{
          task: AgentTask;
          events: RunEvent[];
          artifacts: AgentArtifact[];
          files: Artifact[];
          browsers: BrowserSession[];
          interactions?: InteractionRequest[];
          executionSteps?: AgentTask["plan"];
        }>(`/api/agent/tasks/${taskId}`)
        .then((result) => {
          if (active) {
            setDetail(result);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        });
    load();
    const timer = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, taskId, snapshotTask?.updatedAt]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
      if (path === "input") {
        setAnswer("");
        setFields({});
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function submitInput() {
    try {
      let parsed: Record<string, string | boolean> = fields;
      if (fieldJson.trim()) {
        const raw: unknown = JSON.parse(fieldJson);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.values(raw).some(
            (value) => typeof value !== "string" && typeof value !== "boolean",
          )
        )
          throw new Error("Form fields must be a JSON object with text or true/false values.");
        parsed = raw as Record<string, string | boolean>;
      }
      await act("input", {
        answer: answer.trim() || "Provided the requested fields.",
        fields: parsed,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await refreshWorkspace();
      const snapshot = await api.request<typeof workspace>("/api/workspace");
      const action = snapshot.actions.find((item) => item.id === task?.actionId);
      if (!action) throw new Error("This review is not available yet. Refresh and try again.");
      open({ type: "review", action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const missing = Array.isArray(task?.state.missingFields) ? task.state.missingFields : [];
  const fieldNames = missing
    .map((field) =>
      typeof field === "string"
        ? field
        : typeof field === "object" && field && "name" in field
          ? String(field.name)
          : "",
    )
    .filter(Boolean);
  const events = orderedTaskEvents(detail?.events || []);
  const selectedEvent = events.find((event) => `event:${event.id}` === selected);
  const selectedStep = task?.plan.find((step) => `step:${step.id}` === selected);
  return (
    <Sheet
      title={task?.title || "Task"}
      headerAccessory={
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {task ? (
            <TaskStatusBadge task={task} />
          ) : (
            <Text style={s.small}>{t("Loading saved progress…")}</Text>
          )}
          {task && <TaskRemoveButton task={task} onRemoved={close} />}
        </View>
      }
      onClose={close}
      wide
      scroll={false}
      contentStyle={{ padding: 0, gap: 0 }}
    >
      {!!error && (
        <View style={{ paddingHorizontal: 24 }}>
          <ErrorNotice error={error} />
        </View>
      )}
      {!task ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : (
        <View style={{ flex: 1, minHeight: 0, flexDirection: wide ? "row" : "column" }}>
          <ScrollView
            style={{
              width: wide ? 300 : "100%",
              flexGrow: 0,
              flexShrink: wide ? 0 : 1,
              maxHeight: wide ? undefined : Math.min(220, height * 0.26),
              backgroundColor: colors.subtle,
              borderRightWidth: wide ? 1 : 0,
              borderBottomWidth: wide ? 0 : 1,
              borderColor: colors.line,
            }}
            contentContainerStyle={{ padding: wide ? 17 : 14, gap: 3 }}
          >
            <Pressable
              accessibilityRole="button"
              aria-selected={selected === "request"}
              onPress={() => setSelected("request")}
              style={{
                padding: 12,
                borderRadius: 11,
                gap: 8,
                flexDirection: "row",
                backgroundColor: selected === "request" ? colors.subtle : "transparent",
              }}
            >
              <Circle size={15} color={colors.muted} style={{ marginTop: 2 }} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[s.text, { fontSize: 13 }]}>{t("Started")}</Text>
                <Text style={s.small}>{stamp(task.createdAt)}</Text>
              </View>
            </Pressable>
            {!!task.plan.length && (
              <Pressable
                accessibilityRole="button"
                aria-selected={selected === "plan"}
                onPress={() => setSelected("plan")}
                style={{
                  padding: 12,
                  borderRadius: 11,
                  gap: 10,
                  flexDirection: "row",
                  backgroundColor: selected === "plan" ? colors.subtle : "transparent",
                }}
              >
                <ListChecks size={16} color={colors.muted} style={{ marginTop: 3 }} />
                <Text style={[s.text, { fontSize: 13 }]}>{t("Plan")}</Text>
              </Pressable>
            )}
            {events.length
              ? events.map((event) => (
                  <Pressable
                    key={event.id}
                    accessibilityRole="button"
                    aria-selected={selected === `event:${event.id}`}
                    onPress={() => setSelected(`event:${event.id}`)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 12,
                      borderRadius: 11,
                      gap: 10,
                      flexDirection: "row",
                      backgroundColor:
                        selected === `event:${event.id}` ? colors.subtle : "transparent",
                    }}
                  >
                    <View style={{ paddingTop: 3 }}>
                      {event.kind === "result" ? (
                        <CheckCircle2 size={15} color={colors.muted} />
                      ) : event.kind === "observation" ? (
                        <Globe2 size={15} color={colors.muted} />
                      ) : (
                        <FileText size={15} color={colors.muted} />
                      )}
                    </View>
                    <Text style={[s.text, { flex: 1, fontSize: 13, lineHeight: 20 }]}>
                      {t(event.title)}
                    </Text>
                  </Pressable>
                ))
              : task.plan.map((step) => (
                  <Pressable
                    key={step.id}
                    accessibilityRole="button"
                    aria-selected={selected === `step:${step.id}`}
                    onPress={() => setSelected(`step:${step.id}`)}
                    style={{
                      padding: 12,
                      borderRadius: 11,
                      gap: 10,
                      flexDirection: "row",
                      backgroundColor:
                        selected === `step:${step.id}` ? colors.subtle : "transparent",
                    }}
                  >
                    {step.status === "running" ? (
                      <ActivityIndicator
                        accessibilityLabel={t("In progress")}
                        size="small"
                        color={colors.blueDark}
                      />
                    ) : step.status === "succeeded" ? (
                      <CheckCircle2 size={15} color={colors.success} style={{ marginTop: 3 }} />
                    ) : (
                      <Circle size={15} color={colors.muted} style={{ marginTop: 3 }} />
                    )}
                    <Text style={[s.text, { flex: 1, fontSize: 13, lineHeight: 20 }]}>
                      {t(step.title)}
                    </Text>
                  </Pressable>
                ))}
            <Pressable
              accessibilityRole="button"
              aria-selected={selected === "summary"}
              onPress={() => setSelected("summary")}
              style={{
                padding: 12,
                borderRadius: 11,
                gap: 10,
                flexDirection: "row",
                backgroundColor: selected === "summary" ? colors.subtle : "transparent",
              }}
            >
              <CheckCircle2 size={16} color={colors.text} style={{ marginTop: 2 }} />
              <Text style={[s.text, { flex: 1, fontSize: 13, fontWeight: "500" }]}>
                {t(task.status === "succeeded" ? "Completed" : "Summary")}
              </Text>
            </Pressable>
          </ScrollView>
          <ScrollView
            style={{ flex: 1, minHeight: 0, backgroundColor: colors.card }}
            contentContainerStyle={{ padding: wide ? 30 : 22, gap: 20 }}
          >
            {selected === "plan" ? (
              <View style={{ gap: 20 }}>
                <Text style={s.heading}>{t("Plan")}</Text>
                <Text style={s.small}>
                  {t("{done} of {total} steps completed", {
                    done: task.plan.filter((step) => step.status === "succeeded").length,
                    total: task.plan.length,
                  })}
                </Text>
                {task.plan.map((step) => (
                  <View key={step.id} style={{ flexDirection: "row", gap: 12 }}>
                    {step.status === "running" ? (
                      <ActivityIndicator
                        accessibilityLabel={t("In progress")}
                        size="small"
                        color={colors.blueDark}
                      />
                    ) : step.status === "succeeded" ? (
                      <CheckCircle2 size={19} color={colors.success} />
                    ) : (
                      <Circle
                        size={19}
                        color={
                          step.status === "failed"
                            ? colors.danger
                            : step.status === "waiting"
                              ? colors.warning
                              : colors.muted
                        }
                      />
                    )}
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={s.text}>{t(step.title)}</Text>
                      <Text
                        style={[
                          s.small,
                          {
                            color:
                              step.status === "succeeded"
                                ? colors.success
                                : step.status === "failed"
                                  ? colors.danger
                                  : step.status === "running"
                                    ? colors.blueDark
                                    : colors.muted,
                          },
                        ]}
                      >
                        {t(statusLabel(step.status))}
                      </Text>
                      {!!step.detail && <Text style={s.muted}>{step.detail}</Text>}
                    </View>
                  </View>
                ))}
                {!!detail?.executionSteps?.length &&
                  !task.plan.some((step) => step.id.startsWith("execution:")) && (
                    <>
                      <Text style={s.heading}>{t("Execution progress")}</Text>
                      {detail.executionSteps.map((step) => (
                        <View key={step.id} style={{ flexDirection: "row", gap: 10 }}>
                          {step.status === "running" ? (
                            <ActivityIndicator size="small" color={colors.blueDark} />
                          ) : step.status === "succeeded" ? (
                            <CheckCircle2 size={18} color={colors.success} />
                          ) : (
                            <Circle
                              size={18}
                              color={step.status === "failed" ? colors.danger : colors.muted}
                            />
                          )}
                          <View style={{ flex: 1, gap: 3 }}>
                            <Text style={s.text}>{t(step.title)}</Text>
                            <Text style={s.small}>
                              {t(statusLabel(step.status))}
                              {step.detail ? ` · ${step.detail}` : ""}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </>
                  )}
              </View>
            ) : selected !== "summary" ? (
              <View style={{ gap: 14 }}>
                <Text style={s.heading}>
                  {t(selectedEvent?.title || selectedStep?.title || "Your request")}
                </Text>
                {selectedEvent && (
                  <Text style={s.small}>
                    {stamp(selectedEvent.date)} · {t(statusLabel(selectedEvent.kind))}
                  </Text>
                )}
                {selectedStep && <Text style={s.small}>{t(statusLabel(selectedStep.status))}</Text>}
                <Text selectable style={s.text}>
                  {selectedEvent?.detail ||
                    selectedStep?.detail ||
                    (selected === "request"
                      ? task.prompt
                      : t("This step has no additional details."))}
                </Text>
                <Button small onPress={() => setSelected("summary")}>
                  {t("Back to summary")}
                </Button>
              </View>
            ) : (
              <>
                <View style={{ gap: 13 }}>
                  <Text style={s.heading}>{t("Summary")}</Text>
                  <AssistantResponse
                    content={t(
                      resultSummary(task.result || task.question || task.error || task.prompt),
                    )}
                  />
                  <Text style={s.small}>{stamp(task.updatedAt)}</Text>
                </View>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  {[
                    "queued",
                    "running",
                    "scheduled",
                    "waiting_input",
                    "waiting_approval",
                    "waiting_provider",
                  ].includes(task.status) && (
                    <Button
                      small
                      icon={Pause}
                      busy={busy}
                      onPress={() => void act("control", { action: "pause" })}
                    >
                      Pause
                    </Button>
                  )}
                  {task.status === "paused" && (
                    <Button
                      small
                      icon={Play}
                      busy={busy}
                      onPress={() => void act("control", { action: "resume" })}
                    >
                      Resume
                    </Button>
                  )}
                  {task.status === "failed" && (
                    <Button
                      small
                      icon={RefreshCw}
                      busy={busy}
                      onPress={() => void act("control", { action: "retry" })}
                    >
                      Retry task
                    </Button>
                  )}
                  {activeTask(task) && (
                    <Button
                      small
                      danger
                      icon={X}
                      busy={busy}
                      onPress={() => void act("control", { action: "cancel" })}
                    >
                      Cancel task
                    </Button>
                  )}
                </View>
                {task.completion?.status !== "verified" && <TaskCompletion task={task} />}
                {task.status === "waiting_approval" && (
                  <Card style={{ backgroundColor: colors.lavender, gap: 12 }}>
                    <Text style={s.heading}>Ready for your review</Text>
                    <Text style={s.muted}>
                      Review the exact action and account before it proceeds.
                    </Text>
                    <Button primary busy={busy} onPress={() => void review()}>
                      Review action
                    </Button>
                  </Card>
                )}
                {task.status === "waiting_input" &&
                  detail?.interactions?.some((request) => request.status === "waiting") &&
                  detail.interactions
                    .filter((request) => request.status === "waiting")
                    .map((request) => (
                      <InteractionCard
                        key={request.id}
                        request={request}
                        onAnswered={() => {
                          void refreshWorkspace();
                        }}
                      />
                    ))}
                {task.status === "waiting_input" &&
                  !detail?.interactions?.some((request) => request.status === "waiting") && (
                    <Card style={{ backgroundColor: colors.sky, gap: 10 }}>
                      <Text style={s.heading}>
                        {task.question || "A detail from you will help"}
                      </Text>
                      {fieldNames.map((name) =>
                        missing.some(
                          (f) =>
                            typeof f === "object" && f && f.name === name && f.type === "checkbox",
                        ) ? (
                          <CheckRow
                            key={name}
                            label={name.replace(/_/g, " ")}
                            checked={Boolean(fields[name])}
                            onPress={() =>
                              setFields((current) => ({ ...current, [name]: !current[name] }))
                            }
                          />
                        ) : (
                          <Field
                            key={name}
                            label={name.replace(/_/g, " ")}
                            value={String(fields[name] ?? "")}
                            onChangeText={(value) =>
                              setFields((current) => ({ ...current, [name]: value }))
                            }
                          />
                        ),
                      )}
                      {!fieldNames.length && (
                        <Field
                          label="Your answer"
                          value={answer}
                          onChangeText={setAnswer}
                          multiline
                          placeholder="Add the missing details…"
                        />
                      )}
                      {task.kind === "document" && !fieldNames.length && (
                        <>
                          <Button small onPress={() => setShowFieldJson(!showFieldJson)}>
                            Form field values
                          </Button>
                          {showFieldJson && (
                            <Field
                              label="Fields (JSON: field name to value)"
                              value={fieldJson}
                              onChangeText={setFieldJson}
                              multiline
                              autoCapitalize="none"
                              placeholder={'{"full_name":"Your name","consent":true}'}
                            />
                          )}
                        </>
                      )}
                      <Button
                        primary
                        busy={busy}
                        disabled={
                          !answer.trim() && !Object.keys(fields).length && !fieldJson.trim()
                        }
                        onPress={() => void submitInput()}
                      >
                        Continue task
                      </Button>
                    </Card>
                  )}
                <ErrorNotice error={task.error ?? undefined} />
                {detail?.browsers?.map((browser) => (
                  <Card key={browser.id} style={{ gap: 10 }}>
                    <Text style={s.heading}>{browser.title || "Agent browser"}</Text>
                    <Text style={s.small}>{browser.url}</Text>
                    {previewVisible && browser.status === "active" && browser.previewUrl && (
                      <Image
                        accessibilityLabel="Agent browser preview"
                        source={{ uri: api.url(browser.previewUrl) }}
                        style={{ width: "100%", aspectRatio: 1.6, borderRadius: 12 }}
                      />
                    )}
                    <Button
                      small
                      busy={busy}
                      onPress={() => {
                        setBusy(true);
                        void (async () => {
                          try {
                            if (["running", "scheduled", "queued"].includes(task.status))
                              await mutate(`/tasks/${taskId}/control`, { action: "pause" });
                            open({ type: "browser", browser });
                          } catch (error) {
                            setError(errorText(error));
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      {["running", "scheduled", "queued"].includes(task.status)
                        ? "Pause and open browser"
                        : "Open browser"}
                    </Button>
                  </Card>
                ))}
                {detail?.files?.map((file) => (
                  <LinkRow
                    key={file.id}
                    title={file.name}
                    detail={attachmentLabel(file)}
                    icon={FileText}
                    onPress={() => open({ type: "file", file })}
                  />
                ))}
                {(
                  data?.artifacts.filter((artifact) => artifact.taskId === taskId) ||
                  detail?.artifacts ||
                  []
                ).map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} />
                ))}
                {!!task.evidence.length && (
                  <View style={{ gap: 14 }}>
                    <Text style={s.heading}>Sources</Text>
                    <EvidenceList items={task.evidence} />
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  aria-expanded={manage}
                  onPress={() => setManage(!manage)}
                  style={[
                    s.between,
                    {
                      paddingVertical: 13,
                      borderTopWidth: 1,
                      borderBottomWidth: 1,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Text style={s.muted}>{t("Task settings")}</Text>
                  {manage ? (
                    <ChevronDown size={16} color={colors.muted} />
                  ) : (
                    <ChevronRight size={16} color={colors.muted} />
                  )}
                </Pressable>
                {manage && (
                  <View style={{ gap: 14 }}>
                    <TaskTimingControls task={task} />
                    <TaskBudgetControls task={task} />
                    {task.completion?.status === "verified" && <TaskCompletion task={task} />}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}
export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  return artifact.kind === "finance" ? (
    <FinanceArtifact artifact={artifact} />
  ) : (
    <ArtifactResultCard key={artifact.id} artifact={artifact} />
  );
}

function FinanceArtifact({ artifact }: { artifact: AgentArtifact }) {
  const { colors, s } = useUI();

  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { mutate } = useAgentWorkspace();
  const [goalTitle, setGoalTitle] = useState("");
  const [goalSaved, setGoalSaved] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState("");
  const saveGoal = async () => {
    setGoalBusy(true);
    setGoalError("");
    try {
      await mutate("/goals", {
        title: goalTitle.trim(),
        category: "Finances",
        description: `Inspired by ${artifact.title}: ${artifact.summary}`,
        milestones: ["Choose a savings target", "Review spending each week"],
      });
      setGoalSaved(true);
    } catch (error) {
      setGoalError(errorText(error));
    } finally {
      setGoalBusy(false);
    }
  };
  const amount = (value: unknown) =>
    Number(value ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const categories = Array.isArray(artifact.data.categories) ? artifact.data.categories : [];
  const transactions = Array.isArray(artifact.data.transactions) ? artifact.data.transactions : [];
  const spending = Number(artifact.data.spending) || 1;
  const period = record(artifact.data.period);
  return (
    <Card
      style={{ gap: 12, padding: 10, backgroundColor: colors.subtle, maxWidth: 440, width: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open finance tracker: ${artifact.title}`}
        aria-expanded={details}
        onPress={() => setDetails(!details)}
      >
        <View
          style={{
            minHeight: 200,
            borderRadius: 16,
            overflow: "hidden",
            backgroundColor: colors.code,
            padding: 20,
          }}
        >
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 142 }}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="finance" x1="0" y1="0" x2="0.5" y2="1">
                  <Stop offset="0" stopColor="#281066" />
                  <Stop offset="0.5" stopColor="#163BBF" />
                  <Stop offset="1" stopColor="#148CE8" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#finance)" />
            </Svg>
          </View>
          <Text style={{ color: colors.blueDark, fontSize: 11, lineHeight: 18, marginBottom: 20 }}>
            Read from your imported transactions.{"\n"}
            {String(period?.from ?? "")} — {String(period?.to ?? "")}
            {"\n"}
            {transactions.length} transactions, categorized and summarized.
          </Text>
          <View style={[s.row, { gap: 7 }]}>
            {(
              [
                ["Income", "income"],
                ["Spending", "spending"],
                ["Remaining", "saved"],
              ] as const
            ).map(([label, key]) => (
              <View
                key={key}
                style={{ flex: 1, padding: 11, borderRadius: 12, backgroundColor: colors.code }}
              >
                <Text style={{ color: colors.muted, fontSize: 9 }}>{label}</Text>
                <Text
                  selectable
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.65}
                  style={{
                    fontSize: 17,
                    fontWeight: "600",
                    color: key === "saved" ? colors.success : colors.onFeature,
                    marginTop: 5,
                  }}
                >
                  {amount(artifact.data[key])}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 8, marginTop: 4 }}>
                  source currency
                </Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[s.row, { gap: 11, paddingHorizontal: 8, paddingTop: 13, paddingBottom: 4 }]}>
          <SubjectIllustration title={artifact.title} kind="finance" size={28} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.text, { fontWeight: "600" }]}>Finance tracker</Text>
            <Text style={s.small}>Spending, savings, and a plan for what’s next.</Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
      </Pressable>
      {details && (
        <View style={{ gap: 16, padding: 10 }}>
          <Text style={s.label}>Where your money went</Text>
          {categories.map((category) => {
            const row = record(category);
            if (!row) return null;
            return (
              <View key={String(row.name)} style={{ gap: 8 }}>
                <View style={s.between}>
                  <Text style={s.text}>{String(row.name)}</Text>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
                <View style={{ height: 7, backgroundColor: colors.subtle, borderRadius: 8 }}>
                  <View
                    style={{
                      width: `${Math.min(100, (Number(row.amount) / spending) * 100)}%`,
                      height: 7,
                      backgroundColor: colors.blueDark,
                      borderRadius: 8,
                    }}
                  />
                </View>
              </View>
            );
          })}
          <Text style={s.small}>
            Amounts use your source currency. This summary covers the imported dates.
          </Text>
          {goalSaved ? (
            <Text style={s.text}>Your savings goal is saved in Goals.</Text>
          ) : (
            <View style={{ gap: 10 }}>
              <Field
                label="Turn this into a savings goal"
                value={goalTitle}
                onChangeText={setGoalTitle}
                placeholder="What would you like to save for?"
              />
              <ErrorNotice error={goalError} />
              <Button
                small
                busy={goalBusy}
                disabled={!goalTitle.trim()}
                onPress={() => void saveGoal()}
              >
                Create savings goal
              </Button>
            </View>
          )}
          <Button small onPress={() => setExpanded(!expanded)}>
            {expanded ? "Hide transactions" : "View transactions"}
          </Button>
          {expanded &&
            transactions.slice(0, 100).map((transaction) => {
              const row = record(transaction);
              return row ? (
                <View key={String(row.id ?? display(row))} style={s.between}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{String(row.description)}</Text>
                    <Text style={s.small}>
                      {String(row.date)} · {String(row.category)}
                    </Text>
                  </View>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
              ) : null;
            })}
          {expanded && transactions.length > 100 && (
            <Text style={s.small}>
              Showing the first 100 transactions. The totals include every row.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}
export function DelegateSheet() {
  const { s } = useUI();

  const { workspace, close, open } = useWorkspace();
  const { delegate } = useAgentWorkspace();
  const { selection, enabled } = useMuseThread();
  const [kind, setKind] = useState<AgentTask["kind"]>("plan");
  const [prompt, setPrompt] = useState("");
  const [messageId, setMessageId] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        prompt: prompt.trim(),
        kind,
        ...(enabled ? { originThreadId: selection.id } : {}),
        input: kind === "finance" ? { csv } : kind === "document" ? { messageId } : {},
      });
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Hand over an outcome"
      subtitle="OkamiBot saves a plan and keeps working on the server."
      onClose={close}
    >
      <View style={[s.row, { flexWrap: "wrap", gap: 8, marginBottom: 20 }]}>
        {(["plan", "document", "finance", "agent"] as const).map((item) => (
          <Button small primary={kind === item} key={item} onPress={() => setKind(item)}>
            {item === "agent" ? "General task" : statusLabel(item)}
          </Button>
        ))}
      </View>
      <Field
        label="What would you like done?"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder={
          kind === "document"
            ? "Fill the attached form and prepare a reply for my review"
            : kind === "finance"
              ? "Summarize my spending and suggest a savings plan"
              : "Make a practical plan for my week"
        }
      />
      {kind === "document" && (
        <View style={{ gap: 8, marginBottom: 18 }}>
          <Text style={s.heading}>Choose the email with the PDF</Text>
          {workspace.mail
            .filter((mail) => mail.attachments.length)
            .map((mail) => (
              <CheckRow
                key={mail.id}
                checked={mail.id === messageId}
                label={`${mail.subject} · ${mail.sender}`}
                onPress={() => setMessageId(mail.id)}
              />
            ))}
          {!workspace.mail.some((mail) => mail.attachments.length) && (
            <Text style={s.muted}>
              Connect mail in Apps and select a message with a PDF attachment.
            </Text>
          )}
        </View>
      )}
      {kind === "finance" && (
        <>
          <Field
            label="Transaction CSV"
            value={csv}
            onChangeText={setCsv}
            multiline
            autoCapitalize="none"
            placeholder={"date,description,amount,category\n2026-09-01,Groceries,54.20,Food"}
          />
          {workspace.mode === "sample" && (
            <Button
              onPress={() =>
                setCsv(
                  "date,description,amount,category\n2026-09-01,Salary,-4200,Income\n2026-09-02,Groceries,84.50,Food\n2026-09-03,Subscription,19.99,Subscriptions\n2026-09-04,Coffee,6.50,Food",
                )
              }
            >
              Try example transactions
            </Button>
          )}
          <Text style={[s.small, { marginVertical: 12 }]}>
            Positive amounts are expenses; negative amounts are income. Imported data only. No bank
            connection is implied.
          </Text>
        </>
      )}
      {kind === "agent" && !workspace.runtime.configured && (
        <Text style={[s.muted, { marginBottom: 16 }]}>
          General tasks and plans require a configured model. Document jobs, page watches and
          spending summaries have guided workflows.
        </Text>
      )}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !prompt.trim() ||
          (kind === "document" && !messageId) ||
          (kind === "finance" && !csv.trim())
        }
        onPress={() => void submit()}
      >
        Delegate task
      </Button>
    </Sheet>
  );
}
export function IdeasScreen() {
  const { colors, s } = useUI();

  const { data, mutate } = useAgentWorkspace();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refreshIdeas() {
    setBusy(true);
    setError("");
    try {
      await mutate("/ideas/refresh", {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const ideas = data?.ideas.filter((idea) => idea.status === "new") || [];
  const categories = [...new Set(ideas.map(ideaCategory))];
  const started = (data?.ideas || []).filter((idea) => idea.status === "accepted");
  return (
    <View style={{ gap: 10 }}>
      <AgentStatus />
      <View style={[s.between, { marginBottom: 9 }]}>
        <Text style={s.title}>{t("Ideas")}</Text>
        <Button small icon={RefreshCw} busy={busy} onPress={() => void refreshIdeas()}>
          {t("Find ideas")}
        </Button>
      </View>
      <ErrorNotice error={error} />
      {categories.map((category) => (
        <View key={category}>
          {category !== "For you" && (
            <Text style={[s.heading, { fontSize: 21, marginTop: 25, marginBottom: 5 }]}>
              {t(category)}
            </Text>
          )}
          {ideas
            .filter((idea) => ideaCategory(idea) === category)
            .map((idea) => (
              <IdeaCard key={idea.id} idea={idea} />
            ))}
        </View>
      ))}
      {!ideas.length && (
        <Empty
          icon={Lightbulb}
          title={t("Room for a good idea")}
          detail={t(
            "Find ideas from the sources you have granted access to. Each suggestion includes its evidence.",
          )}
        />
      )}
      {!!started.length && (
        <View style={{ marginTop: 25 }}>
          <Text style={[s.heading, { marginBottom: 12 }]}>{t("Started")}</Text>
          {started.map((idea) => (
            <View
              key={idea.id}
              style={{
                paddingVertical: 17,
                borderBottomWidth: 1,
                borderBottomColor: colors.line,
                flexDirection: "row",
                gap: 14,
              }}
            >
              <CheckCircle2 size={20} color={colors.success} />
              <View style={{ flex: 1, gap: 10 }}>
                <Text style={s.text}>{idea.title}</Text>
                {!!idea.taskId && <TaskLink taskId={idea.taskId} />}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function TaskLink({ taskId, onOpen }: { taskId: string; onOpen?: () => void }) {
  const { open } = useWorkspace();
  return (
    <Button
      small
      icon={ArrowRight}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId });
      }}
    >
      View task
    </Button>
  );
}
function IdeaCard({ idea }: { idea: Idea }) {
  const { colors, s } = useUI();

  const { mutate } = useAgentWorkspace();
  const { t } = useI18n();
  const { open } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(idea.prompt);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: "accept" | "dismiss") {
    setBusy(true);
    setError("");
    try {
      const result = await mutate<Idea>(`/ideas/${idea.id}`, { action, prompt });
      if (result.taskId && action === "accept") open({ type: "task", taskId: result.taskId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ paddingVertical: 23, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View idea: ${idea.title}`}
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", gap: 14 }}
      >
        <SubjectIllustration title={idea.title} kind={idea.kind} />
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[s.heading, { fontSize: 17, lineHeight: 24, fontWeight: "500" }]}>
            {idea.title}
          </Text>
          <Text style={[s.muted, { fontSize: 15, lineHeight: 24 }]}>{idea.reason}</Text>
        </View>
      </Pressable>
      {expanded && (
        <View style={{ gap: 15, marginTop: 18, paddingLeft: 54 }}>
          <EvidenceList items={idea.evidence} />
          {editing && (
            <Field
              label={t("What should your agent do?")}
              value={prompt}
              onChangeText={setPrompt}
              multiline
            />
          )}
          <ErrorNotice error={error} />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              busy={busy}
              disabled={!prompt.trim()}
              onPress={() => void act("accept")}
            >
              {t("Start this")}
            </Button>
            <Button disabled={busy} onPress={() => setEditing(!editing)}>
              {t(editing ? "Keep edits" : "Edit")}
            </Button>
            <Button disabled={busy} onPress={() => void act("dismiss")}>
              {t("Dismiss")}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
export function GoalsScreen() {
  const { colors, s } = useUI();

  const { data } = useAgentWorkspace();
  const { t } = useI18n();
  const [adding, setAdding] = useState<string>();
  const [selectedGoal, setSelectedGoal] = useState<string>();
  const [selectedMonitor, setSelectedMonitor] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const goal = data?.goals.find((item) => item.id === selectedGoal);
  const monitor = data?.monitors.find((item) => item.id === selectedMonitor);
  const monitors = data?.monitors || [];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <View style={{ gap: 8 }}>
        <View style={[s.between, { marginBottom: 5 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                borderWidth: 5,
                borderColor: colors.line,
                backgroundColor: "#24A46B",
              }}
            />
            <Text style={[s.heading, { color: colors.success }]}>{t("Tracking")}</Text>
          </View>
          <Button small icon={Plus} onPress={() => setAdding("Tracking")}>
            {t("Track")}
          </Button>
        </View>
        {(showAll ? monitors : monitors.slice(0, 3)).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={t("Open tracking: {title}", { title: item.title })}
            onPress={() => setSelectedMonitor(item.id)}
            style={[s.row, { gap: 12, paddingVertical: 13 }]}
          >
            <Square size={21} color={colors.muted} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.text}>{item.title}</Text>
              <Text numberOfLines={2} style={s.muted}>
                {item.lastValue
                  ? resultSummary(item.lastValue)
                  : item.status === "active"
                    ? t("Checking every {minutes} minutes", { minutes: item.intervalMinutes })
                    : t(statusLabel(item.status))}
              </Text>
            </View>
            <MoreHorizontal size={19} color={colors.muted} />
          </Pressable>
        ))}
        {!monitors.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>
            {t(
              "Follow a price or a page. Your assistant will let you know when something changes.",
            )}
          </Text>
        )}
        {monitors.length > 3 && (
          <Button small onPress={() => setShowAll(!showAll)}>
            {showAll ? t("Show less") : t("Show {count} more", { count: monitors.length - 3 })}
          </Button>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 10, marginBottom: 5 }]}>
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 5,
              borderColor: colors.selectedBorder,
              backgroundColor: "#3D9BDE",
            }}
          />
          <Text style={[s.heading, { color: colors.blueDark }]}>{t("Goals")}</Text>
        </View>
        {data?.goals.map((item) => (
          <GoalListRow key={item.id} goal={item} onOpen={() => setSelectedGoal(item.id)} />
        ))}
        {!data?.goals.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>
            {t("What would you like to work toward? Add a goal and take it one step at a time.")}
          </Text>
        )}
      </View>
      <View style={{ gap: 15, paddingTop: 6 }}>
        <Button icon={Plus} onPress={() => setAdding("Something else")}>
          {t("Create a goal")}
        </Button>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {[
            { name: "Health", icon: Heart },
            { name: "Relationships", icon: Users },
            { name: "Finances", icon: CircleDollarSign },
          ].map((item) => (
            <Pressable
              key={item.name}
              accessibilityRole="button"
              accessibilityLabel={t("Create a goal: {category}", { category: t(item.name) })}
              onPress={() => setAdding(item.name)}
              style={[
                s.row,
                {
                  gap: 8,
                  minHeight: 38,
                  borderRadius: 20,
                  paddingHorizontal: 14,
                  backgroundColor: colors.subtle,
                },
              ]}
            >
              <item.icon size={17} color={colors.muted} />
              <Text style={[s.text, { fontSize: 13, color: colors.muted }]}>{t(item.name)}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      {adding && (
        <Sheet
          title={t(adding === "Tracking" ? "Track something" : "Create a goal")}
          onClose={() => setAdding(undefined)}
        >
          {adding === "Tracking" ? (
            <MonitorForm onDone={() => setAdding(undefined)} />
          ) : (
            <GoalForm category={adding} onDone={() => setAdding(undefined)} />
          )}
        </Sheet>
      )}
      {goal && (
        <Sheet title={goal.title} onClose={() => setSelectedGoal(undefined)}>
          <GoalCard goal={goal} onOpenTask={() => setSelectedGoal(undefined)} />
        </Sheet>
      )}
      {monitor && (
        <Sheet title={monitor.title} onClose={() => setSelectedMonitor(undefined)}>
          <MonitorCard monitor={monitor} onOpenTask={() => setSelectedMonitor(undefined)} />
        </Sheet>
      )}
    </View>
  );
}
function GoalListRow({ goal, onOpen }: { goal: Goal; onOpen: () => void }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <View style={{ flexDirection: "row", gap: 12, paddingVertical: 15 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Expand goal")}
          aria-expanded={expanded}
          onPress={() => (goal.milestones.length ? setExpanded(!expanded) : onOpen())}
          style={{ paddingTop: 3, width: 23 }}
        >
          {goal.milestones.length ? (
            expanded ? (
              <ChevronDown size={21} color={colors.muted} />
            ) : (
              <ChevronRight size={21} color={colors.muted} />
            )
          ) : goal.status === "completed" ? (
            <Check size={21} color={colors.success} />
          ) : (
            <Square size={21} color={colors.muted} />
          )}
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onOpen} style={{ flex: 1, gap: 4 }}>
          <Text style={[s.text, { fontSize: 16 }]}>{goal.title}</Text>
          <Text numberOfLines={3} style={s.muted}>
            {goal.description || t(statusLabel(goal.status))}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Goal details")}
          onPress={onOpen}
          style={{ padding: 3 }}
        >
          <MoreHorizontal size={19} color={colors.muted} />
        </Pressable>
      </View>
      {expanded && (
        <View style={{ paddingLeft: 35, paddingBottom: 12 }}>
          {goal.milestones.map((milestone) => (
            <Pressable
              accessibilityRole="button"
              key={milestone.id}
              onPress={onOpen}
              style={[s.row, { gap: 12, paddingVertical: 12 }]}
            >
              {milestone.done ? (
                <Check size={20} color={colors.success} />
              ) : (
                <Square size={20} color={colors.muted} />
              )}
              <Text style={[s.text, { flex: 1 }]}>{milestone.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function GoalForm({ onDone, category }: { onDone: () => void; category?: string }) {
  const { mutate } = useAgentWorkspace();
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestones, setMilestones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await mutate("/goals", {
        title: title.trim(),
        category,
        description,
        milestones: milestones
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View>
      <Field
        label={t("Your goal")}
        value={title}
        onChangeText={setTitle}
        placeholder={t("Build a three-month emergency fund")}
      />
      <Field
        label={t("What does success look like?")}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Field
        label={t("Milestones (one per line)")}
        value={milestones}
        onChangeText={setMilestones}
        multiline
      />
      <ErrorNotice error={error} />
      <Button primary disabled={!title.trim()} busy={busy} onPress={() => void save()}>
        {t("Create goal")}
      </Button>
    </View>
  );
}
function GoalCard({ goal, onOpenTask }: { goal: Goal; onOpenTask?: () => void }) {
  const { colors, s } = useUI();

  const { data, mutate, delegate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const { t } = useI18n();
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = goal.milestones.filter((item) => item.done).length;
  const tasks = (data?.tasks || [])
    .filter((task) => task.goalId === goal.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const artifacts = (data?.artifacts || []).filter((artifact) =>
    tasks.some((task) => task.id === artifact.taskId),
  );
  async function update(body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/goals/${goal.id}`, {
        ...(body as object),
        expectedRevision: goal.revision ?? 0,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        title: `Plan: ${goal.title}`,
        prompt: `Create a practical plan for this goal: ${goal.title}. ${goal.description}`,
        kind: "plan",
        goalId: goal.id,
        input: {},
      });
      onOpenTask?.();
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 20 }}>
      {!!goal.description && (
        <Text style={[s.text, { fontSize: 16, lineHeight: 25 }]}>{goal.description}</Text>
      )}
      <Pressable
        accessibilityRole="button"
        aria-expanded={showArtifacts}
        onPress={() => setShowArtifacts(!showArtifacts)}
        style={[
          s.row,
          {
            paddingVertical: 19,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: colors.line,
            gap: 12,
          },
        ]}
      >
        <Text style={[s.text, { flex: 1 }]}>{t("Artifacts")}</Text>
        <Text style={s.muted}>{artifacts.length}</Text>
        {showArtifacts ? (
          <ChevronDown size={18} color={colors.muted} />
        ) : (
          <ChevronRight size={18} color={colors.muted} />
        )}
      </Pressable>
      {showArtifacts && (
        <View style={{ gap: 14 }}>
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {!artifacts.length && (
            <Text style={s.muted}>{t("Your goal's results will appear here.")}</Text>
          )}
        </View>
      )}
      {!!goal.milestones.length && (
        <Text style={s.small}>
          {done} / {goal.milestones.length} {t("milestones")}
        </Text>
      )}
      {goal.milestones.map((milestone) => (
        <CheckRow
          key={milestone.id}
          checked={milestone.done}
          label={milestone.title}
          onPress={() => {
            if (!busy)
              void update({
                milestone: { id: milestone.id, done: !milestone.done },
              });
          }}
        />
      ))}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small
          busy={busy}
          onPress={() => void update({ status: goal.status === "active" ? "paused" : "active" })}
        >
          {t(goal.status === "active" ? "Pause" : "Resume")}
        </Button>
        {goal.status !== "completed" && (
          <Button small busy={busy} onPress={() => void update({ status: "completed" })}>
            {t("Complete goal")}
          </Button>
        )}
        <Button small primary busy={busy} onPress={() => void plan()}>
          {t("Plan next steps")}
        </Button>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 20, gap: 18 }}>
        <Text style={s.heading}>{t("Activity")}</Text>
        {tasks.map((task) => (
          <Pressable
            key={task.id}
            accessibilityRole="button"
            onPress={() => {
              onOpenTask?.();
              open({ type: "task", taskId: task.id });
            }}
            style={{ flexDirection: "row", gap: 14 }}
          >
            <View style={{ alignItems: "center", width: 15 }}>
              <Circle size={13} color={colors.muted} />
              <View style={{ width: 1, flex: 1, backgroundColor: colors.line, marginTop: 6 }} />
            </View>
            <View style={{ flex: 1, gap: 5, paddingBottom: 10 }}>
              <Text style={s.text}>{task.title}</Text>
              <Text style={s.muted} numberOfLines={4}>
                {resultSummary(task.result || task.question || task.error || task.prompt)}
              </Text>
              <Text style={s.small}>{stamp(task.updatedAt)}</Text>
            </View>
          </Pressable>
        ))}
        <View style={{ flexDirection: "row", gap: 14 }}>
          <Circle size={13} color={colors.muted} />
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={s.text}>{t("Goal created")}</Text>
            <Text style={s.small}>{stamp(goal.createdAt)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function MonitorForm({ onDone }: { onDone: () => void }) {
  const { s } = useUI();

  const { workspace } = useWorkspace();
  const { mutate } = useAgentWorkspace();
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [condition, setCondition] = useState<Monitor["condition"]>("change");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [priceTarget, setPriceTarget] = useState("");
  const [interval, setInterval] = useState("15");
  const [sample, setSample] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const minutes = Number(interval);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
        throw new Error(t("Use a check interval from 1 to 10080 minutes."));
      if (!sample && !/^https?:\/\//i.test(url.trim()))
        throw new Error(t("Enter an http or https address for a public page."));
      await mutate("/monitors", {
        title: title.trim(),
        url: sample ? "sample://availability" : url.trim(),
        condition,
        value,
        intervalMinutes: minutes,
        ...(condition === "price_below" ? { currency, priceTarget } : {}),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View>
      <Field
        label={t("What are you watching?")}
        value={title}
        onChangeText={setTitle}
        placeholder={t("A table at my favorite restaurant")}
      />
      {workspace.mode === "sample" && (
        <CheckRow
          checked={sample}
          label={t("Try the built-in availability page")}
          onPress={() => setSample(!sample)}
        />
      )}
      {!sample && (
        <Field
          label={t("Public page URL")}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          placeholder="https://example.com/product"
        />
      )}
      <Text style={[s.small, { marginBottom: 10 }]}>{t("Notify me when")}</Text>
      <View style={[s.row, { gap: 7, flexWrap: "wrap", marginBottom: 16 }]}>
        {(["change", "contains", "price_below"] as const).map((item) => (
          <Button small primary={condition === item} key={item} onPress={() => setCondition(item)}>
            {t(
              item === "change"
                ? "Page changes"
                : item === "contains"
                  ? "Text appears"
                  : "Price drops below",
            )}
          </Button>
        ))}
      </View>
      {condition !== "change" && (
        <Field
          label={t(condition === "contains" ? "Text to look for" : "Target price")}
          value={value}
          onChangeText={setValue}
        />
      )}
      {condition === "price_below" && (
        <>
          <Field
            label={t("Exact product name")}
            value={priceTarget}
            onChangeText={setPriceTarget}
          />
          <Field
            label={t("Currency (EUR, USD, BRL...)")}
            value={currency}
            onChangeText={(value) => setCurrency(value.toUpperCase())}
          />
        </>
      )}
      <Field
        label={t("Check every (minutes)")}
        value={interval}
        onChangeText={setInterval}
        keyboardType="number-pad"
      />
      <Text style={[s.small, { marginBottom: 14 }]}>
        {t(
          sample
            ? "Changes to this built-in page stay in your workspace."
            : "OkamiBot checks this public page on the server and saves meaningful changes in Notifications.",
        )}
      </Text>
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !title.trim() || (!sample && !url.trim()) || (condition !== "change" && !value.trim())
        }
        onPress={() => void save()}
      >
        {t("Start tracking")}
      </Button>
    </View>
  );
}
function MonitorCard({ monitor, onOpenTask }: { monitor: Monitor; onOpenTask?: () => void }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { mutate } = useAgentWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/monitors/${monitor.id}/control`, { action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeSample() {
    setBusy(true);
    setError("");
    try {
      await mutate("/sample-page", {
        text: `Availability: a table is available. Updated ${new Date().toISOString()}`,
      });
      await mutate(`/monitors/${monitor.id}/control`, { action: "check" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 18 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{t("Tracking")}</Text>
        <Chip tint={colors.sky}>{t(statusLabel(monitor.status))}</Chip>
      </View>
      <Text selectable style={s.small}>
        {monitor.url.startsWith("sample:") ? t("Built-in availability page") : monitor.url}
      </Text>
      <Text style={s.text}>
        {monitor.condition === "change"
          ? t("Watch for a page change")
          : monitor.condition === "contains"
            ? t("Watch for “{value}”", { value: monitor.value })
            : t("Price below {value}", { value: monitor.value })}
      </Text>
      <Text style={s.small}>
        {t("Every {minutes} min · {count} checks", {
          minutes: monitor.intervalMinutes,
          count: monitor.checks,
        })}
      </Text>
      <Text style={s.small}>
        {t("Last check: {date}", { date: stamp(monitor.lastCheckedAt) })}
        {monitor.status === "active"
          ? `\n${t("Next check: {date}", { date: stamp(monitor.nextCheckAt) })}`
          : ""}
      </Text>
      {!!monitor.lastValue && (
        <Text selectable numberOfLines={5} style={s.muted}>
          {monitor.lastValue}
        </Text>
      )}
      {!!monitor.lastDiff && (
        <Text selectable style={s.small}>
          {monitor.lastDiff}
        </Text>
      )}
      {!!monitor.diffTruncated && (
        <Text style={s.small}>
          {t("Partial comparison. Open the source for the full content.")}
        </Text>
      )}
      <ErrorNotice error={error || monitor.error || monitor.coverageWarning} />
      {monitor.status !== "stopped" && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            small
            busy={busy}
            onPress={() => void act(monitor.status === "active" ? "pause" : "resume")}
          >
            {t(monitor.status === "active" ? "Pause" : "Resume")}
          </Button>
          <Button small busy={busy} onPress={() => void act("check")}>
            {t("Check now")}
          </Button>
          <Button small danger busy={busy} onPress={() => void act("stop")}>
            {t("Stop tracking")}
          </Button>
        </View>
      )}
      {monitor.url.startsWith("sample:") && monitor.status !== "stopped" && (
        <Button small busy={busy} onPress={() => void changeSample()}>
          {t("Change availability")}
        </Button>
      )}
      <TaskLink taskId={monitor.taskId} onOpen={onOpenTask} />
    </View>
  );
}
export function NotificationsSheet() {
  const { colors, s } = useUI();

  const { data, mutate } = useAgentWorkspace();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string>();
  const { close, open } = useWorkspace();
  const [error, setError] = useState("");
  async function read(id: string, taskId?: string) {
    try {
      await mutate(`/notifications/${id}/read`, {});
      if (taskId) open({ type: "task", taskId });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Sheet title="Notifications" onClose={close}>
      <View style={{ gap: 14 }}>
        <ErrorNotice error={error} />
        {productNotifications(data?.tasks ?? [], data?.notifications ?? []).map((item) => (
          <View
            key={item.id}
            style={{
              flexDirection: "row",
              gap: 14,
              paddingVertical: 17,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <View style={{ width: 28, paddingTop: 3 }}>
              <Bell size={20} color={item.read ? colors.muted : colors.blueDark} />
            </View>
            <View style={{ flex: 1, gap: 7 }}>
              <View style={s.between}>
                <Text style={[s.text, { flex: 1, fontWeight: item.read ? "400" : "600" }]}>
                  {item.title}
                </Text>
                {!item.read && (
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: colors.blueDark,
                      marginLeft: 9,
                    }}
                  />
                )}
              </View>
              <Text style={s.muted}>{item.body}</Text>
              <Text style={s.small}>{stamp(item.createdAt)}</Text>
              {expanded === item.id && item.nativeDelivery && (
                <Text style={s.small}>
                  {item.nativeDelivery === "accepted"
                    ? "Phone notification accepted by provider"
                    : item.nativeDelivery === "not_configured"
                      ? "Available in-app; phone delivery not configured"
                      : item.nativeDelivery === "outcome_unknown"
                        ? "Phone delivery uncertain; result stays here"
                        : `Phone delivery: ${item.nativeDelivery}`}
                </Text>
              )}
              <View style={[s.row, { gap: 16 }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void read(item.id, item.taskId)}
                  style={{ minHeight: 32, justifyContent: "center" }}
                >
                  <Text style={[s.small, { color: colors.text, fontWeight: "500" }]}>
                    {t(item.taskId ? "View task" : item.read ? "Read" : "Mark read")}
                  </Text>
                </Pressable>
                {!!item.nativeDelivery && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("Notification details")}
                    aria-expanded={expanded === item.id}
                    onPress={() => setExpanded(expanded === item.id ? undefined : item.id)}
                    style={{ padding: 7 }}
                  >
                    <Info size={15} color={colors.muted} />
                  </Pressable>
                )}
              </View>
            </View>
          </View>
        ))}
        {!productNotifications(data?.tasks ?? [], data?.notifications ?? []).length && (
          <Empty
            icon={Bell}
            title="You're all caught up"
            detail="Results, meaningful changes and requests for your input will appear here."
          />
        )}
      </View>
    </Sheet>
  );
}
export function AppsScreen() {
  const { colors, s } = useUI();

  const { navigate, open } = useWorkspace();
  const { t } = useI18n();
  const [panel, setPanel] = useState<"routines" | "playbooks" | "notifications" | "recovery">();
  const { data, mutate } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  const [showChatUpdates, setShowChatUpdates] = useState(data?.identity.showChatUpdates !== false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.identity) {
      setAvatar(data.identity.avatar || "sky");
      setShowChatUpdates(data.identity.showChatUpdates !== false);
    }
  }, [data?.identity.avatar, data?.identity.showChatUpdates]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const shortcuts = [
    {
      section: "mail" as const,
      title: "Mail",
      detail: "Read messages and prepare replies",
      icon: Mail,
    },
    {
      section: "calendar" as const,
      title: "Calendar",
      detail: "Events and reviewed invitations",
      icon: CalendarDays,
    },
    {
      section: "browser" as const,
      title: "Agent computer",
      detail: "Persistent browser sessions",
      icon: Globe2,
    },
    {
      section: "files" as const,
      title: "Files",
      detail: "PDFs, forms and filled copies",
      icon: FileText,
    },
  ];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <Field
        label={t("Search apps")}
        value={query}
        onChangeText={setQuery}
        placeholder={t("Search connectors")}
      />
      <ConnectionsScreen query={query} />
      <Text style={[s.small, { marginTop: 5 }]}>{t("On your computer")}</Text>
      <View style={{ paddingVertical: 3 }}>
        {shortcuts
          .filter((item) =>
            `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => (
            <LinkRow
              key={item.section}
              icon={item.icon}
              title={t(item.title)}
              detail={t(item.detail)}
              onPress={() =>
                item.section === "browser" ? open({ type: "computer" }) : navigate(item.section)
              }
            />
          ))}
      </View>
      {!query && (
        <View style={{ gap: 2 }}>
          <Text style={[s.small, { marginBottom: 8 }]}>{t("Manage")}</Text>
          <LinkRow
            icon={RefreshCw}
            title={t("Routines")}
            detail={t("Things your agent does regularly")}
            onPress={() => setPanel("routines")}
          />
          <LinkRow
            icon={ListChecks}
            title={t("Playbooks")}
            detail={t("Your saved ways of doing things")}
            onPress={() => setPanel("playbooks")}
          />
          <LinkRow
            icon={Bell}
            title={t("Notifications")}
            detail={t("Choose how updates reach you")}
            onPress={() => setPanel("notifications")}
          />
          <LinkRow
            icon={FileText}
            title={t("File history")}
            detail={t("Review and restore saved versions")}
            onPress={() => setPanel("recovery")}
          />
          <LinkRow
            icon={Settings2}
            title={t("Personality & memory")}
            detail={t("Make your agent feel like yours")}
            onPress={() => setSettings(true)}
          />
        </View>
      )}
      {panel && (
        <Sheet
          title={t(
            panel === "routines"
              ? "Routines"
              : panel === "playbooks"
                ? "Playbooks"
                : panel === "notifications"
                  ? "Notifications"
                  : "File history",
          )}
          onClose={() => setPanel(undefined)}
        >
          {panel === "routines" ? (
            <RoutinesPanel />
          ) : panel === "playbooks" ? (
            <PlaybooksPanel />
          ) : panel === "notifications" ? (
            <NativePushSettings />
          ) : (
            <FileRecoveryPanel />
          )}
        </Sheet>
      )}
      {settings && (
        <Sheet title={t("Personality & memory")} onClose={() => setSettings(false)}>
          <View style={{ gap: 22 }}>
            <ProfileSettings />
            <Card style={{ gap: 10 }}>
              <SectionHeading title="Your agent" />
              <View style={[s.row, { gap: 16, justifyContent: "center", marginBottom: 12 }]}>
                {(["sky", "sand", "lilac"] as const).map((item) => (
                  <Pressable
                    key={item}
                    accessibilityRole="radio"
                    accessibilityLabel={`${statusLabel(item)} avatar`}
                    aria-checked={avatar === item}
                    onPress={() => setAvatar(item)}
                    style={{
                      padding: 7,
                      borderRadius: 24,
                      backgroundColor: avatar === item ? colors.sky : colors.canvas,
                    }}
                  >
                    <Mascot size={62} variant={item} />
                  </Pressable>
                ))}
              </View>
              <CheckRow
                label="Show background updates in chat"
                checked={showChatUpdates}
                onPress={() => setShowChatUpdates(!showChatUpdates)}
              />
              <Text style={s.small}>
                Activity and notifications always keep the full record, including requests for
                approval.
              </Text>
              <Button
                busy={busy}
                onPress={() => void save("/identity", { avatar, showChatUpdates })}
              >
                Save preferences
              </Button>
            </Card>
            <MemorySettings />
            <ErrorNotice error={error} />
          </View>
        </Sheet>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}

export function FileRecoveryPanel() {
  const { s } = useUI();

  const { api } = useWorkspace();
  const [snapshot, setSnapshot] = useState<FileRecoverySnapshot>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const requests = useRef(
    new Map<string, { requestId: string; expectedCurrentVersion: string | null }>(),
  );
  const load = async () => {
    try {
      setSnapshot(await api.request<FileRecoverySnapshot>("/api/computer/file-versions"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [api]);
  if (!snapshot?.versions.length && !error) return null;
  const restore = async (versionId: string, artifactId: string) => {
    setBusy(versionId);
    setError("");
    setMessage("");
    const prior = requests.current.get(versionId) ?? {
      requestId: Crypto.randomUUID(),
      expectedCurrentVersion:
        snapshot?.artifacts.find((value) => value.artifactId === artifactId)?.version ?? null,
    };
    requests.current.set(versionId, prior);
    try {
      const result = await api.request<{ path: string; restoredAsCopy: boolean }>(
        "/api/computer/file-versions/restore",
        { versionId, ...prior },
      );
      requests.current.delete(versionId);
      setMessage(
        result.restoredAsCopy
          ? `Recovered as a copy: ${result.path}. Your later edit is preserved.`
          : `Recovered: ${result.path}`,
      );
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Card style={{ gap: 12 }}>
      <SectionHeading title="Recover files" />
      <Text style={s.muted}>
        Versions saved by controlled file tools stay on their original computer for{" "}
        {snapshot?.policy.retentionDays ?? 30} days, within{" "}
        {Math.round((snapshot?.policy.maxVersionBytes ?? 2 * 1024 ** 3) / 1024 ** 3)} GiB. Shell and
        app edits need backups.
      </Text>
      <ErrorNotice error={error} />
      {message && <Text style={s.text}>{message}</Text>}
      {snapshot?.versions
        .slice(-20)
        .reverse()
        .map((version) => (
          <View key={version.id} style={{ gap: 8 }}>
            <Text selectable style={s.text}>
              {version.path}
              {version.trashed ? " · Trash" : " · Saved version"}
            </Text>
            <Text style={s.muted}>
              {new Date(version.createdAt * 1000).toLocaleString()} ·{" "}
              {Math.max(1, Math.ceil(version.size / 1024))} KB
            </Text>
            <Button
              small
              disabled={Boolean(busy)}
              onPress={() => void restore(version.id, version.artifactId)}
            >
              {busy === version.id ? "Recovering…" : "Recover this version"}
            </Button>
          </View>
        ))}
      <Button small onPress={() => void load()}>
        Refresh recovery history
      </Button>
    </Card>
  );
}
