import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentPart } from "@tanstack/ai";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const MAX_BYTES = 1024 * 1024;
type ScreenshotAsset = {
  id: string;
  size: number;
  mimeType: "image/jpeg" | "image/png";
  createdAt: string;
};
/** Images live once beneath DATA_DIR; cumulative AG-UI history stores only owner-scoped refs. */
export class BrowserAssets {
  constructor(
    private readonly db: Store,
    private readonly dataDir: string,
  ) {}
  private directory(owner: string) {
    return join(
      this.dataDir,
      "browser-screenshots",
      createHash("sha256").update(owner).digest("hex"),
    );
  }
  async save(
    owner: string,
    bytes: Buffer,
    mimeType: "image/jpeg" | "image/png" = "image/jpeg",
  ): Promise<ScreenshotAsset> {
    if (!bytes.length || bytes.length > MAX_BYTES)
      throw new AppError("Browser screenshot exceeds 1 MiB", 413);
    const id = createHash("sha256").update(bytes).digest("hex");
    const existing = await this.db.get<ScreenshotAsset>(owner, "browser-screenshots", id);
    if (existing) return existing;
    const folder = this.directory(owner);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      // A complete image becomes visible atomically, including concurrent same-hash saves.
      await rename(temporary, join(folder, `${id}.${mimeType === "image/png" ? "png" : "jpg"}`));
    } finally {
      await rm(temporary, { force: true });
    }
    const asset = {
      id,
      size: bytes.length,
      mimeType,
      createdAt: new Date().toISOString(),
    };
    await this.db.insertIfAbsent(owner, "browser-screenshots", asset);
    return asset;
  }
  async image(owner: string, id: string): Promise<ContentPart> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError("Screenshot not found", 404);
    const asset = await this.db.get<ScreenshotAsset>(owner, "browser-screenshots", id);
    if (!asset) throw new AppError("Screenshot not found", 404);
    const handle = await open(
      join(this.directory(owner), `${id}.${asset.mimeType === "image/png" ? "png" : "jpg"}`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== asset.size || info.size > MAX_BYTES)
        throw new AppError("Screenshot storage is invalid", 502);
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== id)
        throw new AppError("Screenshot storage is invalid", 502);
      return {
        type: "image",
        source: { type: "data", value: bytes.toString("base64"), mimeType: asset.mimeType },
      };
    } finally {
      await handle.close();
    }
  }
}
