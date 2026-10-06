import assert from "node:assert/strict";
import test from "node:test";
import { delegatedToolResult } from "../apps/mobile/src/delegated-tool-result.ts";
import {
  connectorReviewLines,
  googleActionPresentation,
  withGoogleActionContext,
} from "../apps/mobile/src/external-action-preview.ts";
import { componentHarness } from "./helpers/component.ts";

test("native Google handoffs are recognized independently of the foreground tool name", () => {
  const receipt = { delegated: true, taskId: "owned-task", title: "Write an email" };
  assert.equal(delegatedToolResult(JSON.stringify(receipt))?.taskId, "owned-task");
  assert.equal(delegatedToolResult(receipt)?.taskId, "owned-task");
  for (const result of [
    null,
    "invalid json",
    { taskId: "task" },
    { delegated: true },
    { delegated: true, taskId: "" },
    { delegated: false, taskId: "task" },
  ])
    assert.equal(delegatedToolResult(result), undefined);
});

const draft = {
  id: "draft-card",
  account: "work@example.com",
  connectionId: "work-id",
  draft: {
    to: ["msant262@gmail.com"],
    cc: ["cc@example.com"],
    bcc: [],
    subject: "Visible subject",
    body: "Actual message text",
    attachmentIds: [],
  },
  gmailDraftId: "gmail-draft",
  operation: "save",
  status: "saved",
  updatedAt: "2026-10-06T12:00:00Z",
};
const action = {
  id: "delete-action",
  hash: "exact-prepared-hash",
  status: "awaiting_review",
  kind: "external.action",
  data: {
    tool: "google.workspace",
    account: "work@example.com",
    operation: "gmail.users.drafts.delete",
    requiresHumanApproval: true,
    subject: "Visible subject",
    to: "msant262@gmail.com",
    request: '{"id":"gmail-draft"}',
  },
};
function view(
  name: string,
  props: Record<string, unknown>,
  request: (path: string, body?: any) => Promise<unknown>,
  copied: string[] = [],
) {
  const api = { identityKey: "owner", request };
  const h = componentHarness(
    new URL("../apps/mobile/src/google-workspace-cards.tsx", import.meta.url),
    name,
    {
      "react-native": {
        Text: "Text",
        View: "View",
        Platform: { OS: "web" },
        Clipboard: {},
        Linking: {
          openURL: async (url: string) => {
            copied.push(url);
          },
        },
      },
      "expo-crypto": { randomUUID: () => "stable-click-id" },
      "lucide-react-native": {
        CheckCircle2: "CheckCircle2",
        CircleX: "CircleX",
        Clock3: "Clock3",
        ShieldCheck: "ShieldCheck",
      },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./ui": { Button: "Button", Card: "Card", ErrorNotice: "ErrorNotice" },
      "./workspace": { useWorkspace: () => ({ api, refresh: async () => {} }) },
      "./external-action-preview": {
        connectorReviewLines,
        googleActionPresentation,
        withGoogleActionContext,
      },
    },
    props,
    {
      navigator: {
        clipboard: {
          writeText: async (value: string) => {
            copied.push(value);
          },
        },
      },
      JSON,
      String,
    },
  );
  h.render();
  return h;
}

test("the draft card renders human email fields and all controls; retries retain the operation ID", async () => {
  const calls: any[] = [],
    copied: string[] = [];
  let fail = true;
  const h = view(
    "GoogleMailDraftCard",
    { id: draft.id },
    async (path, body) => {
      if (path.endsWith("/collapse")) return { ...draft, collapsed: true };
      if (body) {
        calls.push({ path, body });
        if (fail) throw new Error("Connection lost");
      }
      return draft;
    },
    copied,
  );
  try {
    await h.flush();
    assert.match(
      h.text(),
      /work@example.com.*msant262@gmail.com.*Visible subject.*Actual message text/s,
    );
    for (const button of ["Send", "Copy", "Delete", "Save draft"])
      assert.equal(h.button(button).disabled, false);
    assert.equal(calls.length, 0);
    h.button("Copy").onPress();
    await h.flush();
    assert.match(copied[0], /From: work@example.com.*To: msant262@gmail.com.*Actual message text/s);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(h.text(), /Actual message text/);
    h.button("View draft").onPress();
    h.render();
    h.button("Save draft").onPress();
    await h.flush();
    fail = false;
    h.button("Save draft").onPress();
    await h.flush();
    assert.equal(calls[0].body.operationId, calls[1].body.operationId);
    assert.equal(calls[1].body.operation, "save");
    assert.doesNotMatch(h.text(), /Actual message text/);
    assert.doesNotMatch(h.text(), /"message"|"raw"/);
  } finally {
    h.close();
  }
});

test("deleting from the draft card only prepares a visible approval and disables pending writes", async () => {
  const calls: any[] = [];
  let pending = false;
  const h = view("GoogleMailDraftCard", { id: draft.id }, async (path, body) => {
    if (body) {
      calls.push({ path, body });
      pending = true;
      return {};
    }
    if (path.startsWith("/api/actions/")) return action;
    return pending ? { ...draft, status: "awaiting_review", actionId: action.id } : draft;
  });
  try {
    await h.flush();
    h.button("Delete").onPress();
    await h.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.operation, "delete");
    assert.doesNotMatch(h.text(), /Actual message text/);
    h.button("View draft").onPress();
    h.render();
    assert.equal(h.button("Send").disabled, true);
    assert.equal(h.button("Delete").disabled, true);
    assert.ok(
      h.nodes().some((node) => typeof node.type === "function" && node.props.action === action),
    );
    assert.ok(calls.every((call) => !call.path.endsWith("/decide")));
  } finally {
    h.close();
  }
});

test("approval shows readable account and target, hides JSON, and submits only the clicked exact decision", async () => {
  const calls: any[] = [];
  const h = view("GoogleApprovalCard", { action }, async (path, body) => {
    if (path.endsWith("/details")) return { action, taskAvailable: false };
    calls.push({ path, body });
    return { ...action, status: "denied" };
  });
  try {
    await h.flush();
    assert.match(h.text(), /Delete email draft.*Visible subject.*work@example.com/s);
    assert.doesNotMatch(h.text(), /"id"|gmail.users.drafts.delete/);
    assert.equal(calls.length, 0);
    h.button("Show technical details").onPress();
    h.render();
    assert.match(h.text(), /gmail.users.drafts.delete/);
    h.button("Deny").onPress();
    await h.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `/api/actions/${action.id}/decide`);
    assert.equal(calls[0].body.hash, action.hash);
    assert.equal(calls[0].body.decision, "deny");
    assert.doesNotMatch(h.text(), /gmail.users.drafts.delete|Nothing is deleted/);
    assert.match(h.text(), /Declined.*View details.*Actions/s);
    assert.ok(
      !h
        .nodes()
        .some((node) => node.type === "Button" && node.props.children === "Approve deletion"),
    );
  } finally {
    h.close();
  }
});

test("opening a declined action from history shows the full context immediately without reopening or approving it", async () => {
  const calls: string[] = [];
  const h = view(
    "GoogleApprovalCard",
    { action: { ...action, status: "denied" }, presentation: "detail" },
    async (path) => {
      calls.push(path);
      return { action, taskAvailable: false };
    },
  );
  try {
    await h.flush();
    assert.match(h.text(), /Visible subject.*work@example.com.*Deletion was declined/s);
    assert.doesNotMatch(h.text(), /View details|Approve deletion|gmail.users.drafts.delete/);
    assert.deepEqual(calls, [`/api/actions/${action.id}/details`]);
  } finally {
    h.close();
  }
});

test("handled drafts remain compact after remount and can be reopened without performing an action", async () => {
  const calls: any[] = [];
  for (const status of ["saved", "sent", "deleted", "denied"]) {
    const h = view("GoogleMailDraftCard", { id: draft.id }, async (path, body) => {
      if (body) calls.push({ path, body });
      return { ...draft, status, collapsed: true };
    });
    try {
      await h.flush();
      assert.match(h.text(), /Visible subject.*View draft.*Actions/s);
      assert.doesNotMatch(h.text(), /Actual message text/);
      h.button("View draft").onPress();
      h.render();
      assert.match(h.text(), /Actual message text/);
      assert.equal(h.button("Send").disabled, ["sent", "deleted"].includes(status));
      assert.equal(calls.length, 0);
    } finally {
      h.close();
    }
  }
});
test("document history explains the real edit and original request and opens the exact Google document without a write", async () => {
  const calls: { path: string; body?: unknown }[] = [],
    opened: string[] = [];
  const doc = {
    ...action,
    title: "Edit document",
    status: "succeeded",
    data: {
      tool: "google.workspace",
      operation: "docs.documents.batchUpdate",
      account: "work@example.com",
      documentId: "actual-doc-id",
      resourceName: "Meeting notes",
      request: JSON.stringify({
        body: { requests: [{ insertText: { text: "Agenda for tomorrow" } }] },
      }),
    },
  };
  const h = view(
    "GoogleApprovalCard",
    { action: doc, presentation: "detail" },
    async (path, body) => {
      calls.push({ path, body });
      return {
        action: doc,
        origin: {
          request: "Create my meeting notes for tomorrow.",
          taskId: "original-task",
          taskTitle: "Meeting notes",
        },
        taskAvailable: false,
      };
    },
    opened,
  );
  try {
    await h.flush();
    assert.match(
      h.text(),
      /Meeting notes.*Where.*Google Drive.*Google Docs.*work@example.com.*Open document.*Text added to the document.*Text added.*Agenda for tomorrow.*Create my meeting notes for tomorrow/s,
    );
    assert.doesNotMatch(h.text(), /Change completed|Show technical details.*\{/);
    h.button("Open document").onPress();
    await h.flush();
    assert.deepEqual(opened, [
      "https://docs.google.com/document/d/actual-doc-id/edit?authuser=work%40example.com",
    ]);
    assert.deepEqual(calls, [{ path: `/api/actions/${doc.id}/details`, body: undefined }]);
  } finally {
    h.close();
  }
});

test("sending collapses the card only after success while failures retain the draft controls", async () => {
  let current = { ...draft, status: "saved", collapsed: false };
  let fail = true;
  const h = view("GoogleMailDraftCard", { id: draft.id }, async (_path, body) => {
    if (body) {
      if (fail) throw new Error("Google temporarily unavailable");
      current = { ...current, status: "sent", collapsed: true };
    }
    return current;
  });
  try {
    await h.flush();
    h.button("Send").onPress();
    await h.flush();
    assert.match(h.text(), /Actual message text/);
    fail = false;
    h.button("Send").onPress();
    await h.flush();
    assert.match(h.text(), /Visible subject.*Sent.*View draft/s);
    assert.doesNotMatch(h.text(), /Actual message text/);
  } finally {
    h.close();
  }
});

test("calendar reviews display the same instant in its named zone instead of copying the returned hour", () => {
  const lines = connectorReviewLines({
    tool: "google.workspace",
    operation: "calendar.events.delete",
    account: "work@example.com",
    starts: "2026-10-07T17:00:00+02:00",
    ends: "2026-10-07T17:15:00+02:00",
    timeZone: "UTC",
  });
  assert.match(lines.find((line) => line.label === "Starts")!.value, /07\/10\/2026.*15:00.*UTC/);
  assert.match(lines.find((line) => line.label === "Ends")!.value, /15:15.*UTC/);
  const local = connectorReviewLines({
    tool: "google.workspace",
    operation: "calendar.events.insert",
    starts: "2026-10-07T15:00:00Z",
    timeZone: "Europe/Berlin",
  });
  assert.match(local.find((line) => line.label === "Starts")!.value, /17:00.*Europe\/Berlin/);
});

test("the Actions tab fetches one summary page and reopens a selected draft without issuing Google operations", async () => {
  const calls: string[] = [],
    opened: any[] = [];
  const workspace: { actions: any[] } = { actions: [] };
  const api = {
    identityKey: "owner",
    request: async (path: string) => {
      calls.push(path);
      return {
        entries: [
          {
            id: "draft-1",
            subject: "Saved subject",
            account: "work@example.com",
            to: ["msant262@gmail.com"],
            status: workspace.actions[0]?.status ?? "saved",
            updatedAt: "2026-10-06T12:00:00Z",
          },
        ],
      };
    },
  };
  const h = componentHarness(
    new URL("../apps/mobile/src/google-actions-screen.tsx", import.meta.url),
    "GoogleActionsScreen",
    {
      "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./ui": { Button: "Button", Card: "Card", ErrorNotice: "ErrorNotice" },
      "./workspace": {
        useWorkspace: () => ({
          api,
          workspace,
          open: (detail: any) => opened.push(detail),
        }),
      },
      "./external-action-preview": {
        connectorReviewLines,
        googleActionPresentation,
        withGoogleActionContext,
      },
      "lucide-react-native": {
        CheckCircle2: "CheckCircle2",
        ChevronRight: "ChevronRight",
        CircleAlert: "CircleAlert",
        CircleX: "CircleX",
        Clock3: "Clock3",
        FileText: "FileText",
        ShieldCheck: "ShieldCheck",
      },
      "./google-workspace-cards": { googleActionStatus: (status: string) => status },
    },
  );
  try {
    h.render();
    await h.flush();
    assert.deepEqual(calls, ["/api/google/mail-drafts"]);
    assert.match(h.text(), /Saved subject.*work@example.com.*msant262@gmail.com/s);
    const row = h
      .nodes()
      .find(
        (node) =>
          node.type === "Pressable" &&
          node.props.accessibilityLabel === "Email draft · Saved subject",
      );
    assert.ok(row);
    (row.props.onPress as () => void)();
    assert.equal(opened[0].type, "gmailDraft");
    assert.equal(opened[0].id, "draft-1");
    assert.equal(calls.length, 1);
    workspace.actions.push({ ...action, status: "denied", createdAt: "2026-10-06T12:01:00Z" });
    h.render();
    await h.flush();
    assert.equal(calls.length, 2, "a decision refreshes the displayed summaries");
    assert.match(h.text(), /denied/);
  } finally {
    h.close();
  }
});
