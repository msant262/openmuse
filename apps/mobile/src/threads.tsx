import { useThreads } from "@copilotkit/react-native/headless";
import {
  Archive,
  CalendarDays,
  FileText,
  type MessageCircle,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "./i18n";
import { messageStorage } from "./message-storage";
import { navigateFromThreadMenu, parseThreadSelection } from "./thread-selection";
import { Button, colors, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type Selection = { id: string; existing: boolean };
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  markAccepted: (id: string) => void;
  start: () => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { workspace, navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | { key: string; detail: string }>("");
  const [attempt, setAttempt] = useState(0);
  const selectionVersion = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    const version = selectionVersion.current;
    const restoration = messageStorage
      .read(`${api.identityKey}\nthread-selection`)
      .then((raw) => {
        const saved = parseThreadSelection(raw);
        if (saved && active && version === selectionVersion.current) {
          setMainId(saved.mainId);
          setSelection(saved.selection);
          setVisited(saved.visited);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (active)
          setError({ key: "Conversation drafts could not be restored:", detail: String(cause) });
      });
    // Restore the device's choice before a fast server response can persist a default.
    void restoration
      .then(() => api.request<{ threadId: string; existing: boolean }>("/api/main-thread"))
      .then((main) => {
        if (!active) return;
        const next = { id: main.threadId, existing: main.existing };
        setMainId(next.id);
        if (version === selectionVersion.current) {
          setSelection((current) => (current.id === "local" ? next : current));
          setVisited((current) => (current.length ? current : [next]));
        }
        setLoading(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, enabled, attempt]);
  function select(next: Selection) {
    selectionVersion.current++;
    setSelection(next);
    setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
    navigate("chat");
  }
  useEffect(() => {
    if (!enabled || loading || mainId === "local") return;
    void messageStorage
      .write(`${api.identityKey}\nthread-selection`, JSON.stringify({ mainId, selection, visited }))
      .catch((cause) =>
        setError({ key: "Conversation selection could not be saved:", detail: String(cause) }),
      );
  }, [api, enabled, loading, mainId, selection, visited]);
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        enabled,
        mainId,
        visited,
        loading,
        error: typeof error === "string" ? error : `${t(error.key)} ${error.detail}`,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        markAccepted: (id) => {
          setSelection((current) =>
            current.id === id && !current.existing ? { ...current, existing: true } : current,
          );
          setVisited((current) =>
            current.map((item) =>
              item.id === id && !item.existing ? { ...item, existing: true } : item,
            ),
          );
        },
        start: () => select({ id: newThreadId(), existing: false }),
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}
export function ThreadsSheet({
  onClose,
  onSettings,
}: {
  onClose: () => void;
  onSettings?: () => void;
}) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const {
    enabled,
    selection,
    visited,
    mainId,
    loading,
    error: mainError,
    retry,
    select,
    start,
  } = useMuseThread();
  const { open, navigate, refresh } = useWorkspace();
  const threads = useThreads({ agentId: "default", enabled, includeArchived: true, limit: 20 });
  const [editing, setEditing] = useState<string>();
  const [actions, setActions] = useState<string>();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  const [tools, setTools] = useState(false);
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
      setActions(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function go(section: "calendar" | "files" | "apps") {
    navigateFromThreadMenu(onClose, () => navigate(section));
  }
  const matches = (value: string) =>
    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const saved = threads.threads.filter(
    (thread) =>
      thread.id !== mainId &&
      thread.archived === archived &&
      matches(thread.name || t("Untitled conversation")),
  );
  const drafts = archived
    ? []
    : visited
        .filter(
          (item) => item.id !== mainId && !threads.threads.some((saved) => saved.id === item.id),
        )
        .map((item, index) => ({ ...item, name: t("Side chat {number}", { number: index + 1 }) }))
        .filter((item) => matches(item.name));
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.12)" }}>
        <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} />
        <View
          accessibilityViewIsModal
          accessibilityLabel={t("Chats")}
          role={Platform.OS === "web" ? "dialog" : undefined}
          aria-modal={true}
          style={{
            position: "absolute",
            left: width >= 760 ? 78 : 12,
            top: Math.max(insets.top + 12, width >= 760 ? 54 : 12),
            width: Math.min(320, width - 24),
            maxHeight: height - insets.top - insets.bottom - 40,
            backgroundColor: colors.canvas,
            borderRadius: 25,
            padding: 12,
            shadowColor: "#000",
            shadowOpacity: 0.16,
            shadowRadius: 30,
            shadowOffset: { width: 0, height: 10 },
            elevation: 16,
          }}
        >
          <View style={[s.row, { gap: 5, paddingBottom: 9 }]}>
            <View
              style={[
                s.row,
                {
                  flex: 1,
                  gap: 7,
                  backgroundColor: "#EEEEF0",
                  borderRadius: 22,
                  paddingHorizontal: 12,
                  minHeight: 37,
                },
              ]}
            >
              <Search size={16} strokeWidth={1.7} color={colors.muted} />
              <TextInput
                accessibilityLabel={t("Search conversations")}
                placeholder={t("Search")}
                value={query}
                onChangeText={setQuery}
                placeholderTextColor={colors.muted}
                style={{
                  flex: 1,
                  color: colors.text,
                  fontSize: 14,
                  paddingVertical: 8,
                  ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
                }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("More options")}
              accessibilityState={{ expanded: tools }}
              onPress={() => setTools(!tools)}
              style={{
                width: 32,
                height: 36,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 18,
                backgroundColor: tools ? "#EEEEF0" : "transparent",
              }}
            >
              <MoreHorizontal size={19} color={colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Close details")}
              onPress={onClose}
              style={{ width: 28, height: 36, alignItems: "center", justifyContent: "center" }}
            >
              <X size={17} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flexShrink: 1 }}
          >
            {tools ? (
              <View style={{ gap: 4 }}>
                <ThreadMenuRow
                  title={archived ? t("Show active") : t("Archived")}
                  icon={Archive}
                  onPress={() => {
                    setArchived(!archived);
                    setTools(false);
                  }}
                />
                <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 8 }} />
                <Text style={[s.small, { paddingHorizontal: 10, marginBottom: 4 }]}>
                  {t("Workspace tools")}
                </Text>
                <ThreadMenuRow
                  title={t("Delegate task")}
                  icon={Plus}
                  onPress={() => {
                    onClose();
                    open({ type: "delegate" });
                  }}
                />
                <ThreadMenuRow
                  title={t("Agent computer")}
                  icon={Monitor}
                  onPress={() => {
                    onClose();
                    open({ type: "computer" });
                  }}
                />
                <ThreadMenuRow
                  title={t("Calendar")}
                  icon={CalendarDays}
                  onPress={() => go("calendar")}
                />
                <ThreadMenuRow title={t("Files")} icon={FileText} onPress={() => go("files")} />
                <ThreadMenuRow
                  title={t(onSettings ? "Settings" : "Apps & settings")}
                  icon={Settings2}
                  onPress={() =>
                    onSettings ? navigateFromThreadMenu(onClose, onSettings) : go("apps")
                  }
                />
                <ThreadMenuRow
                  title={t("Refresh workspace")}
                  icon={RefreshCw}
                  onPress={() => void mutate(refresh)}
                />
                <ErrorNotice error={error} />
              </View>
            ) : (
              <View style={{ gap: 3 }}>
                {enabled && loading ? (
                  <View style={{ padding: 15 }}>
                    <ErrorNotice error={mainError} />
                    {mainError ? (
                      <Button onPress={retry}>{t("Retry main chat")}</Button>
                    ) : (
                      <ActivityIndicator color={colors.blueDark} />
                    )}
                  </View>
                ) : (
                  <>
                    {matches(t("Main chat")) && (
                      <ThreadMenuRow
                        title={t("Main chat")}
                        selected={!archived && selection.id === mainId}
                        onPress={() =>
                          navigateFromThreadMenu(onClose, () =>
                            enabled ? select({ id: mainId, existing: true }) : navigate("chat"),
                          )
                        }
                      />
                    )}
                    {enabled && (
                      <>
                        <View
                          style={[s.between, { paddingLeft: 10, marginTop: 8, marginBottom: 3 }]}
                        >
                          <Text style={[s.muted, { fontSize: 13 }]}>
                            {archived ? t("Archived") : t("Side chats")}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t("New side chat")}
                            onPress={() => navigateFromThreadMenu(onClose, start)}
                            style={{
                              width: 34,
                              height: 32,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Plus size={17} strokeWidth={1.6} color={colors.muted} />
                          </Pressable>
                        </View>
                        {threads.isLoading && <ActivityIndicator color={colors.blueDark} />}
                        <ErrorNotice error={error || threads.error?.message} />
                        {threads.error && (
                          <Button small onPress={threads.refetchThreads}>
                            {t("Retry conversations")}
                          </Button>
                        )}
                        {drafts.map((item) => (
                          <ThreadMenuRow
                            key={item.id}
                            title={item.name}
                            selected={selection.id === item.id}
                            onPress={() => navigateFromThreadMenu(onClose, () => select(item))}
                          />
                        ))}
                        {saved.map((thread) => (
                          <View key={thread.id}>
                            <ThreadMenuRow
                              title={thread.name || t("Untitled conversation")}
                              selected={selection.id === thread.id}
                              onPress={() =>
                                navigateFromThreadMenu(onClose, () =>
                                  select({ id: thread.id, existing: true }),
                                )
                              }
                              action={
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={t("Conversation actions")}
                                  accessibilityState={{ expanded: actions === thread.id }}
                                  onPress={() =>
                                    setActions(actions === thread.id ? undefined : thread.id)
                                  }
                                  style={{
                                    width: 32,
                                    height: 38,
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  <MoreHorizontal size={17} color={colors.muted} />
                                </Pressable>
                              }
                            />
                            {actions === thread.id && (
                              <View
                                style={{
                                  marginHorizontal: 5,
                                  padding: 6,
                                  backgroundColor: "#EEEEF0",
                                  borderRadius: 14,
                                }}
                              >
                                {editing === thread.id ? (
                                  <View style={{ padding: 6 }}>
                                    <Field
                                      label={t("Conversation name")}
                                      value={name}
                                      onChangeText={setName}
                                    />
                                    <View style={[s.row, { justifyContent: "flex-end", gap: 6 }]}>
                                      <Button small onPress={() => setEditing(undefined)}>
                                        {t("Cancel")}
                                      </Button>
                                      <Button
                                        small
                                        disabled={threads.isMutating || !name.trim()}
                                        onPress={() =>
                                          void mutate(() =>
                                            threads.renameThread(thread.id, name.trim()),
                                          )
                                        }
                                      >
                                        {t("Save name")}
                                      </Button>
                                    </View>
                                  </View>
                                ) : (
                                  <>
                                    <ThreadMenuRow
                                      icon={Pencil}
                                      title={t("Rename")}
                                      onPress={() => {
                                        setEditing(thread.id);
                                        setName(thread.name || "");
                                      }}
                                    />
                                    <ThreadMenuRow
                                      icon={Archive}
                                      title={thread.archived ? t("Restore") : t("Archive")}
                                      disabled={threads.isMutating}
                                      onPress={() =>
                                        void mutate(() =>
                                          thread.archived
                                            ? threads.unarchiveThread(thread.id)
                                            : threads.archiveThread(thread.id),
                                        )
                                      }
                                    />
                                  </>
                                )}
                              </View>
                            )}
                          </View>
                        ))}
                        {!threads.isLoading &&
                          !threads.error &&
                          !saved.length &&
                          !drafts.length && (
                            <Text style={[s.muted, { padding: 12, fontSize: 13 }]}>
                              {query.trim()
                                ? t("No conversations found.")
                                : archived
                                  ? t("No archived conversations.")
                                  : t(
                                      "Keep a separate topic here. Your main chat is always available.",
                                    )}
                            </Text>
                          )}
                        <ErrorNotice error={threads.fetchMoreError?.message} />
                        {threads.hasMoreThreads && (
                          <Button
                            small
                            busy={threads.isFetchingMoreThreads}
                            onPress={threads.fetchMoreThreads}
                          >
                            {t("Load more conversations")}
                          </Button>
                        )}
                      </>
                    )}
                  </>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ThreadMenuRow({
  title,
  icon: Icon,
  selected,
  onPress,
  action,
  disabled,
}: {
  title: string;
  icon?: typeof MessageCircle;
  selected?: boolean;
  onPress: () => void;
  action?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderRadius: 11,
        backgroundColor: selected ? "#EEEEF0" : "transparent",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: !!selected, disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 38,
          paddingHorizontal: 10,
          borderRadius: 11,
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed ? "#E8E8EA" : "transparent",
        })}
      >
        {Icon && <Icon size={17} strokeWidth={1.6} color={colors.text} />}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: colors.text }}>
          {title}
        </Text>
      </Pressable>
      {action}
    </View>
  );
}
