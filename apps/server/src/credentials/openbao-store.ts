import { createHash } from "node:crypto";
import { AppError } from "../errors.ts";
import type { SecretStore } from "./contracts.ts";

type OpenBaoResponse = {
  data?: {
    data?: Record<string, unknown>;
    metadata?: { version?: number };
    version?: number;
    current_version?: number;
  };
};

export class OpenBaoSecretStore implements SecretStore {
  private readonly address: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly options: {
      address: string;
      token: string;
      mount: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    let url: URL;
    try {
      url = new URL(options.address);
    } catch {
      throw new Error("CREDENTIALS_OPENBAO_ADDR must be an HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("CREDENTIALS_OPENBAO_ADDR must be an HTTP(S) origin");
    if (!options.token.trim()) throw new Error("CREDENTIALS_OPENBAO_TOKEN is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(options.mount))
      throw new Error("CREDENTIALS_OPENBAO_MOUNT must be one mount name");
    this.address = url.origin;
    this.fetcher = options.fetch ?? fetch;
  }

  private path(owner: string, id: string) {
    if (!owner || !/^[0-9a-f-]{36}$/i.test(id))
      throw new AppError("Credential reference is invalid", 422);
    const ownerKey = createHash("sha256").update(owner).digest("hex");
    return `openmuse/${ownerKey}/${id}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<OpenBaoResponse | null> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.address}/v1/${this.options.mount}/${path}`, {
        method,
        headers: {
          "X-Vault-Token": this.options.token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000),
      });
    } catch {
      throw new AppError("The credential vault is unavailable", 503, "VAULT_UNAVAILABLE");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const status = response.status === 400 || response.status === 409 ? 409 : 503;
      throw new AppError(
        status === 409
          ? "The credential vault rejected this update"
          : "The credential vault is unavailable",
        status,
        status === 409 ? "VAULT_CONFLICT" : "VAULT_UNAVAILABLE",
      );
    }
    try {
      return (await response.json()) as OpenBaoResponse;
    } catch {
      throw new AppError(
        "The credential vault returned an invalid response",
        503,
        "VAULT_UNAVAILABLE",
      );
    }
  }

  async write(owner: string, id: string, data: Record<string, string>, expectedVersion: number) {
    const result = await this.request("POST", `data/${this.path(owner, id)}`, {
      options: { cas: expectedVersion },
      data,
    });
    const version = result?.data?.version;
    if (!Number.isSafeInteger(version) || Number(version) < 1)
      throw new AppError("The credential vault did not confirm the save", 503, "VAULT_UNAVAILABLE");
    return Number(version);
  }

  async read(owner: string, id: string) {
    const result = await this.request("GET", `data/${this.path(owner, id)}`);
    if (!result) return null;
    const data = result.data?.data;
    const version = result.data?.metadata?.version;
    if (!data || !Number.isSafeInteger(version) || Number(version) < 1)
      throw new AppError(
        "The credential vault returned an invalid secret",
        503,
        "VAULT_UNAVAILABLE",
      );
    if (Object.values(data).some((value) => typeof value !== "string"))
      throw new AppError(
        "The credential vault returned an invalid secret",
        503,
        "VAULT_UNAVAILABLE",
      );
    return { version: Number(version), data: data as Record<string, string> };
  }

  async delete(owner: string, id: string, expectedVersion?: number) {
    if (expectedVersion !== undefined) {
      const current = await this.read(owner, id);
      if (!current || current.version !== expectedVersion)
        throw new AppError("The credential changed before revocation", 409, "VAULT_CONFLICT");
    }
    // KV v2 metadata deletion removes every version and the key metadata. A
    // per-version destroy would leave older password versions recoverable.
    await this.request("DELETE", `metadata/${this.path(owner, id)}`);
  }
}
