import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  type ConversationSocialState,
  companionStickers,
  type GifMessage,
  type MessageQuote,
  type MessageReaction,
  type StickerId,
} from "../../../packages/domain/src/conversation-social";
import { AvatarRenderer } from "./avatar-renderer";
import { useI18n } from "./i18n";
import type { MessageOutbox } from "./message-outbox";
import { useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function CompanionSticker({
  id,
  caption,
  small = false,
}: {
  id: StickerId;
  caption?: string;
  small?: boolean;
}) {
  const { colors } = useUI();
  const { t } = useI18n();
  const sticker = companionStickers.find((item) => item.id === id);
  if (!sticker) return null;
  return (
    <View
      accessibilityLabel={t("Sticker: {name}", { name: caption ?? t(sticker.label) })}
      style={{ alignItems: "center", gap: 4, width: small ? 100 : 156, paddingVertical: 6 }}
    >
      <View>
        <AvatarRenderer
          state={
            sticker.motion === "working"
              ? "thinking"
              : sticker.motion === "responding"
                ? "talking"
                : "idle"
          }
          size={small ? 76 : 128}
          reducedMotion={small ? true : undefined}
        />
        <Text
          style={{
            position: "absolute",
            right: -3,
            bottom: 0,
            fontSize: small ? 24 : 38,
            color: colors.text,
          }}
        >
          {sticker.emoji}
        </Text>
      </View>
      <Text
        style={{
          color: colors.text,
          fontWeight: "600",
          fontSize: small ? 11 : 14,
          textAlign: "center",
        }}
      >
        {caption ?? t(sticker.label)}
      </Text>
    </View>
  );
}

export function CompanionGif({ gif }: { gif: GifMessage }) {
  const { colors } = useUI();
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ gap: 6, maxWidth: 260 }}>
      {!failed && (
        <Image
          source={{ uri: gif.url }}
          accessibilityLabel={gif.alt}
          style={{ width: 240, height: 180, borderRadius: 14 }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      )}
      {(failed || gif.caption) && (
        <Text style={{ color: colors.text }}>{gif.caption ?? gif.alt}</Text>
      )}
    </View>
  );
}

export function MessageQuoteView({
  quote,
  name,
  onPress,
}: {
  quote: MessageQuote;
  name?: string;
  onPress?: () => void;
}) {
  const { colors } = useUI();
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={t("Quoted message: {text}", { text: quote.text })}
      onPress={onPress}
      disabled={!onPress}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: colors.blueDark,
        paddingHorizontal: 10,
        paddingVertical: 7,
        marginBottom: 6,
        borderRadius: 6,
        backgroundColor: colors.raised,
        gap: 3,
      }}
    >
      <Text style={{ color: colors.blueDark, fontWeight: "600", fontSize: 12 }}>
        {quote.role === "user" ? t("You") : (name ?? t("Your companion"))}
      </Text>
      <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        {quote.text}
      </Text>
    </Pressable>
  );
}

export function useConversationSocial(
  threadId: string,
  enabled: boolean,
  outbox?: MessageOutbox,
  transcript: readonly { id: string; role: string; content?: unknown }[] = [],
) {
  const { api } = useWorkspace();
  const empty = (): ConversationSocialState => ({ reactions: [], messages: [] });
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const target = useRef({ api, identity: api.identityKey, threadId });
  const [snapshot, setSnapshot] = useState({ owner: target.current, state: empty() });
  const mutation = useRef(0);
  const changing = useRef(false);
  if (
    target.current.api !== api ||
    target.current.identity !== api.identityKey ||
    target.current.threadId !== threadId
  ) {
    target.current = { api, identity: api.identityKey, threadId };
    mutation.current++;
    changing.current = false;
  }
  const owner = target.current;
  const state = snapshot.owner === owner ? snapshot.state : empty();
  function setState(
    next: ConversationSocialState | ((before: ConversationSocialState) => ConversationSocialState),
  ) {
    setSnapshot((before) => ({
      owner,
      state:
        typeof next === "function" ? next(before.owner === owner ? before.state : empty()) : next,
    }));
  }
  useEffect(() => {
    setError("");
    setLoadError("");
  }, [owner]);
  const userMessages = transcript.filter((message) => message.role === "user");
  const messageIds = JSON.stringify(transcript.map((message) => message.id));
  useEffect(() => {
    let live = true;
    let reading = false;
    const load = async () => {
      if (!enabled || reading || changing.current) return;
      reading = true;
      const version = mutation.current;
      try {
        const ids = JSON.parse(messageIds) as string[];
        const next: ConversationSocialState = { reactions: [], messages: [] };
        // Fetch only the history explicitly loaded on this screen, never the
        // owner's complete inbox. POST keeps long opaque IDs out of URL limits.
        for (let offset = 0; offset < Math.max(1, ids.length); offset += 200) {
          if (!live || target.current !== owner) return;
          const page = await api.request<ConversationSocialState>(
            `/api/conversations/${threadId}/social/window`,
            { messageIds: ids.slice(offset, offset + 200) },
          );
          next.reactions.push(...page.reactions);
          next.messages.push(...page.messages);
        }
        if (live && target.current === owner && version === mutation.current) {
          // A successful social read distinguishes ordinary history from
          // messages with canonical quote/sticker metadata. Until then the
          // transcript must not show the model-facing transport annotations.
          const details = new Map(next.messages.map((message) => [message.messageId, message]));
          for (const message of userMessages) {
            if (
              !details.has(message.id) &&
              !outbox?.getSnapshot().messageDetails.some((item) => item.messageId === message.id) &&
              typeof message.content === "string"
            )
              details.set(message.id, { messageId: message.id, text: message.content });
          }
          const messages = [...details.values()];
          setState({ ...next, messages });
          setLoadError("");
          await outbox?.saveMessageDetails(messages);
        }
      } catch {
        if (live && target.current === owner)
          setLoadError("Could not load message details. Reconnecting…");
      } finally {
        reading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [owner, enabled, outbox, messageIds]);
  async function react(messageId: string, emoji: MessageReaction["emoji"]) {
    if (!enabled || changing.current || target.current !== owner) return;
    changing.current = true;
    mutation.current++;
    setError("");
    const previous = state.reactions.find((r) => r.messageId === messageId && r.actor === "user");
    const nextEmoji = previous?.emoji === emoji ? null : emoji;
    const optimistic: MessageReaction = {
      id: previous?.id ?? `${threadId}:${messageId}:user`,
      threadId,
      messageId,
      actor: "user",
      emoji: nextEmoji,
    };
    const replace = (reactions: MessageReaction[], value: MessageReaction) => [
      ...reactions.filter((r) => r.id !== value.id),
      ...(value.emoji ? [value] : []),
    ];
    setState((before) => ({ ...before, reactions: replace(before.reactions, optimistic) }));
    try {
      const saved = await api.request<MessageReaction>(`/api/conversations/${threadId}/reactions`, {
        requestId: Crypto.randomUUID(),
        messageId,
        emoji: nextEmoji,
      });
      if (target.current === owner)
        setState((before) => ({ ...before, reactions: replace(before.reactions, saved) }));
    } catch {
      if (target.current === owner) {
        setState((before) => ({
          ...before,
          reactions: replace(before.reactions, previous ?? { ...optimistic, emoji: null }),
        }));
        setError("Could not save your reaction. Try again.");
      }
    } finally {
      if (target.current === owner) {
        changing.current = false;
        mutation.current++;
      }
    }
  }
  const messages = new Map(
    outbox?.getSnapshot().messageDetails.map((item) => [item.messageId, item]),
  );
  for (const message of state.messages) messages.set(message.messageId, message);
  return {
    state: { ...state, messages: [...messages.values()] },
    error: error || loadError,
    react,
  };
}
