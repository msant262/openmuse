import type { AvatarSceneController, AvatarSceneOptions } from "./scene";
import { mountAvatarScene } from "./scene";

declare global {
  interface Window {
    __OKAMI_AVATAR_INITIAL__: AvatarSceneOptions;
    __OKAMI_AVATAR__?: AvatarSceneController;
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function report(renderer: "webgl" | "fallback") {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "avatar-ready", renderer }));
}
try {
  window.__OKAMI_AVATAR__ = mountAvatarScene(document.getElementById("avatar") as HTMLElement, {
    ...window.__OKAMI_AVATAR_INITIAL__,
    onFailure: () => report("fallback"),
  });
  window.addEventListener("pagehide", () => window.__OKAMI_AVATAR__?.dispose());
  report("webgl");
} catch {
  report("fallback");
}
