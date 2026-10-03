import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ApiError } from "../apps/mobile/src/api-errors.ts";
import { parseThreadSelection } from "../apps/mobile/src/thread-selection.ts";

type Selection = { id: string; existing: boolean };
type ThreadState = {
  selection: Selection;
  visited: Selection[];
  loading: boolean;
  error: string;
  select(next: Selection): void;
};
type Cell = {
  value?: unknown;
  current?: unknown;
  deps?: readonly unknown[];
  cleanup?: () => void;
};

// Run the actual provider's lifecycle with controlled storage and network races.
function fixture({ pendingWrites = false } = {}) {
  const main = { id: "00000000-0000-4000-8000-000000000001", existing: true };
  const draft = { id: "00000000-0000-4000-8000-000000000002", existing: false };
  let saved = JSON.stringify({ mainId: main.id, selection: main, visited: [main] });
  let unavailable = false;
  let mainRequests = 0;
  let selectionReads = 0;
  let t = (key: string) => key;
  const writers: (() => void)[] = [];
  const cells: Cell[] = [];
  let index = 0;
  let effects: (() => void)[] = [];
  const hooks = {
    createContext: () => ({ Provider: "ThreadProvider" }),
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in cells))
        cells[slot] = { value: typeof initial === "function" ? initial() : initial };
      return [
        cells[slot].value,
        (next: unknown) => {
          cells[slot].value = typeof next === "function" ? next(cells[slot].value) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const slot = index++;
      if (!(slot in cells)) cells[slot] = { current: initial };
      return cells[slot];
    },
    useEffect(run: () => undefined | (() => void), deps: readonly unknown[]) {
      const slot = index++;
      const before = cells[slot];
      if (!before || deps.some((value, n) => value !== before.deps?.[n])) {
        before?.cleanup?.();
        cells[slot] = { deps };
        effects.push(() => {
          cells[slot].cleanup = run() ?? undefined;
        });
      }
    },
  };
  const api = {
    identityKey: "thread-locale-owner",
    async request(path: string) {
      if (path === "/api/main-thread") mainRequests++;
      if (unavailable) throw new Error("Offline");
      return { threadId: main.id, existing: true };
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@copilotkit/react-native/headless": {},
    "lucide-react-native": {},
    "react-native": {},
    "react-native-safe-area-context": {},
    "../../../packages/domain/src/brand": { PRODUCT_NAME: "OkamiBot" },
    "./api-errors": { ApiError },
    "./thread-actions": {},
    "./i18n": { useI18n: () => ({ t }) },
    "./thread-selection": { parseThreadSelection },
    "./ui": {},
    "./workspace": {
      useWorkspace: () => ({ workspace: { runtime: { richThreads: true } }, navigate() {}, api }),
    },
    "./message-storage": {
      removeConversationCache: async () => {},
      messageStorage: {
        async read() {
          selectionReads++;
          if (unavailable) throw new Error("Saved conversation selection is unavailable");
          return saved;
        },
        async write(_key: string, value: string) {
          if (pendingWrites)
            await new Promise<void>((resolve) => {
              writers.push(resolve);
            });
          saved = value;
        },
      },
    },
  };
  const source = readFileSync(new URL("../apps/mobile/src/threads.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} as { ThreadsProvider?: (props: unknown) => unknown } };
  runInNewContext(`(function(require,module,exports){${js}})`)(
    (key: string) => {
      assert.ok(key in modules, `Unknown provider dependency: ${key}`);
      return modules[key];
    },
    module,
    module.exports,
  );
  const component = module.exports.ThreadsProvider;
  assert.ok(component);
  const render = () => {
    index = 0;
    effects = [];
    const tree = component({ children: null }) as {
      props: { value: ThreadState };
    };
    for (const run of effects) run();
    return tree.props.value;
  };
  return {
    main,
    draft,
    render,
    async flush() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return render();
    },
    switchLocale() {
      t = (key: string) => `PT ${key}`;
      render();
    },
    disconnect() {
      unavailable = true;
    },
    mainRequests: () => mainRequests,
    selectionReads: () => selectionReads,
    close() {
      for (const cell of cells) cell.cleanup?.();
      for (const resolve of writers) resolve();
    },
  };
}

test("changing app language preserves a draft conversation while its selection save is pending", async () => {
  const view = fixture({ pendingWrites: true });
  try {
    view.render();
    let state = await view.flush();
    state.select(view.draft);
    state = view.render();
    assert.deepEqual(state.selection, view.draft);
    assert.deepEqual(Array.from(state.visited), [view.main, view.draft]);
    view.switchLocale();
    state = await view.flush();
    assert.deepEqual(state.selection, view.draft);
    assert.deepEqual(Array.from(state.visited), [view.main, view.draft]);
    assert.equal(state.loading, false);
    assert.equal(view.mainRequests(), 1);
    assert.equal(view.selectionReads(), 1);
  } finally {
    view.close();
  }
});

test("changing app language keeps an initialized conversation usable when its storage and network fail", async () => {
  const view = fixture();
  try {
    view.render();
    let state = await view.flush();
    state.select(view.draft);
    view.render();
    state = await view.flush();
    view.disconnect();
    view.switchLocale();
    state = await view.flush();
    assert.deepEqual(state.selection, view.draft);
    assert.deepEqual(Array.from(state.visited), [view.main, view.draft]);
    assert.equal(state.loading, false);
    assert.equal(state.error, "");
    assert.equal(view.mainRequests(), 1);
    assert.equal(view.selectionReads(), 1);
  } finally {
    view.close();
  }
});
