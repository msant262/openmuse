import { useThreads } from "@copilotkit/react-native/headless";
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  Fingerprint,
  Lightbulb,
  List,
  type LucideIcon,
  Maximize2,
  Menu,
  MessageCircle,
  Minimize2,
  Monitor,
  MoreHorizontal,
  Newspaper,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings2,
  Shapes,
  ShieldCheck,
  SquareCheck,
  X,
} from "lucide-react-native";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
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
import { CompanionHeading } from "./companion-heading";
import { cachedConversationTitle, isEmptyConversationCache } from "./conversation-label";
import { desktopStyles as d } from "./desktop-shell-styles";
import { useI18n } from "./i18n";
import { MemorySettings } from "./memory-settings";
import { messageStorage } from "./message-storage";
import { ProfileSettings } from "./profile-settings";
import { type Selection, useMuseThread } from "./threads";
import { Button, Card, CheckRow, colors, ErrorNotice, HeaderFade, Mascot, s } from "./ui";
import { useWorkspace } from "./workspace";

// Kept together so the workspace language catalog can translate the desktop shell.
export const desktopCopy = {
  chat: "Chat",
  activity: "Feed",
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
  { id: "activity", label: desktopCopy.activity, icon: Newspaper },
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
  workspacePane,
  workspaceKind = "computer",
  title,
  subtitle,
  settingsOpen,
  onSettings,
  onCustomize,
  onSearch,
  onNavigate,
  onThreads,
  pending,
}: {
  children: ReactNode;
  desktop?: boolean;
  mobileHeader?: ReactNode;
  mobileNavigation?: ReactNode;
  workspacePane?: ReactNode;
  workspaceKind?: "computer" | "document";
  title: string;
  subtitle: string;
  settingsOpen: boolean;
  onSettings: () => void;
  onCustomize: () => void;
  onSearch: () => void;
  onNavigate: (section: Section) => void;
  onThreads: () => void;
  pending: number;
}) {
  const { t, locale } = useI18n();
  const { width } = useWindowDimensions();
  const [sideChatsOpen, setSideChatsOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
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
  const chatOpen = section === "chat";
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
  const sideChatsVisible = sideChatsOpen && width >= 1240 && chatOpen && !workspacePane;
  const inspectorVisible = inspectorOpen && chatOpen && !workspacePane;
  const readingDocument = !!workspacePane && workspaceKind === "document";
  const splitWorkspace = !!workspacePane && !readingDocument && !expandedWorkspace;
  const selectedConversation = conversationList.find((thread) => thread.id === selection.id);
  useEffect(() => {
    if (!workspacePane) setExpandedWorkspace(false);
  }, [!!workspacePane]);
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
            <View style={d.railPrimary}>
              <View style={d.railNavigation}>
                {desktopNavigation.map((item) => (
                  <Fragment key={item.id}>
                    <SidebarItem
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
                    {item.id === "chat" && (
                      <SidebarItem label={t("Search")} icon={Search} onPress={onSearch} />
                    )}
                  </Fragment>
                ))}
              </View>
            </View>
            <View style={d.railUtilities}>
              <View style={d.notification}>
                <SidebarItem
                  label={t("Agent computer — take control")}
                  icon={Monitor}
                  onPress={() => open({ type: "computer" })}
                />
              </View>
              <View style={d.notification}>
                <SidebarItem
                  label={t("App menu")}
                  icon={Menu}
                  active={settingsOpen}
                  onPress={() => setMenuOpen(true)}
                />
                {pending > 0 && <View pointerEvents="none" style={d.badge} />}
              </View>
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
                        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
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
            ? [
                d.main,
                splitWorkspace && {
                  flexGrow: 0,
                  flexBasis: Math.min(430, width * 0.34),
                  width: Math.min(430, width * 0.34),
                  flexShrink: 0,
                },
                !!workspacePane && !splitWorkspace && { display: "none" },
              ]
            : { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center", minHeight: 0 }
        }
      >
        {desktop
          ? chatOpen && (
              <View pointerEvents="box-none" style={d.floatingHeader}>
                <HeaderFade />
                <View pointerEvents="box-none" style={d.chatControls}>
                  <View style={[s.row, { gap: 7, maxWidth: splitWorkspace ? "70%" : "48%" }]}>
                    {selection.id !== mainId && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t(desktopCopy.mainChat)}
                        onPress={() => openThread({ id: mainId, existing: true })}
                        style={d.titleBack}
                      >
                        <ArrowLeft size={17} color={colors.text} />
                      </Pressable>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(desktopCopy.conversationMenu)}
                      accessibilityState={{ expanded: sideChatsVisible }}
                      onPress={() =>
                        width >= 1240 && !workspacePane
                          ? setSideChatsOpen(!sideChatsOpen)
                          : onThreads()
                      }
                      style={[
                        d.conversationPill,
                        sideChatsVisible && { backgroundColor: "transparent", shadowOpacity: 0 },
                      ]}
                    >
                      {sideChatsVisible ? (
                        <PanelLeftClose size={18} color={colors.muted} />
                      ) : (
                        <Menu size={18} color={colors.text} />
                      )}
                      {!sideChatsVisible && !splitWorkspace && (
                        <Text numberOfLines={1} style={d.conversationPillText}>
                          {selectedConversation?.name || t(desktopCopy.mainChat)}
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
                {!inspectorVisible && (
                  <View
                    pointerEvents="box-none"
                    style={{
                      position: "absolute",
                      top: 7,
                      left: splitWorkspace ? 45 : 160,
                      right: splitWorkspace ? 45 : 160,
                      alignItems: "center",
                    }}
                  >
                    <CompanionHeading
                      name={agentName}
                      status={companionStatus}
                      variant={data?.identity.avatar}
                      onPress={() => {
                        if (workspacePane) onNavigate("chat");
                        setInspectorOpen(true);
                      }}
                    />
                  </View>
                )}
              </View>
            )
          : mobileHeader}
        <View key="workspace-content" style={d.content}>
          {children}
        </View>
        {!desktop && mobileNavigation}
      </View>
      {desktop && workspacePane && (
        <View
          testID="desktop-workspace-pane"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            borderLeftWidth: splitWorkspace ? 1 : 0,
            borderLeftColor: colors.line,
          }}
        >
          {workspaceKind === "computer" && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(expandedWorkspace ? "Show conversation" : "Expand workspace")}
              onPress={() => setExpandedWorkspace(!expandedWorkspace)}
              style={{
                position: "absolute",
                top: 18,
                right: 76,
                zIndex: 2,
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.canvas,
              }}
            >
              {expandedWorkspace ? (
                <Minimize2 size={17} color={colors.muted} />
              ) : (
                <Maximize2 size={17} color={colors.muted} />
              )}
            </Pressable>
          )}
          {workspacePane}
        </View>
      )}
      {desktop && inspectorVisible && (
        <AgentInspector
          name={agentName}
          status={companionStatus}
          width={width >= 1440 ? 340 : width >= 1240 ? 310 : 288}
          onSettings={onCustomize}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      {desktop && menuOpen && (
        <Modal transparent visible animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <View style={{ flex: 1 }}>
            <Pressable
              accessible={false}
              onPress={() => setMenuOpen(false)}
              style={{ position: "absolute", top: 0, left: 0, bottom: 0, right: 0 }}
            />
            <View
              accessibilityViewIsModal
              accessibilityLabel={t("App menu")}
              style={{
                position: "absolute",
                left: 76,
                bottom: 18,
                width: 264,
                padding: 7,
                backgroundColor: "#FFFFFF",
                borderRadius: 22,
                borderWidth: 1,
                borderColor: colors.line,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.13,
                shadowRadius: 26,
              }}
            >
              {[
                {
                  label: t("Download Android app"),
                  icon: Download,
                  action: () =>
                    void Linking.openURL(
                      `https://app.okamibot.cloud/downloads/okamibot.apk?v=${Date.now()}`,
                    ),
                },
                { label: t(desktopCopy.apps), icon: Settings2, action: () => onNavigate("apps") },
                {
                  label: t("Notifications"),
                  icon: Bell,
                  action: () => open({ type: "notifications" }),
                },
                { label: t("Settings"), icon: Settings2, action: onSettings },
              ].map(({ label, icon: Icon, action }, index) => (
                <Pressable
                  key={label}
                  accessibilityRole="button"
                  onPress={() => {
                    setMenuOpen(false);
                    action();
                  }}
                  style={({ pressed }) => [
                    s.row,
                    {
                      paddingHorizontal: 14,
                      minHeight: 46,
                      gap: 13,
                      borderRadius: 15,
                      backgroundColor: pressed ? "#F0F0F1" : "transparent",
                      ...(index === 3
                        ? { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 5 }
                        : {}),
                    },
                  ]}
                >
                  <Icon size={18} strokeWidth={1.6} color={colors.text} />
                  <Text style={s.text}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
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
  width,
}: {
  name: string;
  status: string;
  onSettings: () => void;
  onClose: () => void;
  compact?: boolean;
  width?: number;
}) {
  const { t, locale } = useI18n();
  const { data } = useAgentWorkspace();
  const { workspace, open } = useWorkspace();
  const [tab, setTab] = useState("activity");
  const tabs = [
    { id: "activity", label: t("Activity"), icon: List },
    { id: "approvals", label: t("Approvals"), icon: ShieldCheck },
    { id: "upcoming", label: t("Upcoming"), icon: Clock3 },
    { id: "identity", label: t("Personality"), icon: Fingerprint },
  ];
  const tasks = [...(data?.tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shownTasks = tab === "upcoming" ? tasks.filter((task) => task.status === "queued") : tasks;
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
      style={[
        d.inspector,
        width !== undefined && { width },
        compact && { width: "100%", flex: 1, borderLeftWidth: 0 },
      ]}
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
      <View style={[d.inspectorProfile, compact && { paddingTop: 24, paddingBottom: 34 }]}>
        <View style={[d.inspectorPortrait, compact && { width: 78, height: 78, borderRadius: 39 }]}>
          <View
            style={{
              width: compact ? 78 : 98,
              height: compact ? 78 : 98,
              borderRadius: 54,
              overflow: "hidden",
            }}
          >
            <Mascot size={compact ? 78 : 98} variant={data?.identity.avatar} framing="portrait" />
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
        <Text numberOfLines={1} style={[d.inspectorName, compact && { fontSize: 25 }]}>
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
          <Text
            numberOfLines={2}
            style={[d.inspectorStatus, compact && { fontSize: 15, lineHeight: 21 }]}
          >
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
      <View
        accessibilityRole="tablist"
        style={[d.inspectorTabs, compact && { marginHorizontal: 16, padding: 4 }]}
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: tab === id }}
            onPress={() => setTab(id)}
            style={[d.inspectorTab, compact && { height: 41 }, tab === id && d.inspectorTabActive]}
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
            <Text style={[d.inspectorSection, compact && { fontSize: 18 }]}>
              {t("Name and personality")}
            </Text>
            <Text style={s.muted}>
              {data?.identity.profile?.fields.personality || t(desktopCopy.customizeCaption)}
            </Text>
            <Button small icon={Pencil} onPress={onSettings}>
              {t(desktopCopy.customize)}
            </Button>
            <Text style={[d.inspectorSection, compact && { fontSize: 18 }]}>
              {t("Preferences")}
            </Text>
            <Text style={s.muted}>{t(desktopCopy.settingsSubtitle)}</Text>
            <Button small icon={Settings2} onPress={onSettings}>
              {t("Settings")}
            </Button>
          </View>
        ) : tab === "approvals" ? (
          <>
            <Text style={[d.inspectorSection, compact && { fontSize: 18 }]}>{t("Approvals")}</Text>
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
                <View style={[d.activityIcon, compact && { width: 42, height: 42 }]}>
                  <ShieldCheck size={17} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text
                    numberOfLines={2}
                    style={[d.activityTitle, compact && { fontSize: 16, lineHeight: 22 }]}
                  >
                    {action.title}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[d.activityDetail, compact && { fontSize: 14, lineHeight: 20 }]}
                  >
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
            <Text style={[d.inspectorSection, compact && { fontSize: 18 }]}>
              {tab === "upcoming" ? t("Upcoming") : t("Today")}
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
                  <View style={[d.activityIcon, compact && { width: 42, height: 42 }]}>
                    <RowIcon size={17} strokeWidth={1.6} color={colors.muted} />
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      numberOfLines={2}
                      style={[d.activityTitle, compact && { fontSize: 16, lineHeight: 22 }]}
                    >
                      {task.title}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={[d.activityDetail, compact && { fontSize: 14, lineHeight: 20 }]}
                    >
                      {task.question ||
                        task.error ||
                        task.result ||
                        task.plan.find((step) => step.status === "running")?.title ||
                        task.title}
                    </Text>
                    <Text style={[d.activityTime, compact && { fontSize: 13, lineHeight: 19 }]}>
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
    <Card style={{ padding: 0, backgroundColor: "transparent", gap: 10 }}>
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
      <Card style={{ gap: 14, padding: 16, backgroundColor: "#F0F0F1", borderRadius: 18 }}>
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
