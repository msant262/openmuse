import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { DeviceSessions } from "./device-sessions.ts";
import { AppError } from "./errors.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
export class Auth {
  readonly devices: DeviceSessions;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {
    this.devices = new DeviceSessions(db, signingKey, config.sessionDeviceIdleDays ?? 0);
  }
  async session(
    accessKey?: string,
    deviceLabel = "OpenMuse device",
    transport: "native" | "web" = "native",
  ) {
    if (
      this.config.mode === "live" &&
      (!accessKey ||
        !this.config.accessKey ||
        !timingSafeEqual(digest(accessKey), digest(this.config.accessKey)))
    )
      throw new AppError("Access key is incorrect", 401);
    return {
      ...(await this.devices.pair("local-user", deviceLabel, transport)),
      mode: this.config.mode,
    };
  }
  async owner(authorization?: string) {
    if (!authorization?.startsWith("Bearer "))
      throw new AppError("Sign in to OpenMuse", 401, "SESSION_REQUIRED");
    if (authorization.slice(7).startsWith("om1."))
      return this.devices.owner(authorization.slice(7));
    const session = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      digest(authorization.slice(7)).toString("hex"),
    );
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Pair this device again.", 401, "SESSION_EXPIRED");
    return session.owner;
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  return new Auth(db, config, await getOrCreateSigningKey(config.dataDir));
}

/** Publish a fully written key by atomic hard-link; losers read the winning key. */
export async function getOrCreateSigningKey(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "session-signing-key");
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = join(directory, `.session-signing-key-${randomBytes(16).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(randomBytes(32).toString("base64"));
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return await readFile(path, "utf8");
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}
