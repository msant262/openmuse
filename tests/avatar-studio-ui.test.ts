import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

const poster = {
  fileId: "poster-file",
  url: "https://example.test/avatar.png",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
};
const asset = (id: string) => ({
  id,
  version: 1,
  label: `Companion ${id}`,
  source: "generated",
  prompt: "A small teal dragon",
  poster,
  motions: {},
  status: "still",
  generationId: "generation-one",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
});
const candidates = ["one", "two", "three", "four"].map(asset);
const job = (patch: Record<string, unknown> = {}) => ({
  id: "generation-one",
  requestId: "request-one",
  label: "A small teal dragon",
  completedMotions: [],
  prompt: "A small teal dragon",
  candidateIds: candidates.map((item) => item.id),
  candidates,
  status: "awaiting_selection",
  phase: "selection",
  retryable: false,
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
  ...patch,
});
const studio = (patch: Record<string, unknown> = {}) => ({
  capabilities: { images: true, videos: true, provider: "grok" },
  assets: [],
  generations: [],
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(request: (path: string, body?: unknown) => Promise<unknown>) {
  const api = { identityKey: "owner-one", request };
  const notifications: string[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 0;
  let refreshes = 0;
  const view = componentHarness(
    new URL("../apps/mobile/src/avatar-studio.tsx", import.meta.url),
    "AvatarStudio",
    {
      "expo-crypto": { randomUUID: () => `request-${++nextId}` },
      "react-native": {
        Text: "Text",
        View: "View",
        Pressable: "Button",
        Image: "Image",
        ActivityIndicator: "ActivityIndicator",
        Platform: { OS: "web" },
        useWindowDimensions: () => ({ width: 1440 }),
        StyleSheet: { create: (value: unknown) => value },
      },
      "../../../packages/domain/src/avatar": {
        resolveAvatarDesign: () => ({ species: "capybara" }),
        AVATAR_PRESETS: [],
        avatarDesignSchema: {},
      },
      "./agent-workspace": {
        useAgentWorkspace: () => ({
          refresh: async () => {
            refreshes++;
          },
        }),
      },
      "./avatar-renderer": { AvatarRenderer: "AvatarRenderer" },
      "./avatar-thumbnail": { AvatarThumbnail: "AvatarThumbnail" },
      "./avatar-studio-styles": { avatarStudioStyles: {} },
      "./i18n": {
        useI18n: () => ({
          t: (key: string, values?: Record<string, unknown>) =>
            key.replace(/\{(\w+)\}/g, (_match, name) => String(values?.[name] ?? name)),
        }),
      },
      "./ui": { Button: "Button", ErrorNotice: "ErrorNotice", Field: "Field" },
      "./workspace": {
        useWorkspace: () => ({ api, notify: (message: string) => notifications.push(message) }),
      },
    },
    {},
    {
      setTimeout: (run: () => void) => {
        const id = ++nextId;
        timers.set(id, run);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  return {
    view,
    api,
    notifications,
    get refreshes() {
      return refreshes;
    },
    async poll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const run of pending) run();
      await view.flush();
    },
  };
}
function describe(view: ReturnType<typeof fixture>["view"], prompt: string) {
  const field = view
    .nodes()
    .find((item) => item.type === "Field" && item.props.label === "Describe your companion");
  assert.ok(field, "free-form creation remains available");
  (field.props.onChangeText as (value: string) => void)(prompt);
  view.render();
}
function choose(view: ReturnType<typeof fixture>["view"], label: string) {
  const node = view.nodes().find((item) => item.props.accessibilityLabel === label);
  assert.ok(node, `Missing option ${label}`);
  (node.props.onPress as () => void)();
  view.render();
}
function errors(view: ReturnType<typeof fixture>["view"]) {
  return view
    .nodes()
    .filter((item) => item.type === "ErrorNotice")
    .map((item) => item.props.error)
    .join(" ");
}

test("opening a blank avatar draft does not revive an old unselected generation", async () => {
  const calls: string[] = [];
  const saved = { ...asset("saved"), status: "ready" };
  const f = fixture(async (path) => {
    calls.push(path);
    return studio({ generations: [job()], assets: [...candidates, saved], activeAssetId: "saved" });
  });
  try {
    f.view.render();
    await f.view.flush();
    assert.equal(f.view.field("Describe your companion"), "");
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      0,
    );
    const preview = f.view.nodes().find((item) => item.type === "AvatarRenderer");
    assert.ok(preview);
    assert.equal((preview.props.asset as { id: string }).id, "saved");
    assert.deepEqual(calls, ["/api/agent/avatars"]);
    f.view.button("Previous generations").onPress();
    f.view.render();
    choose(f.view, "Resume generation: A small teal dragon");
    assert.equal(f.view.field("Describe your companion"), "A small teal dragon");
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      4,
    );
    describe(f.view, "");
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      0,
    );
    assert.deepEqual(
      calls,
      ["/api/agent/avatars"],
      "resuming and clearing do not regenerate or delete saved assets",
    );
  } finally {
    f.view.close();
  }
});

test("avatar creation polls real job candidates and applies selected poster while videos generate", async () => {
  const calls: { path: string; body?: unknown }[] = [];
  const f = fixture(async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/agent/avatars") return studio();
    if (path.endsWith("/select"))
      return job({
        selectedAssetId: "two",
        status: "running",
        phase: "videos",
        candidates: candidates.map((item) => ({
          ...item,
          status: item.id === "two" ? "animating" : "still",
        })),
      });
    if (body) return job({ status: "queued", phase: "images", candidates: [], candidateIds: [] });
    return job();
  });
  try {
    f.view.render();
    await f.view.flush();
    describe(f.view, "A small teal dragon");
    f.view.button("Generate companions").onPress();
    await f.view.flush();
    assert.match(f.view.text(), /Creating four companions/);
    await f.poll();
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      4,
    );
    assert.equal(f.view.button("Select companion").disabled, true);
    choose(f.view, "Choose option 2");
    assert.equal(
      f.view.nodes().find((item) => item.props.accessibilityLabel === "Choose option 2")?.props[
        "aria-checked"
      ],
      true,
    );
    f.view.button("Select companion").onPress();
    await f.view.flush();
    assert.equal(
      (calls.find((item) => item.path.endsWith("/select"))?.body as { assetId: string } | undefined)
        ?.assetId,
      "two",
    );
    const preview = f.view.nodes().find((item) => item.type === "AvatarRenderer");
    assert.equal((preview?.props.asset as { id: string } | undefined)?.id, "two");
    assert.match(f.view.text(), /Your companion is applied/);
    assert.ok(f.refreshes > 0);
  } finally {
    f.view.close();
  }
});

test("generation transport retry preserves the draft and reuses its idempotency key", async () => {
  const posts: Record<string, unknown>[] = [];
  const f = fixture(async (_path, body) => {
    if (!body) return studio();
    posts.push(body as Record<string, unknown>);
    if (posts.length === 1) throw new Error("Connection interrupted");
    return job();
  });
  try {
    f.view.render();
    await f.view.flush();
    describe(f.view, "A small teal dragon");
    f.view.button("Generate companions").onPress();
    await f.view.flush();
    assert.match(errors(f.view), /Connection interrupted/);
    assert.equal(f.view.field("Describe your companion"), "A small teal dragon");
    f.view.button("Try again").onPress();
    await f.view.flush();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].requestId, posts[1].requestId);
    assert.equal(posts[1].prompt, "A small teal dragon");
  } finally {
    f.view.close();
  }
});

test("old owner generation responses and captured handlers cannot change the next owner", async () => {
  const old = deferred<unknown>();
  let posts = 0;
  const f = fixture(async (_path, body) => {
    if (body) {
      posts++;
      return old.promise;
    }
    return studio();
  });
  try {
    f.view.render();
    await f.view.flush();
    describe(f.view, "A small teal dragon");
    const generate = f.view.button("Generate companions").onPress;
    generate();
    f.view.render();
    f.api.identityKey = "owner-two";
    f.view.render();
    await f.view.flush();
    generate();
    old.resolve(job());
    await f.view.flush();
    assert.equal(posts, 1);
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      0,
    );
    assert.equal(f.view.field("Describe your companion"), "");
    assert.deepEqual(f.notifications, []);
  } finally {
    f.view.close();
  }
});

test("unmounted selection response cannot refresh identity or announce success", async () => {
  const selection = deferred<unknown>();
  const f = fixture(async (_path, body) =>
    body ? selection.promise : studio({ generations: [job()], assets: candidates }),
  );
  f.view.render();
  await f.view.flush();
  f.view.button("Previous generations").onPress();
  f.view.render();
  choose(f.view, "Resume generation: A small teal dragon");
  choose(f.view, "Choose option 1");
  f.view.button("Select companion").onPress();
  f.view.close();
  selection.resolve(job({ selectedAssetId: "one", status: "running", phase: "videos" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.refreshes, 0);
  assert.deepEqual(f.notifications, []);
});

test("unavailable provider keeps creation draft visible and rechecking does not erase it", async () => {
  let loads = 0;
  const f = fixture(async () => {
    loads++;
    if (loads === 1) throw new Error("Service offline");
    return studio({
      capabilities: {
        images: false,
        videos: false,
        provider: null,
        reason: "Connect a generation provider",
      },
    });
  });
  try {
    f.view.render();
    await f.view.flush();
    describe(f.view, "A sleepy cream companion");
    assert.match(errors(f.view), /Service offline/);
    f.view.button("Try again").onPress();
    await f.view.flush();
    assert.equal(f.view.field("Describe your companion"), "A sleepy cream companion");
    assert.match(f.view.text(), /Connect a generation provider/);
    assert.equal(f.view.button("Generate companions").disabled, true);
  } finally {
    f.view.close();
  }
});

test("uncertain jobs retry only after explicit acknowledgement with a new action key", async () => {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const f = fixture(async (path, body) => {
    if (!body)
      return studio({
        generations: [
          job({
            status: "uncertain",
            phase: "images",
            candidates: [],
            candidateIds: [],
            retryable: true,
            error: "Provider result could not be confirmed",
          }),
        ],
      });
    posts.push({ path, body: body as Record<string, unknown> });
    return job({ status: "running", phase: "images", candidates: [], candidateIds: [] });
  });
  try {
    f.view.render();
    await f.view.flush();
    f.view.button("Previous generations").onPress();
    f.view.render();
    choose(f.view, "Resume generation: A small teal dragon");
    f.view.button("Retry generation").onPress();
    f.view.render();
    assert.equal(posts.length, 0);
    assert.match(f.view.text(), /may create another generation/);
    f.view.button("Confirm new attempt").onPress();
    await f.view.flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/api/agent/avatars/generations/generation-one/retry");
    assert.equal(posts[0].body.acknowledgeUncertain, true);
    assert.notEqual(posts[0].body.requestId, "request-one");
  } finally {
    f.view.close();
  }
});

test("saved companion selection uses its own route without generating a new character", async () => {
  const posts: string[] = [];
  const saved = { ...asset("saved"), source: "upload", generationId: undefined };
  const f = fixture(async (path, body) => {
    if (!body) return studio({ assets: [saved] });
    posts.push(path);
    return saved;
  });
  try {
    f.view.render();
    await f.view.flush();
    choose(f.view, "Use Companion saved");
    await f.view.flush();
    assert.deepEqual(posts, ["/api/agent/avatars/saved/select"]);
    assert.equal(
      (
        f.view.nodes().find((item) => item.type === "AvatarRenderer")?.props.asset as
          | { id: string }
          | undefined
      )?.id,
      "saved",
    );
  } finally {
    f.view.close();
  }
});

test("progress read failure pauses polling and an explicit check recovers without recreating the job", async () => {
  let reads = 0;
  let posts = 0;
  const f = fixture(async (path, body) => {
    if (body) posts++;
    if (path === "/api/agent/avatars")
      return studio({
        generations: [
          job({ status: "running", phase: "images", candidates: [], candidateIds: [] }),
        ],
      });
    reads++;
    if (reads === 1) throw new Error("Progress temporarily unavailable");
    return job();
  });
  try {
    f.view.render();
    await f.view.flush();
    describe(f.view, "Keep this description");
    await f.poll();
    assert.match(errors(f.view), /Progress temporarily unavailable/);
    await f.poll();
    assert.equal(reads, 1, "failed reads do not silently restart work");
    f.view.button("Try again").onPress();
    f.view.render();
    await f.poll();
    assert.equal(reads, 2);
    assert.equal(posts, 0);
    assert.equal(f.view.field("Describe your companion"), "Keep this description");
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      4,
    );
  } finally {
    f.view.close();
  }
});

test("a delayed job poll cannot reveal a previous owner’s candidate images", async () => {
  const old = deferred<unknown>();
  const f = fixture(async (path) =>
    path === "/api/agent/avatars"
      ? studio({
          generations:
            f.api.identityKey === "owner-one"
              ? [job({ status: "running", phase: "images", candidates: [], candidateIds: [] })]
              : [],
        })
      : old.promise,
  );
  try {
    f.view.render();
    await f.view.flush();
    await f.poll();
    f.api.identityKey = "owner-two";
    f.view.render();
    await f.view.flush();
    old.resolve(job());
    await f.view.flush();
    assert.equal(
      f.view.nodes().filter((item) => item.props.accessibilityRole === "radio").length,
      0,
    );
    assert.doesNotMatch(f.view.text(), /Which one feels/);
  } finally {
    f.view.close();
  }
});

test("the gallery retains chosen characters after their generation leaves the latest 30 jobs", async () => {
  const old = { ...asset("old-favorite"), generationId: "old-generation", status: "ready" };
  const skipped = asset("not-chosen");
  const recent = Array.from({ length: 30 }, (_, index) =>
    job({
      id: `recent-${index}`,
      selectedAssetId: `chosen-${index}`,
      status: "succeeded",
      phase: "complete",
    }),
  );
  const f = fixture(async () => studio({ assets: [old, skipped], generations: recent }));
  try {
    f.view.render();
    await f.view.flush();
    assert.ok(
      f.view.nodes().some((item) => item.props.accessibilityLabel === "Use Companion old-favorite"),
    );
    assert.equal(
      f.view.nodes().some((item) => item.props.accessibilityLabel === "Use Companion not-chosen"),
      false,
    );
  } finally {
    f.view.close();
  }
});

test("using the default companion clears the active asset without deleting the saved gallery", async () => {
  const saved = { ...asset("saved"), status: "ready" };
  const paths: string[] = [];
  const f = fixture(async (path, body) => {
    if (!body) return studio({ assets: [saved], activeAssetId: "saved" });
    paths.push(path);
    return { selected: true };
  });
  try {
    f.view.render();
    await f.view.flush();
    f.view.button("Use default companion").onPress();
    await f.view.flush();
    assert.deepEqual(paths, ["/api/agent/avatars/default/select"]);
    assert.equal(
      f.view.nodes().find((item) => item.type === "AvatarRenderer")?.props.asset,
      undefined,
    );
    assert.ok(
      f.view.nodes().some((item) => item.props.accessibilityLabel === "Use Companion saved"),
    );
    assert.ok(f.refreshes > 0);
  } finally {
    f.view.close();
  }
});

test("Mini Muse stays selectable beside the new default and switching preserves saved companions", async () => {
  const saved = { ...asset("favorite"), status: "ready" };
  const selections: Record<string, unknown>[] = [];
  const f = fixture(async (_path, body) => {
    if (!body) return studio({ assets: [saved], builtinCompanion: "okami" });
    selections.push(body as Record<string, unknown>);
    return { selected: true };
  });
  try {
    f.view.render();
    await f.view.flush();
    const mini = f.view.nodes().find((node) => node.props.accessibilityLabel === "Use Mini Muse");
    assert.ok(mini);
    (mini.props.onPress as () => void)();
    await f.view.flush();
    assert.equal(selections[0].companion, "mini-muse");
    assert.equal(
      f.view.nodes().find((node) => node.type === "AvatarRenderer")?.props.companion,
      "mini-muse",
    );
    assert.ok(
      f.view.nodes().some((node) => node.props.accessibilityLabel === "Use Companion favorite"),
    );
    const wolf = f.view.nodes().find((node) => node.props.accessibilityLabel === "Use Okami wolf");
    assert.ok(wolf);
    (wolf.props.onPress as () => void)();
    await f.view.flush();
    assert.equal(selections[1].companion, "okami");
    assert.notEqual(selections[0].requestId, selections[1].requestId);
  } finally {
    f.view.close();
  }
});
