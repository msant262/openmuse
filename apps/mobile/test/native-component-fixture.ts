import { readFile } from "node:fs/promises";
import type { URL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export type NativeNode = { type: unknown; props: Record<string, unknown> };

/** Runs component logic without Android hosts; effects advance at explicit render boundaries. */
export async function nativeComponentFixture(
  sourceUrl: URL,
  componentName: string,
  imports: Record<string, unknown>,
  initialProps: Record<string, unknown>,
) {
  let cursor = 0;
  const slots: unknown[] = [];
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  let pendingEffects: (() => void)[] = [];
  let tree: NativeNode;
  let props = initialProps;
  let mounted = true;
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value: unknown) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo(value: () => unknown, deps: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { deps: unknown[]; value: unknown } | undefined;
      if (!previous || !same(previous.deps, deps)) slots[index] = { deps, value: value() };
      return (slots[index] as { value: unknown }).value;
    },
    useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
      const index = cursor++;
      if (!same(effects[index]?.deps, deps))
        pendingEffects.push(() => {
          effects[index]?.cleanup?.();
          effects[index] = { deps, cleanup: effect() };
        });
    },
  };
  const exports: Record<string, (input: typeof props) => NativeNode> = {};
  const source = await readFile(sourceUrl, "utf8");
  const jsx = (type: unknown, props: NativeNode["props"]) => ({ type, props });
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    {
      exports,
      Date,
      // Polls are triggered explicitly by the tests, so no timers survive teardown.
      setInterval: () => 1,
      clearInterval: () => {},
      require(name: string) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name in imports) return imports[name];
        throw new Error(`Missing native boundary: ${name}`);
      },
    },
  );
  function render(nextProps?: typeof props) {
    if (!mounted) return;
    if (nextProps) props = { ...props, ...nextProps };
    cursor = 0;
    tree = exports[componentName](props);
    const current = pendingEffects;
    pendingEffects = [];
    for (const effect of current) effect();
  }
  function walk(node: unknown): NativeNode[] {
    if (Array.isArray(node)) return node.flatMap(walk);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const item = node as NativeNode;
    return [item, ...walk(item.props.children)];
  }
  render();
  return {
    render,
    nodes: () => walk(tree),
    async settle() {
      for (let i = 0; i < 60; i++) {
        await Promise.resolve();
        render();
      }
    },
    unmount() {
      mounted = false;
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}
