import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const mobileRequire = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const configRequire = createRequire(mobileRequire.resolve("expo/metro-config"));
const expoRequire = createRequire(configRequire.resolve("@expo/metro-config"));
const metroRequire = createRequire(expoRequire.resolve("metro/package.json"));

// Run a malformed-box regression in a bounded disposable process, never the test event loop.
test("Metro's image parser rejects a zero-size JXL partial stream without hanging", () => {
  const parser = metroRequire.resolve("image-size");
  // Signature (12 bytes), ftyp (16 bytes), then an actual zero-size jxlp box.
  // Keep box boundaries explicit: putting jxlp inside ftyp only tests a brand.
  const fixture = Buffer.concat([
    Buffer.from("0000000c4a584c200d0a870a", "hex"),
    Buffer.from("00000010667479706a786c206a786c20", "hex"),
    Buffer.from("000000006a786c700000000000000000", "hex"),
  ]);
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=32",
      "--max-semi-space-size=1",
      "-e",
      `
    const mod = require(${JSON.stringify(parser)});
    const size = mod.imageSize || mod.default || mod;
    const bytes = Buffer.from(${JSON.stringify(fixture.toString("hex"))}, 'hex');
    try { size(bytes); process.stdout.write('accepted'); }
    catch { process.stdout.write('rejected'); }
  `,
    ],
    { timeout: 2000, encoding: "utf8", maxBuffer: 4096 },
  );
  assert.equal(
    result.status,
    0,
    `Image parser did not terminate: ${result.signal ?? result.error?.message}`,
  );
  assert.equal(result.stdout, "rejected");
});

test("actual Metro asset loading accepts regular and scaled PNG files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okami-assets-"));
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzTkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(directory, "sample.png"), png);
    await writeFile(join(directory, "sample@2x.png"), png);
    const assets = metroRequire(
      join(dirname(metroRequire.resolve("./package.json")), "src/Assets.js"),
    );
    const result = await assets.getAssetData(
      join(directory, "sample.png"),
      "sample.png",
      [],
      "android",
      "/assets",
    );
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.deepEqual(result.scales, [1, 2]);
    assert.equal(result.files.length, 2);
    assert.deepEqual(assets.getAssetSize("png", png, "sample.png"), { width: 1, height: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
