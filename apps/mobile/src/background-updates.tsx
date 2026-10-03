import { Bell, ChevronRight, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function BackgroundUpdates() {
  const { t } = useI18n();
  const { data, mutate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const updates = data?.notifications.filter((item) => !item.read) || [];
  const update = updates[0];
  if (!update || data?.identity.showChatUpdates === false) return null;
  async function dismiss() {
    if (!update) return;
    setBusy(true);
    try {
      await mutate(`/notifications/${update.id}/read`, {});
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 4 }}>
      <View
        style={[
          s.row,
          {
            backgroundColor: "#F1F5F8",
            borderRadius: 17,
            paddingLeft: 12,
            paddingRight: 5,
            gap: 4,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t(update.taskId ? "View task" : "Updates")}: ${update.title}`}
          onPress={() =>
            open(
              update.taskId ? { type: "task", taskId: update.taskId } : { type: "notifications" },
            )
          }
          style={[s.row, { flex: 1, minHeight: 46, gap: 9 }]}
        >
          <Bell size={16} color={colors.blueDark} strokeWidth={1.6} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 13 }}>
            {update.title}
          </Text>
          <ChevronRight size={16} color={colors.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Dismiss background update")}
          disabled={busy}
          onPress={() => void dismiss()}
          hitSlop={10}
          style={{ padding: 8 }}
        >
          <X size={16} color={colors.muted} />
        </Pressable>
      </View>
      {updates.length > 1 && (
        <Pressable
          accessibilityRole="button"
          onPress={() => open({ type: "notifications" })}
          style={{ paddingHorizontal: 12, paddingVertical: 4, alignSelf: "flex-start" }}
        >
          <Text style={s.small}>{t("{count} more updates", { count: updates.length - 1 })}</Text>
        </Pressable>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
