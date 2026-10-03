import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

const i18n = { useI18n: () => ({ t: (key: string) => key }) };
const localPoster = 41;
const visual = {
  key: "dragon:working:file-2",
  poster: { uri: "https://media.example/working.png?sig=1" },
  video: { uri: "https://media.example/working.mp4?sig=1" },
  pending: false,
};
function mediaFixture(extra: Record<string, unknown> = {}) {
  const ready: string[] = [];
  let props = {
    visual,
    playing: true,
    reducedMotion: false,
    size: 180,
    framing: "full",
    Video: "Video",
    onReady: (value: string) => ready.push(value),
    ...extra,
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-media-stage.tsx", import.meta.url),
    "AvatarMediaStage",
    {
      "react-native": {
        View: "View",
        Text: "Text",
        Image: "Image",
        StyleSheet: { absoluteFill: {} },
      },
      "./avatar-media": { companionPoster: localPoster },
      "./i18n": i18n,
    },
    props,
  );
  view.render();
  const node = (type: string) => view.nodes().find((item) => item.type === type)?.props;
  const update = (next: Record<string, unknown>) => {
    props = { ...props, ...next };
    view.render(props);
  };
  const fire = (type: string, event: string) => {
    const handler = node(type)?.[event];
    assert.equal(typeof handler, "function", `Missing ${type}.${event}`);
    (handler as () => void)();
  };
  return { view, node, update, ready, fire };
}

test("reduced motion renders the state poster without mounting a video or player", () => {
  const f = mediaFixture({ reducedMotion: true });
  try {
    assert.equal(f.node("Video"), undefined);
    assert.deepEqual(f.node("Image")?.source, visual.poster);
    f.fire("Image", "onLoad");
    f.view.render();
    assert.deepEqual(f.ready, ["image"]);
    assert.equal(f.view.nodes()[0].props["aria-busy"], false);
  } finally {
    f.view.close();
  }
});

test("the matching poster remains underneath the video through first frame and failure", () => {
  const f = mediaFixture();
  try {
    assert.ok(f.node("Image"));
    assert.ok(f.node("Video"));
    assert.deepEqual(f.ready, []);
    f.fire("Video", "onFirstFrame");
    f.view.render();
    assert.deepEqual(f.ready, ["video"]);
    assert.deepEqual(f.node("Image")?.source, visual.poster);
    f.fire("Video", "onError");
    f.view.render();
    assert.equal(f.node("Video"), undefined);
    assert.deepEqual(f.node("Image")?.source, visual.poster);
    assert.deepEqual(f.ready, ["video", "fallback"]);
    assert.match(f.view.text(), /Static preview · video unavailable/);
  } finally {
    f.view.close();
  }
});

test("renewed signatures do not restart loaded media, but an error retries the newest signature", () => {
  const f = mediaFixture();
  try {
    const renewed = {
      ...visual,
      poster: { uri: "https://media.example/working.png?sig=2" },
      video: { uri: "https://media.example/working.mp4?sig=2" },
    };
    f.update({ visual: renewed });
    assert.deepEqual(f.node("Video")?.source, visual.video);
    assert.deepEqual(f.node("Image")?.source, visual.poster);
    f.fire("Video", "onError");
    f.view.render();
    f.view.render();
    assert.deepEqual(f.node("Video")?.source, renewed.video);
    f.fire("Image", "onError");
    f.view.render();
    assert.deepEqual(f.node("Image")?.source, renewed.poster);
    f.fire("Image", "onError");
    f.view.render();
    assert.equal(f.node("Image")?.source, localPoster);
    assert.match(f.view.text(), /Companion preview unavailable/);
  } finally {
    f.view.close();
  }
});

test("a still-only companion reports an image and small failed previews retain an accessible explanation", () => {
  const f = mediaFixture({ visual: { ...visual, video: undefined }, size: 54 });
  try {
    f.fire("Image", "onLoad");
    f.view.render();
    assert.deepEqual(f.ready, ["image"]);
    f.fire("Image", "onError");
    f.view.render();
    assert.equal(f.node("Text"), undefined);
    assert.equal(f.view.nodes()[0].props.accessibilityLabel, "Companion preview unavailable");
  } finally {
    f.view.close();
  }
});

function nativeDependencies() {
  const events: Record<string, (value: unknown) => void> = {};
  const removed: string[] = [];
  const timers: (() => void)[] = [];
  return {
    events,
    removed,
    timers,
    deps: {
      "expo-video": {},
      "react-native": {
        View: "View",
        StyleSheet: { absoluteFill: {} },
        AccessibilityInfo: {
          isReduceMotionEnabled: async () => false,
          addEventListener: (name: string, handler: (value: unknown) => void) => {
            events[name] = handler;
            return { remove: () => removed.push(name) };
          },
        },
        AppState: {
          currentState: "active",
          addEventListener: (name: string, handler: (value: unknown) => void) => {
            events[name] = handler;
            return { remove: () => removed.push(name) };
          },
        },
        Dimensions: { get: () => ({ width: 390, height: 844 }) },
      },
      "./api": { API_URL: "http://localhost:8787" },
      "./avatar-media": { avatarVisual: () => visual },
      "./avatar-media-stage": { AvatarMediaStage: "AvatarMediaStage" },
    },
    globals: {
      setInterval: (callback: () => void) => {
        timers.push(callback);
        return 1;
      },
      clearInterval: () => removed.push("timer"),
    },
  };
}

test("native playback waits for motion preferences and stops when hidden, inactive, or backgrounded", async () => {
  const f = nativeDependencies();
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-renderer.native.tsx", import.meta.url),
    "AvatarRenderer",
    f.deps,
    { active: true },
    f.globals,
  );
  const stage = () => view.nodes().find((item) => item.type === "AvatarMediaStage")?.props;
  let y = 20;
  try {
    view.render();
    assert.equal(stage()?.reducedMotion, true);
    (view.nodes()[0].props.ref as { current: unknown }).current = {
      measureInWindow: (callback: (...args: number[]) => void) => callback(10, y, 180, 180),
    };
    await view.flush();
    f.timers[0]();
    view.render();
    assert.equal(stage()?.playing, true);
    y = 900;
    f.timers[0]();
    view.render();
    assert.equal(stage()?.playing, false);
    y = 20;
    f.timers[0]();
    view.render();
    assert.equal(stage()?.playing, true);
    f.events.change("background");
    view.render();
    assert.equal(stage()?.playing, false);
    f.events.change("active");
    view.render();
    assert.equal(stage()?.playing, true);
    f.events.reduceMotionChanged(true);
    view.render();
    assert.equal(stage()?.reducedMotion, true);
    assert.equal(stage()?.playing, false);
    view.render({ active: false, reducedMotion: false });
    assert.equal(stage()?.playing, false);
  } finally {
    view.close();
  }
  assert.ok(f.removed.includes("change"));
  assert.ok(f.removed.includes("reduceMotionChanged"));
  assert.ok(f.removed.includes("timer"));
});

test("the native video waits for first frame, never steals controls or wake locks, and cleans up", () => {
  const calls: string[] = [];
  let status: ((event: { status: string }) => void) | undefined;
  const player = {
    status: "readyToPlay",
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    addListener: (_name: string, listener: typeof status) => {
      status = listener;
      return { remove: () => calls.push("remove") };
    },
  };
  class Value {
    setValue() {}
    stopAnimation() {
      calls.push("stop-animation");
    }
  }
  let initialized = false;
  const f = nativeDependencies();
  const props = {
    source: visual.video,
    playing: true,
    onFirstFrame: () => calls.push("first-frame"),
    onError: () => calls.push("error"),
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-renderer.native.tsx", import.meta.url),
    "NativeAvatarVideo",
    {
      ...f.deps,
      "react-native": {
        ...f.deps["react-native"],
        Animated: {
          View: "AnimatedView",
          Value,
          timing: (_value: unknown, options: { duration: number }) => ({
            start: () => calls.push(`fade:${options.duration}`),
          }),
        },
      },
      "expo-video": {
        VideoView: "VideoView",
        useVideoPlayer: (_source: unknown, setup: (instance: unknown) => void) => {
          if (!initialized) {
            setup(player);
            initialized = true;
          }
          return player;
        },
      },
    },
    props,
  );
  try {
    view.render();
    const video = view.nodes().find((node) => node.type === "VideoView")?.props;
    assert.ok(video);
    assert.equal(video.surfaceType, "textureView");
    assert.equal(video.nativeControls, false);
    assert.equal(video.allowsPictureInPicture, false);
    assert.equal((player as unknown as { muted: boolean }).muted, true);
    assert.equal(
      (player as unknown as { keepScreenOnWhilePlaying: boolean }).keepScreenOnWhilePlaying,
      false,
    );
    assert.equal(
      (player as unknown as { staysActiveInBackground: boolean }).staysActiveInBackground,
      false,
    );
    assert.ok(!calls.includes("first-frame"));
    (video.onFirstFrameRender as () => void)();
    (video.onFirstFrameRender as () => void)();
    assert.equal(calls.filter((call) => call === "first-frame").length, 1);
    assert.ok(calls.includes("fade:180"));
    view.render({ ...props, playing: false });
    assert.equal(calls.at(-1), "pause");
    status?.({ status: "error" });
    assert.equal(calls.at(-1), "error");
  } finally {
    view.close();
  }
  assert.ok(calls.includes("remove"));
  assert.equal(calls.at(-1), "pause");
});

test("web visibility and reduced-motion signals gate video playback and remove observers", () => {
  const events: Record<string, () => void> = {};
  let intersect:
    | ((entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void)
    | undefined;
  let disconnected = false;
  const media = {
    matches: false,
    addEventListener: (_: string, cb: () => void) => {
      events.motion = cb;
    },
    removeEventListener: () => {
      delete events.motion;
    },
  };
  const doc = {
    hidden: false,
    addEventListener: (_: string, cb: () => void) => {
      events.visible = cb;
    },
    removeEventListener: () => {
      delete events.visible;
    },
  };
  class Observer {
    constructor(cb: typeof intersect) {
      intersect = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-renderer.tsx", import.meta.url),
    "AvatarRenderer",
    {
      "expo-asset": {},
      "react-native": { View: "View" },
      "./api": { API_URL: "http://localhost" },
      "./avatar-media": { avatarVisual: () => visual },
      "./avatar-media-stage": { AvatarMediaStage: "AvatarMediaStage" },
    },
    {},
    { document: doc, window: { matchMedia: () => media }, IntersectionObserver: Observer },
  );
  const stage = () => view.nodes().find((node) => node.type === "AvatarMediaStage")?.props;
  try {
    view.render();
    assert.equal(stage()?.playing, false);
    intersect?.([{ isIntersecting: true, intersectionRatio: 1 }]);
    view.render();
    assert.equal(stage()?.playing, true);
    doc.hidden = true;
    events.visible();
    view.render();
    assert.equal(stage()?.playing, false);
    doc.hidden = false;
    events.visible();
    view.render();
    assert.equal(stage()?.playing, true);
    media.matches = true;
    events.motion();
    view.render();
    assert.equal(stage()?.playing, false);
    assert.equal(stage()?.reducedMotion, true);
  } finally {
    view.close();
  }
  assert.equal(disconnected, true);
  assert.deepEqual(Object.keys(events), []);
});

test("web bundled media URLs reach the video element and first decoded data reveals the clip", () => {
  const calls: string[] = [];
  const source = "/assets/okami-idle.mp4";
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-renderer.tsx", import.meta.url),
    "WebAvatarVideo",
    {
      "expo-asset": {
        Asset: {
          fromModule: () => {
            throw new Error("A web URL is already resolved");
          },
        },
      },
      "react-native": { View: "View" },
      "./api": { API_URL: "http://localhost" },
      "./avatar-media": {},
      "./avatar-media-stage": {},
    },
    {
      source,
      playing: false,
      onFirstFrame: () => calls.push("video"),
      onError: () => calls.push("fallback"),
    },
  );
  try {
    view.render();
    const video = view.nodes()[0].props;
    assert.equal(video.src, source);
    assert.equal((video.style as { opacity: number }).opacity, 0);
    (video.onLoadedData as () => void)();
    view.render();
    assert.equal((view.nodes()[0].props.style as { opacity: number }).opacity, 1);
    assert.deepEqual(calls, ["video"]);
  } finally {
    view.close();
  }
});
