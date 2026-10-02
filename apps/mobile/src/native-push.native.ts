import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { MuseApi } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
type Preference = { id: string; enabled: boolean };
function preference(): Preference {
  const file = new File(Paths.document, "native-push.json");
  if (file.exists) {
    try {
      const data = JSON.parse(file.textSync());
      if (typeof data.id === "string" && typeof data.enabled === "boolean") return data;
    } catch {}
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const value = {
    id: Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""),
    enabled: false,
  };
  file.write(JSON.stringify(value));
  return value;
}
function save(value: Preference) {
  new File(Paths.document, "native-push.json").write(JSON.stringify(value));
}
async function register(api: MuseApi, pref: Preference, token?: string) {
  const native = token ?? (await Notifications.getDevicePushTokenAsync()).data;
  return api.request<{ configured: boolean }>("/api/agent/push/devices", {
    installationId: pref.id,
    platform: Platform.OS,
    token: native,
  });
}
export async function enableNativePush(api: MuseApi, enabled: boolean): Promise<string> {
  const pref = preference();
  if (!enabled) {
    save({ ...pref, enabled: false });
    await api.request(`/api/agent/push/devices/${pref.id}/delete`, {});
    return "Phone notifications disabled. In-app updates remain available.";
  }
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("openmuse", {
      name: "OpenMuse",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted)
    return "Notifications are disabled in your phone settings. In-app updates remain available.";
  const result = await register(api, pref);
  save({ ...pref, enabled: true });
  return result.configured
    ? "Phone notifications enabled."
    : "Phone registered. Server notification credentials are not configured; in-app updates remain available.";
}
export function startNativePush(api: MuseApi, tap: (taskId?: string) => void): () => void {
  let stopped = false;
  const pref = preference();
  void (async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (stopped || !pref.enabled || !permission.granted) return;
    const token = (await Notifications.getDevicePushTokenAsync()).data;
    if (!stopped) await register(api, pref, token);
  })().catch(() => {});
  const rotation = Notifications.addPushTokenListener((token) => {
    if (!stopped && preference().enabled) void register(api, pref, token.data).catch(() => {});
  });
  const handle = (response: Notifications.NotificationResponse) => {
    const data = response.notification.request.content.data;
    tap(typeof data.taskId === "string" ? data.taskId : undefined);
  };
  const response = Notifications.addNotificationResponseReceivedListener(handle);
  void Notifications.getLastNotificationResponseAsync()
    .then((last) => {
      if (last && !stopped) {
        handle(last);
        void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      }
    })
    .catch(() => {});
  return () => {
    stopped = true;
    rotation.remove();
    response.remove();
    if (preference().enabled)
      void api.request(`/api/agent/push/devices/${pref.id}/delete`, {}).catch(() => {});
  };
}
