import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DesignCatalog,
  designReferenceTools,
  getDesignProfile,
  listDesignProfiles,
} from "../apps/server/src/design-catalog.ts";

const directory = resolve("third_party/awesome-design-md");
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

test("all pinned design references are discoverable, searchable by body, and read losslessly in bounded pages", async () => {
  const catalog = new DesignCatalog();
  const ids: string[] = [];
  let page = 0;
  for (;;) {
    const listed = await catalog.list({ page, limit: 20 });
    assert.equal(listed.total, 74);
    assert.ok(JSON.stringify(listed).length < 16000);
    ids.push(...listed.references.map((entry) => entry.id));
    if (listed.nextPage === null) break;
    page = listed.nextPage;
  }
  assert.equal(new Set(ids).size, 74);
  assert.ok(ids.includes("linear.app"));
  const found = await catalog.list({ query: "Copernicus", page: 0, limit: 20 });
  assert.ok(found.references.some((entry) => entry.id === "claude"));
  const pages: string[] = [];
  for (const id of ids) {
    pages.length = 0;
    let readPage = 0;
    for (;;) {
      const result = await catalog.read(id, readPage);
      assert.equal(result.authority, "reference_data");
      assert.match(result.policy, /permissions/);
      assert.ok(result.content.length <= 8000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(result.content));
      pages.push(result.content);
      if (result.nextPage === null) {
        assert.equal(sha256(pages.join("")), result.sha256);
        break;
      }
      readPage = result.nextPage;
    }
    assert.equal(
      pages.join(""),
      await readFile(join(directory, "design-md", id, "DESIGN.md"), "utf8"),
    );
  }
});

test("curated document profiles trace every palette and use paper-readable body colors", async () => {
  const profiles = await listDesignProfiles();
  assert.deepEqual(profiles.map(({ id }) => id).sort(), [
    "airbnb",
    "claude",
    "ibm",
    "linear",
    "notion",
    "spotify",
    "stripe",
    "vercel",
  ]);
  const luminance = (hex: string) => {
    const values = (hex.slice(1).match(/../g) ?? [])
      .map((value) => parseInt(value, 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const contrast = (a: string, b: string) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const profile of profiles) {
    assert.deepEqual(await getDesignProfile(profile.id), profile);
    const source = await readFile(join(directory, profile.source.path), "utf8");
    assert.equal(sha256(source), profile.source.sha256);
    assert.equal(profile.source.revision, "f6961238d5cddcf8042a74a70fc400ec67181abb");
    for (const color of Object.values(profile.tokens))
      assert.ok(
        source.toLowerCase().includes(color.toLowerCase()),
        `${profile.id}: ${color} must trace to source`,
      );
    assert.ok(contrast(profile.tokens.paper, profile.tokens.ink) >= 4.5);
    assert.ok(contrast(profile.tokens.paper, profile.tokens.muted) >= 4.5);
    assert.ok(["serif", "sans"].includes(profile.display));
  }
  assert.equal(await getDesignProfile("unknown"), undefined);
});

test("design tool is bounded read-only data with exact IDs, no traversal and lifecycle hooks", async () => {
  let before = 0;
  let queued = 0;
  const [tool] = designReferenceTools(new DesignCatalog(), {
    before: async () => {
      before++;
    },
    queue: async (operation) => {
      queued++;
      return operation();
    },
  });
  assert.equal(tool.name, "design_references");
  const run = tool.execute;
  assert.ok(run);
  const execute = async (args: object) => JSON.parse(JSON.stringify(await run(args as never)));
  const result = await execute({ action: "read", id: "claude", page: 0 });
  assert.equal(result.id, "claude");
  assert.equal(result.authority, "reference_data");
  for (const args of [
    { action: "read", id: "../../LICENSE" },
    { action: "read", id: "claude", page: 999 },
    { action: "search", query: "x".repeat(161) },
    { action: "list", limit: 1000 },
    { action: "write", id: "claude" },
  ]) {
    const rejected = await execute(args);
    assert.ok(rejected.error);
    assert.ok(!JSON.stringify(rejected).includes(directory));
  }
  assert.equal(before, 6);
  assert.equal(queued, 6);
});

test("modified or linked vendored references are rejected before content reaches a caller", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "design-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(directory, root, { recursive: true });
  const path = join(root, "design-md", "claude", "DESIGN.md");
  await writeFile(path, "TAMPERED_REFERENCE");
  await assert.rejects(new DesignCatalog(root).read("claude", 0), /unavailable/i);
  await rm(path);
  await symlink(join(directory, "design-md", "claude", "DESIGN.md"), path);
  await assert.rejects(new DesignCatalog(root).read("claude", 0), /unavailable/i);
});
