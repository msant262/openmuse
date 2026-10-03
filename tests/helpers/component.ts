import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Node = { type: unknown; props: Record<string, unknown> };
type Cell = { value?: unknown; current?: unknown; deps?: readonly unknown[]; cleanup?: () => void };

/** Deterministic hooks/JSX harness for actual rendered handlers, without React Native runtime. */
export function componentHarness(source: URL, name: string, dependencies: Record<string, unknown>) {
  const cells: Cell[] = [];
  let index = 0;
  let effects: (() => void)[] = [];
  let tree: unknown;
  const hooks = {
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
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules = { ...dependencies, react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx } };
  const js = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const factory = runInNewContext(`(function(require,module,exports){${js}})`);
  factory(
    (key: string) => {
      assert.ok(key in modules, `Unknown component dependency: ${key}`);
      return modules[key as keyof typeof modules];
    },
    module,
    module.exports,
  );
  const component = module.exports[name];
  assert.equal(typeof component, "function");
  const render = () => {
    index = 0;
    effects = [];
    tree = (component as () => unknown)();
    for (const run of effects) run();
  };
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [node, ...nodes(node.props.children)];
  }
  function text(value: unknown): string {
    if (Array.isArray(value)) return value.map(text).join("");
    if (value == null || value === false) return "";
    if (typeof value !== "object") return String(value);
    return text((value as Node).props?.children);
  }
  return {
    render,
    async flush() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      render();
    },
    text: () => text(tree),
    field(label: string) {
      return nodes(tree).find((node) => node.type === "Field" && node.props.label === label)?.props
        .value;
    },
    button(label: string) {
      const node = nodes(tree).find((item) => item.type === "Button" && text(item) === label);
      assert.ok(node, `Missing button: ${label}`);
      return node.props as { onPress: () => unknown; disabled?: boolean; busy?: boolean };
    },
    close() {
      for (const cell of cells) cell.cleanup?.();
    },
  };
}
