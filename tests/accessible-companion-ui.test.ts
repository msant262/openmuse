import assert from "node:assert/strict";
import { test } from "node:test";
import { componentHarness } from "./helpers/component.ts";

const translate = (key: string) => key;
const ui = Object.fromEntries(
  ["Button", "Card", "Chip", "ErrorNotice", "Field", "Sheet"].map((name) => [name, name]),
);
const native = {
  ActivityIndicator: "ActivityIndicator",
  Text: "Text",
  View: "View",
  Pressable: "Button",
};
const memory = {
  id: "fact",
  text: "Prefiro reuniões pela manhã",
  status: "active",
  revision: 2,
  source: "explicit",
  createdAt: "2026-10-01T10:00:00Z",
};
function change(view: ReturnType<typeof componentHarness>, label: string, value: string) {
  const field = view.nodes().find((node) => node.type === "Field" && node.props.label === label);
  assert.ok(field, `Missing field ${label}`);
  (field.props.onChangeText as (value: string) => void)(value);
  view.render();
}
function memoryView(
  name: "MemorySettings" | "MemoryRow",
  request: (path: string, body?: unknown) => Promise<unknown>,
  props: Record<string, unknown> = {},
) {
  const timers = new Map<number, () => void>();
  let next = 0,
    refreshed = 0;
  const refresh = async () => {
    refreshed++;
  };
  const api = { request };
  const view = componentHarness(
    new URL("../apps/mobile/src/memory-settings.tsx", import.meta.url),
    name,
    {
      "react-native": native,
      "./i18n": { useI18n: () => ({ t: translate, locale: "pt-BR" }) },
      "./ui": ui,
      "./workspace": { useWorkspace: () => ({ api }) },
      "./agent-workspace": { useAgentWorkspace: () => ({ refresh }) },
      "./proactivity-settings": { ProactivitySettings: "ProactivitySettings" },
    },
    props,
    {
      URLSearchParams,
      setTimeout: (run: () => void) => {
        timers.set(++next, run);
        return next;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  view.render();
  return {
    view,
    refreshed: () => refreshed,
    async timers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const run of pending) run();
      await view.flush();
    },
  };
}

test("memory edit and forget can be cancelled, errors retain the draft and retry keeps its request ID", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let fail = true,
    changed = 0;
  const { view } = memoryView(
    "MemoryRow",
    async (path, body) => {
      calls.push({ path, body: (body ?? {}) as Record<string, unknown> });
      if (fail) throw new Error("Connection lost");
      return {};
    },
    {
      memory,
      changed: async () => {
        changed++;
      },
    },
  );
  try {
    view.button("Edit").onPress();
    view.render();
    change(view, "Memory correction", "Texto descartado");
    view.button("Cancel").onPress();
    view.render();
    assert.equal(calls.length, 0);
    view.button("Forget").onPress();
    view.render();
    assert.match(view.text(), /Forget this memory/);
    view.button("Cancel").onPress();
    view.render();
    assert.equal(calls.length, 0);
    view.button("Edit").onPress();
    view.render();
    assert.equal(view.field("Memory correction"), memory.text);
    change(view, "Memory correction", "  ");
    assert.equal(view.button("Save correction").disabled, true);
    change(view, "Memory correction", "Prefiro à tarde");
    view.button("Save correction").onPress();
    await view.flush();
    assert.equal(view.field("Memory correction"), "Prefiro à tarde");
    assert.ok(
      view
        .nodes()
        .some((node) => node.type === "ErrorNotice" && node.props.error === "Connection lost"),
    );
    fail = false;
    view.button("Save correction").onPress();
    await view.flush();
    assert.equal(changed, 1);
    assert.equal(calls[0].body.expectedRevision, 2);
    assert.equal(calls[0].body.requestId, calls[1].body.requestId);
    assert.equal(calls[1].body.text, "Prefiro à tarde");
  } finally {
    view.close();
  }
});

test("forgotten memory offers direct restore and finds a saved revision across history pages", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const { view } = memoryView(
    "MemoryRow",
    async (path, body) => {
      calls.push({ path, body: (body ?? {}) as Record<string, unknown> });
      if (body) return {};
      if (path.includes("cursor="))
        return { entries: [{ id: "old", revision: 1, value: memory }], nextCursor: null };
      return {
        entries: [{ id: "gone", revision: 2, value: { ...memory, status: "forgotten" } }],
        nextCursor: "older+/=",
      };
    },
    { memory: { ...memory, status: "forgotten" }, changed: async () => {} },
  );
  try {
    assert.match(view.text(), /no longer uses this memory/);
    assert.ok(
      !view.nodes().some((node) => node.type === "Button" && node.props.children === "Edit"),
    );
    view.button("Restore memory").onPress();
    await view.flush();
    assert.equal(calls.length, 3);
    assert.ok(calls[1].path.includes("cursor=older%2B%2F%3D"));
    assert.equal(calls[2].path, "/api/agent/memories/fact/restore");
    assert.equal(calls[2].body.revision, 1);
    assert.equal(calls[2].body.expectedRevision, 2);
  } finally {
    view.close();
  }
});

test("memory search ignores an old response after changing filter and supports recovery after errors", async () => {
  let resolveOld!: (value: unknown) => void;
  let fail = false;
  const paths: string[] = [];
  const fixture = memoryView("MemorySettings", async (path) => {
    paths.push(path);
    if (paths.length === 1)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    if (fail) throw new Error("Offline");
    return { entries: [], nextCursor: null };
  });
  const { view } = fixture;
  try {
    await fixture.timers();
    assert.match(paths[0], /status=active/);
    view.button("Forgotten").onPress();
    view.render();
    await fixture.timers();
    assert.match(paths[1], /status=forgotten/);
    resolveOld({ entries: [memory] });
    await view.flush();
    assert.match(view.text(), /No memories here/);
    assert.ok(!view.nodes().some((node) => node.props.memory));
    fail = true;
    change(view, "Search memories", "reuniões & café");
    await fixture.timers();
    assert.equal(
      new URL(paths.at(-1) ?? "", "https://example.test").searchParams.get("query"),
      "reuniões & café",
    );
    assert.ok(view.button("Try again"));
    fail = false;
    view.button("Try again").onPress();
    await view.flush();
    assert.match(view.text(), /No matching memories/);
  } finally {
    view.close();
  }
});

test("memory creation rejects impossible dates without a write and cancellation discards the form", async () => {
  const writes: unknown[] = [];
  const fixture = memoryView("MemorySettings", async (_path, body) => {
    if (body) writes.push(body);
    return { entries: [] };
  });
  const { view } = fixture;
  try {
    await fixture.timers();
    view.button("Add memory").onPress();
    view.render();
    change(view, "What should I remember?", "Tenho alergia a amendoim");
    change(view, "Expiration date (optional)", "2099-02-31");
    view.button("Save memory").onPress();
    await view.flush();
    assert.equal(writes.length, 0);
    assert.ok(
      view
        .nodes()
        .some(
          (node) => node.type === "ErrorNotice" && /future date/.test(String(node.props.error)),
        ),
    );
    view.button("Cancel").onPress();
    view.render();
    view.button("Add memory").onPress();
    view.render();
    assert.equal(view.field("What should I remember?"), "");
    change(view, "What should I remember?", "Gosto de café");
    view.button("Save memory").onPress();
    await view.flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), { text: "Gosto de café" });
  } finally {
    view.close();
  }
});

test("a delayed memory mutation refreshes the currently selected filter", async () => {
  const paths: string[] = [];
  const fixture = memoryView("MemorySettings", async (path) => {
    paths.push(path);
    return { entries: [memory] };
  });
  const { view } = fixture;
  try {
    await fixture.timers();
    const changed = view.nodes().find((node) => node.props.memory)?.props
      .changed as () => Promise<void>;
    assert.ok(changed);
    view.button("Forgotten").onPress();
    view.render();
    await fixture.timers();
    await changed();
    assert.match(paths.at(-1) ?? "", /status=forgotten/);
  } finally {
    view.close();
  }
});

test("mobile web installation opens the APK and retains a usable screen after a failed download", async () => {
  let attempts = 0;
  const view = componentHarness(
    new URL("../apps/mobile/src/app-install.tsx", import.meta.url),
    "AppInstall",
    {
      "lucide-react-native": { Download: "Download", Smartphone: "Smartphone" },
      "react-native": {
        ...native,
        Platform: { OS: "web" },
        Linking: {
          openURL: async (url: string) => {
            assert.equal(new URL(url).pathname, "/downloads/okamibot.apk");
            if (++attempts === 1) throw new Error("blocked");
          },
        },
      },
      "./i18n": { useI18n: () => ({ t: translate }) },
      "./ui": ui,
    },
  );
  view.render();
  try {
    view.button("Install app").onPress();
    view.render();
    assert.match(view.text(), /Safari/);
    view.button("Download Android app").onPress();
    await view.flush();
    assert.ok(view.nodes().some((node) => node.type === "ErrorNotice" && node.props.error));
    view.button("Download Android app").onPress();
    await view.flush();
    assert.equal(attempts, 2);
    assert.ok(!view.nodes().some((node) => node.type === "ErrorNotice" && node.props.error));
  } finally {
    view.close();
  }
});

function googleView(configured = true) {
  const calls: string[] = [];
  const requests: { path: string; body: unknown }[] = [];
  const workspace = {
    mode: "live",
    connections: [] as { id: string; status: string; account?: string; capabilities: string[] }[],
  };
  let account: {
    connected: boolean;
    connectionId?: string;
    account?: string;
    accounts?: {
      account: string;
      connectionId: string;
      capabilities: string[];
      isDefault: boolean;
    }[];
  } = {
    connected: false,
  };
  let poll: () => Promise<void> = async () => {};
  let refreshed = 0,
    failed = false,
    popupBlocked = false,
    closed = 0;
  const popup = {
    opener: {} as unknown,
    location: { href: "" },
    close: () => {
      closed++;
    },
  };
  const location = {
    assign: (url: string) => {
      popup.location.href = url;
    },
  };
  const api = {
    async request(path: string, body?: unknown) {
      calls.push(path);
      requests.push({ path, body });
      if (failed) throw new Error("Network unavailable");
      if (path === "/api/google/status") return { configured };
      if (path === "/api/google/account") return account;
      if (path === "/api/google/connect")
        return { url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" };
      if (path === "/api/google/disconnect") {
        account = { connected: false };
        return {};
      }
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const refresh = async () => {
    refreshed++;
    workspace.connections = account.connected
      ? [{ id: "google", status: "connected", account: account.account, capabilities: [] }]
      : [];
  };
  const view = componentHarness(
    new URL("../apps/mobile/src/native-connections.tsx", import.meta.url),
    "NativeConnections",
    {
      "react-native": {
        ...native,
        Platform: { OS: "web" },
        Linking: {},
        AppState: { addEventListener: () => ({ remove() {} }) },
      },
      "lucide-react-native": Object.fromEntries(
        ["ArrowDownToLine", "CalendarDays", "ChevronRight", "Globe2", "Link2", "Mail"].map(
          (name) => [name, name],
        ),
      ),
      "./i18n": { useI18n: () => ({ t: translate }) },
      "./ui": ui,
      "./workspace": { useWorkspace: () => ({ api, workspace, refresh, notify() {}, open() {} }) },
    },
    { query: "" },
    {
      setInterval: (run: () => Promise<void>) => {
        poll = run;
        return 1;
      },
      clearInterval() {},
      window: {
        location,
        open: () => {
          calls.push("open-popup");
          return popupBlocked ? null : popup;
        },
      },
    },
  );
  view.render();
  return {
    view,
    calls,
    requests,
    popup,
    refreshed: () => refreshed,
    closed: () => closed,
    async select() {
      const row = view.nodes().find((node) => node.props.accessibilityLabel === "Manage {name}");
      assert.ok(row);
      (row.props.onPress as () => void)();
      await view.flush();
    },
    async poll() {
      await poll();
      await view.flush();
    },
    account(value: typeof account) {
      account = {
        ...value,
        accounts:
          value.accounts ??
          (value.connected && value.account && value.connectionId
            ? [
                {
                  account: value.account,
                  connectionId: value.connectionId,
                  capabilities: [],
                  isDefault: true,
                },
              ]
            : []),
      };
    },
    fail(value: boolean) {
      failed = value;
    },
    blockPopup() {
      popupBlocked = true;
    },
  };
}

test("normal Google connection and adding another account both request Workspace permissions", async () => {
  const fixture = googleView();
  try {
    await fixture.select();
    fixture.view.button("Connect Google").onPress();
    await fixture.view.flush();
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(fixture.requests.findLast((r) => r.path === "/api/google/connect")?.body),
      ),
      {
        capability: "write",
        add: true,
      },
    );
    fixture.account({
      connected: true,
      account: "personal@example.test",
      connectionId: "personal",
      accounts: [
        {
          account: "personal@example.test",
          connectionId: "personal",
          capabilities: [],
          isDefault: true,
        },
      ],
    });
    await fixture.poll();
    fixture.view.button("Add another Google account").onPress();
    await fixture.view.flush();
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(fixture.requests.findLast((r) => r.path === "/api/google/connect")?.body),
      ),
      {
        capability: "write",
        add: true,
      },
    );
    assert.ok(fixture.view.text().includes("personal@example.test"));
    assert.ok(!fixture.requests.some((r) => r.path === "/api/google/disconnect"));
  } finally {
    fixture.view.close();
  }
});

test("Google setup is an app concern and never sends an unconfigured person to Composio", async () => {
  const fixture = googleView(false);
  try {
    await fixture.select();
    assert.match(fixture.view.text(), /administrator needs to finish the app setup/);
    assert.doesNotMatch(fixture.view.text(), /Composio|API key/);
    assert.deepEqual(fixture.calls, ["/api/google/status", "/api/google/account"]);
    assert.ok(!fixture.view.nodes().some((node) => node.props.children === "Connect Google"));
  } finally {
    fixture.view.close();
  }
});

test("Google opens authorization on the tap, refreshes each new receipt and supports a blocked popup", async () => {
  const fixture = googleView();
  const { view } = fixture;
  try {
    await fixture.select();
    fixture.calls.length = 0;
    view.button("Connect Google").onPress();
    assert.equal(fixture.calls[0], "open-popup");
    await view.flush();
    assert.equal(new URL(fixture.popup.location.href).origin, "https://accounts.google.com");
    assert.equal(fixture.popup.opener, null);
    fixture.account({ connected: true, account: "wife@example.test", connectionId: "first" });
    await fixture.poll();
    assert.equal(fixture.refreshed(), 1);
    assert.ok(view.button("Add another Google account"));
    await fixture.poll();
    assert.equal(
      fixture.refreshed(),
      1,
      "an unchanged account must not continuously reload the workspace",
    );
    fixture.account({ connected: true, account: "wife@example.test", connectionId: "upgraded" });
    await fixture.poll();
    assert.equal(fixture.refreshed(), 2, "same-account permission upgrades must also update");
    fixture.blockPopup();
    view.button("Add another Google account").onPress();
    await view.flush();
    assert.match(fixture.popup.location.href, /accounts.google.com/);
    fixture.fail(true);
    view.button("Add another Google account").onPress();
    await view.flush();
    assert.ok(
      view
        .nodes()
        .some((node) => node.type === "ErrorNotice" && node.props.error === "Network unavailable"),
    );
    fixture.fail(false);
    view.button("Disconnect this account").onPress();
    await view.flush();
    assert.ok(view.button("Connect Google"));
  } finally {
    view.close();
  }
});
