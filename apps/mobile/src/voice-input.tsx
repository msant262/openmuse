import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import type { PickedAttachment } from "./attachment-cache";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, s } from "./ui";
export function VoiceInput({
  save,
  active,
}: {
  active: boolean;
  save: (file: PickedAttachment, transcribe?: boolean, includeSubtitles?: boolean) => Promise<void>;
}) {
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
  const stopping = useRef(false);
  async function stop() {
    if (stopping.current) return;
    stopping.current = true;
    setBusy(true);
    try {
      await recorder.stop();
      if (!recorder.uri) throw new Error(t("The recording is unavailable. Try again."));
      await save(
        {
          uri: recorder.uri,
          name: `voz-${Date.now()}.${Platform.OS === "web" ? "webm" : "m4a"}`,
          mimeType: Platform.OS === "web" ? "audio/webm" : "audio/mp4",
        },
        true,
        true,
      );
      setError("");
    } catch (error) {
      setError(String(error));
    } finally {
      stopping.current = false;
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          t("Microphone access is unavailable. You can keep typing or attach audio."),
        );
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if ((!active || state.durationMillis >= 1800000) && recorder.isRecording)
      void stopRef.current();
  }, [active, recorder, state.durationMillis]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active" && recorder.isRecording) void stopRef.current();
    });
    return () => subscription.remove();
  }, [recorder]);
  return (
    <View style={{ gap: 6 }}>
      <Button small busy={busy} onPress={() => void (state.isRecording ? stop() : start())}>
        {state.isRecording ? t("Stop and transcribe") : t("Record audio")}
      </Button>
      {state.isRecording && (
        <Text style={s.small}>{t("Recording · {seconds} s", { seconds: Math.floor(state.durationMillis / 1000) })}</Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
