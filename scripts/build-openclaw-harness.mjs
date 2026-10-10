import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("third_party/openclaw/harness");
const toolResultLimits = "src/agents/tool-result-limits.ts";
const portableToolResultLimits = resolve("apps/server/src/engine/openclaw/tool-result-limits.ts");
const upstream = JSON.parse(await readFile(join(root, "UPSTREAM.json"), "utf8"));
for (const [path, expected] of Object.entries(upstream.sha256)) {
  const actual = createHash("sha256")
    .update(await readFile(join(root, path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Copied harness source changed: ${path}`);
}
// The original runtime launches workers relative to /dist, so preserve their
// entry paths. All workspace packages are bundled from the copied source tree.
const entries = { "openclaw-harness/entry": join(root, "okami-harness-entry.ts") };
const launchers = await readFile(join(root, "src/infra/runtime-process-entrypoints.ts"), "utf8");
for (const match of launchers.matchAll(/runtimeProcessEntrypoint\(\s*"([^"]+)"/g)) {
  const path = join(root, "src", `${match[1]}.ts`);
  if (existsSync(path)) entries[match[1]] = path;
}
const result = await build({
  absWorkingDir: root,
  entryPoints: entries,
  chunkNames: "openclaw-harness/chunks/[name]-[hash]",
  outdir: resolve("dist"),
  platform: "node",
  target: "node24",
  format: "esm",
  splitting: true,
  bundle: true,
  metafile: true,
  packages: "external",
  banner: {
    js: 'import {createRequire as __okamiCreateRequire} from "node:module";const require=__okamiCreateRequire(import.meta.url);',
  },
  plugins: [
    {
      // Keep the pinned upstream bytes intact while sharing the app's effective
      // model budget with native persistence, dispatch and context guards.
      name: "owned-tool-result-budget",
      setup(builder) {
        builder.onLoad({ filter: /[/\\]agents[/\\]tool-result-limits\.ts$/ }, async ({ path }) => {
          if (path !== join(root, toolResultLimits)) return;
          const source = await readFile(path, "utf8");
          const start = source.indexOf(
            "/** Fresh producer text must fit persistence/dispatch and the raw-weight context guard. */",
          );
          if (start < 0) throw new Error("Copied native tool budget boundary changed");
          const names =
            "DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS, resolveAutoLiveToolResultMaxChars, calculateMaxToolResultCharsWithCap, resolveLiveToolResultMaxChars";
          return {
            contents: `import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";\nimport { ${names} } from ${JSON.stringify(portableToolResultLimits)};\nexport { ${names} };\n${source.slice(start)}`,
            loader: "ts",
            resolveDir: dirname(path),
          };
        });
      },
    },
    {
      name: "copied-upstream-workspaces",
      setup(builder) {
        builder.onResolve({ filter: /^(?:@openclaw\/|openclaw\/plugin-sdk)/ }, async ({ path }) => {
          let file;
          if (path.startsWith("openclaw/")) {
            file = join(root, "src/plugin-sdk", `${path.slice("openclaw/plugin-sdk/".length)}.ts`);
          } else {
            const [, name, ...rest] = path.split("/");
            const base = join(root, "packages", name);
            if (!existsSync(join(base, "package.json"))) return { path, external: true };
            const metadata = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
            let entry = metadata.exports?.[rest.length ? `./${rest.join("/")}` : "."];
            if (typeof entry === "object") entry = entry.import ?? entry.default;
            file = join(
              base,
              (entry ?? `./dist/${rest.join("/") || "index"}.js`)
                .replace("./dist/", "src/")
                .replace(/\.m?[jc]s$/, ".ts"),
            );
          }
          if (path === "@openclaw/ai/diagnostics")
            file = join(root, "packages/ai/src/utils/diagnostics.ts");
          if (path === "@openclaw/ai/event-stream")
            file = join(root, "packages/ai/src/utils/event-stream.ts");
          if (!existsSync(file))
            throw new Error(`Missing copied workspace source ${path}: ${file}`);
          return { path: file };
        });
      },
    },
  ],
});
const output = "dist/openclaw-harness";
await mkdir(join(output, "chunks"), { recursive: true });
for (const name of ["openclaw-state-schema.sql", "openclaw-agent-schema.sql"]) {
  await copyFile(join(root, "src/state", name), join(output, "chunks", name));
}
await writeFile(
  join(output, "build-manifest.json"),
  JSON.stringify(
    {
      revision: upstream.revision,
      sources: Object.keys(result.metafile.inputs).length,
      outputs: Object.keys(result.metafile.outputs).length,
      adaptations: [
        {
          source: toolResultLimits,
          adapter: "apps/server/src/engine/openclaw/tool-result-limits.ts",
        },
      ],
    },
    null,
    2,
  ),
);
