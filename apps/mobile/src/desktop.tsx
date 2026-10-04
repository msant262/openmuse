import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { AppState, Image, ScrollView, Text, View } from "react-native";
import type {
  DesktopControl,
  DesktopInput,
  DesktopSession,
} from "../../../packages/domain/src/desktop";
import { desktopFrameSchema } from "../../../packages/domain/src/desktop";
import { ApiError } from "./api-errors";
import { browserAddress } from "./browser-address";
import { readDesktop } from "./desktop-requests";
import { desktopPoint, type RenderedDesktop, renderDesktopFrame } from "./desktop-state";
import { useI18n } from "./i18n";
import { desktopPollDelay } from "./preview-policy";
import { Button, Card, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Status = DesktopSession & {
  control: DesktopControl["control"];
  revision: number;
  enabled: true;
  runtimePaused?: boolean;
};
export function DesktopViewer({ embedded = false }: { embedded?: boolean } = {}) {
  const { colors, s } = useUI();

  const { api, refresh } = useWorkspace();
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>();
  const [rendered, setRendered] = useState<RenderedDesktop>();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [control, setControl] = useState<DesktopControl>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [width, setWidth] = useState(320);
  const latest = useRef<RenderedDesktop | undefined>(undefined);
  const visible = useRef<RenderedDesktop | undefined>(undefined);
  const displayed = useRef<string | undefined>(undefined);
  const viewer = useRef<{ id: string; session: DesktopSession } | undefined>(undefined);
  const unchanged = useRef(0);
  const active = useRef(true),
    pending = useRef(false);
  const grant = useRef<DesktopControl | undefined>(undefined);
  const point = useRef<{ x: number; y: number } | undefined>(undefined);
  const version = useRef(0);
  const refreshFrame = useRef<() => void>(() => {});
  const human = control?.control === "human" && Boolean(control.grantId);
  function showFrame(next?: RenderedDesktop) {
    visible.current = next;
    setRendered(next);
  }
  useEffect(() => {
    active.current = true;
    version.current++;
    grant.current = undefined;
    setControl(undefined);
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule(immediate = false) {
      if (timer) clearTimeout(timer);
      const delay = desktopPollDelay(
        active.current && AppState.currentState === "active",
        unchanged.current,
      );
      if (delay !== undefined) timer = setTimeout(() => void poll(), immediate ? 0 : delay);
    }
    refreshFrame.current = () => {
      unchanged.current = 0;
      if (!running) schedule(true);
    };
    async function poll() {
      if (running || !active.current || AppState.currentState !== "active") return;
      if (pending.current) {
        schedule();
        return;
      }
      running = true;
      let request = version.current;
      let stage: "status" | "open" | "heartbeat" | "observe" = "status";
      const currentRequest = () => active.current && request === version.current;
      try {
        const current = await readDesktop(() =>
          api.request<Status | { enabled: false }>("/api/desktop"),
        );
        if (!currentRequest()) return;
        if (!current.enabled) {
          latest.current = undefined;
          setImageLoaded(false);
          setConnectionError("A registered desktop is not connected yet.");
          return;
        }
        if (
          viewer.current &&
          (viewer.current.session.sessionGeneration !== current.sessionGeneration ||
            viewer.current.session.id !== current.id)
        ) {
          const old = viewer.current;
          viewer.current = undefined;
          latest.current = undefined;
          displayed.current = undefined;
          setImageLoaded(false);
          grant.current = undefined;
          showFrame();
          setControl(undefined);
          request = ++version.current;
          void api.request(`/api/desktop/viewers/${old.id}/close`, {}).catch(() => {});
        }
        if (
          grant.current &&
          (current.control !== "human" || current.revision !== grant.current.revision)
        ) {
          grant.current = undefined;
          latest.current = undefined;
          displayed.current = undefined;
          setImageLoaded(false);
          showFrame();
          setControl(undefined);
        }
        setStatus(current);
        if (!viewer.current) {
          stage = "open";
          const opened = await readDesktop(() =>
            api.request<{ viewerId: string; session: DesktopSession }>("/api/desktop/viewers", {
              sessionId: current.id,
            }),
          );
          if (!currentRequest()) {
            void api.request(`/api/desktop/viewers/${opened.viewerId}/close`, {}).catch(() => {});
            return;
          }
          viewer.current = { id: opened.viewerId, session: opened.session };
        }
        const connected = viewer.current;
        if (grant.current?.grantId) {
          stage = "heartbeat";
          const grantId = grant.current.grantId;
          const renewed = await readDesktop(() =>
            api.request<DesktopControl>(`/api/desktop/viewers/${connected.id}/heartbeat`, {
              sessionId: current.id,
              grantId,
              operationId: Crypto.randomUUID(),
            }),
          );
          if (!currentRequest()) return;
          grant.current = renewed;
          setControl(renewed);
        } else setControl({ control: current.control, revision: current.revision });
        stage = "observe";
        const previous = latest.current;
        const frame = desktopFrameSchema.parse(
          await readDesktop(() =>
            api.request(`/api/desktop/viewers/${connected.id}/observe`, {
              sessionId: current.id,
              ...(previous ? { previousImage: previous.frame.imageHash } : {}),
            }),
          ),
        );
        if (!currentRequest() || viewer.current?.id !== connected.id) return;
        const next = renderDesktopFrame(connected.session, previous, frame);
        if (!next)
          throw new ApiError(
            "Desktop pixels no longer match this session. Reconnect before sending input.",
            409,
            "FRAME_SESSION_CHANGED",
          );
        unchanged.current =
          latest.current?.frame.imageHash === frame.imageHash ? unchanged.current + 1 : 0;
        latest.current = next;
        // Identical pixels need no second onLoad: the URI is already displayed.
        setImageLoaded(next.uri === displayed.current);
        showFrame(next);
        setConnectionError("");
      } catch (failure) {
        if (currentRequest()) {
          const message = failure instanceof Error ? failure.message : String(failure);
          setConnectionError(message);
          latest.current = undefined;
          setImageLoaded(false);
          const denied = failure instanceof ApiError && [401, 403].includes(failure.status);
          const expiredViewer =
            failure instanceof ApiError &&
            failure.status === 409 &&
            message.startsWith("Desktop viewer");
          // Capture/network failures do not revoke a device's acknowledged
          // grant. Reconnect an expired viewer using that same device/grant.
          if (denied || expiredViewer) {
            const old = viewer.current;
            viewer.current = undefined;
            if (old) void api.request(`/api/desktop/viewers/${old.id}/close`, {}).catch(() => {});
          }
          const authorityChanged =
            denied ||
            (failure instanceof ApiError && failure.code === "FRAME_SESSION_CHANGED") ||
            (expiredViewer && message.includes("generation/epoch")) ||
            (stage === "heartbeat" &&
              failure instanceof ApiError &&
              failure.status === 409 &&
              !expiredViewer);
          if (authorityChanged) {
            grant.current = undefined;
            displayed.current = undefined;
            showFrame();
            setControl(undefined);
          }
        }
      } finally {
        running = false;
        schedule(request !== version.current);
      }
    }
    void poll();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        unchanged.current = 0;
        void poll();
      } else {
        if (timer) clearTimeout(timer);
        version.current++;
        latest.current = undefined;
        displayed.current = undefined;
        setImageLoaded(false);
        showFrame();
        point.current = undefined;
      }
    });
    return () => {
      active.current = false;
      version.current++;
      if (timer) clearTimeout(timer);
      subscription.remove();
      latest.current = undefined;
      displayed.current = undefined;
      visible.current = undefined;
      point.current = undefined;
      const current = viewer.current;
      viewer.current = undefined;
      refreshFrame.current = () => {};
      if (current) void api.request(`/api/desktop/viewers/${current.id}/close`, {}).catch(() => {});
    };
  }, [api]);
  async function operation(name: string, body: Record<string, unknown>) {
    const current = viewer.current;
    if (!current || pending.current) return;
    unchanged.current = 0;
    version.current++;
    pending.current = true;
    setBusy(true);
    setError("");
    latest.current = undefined;
    setImageLoaded(false);
    point.current = undefined;
    try {
      const result = await api.request<DesktopControl>(
        `/api/desktop/viewers/${current.id}/${name}`,
        { sessionId: current.session.id, operationId: Crypto.randomUUID(), ...body },
      );
      if (!active.current || viewer.current?.id !== current.id) return;
      if (name === "import-downloads") {
        const transfer = result as unknown as { files: unknown[]; failures: { message: string }[] };
        if (transfer.failures.length)
          setError(transfer.failures.map((failure) => failure.message).join("\n"));
      }
      if (name === "take-control" || name === "release-control") {
        grant.current = result;
        setControl(result);
      }
      latest.current = undefined;
      void refresh().catch(() => {});
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
      refreshFrame.current();
    }
  }
  function input(action: DesktopInput["action"]) {
    const frame = latest.current?.frame,
      grantId = grant.current?.grantId;
    if (
      !frame ||
      latest.current?.uri !== displayed.current ||
      frame.paused ||
      status?.runtimePaused ||
      !grantId ||
      busy
    )
      return;
    const binding = {
      sessionGeneration: frame.sessionGeneration,
      frameId: frame.frameId,
      width: frame.width,
      height: frame.height,
    };
    void operation("input", { grantId, input: { ...binding, action } });
  }
  const imageWidth = width * zoom,
    imageHeight = status ? (imageWidth * status.height) / status.width : 180;
  return (
    <Card style={{ gap: 14, ...(embedded ? { padding: 0, borderRadius: 0 } : {}) }}>
      <Text style={s.heading}>
        {t("Desktop")}{" "}
        {status
          ? `· ${t(human ? "Your control" : status.control === "human" ? "Under human control" : "Observing")}`
          : `· ${t("reconnecting")}`}
      </Text>
      {!embedded && (
        <Text style={s.small}>
          {t(
            "Observe your agent’s own computer. Take control to click, type or drag; hand it back to resume the same task.",
          )}
        </Text>
      )}
      <Button
        small={embedded}
        style={embedded ? { alignSelf: "flex-start" } : undefined}
        disabled={!viewer.current || busy || status?.runtimePaused}
        onPress={() => void operation("import-downloads", {})}
      >
        {t("Add browser downloads to Files")}
      </Button>
      <ErrorNotice error={t(error || connectionError)} />
      {rendered && !imageLoaded ? (
        <Text style={s.small}>
          {t("Updating desktop image… Input is disabled until a fresh frame arrives.")}
        </Text>
      ) : null}
      {rendered?.frame.paused ? (
        <Text style={s.small}>
          {t("Paused · last masked frame from {observedAt}. Resume to refresh or send input.", {
            observedAt: rendered.frame.observedAt,
          })}
        </Text>
      ) : null}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small={embedded}
          primary
          busy={busy}
          disabled={!viewer.current || status?.runtimePaused}
          onPress={() =>
            void operation(
              human ? "release-control" : "take-control",
              human ? { grantId: control?.grantId } : {},
            )
          }
        >
          {t(human ? "Hand back to agent" : "Take control")}
        </Button>
        <Button small onPress={() => setZoom(zoom === 1 ? 2 : 1)}>
          {t(zoom === 1 ? "Zoom in" : "Fit")}
        </Button>
        <Button
          small
          disabled={busy}
          onPress={() => {
            version.current++;
            latest.current = undefined;
            setImageLoaded(false);
            point.current = undefined;
            refreshFrame.current();
          }}
        >
          {t("Refresh frame")}
        </Button>
        <Button small disabled={!human} primary={drag} onPress={() => setDrag(!drag)}>
          {t(drag ? "Drag mode" : "Click mode")}
        </Button>
      </View>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <ScrollView horizontal nestedScrollEnabled>
          <View
            style={{
              width: imageWidth,
              height: imageHeight,
              backgroundColor: colors.code,
              borderRadius: 8,
              overflow: "hidden",
            }}
            onStartShouldSetResponder={() =>
              human &&
              !busy &&
              !status?.runtimePaused &&
              !latest.current?.frame.paused &&
              latest.current?.uri === displayed.current &&
              Boolean(latest.current)
            }
            onResponderGrant={(event) => {
              const frame = latest.current?.frame;
              point.current = frame
                ? desktopPoint(frame, event.nativeEvent.locationX, event.nativeEvent.locationY, {
                    width: imageWidth,
                    height: imageHeight,
                  })
                : undefined;
            }}
            onResponderRelease={(event) => {
              const start = point.current;
              point.current = undefined;
              const frame = latest.current?.frame,
                end = frame
                  ? desktopPoint(frame, event.nativeEvent.locationX, event.nativeEvent.locationY, {
                      width: imageWidth,
                      height: imageHeight,
                    })
                  : undefined;
              if (start && end)
                input(
                  drag
                    ? { action: "drag", ...start, toX: end.x, toY: end.y }
                    : { action: "click", ...end },
                );
            }}
            onResponderTerminate={() => {
              point.current = undefined;
            }}
          >
            {rendered ? (
              <Image
                accessibilityLabel={
                  rendered.frame.paused
                    ? t("Last masked agent desktop before pause")
                    : t("Current masked agent desktop")
                }
                source={{ uri: rendered.uri }}
                style={{ width: imageWidth, height: imageHeight }}
                resizeMode="contain"
                onLoad={() => {
                  if (
                    visible.current?.uri !== rendered.uri ||
                    visible.current.frame.sessionGeneration !== rendered.frame.sessionGeneration
                  )
                    return;
                  displayed.current = rendered.uri;
                  setImageLoaded(latest.current?.uri === rendered.uri);
                }}
                onError={() => {
                  if (
                    visible.current?.uri !== rendered.uri ||
                    visible.current.frame.sessionGeneration !== rendered.frame.sessionGeneration
                  )
                    return;
                  latest.current = undefined;
                  displayed.current = undefined;
                  setImageLoaded(false);
                  showFrame();
                  setConnectionError(
                    "Desktop image could not be displayed. Retrying a fresh frame…",
                  );
                }}
              />
            ) : (
              <Text style={{ color: colors.onFeature, padding: 24 }}>
                {t("Waiting for a fresh desktop frame…")}
              </Text>
            )}
          </View>
        </ScrollView>
      </View>
      {human ? (
        <>
          <Field
            label={t("Type into the focused control")}
            value={text}
            onChangeText={setText}
            autoCapitalize="none"
            secureTextEntry
            maxLength={2000}
          />
          <Button
            disabled={!text || !rendered || !imageLoaded}
            busy={busy}
            onPress={() => {
              const value = text;
              setText("");
              input({ action: "type", text: value });
            }}
          >
            {t("Type text")}
          </Button>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {(["Enter", "Tab", "Escape", "Backspace", "Control+l"] as const).map((key) => (
              <Button
                key={key}
                small
                disabled={!rendered || !imageLoaded || busy}
                onPress={() => input({ action: "press", key })}
              >
                {key}
              </Button>
            ))}
            <Button
              small
              disabled={!rendered || !imageLoaded || busy}
              onPress={() => input({ action: "scroll", deltaY: -360 })}
            >
              {t("Scroll up")}
            </Button>
            <Button
              small
              disabled={!rendered || !imageLoaded || busy}
              onPress={() => input({ action: "scroll", deltaY: 360 })}
            >
              {t("Scroll down")}
            </Button>
          </View>
        </>
      ) : (
        <>
          {embedded && (
            <Button
              small
              style={{ alignSelf: "flex-start" }}
              onPress={() => setAddressOpen(!addressOpen)}
              expanded={addressOpen}
            >
              {t("Website address")}
            </Button>
          )}
          {(!embedded || addressOpen) && (
            <>
              <Field
                label={t("Website address")}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                keyboardType="url"
                placeholder="https://example.com"
              />
              <Button
                disabled={!url.trim() || status?.control !== "agent" || status?.runtimePaused}
                busy={busy}
                onPress={() => void operation("open-browser", { url: browserAddress(url) })}
              >
                {t("Open in this desktop")}
              </Button>
            </>
          )}
        </>
      )}
    </Card>
  );
}
