import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import { nativeComponentFixture } from "./native-component-fixture.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Native audio and React Native hosts require Android. Execute the real component
// with deterministic hook scheduling and the native recorder's pause/prepare contract.
async function fixture() {
  let permission = true;
  let holdPreparation = false;
  let failSave = false;
  const preparation = deferred<void>();
  const saved: { uri: string; name: string; mimeType: string }[] = [];
  const listeners = new Set<(next: string) => void>();
  const recorder = {
    isRecording: false,
    prepared: false,
    recordings: 0,
    uri: "",
    async prepareToRecordAsync() {
      if (this.prepared) throw new Error("Recorder is already prepared");
      if (holdPreparation) await preparation.promise;
      this.prepared = true;
      this.uri = `file:///cache/recording-${++this.recordings}.m4a`;
    },
    record() {
      assert.equal(this.prepared, true);
      this.isRecording = true;
    },
    async stop() {
      this.isRecording = false;
      this.prepared = false;
    },
  };
  const appState = {
    currentState: "active",
    addEventListener(_name: string, listener: (next: string) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const component = await nativeComponentFixture(
    new URL("../src/voice-input.tsx", import.meta.url),
    "VoiceInput",
    {
      "react-native": {
        AppState: appState,
        Platform: { OS: "android" },
        Text: "Text",
        View: "View",
      },
      "lucide-react-native": { Mic: "Mic", Square: "Square" },
      "./ui": { Button: "Button", ErrorNotice: "ErrorNotice", useUI: () => ({ s: {} }) },
      "./i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "expo-audio": {
        AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: permission }) },
        RecordingPresets: { HIGH_QUALITY: {} },
        setAudioModeAsync: async () => {},
        useAudioRecorder: () => recorder,
        useAudioRecorderState: () => ({ isRecording: recorder.isRecording, durationMillis: 1000 }),
      },
    },
    {
      active: true,
      save: async (file: (typeof saved)[number]) => {
        if (failSave) throw new Error("disk full");
        saved.push(file);
      },
    },
  );
  return {
    ...component,
    recorder,
    saved,
    preparation,
    press(label?: string) {
      const button = component
        .nodes()
        .find((node) => node.type === "Button" && (!label || node.props.children === label));
      assert.ok(button, `Missing button: ${label}`);
      (button.props.onPress as () => void)();
    },
    error: () =>
      String(component.nodes().find((node) => node.type === "ErrorNotice")?.props.error ?? ""),
    permission: (value: boolean) => {
      permission = value;
    },
    holdPreparation: () => {
      holdPreparation = true;
    },
    failSave: (value: boolean) => {
      failSave = value;
    },
    active(value: boolean) {
      component.render({ active: value });
    },
    background() {
      // Expo Audio pauses before JS receives AppState.change on Android.
      recorder.isRecording = false;
      appState.currentState = "background";
      for (const listener of listeners) listener("background");
    },
    resume() {
      appState.currentState = "active";
      for (const listener of listeners) listener("active");
    },
  };
}

test("Android native auto-pause still saves the recording and releases it for the next recording", async () => {
  const f = await fixture();
  f.press();
  await f.settle();
  assert.equal(f.recorder.isRecording, true);
  f.background();
  await f.settle();
  assert.equal(f.saved.length, 1);
  assert.equal(f.recorder.prepared, false);
  f.resume();
  f.press();
  await f.settle();
  assert.equal(f.recorder.isRecording, true);
  assert.equal(f.error(), "");
  f.unmount();
});

test("closing the attachment panel while preparation is pending cannot start a hidden recording", async () => {
  const f = await fixture();
  f.holdPreparation();
  f.press();
  await f.settle();
  f.active(false);
  f.preparation.resolve();
  await f.settle();
  assert.equal(f.recorder.isRecording, false);
  assert.equal(f.recorder.prepared, false);
  assert.equal(f.saved.length, 0);
  f.unmount();
});

test("a failed save keeps the stopped recording available for explicit retry", async () => {
  const f = await fixture();
  f.press();
  await f.settle();
  f.failSave(true);
  f.press();
  await f.settle();
  assert.match(f.error(), /disk full/);
  f.failSave(false);
  f.press("Retry saving recording");
  await f.settle();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].uri, "file:///cache/recording-1.m4a");
  assert.equal(f.recorder.recordings, 1);
  assert.equal(f.error(), "");
  f.unmount();
});

test("permission denial leaves typing available and a later recording request can recover", async () => {
  const f = await fixture();
  f.permission(false);
  f.press();
  await f.settle();
  assert.match(f.error(), /Microphone access is unavailable/);
  assert.equal(f.recorder.recordings, 0);
  f.permission(true);
  f.press();
  await f.settle();
  assert.equal(f.recorder.isRecording, true);
  assert.equal(f.error(), "");
  f.unmount();
});

test("unmounting during native preparation cannot activate a released recorder", async () => {
  const f = await fixture();
  f.holdPreparation();
  f.press();
  await f.settle();
  f.unmount();
  f.preparation.resolve();
  await f.settle();
  assert.equal(f.recorder.isRecording, false);
});
