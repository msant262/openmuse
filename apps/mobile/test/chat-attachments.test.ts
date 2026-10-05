import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import { ApiError } from "../src/api-errors.ts";
import { AttachmentQueue, type PendingAttachment } from "../src/attachment-queue.ts";
import { ComputerPendingError } from "../src/computer-requests.ts";
import { sha256 } from "../src/message-hash.ts";
import type { MessageStorage } from "../src/message-storage.ts";
import { nativeComponentFixture } from "./native-component-fixture.ts";

const audio: PendingAttachment = {
  id: "voice-upload",
  key: "a".repeat(64),
  name: "voice.m4a",
  mimeType: "audio/mp4",
  size: 100,
  sha256: "b".repeat(64),
  transcribe: true,
  fileId: "saved-audio",
  transcriptionStatus: "error",
  transcriptionError: "worker unavailable",
  transcriptionTaskId: "failed-task",
};

async function fixture(initial: PendingAttachment[] = []) {
  const records = new Map<string, string>();
  const disk: MessageStorage = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    update: async (key, change) => {
      const next = change(records.get(key) ?? null);
      records.set(key, next);
      return next;
    },
  };
  await disk.write("phone:chat-uploads:chat", JSON.stringify(initial));
  const requests: Record<string, unknown>[] = [];
  const cached: { uri: string; name: string; mimeType: string }[] = [];
  const key = "phone:chat-uploads:chat";
  const queue = new AttachmentQueue(key, disk, async () => ({ id: "uploaded-image" }));
  let nextResult: unknown = {
    status: "succeeded",
    attachments: [{ fileId: "transcript", name: "voice.txt", mimeType: "text/plain" }],
  };
  let documentResult: unknown = { canceled: true, assets: null };
  let cameraResult: unknown = { canceled: true, assets: null };
  let pendingCamera: unknown = null;
  let cameraPermission = true;
  let uuid = 0;
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active",
    addEventListener(_name: string, callback: (state: string) => void) {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    },
  };
  const api = {
    identityKey: "phone",
    async request(_path: string, body: Record<string, unknown>) {
      requests.push(body);
      if (nextResult instanceof Error) throw nextResult;
      return nextResult;
    },
  };
  const component = await nativeComponentFixture(
    new URL("../src/chat-attachments.tsx", import.meta.url),
    "ChatAttachments",
    {
      "react-native": {
        AppState: appState,
        Platform: { OS: "android" },
        Text: "Text",
        View: "View",
      },
      "lucide-react-native": { Camera: "Camera", FilePlus2: "FilePlus2" },
      "expo-crypto": { randomUUID: () => `uuid-${++uuid}` },
      "expo-document-picker": { getDocumentAsync: async () => documentResult },
      "expo-image-picker": {
        requestCameraPermissionsAsync: async () => ({ granted: cameraPermission }),
        launchCameraAsync: async () => cameraResult,
        getPendingResultAsync: async () => {
          const result = pendingCamera;
          pendingCamera = null;
          return result;
        },
      },
      "./api": { ApiError },
      "./attachment-cache": {
        async cacheAttachment(cacheKey: string, file: (typeof cached)[number]) {
          cached.push(file);
          return {
            key: cacheKey,
            name: file.name,
            mimeType: file.mimeType,
            size: 100,
            sha256: "b".repeat(64),
          };
        },
        removeCachedAttachment: async () => {},
        uploadCachedAttachment: async () => ({ id: "uploaded-image" }),
      },
      "./attachment-queue": { AttachmentQueue },
      "./computer-requests": { ComputerPendingError },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./message-hash": { sha256 },
      "./message-storage": { messageStorage: disk },
      "./thread-artifacts": { FileThreadCard: "FileThreadCard" },
      "./ui": { useUI: () => ({ s: {} }), Button: "Button", ErrorNotice: "ErrorNotice" },
      "./voice-input": { VoiceInput: "VoiceInput" },
      "./workspace": { useWorkspace: () => ({ api, refresh: async () => {} }) },
    },
    { active: true, threadId: "chat", attach: async () => {}, transcript: async () => {} },
  );
  await component.settle();
  return {
    ...component,
    queue,
    requests,
    cached,
    press(label: string) {
      const button = component
        .nodes()
        .find((node) => node.type === "Button" && node.props.children === label);
      assert.ok(button, `Missing action: ${label}`);
      (button.props.onPress as () => void)();
    },
    error: () =>
      String(
        component
          .nodes()
          .reverse()
          .find((node) => node.type === "ErrorNotice")?.props.error ?? "",
      ),
    response: (value: unknown) => {
      nextResult = value;
    },
    document: (value: unknown) => {
      documentResult = value;
    },
    camera: (value: unknown) => {
      cameraResult = value;
    },
    cameraPermission: (value: boolean) => {
      cameraPermission = value;
    },
    async recoveredCamera(value: unknown) {
      await disk.write(
        "camera-picker:phone",
        JSON.stringify({ threadId: "chat", id: "camera-recovered" }),
      );
      pendingCamera = value;
    },
    resume() {
      for (const listener of listeners) listener("active");
    },
  };
}

test("a failed transcription can be explicitly retried with a fresh stable server request identity", async () => {
  const f = await fixture([audio]);
  assert.equal(f.requests.length, 0, "terminal failures must wait for explicit retry");
  f.press("Try transcription again");
  await f.settle();
  assert.equal((await f.queue.list())[0].transcriptionStatus, "complete");
  assert.notEqual(f.requests[0].requestId, "transcribe-voice-upload");
  f.unmount();
});

test("transcription retry after a lost response reuses its new request identity on resume", async () => {
  const f = await fixture([audio]);
  f.response(new ApiError("offline", 503));
  f.press("Try transcription again");
  await f.settle();
  assert.equal((await f.queue.list())[0].transcriptionStatus, "queued");
  f.response({
    status: "succeeded",
    attachments: [{ fileId: "txt", name: "voice.txt", mimeType: "text/plain" }],
  });
  f.resume();
  await f.settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].requestId, f.requests[1].requestId);
  assert.equal((await f.queue.list())[0].transcriptionStatus, "complete");
  f.unmount();
});

test("Android camera results recovered after activity destruction enter the saved attachment queue once", async () => {
  const f = await fixture();
  await f.recoveredCamera({
    canceled: false,
    assets: [{ uri: "file:///cache/camera.jpg", fileName: "camera.jpg", mimeType: "image/jpeg" }],
  });
  f.resume();
  await f.settle();
  assert.equal((await f.queue.list()).length, 1);
  assert.equal(f.cached[0].uri, "file:///cache/camera.jpg");
  f.resume();
  await f.settle();
  assert.equal((await f.queue.list()).length, 1);
  f.unmount();
});

test("canceling a document or camera picker leaves the draft queue empty", async () => {
  const f = await fixture();
  f.press("Upload file");
  await f.settle();
  f.press("Camera");
  await f.settle();
  assert.deepEqual(await f.queue.list(), []);
  assert.equal(f.error(), "");
  f.unmount();
});

test("camera permission denial exposes an error and document attachments remain available", async () => {
  const f = await fixture();
  f.cameraPermission(false);
  f.press("Camera");
  await f.settle();
  assert.match(f.error(), /câmera/);
  f.document({
    canceled: false,
    assets: [{ uri: "file:///cache/picked.pdf", name: "picked.pdf", mimeType: "application/pdf" }],
  });
  f.press("Upload file");
  await f.settle();
  assert.equal((await f.queue.list())[0].name, "picked.pdf");
  assert.equal(f.error(), "");
  f.unmount();
});
