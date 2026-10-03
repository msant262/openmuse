import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { WebView } from "react-native-webview";
import { ErrorNotice } from "./ui";
export default function BrowserConsole({ url }: { url: string }) {
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(AppState.currentState === "active");
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setVisible(state === "active"));
    return () => listener.remove();
  }, []);
  return (
    <View>
      <ErrorNotice error={error} />
      {visible && (
        <WebView
          source={{ uri: url }}
          onError={(event) => setError(event.nativeEvent.description)}
          style={{ height: 520, borderRadius: 12 }}
        />
      )}
    </View>
  );
}
