import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import * as catalogModule from "../apps/server/src/design-catalog.ts";
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

test("natural Portuguese briefs retrieve matching composition and typography instead of requiring every literal word", async () => {
  const catalog = new DesignCatalog();
  const warm = await catalog.list({
    query: "Quero um relatório editorial acolhedor com tipografia serifada",
    limit: 5,
  });
  assert.ok(warm.references.some(({ id }) => id === "claude"));
  assert.equal(
    warm.references[0]?.id,
    "claude",
    "a warm serif editorial brief should favor its defining traits over incidental body mentions",
  );
  const cinema = await catalog.list({
    query: "Uma apresentação cinematográfica com fotografia e luxo",
    limit: 5,
  });
  assert.ok(cinema.references.some(({ id }) => ["ferrari", "bugatti", "runwayml"].includes(id)));
  assert.notEqual(warm.references[0]?.id, cinema.references[0]?.id);
  const exact = await catalog.list({ query: "Quero o estilo Linear.app com fotografia", limit: 5 });
  assert.equal(exact.references[0]?.id, "linear.app");
  assert.equal((await catalog.list({ query: "Cal" })).references[0]?.id, "cal");
  assert.equal((await catalog.list({ query: "plasmaquantumxyz" })).total, 0);
  const sans = await catalog.recommend({ query: "tipografia sem serifa" });
  const englishSans = await catalog.recommend({ query: "sans-serif typography" });
  assert.equal(sans.total, englishSans.total);
  assert.ok(sans.references.length);
  for (const { matchedTerms } of sans.references)
    assert.deepEqual(matchedTerms, ["sans"], "sem serifa means sans-serif, not serif");
});

test("recommendations expose bounded source excerpts for contrasting composition, with full catalog access", async () => {
  const [tool] = designReferenceTools(new DesignCatalog());
  assert.ok(tool.execute);
  const result = JSON.parse(
    JSON.stringify(
      await tool.execute({
        action: "recommend",
        query: "revista editorial com fotografia e tipografia expressiva",
        limit: 3,
      } as never),
    ),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.authority, "reference_data");
  assert.equal(result.references.length, 3);
  assert.ok(JSON.stringify(result).length < 12000);
  assert.equal(new Set(result.references.map((entry: { id: string }) => entry.id)).size, 3);
  assert.ok(result.references.some((entry: { profileIds: string[] }) => !entry.profileIds.length));
  const catalog = new DesignCatalog();
  for (const reference of result.references) {
    assert.ok(reference.matchedTerms.length);
    assert.ok(reference.cues.some((cue: { aspect: string }) => cue.aspect === "layout"));
    assert.ok(reference.cues.some((cue: { aspect: string }) => cue.aspect === "typography"));
    const fullSource = await readFile(join(directory, reference.path), "utf8");
    assert.equal(sha256(fullSource), reference.sha256);
    for (const cue of reference.cues) {
      assert.ok(
        cue.excerpt.length > 30,
        `${reference.id}: cue must contain design content, not just a heading`,
      );
      assert.ok(cue.excerpt.length <= 420);
      const page = await catalog.read(reference.id, cue.page);
      assert.ok(
        page.content.includes(cue.excerpt),
        `${reference.id}: excerpt must match source page`,
      );
    }
  }
  const unknown = JSON.parse(
    JSON.stringify(
      await tool.execute({
        action: "recommend",
        query: "plasmaquantumxyz",
      } as never),
    ),
  );
  assert.deepEqual(unknown.references, []);
  const tooMany = await tool.execute({
    action: "recommend",
    query: "editorial",
    limit: 20,
  } as never);
  assert.ok((tooMany as { error?: string }).error);
});

test("renderer source lookup resolves any exact catalog ID without hiding inventory failures", async () => {
  assert.equal("getDesignReference" in catalogModule, true);
  const lookup = catalogModule.getDesignReference as (
    id: string,
  ) => Promise<{ id: string; sha256: string } | undefined>;
  const reference = await lookup("wired");
  assert.equal(reference?.id, "wired");
  assert.equal(
    reference?.sha256,
    sha256(await readFile(join(directory, "design-md/wired/DESIGN.md"), "utf8")),
  );
  assert.equal(await lookup("not-a-reference"), undefined);
  await assert.rejects(lookup("../wired"));
});

test("recent preset aliases annotate canonical references while explicit names keep priority", async () => {
  const [tool] = designReferenceTools(new DesignCatalog(), {
    recent: async () => [{ reference: "linear", layout: "briefing", title: "Previous report" }],
  });
  assert.ok(tool.execute);
  const result = JSON.parse(
    JSON.stringify(
      await tool.execute({
        action: "recommend",
        query: "Quero Linear com fotografia editorial",
        limit: 3,
      } as never),
    ),
  );
  assert.equal(result.references[0].id, "linear.app");
  assert.equal(result.references[0].usedRecently, true);
  const catalog = new DesignCatalog();
  const first = await catalog.recommend({ query: "editorial" });
  const repeated = await catalog.recommend({
    query: "editorial",
    avoidIds: first.references.map(({ id }) => id),
  });
  assert.notEqual(first.references[0].id, repeated.references[0].id);
  assert.equal(
    (await catalog.recommend({ query: "Claude", avoidIds: ["claude"] })).references[0]?.id,
    "claude",
  );
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
    { action: "search", query: "x".repeat(2001) },
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
