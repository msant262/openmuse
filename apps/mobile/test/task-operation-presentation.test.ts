import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import { museInterfacePTBR } from "../src/muse-interface-copy.ts";
import * as details from "../src/task-operation-details.ts";
import { nativeComponentFixture } from "./native-component-fixture.ts";

const operation = (toolName: string, args: unknown, receipt: unknown) => ({
  id: "saved-operation",
  toolName,
  status: "succeeded",
  args,
  receipt,
});

test("a search receipt becomes readable query and source cards without transport metadata", () => {
  assert.equal(
    typeof details.operationPresentation,
    "function",
    "steps need a structured presentation instead of a JSON dump",
  );
  const value = operation(
    "search_web",
    { query: "Gemini Argon", limit: 5 },
    {
      status: "ok",
      sources: [
        {
          title: "Introducing Argon",
          url: "https://blog.google/argon",
          snippet: "Confirmed announcement",
        },
      ],
      provenance: { provider: "internal-provider", operationId: "opaque-operation" },
    },
  );
  const shown = details.operationPresentation(value);
  assert.ok(shown.input.some((node) => node.kind === "text" && node.value === "Gemini Argon"));
  assert.ok(
    shown.output.some(
      (node) =>
        node.kind === "source" &&
        node.title === "Introducing Argon" &&
        node.url === "https://blog.google/argon" &&
        node.excerpt === "Confirmed announcement",
    ),
  );
  assert.doesNotMatch(JSON.stringify(shown), /opaque-operation|internal-provider/);
  assert.equal(
    (value.receipt as { provenance: { operationId: string } }).provenance.operationId,
    "opaque-operation",
  );
  assert.ok(
    details
      .operationPresentation(operation("search_web", {}, { sources: [] }))
      .output.some((node) => node.kind === "text" && node.value === "No sources found."),
  );
});

test("saved JSON page receipts become a source link, Markdown and an honest excerpt notice", () => {
  const shown = details.operationPresentation(
    operation(
      "web_fetch",
      { url: "https://example.com/article", maxChars: 8000 },
      JSON.stringify({
        title: "An announcement",
        url: "https://example.com/article",
        text: "# Announcement\n\nFacts **with context**.",
        truncated: true,
        sourceLength: 9000,
      }),
    ),
  );
  assert.ok(
    shown.output.some((node) => node.kind === "source" && node.title === "An announcement"),
  );
  assert.ok(
    shown.output.some(
      (node) => node.kind === "text" && node.value === "# Announcement\n\nFacts **with context**.",
    ),
  );
  assert.ok(
    shown.output.some(
      (node) =>
        node.kind === "text" &&
        node.value === "This is a saved excerpt. Open the source to read the full page.",
    ),
  );
  assert.doesNotMatch(JSON.stringify(shown.input), /maxChars/);
});

test("image receipts resolve an actual file and final checks retain failures and remaining work", () => {
  const image = details.operationPresentation(
    operation(
      "generate_image",
      { prompt: "A clear infographic", operationId: "opaque", provider: "auto" },
      {
        fileId: "image-id",
        name: "Infographic.png",
        mimeType: "image/png",
        size: 20000,
        generation: { model: "gpt-image-2", provider: "codex" },
      },
    ),
  );
  assert.ok(
    image.input.some((node) => node.kind === "text" && node.value === "A clear infographic"),
  );
  assert.ok(
    image.output.some(
      (node) =>
        node.kind === "file" && node.fileId === "image-id" && node.name === "Infographic.png",
    ),
  );
  assert.ok(image.output.some((node) => node.kind === "text" && node.value === "gpt-image-2"));
  const finish = details.operationPresentation(
    operation(
      "finish_task",
      { summary: "Partial map", artifactIds: ["image-id"] },
      {
        complete: false,
        completion: {
          status: "partial",
          checks: [{ criterionId: "map", passed: false }],
          remaining: ["Add the missing states"],
        },
      },
    ),
    [{ id: "map", description: "All states included" }],
  );
  assert.ok(
    finish.output.some(
      (node) =>
        node.kind === "check" && node.label === "All states included" && node.passed === false,
    ),
  );
  assert.match(JSON.stringify(finish.output), /Add the missing states/);
  assert.doesNotMatch(JSON.stringify(finish.output), /Delivery verified/);
});

test("unknown nested receipts stay readable and unsafe source URLs never become links", () => {
  const shown = details.operationPresentation(
    operation(
      "future_tool",
      { taskId: "opaque-task", includeArchived: false },
      {
        title: "Useful result",
        details: { total: 0, available: false, paid: false, valid: true },
        rows: ["First item", "Second item"],
        url: "javascript:alert(1)",
        api_key: "private",
        payloadBase64: "private-binary",
      },
    ),
  );
  const text = JSON.stringify(shown);
  assert.match(text, /Useful result|First item|Second item/);
  assert.match(text, /"value":0/);
  assert.match(text, /"value":false/);
  const nested = shown.output.flatMap((node) => (node.kind === "group" ? node.children : [node]));
  assert.ok(
    nested.some((node) => node.kind === "text" && node.label === "Paid" && node.value === false),
  );
  assert.ok(
    nested.some((node) => node.kind === "text" && node.label === "Valid" && node.value === true),
  );
  assert.doesNotMatch(text, /opaque-task|private|javascript:/);
  assert.doesNotThrow(() =>
    details.operationPresentation(operation("future_tool", null, "{invalid json")),
  );
  assert.ok(
    details
      .operationPresentation({
        ...operation("web_fetch", {}, undefined),
        status: "failed",
        error: "Source unavailable",
      })
      .output.some((node) => node.kind === "text" && node.value === "Source unavailable"),
  );
});

test("the viewer keeps the original JSON hidden until explicitly expanded and can close it again", async () => {
  const receipt = { sources: [{ title: "An announcement", url: "https://example.com/news" }] };
  const component = await nativeComponentFixture(
    new URL("../src/task-operation-viewer.tsx", import.meta.url),
    "TaskOperationViewer",
    {
      "react-native": {
        Text: "Text",
        View: "View",
        ScrollView: "ScrollView",
        Platform: { OS: "web" },
      },
      "lucide-react-native": { ChevronDown: "ChevronDown", ChevronRight: "ChevronRight" },
      "./ui": { Button: "Button", useUI: () => ({ s: {}, colors: {} }) },
      "./i18n": { useI18n: () => ({ t: (key: string) => museInterfacePTBR[key] ?? key }) },
      "./task-operation-details": details,
      "./attachment-ui-copy": {},
      "./assistant-response": {},
      "./artifact-result-card": {},
      "./workspace": {},
    },
    { operation: operation("search_web", { query: "An announcement" }, receipt) },
  );
  const button = () => {
    const node = component.nodes().find((node) => node.type === "Button");
    assert.ok(node);
    return node;
  };
  const rawText = () =>
    component
      .nodes()
      .filter((node) => node.type === "Text")
      .map((node) => node.props.children)
      .find((value) => typeof value === "string" && value.includes('"tool"'));
  assert.equal(button().props.children, "Detalhes técnicos (JSON)");
  assert.equal(button().props.expanded, false);
  assert.equal(rawText(), undefined);
  (button().props.onPress as () => void)();
  component.render();
  assert.equal(button().props.expanded, true);
  assert.deepEqual(JSON.parse(rawText() as string), {
    tool: "search_web",
    status: "succeeded",
    input: { query: "An announcement" },
    result: receipt,
  });
  (button().props.onPress as () => void)();
  component.render();
  assert.equal(button().props.expanded, false);
  assert.equal(rawText(), undefined);
  component.unmount();
});
