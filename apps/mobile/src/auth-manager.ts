import { z } from "zod";
import { ApiError } from "./api-errors";

export function normalizeServerOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Workspace API URL must be an HTTP(S) origin without credentials or subpath");
  return url.origin;
}

const sessionSchema = z.object({
  deviceId: z.string().min(1),
  owner: z.string().min(1),
  token: z.string().min(1),
  accessExpiresAt: z.number().finite(),
  mode: z.enum(["sample", "live"]),
});
const credentialSchema = sessionSchema.extend({
  version: z.literal(1),
  refreshToken: z.string().min(1),
  serverOrigin: z.string().optional(),
  pending: z.object({ rotationId: z.string().min(8), nextToken: z.string().min(1) }).optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export type Credential = z.infer<typeof credentialSchema>;
type PendingCredential = Credential & { pending: NonNullable<Credential["pending"]> };
export interface CredentialStorage {
  read(): Promise<Credential | null>;
  write(value: Credential): Promise<void>;
  remove(): Promise<void>;
}
export interface RefreshRequest {
  deviceId: string;
  rotationId: string;
  currentToken: string;
  nextTokenHash: string;
}
export interface SessionTransport {
  pair(accessKey?: string, deviceLabel?: string): Promise<Session & { refreshToken?: string }>;
  refresh(input?: RefreshRequest): Promise<Session>;
}
export interface AuthSnapshot {
  status: "loading" | "paired" | "missing" | "unavailable" | "revoked";
  token: string;
  accessExpiresAt: number;
  identity?: { owner: string; deviceId: string };
}
export class CredentialStorageUnavailableError extends Error {
  readonly code = "CREDENTIAL_STORAGE_UNAVAILABLE";
  constructor() {
    super("Credential storage is temporarily unavailable. Unlock your device and try again.");
    this.name = "CredentialStorageUnavailableError";
  }
}
const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

/** The single owner of REST, upload and runtime renewal. Pending rotations precede dispatch. */
export class AuthManager {
  private readonly serverOrigin: string;
  private credential: Credential | null = null;
  private loaded = false;
  private flight?: Promise<void>;
  private listeners = new Set<(snapshot: AuthSnapshot) => void>();
  snapshot: AuthSnapshot = { status: "loading", token: "", accessExpiresAt: 0 };
  constructor(
    private readonly options: {
      storage: CredentialStorage;
      transport: SessionTransport;
      crypto: { token(): string; hash(value: string): Promise<string> };
      web?: boolean;
      now?: () => number;
      serverOrigin?: string;
    },
  ) {
    this.serverOrigin = normalizeServerOrigin(options.serverOrigin ?? "http://localhost");
  }
  subscribe(listener: (snapshot: AuthSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(status: AuthSnapshot["status"], session?: Session) {
    this.snapshot = session
      ? {
          status,
          token: session.token,
          accessExpiresAt: session.accessExpiresAt,
          identity: { owner: session.owner, deviceId: session.deviceId },
        }
      : { ...this.snapshot, status };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new CredentialStorageUnavailableError();
    }
  }
  private readCredential() {
    return this.storage(async () => {
      const stored = await this.options.storage.read();
      const credential = stored ? credentialSchema.parse(stored) : null;
      return credential?.serverOrigin === this.serverOrigin ? credential : null;
    });
  }
  async restore() {
    try {
      if (this.options.web) {
        await this.recoverExpiredSession();
        return;
      }
      if (!this.loaded) {
        this.credential = await this.readCredential();
        this.loaded = true;
      }
      if (!this.credential) {
        this.emit("missing");
        return;
      }
      this.emit("paired", this.credential);
      if (
        this.credential.pending ||
        this.credential.accessExpiresAt <= (this.options.now?.() ?? Date.now()) + 30_000
      )
        await this.recoverExpiredSession();
    } catch (error) {
      if (code(error) === "SESSION_REQUIRED") {
        this.emit("missing");
        return;
      }
      if (code(error) !== "SESSION_REVOKED")
        this.emit(code(error) === "SESSION_REQUIRED" ? "missing" : "unavailable");
      throw error;
    }
  }
  async pair(accessKey?: string, deviceLabel = "OpenMuse mobile") {
    const result = await this.options.transport.pair(accessKey, deviceLabel);
    const session = sessionSchema.parse(result);
    if (!this.options.web) {
      const credential = credentialSchema.parse({
        ...session,
        version: 1,
        refreshToken: result.refreshToken,
        serverOrigin: this.serverOrigin,
      });
      await this.storage(() => this.options.storage.write(credential));
      this.credential = credential;
    }
    this.loaded = true;
    this.emit("paired", session);
  }
  async authorization(): Promise<string> {
    if (!this.loaded && !this.options.web) await this.restore();
    if (
      !this.snapshot.token ||
      this.credential?.pending ||
      this.snapshot.accessExpiresAt <= (this.options.now?.() ?? Date.now()) + 30_000
    )
      await this.recoverExpiredSession();
    if (!this.snapshot.token) throw new Error("Pair this device to open your workspace");
    return `Bearer ${this.snapshot.token}`;
  }
  async confirmRevocation() {
    this.credential = null;
    this.loaded = true;
    this.snapshot = { status: "revoked", token: "", accessExpiresAt: 0 };
    for (const listener of this.listeners) listener(this.snapshot);
    if (!this.options.web) await this.storage(() => this.options.storage.remove());
  }
  async recoverExpiredSession(failedAuthorization?: string): Promise<void> {
    if (this.flight) return this.flight;
    if (
      failedAuthorization &&
      this.snapshot.token &&
      failedAuthorization !== `Bearer ${this.snapshot.token}` &&
      !this.credential?.pending
    )
      return;
    this.flight = this.refresh()
      .catch(async (error: unknown) => {
        if (code(error) === "SESSION_REVOKED") await this.confirmRevocation();
        else this.emit(code(error) === "SESSION_REQUIRED" ? "missing" : "unavailable");
        throw error;
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  private async prepare(credential: Credential): Promise<PendingCredential> {
    if (credential.pending) return { ...credential, pending: credential.pending };
    const pending = {
      rotationId: this.options.crypto.token(),
      nextToken: this.options.crypto.token(),
    };
    const prepared = { ...credential, pending };
    await this.storage(() => this.options.storage.write(prepared));
    this.credential = prepared;
    return prepared;
  }
  private async refresh() {
    if (this.options.web) {
      const result = sessionSchema.parse(await this.options.transport.refresh());
      this.loaded = true;
      this.emit("paired", result);
      return;
    }
    if (!this.loaded) {
      this.credential = await this.readCredential();
      this.loaded = true;
    }
    if (!this.credential) {
      this.emit("missing");
      throw new ApiError("Pair this device to open your workspace", 401, "SESSION_REQUIRED");
    }
    let prepared = await this.prepare(this.credential);
    const send = (credential: PendingCredential) =>
      this.options.crypto.hash(credential.pending.nextToken).then((nextTokenHash) =>
        this.options.transport.refresh({
          deviceId: credential.deviceId,
          rotationId: credential.pending.rotationId,
          currentToken: credential.refreshToken,
          nextTokenHash,
        }),
      );
    let result: Session;
    try {
      result = await send(prepared);
    } catch (error) {
      if (code(error) !== "SESSION_ROTATION_CONFLICT") throw error;
      // After the bounded predecessor receipt expires, prove possession of the
      // successor saved before the original dispatch. Persist this attempt too.
      prepared = await this.prepare({
        ...prepared,
        refreshToken: prepared.pending.nextToken,
        pending: undefined,
      });
      result = await send(prepared);
    }
    const session = sessionSchema.parse(result);
    if (session.deviceId !== prepared.deviceId || session.owner !== prepared.owner)
      throw new Error("Workspace identity changed during refresh");
    const committed: Credential = {
      ...session,
      version: 1,
      refreshToken: prepared.pending.nextToken,
      serverOrigin: this.serverOrigin,
    };
    await this.storage(() => this.options.storage.write(committed));
    this.credential = committed;
    this.emit("paired", session);
  }
}
