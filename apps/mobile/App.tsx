import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { StatusBar } from "expo-status-bar";
import {
  Check,
  Lightbulb,
  type LucideIcon,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Settings2,
  Shapes,
  SquareCheck,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../packages/domain/src";
import { AgentActivityScreen, AppsScreen, GoalsScreen, IdeasScreen } from "./src/agent-ui";
import { AgentWorkspaceProvider, useAgentWorkspace } from "./src/agent-workspace";
import { API_URL, ApiError, authManager, MuseApi } from "./src/api";
import type { AuthManager } from "./src/auth-manager";
import { installRuntimeAuthFetch } from "./src/auth-transport";
import { AvatarPresentationProvider, useAvatarPresentation } from "./src/avatar-presentation";
import { AvatarStudio } from "./src/avatar-studio";
import { ChatScreen, WorkspaceTools } from "./src/chat";
import { ComputerDraftProvider } from "./src/computer-drafts";
import {
  AgentInspector,
  AppLanguagePicker,
  DesktopSettings,
  DesktopShell,
  desktopCopy,
} from "./src/desktop-shell";
import { desktopStyles as d } from "./src/desktop-shell-styles";
import { Details } from "./src/details";
import { useI18n } from "./src/i18n";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./src/screens";
import { ShareReceiver } from "./src/share-receiver";
import { ThreadsProvider, ThreadsSheet, useMuseThread } from "./src/threads";
import {
  Button,
  Card,
  colors,
  ErrorNotice,
  Field,
  HeaderFade,
  IconButton,
  Mascot,
  s,
} from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

const nav: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "activity", label: "Activity", icon: PanelsTopLeft },
  { id: "ideas", label: "Ideas", icon: Lightbulb },
  { id: "goals", label: "Goals", icon: SquareCheck },
  { id: "files", label: "Library", icon: Shapes },
];
const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "Activity", subtitle: "Plans, progress, decisions and results." },
  ideas: { title: "Ideas", subtitle: "Useful next steps, grounded in your world." },
  goals: {
    title: "Goals",
    subtitle: "Longer-term goals and things to keep an eye on.",
  },
  apps: {
    title: "Apps",
    subtitle: "Connections, capabilities and what your agent remembers.",
  },
  connections: { title: "Apps", subtitle: "Connections and capabilities." },
  mail: { title: "Mail", subtitle: "The conversations behind your work." },
  calendar: { title: "Calendar", subtitle: "Time for what matters." },
  browser: { title: "Browser", subtitle: "Your connected browsing sessions." },
  files: { title: "Library", subtitle: "Documents, forms and filled copies." },
};
export default function App() {
  const { t } = useI18n();
  const [session, setSession] = useState(authManager.snapshot);
  const [accessKey, setAccessKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const connect = useCallback(async (key?: string) => {
    setBusy(true);
    setError("");
    try {
      await authManager.pair(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const restore = useCallback(async (bootstrap = false) => {
    setBusy(true);
    setError("");
    try {
      await authManager.restoreOrPair();
    } catch (e) {
      if (
        !(
          bootstrap &&
          e instanceof ApiError &&
          e.status === 401 &&
          authManager.snapshot.status === "missing"
        )
      )
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const unsubscribe = authManager.subscribe(setSession);
    const restoreFetch = installRuntimeAuthFetch(API_URL, authManager);
    void restore(true);
    const timer = setInterval(() => {
      if (authManager.snapshot.token) void authManager.authorization().catch(() => {});
    }, 30_000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active")
        void (authManager.snapshot.token ? authManager.authorization() : restore(true)).catch(
          () => {},
        );
    });
    return () => {
      unsubscribe();
      restoreFetch();
      clearInterval(timer);
      listener.remove();
    };
  }, [restore]);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {session.token ? (
        <CopilotKitProvider
          runtimeUrl={`${API_URL}/api/copilotkit`}
          headers={{ Authorization: `Bearer ${session.token}` }}
          credentials="include"
          onError={({ error }) => setError(error.message)}
        >
          <WorkspaceApp auth={authManager} sessionError={error} />
        </CopilotKitProvider>
      ) : (
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: colors.canvas,
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
        >
          <SafeAreaView
            edges={["top", "left", "right"]}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              left: 0,
              padding: 24,
              alignItems: "flex-end",
            }}
          >
            <AppLanguagePicker compact />
          </SafeAreaView>
          <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
            <Mascot size={72} />
            <Text
              style={{
                fontSize: 32,
                color: colors.text,
                letterSpacing: -1,
                fontWeight: "500",
                textAlign: "center",
              }}
            >
              {t("Welcome to OkamiBot.")}
            </Text>
            <Text style={[s.muted, { textAlign: "center" }]}>
              {t("A little room for your day.")}
            </Text>
            {!busy && session.status === "missing" && !error && (
              <Text style={[s.muted, { textAlign: "center" }]}>
                {t("Enter your access key to continue.")}
              </Text>
            )}
            {busy ? (
              <ActivityIndicator color={colors.blueDark} />
            ) : (
              <Card style={{ width: "100%" }}>
                <ErrorNotice error={t(error)} />
                {session.status === "unavailable" ? (
                  <Button primary onPress={() => void restore()}>
                    {t("Retry saved pairing")}
                  </Button>
                ) : (
                  <>
                    <Field
                      label={t("Workspace access key")}
                      value={accessKey}
                      onChangeText={setAccessKey}
                      secureTextEntry
                      placeholder={t("Required for a live workspace")}
                    />
                    <Button primary onPress={() => void connect(accessKey || undefined)}>
                      {t("Open workspace")}
                    </Button>
                  </>
                )}
                <Text style={[s.small, { marginTop: 15 }]}>
                  {t("Your language choice is saved on this device.")}
                </Text>
              </Card>
            )}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
function WorkspaceApp({ auth, sessionError }: { auth: AuthManager; sessionError: string }) {
  const { t } = useI18n();
  const api = useMemo(() => new MuseApi(auth), [auth]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [section, setSection] = useState<Section>("chat");
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    const requested = ["mail", "calendar", "files", "browser"].includes(section)
      ? section
      : "essential";
    const snapshot = await api.request<Workspace>(`/api/workspace?section=${requested}`);
    setWorkspace(snapshot);
    setError("");
  }, [api, section]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((e) => setError(String(e)));
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const ask = useCallback((text: string) => {
    setPrompt({ id: Date.now(), text });
    setSection("chat");
  }, []);
  if (!workspace)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.canvas,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
        }}
      >
        <Mascot size={56} />
        {error ? (
          <>
            <ErrorNotice error={t(error)} />
            <Button onPress={() => void refresh().catch((e) => setError(String(e)))}>
              {t("Try again")}
            </Button>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.blueDark} />
            <Text style={s.muted}>{t("Opening your workspace…")}</Text>
          </>
        )}
      </SafeAreaView>
    );
  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        api,
        section,
        navigate,
        refresh,
        open,
        close,
        notify: setToast,
        ask,
        viewerActive: detail?.type === "computer" || detail?.type === "browser",
      }}
    >
      <AgentWorkspaceProvider>
        <ComputerDraftProvider>
          <ThreadsProvider>
            <ShareReceiver />
            <WorkspaceShell
              detail={detail}
              toast={toast}
              clearToast={() => setToast("")}
              error={error || sessionError}
              prompt={prompt}
            />
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}
function CompanionHeading({
  name,
  status,
  variant,
  onPress,
}: {
  name: string;
  status: string;
  variant?: "sky" | "sand" | "lilac";
  onPress: () => void;
}) {
  const { t } = useI18n();
  const { state } = useAvatarPresentation();
  const showStatus = state !== "idle" || status !== t("Here when you need me");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {name} activity and approvals", { name })}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        maxWidth: "70%",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Mascot size={54} variant={variant} />
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: showStatus ? 7 : 8,
          marginTop: -4,
          borderRadius: showStatus ? 20 : 24,
          backgroundColor: "#FFFFFF",
          shadowColor: "#171719",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.06,
          shadowRadius: 14,
          alignItems: "center",
          maxWidth: "100%",
        }}
      >
        <Text
          numberOfLines={1}
          style={{ fontSize: 15, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}
        >
          {name}
        </Text>
        {showStatus && (
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
            {state === "talking"
              ? t("Writing to you…")
              : state === "thinking" && status === t("Here when you need me")
                ? t("Thinking it through…")
                : status}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function WorkspaceShell({
  detail,
  toast,
  clearToast,
  error,
  prompt,
}: {
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}) {
  const { t } = useI18n();
  const { api, workspace, section, navigate } = useWorkspace();
  const { data } = useAgentWorkspace();
  const {
    selection,
    visited,
    loading: threadsLoading,
    error: threadsError,
    retry: retryThreads,
    enabled: richThreads,
  } = useMuseThread();
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  useEffect(() => setSettingsOpen(false), [section, prompt?.id]);
  const navigateSection = useCallback(
    (next: Section) => {
      setSettingsOpen(false);
      navigate(next);
    },
    [navigate],
  );
  const openThreads = () => {
    setSettingsOpen(false);
    setThreadsOpen(true);
  };
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= 1024;
  const pending =
    (data?.notifications.filter((n) => !n.read).length || 0) +
    workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const activeTask =
    data?.tasks.find(
      (task) => task.status === "waiting_approval" || task.status === "waiting_input",
    ) || data?.tasks.find((task) => task.status === "running");
  const agentName = data?.identity.name || "OkamiBot";
  const status = activeTask
    ? activeTask.status === "waiting_approval"
      ? t("Ready to review · {title}", { title: activeTask.title })
      : activeTask.status === "waiting_input"
        ? t("Needs your input · {title}", { title: activeTask.title })
        : activeTask.plan.find((step) => step.status === "running")?.title || activeTask.title
    : data?.tasks.some((task) => task.status === "queued")
      ? t("Picking up your next task…")
      : t("Here when you need me");
  const title = titles[section] || titles.apps;
  const Screen =
    section === "mail"
      ? MailScreen
      : section === "calendar"
        ? CalendarScreen
        : section === "browser"
          ? BrowserScreen
          : section === "files"
            ? FilesScreen
            : section === "activity"
              ? AgentActivityScreen
              : section === "ideas"
                ? IdeasScreen
                : section === "goals"
                  ? GoalsScreen
                  : AppsScreen;
  const utility = ["mail", "calendar", "browser"].includes(section);
  const content = (
    <View style={{ flex: 1, minHeight: 0 }}>
      {settingsOpen && (
        <ScrollView
          key="settings"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={
            desktop ? d.page : { paddingHorizontal: 20, paddingTop: 100, paddingBottom: 28 }
          }
        >
          {desktop && (
            <>
              <Text style={d.pageTitle}>{t(desktopCopy.settingsTitle)}</Text>
              <Text style={d.pageSubtitle}>{t(desktopCopy.settingsSubtitle)}</Text>
            </>
          )}
          <ErrorNotice error={t(error)} />
          <DesktopSettings appearance={<AvatarStudio />} />
        </ScrollView>
      )}
      {!settingsOpen && section !== "chat" && (
        <ScrollView
          key={section}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={
            desktop ? d.page : { paddingHorizontal: 20, paddingTop: 100, paddingBottom: 28 }
          }
          keyboardShouldPersistTaps="handled"
        >
          {utility && (
            <Button
              small
              style={{ alignSelf: "flex-start", marginBottom: 18 }}
              onPress={() => navigateSection("apps")}
            >
              {t("Back to Apps")}
            </Button>
          )}
          <Text style={desktop ? d.pageTitle : [s.title, { fontSize: 25, marginBottom: 22 }]}>
            {t(title?.title || "")}
          </Text>
          {desktop && <Text style={d.pageSubtitle}>{t(title?.subtitle || "")}</Text>}
          <ErrorNotice error={t(error)} />
          <Screen />
        </ScrollView>
      )}
      <View
        style={[
          desktop ? d.chat : { flex: 1, paddingHorizontal: 16 },
          { display: !settingsOpen && section === "chat" ? "flex" : "none" },
        ]}
      >
        {richThreads ? (
          <>
            <ErrorNotice error={threadsError} />
            {threadsError ? (
              <Button onPress={retryThreads}>{t("Retry main chat")}</Button>
            ) : threadsLoading ? (
              <ActivityIndicator color={colors.blueDark} />
            ) : null}
            {visited.map((thread) => (
              <View
                key={thread.id}
                style={{ display: selection.id === thread.id ? "flex" : "none", flex: 1 }}
              >
                <ChatScreen
                  thread={thread}
                  active={!settingsOpen && section === "chat" && selection.id === thread.id}
                  wide={desktop}
                  prompt={selection.id === thread.id ? prompt : undefined}
                />
              </View>
            ))}
          </>
        ) : (
          <ChatScreen prompt={prompt} active={!settingsOpen && section === "chat"} wide={desktop} />
        )}
      </View>
    </View>
  );
  const mobileHeader = (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        zIndex: 3,
        top: 0,
        left: 0,
        right: 0,
        height: settingsOpen ? 80 : 102,
      }}
    >
      <HeaderFade />
      <View style={{ position: "absolute", left: 16, top: 17 }}>
        <IconButton icon={Menu} label={t(desktopCopy.conversationMenu)} onPress={openThreads} />
      </View>
      <View pointerEvents="box-none" style={{ alignItems: "center", paddingTop: 1 }}>
        {settingsOpen ? (
          <View style={{ height: 72, justifyContent: "center", maxWidth: "58%" }}>
            <Text numberOfLines={1} style={[s.heading, { textAlign: "center" }]}>
              {t(desktopCopy.customize)}
            </Text>
          </View>
        ) : (
          <CompanionHeading
            name={agentName}
            status={status}
            variant={data?.identity.avatar}
            onPress={() => setAgentOpen(true)}
          />
        )}
      </View>
      <View style={{ position: "absolute", right: 16, top: 17 }}>
        <IconButton
          icon={Settings2}
          label={t(desktopCopy.settings)}
          onPress={() => setSettingsOpen(true)}
        />
      </View>
    </View>
  );
  const mobileNavigation = (
    <View
      style={{
        paddingHorizontal: 18,
        paddingTop: 10,
        paddingBottom: 8,
        alignItems: "center",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          width: "100%",
          maxWidth: 370,
          padding: 4,
          backgroundColor: "#FFF",
          borderRadius: 40,
          shadowColor: "#132631",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.07,
          shadowRadius: 18,
          elevation: 3,
          borderWidth: 1,
          borderColor: "#F8F8F8",
        }}
      >
        {nav.map((item) => {
          const active =
            !settingsOpen && (section === item.id || (item.id === "files" && section === "files"));
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={t(item.label)}
              accessibilityState={{ selected: active }}
              onPress={() => navigateSection(item.id)}
              style={{
                flex: 1,
                height: 48,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: active ? "#EDEDEF" : "transparent",
                borderRadius: 28,
              }}
            >
              <item.icon size={23} strokeWidth={1.8} color={colors.text} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
  return (
    <AvatarPresentationProvider
      design={data?.identity.avatarDesign}
      asset={data?.identity.avatarAsset}
      state={activeTask?.status === "running" ? "thinking" : "idle"}
      active={!settingsOpen && !detail}
      conversationKey={
        !settingsOpen && section === "chat"
          ? `${api.identityKey}\n${richThreads ? selection.id : "local-main"}`
          : undefined
      }
    >
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <DesktopShell
          title={
            settingsOpen
              ? t(desktopCopy.settings)
              : section === "chat"
                ? agentName
                : t(title?.title || desktopCopy.apps)
          }
          subtitle={
            settingsOpen
              ? t(desktopCopy.settingsSubtitle)
              : section === "chat"
                ? status
                : t(title?.subtitle || "")
          }
          settingsOpen={settingsOpen}
          onSettings={() => setSettingsOpen(true)}
          onNavigate={navigateSection}
          onThreads={openThreads}
          pending={pending}
          desktop={desktop}
          mobileHeader={mobileHeader}
          mobileNavigation={mobileNavigation}
        >
          {content}
        </DesktopShell>
        {agentOpen && !desktop && (
          <Modal
            transparent
            animationType="slide"
            visible
            onRequestClose={() => setAgentOpen(false)}
          >
            <View
              style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.12)" }}
            >
              <SafeAreaView
                edges={["bottom"]}
                style={{
                  height: "94%",
                  backgroundColor: colors.canvas,
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  overflow: "hidden",
                }}
              >
                <AgentInspector
                  compact
                  name={agentName}
                  status={status}
                  onClose={() => setAgentOpen(false)}
                  onSettings={() => {
                    setAgentOpen(false);
                    setSettingsOpen(true);
                  }}
                />
              </SafeAreaView>
            </View>
          </Modal>
        )}
        {!!toast && (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              bottom: desktop ? 28 : 94,
              left: desktop ? 260 : 20,
              right: 20,
              alignItems: "center",
            }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.text,
                  borderRadius: 20,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.blue} />
              <Text style={{ color: "#FFF", fontSize: 13, flexShrink: 1 }}>{toast}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Dismiss notification")}
                onPress={clearToast}
              >
                <X size={16} color="#FFF" />
              </Pressable>
            </View>
          </View>
        )}
        {threadsOpen && <ThreadsSheet onClose={() => setThreadsOpen(false)} />}
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "file"
                  ? detail.file.id
                  : detail.type === "browser"
                    ? detail.browser.id
                    : detail.type === "mail"
                      ? detail.mail.id
                      : detail.type === "review"
                        ? detail.action.id
                        : detail.type === "email"
                          ? JSON.stringify(detail.draft)
                          : detail.type === "event"
                            ? detail.event?.id || "event-new"
                            : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </AvatarPresentationProvider>
  );
}
