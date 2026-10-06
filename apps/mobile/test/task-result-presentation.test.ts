import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import type { Evidence } from "../../../packages/domain/src/agent.ts";
import { museInterfacePTBR } from "../src/muse-interface-copy.ts";
import * as presentation from "../src/task-operation-details.ts";
import { nativeComponentFixture } from "./native-component-fixture.ts";

const operation = (toolName: string, receipt: unknown) => ({
  id: toolName,
  toolName,
  status: "succeeded",
  receipt,
});
const evidence = (title: string, excerpt: string, url = "https://example.com/news"): Evidence => ({
  id: title,
  kind: "web",
  title,
  excerpt,
  url,
});

test("the completed summary recovers actual sources from receipts instead of printing a truncated index JSON", () => {
  assert.equal(
    typeof presentation.taskSourcesPresentation,
    "function",
    "the completed view needs the same receipt parsing as steps",
  );
  const index = evidence(
    "Search index: announcement",
    'Index entries only; source pages have not been read. [{"title":"An announcement","url":"https://example.com/news","snippet":"Confirmed announcement"},{"title":"Other news","url":"https://other.example/news"',
  );
  const read = evidence(
    "An announcement",
    "Breadcrumb\n\n- [Home](https://example.com/)\n\n# Announcement\n\nThe published facts.",
  );
  const operations = [
    operation("search_web", {
      sources: [
        { title: "An announcement", url: read.url, snippet: "Confirmed announcement" },
        { title: "Other news", url: "https://other.example/news", snippet: "Other facts" },
      ],
    }),
    operation(
      "web_fetch",
      JSON.stringify({
        url: read.url,
        title: read.title,
        text: "# Announcement\n\nThe published facts.",
      }),
    ),
    operation("primitive.web_fetch", { url: read.url, title: read.title, text: "Same page" }),
  ];
  const shown = presentation.taskSourcesPresentation([index, read], operations);
  assert.equal(shown.length, 2);
  assert.ok(
    shown.some(
      (source) =>
        source.url === read.url &&
        source.excerpt === "Confirmed announcement" &&
        source.consulted === true,
    ),
  );
  assert.ok(
    shown.some(
      (source) => source.url === "https://other.example/news" && source.consulted === false,
    ),
  );
  assert.doesNotMatch(JSON.stringify(shown), /Index entries|Breadcrumb|Search index|"snippet"/);
  assert.match(index.excerpt, /Index entries/);
});

test("legacy sources stay readable without inventing a recovery of incomplete JSON or using unsafe links", () => {
  const legacy = evidence(
    "Search index: announcement",
    'Index entries only; source pages have not been read. [{"title":"First page","url":"https://first.example/","snippet":"First facts"}]',
  );
  const shown = presentation.taskSourcesPresentation(
    [
      legacy,
      evidence(
        "Readable page",
        "Breadcrumb\n\n- [Home](https://example.com/)\n\n# Headline\n\nA **readable** paragraph.",
      ),
      evidence("Broken payload", '{"sources":[{"url":'),
      evidence("Unsafe", "Ignored", "javascript:alert(1)"),
      evidence("Credentials", "Ignored", "https://name:password@example.com/"),
    ],
    [],
  );
  assert.ok(shown.some((source) => source.url === "https://first.example/"));
  assert.ok(shown.some((source) => source.excerpt === "A **readable** paragraph."));
  assert.ok(shown.every((source) => source.consulted === false));
  assert.doesNotMatch(JSON.stringify(shown), /password|javascript:|Breadcrumb|"sources"/);
});

test("summary delivery checks preserve partial results, failed criteria and missing work", () => {
  const nodes = presentation.completionPresentation(
    {
      status: "partial",
      checks: [
        { criterionId: "requested-image", passed: true, evidenceIds: ["image"] },
        { criterionId: "sources", passed: false, evidenceIds: [] },
      ],
      remaining: ["Add verified sources"],
    },
    [{ id: "sources", description: "Sources verified" }],
  );
  assert.ok(
    nodes.some(
      (node) => node.kind === "check" && node.label === "Sources verified" && node.passed === false,
    ),
  );
  assert.match(JSON.stringify(nodes), /Partial delivery|Add verified sources/);
  assert.doesNotMatch(JSON.stringify(nodes), /Delivery verified|evidenceIds|requested-image/);
});

test("the completed view keeps original evidence JSON closed until requested", async () => {
  const original = [
    evidence(
      "Search index: announcement",
      'Index entries only; source pages have not been read. [{"title":',
    ),
  ];
  const component = await nativeComponentFixture(
    new URL("../src/task-operation-viewer.tsx", import.meta.url),
    "TaskResultViewer",
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
      "./task-operation-details": presentation,
      "./attachment-ui-copy": {},
      "./assistant-response": {},
      "./artifact-result-card": {},
      "./workspace": {},
    },
    { files: [], artifacts: [], evidence: original, operations: [] },
  );
  const button = () => {
    const node = component.nodes().find((node) => node.type === "Button");
    assert.ok(node);
    return node;
  };
  const raw = () =>
    component
      .nodes()
      .find(
        (node) =>
          node.type === "Text" &&
          typeof node.props.children === "string" &&
          node.props.children.includes('"evidence"'),
      )?.props.children;
  assert.equal(button().props.expanded, false);
  assert.equal(raw(), undefined);
  (button().props.onPress as () => void)();
  component.render();
  assert.equal(button().props.expanded, true);
  assert.deepEqual(JSON.parse(raw() as string), { evidence: original });
  component.unmount();
});
