import {
  ArrowDownToLine,
  CalendarDays,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe2,
  Link2,
  Mail,
  Presentation,
  Sheet as SheetIcon,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, Chip, ErrorNotice, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type ConnectedGoogleAccount = {
  account: string;
  connectionId: string;
  capabilities: string[];
  isDefault: boolean;
};
type GoogleAccount = {
  connected: boolean;
  account?: string;
  connectionId?: string;
  accounts?: ConnectedGoogleAccount[];
};
const accountFingerprint = (value: GoogleAccount) =>
  JSON.stringify([value.connectionId, value.accounts]);
export function NativeConnections({ query }: { query: string }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { workspace: w, api, refresh, notify, open } = useWorkspace();
  const lastConnection = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<"gmail" | "googlecalendar">();
  const [nativeConfigured, setNativeConfigured] = useState(w.mode === "sample");
  const [accounts, setAccounts] = useState<ConnectedGoogleAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const google = w.connections.find((c) => c.id === "google");
  const connected = google?.status === "connected" || google?.status === "sample";
  async function checkNative() {
    const configured =
      w.mode === "sample" ||
      (await api.request<{ configured: boolean }>("/api/google/status")).configured;
    setNativeConfigured(configured);
    return configured;
  }
  async function selectGoogle(toolkit: "gmail" | "googlecalendar") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await checkNative();
      if (w.mode !== "sample") {
        const value = await api.request<GoogleAccount>("/api/google/account");
        lastConnection.current = accountFingerprint(value);
        setAccounts(value.accounts ?? []);
      }
      setSelected(toolkit);
    } catch {
      setError(t("Could not check the connection. We will try again."));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!selected || w.mode === "sample") return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const account = await api.request<GoogleAccount>("/api/google/account");
        if (active && accountFingerprint(account) !== lastConnection.current) {
          await refresh();
          if (active) {
            lastConnection.current = accountFingerprint(account);
            setAccounts(account.accounts ?? []);
          }
        }
      } catch {
        /* A transient read does not discard the pending authorization. */
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 2500);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    return () => {
      active = false;
      clearInterval(timer);
      foreground.remove();
    };
  }, [selected, api, refresh, w.mode]);
  async function connect(capability: "read" | "write", connectionId?: string) {
    // Open during the tap: awaiting the API first lets mobile browsers block OAuth.
    const popup =
      Platform.OS === "web" && w.mode !== "sample" ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    setBusy(true);
    setError("");
    try {
      if (!(await checkNative())) {
        throw new Error(
          t(
            "Google sign-in is not enabled on this server yet. The administrator needs to finish the app setup.",
          ),
        );
      }
      const result = await api.request<{ url: string | null; connected?: boolean }>(
        "/api/google/connect",
        { capability, add: true, ...(connectionId ? { connectionId } : {}) },
      );
      if (result.url) {
        const authorization = new URL(result.url);
        if (authorization.origin !== "https://accounts.google.com")
          throw new Error(t("Could not open Google sign-in. Try again."));
        if (Platform.OS === "web") {
          if (popup) popup.location.href = authorization.href;
          else window.location.assign(authorization.href);
        } else await Linking.openURL(authorization.href);
        notify(t("Choose your Google account. This screen updates when you return."));
      } else {
        await refresh();
        notify(t("Local Google data is ready."));
      }
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(connectionId?: string) {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/disconnect", { connectionId });
      if (w.mode !== "sample")
        setAccounts((await api.request<GoogleAccount>("/api/google/account")).accounts ?? []);
      await refresh();
      notify(t("Google disconnected."));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(connectionId: string) {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/default", { connectionId });
      setAccounts((await api.request<GoogleAccount>("/api/google/account")).accounts ?? []);
      await refresh();
      notify(t("Default Google account updated."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const rows = [
    { id: "gmail", name: "Gmail", icon: Mail, color: colors.danger, connected, group: "google" },
    {
      id: "googlecalendar",
      name: "Google Calendar",
      icon: CalendarDays,
      color: colors.blueDark,
      connected,
      group: "google",
    },
    ...[
      { id: "googledrive", name: "Google Drive", icon: FolderOpen },
      { id: "googledocs", name: "Google Docs", icon: FileText },
      { id: "googlesheets", name: "Google Sheets", icon: SheetIcon },
      { id: "googleslides", name: "Google Slides", icon: Presentation },
    ].map((row) => ({
      ...row,
      color: colors.blueDark,
      group: "google",
      connected:
        connected &&
        (w.mode === "sample" ||
          w.connections.some(
            (connection) =>
              (connection.id === "google" || connection.id.startsWith("google:")) &&
              connection.capabilities.some((capability) =>
                /auth\/(drive|documents|spreadsheets|presentations)(\.|$)/.test(capability),
              ),
          )),
    })),
    {
      id: "browser",
      name: "Agent computer",
      icon: Globe2,
      color: colors.blueDark,
      connected: w.connections.some((c) => c.id === "browser" && c.status === "connected"),
      group: "browser",
    },
  ].filter((row) =>
    `${row.name} ${t(row.name)} ${row.group}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <View style={{ gap: 24 }}>
      {!selected && <ErrorNotice error={error} />}
      {[true, false].map((isConnected) => {
        const group = rows.filter((row) => row.connected === isConnected);
        if (!group.length) return null;
        return (
          <View key={String(isConnected)} style={{ gap: 8 }}>
            <Text style={[s.muted, { fontSize: 13 }]}>
              {isConnected
                ? w.mode === "sample"
                  ? t("Your connections")
                  : t("Connected")
                : t("Available")}
            </Text>
            <View
              style={{ paddingHorizontal: 16, borderRadius: 16, backgroundColor: colors.subtle }}
            >
              {group.map((row, index) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={t("Manage {name}", { name: t(row.name) })}
                  disabled={row.group === "google" && busy}
                  onPress={() =>
                    row.group === "browser"
                      ? open({ type: "computer" })
                      : void selectGoogle(row.id === "gmail" ? "gmail" : "googlecalendar")
                  }
                  style={[
                    s.row,
                    {
                      gap: 11,
                      minHeight: 49,
                      borderBottomWidth: index < group.length - 1 ? 1 : 0,
                      borderBottomColor: colors.line,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 7,
                      backgroundColor: colors.card,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <row.icon size={20} color={row.color} strokeWidth={1.8} />
                  </View>
                  <Text style={[s.text, { flex: 1, fontSize: 13 }]}>{t(row.name)}</Text>
                  {row.connected && row.group === "google" && w.mode === "sample" && (
                    <Text style={s.small}>{t("Local data")}</Text>
                  )}
                  {row.connected ? (
                    <ChevronRight size={16} color={colors.muted} />
                  ) : (
                    <Text
                      style={{
                        fontSize: 13,
                        color: row.group === "google" ? colors.blueDark : colors.muted,
                      }}
                    >
                      {row.group === "google" ? t("Connect") : t("Setup")}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
      {selected && (
        <Sheet
          title={t("Google connections")}
          subtitle={google?.account}
          onClose={() => setSelected(undefined)}
        >
          <View style={{ gap: 18 }}>
            <Text style={s.muted}>
              {t(
                "Connect Gmail, Calendar, Drive, Docs, Sheets and Slides to read, send and manage your work. Each account stays connected independently.",
              )}
            </Text>
            <ErrorNotice error={error} />
            {accounts.map((account) => (
              <View
                key={account.connectionId}
                style={{ gap: 12, padding: 16, borderRadius: 16, backgroundColor: colors.subtle }}
              >
                <Text style={[s.text, { fontWeight: "600" }]}>{account.account}</Text>
                {account.isDefault && <Text style={s.small}>{t("Default account")}</Text>}
                <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                  {account.capabilities.map((cap) => (
                    <Chip key={cap}>{t(capabilityLabel(cap))}</Chip>
                  ))}
                </View>
                {!account.isDefault && (
                  <Button small busy={busy} onPress={() => void setDefault(account.connectionId)}>
                    {t("Use as default")}
                  </Button>
                )}
                {!["gmail.modify", "calendar", "drive"].every((scope) =>
                  account.capabilities.includes(`https://www.googleapis.com/auth/${scope}`),
                ) && (
                  <Button
                    small
                    busy={busy}
                    onPress={() => void connect("write", account.connectionId)}
                  >
                    {t("Enable Google Workspace access")}
                  </Button>
                )}
                <Button
                  small
                  danger
                  busy={busy}
                  onPress={() => void disconnect(account.connectionId)}
                >
                  {t("Disconnect this account")}
                </Button>
              </View>
            ))}
            {nativeConfigured ? (
              <Button busy={busy} primary icon={Link2} onPress={() => void connect("write")}>
                {t(connected ? "Add another Google account" : "Connect Google")}
              </Button>
            ) : (
              <Text style={s.muted}>
                {t(
                  "Google sign-in is not enabled on this server yet. The administrator needs to finish the app setup.",
                )}
              </Text>
            )}
            {w.mode === "sample" && connected && (
              <Button busy={busy} danger onPress={() => void disconnect()}>
                {t("Disconnect Google")}
              </Button>
            )}
            <Button
              small
              icon={ArrowDownToLine}
              onPress={() => void refresh().catch((e) => setError(String(e)))}
            >
              {t("Refresh connections")}
            </Button>
          </View>
        </Sheet>
      )}
    </View>
  );
}
function capabilityLabel(value: string) {
  const scope = value.split("/").at(-1) || value;
  const names: Record<string, string> = {
    "gmail.readonly": "Read Gmail",
    "gmail.send": "Send Gmail",
    "gmail.modify": "Manage Gmail and drafts",
    "calendar.events.readonly": "Read calendar events",
    "calendar.calendarlist.readonly": "Read calendar list",
    "calendar.events": "Manage calendar events",
    "calendar.readonly": "Read calendars",
    calendar: "Manage calendars",
    "drive.readonly": "Read Drive and documents",
    drive: "Manage Drive, Docs, Sheets and Slides",
  };
  return names[scope] || scope;
}
