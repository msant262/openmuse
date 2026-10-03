import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

function fixture(contextual: boolean, onQuote?: () => void) {
  return componentHarness(
    new URL("../apps/mobile/src/message-bubble.tsx", import.meta.url),
    "MessageBubble",
    {
      "react-native": { View: "View", Pressable: "Pressable", Platform: { OS: "web" } },
      "lucide-react-native": { Quote: "Quote" },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./ui": { colors: { blue: "blue", muted: "gray" } },
    },
    { contextual, onQuote, user: false, children: "A message" },
  );
}

function quote(view: ReturnType<typeof fixture>) {
  const node = view.nodes().find((item) => item.props.accessibilityLabel === "Quote text");
  assert.ok(node);
  return node.props as {
    onFocus: () => void;
    onBlur: () => void;
    onPress: () => void;
    style: (state: { pressed: boolean }) => { opacity: number };
  };
}

test("keyboard focus reveals the contextual quote action and activation keeps its actual handler", () => {
  let quoted = 0;
  const view = fixture(true, () => quoted++);
  try {
    view.render();
    assert.equal(quote(view).style({ pressed: false }).opacity, 0);
    quote(view).onFocus();
    view.render();
    assert.equal(quote(view).style({ pressed: false }).opacity, 1);
    quote(view).onPress();
    assert.equal(quoted, 1);
    quote(view).onBlur();
    view.render();
    assert.equal(quote(view).style({ pressed: false }).opacity, 0);
  } finally {
    view.close();
  }
});

test("touch layouts keep quotation discoverable and messages without quotation have no action", () => {
  const touch = fixture(false, () => {});
  const plain = fixture(true);
  try {
    touch.render();
    assert.ok(quote(touch).style({ pressed: false }).opacity > 0);
    plain.render();
    assert.equal(
      plain.nodes().some((item) => item.props.accessibilityLabel === "Quote text"),
      false,
    );
  } finally {
    touch.close();
    plain.close();
  }
});
