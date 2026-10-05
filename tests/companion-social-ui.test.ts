import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { MessageOutbox } from "../apps/mobile/src/message-outbox.ts";
import * as socialDomain from "../packages/domain/src/conversation-social.ts";
import { componentHarness } from "./helpers/component.ts";

function fixture(request: (path: string, body?: unknown) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "companion-social-ui-"));
  const source = join(directory, "social.tsx");
  writeFileSync(
    source,
    readFileSync(new URL("../apps/mobile/src/companion-chat.tsx", import.meta.url), "utf8") +
      `
export function SocialHarness(props) {
  const social = useConversationSocial(props.threadId, true, props.outbox, props.messages);
  return <View social={social} />;
}
`,
  );
  const api = { identityKey: "owner-one", request };
  let poll: (() => void) | undefined;
  const view = componentHarness(
    pathToFileURL(source),
    "SocialHarness",
    {
      "./avatar-renderer": { AvatarRenderer: "AvatarRenderer" },
      "expo-crypto": { randomUUID: () => "reaction-request" },
      "../../../packages/domain/src/conversation-social": socialDomain,
      "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View" },
      "./i18n": { useI18n: () => ({ t: (text: string) => text }) },
      "./workspace": { useWorkspace: () => ({ api }) },
    },
    { threadId: "chat", messages: [] },
    {
      setInterval: (callback: () => void) => {
        poll = callback;
        return 1;
      },
      clearInterval: () => {
        poll = undefined;
      },
    },
  );
  return {
    ...view,
    api,
    poll: () => poll?.(),
    social: () =>
      view.nodes()[0].props.social as {
        state: socialDomain.ConversationSocialState;
        error: string;
        react: (id: string, emoji: socialDomain.MessageReaction["emoji"]) => Promise<void>;
      },
    close: () => {
      view.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a new identity cannot render another owner's cached reactions or quotes", async () => {
  const view = fixture(async () => ({
    reactions: [{ id: "r", threadId: "chat", messageId: "m", actor: "user", emoji: "❤️" }],
    messages: [
      {
        messageId: "m",
        text: "Private quote",
        replyTo: { messageId: "source", text: "Private", role: "assistant" },
      },
    ],
  }));
  try {
    view.render();
    await view.flush();
    assert.equal(view.social().state.messages.length, 1);
    view.api.identityKey = "owner-two";
    view.render();
    assert.equal(view.social().state.messages.length, 0);
    assert.equal(view.social().state.reactions.length, 0);
  } finally {
    view.close();
  }
});

test("polling cannot overwrite an in-flight reaction and a failed reaction restores its prior state", async () => {
  let reads = 0;
  let rejectReaction: (cause: Error) => void = () => {};
  const view = fixture(async (_path, body) => {
    if (body)
      return new Promise((_resolve, reject) => {
        rejectReaction = reject;
      });
    reads++;
    return { reactions: [], messages: [] };
  });
  try {
    view.render();
    await view.flush();
    const reaction = view.social().react("m", "❤️");
    view.render();
    assert.equal(view.social().state.reactions[0].emoji, "❤️");
    view.poll();
    await view.flush();
    assert.equal(reads, 1);
    assert.equal(view.social().state.reactions[0].emoji, "❤️");
    rejectReaction(new Error("Offline"));
    await reaction;
    await view.flush();
    assert.equal(view.social().state.reactions.length, 0);
    assert.match(view.social().error, /Could not save/);
    view.poll();
    await view.flush();
    assert.match(view.social().error, /Could not save/);
  } finally {
    view.close();
  }
});

test("an offline sticker quote keeps its local preview when the social read precedes acceptance", async () => {
  let saved: string | null = null;
  const outbox = new MessageOutbox(
    {
      read: async () => saved,
      write: async (_key, value) => {
        saved = value;
      },
      update: async (_key, change) => {
        saved = change(saved);
        return saved;
      },
    },
    "social-preview",
    "chat",
  );
  const replyTo = { messageId: "source", role: "assistant" as const, text: "Ready?" };
  await outbox.enqueue({
    id: "pending",
    text: "Deal!",
    stickerId: "agreed",
    replyToMessageId: "source",
    displayReplyTo: replyTo,
  });
  const view = fixture(async () => ({ messages: [], reactions: [] }));
  try {
    view.render({
      threadId: "chat",
      messages: [{ id: "pending", role: "user", content: "Deal!" }],
      outbox,
    });
    assert.equal(view.social().state.messages[0].stickerId, "agreed");
    await view.flush();
    assert.equal(view.social().state.messages[0].replyTo?.text, "Ready?");
    assert.equal(view.social().state.messages[0].stickerId, "agreed");
  } finally {
    view.close();
  }
});

test("the canonical social response replaces transport annotations and failures remain visible until recovery", async () => {
  let offline = true;
  const view = fixture(async () => {
    if (offline) throw new Error("Offline");
    return { reactions: [], messages: [{ messageId: "m", text: "Thanks!", stickerId: "thanks" }] };
  });
  try {
    view.render({
      threadId: "chat",
      messages: [{ id: "m", role: "user", content: "Thanks!\n[Companion sticker: thanks]" }],
    });
    await view.flush();
    assert.equal(view.social().state.messages.length, 0);
    assert.match(view.social().error, /Reconnecting/);
    offline = false;
    view.poll();
    await view.flush();
    assert.equal(view.social().state.messages[0].text, "Thanks!");
    assert.equal(view.social().state.messages[0].stickerId, "thanks");
    assert.equal(view.social().error, "");
  } finally {
    view.close();
  }
});
