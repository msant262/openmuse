import assert from "node:assert/strict";
import test from "node:test";
import * as state from "../apps/mobile/src/proactivity-state.ts";
import type { ProactivitySuggestion } from "../packages/domain/src/proactivity.ts";
import { componentHarness } from "./helpers/component.ts";

const suggestion: ProactivitySuggestion = {
  id: "alert",
  semanticKey: "mail:one",
  cycleId: "cycle",
  threadId: "chat",
  requestId: "request",
  revision: 1,
  title: "Alerta de segurança",
  reason: "Confirme o novo acesso",
  prompt: "Confirme o novo acesso",
  target: { kind: "memory", memoryId: "memory", revision: 1 },
  evidence: [
    {
      id: "source",
      kind: "mail",
      title: "Google",
      excerpt: "LONG PRIVATE EMAIL BODY",
      acquiredAt: "2026-10-06T12:00:00Z",
    },
  ],
  status: "pending",
  createdAt: "2026-10-06T12:00:00Z",
  updatedAt: "2026-10-06T12:00:00Z",
};
function fixture(
  name = "ProactivityAlerts",
  props: Record<string, unknown> = { suggestions: [suggestion] },
) {
  const values = new Map<string, string>();
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    update: async (key: string, change: (old: string | null) => string) => {
      const value = change(values.get(key) ?? null);
      values.set(key, value);
      return value;
    },
  };
  return componentHarness(
    new URL("../apps/mobile/src/proactivity-card.tsx", import.meta.url),
    name,
    {
      "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
      "lucide-react-native": {
        Bell: "Bell",
        ChevronRight: "ChevronRight",
        ChevronDown: "ChevronDown",
      },
      "./i18n": {
        useI18n: () => ({
          t: (text: string, vars?: Record<string, number>) =>
            text.replace("{count}", String(vars?.count)),
          locale: "en",
        }),
      },
      "./workspace": {
        useWorkspace: () => ({
          api: {
            identityKey: "owner",
            request: async () => ({
              suggestion: { ...suggestion, status: "resolved", revision: 2 },
            }),
          },
          open: () => {},
        }),
      },
      "./agent-workspace": { useAgentWorkspace: () => ({ data: { tasks: [] } }) },
      "./message-storage": { messageStorage: storage },
      "./proactivity-state": state,
      "./ui": {
        Card: "Card",
        Button: "Button",
        ErrorNotice: "ErrorNotice",
        Field: "Field",
        Sheet: "Sheet",
      },
    },
    props,
  );
}
test("chat renders one compact bar and no evidence until opened; closed alerts stay out of chat", () => {
  const view = fixture("ProactivityAlerts", {
    suggestions: [
      suggestion,
      { ...suggestion, id: "two" },
      { ...suggestion, id: "resolved", status: "resolved" },
    ],
  });
  view.render();
  assert.doesNotMatch(view.text(), /LONG PRIVATE EMAIL BODY|Confirme o novo acesso/);
  assert.equal(view.nodes().filter((n) => n.type === "Pressable").length, 1);
  const trigger = view.nodes().find((n) => n.type === "Pressable")!;
  (trigger.props.onPress as () => void)();
  view.render();
  assert.ok(view.nodes().some((n) => n.type === "Sheet"));
  assert.doesNotMatch(
    view.text(),
    /LONG PRIVATE EMAIL BODY/,
    "alert details are only mounted on selection",
  );
  view.render({
    suggestions: [
      { ...suggestion, status: "resolved" },
      { ...suggestion, status: "snoozed" },
      { ...suggestion, status: "accepted" },
    ],
  });
  assert.equal(view.nodes().length, 0);
});
test("a confirmed resolution immediately leaves the pending list without waiting for a poll", () => {
  const view = fixture();
  view.render();
  (view.nodes().find((n) => n.type === "Pressable")!.props.onPress as () => void)();
  view.render();
  const list = view.nodes().find((n) => typeof n.props.onAnswered === "function")!;
  (list.props.onAnswered as (s: ProactivitySuggestion) => void)({
    ...suggestion,
    status: "resolved",
    revision: 2,
  });
  view.render();
  assert.equal(view.nodes().length, 0);
  view.render({ suggestions: [suggestion] });
  assert.equal(view.nodes().length, 0, "a stale poll cannot resurrect an acknowledged alert");
  view.render({ suggestions: [{ ...suggestion, revision: 3, requestId: "new-request" }] });
  assert.equal(view.nodes().filter((n) => n.type === "Pressable").length, 1);
});
test("the actual card forwards the confirmed server revision to its container", async () => {
  let result: ProactivitySuggestion | undefined;
  const view = fixture("ProactivityCard", {
    suggestion,
    onAnswered: (s: ProactivitySuggestion) => {
      result = s;
    },
  });
  view.render();
  view.button("Resolved").onPress();
  await view.flush();
  assert.equal(result?.status, "resolved");
  assert.equal(result?.revision, 2);
});
