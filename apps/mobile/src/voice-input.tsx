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
import { Button, ErrorNotice, s } from "./ui";
export function VoiceInput({
  save,
  active,
}: {
  active: boolean;
  save: (file: PickedAttachment, transcribe?: boolean, includeSubtitles?: boolean) => Promise<void>;
}) {
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
      if (!recorder.uri) throw new Error("A gravação não ficou disponível. Tente novamente.");
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
          "Sem acesso ao microfone. Você pode continuar digitando ou anexar um áudio.",
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
        {state.isRecording ? "Parar e transcrever" : "Gravar áudio"}
      </Button>
      {state.isRecording && (
        <Text style={s.small}>Gravando · {Math.floor(state.durationMillis / 1000)} s</Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
