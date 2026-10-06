import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const services = {
  gmail: "v1",
  calendar: "v3",
  drive: "v3",
  docs: "v1",
  sheets: "v4",
  slides: "v1",
};
const directory = new URL("../packages/integrations/assets/google-discovery/", import.meta.url);
await mkdir(directory, { recursive: true });
const manifest = {};
await Promise.all(
  Object.entries(services).map(async ([service, version]) => {
    const url =
      service === "drive"
        ? "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"
        : `https://${service === "calendar" ? "calendar-json" : service}.googleapis.com/$discovery/rest?version=${version}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw new Error(`${service}: HTTP ${response.status}`);
    const document = await response.json();
    if (document.name !== service || document.version !== version)
      throw new Error("Unexpected Google API");
    const bytes = JSON.stringify(document);
    await writeFile(new URL(`${service}.json`, directory), bytes);
    manifest[service] = {
      version,
      revision: document.revision,
      url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
await writeFile(new URL("manifest.json", directory), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
