import { Brain, Heart, X } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { MemorySettings } from "./memory-settings";
import { ProfileSettings } from "./profile-settings";
import { IconButton, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function AgentDocument({
  kind,
  embedded = false,
}: {
  kind: "agent-soul" | "agent-memory";
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const { api, close } = useWorkspace();
  const { colors, s } = useUI();
  const soul = kind === "agent-soul";
  const title = soul ? "SOUL" : "MEMORY";
  const Icon = soul ? Heart : Brain;
  const content = (
    <View
      style={{ width: "100%", maxWidth: 820, alignSelf: "center", paddingVertical: 22, gap: 22 }}
    >
      <View
        style={{
          borderLeftWidth: 3,
          borderLeftColor: soul ? colors.soul : colors.memory,
          paddingLeft: 18,
          marginHorizontal: 20,
          gap: 6,
        }}
      >
        <Text style={[s.heading, { fontSize: 20 }]}>
          {t(soul ? "Your assistant's personality" : "What your assistant remembers")}
        </Text>
        <Text style={s.muted}>
          {t(
            soul
              ? "This shapes how your assistant speaks and behaves. Edit the personality below; your saved preferences apply to conversations."
              : "Facts and preferences kept from your conversations. You can correct a memory, add one, or ask your assistant to forget it. Changes have a history.",
          )}
        </Text>
      </View>
      {soul ? (
        <ProfileSettings key={api.identityKey} document />
      ) : (
        <MemorySettings key={api.identityKey} document />
      )}
    </View>
  );
  if (!embedded)
    return (
      <Sheet title={title} subtitle={t(soul ? "Personality" : "Memory")} onClose={close}>
        {content}
      </Sheet>
    );
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.canvas }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 28,
          paddingVertical: 17,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
          gap: 12,
        }}
      >
        <Icon size={21} color={soul ? colors.soul : colors.memory} />
        <Text style={[s.heading, { flex: 1, fontSize: 19 }]}>{title}</Text>
        <IconButton icon={X} label={t("Close editor")} onPress={close} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 28, paddingBottom: 50 }}
      >
        {content}
      </ScrollView>
    </View>
  );
}
