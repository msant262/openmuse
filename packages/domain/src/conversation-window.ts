import type { Message } from "@ag-ui/core";

/** A display page only. The server retains the complete transcript and model context. */
export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_EVENT_CACHE_SIZE = 200;

export type RecentChatPage = {
  messages: Message[];
  previousCursor?: string;
  snapshotRequired: boolean;
};

export function mergeChatHistory<T extends { id: string }>(
  older: readonly T[],
  recent: readonly T[],
) {
  const ids = new Set(recent.map((message) => message.id));
  return [...older.filter((message) => !ids.has(message.id)), ...recent];
}
