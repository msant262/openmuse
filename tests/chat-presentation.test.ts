import assert from "node:assert/strict";
import test from "node:test";
import { ChatScrollFollow } from "../apps/mobile/src/chat-scroll-follow.ts";
import {
  googleActionPresentation,
  withGoogleActionContext,
} from "../apps/mobile/src/external-action-preview.ts";
import {
  showTaskDeliveryChecks,
  taskOutcomeHeading,
  taskTimeline,
} from "../apps/mobile/src/task-presentation.ts";

test("new messages and late card layout do not disengage automatic scroll", () => {
  const follow = new ChatScrollFollow();
  follow.scroll(400, 1000, 600);
  assert.equal(follow.following, true);
  // Content grows before scrollToEnd runs: the browser emits a non-user scroll.
  follow.scroll(400, 1500, 600);
  assert.equal(follow.following, true);
  follow.scroll(900, 1500, 600);
  follow.scroll(900, 2300, 600);
  assert.equal(follow.following, true);
  follow.beginUserScroll();
  follow.scroll(200, 2300, 600);
  assert.equal(follow.following, false, "an intentional upward scroll preserves history reading");
  follow.scroll(300, 2300, 600);
  assert.equal(follow.following, false);
  follow.latest();
  assert.equal(follow.following, true, "sending or tapping latest resumes following");
  follow.pause();
  follow.scroll(1700, 2300, 600);
  assert.equal(follow.following, true, "returning to the bottom resumes following");
});

const action = {
  title: "Google calendar.events.delete",
  kind: "external.action",
  status: "denied",
  data: {
    tool: "google.workspace",
    operation: "calendar.events.delete",
    account: "msant262@gmail.com",
    resourceName: "Okami agenda verificada",
    starts: "2026-10-07T15:00:00+02:00",
    ends: "2026-10-07T15:15:00+02:00",
    timeZone: "Europe/Berlin",
    calendarId: "primary",
    eventId: "opaque-id",
    requiresHumanApproval: true,
  },
};
test("a declined calendar action shows what, whose account and the actual local time without technical IDs", () => {
  const view = googleActionPresentation(action, "pt-BR");
  assert.equal(view.verb, "Remove event");
  assert.equal(view.item, "Okami agenda verificada");
  assert.equal(view.account, "msant262@gmail.com");
  assert.equal(view.outcome, "Deletion was declined. This item was not removed.");
  assert.match(
    view.fields.find((f) => f.label === "Starts")?.value ?? "",
    /07\/10\/2026.*15:00.*Europe\/Berlin/,
  );
  assert.doesNotMatch(JSON.stringify(view.fields), /opaque-id|primary/);
});
test("document changes are presented as an operation on a named document with readable content", () => {
  const view = googleActionPresentation(
    {
      title: "Google docs.documents.batchUpdate",
      kind: "external.action",
      status: "succeeded",
      data: {
        tool: "google.workspace",
        operation: "docs.documents.batchUpdate",
        account: "msant262@gmail.com",
        request: JSON.stringify({
          body: {
            requests: [{ insertText: { text: "Documento criado e salvo pelo aplicativo." } }],
          },
        }),
      },
      result: { data: { title: "Okami confirmação final" } },
    },
    "pt-BR",
  );
  assert.equal(view.verb, "Edit document");
  assert.equal(view.item, "Okami confirmação final");
  assert.equal(view.preview, "Documento criado e salvo pelo aplicativo.");
});
test("cancelled tasks do not imply delivery checks or unfinished work and native stages have meaningful labels", () => {
  assert.equal(taskOutcomeHeading("cancelled", "denied"), "Action declined");
  assert.equal(showTaskDeliveryChecks("cancelled"), false);
  const events = [
    {
      id: "a",
      title: "Working on your request",
      kind: "step",
      date: "2026-10-06T13:00:00Z",
      operationId: "read",
    },
    {
      id: "b",
      title: "Working on your request",
      kind: "step",
      date: "2026-10-06T13:00:01Z",
      operationId: "delete",
    },
  ];
  const rows = taskTimeline(events, [
    {
      id: "read",
      toolName: "execute_google_workspace_tool",
      status: "succeeded",
      args: { toolId: "calendar.events.list" },
    },
    {
      id: "delete",
      toolName: "execute_google_workspace_tool",
      status: "succeeded",
      args: { toolId: "calendar.events.delete" },
      receipt: { status: "awaiting_review" },
    },
  ]);
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Find calendar events", "Prepare event removal"],
  );
  assert.equal(rows[1].events[0].id, "b", "every underlying stage remains inspectable");
  const duplicates = taskTimeline(
    events.map((e) => ({ ...e, operationId: undefined })),
    [],
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].events.length, 2);
});

test("an update reuses the exact document name across actions without mixing Google accounts", () => {
  const update = {
    title: "Update",
    kind: "external.action",
    status: "succeeded",
    data: {
      tool: "google.workspace",
      operation: "docs.documents.batchUpdate",
      account: "msant262@gmail.com",
      documentId: "doc-id",
    },
  };
  const create = {
    ...update,
    data: {
      tool: "google.workspace",
      operation: "docs.documents.create",
      account: "msant262@gmail.com",
      resourceName: "Okami confirmação final",
    },
    result: { data: { documentId: "doc-id" } },
  };
  assert.equal(
    googleActionPresentation(withGoogleActionContext(update, [create])).item,
    "Okami confirmação final",
  );
  assert.equal(
    googleActionPresentation(
      withGoogleActionContext(update, [
        { ...create, data: { ...create.data, account: "other@example.com" } },
      ]),
    ).item,
    undefined,
  );
});

test("real Gmail draft tool IDs and saved native calendar proposals retain meaningful names and their time zone", () => {
  for (const method of ["create", "update"])
    assert.equal(
      googleActionPresentation({
        title: "Internal draft name",
        kind: "external.action",
        status: "succeeded",
        data: {
          tool: "google.workspace",
          operation: `gmail.users.drafts.${method}`,
          subject: "Reunião",
          account: "msant262@gmail.com",
        },
      }).verb,
      "Save email draft",
    );
  const view = googleActionPresentation({
    title: "Create Okami agenda verificada",
    kind: "calendar.create",
    status: "succeeded",
    account: "msant262@gmail.com",
    data: {
      title: "Okami agenda verificada",
      start: "2026-10-07T15:00:00+02:00",
      end: "2026-10-07T15:15:00+02:00",
      timeZone: "Europe/Berlin",
    },
  });
  assert.equal(view.verb, "Create event");
  assert.equal(view.item, "Okami agenda verificada");
  assert.match(view.fields[0].value, /15:00.*Europe\/Berlin/);
});
