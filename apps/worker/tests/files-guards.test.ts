import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import { publicFixture } from "./public-fixture.ts";

test("real numbered file upload guards stale targets/hash/control; popups and dialogs are contained with safe provenance", async () => {
  const fixture = await publicFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "okami-browser-files-"));
  const browser = await createBrowserManager({ dataDir });
  const id = randomUUID(),
    bytes = Buffer.from("owned workspace content");
  const file = {
    artifactId: randomUUID(),
    name: "owned.txt",
    size: bytes.length,
    mimeType: "text/plain",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
  try {
    await browser.create(id, "https://browser.fixture.test/upload");
    let snapshot = await browser.snapshot(id);
    const upload = snapshot.elements.find((element) => element.type === "file");
    assert.ok(upload);
    const body = { ...file, snapshotId: snapshot.snapshotId, element: upload.number };
    await assert.rejects(browser.upload(id, { ...body, sha256: "0".repeat(64) }), {
      code: "INVALID_UPLOAD",
    });
    snapshot = await browser.upload(id, body);
    assert.match((await browser.read(id)).text, /owned workspace content/);
    await assert.rejects(browser.upload(id, body), { code: "STALE_SNAPSHOT" });
    for (const label of ["Public popup", "Private popup", "Confirm"]) {
      const element = snapshot.elements.find((item) => item.label === label);
      assert.ok(element);
      snapshot = await browser.act(id, {
        snapshotId: snapshot.snapshotId,
        element: element.number,
        action: "click",
      });
    }
    assert.equal(snapshot.interruptions.popupsBlocked, 2);
    assert.equal(snapshot.interruptions.dialogsDismissed, 1);
    assert.match((await browser.read(id)).text, /dismissed/);
    assert.ok(!JSON.stringify(snapshot).includes("sensitive-dialog-fixture-marker"));
    assert.ok(!fixture.requests.some((request) => request.path === "/private"));
    await browser.setControl(id, "human");
    await assert.rejects(browser.upload(id, { ...body, snapshotId: snapshot.snapshotId }), {
      code: "BROWSER_CONTROLLED",
    });
    await browser.setControl(id, "agent");
    await browser.navigate(id, "https://browser.fixture.test/download.csv");
    await browser.close();
    const restored = await createBrowserManager({ dataDir });
    try {
      const downloads = await restored.downloads(id);
      assert.deepEqual(downloads.failures, []);
      assert.equal(downloads.downloads[0].mimeType, "text/csv");
      const downloaded = await restored.download(id, downloads.downloads[0].id);
      assert.equal(downloaded.bytes.toString(), "name,value\nfixture,42\n");
      assert.equal(
        downloaded.metadata.sha256,
        createHash("sha256").update(downloaded.bytes).digest("hex"),
      );
    } finally {
      await restored.close();
    }
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});
