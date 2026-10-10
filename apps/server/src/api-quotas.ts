/** MIT. One API process: bounded owner/device buckets, with separate control
 * capacity. Identity comes only from verified sessions, never forwarding headers. */
export type ApiQuotaClass = "observe" | "control" | "input" | "chat" | "upload" | "work";
type Limit = { owner: number; device: number };
const defaults: Record<ApiQuotaClass, Limit> = {
  observe: { owner: 1200, device: 600 },
  control: { owner: 120, device: 60 },
  input: { owner: 1800, device: 1200 },
  chat: { owner: 60, device: 30 },
  upload: { owner: 20, device: 10 },
  work: { owner: 120, device: 60 },
};
type Bucket = { count: number; resetAt: number };
type Options = {
  now?: () => number;
  maxOwners?: number;
  maxDevices?: number;
  limits?: Partial<Record<ApiQuotaClass, Limit>>;
};

/** This POST only transports bounded IDs to an owner-scoped read handler. */
export function apiReadRequest(method: string, path: string): boolean {
  return (
    ["GET", "HEAD", "OPTIONS"].includes(method) ||
    (method === "POST" && /^\/api\/conversations\/[^/]+\/social\/window$/.test(path))
  );
}

export function apiQuotaClass(method: string, path: string): ApiQuotaClass {
  if (path === "/api/deployment/maintenance") return "control";
  if (
    apiReadRequest(method, path) ||
    /\/viewers\/[^/]+\/observe$/.test(path) ||
    (method === "POST" && /^\/api\/copilotkit\/agent\/[^/]+\/connect$/.test(path))
  )
    return "observe";
  if (/\/(?:viewers\/[^/]+\/input|browsers\/[^/]+\/console)$/.test(path)) return "input";
  if (/\/(?:runtime-pause|stop|take-control|hand-back|control|revoke|close|input)$/.test(path))
    return "control";
  if (/^\/api\/copilotkit(?:\/|$)|^\/api\/conversations\/[^/]+\/messages$/.test(path))
    return "chat";
  if (path === "/api/files" || path === "/api/mail/import-attachment") return "upload";
  return "work";
}

export class ApiQuotas {
  private readonly owners = new Map<ApiQuotaClass, Map<string, Bucket>>();
  private readonly devices = new Map<ApiQuotaClass, Map<string, Bucket>>();
  private readonly limits: Record<ApiQuotaClass, Limit>;
  private readonly options: Options;
  constructor(options: Options = {}) {
    this.options = options;
    this.limits = { ...defaults, ...options.limits };
    for (const value of [
      options.maxOwners ?? 128,
      options.maxDevices ?? 512,
      ...Object.values(this.limits).flatMap((limit) => [limit.owner, limit.device]),
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
        throw new Error("Invalid API quota bound");
  }
  get size() {
    return [...this.owners.values(), ...this.devices.values()].reduce(
      (sum, map) => sum + map.size,
      0,
    );
  }
  private bucket(
    pool: Map<ApiQuotaClass, Map<string, Bucket>>,
    route: ApiQuotaClass,
    key: string,
    maximum: number,
    now: number,
  ) {
    let map = pool.get(route);
    if (!map) {
      map = new Map();
      pool.set(route, map);
    }
    let value = map.get(key);
    map.delete(key);
    if (!value || value.resetAt <= now) value = { count: 0, resetAt: now + 60_000 };
    map.set(key, value);
    if (map.size > maximum) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    return value;
  }
  /** Returns zero if admitted, otherwise the retry delay in whole seconds. */
  take(owner: string, deviceId: string, route: ApiQuotaClass) {
    const now = this.options.now?.() ?? Date.now();
    const own = this.bucket(this.owners, route, owner, this.options.maxOwners ?? 128, now);
    const dev = this.bucket(
      this.devices,
      route,
      JSON.stringify([owner, deviceId]),
      this.options.maxDevices ?? 512,
      now,
    );
    const limit = this.limits[route];
    if (own.count >= limit.owner || dev.count >= limit.device)
      return Math.max(1, Math.ceil((Math.max(own.resetAt, dev.resetAt) - now) / 1000));
    own.count++;
    dev.count++;
    return 0;
  }
}
