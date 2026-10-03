import { displayJevUserMessage } from "./jev-actions";

export function isEmptyConversationCache(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw);
    const empty = (items: unknown) => Array.isArray(items) && items.length === 0;
    return (
      value?.version === 1 &&
      empty(value.messages) &&
      empty(value.pending) &&
      typeof value.draft?.text === "string" &&
      !value.draft.text.trim() &&
      empty(value.draft.attachmentIds) &&
      empty(value.draft.annotations)
    );
  } catch {
    return false;
  }
}

/** Read a display label only; this never changes a saved transcript or unsent draft. */
export function cachedConversationTitle(raw: string | null): string | undefined {
  if (!raw) return;
  try {
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached?.messages)) return;
    const messages = cached.messages as unknown[];
    const index = messages.findIndex(
      (message) =>
        !!message &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "user" &&
        "content" in message &&
        typeof message.content === "string" &&
        !!message.content.trim(),
    );
    if (index < 0) return;
    const message = messages[index] as { content: string };
    const title = displayJevUserMessage(message.content, messages.slice(0, index))
      .split("\n\nAttached documents:")[0]
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return;
    return title.length > 64 ? `${title.slice(0, 64)}…` : title;
  } catch {
    return;
  }
}
