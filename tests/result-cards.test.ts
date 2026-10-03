import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  artifactPresentation,
  questionReceiptAnswers,
  resultSourceUrl,
} from "../apps/mobile/src/artifact-presentation.ts";
import { fileResultPresentation } from "../apps/mobile/src/file-result-presentation.ts";
import {
  partitionInteractions,
  QuestionSubmission,
  questionAnswerError,
  questionOptionSpace,
} from "../apps/mobile/src/interaction-state.ts";
import type { AgentArtifact } from "../packages/domain/src/agent.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";
import { type InteractionRequest, questionSchema } from "../packages/domain/src/runtime.ts";
import { componentHarness } from "./helpers/component.ts";

const t = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? name));
const ui = { Button: "Button", Card: "Card", ErrorNotice: "ErrorNotice", colors: {}, s: {} };
const native = {
  Text: "Text",
  View: "View",
  Pressable: "Pressable",
  Image: "Image",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "web" },
  useWindowDimensions: () => ({ width: 400 }),
  Linking: { openURL: async () => {} },
};
const frame = { ResultCardFrame: "ResultCardFrame", ResultCardFooter: "ResultCardFooter" };
const artifact = (
  data: Record<string, unknown>,
  kind: AgentArtifact["kind"] = "plan",
): AgentArtifact => ({
  id: "result",
  taskId: "task",
  kind,
  title: "A weekend in Porto",
  summary: "Two days by the river.",
  data,
  createdAt: "2026-10-02T00:00:00Z",
});
const question: InteractionRequest = {
  id: "question",
  taskId: "task",
  revision: 1,
  kind: "question",
  status: "waiting",
  createdAt: "2026-10-02T00:00:00Z",
  schema: {
    title: "Plan your trip",
    fields: [
      {
        id: "city",
        label: "City",
        type: "single",
        required: true,
        options: [{ id: "internal_porto", label: "Porto" }],
      },
      { id: "note", label: "Note", type: "text", required: false, multiline: false },
    ],
  },
};

function node(view: ReturnType<typeof componentHarness>, type: string, label?: string) {
  const found = view
    .nodes()
    .find((entry) => entry.type === type && (!label || entry.props.accessibilityLabel === label));
  assert.ok(found, `Missing ${type}: ${label ?? ""}`);
  return found.props;
}
function press(props: Record<string, unknown>) {
  (props.onPress as () => void)();
}

test("saved plans, reports, and comparisons expose readable content without interpreting unknown records", () => {
  const plan = artifactPresentation(
    artifact({
      text: "# Your itinerary",
      steps: [
        { title: "Arrive", description: "Take the train." },
        "Walk along the river",
        { opaque: "never a pretend step" },
      ],
    }),
  );
  assert.equal(plan.body, "# Your itinerary");
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].detail, "Take the train.");
  const report = artifactPresentation(
    artifact({ sections: [{ title: "Findings", content: "The result is saved." }] }, "report"),
  );
  assert.equal(report.sections[0].detail, "The result is saved.");
  const comparison = artifactPresentation(
    artifact(
      {
        options: [
          {
            name: "Train",
            price: 32,
            currency: "EUR",
            pros: ["Direct", 4],
            cons: ["Fixed time"],
            url: "https://example.com/train",
          },
          { name: "Bus", url: "javascript:alert(1)" },
        ],
      },
      "comparison",
    ),
  );
  assert.equal(comparison.items[0].price, "32 EUR");
  assert.deepEqual(comparison.items[0].pros, ["Direct"]);
  assert.equal(comparison.items[1].url, undefined);
  assert.equal(
    artifactPresentation(artifact({ nested: { arbitrary: "preserved in details" } })).hasContent,
    false,
  );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://name:secret@example.com",
    "/api/files/123",
  ])
    assert.equal(resultSourceUrl(url), undefined);
});

test("historical plan text and step arrays do not repeat the same content", () => {
  const text = "1. **Reserve the train**\n2. Walk by the river\n3. Return home";
  const saved = {
    ...artifact({ text, steps: ["Reserve the train", "Walk by the river", "Return home"] }),
    summary: text,
  };
  const presentation = artifactPresentation(saved);
  assert.equal(presentation.previewExcerpt, "");
  assert.equal(presentation.showSummary, false);
  assert.equal(presentation.showItems, false);
  assert.equal(presentation.items.length, 3);
  const withDetails = artifactPresentation(
    artifact({
      text,
      steps: [
        { title: "Reserve the train", detail: "Book the 10 AM departure" },
        "Walk by the river",
        "Return home",
      ],
    }),
  );
  assert.equal(
    withDetails.showItems,
    true,
    "Unique step details must remain in the expanded result",
  );
});

test("artifact cover opens the complete saved body and steps, and details are an explicit disclosure", () => {
  const saved = artifact({
    text: "Full itinerary body",
    steps: [{ title: "Arrive", detail: "Meet at 10 AM" }],
    notes: { booking: "Bring your ticket" },
  });
  const view = componentHarness(
    new URL("../apps/mobile/src/artifact-result-card.tsx", import.meta.url),
    "ArtifactResultCard",
    {
      "lucide-react-native": {},
      "react-native": native,
      "./artifact-presentation": {
        artifactPresentation,
        presentationRecord: (value: unknown) =>
          value && typeof value === "object" ? value : undefined,
      },
      "./assistant-response": { AssistantResponse: "AssistantResponse" },
      "./i18n": { useI18n: () => ({ t }) },
      "./result-card-frame": frame,
      "./ui": ui,
    },
    { artifact: saved },
  );
  view.render();
  assert.match(view.text(), /A weekend in Porto/);
  assert.equal(view.nodes().filter((entry) => entry.type === "AssistantResponse").length, 0);
  press(node(view, "ResultCardFooter"));
  view.render();
  const contents = view
    .nodes()
    .filter((entry) => entry.type === "AssistantResponse")
    .map((entry) => entry.props.content);
  assert.ok(contents.includes("Full itinerary body"));
  assert.ok(contents.includes("Meet at 10 AM"));
  assert.equal(node(view, "ResultCardFooter").expanded, true);
  view.button("Show details").onPress();
  view.render();
  assert.ok(
    view
      .nodes()
      .some((entry) => typeof entry.type === "function" && entry.props.value === saved.data),
  );
  press(node(view, "ResultCardFooter"));
  view.render();
  assert.equal(view.nodes().filter((entry) => entry.type === "AssistantResponse").length, 0);
  view.close();
});

test("answered and superseded questions render compact receipts, with no form or submission", () => {
  let calls = 0;
  const opened: unknown[] = [];
  for (const status of ["answered", "superseded"] as const) {
    const request = {
      ...question,
      status,
      answer: { city: "internal_porto", note: "By the river" },
    };
    const view = componentHarness(
      new URL("../apps/mobile/src/interaction-card.tsx", import.meta.url),
      "InteractionCard",
      {
        "lucide-react-native": {},
        "react-native": native,
        "../../../packages/domain/src/runtime": { questionSchema },
        "./credential-prompts": { CredentialRequestReceipt: "CredentialRequestReceipt" },
        "./artifact-presentation": { questionReceiptAnswers },
        "./interaction-state": { QuestionSubmission, questionAnswerError, questionOptionSpace },
        "./i18n": { useI18n: () => ({ t }) },
        "./ui": ui,
        "./workspace": {
          useWorkspace: () => ({
            api: {
              request: async () => {
                calls++;
              },
            },
            open: (value: unknown) => opened.push(value),
          }),
        },
      },
      { request },
    );
    view.render();
    assert.equal(view.nodes().filter((entry) => entry.type === "TextInput").length, 0);
    assert.doesNotMatch(view.text(), /Send answer|internal_porto/);
    if (status === "answered") assert.match(view.text(), /Porto · By the river/);
    assert.equal(node(view, "Pressable")["aria-expanded"], false);
    press(node(view, "Pressable", status === "answered" ? "Answer saved" : "Question closed"));
    view.render();
    assert.equal(node(view, "Pressable")["aria-expanded"], true);
    if (status === "superseded") {
      assert.match(view.text(), /Plan your trip/);
      assert.match(view.text(), /City.*Porto.*Note/);
    }
    assert.equal(view.nodes().filter((entry) => entry.type === "TextInput").length, 0);
    assert.equal(
      view
        .nodes()
        .filter((entry) => ["radio", "checkbox"].includes(String(entry.props.accessibilityRole)))
        .length,
      0,
    );
    assert.doesNotMatch(view.text(), /Send answer|internal_porto/);
    view.button("View task").onPress();
    assert.equal((opened.at(-1) as { taskId: string }).taskId, "task");
    view.close();
  }
  assert.equal(calls, 0);
});

test("selecting a waiting question option does not submit; explicit send becomes a receipt", async () => {
  const calls: unknown[] = [];
  const view = componentHarness(
    new URL("../apps/mobile/src/interaction-card.tsx", import.meta.url),
    "InteractionCard",
    {
      "lucide-react-native": {},
      "react-native": native,
      "../../../packages/domain/src/runtime": { questionSchema },
      "./credential-prompts": { CredentialRequestReceipt: "CredentialRequestReceipt" },
      "./artifact-presentation": { questionReceiptAnswers },
      "./interaction-state": { QuestionSubmission, questionAnswerError, questionOptionSpace },
      "./i18n": { useI18n: () => ({ t }) },
      "./ui": ui,
      "./workspace": {
        useWorkspace: () => ({
          api: {
            request: async (path: string, body: unknown) => {
              calls.push({ path, body });
              return { ...question, status: "answered", answer: { city: "internal_porto" } };
            },
          },
          open: () => {},
        }),
      },
    },
    { request: question },
  );
  view.render();
  assert.equal(view.button("Send answer").disabled, true);
  press(node(view, "Pressable", "Porto"));
  view.render();
  assert.equal(view.button("Send answer").disabled, false);
  assert.equal(calls.length, 0);
  view.button("Send answer").onPress();
  await view.flush();
  assert.equal(calls.length, 1);
  assert.match(view.text(), /Answer saved/);
  assert.doesNotMatch(view.text(), /Send answer/);
  view.close();
});

test("terminal exit failures stay visible and output expands only on demand", () => {
  for (const value of [
    { exitCode: 2 },
    { exit_code: 1 },
    { success: false },
    { error: "Failed" },
    { status: "failed" },
  ]) {
    assert.equal(fileResultPresentation(value, false).failure, true);
    assert.equal(fileResultPresentation(value, false).title, "Needs attention");
  }
  const api = {
    identityKey: "owner",
    request: async () => {
      throw new Error("No attachment should be requested");
    },
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/file-tool-card.tsx", import.meta.url),
    "FileToolCard",
    {
      "lucide-react-native": {},
      "react-native": { ...native, AppState: { addEventListener: () => ({ remove() {} }) } },
      "./file-result-presentation": { fileResultPresentation },
      "./thread-artifacts": { FileThreadCard: "FileThreadCard" },
      "./i18n": { useI18n: () => ({ t }) },
      "./ui": ui,
      "./workspace": { useWorkspace: () => ({ api }) },
    },
    {
      result: { stdout: "Detailed command output", stderr: "Failed conversion", exitCode: 2 },
      loading: false,
    },
  );
  view.render();
  assert.match(view.text(), /Needs attention/);
  assert.doesNotMatch(view.text(), /Detailed command output|Failed conversion/);
  view.button("Show output").onPress();
  view.render();
  assert.match(view.text(), /Detailed command output.*Failed conversion.*Exit code: 2/);
  view.close();
});

test("browser snapshots require matching source and owner, and opening does not acquire control", async () => {
  const saved: BrowserSession = {
    id: "browser",
    title: "Saved page",
    url: "https://example.com/one",
    status: "active",
    updatedAt: "1",
    previewUrl: "/api/browsers/browser/preview",
  };
  const requests: string[] = [],
    opened: unknown[] = [];
  let visible = true;
  let current = { ...saved };
  let api = {
    identityKey: "owner",
    url: (url: string) => `https://api.example.com${url}`,
    request: async (path: string) => {
      requests.push(path);
      return saved;
    },
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/browser-tool-card.tsx", import.meta.url),
    "BrowserToolCard",
    {
      zod: { z },
      "lucide-react-native": {},
      "react-native": { ...native, AppState: { addEventListener: () => ({ remove() {} }) } },
      "./artifact-presentation": { resultSourceUrl },
      "./result-card-frame": frame,
      "./i18n": { useI18n: () => ({ t }) },
      "./preview": { useInlinePreview: () => visible },
      "./ui": ui,
      "./workspace": {
        useWorkspace: () => ({
          api,
          workspace: { browsers: [current] },
          open: (value: unknown) => opened.push(value),
        }),
      },
    },
    {
      url: saved.url,
      result: { sessionId: saved.id, title: saved.title, url: saved.url },
      loading: false,
    },
  );
  view.render();
  await view.flush();
  assert.equal(
    node(view, "Image").source && (node(view, "Image").source as { uri: string }).uri,
    "https://api.example.com/api/browsers/browser/preview",
  );
  view.button("Open browser").onPress();
  await view.flush();
  assert.equal((opened[0] as { type: string }).type, "browser");
  assert.deepEqual(requests, ["/api/browsers/browser", "/api/browsers/browser"]);
  current = { ...saved, url: "https://example.com/two", updatedAt: "2" };
  view.render();
  assert.equal(
    view.nodes().some((entry) => entry.type === "Image"),
    false,
  );
  assert.match(view.text(), /The browser has moved on/);
  visible = false;
  view.render();
  await view.flush();
  const before = requests.length;
  current = { ...saved, updatedAt: "3" };
  view.render();
  assert.equal(requests.length, before);
  assert.equal(
    view.nodes().some((entry) => entry.type === "Image"),
    false,
  );
  api = { ...api, identityKey: "another-owner" };
  view.render();
  assert.equal(view.button("Open browser").disabled, false);
  assert.ok(requests.every((path) => path === "/api/browsers/browser"));
  view.close();
});

test("image attachments show the signed source and both preview and footer open the actual file", () => {
  const file = {
    id: "file",
    name: "River.png",
    mimeType: "image/png",
    url: "/api/files/file?signature=fresh",
    size: 120,
    pageCount: 1,
    createdAt: "2026-10-02T00:00:00Z",
    source: "task",
  };
  const opened: unknown[] = [];
  const view = componentHarness(
    new URL("../apps/mobile/src/thread-artifacts.tsx", import.meta.url),
    "FileThreadCard",
    {
      "lucide-react-native": {},
      "react-native": native,
      "./agent-ui": {},
      "./attachment-ui-copy": { localizedAttachmentLabel: () => "PNG image" },
      "./computer": {},
      "./result-card-frame": frame,
      "./i18n": { useI18n: () => ({ t }) },
      "./ui": ui,
      "./workspace": {
        useWorkspace: () => ({
          api: { url: (url: string) => `https://api.example.com${url}` },
          open: (value: unknown) => opened.push(value),
        }),
      },
    },
    { file },
  );
  view.render();
  assert.equal(
    (node(view, "Image").source as { uri: string }).uri,
    "https://api.example.com/api/files/file?signature=fresh",
  );
  press(node(view, "Pressable", "View image: River.png"));
  press(node(view, "ResultCardFooter"));
  assert.equal(opened.length, 2);
  assert.ok(opened.every((value) => (value as { file: unknown }).file === file));
  (node(view, "Image").onError as () => void)();
  view.render();
  assert.equal(
    view.nodes().some((entry) => entry.type === "Image"),
    false,
  );
  assert.match(view.text(), /Preview unavailable/);
  press(node(view, "ResultCardFooter"));
  assert.equal(opened.length, 3);
  view.close();
});

test("attachment replay fetches owner-bound IDs, discards the previous owner's files and ignores delayed responses", async () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const first = {
    id,
    name: "First owner's report",
    mimeType: "application/pdf",
    url: "/signed/first",
  };
  let resolve!: (value: unknown) => void;
  const paths: string[] = [];
  let api = {
    identityKey: "first",
    request: async (path: string): Promise<unknown> => {
      paths.push(path);
      return first;
    },
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/file-tool-card.tsx", import.meta.url),
    "FileToolCard",
    {
      "lucide-react-native": {},
      "react-native": { ...native, AppState: { addEventListener: () => ({ remove() {} }) } },
      "./file-result-presentation": { fileResultPresentation },
      "./thread-artifacts": { FileThreadCard: "FileThreadCard" },
      "./i18n": { useI18n: () => ({ t }) },
      "./ui": ui,
      "./workspace": { useWorkspace: () => ({ api }) },
    },
    { result: { fileId: id, url: "https://untrusted.example/old-signature" }, loading: false },
  );
  view.render();
  await view.flush();
  assert.equal((node(view, "FileThreadCard").file as { name: string }).name, first.name);
  api = {
    identityKey: "second",
    request: (path: string) => {
      paths.push(path);
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  view.render();
  assert.equal(
    view.nodes().some((entry) => entry.type === "FileThreadCard"),
    false,
  );
  view.render({ result: { stdout: "Different tool result" }, loading: false });
  resolve({ ...first, name: "Delayed result" });
  await view.flush();
  assert.equal(
    view.nodes().some((entry) => entry.type === "FileThreadCard"),
    false,
  );
  assert.ok(paths.every((path) => path === `/api/files/${id}`));
  view.close();
});

test("opening browser history is explicit, ignores responses after an owner switch, and shows session expiration", async () => {
  const saved: BrowserSession = {
    id: "browser",
    title: "Saved page",
    url: "https://example.com/one",
    status: "active",
    updatedAt: "1",
    previewUrl: "/preview",
  };
  let resolve!: (value: BrowserSession) => void;
  const paths: string[] = [],
    opened: unknown[] = [];
  let api = {
    identityKey: "first",
    url: (url: string) => url,
    request: (path: string): Promise<BrowserSession> => {
      paths.push(path);
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/browser-tool-card.tsx", import.meta.url),
    "BrowserToolCard",
    {
      zod: { z },
      "lucide-react-native": {},
      "react-native": { ...native, AppState: { addEventListener: () => ({ remove() {} }) } },
      "./artifact-presentation": { resultSourceUrl },
      "./result-card-frame": frame,
      "./i18n": { useI18n: () => ({ t }) },
      "./preview": { useInlinePreview: () => false },
      "./ui": ui,
      "./workspace": {
        useWorkspace: () => ({
          api,
          workspace: { browsers: [] },
          open: (value: unknown) => opened.push(value),
        }),
      },
    },
    {
      url: saved.url,
      result: { sessionId: saved.id, title: saved.title, url: saved.url },
      loading: false,
    },
  );
  view.render();
  assert.equal(paths.length, 0);
  view.button("Open browser").onPress();
  view.render();
  assert.equal(view.button("Open browser").busy, true);
  assert.equal(paths.length, 1);
  assert.equal(opened.length, 0);
  api = {
    ...api,
    identityKey: "second",
    request: async (path: string) => {
      paths.push(path);
      throw new Error("This browser session has expired.");
    },
  };
  view.render();
  resolve(saved);
  await view.flush();
  assert.equal(opened.length, 0);
  view.button("Open browser").onPress();
  await view.flush();
  assert.equal(node(view, "ErrorNotice").error, "This browser session has expired.");
  assert.equal(view.button("Open browser").busy, false);
  assert.equal(opened.length, 0);
  assert.equal(
    view.nodes().some((entry) => entry.type === "Image"),
    false,
  );
  assert.deepEqual(paths, ["/api/browsers/browser", "/api/browsers/browser"]);
  view.close();
});

test("result footer exposes expansion explicitly to web and native accessibility", () => {
  let pressed = 0;
  const props = {
    title: "Saved report",
    subtitle: "Report",
    action: "Open report",
    icon: "FileText",
    expanded: false,
    onPress: () => {
      pressed++;
    },
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/result-card-frame.tsx", import.meta.url),
    "ResultCardFooter",
    { "lucide-react-native": {}, "react-native": native, "./ui": ui },
    props,
  );
  view.render();
  const closed = node(view, "Pressable", "Open report: Saved report");
  assert.equal(closed["aria-expanded"], false);
  assert.equal((closed.accessibilityState as { expanded: boolean }).expanded, false);
  press(closed);
  assert.equal(pressed, 1);
  view.render({ ...props, expanded: true, action: "Show summary" });
  const opened = node(view, "Pressable", "Show summary: Saved report");
  assert.equal(opened["aria-expanded"], true);
  assert.equal((opened.accessibilityState as { expanded: boolean }).expanded, true);
  view.close();
});

test("a user can stop a waiting task directly without answering another question", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let refreshed = 0;
  const view = componentHarness(
    new URL("../apps/mobile/src/interaction-card.tsx", import.meta.url),
    "InteractionCard",
    {
      "lucide-react-native": {},
      "react-native": native,
      "../../../packages/domain/src/runtime": { questionSchema },
      "./credential-prompts": { CredentialRequestReceipt: "CredentialRequestReceipt" },
      "./artifact-presentation": { questionReceiptAnswers },
      "./interaction-state": { QuestionSubmission, questionAnswerError, questionOptionSpace },
      "./i18n": { useI18n: () => ({ t }) },
      "./ui": ui,
      "./workspace": {
        useWorkspace: () => ({
          api: {
            request: async (path: string, body: unknown) => {
              calls.push({ path, body });
              return { status: "cancelled" };
            },
          },
          open: () => {},
        }),
      },
    },
    {
      request: question,
      onAnswered: () => {
        refreshed++;
      },
    },
  );
  view.render();
  assert.equal(view.button("Send answer").disabled, true);
  await view.button("Stop task").onPress();
  await view.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { path: "/api/agent/tasks/task/control", body: { action: "cancel" } },
  ]);
  assert.equal(refreshed, 1);
  assert.equal(view.nodes().filter((entry) => entry.type === "TextInput").length, 0);
  assert.match(view.text(), /Question closed/);
  view.close();
});

test("conversation keeps answered history folded while active questions stay accessible", () => {
  const requests = [
    question,
    {
      ...question,
      id: "past",
      taskId: "past-task",
      status: "answered",
      answer: { city: "internal_porto" },
    },
  ];
  const view = componentHarness(
    new URL("../apps/mobile/src/interaction-list.tsx", import.meta.url),
    "InteractionList",
    {
      "lucide-react-native": {},
      "react-native": native,
      "./i18n": { useI18n: () => ({ t }) },
      "./interaction-card": { InteractionCard: "InteractionCard" },
      "./interaction-state": { partitionInteractions },
      "./ui": ui,
    },
    { requests },
  );
  view.render();
  const visible = () =>
    view
      .nodes()
      .filter((n) => n.type === "InteractionCard")
      .map((n) => (n.props.request as InteractionRequest).id);
  assert.deepEqual(visible(), ["question"]);
  const disclosure = () => node(view, "Pressable", "Previous questions and answers (1)");
  assert.equal(disclosure()["aria-expanded"], false);
  press(disclosure());
  view.render();
  assert.deepEqual(visible(), ["question", "past"]);
  press(disclosure());
  view.render();
  assert.deepEqual(visible(), ["question"]);
  view.close();
});
