import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

const translate = (key: string) => key;
function fixture(name: string, mimeType: string, passive = false) {
  return componentHarness(
    new URL("../apps/mobile/src/file-content-preview.tsx", import.meta.url),
    "FileContentPreview",
    {
      "react-native": {
        View: "View",
        Text: "Text",
        ActivityIndicator: "ActivityIndicator",
        Platform: { OS: "web" },
      },
      "./assistant-response": { AssistantResponse: "AssistantResponse" },
      "./i18n": { useI18n: () => ({ t: translate }) },
      "./ui": { colors: {}, s: {}, ErrorNotice: "ErrorNotice" },
    },
    {
      file: { name, mimeType },
      url: "https://workspace.test/signed-content",
      height: 600,
      passive,
    },
    {
      AbortController,
      fetch: async () => ({
        ok: true,
        text: async () => "<h1>Saved report</h1><script>window.test = true;</script>",
      }),
    },
  );
}

test("HTML preview reads attachment content without navigating to a download and isolates scripts from the app origin", async () => {
  const view = fixture("report.html", "text/html");
  try {
    view.render();
    await view.flush();
    const frame = view.nodes().find((node) => node.type === "iframe");
    assert.ok(frame);
    assert.match(String(frame.props.srcDoc), /Saved report/);
    assert.equal(frame.props.src, undefined);
    assert.equal(frame.props.sandbox, "allow-scripts");
    assert.equal(frame.props.referrerPolicy, "no-referrer");
  } finally {
    view.close();
  }
});

test("library HTML thumbnails cannot execute scripts", async () => {
  const view = fixture("report.html", "text/html", true);
  try {
    view.render();
    await view.flush();
    assert.equal(view.nodes().find((node) => node.type === "iframe")?.props.sandbox, "");
  } finally {
    view.close();
  }
});

test("saved video opens a user-controlled player without automatically playing", () => {
  const view = fixture("recording.mp4", "video/mp4");
  try {
    view.render();
    const video = view.nodes().find((node) => node.type === "video");
    assert.equal(video?.props.controls, true);
    assert.equal(video?.props.autoPlay, undefined);
  } finally {
    view.close();
  }
});
