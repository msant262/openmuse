import assert from "node:assert/strict";
import test from "node:test";
import * as promptState from "../apps/mobile/src/credential-prompts-state.ts";
import type { CredentialInteractionRequest } from "../packages/domain/src/runtime.ts";
import { componentHarness } from "./helpers/component.ts";

test("credential polling keeps the chat's controller stable while showing a new form", async () => {
  let requests: CredentialInteractionRequest[] = [];
  const api = {
    identityKey: "owner",
    request: async () => ({ requests: structuredClone(requests) }),
  };
  let poll: (() => void) | undefined;
  const view = componentHarness(
    new URL("../apps/mobile/src/credential-prompts.tsx", import.meta.url),
    "CredentialPromptsProvider",
    {
      "lucide-react-native": { KeyRound: "KeyRound", ShieldCheck: "ShieldCheck", X: "X" },
      "react-native": {
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
        Platform: { OS: "android" },
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        useWindowDimensions: () => ({ width: 400 }),
      },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0 }) },
      "./agent-workspace": { useAgentWorkspace: () => ({ refresh: async () => {} }) },
      "./composio-connection": { ComposioConnectionContent: "ComposioConnectionContent" },
      "./credential-prompts-state": promptState,
      "./credential-request": { CredentialRequestCard: "CredentialRequestCard" },
      "./i18n": { useI18n: () => ({ t: (value: string) => value }) },
      "./ui": { Button: "Button", IconButton: "IconButton", ModalSurface: "ModalSurface" },
      "./workspace": { useWorkspace: () => ({ api, notify() {}, navigate() {} }) },
    },
    { children: "Chat" },
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
  try {
    view.render();
    await view.flush();
    const controller = view.nodes()[0].props.value;
    for (let n = 0; n < 5; n++) {
      poll?.();
      await view.flush();
      assert.equal(
        view.nodes()[0].props.value,
        controller,
        "an unchanged credential queue must not invalidate every chat consumer",
      );
    }
    requests = [
      {
        id: "new-form",
        taskId: "settings",
        revision: 1,
        kind: "credential",
        status: "waiting",
        createdAt: "2026-10-10T16:00:00Z",
        schema: {
          title: "Connect service",
          serviceName: "Mail account",
          origin: "https://mail.example",
          purpose: "Read requested email",
          fields: [],
        },
      },
    ] as CredentialInteractionRequest[];
    poll?.();
    await view.flush();
    assert.equal(view.nodes()[0].props.value, controller);
    const card = view.nodes().find((node) => node.type === "CredentialRequestCard");
    assert.equal((card?.props.request as CredentialInteractionRequest)?.id, "new-form");
    assert.match(view.text(), /Mail account/);
  } finally {
    view.close();
  }
});
