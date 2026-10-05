import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clock3,
  Hourglass,
  PauseCircle,
} from "lucide-react-native";
import { ActivityIndicator, Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { useI18n } from "./i18n";
import { useUI } from "./ui";

export function TaskStatusBadge({
  task,
  iconOnly = false,
}: {
  task: AgentTask;
  iconOnly?: boolean;
}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const running = task.status === "running" || task.status === "waiting_job";
  const completed = task.status === "succeeded";
  const failed = task.status === "failed";
  const cancelled = task.status === "cancelled";
  const paused = ["paused", "waiting_global_pause"].includes(task.status);
  const queued = ["queued", "scheduled"].includes(task.status);
  const color = completed
    ? colors.success
    : failed
      ? colors.danger
      : running
        ? colors.blueDark
        : cancelled
          ? colors.muted
          : colors.warning;
  const backgroundColor = completed
    ? colors.green
    : failed
      ? colors.dangerSurface
      : running
        ? colors.sky
        : cancelled
          ? colors.subtle
          : colors.orange;
  const Icon = completed
    ? CheckCircle2
    : failed
      ? CircleAlert
      : cancelled
        ? CircleX
        : paused
          ? PauseCircle
          : queued
            ? Clock3
            : Hourglass;
  const label = completed
    ? "Completed"
    : failed
      ? task.completion?.status === "partial"
        ? "Partial delivery"
        : "Not completed"
      : cancelled
        ? "Cancelled"
        : paused
          ? "Paused"
          : running
            ? "In progress"
            : queued
              ? task.status === "queued"
                ? "Queued"
                : "Scheduled"
              : task.status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <View
      accessibilityLabel={t(label)}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 8,
        paddingHorizontal: 7,
        paddingVertical: 5,
        backgroundColor,
      }}
    >
      {running ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Icon size={iconOnly ? 19 : 14} color={color} />
      )}
      {!iconOnly && <Text style={[s.small, { color, fontWeight: "600" }]}>{t(label)}</Text>}
    </View>
  );
}
