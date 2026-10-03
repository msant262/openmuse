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
// Consent changes invalidate asynchronous token acquisition immediately. Network mutations
// remain ordered, so Disable/logout cannot finish before an older POST and its DELETE.
let generation = 0;
let session: object | undefined;
let mutations: Promise<unknown> = Promise.resolve();
function ordered<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation);
  mutations = result.catch(() => {});
  return result;
}
async function register(api: MuseApi, version: number, token?: string) {
  const native = token ?? (await Notifications.getDevicePushTokenAsync()).data;
  return ordered(async () => {
    const pref = preference();
    if (version !== generation || !pref.enabled) return undefined;
    return api.request<{ configured: boolean }>("/api/agent/push/devices", {
      installationId: pref.id,
      platform: Platform.OS,
      token: native,
    });
  });
}
function revoke(api: MuseApi, id: string) {
  return ordered(() => api.request(`/api/agent/push/devices/${id}/delete`, {}));
}
export async function enableNativePush(api: MuseApi, enabled: boolean): Promise<string> {
  const version = ++generation;
  const pref = preference();
  if (!enabled) {
    save({ ...pref, enabled: false });
    await revoke(api, pref.id);
    return "Phone notifications disabled. In-app updates remain available.";
  }
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("openmuse", {
      name: "OkamiBot",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  if (version !== generation) return "Notification setting changed.";
  const permission = await Notifications.requestPermissionsAsync();
  if (version !== generation) return "Notification setting changed.";
  if (!permission.granted)
    return "Notifications are disabled in your phone settings. In-app updates remain available.";
  save({ ...pref, enabled: true });
  const result = await register(api, version);
  if (version !== generation || !result) return "Notification setting changed.";
  return result.configured
    ? "Phone notifications enabled."
    : "Phone registered. Server notification credentials are not configured; in-app updates remain available.";
}
export function startNativePush(api: MuseApi, tap: (taskId?: string) => void): () => void {
  let stopped = false;
  const currentSession = {};
  session = currentSession;
  const version = ++generation;
  const pref = preference();
  void (async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (stopped || version !== generation || !preference().enabled || !permission.granted) return;
    await register(api, version);
  })().catch(() => {});
  const rotation = Notifications.addPushTokenListener((token) => {
    if (!stopped && session === currentSession && preference().enabled)
      void register(api, ++generation, token.data).catch(() => {});
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
    if (session === currentSession) {
      session = undefined;
      generation++;
      void revoke(api, pref.id).catch(() => {});
    }
  };
}
