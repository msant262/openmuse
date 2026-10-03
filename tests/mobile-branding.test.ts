import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("OkamiBot display branding preserves installed app and paired storage identities", async () => {
  const { expo } = JSON.parse(await readFile("apps/mobile/app.json", "utf8"));
  assert.equal(expo.name, "OkamiBot");
  assert.equal(expo.slug, "openmuse");
  assert.equal(expo.scheme, "openmuse");
  assert.equal(expo.android.package, "app.openmuse.mobile");
  assert.equal(expo.ios.bundleIdentifier, "app.openmuse.mobile");
  assert.equal(expo.icon, "./assets/companions/okami-idle-poster.png");
  assert.equal(expo.web.favicon, expo.icon);
  assert.equal(expo.android.adaptiveIcon.foregroundImage, "./assets/companions/okami-poster.png");
  const storage = await readFile("apps/mobile/src/credential-storage.native.ts", "utf8");
  assert(storage.includes('keychainService: "openmuse.device-session"'));
  assert(storage.includes("openmuse.device-session.v1."));
  const push = await readFile("apps/mobile/src/native-push.native.ts", "utf8");
  assert(push.includes('setNotificationChannelAsync("openmuse"'));
  assert(push.includes('name: "OkamiBot"'));
  const image = await readFile("apps/mobile/assets/capybara.png");
  assert.equal(
    createHash("sha256").update(image).digest("hex"),
    "3a323215d0976583d0c3d0748df06bce75db9b05cc955901709b18e3b64e9b34",
  );
  assert((await readFile("LICENSE", "utf8")).includes("MIT License"));
});
