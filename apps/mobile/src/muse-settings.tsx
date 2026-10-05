import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Fingerprint,
  Globe2,
  LayoutGrid,
  type LucideIcon,
  Moon,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { AppInstall } from "./app-install";
import { AvatarStudio } from "./avatar-studio";
import { AppLanguagePicker, AssistantChatPreferences } from "./desktop-shell";
import { useI18n } from "./i18n";
import { MemorySettings } from "./memory-settings";
import { ModelSettings } from "./model-settings";
import { NativePushSettings } from "./native-push-settings";
import { ProactivitySettings } from "./proactivity-settings";
import { ProfileSettings } from "./profile-settings";
import { ConnectionsScreen } from "./screens";
import { ThemePicker } from "./theme-picker";
import { Button, IconButton, Mascot, ModalSurface, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

const sections: { id: string; title: string; icon: LucideIcon }[] = [
  { id: "general", title: "General", icon: Settings2 },
  { id: "appearance", title: "App theme", icon: Moon },
  { id: "models", title: "Models", icon: Cpu },
  { id: "connectors", title: "Connectors", icon: LayoutGrid },
  { id: "personality", title: "Personalization", icon: Sparkles },
  { id: "permissions", title: "Permissions", icon: ShieldCheck },
  { id: "memory", title: "Memory", icon: Fingerprint },
  { id: "proactivity", title: "Proactivity", icon: Bell },
  { id: "notifications", title: "Notifications", icon: Bell },
];

export function SettingsDialog({
  onClose,
  onCustomize,
}: {
  onClose: () => void;
  onCustomize: () => void;
}) {
  const { colors, s } = useUI();

  const { width } = useWindowDimensions();
  const { t, locale } = useI18n();
  const { data } = useAgentWorkspace();
  const { workspace, open } = useWorkspace();
  const compact = width < 700;
  const [section, setSection] = useState("general");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const current = sections.find((item) => item.id === section) ?? sections[0];
  const actions = workspace.actions.filter((item) => item.status === "awaiting_review");
  function showNotifications() {
    onClose();
    open({ type: "notifications" });
  }
  return (
    <ModalSurface
      label={t("Settings")}
      onClose={onClose}
      onBack={compact && mobileDetail ? () => setMobileDetail(false) : onClose}
      width={840}
      height={680}
    >
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
        {(!compact || !mobileDetail) && (
          <View
            style={{
              width: compact ? "100%" : 212,
              borderRightWidth: compact ? 0 : 1,
              borderRightColor: colors.line,
              paddingHorizontal: 14,
              paddingTop: 18,
            }}
          >
            <View style={[s.between, { paddingHorizontal: 8, marginBottom: 17, minHeight: 36 }]}>
              <Text style={[s.heading, { fontSize: 17 }]}>{t("Settings")}</Text>
              {compact && <IconButton icon={X} label={t("Close settings")} onPress={onClose} />}
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {sections.map(({ id, title, icon: Icon }) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  aria-selected={section === id}
                  onPress={() => {
                    setSection(id);
                    setMobileDetail(true);
                  }}
                  style={({ pressed }) => [
                    s.row,
                    {
                      gap: 12,
                      minHeight: compact ? 52 : 38,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      marginBottom: 2,
                      backgroundColor:
                        section === id && !compact
                          ? colors.selected
                          : pressed
                            ? colors.subtle
                            : "transparent",
                    },
                  ]}
                >
                  <Icon
                    size={17}
                    strokeWidth={1.6}
                    color={section === id ? colors.selectedText : colors.text}
                  />
                  <Text
                    style={{
                      color: section === id ? colors.selectedText : colors.text,
                      fontSize: 14,
                      flex: 1,
                      fontWeight: section === id ? "600" : "400",
                    }}
                  >
                    {t(title)}
                  </Text>
                  {!compact && section === id && <Check size={15} color={colors.selectedText} />}
                  {compact && <ChevronRight size={16} color={colors.muted} />}
                </Pressable>
              ))}
              <View style={{ padding: 10 }}>
                <AppInstall compact />
              </View>
            </ScrollView>
          </View>
        )}
        {(!compact || mobileDetail) && (
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <View
              style={[
                s.between,
                { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 10, gap: 12 },
              ]}
            >
              {compact && (
                <IconButton
                  icon={ChevronLeft}
                  label={t("Back to settings")}
                  onPress={() => setMobileDetail(false)}
                />
              )}
              <Text style={[s.heading, { fontSize: 17, flex: 1 }]}>{t(current.title)}</Text>
              <IconButton icon={X} label={t("Close settings")} onPress={onClose} />
            </View>
            {section === "personality" ? (
              <ProfileSettings contained />
            ) : (
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: 22,
                  paddingBottom: 26,
                  paddingTop: 4,
                  gap: 24,
                }}
              >
                {section === "proactivity" && <ProactivitySettings />}
                {section === "general" && (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      onPress={onCustomize}
                      style={[
                        s.row,
                        { gap: 13, padding: 14, backgroundColor: colors.subtle, borderRadius: 18 },
                      ]}
                    >
                      <View style={{ width: 44, height: 44, borderRadius: 22, overflow: "hidden" }}>
                        <Mascot size={44} framing="portrait" />
                      </View>
                      <View style={{ flex: 1, gap: 3 }}>
                        <Text style={[s.text, { fontWeight: "500" }]}>
                          {data?.identity.name || "OkamiBot"}
                        </Text>
                        <Text style={s.small}>{t("Customize your companion")}</Text>
                      </View>
                      <ChevronRight size={16} color={colors.muted} />
                    </Pressable>
                    <View
                      style={{
                        borderRadius: 18,
                        backgroundColor: colors.subtle,
                        overflow: "hidden",
                      }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("App language")}
                        aria-expanded={languageOpen}
                        onPress={() => setLanguageOpen(!languageOpen)}
                        style={[s.row, { padding: 16, gap: 12, minHeight: 56 }]}
                      >
                        <Globe2 size={18} color={colors.muted} />
                        <Text style={[s.text, { flex: 1 }]}>{t("Language")}</Text>
                        <Text style={s.muted}>{locale === "pt-BR" ? "Português" : "English"}</Text>
                        <ChevronRight size={16} color={colors.muted} />
                      </Pressable>
                      {languageOpen && (
                        <View
                          style={{ padding: 16, borderTopWidth: 1, borderTopColor: colors.line }}
                        >
                          <AppLanguagePicker />
                        </View>
                      )}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setSection("models")}
                      style={[
                        s.row,
                        { padding: 16, gap: 12, backgroundColor: colors.subtle, borderRadius: 18 },
                      ]}
                    >
                      <Cpu size={18} color={colors.muted} />
                      <Text style={[s.text, { flex: 1 }]}>{t("Conversation model")}</Text>
                      <ChevronRight size={16} color={colors.muted} />
                    </Pressable>
                    <AssistantChatPreferences />
                  </>
                )}
                {section === "models" && <ModelSettings />}
                {section === "appearance" && <ThemePicker />}
                {section === "connectors" && <ConnectionsScreen />}
                {section === "memory" && <MemorySettings />}
                {section === "notifications" && (
                  <>
                    <NativePushSettings />
                    <Button icon={Bell} onPress={showNotifications}>
                      {t("Open notifications")}
                    </Button>
                  </>
                )}
                {section === "permissions" && (
                  <>
                    <Text style={s.muted}>
                      {t("Review requests before your assistant takes an action on your behalf.")}
                    </Text>
                    <Text style={s.heading}>{t("Needs review")}</Text>
                    {actions.length === 0 && (
                      <Text style={s.muted}>{t("Nothing needs your approval right now.")}</Text>
                    )}
                    {actions.map((action) => (
                      <Pressable
                        key={action.id}
                        accessibilityRole="button"
                        onPress={() => {
                          onClose();
                          open({ type: "review", action });
                        }}
                        style={[
                          s.row,
                          {
                            padding: 16,
                            gap: 12,
                            backgroundColor: colors.subtle,
                            borderRadius: 16,
                          },
                        ]}
                      >
                        <ShieldCheck size={20} color={colors.muted} />
                        <Text style={[s.text, { flex: 1 }]}>{action.title}</Text>
                        <ChevronRight size={16} color={colors.muted} />
                      </Pressable>
                    ))}
                    <Text style={s.heading}>{t("Approvals history")}</Text>
                    {workspace.actions
                      .filter((action) => action.status !== "awaiting_review")
                      .map((action) => (
                        <Pressable
                          key={action.id}
                          accessibilityRole="button"
                          onPress={() => {
                            onClose();
                            open({ type: "review", action });
                          }}
                          style={{
                            paddingVertical: 10,
                            gap: 4,
                            borderBottomWidth: 1,
                            borderBottomColor: colors.line,
                          }}
                        >
                          <Text style={s.text}>{action.title}</Text>
                          <Text style={s.small}>{action.result || t(action.status)}</Text>
                        </Pressable>
                      ))}
                  </>
                )}
              </ScrollView>
            )}
          </View>
        )}
      </View>
    </ModalSurface>
  );
}

export function CompanionDialog({ onClose }: { onClose: () => void }) {
  const { colors } = useUI();

  const { t } = useI18n();
  const [tab, setTab] = useState("appearance");
  return (
    <Sheet
      title={t("Customize your companion")}
      onClose={onClose}
      wide
      scroll={tab !== "personality"}
      contentStyle={
        tab === "personality"
          ? { paddingHorizontal: 0, paddingBottom: 0, paddingTop: 16 }
          : { paddingTop: 16 }
      }
    >
      <View
        style={{
          alignSelf: "center",
          flexDirection: "row",
          backgroundColor: colors.subtle,
          padding: 4,
          borderRadius: 24,
          marginBottom: 22,
        }}
      >
        {[
          ["appearance", "Appearance"],
          ["personality", "Personality"],
        ].map(([id, label]) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            aria-selected={tab === id}
            onPress={() => setTab(id)}
            style={{
              paddingHorizontal: 24,
              paddingVertical: 9,
              borderRadius: 20,
              backgroundColor: tab === id ? colors.card : "transparent",
            }}
          >
            <Text style={{ color: colors.text, fontSize: 14 }}>{t(label)}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "appearance" ? <AvatarStudio embedded /> : <ProfileSettings contained />}
    </Sheet>
  );
}
