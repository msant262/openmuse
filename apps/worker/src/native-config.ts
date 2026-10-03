import type { BrowserType } from "playwright";
import { validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";

/** Populated by the fixed UID desktop broker on stdin. Never an HTTP/model argument. */
export type NativeBrowserConfig = {
  sessionId: string;
  sessionGeneration: string;
  profileId: string;
  display: string;
  authority: string;
  home: string;
  runtime: string;
  dbus?: string;
  channel: "chrome" | "chromium";
  proxyPort?: number;
  width?: number;
  height?: number;
};
export function nativeBrowserEnvironment(config: NativeBrowserConfig, inherited = process.env) {
  validateSessionId(config.sessionId);
  validateSessionId(config.sessionGeneration);
  if (
    !/^:(?:[6-9]\d|1\d\d)$/.test(config.display) ||
    !config.authority.startsWith(`${config.runtime}/desktop-`) ||
    !config.authority.endsWith("/Xauthority") ||
    !config.home.startsWith("/") ||
    !config.runtime.startsWith("/") ||
    [config.home, config.runtime, config.authority].some((value) =>
      value.split("/").includes(".."),
    ) ||
    inherited.DISPLAY !== config.display ||
    inherited.XAUTHORITY !== config.authority ||
    inherited.HOME !== config.home ||
    config.dbus !== inherited.DBUS_SESSION_BUS_ADDRESS
  )
    throw new WorkerError(
      "NATIVE_ENVIRONMENT_CHANGED",
      "Headed browser requires its trusted registered desktop environment",
      503,
    );
  return {
    HOME: config.home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    DISPLAY: config.display,
    XAUTHORITY: config.authority,
    XDG_RUNTIME_DIR: config.runtime,
    ...(config.dbus ? { DBUS_SESSION_BUS_ADDRESS: config.dbus } : {}),
  };
}
export function nativeLaunchOptions(
  config: NativeBrowserConfig,
): NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]> {
  return {
    env: nativeBrowserEnvironment(config),
    headless: false,
    chromiumSandbox: true,
    channel: config.channel,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    viewport: { width: config.width ?? 1280, height: config.height ?? 720 },
  };
}
