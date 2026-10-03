import { ChevronRight, FileText, ListChecks, Mail, Search, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { colors, IconButton, ModalSurface, s } from "./ui";
import { useWorkspace } from "./workspace";

export function WorkspaceSearch({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { workspace, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const results = [
    ...(data?.tasks ?? []).map((task) => ({
      id: `task:${task.id}`,
      title: task.title,
      detail: task.result || task.input || "",
      type: "Activity",
      icon: ListChecks,
      show: () => open({ type: "task", taskId: task.id }),
    })),
    ...workspace.files.map((file) => ({
      id: `file:${file.id}`,
      title: file.name,
      detail: file.mimeType,
      type: "Library",
      icon: FileText,
      show: () => open({ type: "file", file }),
    })),
    ...workspace.mail.map((mail) => ({
      id: `mail:${mail.id}`,
      title: mail.subject,
      detail: mail.body,
      type: "Mail",
      icon: Mail,
      show: () => open({ type: "mail", mail }),
    })),
  ]
    .filter(
      (item) => !needle || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(needle),
    )
    .slice(0, 30);
  return (
    <ModalSurface label={t("Search")} onClose={onClose} width={680} height={540}>
      <View
        style={[
          s.row,
          {
            paddingHorizontal: 22,
            paddingVertical: 14,
            gap: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          },
        ]}
      >
        <Search size={22} color={colors.muted} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          accessibilityLabel={t("Search your workspace")}
          placeholder={t("Search your workspace")}
          placeholderTextColor={colors.muted}
          style={{ flex: 1, minWidth: 0, fontSize: 17, color: colors.text, paddingVertical: 10 }}
        />
        <IconButton icon={X} label={t("Close search")} onPress={onClose} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 14 }}>
        <Text style={[s.small, { padding: 10 }]}>{t(needle ? "Search results" : "Recent")}</Text>
        {results.map(({ id, title, type, icon: Icon, show }) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              show();
            }}
            style={({ pressed }) => [
              s.row,
              {
                gap: 14,
                padding: 12,
                borderRadius: 14,
                backgroundColor: pressed ? "#EEEFF0" : "transparent",
              },
            ]}
          >
            <View style={[s.iconBox, { width: 36, height: 36, backgroundColor: "#EEEEF0" }]}>
              <Icon size={19} color={colors.muted} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text numberOfLines={1} style={s.text}>
                {title}
              </Text>
              <Text style={s.small}>{t(type)}</Text>
            </View>
            <ChevronRight size={16} color={colors.muted} />
          </Pressable>
        ))}
        {!results.length && (
          <Text style={[s.muted, { textAlign: "center", padding: 32 }]}>
            {t("No results found.")}
          </Text>
        )}
      </ScrollView>
    </ModalSurface>
  );
}
