import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { Asset } from "expo-asset";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import {
  Check,
  Lightbulb,
  type LucideIcon,
  Menu,
  MessageCircle,
  Newspaper,
  Settings,
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
import { AvatarPresentationProvider } from "./src/avatar-presentation";
import { BrandBackdrop, BrandLoading, BrandLockup, brandMark } from "./src/brand-screen";
import { ChatScreen, WorkspaceTools } from "./src/chat";
import { CompanionHeading } from "./src/companion-heading";
import { ComputerDraftProvider } from "./src/computer-drafts";
import { CredentialPromptsProvider } from "./src/credential-prompts";
import { AgentInspector, AppLanguagePicker, DesktopShell, desktopCopy } from "./src/desktop-shell";
import { desktopStyles as createDesktopStyles } from "./src/desktop-shell-styles";
import { Details } from "./src/details";
import { useI18n } from "./src/i18n";
import { WorkspaceSearch } from "./src/muse-search";
import { CompanionDialog, SettingsDialog } from "./src/muse-settings";
import { isProductTask, productNotifications } from "./src/muse-surfaces-model";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./src/screens";
import { ShareReceiver } from "./src/share-receiver";
import { useTheme, useThemedStyles } from "./src/theme";
import { ThreadsProvider, ThreadsSheet, useMuseThread } from "./src/threads";
import { Button, Card, ErrorNotice, Field, HeaderFade, IconButton, useUI } from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

if (Platform.OS !== "web") void SplashScreen.preventAutoHideAsync().catch(() => {});

const nav: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "activity", label: "Feed", icon: Newspaper },
  { id: "ideas", label: "Ideas", icon: Lightbulb },
  { id: "goals", label: "Goals", icon: SquareCheck },
  { id: "files", label: "Library", icon: Shapes },
];
const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "Feed", subtitle: "" },
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
  useEffect(() => {
    if (Platform.OS === "web") return;
    void Asset.loadAsync(brandMark)
      .catch(() => {})
      .finally(() => {
        requestAnimationFrame(() => {
          void SplashScreen.hideAsync().catch(() => {});
        });
      });
  }, []);
  const { scheme, colors: themeColors } = useTheme();
  useEffect(() => {
    if (Platform.OS !== "web") {
      void SystemUI.setBackgroundColorAsync(themeColors.canvas);
      return;
    }
    if (typeof document === "undefined") return;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.backgroundColor = themeColors.canvas;
    document.body.style.backgroundColor = themeColors.canvas;
  }, [scheme, themeColors]);
  const { colors, s } = useUI();

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
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {session.token ? (
        <CopilotKitProvider
          runtimeUrl={`${API_URL}/api/copilotkit`}
          headers={{ Authorization: `Bearer ${session.token}` }}
          credentials="include"
          onError={({ error }) => setError(error.message)}
        >
          <WorkspaceApp auth={authManager} sessionError={error} />
        </CopilotKitProvider>
      ) : busy ? (
        <BrandLoading label={t("Connecting to your workspace…")} />
      ) : (
        <BrandBackdrop>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              paddingTop: 64,
              gap: 22,
            }}
          >
            <View style={{ position: "absolute", top: 12, right: 20 }}>
              <AppLanguagePicker compact />
            </View>
            <View style={{ width: "100%", maxWidth: 420, alignItems: "center", gap: 22 }}>
              <BrandLockup compact />
              <Text
                style={{ fontSize: 22, fontWeight: "600", color: colors.text, textAlign: "center" }}
              >
                {t("Welcome to OkamiBot.")}
              </Text>
              {session.status === "missing" && !error && (
                <Text style={[s.muted, { textAlign: "center" }]}>
                  {t("Enter your access key to continue.")}
                </Text>
              )}
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
              <Text style={[s.small, { textAlign: "center", letterSpacing: 1 }]}>
                {t("A brighter tomorrow, together.")}
              </Text>
            </View>
          </ScrollView>
        </BrandBackdrop>
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
      <BrandLoading label={t("Opening your workspace…")}>
        {error ? (
          <View style={{ gap: 18, width: "100%", maxWidth: 420 }}>
            <ErrorNotice error={t(error)} />
            <Button onPress={() => void refresh().catch((e) => setError(String(e)))}>
              {t("Try again")}
            </Button>
          </View>
        ) : undefined}
      </BrandLoading>
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
            <CredentialPromptsProvider>
              <ShareReceiver />
              <WorkspaceShell
                detail={detail}
                toast={toast}
                clearToast={() => setToast("")}
                error={error || sessionError}
                prompt={prompt}
              />
            </CredentialPromptsProvider>
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
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
  const { colors, s } = useUI();
  const d = useThemedStyles(createDesktopStyles);

  const { t } = useI18n();
  const { api, workspace, section, navigate, close } = useWorkspace();
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
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setSettingsOpen(false), [section, prompt?.id]);
  const navigateSection = useCallback(
    (next: Section) => {
      setSettingsOpen(false);
      close();
      navigate(next);
    },
    [navigate, close],
  );
  const openThreads = () => {
    setSettingsOpen(false);
    setThreadsOpen(true);
  };
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= 1024;
  const workspaceDetail =
    desktop &&
    detail &&
    ["file", "computer", "browser", "agent-soul", "agent-memory"].includes(detail.type)
      ? detail
      : undefined;
  const workspaceKind =
    workspaceDetail && ["file", "agent-soul", "agent-memory"].includes(workspaceDetail.type)
      ? "document"
      : "computer";
  useEffect(() => {
    if (workspaceDetail && workspaceKind === "computer") navigate("chat");
  }, [workspaceDetail?.type, workspaceKind, navigate]);
  useEffect(() => {
    if (!workspaceDetail || Platform.OS !== "web") return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[aria-modal="true"]')) close();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [workspaceDetail, close]);
  const pending =
    productNotifications(data?.tasks ?? [], data?.notifications ?? []).filter((n) => !n.read)
      .length + workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const activeTask =
    data?.tasks.find(
      (task) =>
        isProductTask(task) &&
        (task.status === "waiting_approval" || task.status === "waiting_input"),
    ) || data?.tasks.find((task) => isProductTask(task) && task.status === "running");
  const agentName = data?.identity.name || "OkamiBot";
  const status = activeTask
    ? activeTask.status === "waiting_approval"
      ? t("Ready to review · {title}", { title: activeTask.title })
      : activeTask.status === "waiting_input"
        ? t("Needs your input · {title}", { title: activeTask.title })
        : activeTask.plan.find((step) => step.status === "running")?.title || activeTask.title
    : data?.tasks.some((task) => isProductTask(task) && task.status === "queued")
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
      {section === "files" && <FilesScreen />}
      {section !== "chat" && section !== "files" && (
        <ScrollView
          key={section}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={
            desktop ? d.page : { paddingHorizontal: 20, paddingTop: 110, paddingBottom: 100 }
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
          {section !== "activity" && section !== "ideas" && (
            <Text
              style={
                desktop
                  ? [d.pageTitle, { marginBottom: 24 }]
                  : [s.title, { fontSize: 25, marginBottom: 22 }]
              }
            >
              {t(title?.title || "")}
            </Text>
          )}
          <ErrorNotice error={t(error)} />
          <Screen />
        </ScrollView>
      )}
      <View
        style={[
          desktop ? d.chat : { flex: 1, paddingHorizontal: 16, paddingBottom: 82 },
          { display: section === "chat" ? "flex" : "none" },
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
                  active={
                    !settingsOpen &&
                    !customizeOpen &&
                    section === "chat" &&
                    selection.id === thread.id
                  }
                  wide={desktop}
                  prompt={selection.id === thread.id ? prompt : undefined}
                />
              </View>
            ))}
          </>
        ) : (
          <ChatScreen
            prompt={prompt}
            active={!settingsOpen && !customizeOpen && section === "chat"}
            wide={desktop}
          />
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
        height: 112,
      }}
    >
      <HeaderFade />
      <View style={{ position: "absolute", left: 16, top: 17 }}>
        <IconButton icon={Menu} label={t(desktopCopy.conversationMenu)} onPress={openThreads} />
      </View>
      <View pointerEvents="box-none" style={{ alignItems: "center", paddingTop: 1 }}>
        <CompanionHeading
          name={agentName}
          status={status}
          variant={data?.identity.avatar}
          onPress={() => setAgentOpen(true)}
        />
      </View>
    </View>
  );
  const mobileNavigation = (
    <View
      style={{
        position: "absolute",
        bottom: 8,
        left: 0,
        right: 0,
        paddingHorizontal: 20,
        paddingTop: 10,
        paddingBottom: 4,
        alignItems: "center",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          width: "100%",
          maxWidth: 370,
          padding: 4,
          backgroundColor: colors.card,
          borderRadius: 40,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.07,
          shadowRadius: 18,
          elevation: 3,
          borderWidth: 1,
          borderColor: colors.line,
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
              aria-selected={active}
              onPress={() => navigateSection(item.id)}
              style={{
                flex: 1,
                height: 48,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: active ? colors.subtle : "transparent",
                borderRadius: 28,
              }}
            >
              <item.icon size={23} strokeWidth={1.8} color={colors.text} />
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Settings")}
          aria-expanded={settingsOpen}
          onPress={() => setSettingsOpen(true)}
          style={({ pressed }) => ({
            flex: 1,
            height: 48,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: settingsOpen || pressed ? colors.subtle : "transparent",
            borderRadius: 28,
          })}
        >
          <Settings size={23} strokeWidth={1.8} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
  return (
    <AvatarPresentationProvider
      design={data?.identity.avatarDesign}
      asset={data?.identity.avatarAsset}
      companion={data?.identity.builtinCompanion}
      state={activeTask?.status === "running" ? "thinking" : "idle"}
      active={!settingsOpen && !customizeOpen && !detail}
      conversationKey={
        !settingsOpen && section === "chat"
          ? `${api.identityKey}\n${richThreads ? selection.id : "local-main"}`
          : undefined
      }
    >
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <DesktopShell
          title={section === "chat" ? agentName : t(title?.title || desktopCopy.apps)}
          subtitle={section === "chat" ? status : t(title?.subtitle || "")}
          settingsOpen={settingsOpen}
          onSettings={() => setSettingsOpen(true)}
          onCustomize={() => setCustomizeOpen(true)}
          onSearch={() => setSearchOpen(true)}
          onNavigate={navigateSection}
          onThreads={openThreads}
          pending={pending}
          desktop={desktop}
          mobileHeader={mobileHeader}
          mobileNavigation={mobileNavigation}
          workspacePane={
            workspaceDetail ? <Details detail={workspaceDetail} embedded /> : undefined
          }
          workspaceKind={workspaceKind}
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
                edges={["top", "bottom"]}
                style={{
                  height: "100%",
                  backgroundColor: colors.canvas,
                  borderTopLeftRadius: 0,
                  borderTopRightRadius: 0,
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
                    setCustomizeOpen(true);
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
              <Text style={{ color: colors.onFeature, fontSize: 13, flexShrink: 1 }}>{toast}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Dismiss notification")}
                onPress={clearToast}
              >
                <X size={16} color={colors.onFeature} />
              </Pressable>
            </View>
          </View>
        )}
        {searchOpen && <WorkspaceSearch onClose={() => setSearchOpen(false)} />}
        {settingsOpen && (
          <SettingsDialog
            onClose={() => setSettingsOpen(false)}
            onCustomize={() => {
              setSettingsOpen(false);
              setCustomizeOpen(true);
            }}
          />
        )}
        {customizeOpen && <CompanionDialog onClose={() => setCustomizeOpen(false)} />}
        {threadsOpen && (
          <ThreadsSheet
            onClose={() => setThreadsOpen(false)}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        {detail && !workspaceDetail && (
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
