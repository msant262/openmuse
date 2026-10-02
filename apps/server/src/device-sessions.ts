import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const ACCESS_MS = 15 * 60 * 1000;
const RECOVERY_MS = 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const refreshSchema = z.object({
  deviceId: z.uuid(),
  rotationId: z.string().min(8).max(128),
  currentToken: z.string().min(1).max(256),
  nextTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const accessSchema = z.object({
  deviceId: z.uuid(),
  owner: z.string().min(1),
  expiresAt: z.number().int(),
});
interface Receipt {
  rotationId: string;
  previousHash: string;
  nextHash: string;
  recoverUntil: number;
  successor?: string;
}
interface Device {
  id: string;
  owner: string;
  deviceLabel: string;
  transport: "native" | "web";
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
  revision: number;
  refreshHash: string;
  receipts: Receipt[];
}
export interface DeviceAccess {
  deviceId: string;
  owner: string;
  token: string;
  accessExpiresAt: number;
}

/** One record is the authority for access, rotation and receipts; CAS is crash-atomic. */
export class DeviceSessions {
  private readonly encryptionKey: string;
  constructor(
    private readonly db: Store,
    private readonly signingKey: string,
    private readonly idleDays = 0,
  ) {
    this.encryptionKey = createHash("sha256")
      .update(`openmuse:web-refresh:${signingKey}`)
      .digest("base64");
  }
  async pair(owner: string, deviceLabel: string, transport: Device["transport"] = "native") {
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const device: Device = {
      id: randomUUID(),
      owner,
      deviceLabel: z.string().trim().min(1).max(80).parse(deviceLabel),
      transport,
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
      revision: 0,
      refreshHash: hash(refreshToken),
      receipts: [],
    };
    await this.db.insertIfAbsent("system", "device-sessions", device);
    return { ...this.access(device), refreshToken };
  }
  private access(device: Device): DeviceAccess {
    const accessExpiresAt = Date.now() + ACCESS_MS;
    const encoded = Buffer.from(
      JSON.stringify({ deviceId: device.id, owner: device.owner, expiresAt: accessExpiresAt }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.signingKey)
      .update(`om1.${encoded}`)
      .digest("base64url");
    return {
      deviceId: device.id,
      owner: device.owner,
      token: `om1.${encoded}.${signature}`,
      accessExpiresAt,
    };
  }
  private async active(deviceId: string) {
    const device = await this.db.get<Device>("system", "device-sessions", deviceId);
    if (
      !device ||
      device.revokedAt !== null ||
      (this.idleDays > 0 && device.lastUsedAt + this.idleDays * 86_400_000 <= Date.now())
    )
      throw new AppError(
        "This device pairing was revoked. Pair this device again.",
        401,
        "SESSION_REVOKED",
      );
    return device;
  }
  async owner(token: string) {
    const [version, encoded, signature, extra] = token.split(".");
    if (version !== "om1" || !encoded || !signature || extra)
      throw new AppError("Invalid workspace session", 401, "SESSION_REQUIRED");
    const expected = createHmac("sha256", this.signingKey).update(`om1.${encoded}`).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new AppError("Invalid workspace session", 401, "SESSION_REQUIRED");
    let claims: z.infer<typeof accessSchema>;
    try {
      claims = accessSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    } catch {
      throw new AppError("Invalid workspace session", 401, "SESSION_REQUIRED");
    }
    const device = await this.active(claims.deviceId);
    if (claims.owner !== device.owner)
      throw new AppError("Invalid workspace session", 401, "SESSION_REQUIRED");
    if (claims.expiresAt <= Date.now())
      throw new AppError("Workspace access expired", 401, "SESSION_EXPIRED");
    return device.owner;
  }
  async refresh(input: z.infer<typeof refreshSchema>): Promise<DeviceAccess> {
    const request = refreshSchema.parse(input);
    return this.rotate(request, "native");
  }
  async refreshWeb(deviceId: string, currentToken: string, rotationId: string) {
    const nextToken = randomBytes(32).toString("base64url");
    const request = refreshSchema.parse({
      deviceId,
      currentToken,
      rotationId,
      nextTokenHash: hash(nextToken),
    });
    return this.rotate(request, "web", nextToken);
  }
  private async rotate(
    request: z.infer<typeof refreshSchema>,
    transport: Device["transport"],
    nextToken?: string,
  ): Promise<DeviceAccess & { refreshToken?: string }> {
    const previousHash = hash(request.currentToken);
    for (;;) {
      const device = await this.active(request.deviceId);
      if (device.transport !== transport)
        throw new AppError("Wrong session transport", 401, "SESSION_REFRESH_INVALID");
      const receipt = device.receipts.find(
        (r) =>
          r.previousHash === previousHash &&
          (transport === "web" || r.rotationId === request.rotationId),
      );
      if (receipt) {
        if (
          (transport === "native" &&
            (receipt.nextHash !== request.nextTokenHash || receipt.recoverUntil <= Date.now())) ||
          receipt.nextHash !== device.refreshHash
        )
          throw new AppError(
            "Session rotation changed; recover the saved successor",
            409,
            "SESSION_ROTATION_CONFLICT",
          );
        return {
          ...this.access(device),
          ...(transport === "web" && receipt.successor
            ? { refreshToken: decryptSecret(receipt.successor, this.encryptionKey) }
            : {}),
        };
      }
      if (device.refreshHash !== previousHash)
        throw new AppError("Refresh credential is invalid", 401, "SESSION_REFRESH_INVALID");
      if (
        transport === "native" &&
        device.receipts.some((r) => r.rotationId === request.rotationId)
      )
        throw new AppError(
          "Rotation identifier was already used",
          409,
          "SESSION_ROTATION_CONFLICT",
        );
      const now = Date.now();
      const rotated = await this.db.compareAndSwap<Device>(
        "system",
        "device-sessions",
        device.id,
        { revision: device.revision, refreshHash: previousHash, revokedAt: null },
        {
          revision: device.revision + 1,
          refreshHash: request.nextTokenHash,
          lastUsedAt: now,
          receipts: [
            ...device.receipts.filter((r) => r.recoverUntil > now).slice(-3),
            {
              rotationId: request.rotationId,
              previousHash,
              nextHash: request.nextTokenHash,
              recoverUntil: now + RECOVERY_MS,
              ...(nextToken ? { successor: encryptSecret(nextToken, this.encryptionKey) } : {}),
            },
          ],
        },
      );
      if (rotated)
        return { ...this.access(rotated), ...(nextToken ? { refreshToken: nextToken } : {}) };
    }
  }
  async list(owner: string) {
    return (await this.db.list<Device>("system", "device-sessions"))
      .filter((d) => d.owner === owner)
      .map(({ id, deviceLabel, transport, createdAt, lastUsedAt, revokedAt }) => ({
        id,
        deviceLabel,
        transport,
        createdAt,
        lastUsedAt,
        revokedAt,
      }));
  }
  async revoke(owner: string, deviceId: string) {
    for (;;) {
      const device = await this.db.get<Device>("system", "device-sessions", deviceId);
      if (!device || device.owner !== owner) throw new AppError("Device not found", 404);
      if (device.revokedAt !== null) return;
      if (
        await this.db.compareAndSwap(
          "system",
          "device-sessions",
          device.id,
          { revision: device.revision, revokedAt: null },
          { revision: device.revision + 1, revokedAt: Date.now(), receipts: [] },
        )
      )
        return;
    }
  }
}
