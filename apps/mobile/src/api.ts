import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { parsePayload, parseResponse } from "./api-errors";
import { AuthManager, type Session, type SessionTransport } from "./auth-manager";
import { authenticatedFetch, authenticatedUpload } from "./auth-transport";
import { ComputerRequests, durableComputerPath } from "./computer-requests";
import { createCredentialStorage } from "./credential-storage";
import { messageStorage } from "./message-storage";
import { withWebSessionLock } from "./web-session-coordinator";
import { resolveApiOrigin } from "./api-origin";

export { ApiError } from "./api-errors";

export const API_URL = resolveApiOrigin({
  platform: Platform.OS,
  configured: process.env.EXPO_PUBLIC_API_URL,
  sameOrigin: process.env.EXPO_PUBLIC_WEB_SAME_ORIGIN === "true",
  pageOrigin: typeof window === "undefined" ? undefined : window.location?.origin,
});

export class MuseApi {
  private readonly computerRequests = new ComputerRequests(
    messageStorage,
    (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
    () => Crypto.randomUUID(),
  );
  private identityScope?: string;
  private readonly fallbackScope = `${API_URL}\nlegacy-session:${Crypto.randomUUID()}`;
  constructor(private readonly credential: string | AuthManager) {}
  /** Origin + pairing identity, never an access token. Retain it during transient failures. */
  get identityKey(): string {
    const identity =
      typeof this.credential === "string" ? undefined : this.credential.snapshot.identity;
    if (identity) this.identityScope = `${API_URL}\n${identity.owner}\n${identity.deviceId}`;
    return this.identityScope ?? this.fallbackScope;
  }
  get token() {
    return typeof this.credential === "string" ? this.credential : this.credential.snapshot.token;
  }
  authorization() {
    return typeof this.credential === "string"
      ? Promise.resolve(`Bearer ${this.credential}`)
      : this.credential.authorization();
  }
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    if (durableComputerPath(path) && (!method || ["POST", "GET"].includes(method)))
      return this.computerRequests.request(
        this.identityKey,
        path,
        body,
        (nextPath, nextBody, requestId) =>
          this.send(nextPath, nextBody, nextPath === path ? method : "GET", requestId),
      );
    return this.send(path, body, method);
  }
  private async send<T>(
    path: string,
    body?: unknown,
    method?: string,
    requestId?: string,
  ): Promise<T> {
    const init = {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(requestId ? { "Idempotency-Key": requestId } : {}),
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    };
    const response =
      typeof this.credential === "string"
        ? await fetch(`${API_URL}${path}`, init)
        : await authenticatedFetch(this.credential, `${API_URL}${path}`, init);
    return parseResponse<T>(response);
  }
  async upload<T>(operation: (authorization: string) => Promise<{ status: number; body: string }>) {
    if (typeof this.credential !== "string")
      return authenticatedUpload<T>(this.credential, operation);
    const response = await operation(await this.authorization());
    return parsePayload<T>(response.body, response.status);
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
  deviceLabel = "OkamiBot mobile",
): Promise<Session & { refreshToken?: string }> {
  const operation = async () => {
    const response = await fetch(`${API_URL}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenMuse-CSRF": "1" },
      credentials: "include",
      body: JSON.stringify({
        accessKey,
        deviceLabel,
        transport: Platform.OS === "web" ? "web" : "native",
      }),
    });
    return parseResponse<Session & { refreshToken?: string }>(response);
  };
  return Platform.OS === "web" ? withWebSessionLock(API_URL, operation) : operation();
}

const sessionTransport: SessionTransport = {
  pair: createSession,
  refresh: async (input) => {
    const operation = async () =>
      parseResponse<Session>(
        await fetch(`${API_URL}/api/session/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-OpenMuse-CSRF": "1" },
          body: JSON.stringify(
            input
              ? { ...input, transport: "native" }
              : { transport: "web", rotationId: Crypto.randomUUID() },
          ),
        }),
      );
    return Platform.OS === "web" ? withWebSessionLock(API_URL, operation) : operation();
  },
};
export const authManager = new AuthManager({
  storage: createCredentialStorage(API_URL),
  serverOrigin: API_URL,
  transport: sessionTransport,
  web: Platform.OS === "web",
  crypto: {
    token: () =>
      Array.from(Crypto.getRandomBytes(32), (value) => value.toString(16).padStart(2, "0")).join(
        "",
      ),
    hash: (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
  },
});
