import { Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, ModalSurface, useUI } from "./ui";

export function TaskRemoveButton({ task, onRemoved }: { task: AgentTask; onRemoved?: () => void }) {
  return <Removal task={task} onRemoved={onRemoved} />;
}
export function ClearFinishedTasksButton() {
  const { data } = useAgentWorkspace();
  if (!data?.tasks.some((task) => ["succeeded", "failed", "cancelled"].includes(task.status)))
    return null;
  return <Removal />;
}
function Removal({ task, onRemoved }: { task?: AgentTask; onRemoved?: () => void }) {
  const { colors, s } = useUI(),
    { t } = useI18n(),
    { mutate } = useAgentWorkspace();
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = task && !["succeeded", "failed", "cancelled"].includes(task.status);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await mutate(
        task ? `/tasks/${task.id}/remove` : "/tasks/clear-finished",
        task ? { cancelActive: Boolean(active) } : {},
      );
      setVisible(false);
      onRemoved?.();
    } catch (cause) {
      setError(t(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  }
  const title = task
    ? active
      ? "Stop and remove task?"
      : "Remove task?"
    : "Clear finished tasks?";
  return (
    <>
      {task ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Remove task: {title}", { title: task.title })}
          onPress={(event) => {
            event.stopPropagation();
            setError("");
            setVisible(true);
          }}
          style={{
            width: 36,
            minHeight: 40,
            alignItems: "center",
            justifyContent: "center",
            alignSelf: "flex-start",
          }}
        >
          <Trash2 size={16} color={colors.muted} />
        </Pressable>
      ) : (
        <Button
          small
          icon={Trash2}
          onPress={() => {
            setError("");
            setVisible(true);
          }}
        >
          {t("Clear finished")}
        </Button>
      )}
      {visible && (
        <ModalSurface
          label={t(title)}
          onClose={() => {
            if (!busy) setVisible(false);
          }}
          width={460}
        >
          <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
            <Text style={s.title}>{t(title)}</Text>
            {task && <Text style={s.muted}>{task.title}</Text>}
            <Text style={s.text}>
              {t(
                active
                  ? "This task will stop and leave your activity list. Saved files remain available."
                  : task
                    ? "This task will leave your activity list. Saved files remain available."
                    : "Completed, failed and cancelled tasks will leave your activity list. Active tasks and saved files remain available.",
              )}
            </Text>
            <ErrorNotice error={error} />
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <Button disabled={busy} onPress={() => setVisible(false)}>
                {t("Cancel")}
              </Button>
              <Button danger busy={busy} onPress={() => void remove()}>
                {t(active ? "Stop and remove" : "Remove")}
              </Button>
            </View>
          </ScrollView>
        </ModalSurface>
      )}
    </>
  );
}
