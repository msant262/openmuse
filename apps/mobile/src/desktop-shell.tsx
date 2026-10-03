import { useThreads } from "@copilotkit/react-native/headless";
import {
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Fingerprint,
  Lightbulb,
  List,
  type LucideIcon,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Pencil,
  Plus,
  Search,
  Settings2,
  Shapes,
  ShieldCheck,
  SquareCheck,
  X,
} from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { Section } from "../../../packages/domain/src";
import { useAgentWorkspace } from "./agent-workspace";
import { useAvatarPresentation } from "./avatar-presentation";
import { ComputerEntry } from "./computer";
import { cachedConversationTitle, isEmptyConversationCache } from "./conversation-label";
import { desktopStyles as d } from "./desktop-shell-styles";
import { useI18n } from "./i18n";
import { MemorySettings } from "./memory-settings";
import { messageStorage } from "./message-storage";
import { ProfileSettings } from "./profile-settings";
import { type Selection, useMuseThread } from "./threads";
import { Button, Card, CheckRow, colors, ErrorNotice, Mascot, s } from "./ui";
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
  { id: "files", label: "Library", icon: Shapes },
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
      {...(Platform.OS === "web" ? { title: label } : {})}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        d.railItem,
        hovered && { backgroundColor: "#F0F0F1" },
        active && d.activeItem,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon size={22} strokeWidth={1.7} color={active ? colors.text : "#737477"} />
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
  const { width } = useWindowDimensions();
  const [sideChatsOpen, setSideChatsOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [search, setSearch] = useState("");
  const { api, section, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const { state: companionState } = useAvatarPresentation();
  const { selection, visited, mainId, enabled, loading, select, start } = useMuseThread();
  const threads = useThreads({
    agentId: "default",
    enabled: desktop && enabled,
    includeArchived: false,
    limit: 8,
  });
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
  const conversationList = [
    ...drafts
      .filter(
        (thread) =>
          thread.existing || thread.id === selection.id || !emptyDrafts.includes(thread.id),
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
        thread.name || localLabels[thread.id] || t("Conversation {number}", { number: index + 1 }),
      detail: Number.isFinite(new Date(thread.lastRunAt ?? thread.updatedAt).getTime())
        ? new Date(thread.lastRunAt ?? thread.updatedAt).toLocaleDateString(
            locale === "pt-BR" ? "pt-BR" : "en-US",
            { month: "short", day: "numeric" },
          )
        : t("Saved conversation"),
    })),
  ].slice(0, 8);
  const sideChatsVisible = sideChatsOpen && width >= 1240 && chatOpen;
  function newSideChat() {
    if (!enabled) return onThreads();
    onNavigate("chat");
    start();
  }
  return (
    <View style={desktop ? d.shell : { flex: 1, minHeight: 0 }}>
      {desktop && (
        <>
          <View testID="desktop-sidebar" style={d.rail}>
            <View style={d.railNavigation}>
              {desktopNavigation.map((item) => (
                <SidebarItem
                  key={item.id}
                  label={t(item.label)}
                  icon={item.icon}
                  active={
                    !settingsOpen &&
                    (section === item.id || (item.id === "files" && section === "files"))
                  }
                  onPress={() => {
                    if (item.id === "chat" && enabled && !loading)
                      openThread({ id: mainId, existing: true });
                    else onNavigate(item.id);
                  }}
                />
              ))}
            </View>
            <View style={d.railUtilities}>
              <SidebarItem
                label={t(desktopCopy.apps)}
                icon={Settings2}
                active={!settingsOpen && section === "apps"}
                onPress={() => onNavigate("apps")}
              />
              <View style={d.notification}>
                <SidebarItem
                  label={t(desktopCopy.notifications, { pending })}
                  icon={Bell}
                  onPress={() => open({ type: "notifications" })}
                />
                {pending > 0 && <View pointerEvents="none" style={d.badge} />}
              </View>
              <SidebarItem
                label={t(desktopCopy.settings)}
                icon={Menu}
                active={settingsOpen}
                onPress={onSettings}
              />
            </View>
          </View>
          {sideChatsVisible && (
            <View testID="desktop-side-chats" style={d.sidebar}>
              <View style={d.sideChatToolbar}>
                <View style={d.search}>
                  <Search size={15} color={colors.muted} />
                  <TextInput
                    accessibilityLabel={
                      locale === "pt-BR" ? "Buscar conversas" : "Search conversations"
                    }
                    placeholder={locale === "pt-BR" ? "Buscar" : "Search"}
                    placeholderTextColor={colors.muted}
                    value={search}
                    onChangeText={setSearch}
                    style={d.searchInput}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(desktopCopy.conversationMenu)}
                  onPress={onThreads}
                  style={d.menuButton}
                >
                  <MoreHorizontal size={19} color={colors.muted} />
                </Pressable>
              </View>
              {conversationList.length ? (
                <ScrollView
                  style={d.conversations}
                  contentContainerStyle={{ paddingHorizontal: 10, paddingTop: 22, gap: 5 }}
                  showsVerticalScrollIndicator={false}
                >
                  <Text style={[d.sectionLabel, { marginHorizontal: 10, marginBottom: 8 }]}>
                    {t("Side chats")}
                  </Text>
                  {conversationList
                    .filter((thread) => thread.name.toLowerCase().includes(search.toLowerCase()))
                    .map((thread) => (
                      <Pressable
                        key={thread.id}
                        accessibilityRole="button"
                        accessibilityLabel={t(desktopCopy.openConversation, { name: thread.name })}
                        accessibilityState={{ selected: selection.id === thread.id }}
                        onPress={() => openThread({ id: thread.id, existing: thread.existing })}
                        style={[d.conversationItem, selection.id === thread.id && d.activeItem]}
                      >
                        <MessageCircle size={16} strokeWidth={1.7} color={colors.muted} />
                        <View style={{ flex: 1, gap: 4 }}>
                          <Text numberOfLines={1} style={d.conversationLabel}>
                            {thread.name}
                          </Text>
                          <Text style={d.conversationDate}>{thread.detail}</Text>
                        </View>
                      </Pressable>
                    ))}
                </ScrollView>
              ) : (
                <View style={d.sideChatEmpty}>
                  <MessageCircle size={27} strokeWidth={1.5} color="#929297" />
                  <Text style={d.sideChatEmptyTitle}>
                    {locale === "pt-BR" ? "Comece uma conversa separada" : "Start a side chat"}
                  </Text>
                  <Text style={d.sideChatEmptyCopy}>
                    {locale === "pt-BR"
                      ? "Conversas separadas são uma forma opcional de organizar seus assuntos."
                      : "Side chats are an optional way to organize your conversations by topic."}
                  </Text>
                  <Button small disabled={enabled && loading} onPress={newSideChat}>
                    {t("New side chat")}
                  </Button>
                </View>
              )}
              {!!conversationList.length && (
                <View style={{ padding: 16 }}>
                  <Button small icon={Plus} disabled={enabled && loading} onPress={newSideChat}>
                    {t("New side chat")}
                  </Button>
                </View>
              )}
              {loading && <ActivityIndicator color={colors.muted} style={{ marginBottom: 20 }} />}
            </View>
          )}
        </>
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
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(desktopCopy.conversationMenu)}
                  accessibilityState={{ expanded: sideChatsVisible }}
                  onPress={() => (width >= 1240 ? setSideChatsOpen(!sideChatsOpen) : onThreads())}
                  style={d.menuButton}
                >
                  {sideChatsVisible ? (
                    <PanelLeftClose size={19} color={colors.muted} />
                  ) : (
                    <PanelLeftOpen size={19} color={colors.muted} />
                  )}
                </Pressable>
                <View style={d.headerActions}>
                  <ComputerEntry />
                  {!inspectorOpen && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("Open {name} activity and approvals", {
                        name: agentName,
                      })}
                      onPress={() => setInspectorOpen(true)}
                    >
                      <Mascot size={38} variant={data?.identity.avatar} />
                    </Pressable>
                  )}
                </View>
              </>
            ) : (
              <>
                <View accessibilityLabel={title} style={{ flex: 1 }} />
                <ComputerEntry />
              </>
            )}
          </View>
        ) : (
          mobileHeader
        )}
        <View key="workspace-content" style={d.content}>
          {children}
        </View>
        {!desktop && mobileNavigation}
      </View>
      {desktop && chatOpen && inspectorOpen && (
        <AgentInspector
          name={agentName}
          status={companionStatus}
          onSettings={onSettings}
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </View>
  );
}

export function AgentInspector({
  name,
  status,
  onSettings,
  onClose,
  compact = false,
}: {
  name: string;
  status: string;
  onSettings: () => void;
  onClose: () => void;
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const { data } = useAgentWorkspace();
  const { workspace, open } = useWorkspace();
  const [tab, setTab] = useState("activity");
  const tabs = [
    { id: "activity", label: t("Activity"), icon: List },
    { id: "approvals", label: t("Approvals"), icon: ShieldCheck },
    { id: "history", label: t("History"), icon: Clock3 },
    { id: "identity", label: t("Personality"), icon: Fingerprint },
  ];
  const tasks = [...(data?.tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shownTasks =
    tab === "history"
      ? tasks.filter((task) => ["succeeded", "failed", "cancelled"].includes(task.status))
      : tasks;
  const actions = [...workspace.actions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  function showDetail(detail: Parameters<typeof open>[0]) {
    if (compact) onClose();
    open(detail);
  }
  const { state } = useAvatarPresentation();
  const liveStatus =
    state === "talking"
      ? t("Writing to you…")
      : state === "thinking" && status === t("Here when you need me")
        ? t("Thinking it through…")
        : status;
  const connected = !!data?.worker.running;
  const resting = liveStatus === t("Here when you need me");
  return (
    <View
      testID="desktop-agent-inspector"
      style={[d.inspector, compact && { width: "100%", flex: 1, borderLeftWidth: 0 }]}
    >
      <View
        style={[
          d.inspectorToolbar,
          compact && { justifyContent: "space-between", flexDirection: "row-reverse" },
        ]}
      >
        {compact && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(desktopCopy.notifications, {
              pending: data?.notifications.filter((item) => !item.read).length ?? 0,
            })}
            onPress={() => showDetail({ type: "notifications" })}
            style={d.menuButton}
          >
            <Bell size={19} color={colors.muted} />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={locale === "pt-BR" ? "Fechar painel do agente" : "Close agent panel"}
          onPress={onClose}
          style={d.menuButton}
        >
          <X size={18} color={colors.muted} />
        </Pressable>
      </View>
      <View style={d.inspectorProfile}>
        <View style={d.inspectorPortrait}>
          <View style={{ width: 108, height: 108, borderRadius: 54, overflow: "hidden" }}>
            <Mascot size={108} variant={data?.identity.avatar} framing="portrait" />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(desktopCopy.customize)}
            onPress={onSettings}
            style={d.portraitEdit}
          >
            <Pencil size={14} color={colors.text} />
          </Pressable>
        </View>
        <Text numberOfLines={1} style={d.inspectorName}>
          {name}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: connected ? "#59A478" : "#A0A0A4",
            }}
          />
          <Text numberOfLines={2} style={d.inspectorStatus}>
            {resting
              ? connected
                ? t("Connected")
                : locale === "pt-BR"
                  ? "Desconectado"
                  : "Offline"
              : liveStatus}
          </Text>
        </View>
      </View>
      <View accessibilityRole="tablist" style={d.inspectorTabs}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: tab === id }}
            onPress={() => setTab(id)}
            style={[d.inspectorTab, tab === id && d.inspectorTabActive]}
          >
            <Icon size={17} strokeWidth={1.6} color={tab === id ? colors.text : colors.muted} />
          </Pressable>
        ))}
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 20, paddingBottom: 20, gap: 3 }}
      >
        {tab === "identity" ? (
          <View style={{ gap: 16, paddingHorizontal: 4 }}>
            <Text style={d.inspectorSection}>{t("Name and personality")}</Text>
            <Text style={s.muted}>
              {data?.identity.profile?.fields.personality || t(desktopCopy.customizeCaption)}
            </Text>
            <Button small icon={Pencil} onPress={onSettings}>
              {t(desktopCopy.customize)}
            </Button>
            <Text style={d.inspectorSection}>{t("Preferences")}</Text>
            <Text style={s.muted}>{t(desktopCopy.settingsSubtitle)}</Text>
            <Button small icon={Settings2} onPress={onSettings}>
              {t("Settings")}
            </Button>
          </View>
        ) : tab === "approvals" ? (
          <>
            <Text style={d.inspectorSection}>{t("Approvals")}</Text>
            {!actions.length && (
              <Text style={d.inspectorEmpty}>
                {locale === "pt-BR"
                  ? "Pedidos de aprovação aparecem aqui."
                  : "Requests for your approval will appear here."}
              </Text>
            )}
            {actions.map((action) => (
              <Pressable
                key={action.id}
                accessibilityRole="button"
                onPress={() => showDetail({ type: "review", action })}
                style={({ pressed }) => [d.activityRow, pressed && d.activeItem]}
              >
                <View style={d.activityIcon}>
                  <ShieldCheck size={17} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={2} style={d.activityTitle}>
                    {action.title}
                  </Text>
                  <Text numberOfLines={2} style={d.activityDetail}>
                    {action.status === "awaiting_review"
                      ? t("Waiting for approval")
                      : action.result || action.status.replaceAll("_", " ")}
                  </Text>
                </View>
                <ChevronRight size={14} color={colors.muted} />
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <Text style={d.inspectorSection}>
              {tab === "history" ? t("History") : t("Activity")}
            </Text>
            {!shownTasks.length && (
              <Text style={d.inspectorEmpty}>
                {locale === "pt-BR"
                  ? "Os próximos passos e resultados aparecem aqui enquanto conversamos."
                  : "Your next steps and results will appear here as we work together."}
              </Text>
            )}
            {shownTasks.map((task) => {
              const complete = task.status === "succeeded";
              const RowIcon = complete
                ? CheckCircle2
                : task.status === "waiting_approval"
                  ? ShieldCheck
                  : Clock3;
              return (
                <Pressable
                  key={task.id}
                  accessibilityRole="button"
                  accessibilityLabel={task.title}
                  onPress={() => showDetail({ type: "task", taskId: task.id })}
                  style={({ pressed }) => [d.activityRow, pressed && d.activeItem]}
                >
                  <View style={d.activityIcon}>
                    <RowIcon size={17} strokeWidth={1.6} color={colors.muted} />
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text numberOfLines={2} style={d.activityTitle}>
                      {task.title}
                    </Text>
                    <Text numberOfLines={2} style={d.activityDetail}>
                      {task.question ||
                        task.error ||
                        task.result ||
                        task.plan.find((step) => step.status === "running")?.title ||
                        task.title}
                    </Text>
                    <Text style={d.activityTime}>
                      {new Date(task.updatedAt).toLocaleTimeString(locale, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>
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
