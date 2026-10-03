import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { AppState, Image, ScrollView, Text, View } from "react-native";
import type {
  DesktopControl,
  DesktopInput,
  DesktopSession,
} from "../../../packages/domain/src/desktop";
import { desktopFrameSchema } from "../../../packages/domain/src/desktop";
import { browserAddress } from "./browser-address";
import { desktopPoint, type RenderedDesktop, renderDesktopFrame } from "./desktop-state";
import { desktopPollDelay } from "./preview-policy";
import { Button, Card, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

type Status = DesktopSession & {
  control: DesktopControl["control"];
  revision: number;
  enabled: true;
  runtimePaused?: boolean;
};
export function DesktopViewer() {
  const { api, refresh } = useWorkspace();
  const [status, setStatus] = useState<Status>();
  const [rendered, setRendered] = useState<RenderedDesktop>();
  const [control, setControl] = useState<DesktopControl>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const [width, setWidth] = useState(320);
  const latest = useRef<RenderedDesktop | undefined>(undefined);
  const viewer = useRef<{ id: string; session: DesktopSession } | undefined>(undefined);
  const unchanged = useRef(0);
  const active = useRef(true),
    pending = useRef(false);
  const grant = useRef<DesktopControl | undefined>(undefined);
  const point = useRef<{ x: number; y: number } | undefined>(undefined);
  const human = control?.control === "human" && Boolean(control.grantId);
  useEffect(() => {
    active.current = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (timer) clearTimeout(timer);
      const delay = desktopPollDelay(
        active.current && AppState.currentState === "active",
        unchanged.current,
      );
      if (delay !== undefined) timer = setTimeout(() => void poll(), delay);
    }
    async function poll() {
      if (running || !active.current || AppState.currentState !== "active") return;
      if (pending.current) {
        schedule();
        return;
      }
      running = true;
      try {
        const current = await api.request<Status | { enabled: false }>("/api/desktop");
        if (!active.current) return;
        if (!current.enabled) {
          setError("A registered desktop is not connected yet.");
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
          grant.current = undefined;
          setRendered(undefined);
          setControl(undefined);
          void api.request(`/api/desktop/viewers/${old.id}/close`, {}).catch(() => {});
        }
        setStatus(current);
        if (!viewer.current) {
          const opened = await api.request<{ viewerId: string; session: DesktopSession }>(
            "/api/desktop/viewers",
            { sessionId: current.id },
          );
          if (!active.current) {
            void api.request(`/api/desktop/viewers/${opened.viewerId}/close`, {}).catch(() => {});
            return;
          }
          viewer.current = { id: opened.viewerId, session: opened.session };
        }
        const connected = viewer.current;
        if (grant.current?.grantId) {
          const renewed = await api.request<DesktopControl>(
            `/api/desktop/viewers/${connected.id}/heartbeat`,
            {
              sessionId: current.id,
              grantId: grant.current.grantId,
              operationId: Crypto.randomUUID(),
            },
          );
          if (!active.current) return;
          grant.current = renewed;
          setControl(renewed);
        } else setControl({ control: current.control, revision: current.revision });
        const frame = desktopFrameSchema.parse(
          await api.request(`/api/desktop/viewers/${connected.id}/observe`, {
            sessionId: current.id,
            ...(latest.current ? { previousImage: latest.current.frame.imageHash } : {}),
          }),
        );
        if (!active.current || viewer.current?.id !== connected.id) return;
        const next = renderDesktopFrame(connected.session, latest.current, frame);
        if (!next)
          throw new Error(
            "Desktop pixels no longer match this session. Reconnect before sending input.",
          );
        unchanged.current =
          latest.current?.frame.imageHash === frame.imageHash ? unchanged.current + 1 : 0;
        latest.current = next;
        setRendered(next);
        setError("");
      } catch (failure) {
        if (active.current) {
          setError(failure instanceof Error ? failure.message : String(failure));
          latest.current = undefined;
          setRendered(undefined);
          viewer.current = undefined;
          grant.current = undefined;
          setControl(undefined);
        }
      } finally {
        running = false;
        schedule();
      }
    }
    void poll();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        unchanged.current = 0;
        void poll();
      } else {
        if (timer) clearTimeout(timer);
        latest.current = undefined;
        setRendered(undefined);
        point.current = undefined;
      }
    });
    return () => {
      active.current = false;
      if (timer) clearTimeout(timer);
      subscription.remove();
      latest.current = undefined;
      point.current = undefined;
      const current = viewer.current;
      viewer.current = undefined;
      if (current) void api.request(`/api/desktop/viewers/${current.id}/close`, {}).catch(() => {});
    };
  }, [api]);
  async function operation(name: string, body: Record<string, unknown>) {
    const current = viewer.current;
    if (!current || pending.current) return;
    unchanged.current = 0;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<DesktopControl>(
        `/api/desktop/viewers/${current.id}/${name}`,
        { sessionId: current.session.id, operationId: Crypto.randomUUID(), ...body },
      );
      if (!active.current) return;
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
      setRendered(undefined);
      void refresh().catch(() => {});
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  function input(action: DesktopInput["action"]) {
    const frame = latest.current?.frame,
      grantId = grant.current?.grantId;
    if (!frame || frame.paused || status?.runtimePaused || !grantId || busy) return;
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
    <Card style={{ gap: 14 }}>
      <Text style={s.heading}>
        Desktop{" "}
        {status
          ? `· ${human ? "Your control" : status.control === "human" ? "Under human control" : "Observing"}`
          : "· reconnecting"}
      </Text>
      <Text style={s.small}>
        Observe your agent’s own computer. Take control to click, type or drag; hand it back to
        resume the same task.
      </Text>
      <Button
        disabled={!viewer.current || busy || status?.runtimePaused}
        onPress={() => void operation("import-downloads", {})}
      >
        Add browser downloads to Files
      </Button>
      <ErrorNotice error={error} />
      {rendered?.frame.paused ? (
        <Text style={s.small}>
          Paused · last masked frame from {rendered.frame.observedAt}. Resume to refresh or send
          input.
        </Text>
      ) : null}
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <ScrollView horizontal nestedScrollEnabled>
          <View
            style={{
              width: imageWidth,
              height: imageHeight,
              backgroundColor: "#15191E",
              borderRadius: 8,
              overflow: "hidden",
            }}
            onStartShouldSetResponder={() =>
              human &&
              !busy &&
              !status?.runtimePaused &&
              !latest.current?.frame.paused &&
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
                    ? "Last masked agent desktop before pause"
                    : "Current masked agent desktop"
                }
                source={{ uri: rendered.uri }}
                style={{ width: imageWidth, height: imageHeight }}
                resizeMode="contain"
              />
            ) : (
              <Text style={{ color: "#FFF", padding: 24 }}>Waiting for a fresh desktop frame…</Text>
            )}
          </View>
        </ScrollView>
      </View>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          primary
          busy={busy}
          disabled={!viewer.current || status?.runtimePaused}
          onPress={() =>
            void operation(
              human ? "release-control" : "take-control",
              human ? { grantId: control!.grantId } : {},
            )
          }
        >
          {human ? "Hand back to agent" : "Take control"}
        </Button>
        <Button small onPress={() => setZoom(zoom === 1 ? 2 : 1)}>
          {zoom === 1 ? "Zoom in" : "Fit"}
        </Button>
        <Button small disabled={!human} primary={drag} onPress={() => setDrag(!drag)}>
          {drag ? "Drag mode" : "Click mode"}
        </Button>
      </View>
      {human ? (
        <>
          <Field
            label="Type into the focused control"
            value={text}
            onChangeText={setText}
            autoCapitalize="none"
            secureTextEntry
            maxLength={2000}
          />
          <Button
            disabled={!text || !rendered}
            busy={busy}
            onPress={() => {
              const value = text;
              setText("");
              input({ action: "type", text: value });
            }}
          >
            Type text
          </Button>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {(["Enter", "Tab", "Escape", "Backspace", "Control+l"] as const).map((key) => (
              <Button
                key={key}
                small
                disabled={!rendered || busy}
                onPress={() => input({ action: "press", key })}
              >
                {key}
              </Button>
            ))}
            <Button
              small
              disabled={!rendered || busy}
              onPress={() => input({ action: "scroll", deltaY: -360 })}
            >
              Scroll up
            </Button>
            <Button
              small
              disabled={!rendered || busy}
              onPress={() => input({ action: "scroll", deltaY: 360 })}
            >
              Scroll down
            </Button>
          </View>
        </>
      ) : (
        <>
          <Field
            label="Website address"
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
            Open in this desktop
          </Button>
        </>
      )}
    </Card>
  );
}
