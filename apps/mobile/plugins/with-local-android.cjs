const { mkdir, copyFile } = require("node:fs/promises");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

// The explicit build endpoint decides transport. Live releases should use HTTPS.
module.exports = (config, { apiUrl }) => {
  config = withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest is missing");
    application.$["android:usesCleartextTraffic"] =
      new URL(apiUrl).protocol === "http:" ? "true" : "false";
    return result;
  });
  return withDangerousMod(config, [
    "android",
    async (result) => {
      const assets = path.join(result.modRequest.platformProjectRoot, "app/src/main/assets");
      await mkdir(assets, { recursive: true });
      await copyFile(
        path.resolve(result.modRequest.projectRoot, "../../LICENSE"),
        path.join(assets, "openmuse-LICENSE.txt"),
      );
      await copyFile(
        path.join(result.modRequest.projectRoot, "assets/README.md"),
        path.join(assets, "openmuse-ASSET-NOTICE.txt"),
      );
      return result;
    },
  ]);
};
