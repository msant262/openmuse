import { useThreads } from "@copilotkit/react-native/headless";
import {
  Bell,
  ChevronRight,
  Lightbulb,
  type LucideIcon,
  MessageCircle,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Settings2,
  Shapes,
  Sparkles,
  SquareCheck,
} from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { Section } from "../../../packages/domain/src";
import { useAgentWorkspace } from "./agent-workspace";
import { useAvatarPresentation } from "./avatar-presentation";
import { AvatarThumbnail } from "./avatar-thumbnail";
import { ComputerEntry } from "./computer";
import { cachedConversationTitle, isEmptyConversationCache } from "./conversation-label";
import { desktopStyles as d } from "./desktop-shell-styles";
import { useI18n } from "./i18n";
import { MemorySettings } from "./memory-settings";
import { messageStorage } from "./message-storage";
import { ProfileSettings } from "./profile-settings";
import { type Selection, useMuseThread } from "./threads";
import { Button, Card, CheckRow, colors, ErrorNotice, IconButton, Mascot, s } from "./ui";
import { useWorkspace } from "./workspace";

// Kept together so the workspace language catalog can translate the desktop shell.
export const desktopCopy = {
  chat: "Chat",
  activity: "Activity",
  ideas: "Ideas",
  goals: "Goals",
  apps: "Apps & connections",
  settings: "Settings",
  workspace: "Your personal assistant",
  newConversation: "New conversation",
  conversations: "Conversations",
  conversationMenu: "Open conversations and menu",
  mainChat: "Main chat",
  untitledConversation: "Untitled conversation",
  newConversationTitle: "New conversation",
  customize: "Customize bot",
  customizeCaption: "A name, personality and look that feel right for you.",
  settingsTitle: "Make yourself at home",
  settingsSubtitle: "Choose your assistant’s name, personality, language and appearance.",
  appearance: "Appearance",
  appearanceSubtitle: "Choose the face you’ll see around your workspace.",
  skyAvatar: "Sky avatar",
  sandAvatar: "Sand avatar",
  lilacAvatar: "Lilac avatar",
  saveAppearance: "Save appearance",
  appearanceSaved: "Appearance saved.",
  chatPreferences: "Chat preferences",
  backgroundUpdates: "Show background updates in chat",
  backgroundUpdatesHint: "Activity and notifications always keep the full record.",
  savePreferences: "Save preferences",
  preferencesSaved: "Preferences saved.",
  appLanguage: "App language",
  appLanguageHint: "Choose the language for menus and controls.",
  languageSaveError: "App language could not be saved. Please try again.",
  notifications: "Notifications, {pending} unread or pending",
  openConversation: "Open conversation: {name}",
};

const desktopNavigation: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: desktopCopy.chat, icon: MessageCircle },
  { id: "activity", label: desktopCopy.activity, icon: PanelsTopLeft },
  { id: "ideas", label: desktopCopy.ideas, icon: Lightbulb },
  { id: "goals", label: desktopCopy.goals, icon: SquareCheck },
  { id: "apps", label: desktopCopy.apps, icon: Shapes },
];

function SidebarItem({
  label,
  icon: Icon,
  active,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        d.navItem,
        hovered && { backgroundColor: "#ECF0F5" },
        active && d.activeItem,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon size={18} strokeWidth={1.8} color={active ? "#205C91" : "#78848F"} />
      <Text style={[d.navLabel, active && d.activeLabel]}>{label}</Text>
    </Pressable>
  );
}

export function DesktopShell({
  children,
  desktop = true,
  mobileHeader,
  mobileNavigation,
  title,
  subtitle,
  settingsOpen,
  onSettings,
  onNavigate,
  onThreads,
  pending,
}: {
  children: ReactNode;
  desktop?: boolean;
  mobileHeader?: ReactNode;
  mobileNavigation?: ReactNode;
  title: string;
  subtitle: string;
  settingsOpen: boolean;
  onSettings: () => void;
  onNavigate: (section: Section) => void;
  onThreads: () => void;
  pending: number;
}) {
  const { t, locale } = useI18n();
  const { api, workspace, section, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const { state: companionState } = useAvatarPresentation();
  const { selection, visited, mainId, enabled, loading, select, start } = useMuseThread();
  const threads = useThreads({
    agentId: "default",
    enabled: desktop && enabled,
    includeArchived: false,
    limit: 8,
  });
  const utility = ["mail", "calendar", "browser", "files", "connections"].includes(section);
  const agentName = data?.identity.name || "OkamiBot";
  const saved = threads.threads.filter((thread) => thread.id !== mainId && !thread.archived);
  const drafts = visited.filter(
    (thread) => thread.id !== mainId && !threads.threads.some((item) => item.id === thread.id),
  );
  const identityKey = api.identityKey;
  const [labels, setLabels] = useState<{
    identityKey: string;
    values: Record<string, string>;
    emptyDrafts: string[];
  }>();
  const labelsKey = JSON.stringify(
    [
      ...drafts.map((thread) => [thread.id, thread.existing]),
      ...saved.map((thread) => [thread.id, thread.lastRunAt ?? thread.updatedAt]),
    ].slice(0, 8),
  );
  useEffect(() => {
    if (!desktop || !enabled) return;
    let current = true;
    const entries = JSON.parse(labelsKey) as [string, unknown][];
    void Promise.all(
      entries.map(async ([id]) => {
        const raw = await messageStorage.read(`${identityKey}\n${id}`).catch(() => null);
        return { id, title: cachedConversationTitle(raw), empty: isEmptyConversationCache(raw) };
      }),
    ).then((values) => {
      if (current && api.identityKey === identityKey)
        setLabels({
          identityKey,
          values: Object.fromEntries(
            values.flatMap((item) => (item.title ? [[item.id, item.title]] : [])),
          ),
          emptyDrafts: values.filter((item) => item.empty).map((item) => item.id),
        });
    });
    return () => {
      current = false;
    };
  }, [api, desktop, enabled, identityKey, labelsKey, selection.id]);
  const localLabels = labels?.identityKey === identityKey ? labels.values : {};
  const emptyDrafts = labels?.identityKey === identityKey ? labels.emptyDrafts : [];
  const chatOpen = !settingsOpen && section === "chat";
  const companionStatus =
    companionState === "talking"
      ? t("Writing to you…")
      : companionState === "thinking" && subtitle === t("Here when you need me")
        ? t("Thinking it through…")
        : subtitle;
  function openThread(next: Selection) {
    onNavigate("chat");
    select(next);
  }
  return (
    <View style={desktop ? d.shell : { flex: 1, minHeight: 0 }}>
      {desktop && (
        <ScrollView
          testID="desktop-sidebar"
          style={{ width: 240, flexGrow: 0, flexShrink: 0, backgroundColor: "#F5F7FA" }}
          contentContainerStyle={[d.sidebar, { flexGrow: 1, gap: 14 }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={d.brand}>
            <AvatarThumbnail
              size={36}
              species={data?.identity.avatarDesign?.species ?? "capybara"}
            />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={d.brandName}>
                {agentName}
              </Text>
              <Text style={d.brandCaption}>{t(desktopCopy.workspace)}</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(desktopCopy.newConversation)}
            accessibilityState={{ disabled: enabled && loading }}
            disabled={enabled && loading}
            onPress={() => {
              if (!enabled) return onThreads();
              onNavigate("chat");
              start();
            }}
            style={({ pressed }) => [d.newChat, (pressed || loading) && { opacity: 0.75 }]}
          >
            <Plus size={17} color="#344A5D" />
            <Text style={d.newChatText}>{t(desktopCopy.newConversation)}</Text>
          </Pressable>
          <View style={d.navigation}>
            {desktopNavigation.map((item) => (
              <SidebarItem
                key={item.id}
                label={t(item.label)}
                icon={item.icon}
                active={!settingsOpen && (section === item.id || (item.id === "apps" && utility))}
                onPress={() => {
                  if (item.id === "chat" && enabled && !loading)
                    openThread({ id: mainId, existing: true });
                  else onNavigate(item.id);
                }}
              />
            ))}
            <SidebarItem
              label={t(desktopCopy.settings)}
              icon={Settings2}
              active={settingsOpen}
              onPress={onSettings}
            />
          </View>
          <View style={d.divider} />
          <View style={[d.conversations, { minHeight: 126 }]}>
            <View style={d.conversationHeading}>
              <Text style={d.sectionLabel}>{t(desktopCopy.conversations)}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(desktopCopy.conversationMenu)}
                onPress={onThreads}
                style={({ pressed }) => [d.menuButton, pressed && { backgroundColor: "#E4E9EF" }]}
              >
                <MoreHorizontal size={18} color="#78848F" />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 280 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(desktopCopy.mainChat)}
                onPress={() =>
                  enabled ? openThread({ id: mainId, existing: true }) : onNavigate("chat")
                }
                style={[
                  d.navItem,
                  d.conversationItem,
                  !settingsOpen && section === "chat" && selection.id === mainId && d.activeItem,
                ]}
              >
                <MessageCircle size={14} color="#78848F" />
                <Text style={d.conversationLabel}>{t(desktopCopy.mainChat)}</Text>
              </Pressable>
              {loading && <ActivityIndicator color={colors.blueDark} style={{ marginTop: 10 }} />}
              {[
                ...drafts
                  .filter(
                    (thread) =>
                      thread.existing ||
                      thread.id === selection.id ||
                      !emptyDrafts.includes(thread.id),
                  )
                  .map((thread, index) => ({
                    ...thread,
                    name:
                      localLabels[thread.id] ??
                      (thread.existing
                        ? t("Earlier conversation {number}", { number: index + 1 })
                        : t("Draft conversation {number}", { number: index + 1 })),
                    detail: thread.existing ? t("Saved conversation") : t("Draft"),
                  })),
                ...saved.map((thread, index) => ({
                  ...thread,
                  existing: true,
                  name:
                    thread.name ||
                    localLabels[thread.id] ||
                    t("Conversation {number}", { number: index + 1 }),
                  detail: Number.isFinite(new Date(thread.lastRunAt ?? thread.updatedAt).getTime())
                    ? new Date(thread.lastRunAt ?? thread.updatedAt).toLocaleDateString(
                        locale === "pt-BR" ? "pt-BR" : "en-US",
                        { month: "short", day: "numeric" },
                      )
                    : t("Saved conversation"),
                })),
              ]
                .slice(0, 8)
                .map((thread) => (
                  <Pressable
                    key={thread.id}
                    accessibilityRole="button"
                    accessibilityLabel={t(desktopCopy.openConversation, { name: thread.name })}
                    accessibilityState={{ selected: !settingsOpen && selection.id === thread.id }}
                    onPress={() => openThread({ id: thread.id, existing: thread.existing })}
                    style={[
                      d.navItem,
                      d.conversationItem,
                      !settingsOpen && selection.id === thread.id && d.activeItem,
                    ]}
                  >
                    <MessageCircle size={14} color="#78848F" />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text numberOfLines={1} style={d.conversationLabel}>
                        {thread.name}
                      </Text>
                      <Text style={{ color: "#92999E", fontSize: 10 }}>{thread.detail}</Text>
                    </View>
                  </Pressable>
                ))}
            </ScrollView>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(desktopCopy.customize)}
            onPress={onSettings}
            style={({ pressed }) => [d.customize, pressed && { opacity: 0.75 }]}
          >
            <Text style={d.customizeCaption}>{t(desktopCopy.customizeCaption)}</Text>
            <View style={d.customizeAction}>
              <Sparkles size={15} color="#205C91" />
              <Text style={d.customizeLabel}>{t(desktopCopy.customize)}</Text>
              <ChevronRight size={14} color="#205C91" style={{ marginLeft: "auto" }} />
            </View>
          </Pressable>
          <Text numberOfLines={1} style={[s.small, { paddingHorizontal: 8 }]}>
            {workspace.mode === "sample" ? "OkamiBot" : workspace.profile.name}
          </Text>
        </ScrollView>
      )}
      <View
        key="workspace-main"
        style={
          desktop
            ? d.main
            : { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center", minHeight: 0 }
        }
      >
        {desktop ? (
          <View style={[d.header, chatOpen && d.chatHeader]}>
            {chatOpen ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Open {name} activity and approvals", { name: agentName })}
                onPress={() => onNavigate("activity")}
                style={d.companionHeading}
              >
                <Mascot size={72} variant={data?.identity.avatar} />
                <View style={d.companionName}>
                  <Text numberOfLines={1} style={d.headerTitle}>
                    {title}
                  </Text>
                  <Text numberOfLines={1} style={d.companionStatus}>
                    {companionStatus}
                  </Text>
                </View>
              </Pressable>
            ) : (
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={d.headerTitle}>
                  {title}
                </Text>
                <Text numberOfLines={1} style={d.headerSubtitle}>
                  {subtitle}
                </Text>
              </View>
            )}
            <View style={[d.headerActions, chatOpen && d.chatHeaderActions]}>
              <ComputerEntry />
              <View style={d.notification}>
                <IconButton
                  icon={Bell}
                  label={t(desktopCopy.notifications, { pending })}
                  onPress={() => open({ type: "notifications" })}
                />
                {pending > 0 && <View pointerEvents="none" style={d.badge} />}
              </View>
            </View>
          </View>
        ) : (
          mobileHeader
        )}
        <View key="workspace-content" style={d.content}>
          {children}
        </View>
        {!desktop && mobileNavigation}
      </View>
    </View>
  );
}

/** Shared by sign-in and Settings so the saved interface language stays consistent. */
export function AppLanguagePicker({ compact = false }: { compact?: boolean } = {}) {
  const { width } = useWindowDimensions();
  const { locale, setLocale, t } = useI18n();
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState(false);
  async function chooseLanguage(next: "en" | "pt-BR") {
    setLanguageBusy(true);
    setLanguageError(false);
    try {
      await setLocale(next);
    } catch {
      setLanguageError(true);
    } finally {
      setLanguageBusy(false);
    }
  }
  const controls = (
    <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
      <Button
        small
        primary={locale === "en"}
        disabled={languageBusy}
        onPress={() => void chooseLanguage("en")}
      >
        {t("English")}
      </Button>
      <Button
        small
        primary={locale === "pt-BR"}
        disabled={languageBusy}
        onPress={() => void chooseLanguage("pt-BR")}
      >
        {t("Portuguese (Brazil)")}
      </Button>
    </View>
  );
  if (compact)
    return (
      <View style={{ alignItems: "flex-end", gap: 8, maxWidth: 320 }}>
        <Text style={s.small}>{t(desktopCopy.appLanguage)}</Text>
        {controls}
        <ErrorNotice error={languageError ? t(desktopCopy.languageSaveError) : ""} />
      </View>
    );
  return (
    <Card style={{ borderWidth: 1, borderColor: "#E9EDF2", gap: 10 }}>
      <View
        style={{
          flexDirection: width >= 1024 ? "row" : "column",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={s.heading}>{t(desktopCopy.appLanguage)}</Text>
          <Text style={s.small}>{t(desktopCopy.appLanguageHint)}</Text>
        </View>
        {controls}
      </View>
      <ErrorNotice error={languageError ? t(desktopCopy.languageSaveError) : ""} />
    </Card>
  );
}

/** The appearance slot can be replaced by the animated avatar creator. */
export function DesktopSettings({ appearance }: { appearance?: ReactNode } = {}) {
  return (
    <View style={{ gap: 24, width: "100%" }}>
      {appearance ?? <AssistantAppearance />}
      <ProfileSettings />
      <AppLanguagePicker />
      <AssistantChatPreferences />
      <MemorySettings />
    </View>
  );
}

function useIdentityPreferences() {
  const { data, mutate } = useAgentWorkspace();
  const { notify } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(body: Record<string, unknown>, notice: string) {
    setBusy(true);
    setError("");
    try {
      await mutate("/identity", body);
      notify(notice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return { data, busy, error, save };
}

export function AssistantAppearance() {
  const { t } = useI18n();
  const { data, busy, error, save } = useIdentityPreferences();
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  useEffect(() => setAvatar(data?.identity.avatar || "sky"), [data?.identity.avatar]);
  return (
    <View style={{ gap: 22 }}>
      <Card style={d.appearance}>
        <Text style={s.heading}>{t(desktopCopy.appearance)}</Text>
        <Text style={s.muted}>{t(desktopCopy.appearanceSubtitle)}</Text>
        <View style={{ alignItems: "center", paddingVertical: 8 }}>
          <Mascot size={82} variant={avatar} />
        </View>
        <View style={d.avatarOptions}>
          {(
            [
              { id: "sky", label: t(desktopCopy.skyAvatar) },
              { id: "sand", label: t(desktopCopy.sandAvatar) },
              { id: "lilac", label: t(desktopCopy.lilacAvatar) },
            ] as const
          ).map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="radio"
              accessibilityLabel={item.label}
              accessibilityState={{ checked: avatar === item.id }}
              disabled={busy}
              onPress={() => setAvatar(item.id)}
              style={[
                d.avatarOption,
                {
                  backgroundColor: avatar === item.id ? colors.sky : "#F7F8FA",
                  borderColor: avatar === item.id ? "#A6C9E8" : "transparent",
                },
              ]}
            >
              <Mascot size={44} variant={item.id} />
            </Pressable>
          ))}
        </View>
        <Button
          primary
          busy={busy}
          onPress={() => void save({ avatar }, t(desktopCopy.appearanceSaved))}
        >
          {t(desktopCopy.saveAppearance)}
        </Button>
      </Card>
      <ErrorNotice error={error} />
    </View>
  );
}

export function AssistantChatPreferences() {
  const { t } = useI18n();
  const { data, busy, error, save } = useIdentityPreferences();
  const [updates, setUpdates] = useState(data?.identity.showChatUpdates !== false);
  useEffect(
    () => setUpdates(data?.identity.showChatUpdates !== false),
    [data?.identity.showChatUpdates],
  );
  return (
    <View>
      <Card style={d.appearance}>
        <Text style={s.heading}>{t(desktopCopy.chatPreferences)}</Text>
        <CheckRow
          label={t(desktopCopy.backgroundUpdates)}
          checked={updates}
          onPress={() => setUpdates(!updates)}
        />
        <Text style={s.small}>{t(desktopCopy.backgroundUpdatesHint)}</Text>
        <Button
          busy={busy}
          onPress={() => void save({ showChatUpdates: updates }, t(desktopCopy.preferencesSaved))}
        >
          {t(desktopCopy.savePreferences)}
        </Button>
      </Card>
      <ErrorNotice error={error} />
    </View>
  );
}
