import type { MuseApi } from "./api";
export async function enableNativePush(_api: MuseApi, _enabled: boolean): Promise<string> {
  return "Phone notifications require an iOS or Android development build. In-app updates remain available.";
}
export function startNativePush(_api: MuseApi, _tap: (taskId?: string) => void): () => void {
  return () => {};
}
