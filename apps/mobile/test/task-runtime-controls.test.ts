import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import { taskBudgetSchema } from "../../../packages/domain/src/runtime.ts";
import * as state from "../src/task-runtime-state.ts";

// Exercise the actual component callbacks with deterministic hook scheduling.
// Native visual/accessibility checks still belong to the Android device tests.
type Element = {
  type: string | ((props: Record<string, unknown>) => Element);
  key?: string;
  props: Record<string, unknown> & { onPress: () => void; onChangeText: (value: string) => void };
};
function harness(
  task: AgentTask,
  transport: {
    request: (path: string) => Promise<unknown>;
    mutate: (path: string, body: unknown) => Promise<unknown>;
  },
) {
  const cells: { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: () => void }[] =
    [];
  let index = 0,
    effects: (() => void)[] = [],
    tree: Element,
    updatesAfterUnmount = 0;
  let mounted = true;
  const hooks = {
    useState(initial: unknown) {
      const i = index++;
      cells[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [
        cells[i].value,
        (value: unknown) => {
          if (!mounted) updatesAfterUnmount++;
          cells[i].value = typeof value === "function" ? value(cells[i].value) : value;
        },
      ];
    },
    useRef(value: unknown) {
      const i = index++;
      cells[i] ??= { current: value };
      return cells[i];
    },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const i = index++,
        old = cells[i];
      if (!old || deps.some((value, n) => value !== old.deps?.[n])) {
        old?.cleanup?.();
        cells[i] = { deps };
        effects.push(() => {
          cells[i].cleanup = run();
        });
      }
    },
  };
  let id = 0;
  const jsx = (type: Element["type"], props: Element["props"], key?: string) => ({
    type,
    props,
    key,
  });
  const dependencies: Record<string, unknown> = {
    "expo-crypto": { randomUUID: () => `change-${++id}` },
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "../../../packages/domain/src/runtime": { taskBudgetSchema },
    "./agent-workspace": { useAgentWorkspace: () => ({ mutate: transport.mutate }) },
    "./task-runtime-state": state,
    "./ui": {
      Button: "Button",
      Card: "Card",
      ErrorNotice: "ErrorNotice",
      Field: "Field",
      colors: {},
      s: {},
    },
    "./workspace": {
      useWorkspace: () => ({ api: { identityKey: "paired-device", request: transport.request } }),
    },
  };
  const source = readFileSync(new URL("../src/task-runtime-controls.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const result = { exports: {} as Record<string, (props: { task: AgentTask }) => Element> };
  vm.runInNewContext(`(function(require,module,exports){${js}})`)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    result,
    result.exports,
  );
  let component = "TaskTimingControls";
  function render() {
    index = 0;
    effects = [];
    const wrapper = result.exports[component]({ task });
    assert.equal(typeof wrapper.type, "function");
    tree = (wrapper.type as (props: Record<string, unknown>) => Element)(wrapper.props);
    for (const effect of effects) effect();
  }
  function nodes(value: unknown): Element[] {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    const element = value as Element;
    return [element, ...nodes(element.props?.children)];
  }
  function find(type: string, label: string) {
    const element = nodes(tree).find(
      (item) => item.type === type && (item.props.label === label || item.props.children === label),
    );
    assert.ok(element, `${type}: ${label}`);
    return element;
  }
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    render();
  }
  return {
    render,
    find,
    flush,
    choose(name: string) {
      component = name;
      render();
    },
    update(value: AgentTask) {
      task = value;
      render();
    },
    unmount() {
      for (const cell of cells) cell.cleanup?.();
      mounted = false;
    },
    get lateUpdates() {
      return updatesAfterUnmount;
    },
  };
}
function task(): AgentTask {
  return {
    title: "Task",
    prompt: "Prepare the file",
    kind: "agent",
    plan: [],
    evidence: [],
    input: {},
    createdAt: "2026-10-02T12:00:00Z",
    updatedAt: "2026-10-02T12:00:00Z",
    attempts: 0,
    artifactIds: [],
    id: "task-a",
    status: "running",
    state: {
      timingRevision: 3,
      budget: {
        id: "root",
        revision: 5,
        maxSteps: 96,
        usedSteps: 96,
        maxMilliseconds: 3600000,
        usedMilliseconds: 120000,
      },
    },
    timing: { priority: "normal", timezone: "Europe/Berlin" },
  };
}
test("timing card retries the original submitted edit after lost ACK and incoming refresh", async () => {
  const original = task();
  const calls: { path: string; body: unknown }[] = [];
  const view = harness(original, {
    request: async () => ({ task: original }),
    mutate: async (path, body) => {
      calls.push({ path, body });
      if (calls.length === 1) throw new Error("Connection lost");
    },
  });
  view.render();
  view.find("Button", "Edit timing").props.onPress();
  await view.flush();
  view.find("Field", "Desired deadline (optional)").props.onChangeText("03/10/2026 16:00");
  view.render();
  view.find("Button", "Save timing").props.onPress();
  await view.flush();
  assert.equal(view.find("Field", "Desired deadline (optional)").props.editable, false);
  view.update({ ...original, state: { ...original.state, timingRevision: 4 } });
  view.find("Button", "Retry change").props.onPress();
  await view.flush();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].path, "/tasks/task-a/timing");
  assert.equal((calls[0].body as { expectedRevision: number }).expectedRevision, 3);
  assert.ok(view.find("Text", "Timing saved."));
});
test("late timing reload cannot update a closed or replaced task card", async () => {
  let resolve!: (value: unknown) => void;
  const view = harness(task(), {
    request: () =>
      new Promise((done) => {
        resolve = done;
      }),
    mutate: async () => {},
  });
  view.render();
  view.find("Button", "Edit timing").props.onPress();
  view.unmount();
  resolve({ task: task() });
  await new Promise((done) => setImmediate(done));
  assert.equal(view.lateUpdates, 0);
});
test("lost budget authorization ACK cannot grant a second extension using refreshed revision", async () => {
  const original = task();
  const calls: { path: string; body: unknown }[] = [];
  const view = harness(original, {
    request: async () => ({}),
    mutate: async (path, body) => {
      calls.push({ path, body });
      throw new Error("Connection lost");
    },
  });
  view.choose("TaskBudgetControls");
  view.find("Button", "Allow 24 more steps and 30 minutes").props.onPress();
  await view.flush();
  const budget = original.state.budget as Record<string, unknown>;
  view.update({
    ...original,
    state: { ...original.state, budget: { ...budget, revision: 6, maxSteps: 120 } },
  });
  view.find("Button", "Retry authorization").props.onPress();
  await view.flush();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal((calls[0].body as { expectedRevision: number }).expectedRevision, 5);
});
