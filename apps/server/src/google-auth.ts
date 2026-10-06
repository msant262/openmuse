import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().optional(),
});
interface Tokens {
  connectionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  account: string;
}
interface OAuthState {
  id: string;
  owner: string;
  expiresAt: number;
  verifier: string;
  scopes: string[];
  generation: string;
  add?: boolean;
  account?: string;
}
interface Credential {
  id: string;
  generation?: string;
  connectionId: string | null;
  secret: string | null;
}
export class GoogleAuth {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}
  configured() {
    return Boolean(
      this.config.googleClientId && this.config.googleClientSecret && this.config.encryptionKey,
    );
  }
  private async storedAccounts(owner: string) {
    const rows = await this.db.list<Credential>(owner, "credentials");
    return rows
      .filter((row) => row.id === "google" || /^google:[a-f0-9]{64}$/.test(row.id))
      .flatMap((row) => {
        const tokens = this.decodeTokens(row);
        return tokens ? [{ row, tokens }] : [];
      });
  }
  async tokens(owner: string, account?: string): Promise<Tokens | null> {
    const accounts = await this.storedAccounts(owner);
    if (account)
      return (
        accounts.find(
          (a) =>
            a.tokens.connectionId === account ||
            a.tokens.account.toLowerCase() === account.toLowerCase(),
        )?.tokens ?? null
      );
    const preferred = await this.db.get<{ account: string }>(owner, "settings", "google-default");
    return (
      accounts.find((a) => a.tokens.account.toLowerCase() === preferred?.account)?.tokens ??
      accounts.find((a) => a.row.id === "google")?.tokens ??
      accounts[0]?.tokens ??
      null
    );
  }
  async accounts(owner: string) {
    const preferred = await this.tokens(owner);
    return (await this.storedAccounts(owner)).map(({ tokens }) => ({
      connectionId: tokens.connectionId,
      account: tokens.account,
      capabilities: tokens.scopes,
      isDefault: tokens.connectionId === preferred?.connectionId,
    }));
  }
  async setDefault(owner: string, connectionId: string) {
    const tokens = await this.tokens(owner, connectionId);
    if (!tokens) throw new AppError("Google account is disconnected or changed", 409);
    await this.db.put(owner, "settings", {
      id: "google-default",
      account: tokens.account.toLowerCase(),
    });
  }
  private decodeTokens(stored: Credential | null): Tokens | null {
    if (!stored?.secret) return null;
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return JSON.parse(decryptSecret(stored.secret, this.config.encryptionKey));
  }
  private async save(owner: string, tokens: Tokens, state: OAuthState) {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    const stored = await this.storedAccounts(owner);
    const existing = stored.find(
      (a) => a.tokens.account.toLowerCase() === tokens.account.toLowerCase(),
    );
    const id =
      existing?.row.id ??
      (stored.length
        ? `google:${createHash("sha256").update(tokens.account.toLowerCase()).digest("hex")}`
        : "google");
    const value = {
      generation: randomUUID(),
      connectionId: tokens.connectionId,
      secret: encryptSecret(JSON.stringify(tokens), this.config.encryptionKey),
    };
    if (id === "google") {
      const saved = await this.db.compareAndSwap<Credential>(
        owner,
        "credentials",
        id,
        { generation: state.generation },
        value,
      );
      if (saved) return;
    } else {
      const previous = await this.db.get<Credential>(owner, "credentials", id);
      const receiptId = `google-signin:${state.id}`;
      const result = await this.db.durableMutation(owner, receiptId, receiptId, [
        {
          kind: "credentials",
          id: "google",
          expected: { generation: state.generation },
          mode: "merge",
          value: { generation: randomUUID() },
        },
        {
          kind: "credentials",
          id,
          ...(previous ? { expected: { ...previous } } : {}),
          mode: previous ? "merge" : "insert",
          value: { id, ...value },
        },
      ]);
      if (result.status === "applied") return;
    }
    throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
  }
  private async rotateGeneration(owner: string, disconnect = false) {
    const generation = randomUUID();
    for (;;) {
      const previous = await this.db.get<Credential>(owner, "credentials", "google");
      if (!previous) {
        const inserted = await this.db.insertIfAbsent(owner, "credentials", {
          id: "google",
          generation,
          connectionId: null,
          secret: null,
        });
        if (inserted) return { generation, previous: null };
      } else {
        const updated = await this.db.compareAndSwap<Credential>(
          owner,
          "credentials",
          "google",
          { ...previous },
          {
            generation,
            ...(disconnect ? { connectionId: null, secret: null } : {}),
          },
        );
        if (updated) return { generation, previous };
      }
    }
  }
  async connect(
    owner: string,
    write: boolean,
    options: { add?: boolean; connectionId?: string } = {},
  ) {
    if (!this.configured())
      throw new AppError(
        "Google sign-in is not enabled on this server yet. The administrator needs to finish the app setup.",
        503,
        "GOOGLE_SETUP_REQUIRED",
      );
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    const selected = options.connectionId ? await this.tokens(owner, options.connectionId) : null;
    if (options.connectionId && !selected)
      throw new AppError("Google account is disconnected or changed", 409);
    const { generation } = await this.rotateGeneration(owner);
    const existing = selected;
    const scopes = Array.from(
      new Set([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        ...(existing?.scopes ?? []),
        ...(write
          ? [
              "https://www.googleapis.com/auth/gmail.send",
              "https://www.googleapis.com/auth/calendar.events",
            ]
          : []),
      ]),
    );
    await this.db.put("system", "oauth", {
      id: state,
      owner,
      expiresAt: Date.now() + 10 * 60 * 1000,
      verifier,
      scopes,
      generation,
      add: options.add || Boolean(selected),
      account: selected?.account,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId ?? "",
      redirect_uri: this.config.googleRedirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "select_account consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }
  async cancel(stateId: string) {
    await this.db.take<OAuthState>("system", "oauth", stateId);
  }
  async callback(stateId: string, code: string) {
    const state = await this.db.take<OAuthState>("system", "oauth", stateId);
    if (!state || state.expiresAt < Date.now())
      throw new AppError("Google sign-in expired. Connect again.", 400);
    const credential = await this.db.get<Credential>(state.owner, "credentials", "google");
    if (!state.generation || credential?.generation !== state.generation)
      throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        redirect_uri: this.config.googleRedirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google could not complete sign-in. Connect again.", 502);
    const token = tokenSchema.parse(await response.json());
    const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!profile.ok)
      throw new AppError("Google did not grant Gmail read access. Connect again.", 403);
    const { emailAddress } = z.object({ emailAddress: z.email() }).parse(await profile.json());
    if (state.account && state.account.toLowerCase() !== emailAddress.toLowerCase())
      throw new AppError("Choose the same Google account to update its permissions.", 409);
    const previous = await this.tokens(state.owner, emailAddress);
    await this.save(
      state.owner,
      {
        connectionId: randomUUID(),
        accessToken: token.access_token,
        refreshToken:
          token.refresh_token ??
          (previous?.account === emailAddress ? previous.refreshToken : undefined),
        expiresAt: Date.now() + token.expires_in * 1000,
        scopes: token.scope?.split(" ") ?? state.scopes,
        account: emailAddress,
      },
      state,
    );
  }
  async accessToken(owner: string, expectedConnectionId?: string): Promise<string> {
    const tokens = await this.tokens(owner, expectedConnectionId);
    if (!tokens) throw new AppError("Google account or connection changed or is disconnected", 409);
    if (expectedConnectionId && tokens.connectionId !== expectedConnectionId)
      throw new AppError("Google account or connection changed. Prepare a new action.", 409);
    if (tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
    const refreshKey = `${owner}:${tokens.connectionId}`;
    const pending = this.refreshing.get(refreshKey);
    if (pending) return pending;
    const task = this.refresh(owner, tokens).finally(() => this.refreshing.delete(refreshKey));
    this.refreshing.set(refreshKey, task);
    return task;
  }
  private async refresh(owner: string, tokens: Tokens) {
    if (!tokens.refreshToken)
      throw new AppError(
        "Google session expired. Connect again.",
        401,
        "GOOGLE_RECONNECT_REQUIRED",
      );
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401)
        throw new AppError(
          "Google session expired. Connect again.",
          401,
          "GOOGLE_RECONNECT_REQUIRED",
        );
      throw new AppError(
        "Google is temporarily unavailable. Try reconnecting later.",
        502,
        "GOOGLE_UNAVAILABLE",
      );
    }
    const token = tokenSchema.parse(await response.json());
    const refreshed = {
      ...tokens,
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    if (!this.config.encryptionKey) throw new AppError("Token encryption is not configured", 503);
    const updated = await this.db.updateCredential(
      owner,
      tokens.connectionId,
      encryptSecret(JSON.stringify(refreshed), this.config.encryptionKey),
    );
    if (!updated)
      throw new AppError("Google account changed or was disconnected during refresh", 409);
    return token.access_token;
  }
  async disconnect(owner: string, connectionId?: string) {
    const selected = connectionId
      ? (await this.storedAccounts(owner)).find((a) => a.tokens.connectionId === connectionId)
      : undefined;
    if (connectionId && !selected)
      throw new AppError("Google account is disconnected or changed", 409);
    let tokens: Tokens | null;
    if (!selected || selected.row.id === "google") {
      const { previous } = await this.rotateGeneration(owner, true);
      tokens = this.decodeTokens(previous);
    } else {
      for (;;) {
        const root = await this.db.get<Credential>(owner, "credentials", "google");
        const current = await this.db.get<Credential>(owner, "credentials", selected.row.id);
        if (!root || !current || current.connectionId !== connectionId)
          throw new AppError("Google account is disconnected or changed", 409);
        const receiptId = `google-disconnect:${randomUUID()}`;
        const result = await this.db.durableMutation(owner, receiptId, receiptId, [
          {
            kind: "credentials",
            id: "google",
            expected: { ...root },
            mode: "merge",
            value: { generation: randomUUID() },
          },
          {
            kind: "credentials",
            id: current.id,
            expected: { ...current },
            mode: "merge",
            value: { generation: randomUUID(), connectionId: null, secret: null },
          },
        ]);
        if (result.status === "applied") {
          tokens = this.decodeTokens(current);
          break;
        }
      }
    }
    if (tokens) {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 400)
        throw new AppError(
          "Disconnected locally. Google revocation failed; remove access in your Google account settings.",
          502,
        );
    }
  }
}
