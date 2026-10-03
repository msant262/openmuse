import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { inlinePreviewVisible } from "./preview-policy";
import { useWorkspace } from "./workspace";

export function useInlinePreview(sectionVisible = true) {
  const { viewerActive } = useWorkspace();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return inlinePreviewVisible(appActive, sectionVisible, Boolean(viewerActive));
}
