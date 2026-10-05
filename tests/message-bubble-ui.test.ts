import assert from "node:assert/strict";
import { test } from "node:test";
import { reactionEmojis } from "../packages/domain/src/conversation-social.ts";
import { componentHarness } from "./helpers/component.ts";

function fixture(
  contextual: boolean,
  onQuote?: () => void,
  clipboard?: (text: string) => Promise<void>,
) {
  return componentHarness(
    new URL("../apps/mobile/src/message-bubble.tsx", import.meta.url),
    "MessageBubble",
    {
      "../../../packages/domain/src/conversation-social": { reactionEmojis },
      "react-native": {
        View: "View",
        Pressable: "Pressable",
        Modal: "Modal",
        Text: "Text",
        Platform: { OS: "web" },
        StyleSheet: { absoluteFill: {}, hairlineWidth: 1 },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
      },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
      "lucide-react-native": {
        Check: "Check",
        Copy: "Copy",
        MoreHorizontal: "MoreHorizontal",
        Reply: "Reply",
        Share2: "Share2",
        SmilePlus: "SmilePlus",
      },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./ui": { colors: { blue: "blue", muted: "gray" }, s: { small: {} } },
    },
    { contextual, onQuote, user: false, text: "A message", children: "A message" },
    { navigator: { clipboard: { writeText: clipboard || (async () => {}) } } },
  );
}

function overflow(view: ReturnType<typeof fixture>) {
  const node = view
    .nodes()
    .find(
      (item) => item.props.accessibilityLabel === "Message actions" && item.type === "Pressable",
    );
  assert.ok(node);
  return node.props as {
    onFocus: () => void;
    onBlur: () => void;
    onPress: () => void;
    style: (state: { pressed: boolean }) => { opacity: number };
  };
}
function attachAnchor(view: ReturnType<typeof fixture>) {
  const ref = view.nodes().find((item) => item.props.ref)?.props.ref as { current: unknown };
  assert.ok(ref);
  ref.current = {
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(16, 120, 310, 70),
  };
}
function action(view: ReturnType<typeof fixture>, label: string) {
  const node = view.nodes().find((item) => item.props.label === label);
  assert.ok(node, `Missing message action: ${label}`);
  return node.props as { onPress: () => void };
}

test("keyboard focus reveals message actions and Reply invokes the existing quotation handler", () => {
  let quoted = 0;
  const view = fixture(true, () => quoted++);
  try {
    view.render();
    attachAnchor(view);
    assert.equal(overflow(view).style({ pressed: false }).opacity, 0.65);
    overflow(view).onFocus();
    view.render();
    assert.equal(overflow(view).style({ pressed: false }).opacity, 1);
    overflow(view).onPress();
    view.render();
    assert.ok(view.nodes().some((node) => node.type === "Modal"));
    action(view, "Reply").onPress();
    view.render();
    assert.equal(quoted, 1);
    assert.equal(
      view.nodes().some((node) => node.type === "Modal"),
      false,
    );
    overflow(view).onBlur();
    view.render();
    assert.equal(overflow(view).style({ pressed: false }).opacity, 0.65);
  } finally {
    view.close();
  }
});

test("touch actions remain discoverable and long press opens Copy and Share without inventing a reply handler", () => {
  const view = fixture(false);
  try {
    view.render();
    attachAnchor(view);
    assert.ok(overflow(view).style({ pressed: false }).opacity > 0);
    const bubble = view.nodes().find((node) => typeof node.props.onLongPress === "function");
    assert.ok(bubble);
    (bubble.props.onLongPress as () => void)();
    view.render();
    assert.ok(action(view, "Copy"));
    assert.ok(action(view, "Share"));
    assert.equal(
      view.nodes().some((node) => node.props.label === "Reply"),
      false,
    );
  } finally {
    view.close();
  }
});

test("Copy and unsupported web sharing copy the actual message, while clipboard errors never claim success", async () => {
  const copied: string[] = [];
  const view = fixture(true, undefined, async (text) => {
    copied.push(text);
  });
  const failed = fixture(true, undefined, async () => {
    throw new Error("Permission denied");
  });
  try {
    view.render();
    attachAnchor(view);
    overflow(view).onPress();
    view.render();
    action(view, "Copy").onPress();
    await view.flush();
    assert.deepEqual(copied, ["A message"]);
    assert.ok(action(view, "Copied"));
    action(view, "Share").onPress();
    await view.flush();
    assert.deepEqual(copied, ["A message", "A message"]);
    failed.render();
    attachAnchor(failed);
    overflow(failed).onPress();
    failed.render();
    action(failed, "Copy").onPress();
    await failed.flush();
    assert.match(failed.text(), /Could not copy this message/);
    assert.equal(
      failed.nodes().some((node) => node.props.label === "Copied"),
      false,
    );
  } finally {
    view.close();
    failed.close();
  }
});

test("reaction menu selects an emoji and only the user's reaction chip can toggle it", () => {
  const selected: unknown[] = [];
  const view = fixture(true);
  try {
    const props = {
      contextual: true,
      user: false,
      text: "A message",
      children: "A message",
      onReact: (emoji: unknown) => selected.push(emoji),
      reactions: [
        { id: "user", messageId: "m", threadId: "chat", actor: "user", emoji: "❤️" },
        { id: "companion", messageId: "m", threadId: "chat", actor: "assistant", emoji: "👍" },
      ],
    };
    view.render(props);
    attachAnchor(view);
    const mine = view
      .nodes()
      .find((node) => node.props.accessibilityLabel === "Your reaction: {emoji}");
    const companion = view
      .nodes()
      .find((node) => node.props.accessibilityLabel === "Companion reaction: {emoji}");
    assert.ok(mine);
    assert.ok(companion);
    assert.equal(mine.props.disabled, false);
    assert.equal(companion.props.disabled, true);
    (mine.props.onPress as () => void)();
    assert.deepEqual(selected, ["❤️"]);
    overflow(view).onPress();
    view.render();
    const emoji = view.nodes().find((node) => node.props["aria-selected"] === true);
    assert.ok(emoji);
    (emoji.props.onPress as () => void)();
    view.render();
    assert.deepEqual(selected, ["❤️", "❤️"]);
    assert.equal(
      view.nodes().some((node) => node.type === "Modal"),
      false,
    );
  } finally {
    view.close();
  }
});
