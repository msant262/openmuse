import assert from "node:assert/strict";
import { test } from "node:test";
import type { Artifact } from "../packages/domain/src/index.ts";
import { componentHarness } from "./helpers/component.ts";

const files: Artifact[] = [
  ["report", "Report.pdf", "application/pdf"],
  ["site", "Website.html", "text/html"],
  ["photo", "Garden.png", "image/png"],
  ["clip", "Trip.mp4", "video/mp4"],
  ["song", "Notes.mp3", "audio/mpeg"],
].map(([id, name, mimeType]) => ({
  id,
  name,
  mimeType,
  size: 1024,
  pageCount: 1,
  url: `/api/files/${id}/content`,
  source: "Local",
  createdAt: "2026-10-03T12:00:00Z",
}));
function fixture(width: number) {
  const opened: unknown[] = [];
  const view = componentHarness(
    new URL("../apps/mobile/src/muse-library.tsx", import.meta.url),
    "MuseLibrary",
    {
      "lucide-react-native": {},
      "react-native": {
        View: "View",
        Text: "Text",
        Pressable: "Pressable",
        TextInput: "TextInput",
        ScrollView: "ScrollView",
        Platform: { OS: "web" },
        StyleSheet: { create: (value: unknown) => value },
        useWindowDimensions: () => ({ width }),
      },
      "./attachment-ui-copy": { localizedAttachmentLabel: (file: Artifact) => file.mimeType },
      "./file-content-preview": { FileContentPreview: "FileContentPreview" },
      "./i18n": {
        useI18n: () => ({
          t: (key: string, values?: Record<string, string>) =>
            key.replace(/\{(\w+)\}/g, (_match, name) => values?.[name] ?? name),
        }),
      },
      "./ui": {
        Button: "Button",
        LinkRow: "LinkRow",
        IconButton: "IconButton",
        Sheet: "Sheet",
        colors: {},
        s: {},
      },
      "./workspace": {
        useWorkspace: () => ({ api: {}, open: (detail: unknown) => opened.push(detail) }),
      },
    },
    { files, uploading: false, uploadError: "", onUpload() {} },
  );
  const press = (label: string) => {
    const node = view
      .nodes()
      .find((item) => item.props.accessibilityLabel === label || item.props.label === label);
    assert.ok(node, `Missing control: ${label}`);
    (node.props.onPress as () => void)();
    view.render();
  };
  return { view, press, opened };
}

test("Library mobile separates actual document and media MIME types, and keeps file IDs when opening or attaching", () => {
  const { view, press, opened } = fixture(390);
  try {
    view.render();
    assert.match(view.text(), /Report.pdf/);
    assert.match(view.text(), /Website.html/);
    assert.doesNotMatch(view.text(), /Garden.png|Trip.mp4|Notes.mp3/);
    press("Media");
    assert.match(view.text(), /Garden.png/);
    assert.doesNotMatch(view.text(), /Report.pdf|Website.html/);
    press("Open attachment: Garden.png");
    assert.deepEqual(JSON.parse(JSON.stringify(opened[0])), { type: "file", file: files[2] });
    press("More options for Garden.png");
    const attach = view
      .nodes()
      .find((node) => node.type === "LinkRow" && node.props.title === "Attach to email");
    assert.ok(attach);
    (attach.props.onPress as () => void)();
    view.render();
    assert.deepEqual(JSON.parse(JSON.stringify(opened[1])), {
      type: "email",
      draft: { attachmentIds: ["photo"] },
    });
    assert.equal(
      view.nodes().some((node) => node.type === "Sheet"),
      false,
    );
  } finally {
    view.close();
  }
});

test("Library desktop filters by type and filename without changing the selected file on view switches", () => {
  const { view, press } = fixture(1440);
  try {
    view.render();
    assert.match(view.text(), /Report.pdf|Website.html/);
    assert.doesNotMatch(view.text(), /Garden.png|Trip.mp4|Notes.mp3/);
    press("Documents");
    assert.match(view.text(), /Report.pdf/);
    assert.doesNotMatch(view.text(), /Website.html|Garden.png|Trip.mp4|Notes.mp3/);
    press("List view");
    assert.match(view.text(), /Report.pdf/);
    press("Images");
    const search = view.nodes().find((node) => node.props.accessibilityLabel === "Search library");
    assert.ok(search);
    (search.props.onChangeText as (text: string) => void)("garden");
    view.render();
    assert.match(view.text(), /Garden.png/);
    assert.doesNotMatch(view.text(), /Report.pdf|Website.html|Trip.mp4|Notes.mp3/);
  } finally {
    view.close();
  }
});
