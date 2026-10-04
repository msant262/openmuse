import {
  FileText,
  FolderOpen,
  Globe2,
  Monitor,
  Plus,
  RefreshCw,
  Terminal,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Image, Pressable, ScrollView, Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import { attachmentLabel } from "../../../packages/domain/src/attachments";
import { browserAddress } from "./browser-address";
import { useComputerDraft } from "./computer-drafts";
import { LinuxWorkspace } from "./computer-workspace";
import { DesktopViewer } from "./desktop";
import { useI18n } from "./i18n";
import { useInlinePreview } from "./preview";
import { Button, Card, ErrorNotice, Field, LinkRow, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function ComputerEntry({ compact = false }: { compact?: boolean } = {}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { workspace, open } = useWorkspace();
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  const active = workspace.browsers.filter((b) => b.status === "active").length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Agent computer — take control")}
      onPress={() => open({ type: "computer" })}
      style={[
        s.row,
        {
          alignSelf: "center",
          gap: 6,
          paddingHorizontal: compact ? 10 : 12,
          paddingVertical: compact ? 10 : 7,
          borderRadius: 20,
          backgroundColor: compact ? "transparent" : colors.subtle,
        },
      ]}
    >
      <Monitor size={compact ? 20 : 13} color={colors.muted} />
      {!compact && (
        <Text style={{ fontSize: 12, color: colors.muted }}>
          {t("Computer")}
          {` · ${!available ? t("Offline") : active ? t("Take control") : t("Ready")}`}
        </Text>
      )}
      {!compact && (
        <View
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            backgroundColor: available ? "#57AD85" : colors.hover,
          }}
        />
      )}
    </Pressable>
  );
}
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const previewVisible = useInlinePreview();
  const { open } = useWorkspace();
  const [, setTab] = useComputerDraft("tab");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  return (
    <Card
      style={{ padding: 13, backgroundColor: colors.subtle, gap: 12, maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>{t("Browser")}</Text>
          <Text numberOfLines={1} style={s.small}>
            {browser.status === "closed"
              ? t("Session saved")
              : browser.status === "error"
                ? t("Needs attention")
                : browser.title}
          </Text>
        </View>
      </View>
      {previewVisible && browser.previewUrl && browser.status === "active" && !failed ? (
        <Image
          accessibilityLabel={t("Browser preview: {title}", { title: browser.title })}
          source={{ uri: browser.previewUrl }}
          style={{
            width: "100%",
            aspectRatio: 1.6,
            borderRadius: 11,
            backgroundColor: colors.card,
          }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: colors.card,
            alignItems: "center",
            gap: 10,
          }}
        >
          <Globe2 size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed ? t("Preview unavailable. Open the browser to reconnect.") : browser.url}
          </Text>
        </View>
      )}
      <Button
        onPress={() => {
          if (browser.desktopSessionId) {
            setTab("Desktop");
            open({ type: "computer" });
          } else open({ type: "browser", browser });
        }}
      >
        {browser.status === "closed"
          ? t("Reopen browser")
          : browser.status === "error"
            ? t("Reconnect browser")
            : t("Take control")}
      </Button>
    </Card>
  );
}
export function ComputerSheet({ embedded = false }: { embedded?: boolean } = {}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { workspace, api, refresh, close, open, navigate } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useComputerDraft("tab");
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
      });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={t("Agent computer")}
      embedded={embedded}
      onClose={close}
      wide
      scroll={false}
      contentStyle={{ padding: 0 }}
    >
      <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 }}>
        <View
          style={[s.row, { gap: 3, padding: 4, borderRadius: 24, backgroundColor: colors.subtle }]}
        >
          {(["Desktop", "Browser", "Terminal", "Files"] as const).map((item) => {
            const Icon =
              item === "Desktop"
                ? Monitor
                : item === "Browser"
                  ? Globe2
                  : item === "Terminal"
                    ? Terminal
                    : FolderOpen;
            return (
              <Pressable
                key={item}
                accessibilityRole="tab"
                accessibilityLabel={t(item)}
                aria-selected={tab === item}
                onPress={() => setTab(item)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 36,
                  paddingHorizontal: 6,
                  flexDirection: "row",
                  gap: 5,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 19,
                  backgroundColor: tab === item ? colors.card : "transparent",
                }}
              >
                <Icon
                  size={15}
                  color={tab === item ? colors.text : colors.muted}
                  strokeWidth={1.7}
                />
                <Text
                  numberOfLines={1}
                  style={{ color: tab === item ? colors.text : colors.muted, fontSize: 12 }}
                >
                  {t(item)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20, paddingTop: 8 }}
      >
        <View style={{ gap: 18 }}>
          {tab === "Browser" && (
            <Text style={s.small}>{available ? t("Browser connected") : t("Browser offline")}</Text>
          )}
          <View style={{ display: tab === "Browser" || tab === "Desktop" ? "none" : "flex" }}>
            <LinuxWorkspace tab={tab === "Files" ? "Files" : "Terminal"} />
          </View>
          <ErrorNotice error={t(error)} />
          {tab === "Desktop" && <DesktopViewer embedded={embedded} />}
          {tab === "Browser" ? (
            <>
              <View>
                <Field
                  label={t("Website address")}
                  value={url}
                  onChangeText={setUrl}
                  placeholder="https://example.com"
                  autoCapitalize="none"
                  keyboardType="url"
                  onSubmitEditing={() => void create()}
                />
                <Button
                  primary
                  icon={Plus}
                  busy={busy}
                  disabled={!available || !url.trim()}
                  onPress={() => void create()}
                >
                  {t("Open a browser session")}
                </Button>
              </View>
              {[...workspace.browsers]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((browser) => (
                  <BrowserThreadCard key={browser.id} browser={browser} />
                ))}
              {!workspace.browsers.length && (
                <Text style={s.muted}>
                  {t(
                    "Open a page here or ask your agent to research something. Its browsing sessions will appear here.",
                  )}
                </Text>
              )}
              <Text style={s.small}>
                {t(
                  "Browsing sessions keep their own logins and downloads. Open one to take over, then return to your conversation.",
                )}
              </Text>
            </>
          ) : tab === "Files" ? (
            <>
              <Text style={s.heading}>{t("Documents")}</Text>
              <Text style={s.small}>{t("Files saved from your agent, mail and uploads.")}</Text>
              {workspace.files.map((file) => (
                <LinkRow
                  key={file.id}
                  icon={FileText}
                  title={file.name}
                  detail={attachmentLabel(file)}
                  onPress={() => open({ type: "file", file })}
                />
              ))}
              <Button
                icon={Plus}
                onPress={() => {
                  close();
                  navigate("files");
                }}
              >
                {t("Import a document")}
              </Button>
            </>
          ) : null}
          {!embedded && (
            <Button
              small
              icon={RefreshCw}
              onPress={() =>
                void refresh()
                  .then(() => setError(""))
                  .catch((e) => setError(String(e)))
              }
            >
              {t("Refresh computer")}
            </Button>
          )}
        </View>
      </ScrollView>
    </Sheet>
  );
}
