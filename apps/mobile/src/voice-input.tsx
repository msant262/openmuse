import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { Mic, Square } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import type { PickedAttachment } from "./attachment-cache";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, useUI } from "./ui";
export function VoiceInput({
  save,
  active,
  compact = false,
  startRequest = 0,
}: {
  active: boolean;
  compact?: boolean;
  startRequest?: number;
  save: (file: PickedAttachment, transcribe?: boolean, includeSubtitles?: boolean) => Promise<void>;
}) {
  const { s } = useUI();

  const { t } = useI18n();
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  });
  const state = useAudioRecorderState(recorder, 500);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PickedAttachment>();
  const pendingRef = useRef<PickedAttachment | undefined>(undefined);
  const recording = useRef(false);
  const starting = useRef(false);
  const stopping = useRef(false);
  const mounted = useRef(true);
  const allowed = useRef(active);
  allowed.current = active;
  const generation = useRef(0);
  async function stop() {
    generation.current++;
    if (starting.current || stopping.current) return;
    if (!recording.current && !recorder.isRecording && !pendingRef.current) return;
    stopping.current = true;
    if (mounted.current) setBusy(true);
    try {
      if (recording.current || recorder.isRecording) {
        try {
          // Android can pause the recorder before delivering AppState.change.
          // We still own that paused recording and must stop/release it.
          await recorder.stop();
        } finally {
          recording.current = false;
          await setAudioModeAsync({ allowsRecording: false });
        }
        if (!recorder.uri) throw new Error(t("The recording is unavailable. Try again."));
        pendingRef.current = {
          uri: recorder.uri,
          name: `voz-${Date.now()}.${Platform.OS === "web" ? "webm" : "m4a"}`,
          mimeType: Platform.OS === "web" ? "audio/webm" : "audio/mp4",
        };
        if (mounted.current) setPending(pendingRef.current);
      }
      if (pendingRef.current) await save(pendingRef.current, true, true);
      pendingRef.current = undefined;
      if (mounted.current) {
        setPending(undefined);
        setError("");
      }
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      stopping.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function start() {
    if (starting.current || stopping.current || recording.current || pendingRef.current) return;
    starting.current = true;
    const request = ++generation.current;
    const canStart = () =>
      mounted.current &&
      allowed.current &&
      request === generation.current &&
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive";
    let modeSet = false;
    let prepared = false;
    setBusy(true);
    setError("");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          t("Microphone access is unavailable. You can keep typing or attach audio."),
        );
      if (!canStart()) return;
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      modeSet = true;
      if (!canStart()) return;
      await recorder.prepareToRecordAsync();
      prepared = true;
      if (!canStart()) return;
      recorder.record();
      recording.current = true;
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      if (!recording.current && modeSet) {
        if (prepared) {
          // Stopping a prepared recorder may reject for lack of samples; native
          // Expo still releases it in its finally block.
          try {
            await recorder.stop();
          } catch {}
        }
        try {
          await setAudioModeAsync({ allowsRecording: false });
        } catch (error) {
          if (mounted.current) setError(String(error));
        }
      }
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const startRef = useRef(start);
  startRef.current = start;
  const handledStart = useRef(0);
  useEffect(() => {
    if (!active || !startRequest || startRequest === handledStart.current) return;
    handledStart.current = startRequest;
    if (!recorder.isRecording) void startRef.current();
  }, [active, startRequest, recorder]);
  useEffect(() => {
    if (!active) generation.current++;
    if ((!active || state.durationMillis >= 1800000) && recording.current) void stopRef.current();
  }, [active, recorder, state.durationMillis]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" && recording.current) void stopRef.current();
    });
    return () => {
      mounted.current = false;
      generation.current++;
      subscription.remove();
      if (recording.current) void stopRef.current();
    };
  }, [recorder]);
  return (
    <View style={{ gap: 6 }}>
      <Button
        small
        busy={busy}
        icon={state.isRecording || recording.current ? Square : Mic}
        style={
          compact
            ? {
                justifyContent: "flex-start",
                backgroundColor: "transparent",
                borderRadius: 12,
                minHeight: 42,
                paddingHorizontal: 10,
              }
            : undefined
        }
        onPress={() => void (state.isRecording || recording.current || pending ? stop() : start())}
      >
        {pending
          ? t("Retry saving recording")
          : state.isRecording || recording.current
            ? t("Stop and transcribe")
            : t("Record audio")}
      </Button>
      {state.isRecording && (
        <Text style={s.small}>
          {t("Recording · {seconds} s", { seconds: Math.floor(state.durationMillis / 1000) })}
        </Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
