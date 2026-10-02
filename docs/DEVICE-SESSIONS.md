# Device sessions and connector startup

The access key pairs one revocable device identity. Access tokens expire after 15 minutes. Pairing has no absolute or idle expiration by default (`SESSION_DEVICE_IDLE_DAYS=0`); a positive integer enables an optional idle limit measured from the last successful refresh. Revocation is checked on every authenticated request, including requests whose access token is still valid. Previously issued upstream bearer sessions continue to work until their original expiry; pairing, stored profiles, and Google credentials are not deleted during this upgrade.

`POST /api/session` accepts `accessKey`, `deviceLabel`, and `transport` (`native` or `web`). It returns `owner`, `deviceId`, `mode`, `token`, and `accessExpiresAt`. Native pairing also returns a refresh credential. `GET /api/devices` lists the owner's device labels and lifecycle timestamps without credential hashes or receipts. `POST /api/devices/:id/revoke` revokes only that device.

## Native recovery

Expo SecureStore persists a small versioned credential envelope, using first-unlock device-only accessibility and no required biometric interaction. The storage key includes a hash of the normalized API origin, and the envelope also records that origin. Changing the configured API host cannot send the previous host's refresh credential to the new host; returning to the original origin can restore its pairing. Unavailable or locked storage is distinct from a missing credential; a storage or network error never deletes the pairing. Only an explicit `SESSION_REVOKED` response clears the credential.

Before `POST /api/session/refresh`, the client saves its random successor and rotation ID. The request contains `deviceId`, `rotationId`, `currentToken`, `nextTokenHash`, and `transport: "native"`. A single database CAS changes the hash and stores the receipt together. Retrying identical arguments recovers the committed rotation. Receipts retain at most four entries and allow predecessor recovery for 24 hours; after that window, the client proves possession of its saved successor using another durably prepared rotation. This supports a crash before dispatch, after server commit, before final client save, and long offline periods without re-pairing. Invalid or conflicting rotations do not revoke the device.

## Web recovery

The browser receives only an access token in JSON. Refresh lives in the `__Secure-openmuse-refresh` cookie with HttpOnly, Secure, SameSite=Lax, and `/api/session` path. The server generates each successor and stores it in an AES-GCM encrypted receipt. Neither refresh token nor encrypted receipt is written to localStorage or exposed to JavaScript. Session requests use credentials mode `include`.

Web pairing and refresh require an exact allowed `Origin` plus `X-OpenMuse-CSRF: 1`; originless cookie refresh is rejected. Cross-site requests cannot satisfy this header without the configured CORS preflight. Keep app and API on the same HTTPS site for SameSite=Lax. Local development uses the browser's Secure-cookie exception for `localhost`; Secure is never disabled for HTTP LAN hosts. Real HTTPS/native acceptance remains a deployment check.

A lost Set-Cookie is recovered from the predecessor hash's existing receipt, including concurrent tabs with different request IDs. Recovery returns the already-generated successor only while its hash is the current device generation. The latest unresolved web receipt has no wall-clock cutoff, so a lost response followed by 30 days offline does not require pairing again. Advancing the generation makes older predecessors unusable; revocation always wins. At most four receipts are retained. A stolen predecessor cookie can recover its immediate successor while that rotation remains unresolved: rotation cannot distinguish this possession from a lost browser response. Explicit device revocation is the containment mechanism; no replay-proof guarantee is claimed. Persistent cookie expiry follows the browser's 400-day maximum, renewed on refresh; clearing browser cookies removes the credential.

Web pairing and refresh hold an API-origin-named [Web Lock](https://www.w3.org/TR/web-locks/) through fetch and response parsing. This serializes rotations across tabs of the same app origin, including delayed cookie responses, so an older Set-Cookie cannot arrive after a later rotation. Serve one canonical app origin for a paired browser: Web Locks coordinate that origin's tabs, not separate origins or unrelated clients. Browsers without Web Locks return `WEB_SESSION_COORDINATION_UNAVAILABLE` before dispatch and require a supported browser in a secure context; there is no unsafe in-process fallback.

## Clients and connectors

`AuthManager` owns one renewal flight shared by REST, native uploads, and the scoped CopilotKit fetch transport. Only the OpenMuse error code `SESSION_EXPIRED` starts HTTP recovery. Google authorization errors, plain 401s, malformed JSON, HTML gateway responses, and network errors do not log the user out. HTTP recovery repeats a request at most once after an authentication rejection before dispatch. A confirmed revocation on either attempt clears pairing.

`MuseApi` preserves the legacy string-token constructor and adds an AuthManager constructor. Its `identityKey` includes API origin, owner and device ID, remains stable during token rotation or transient failure, and never includes a token. Legacy callers receive an explicit per-instance compatibility scope. CopilotKit headers change on renewal without replacing the provider; computer/chat drafts retain their component identity.

The app opens `/api/workspace?section=essential`. The `mail`, `calendar`, `files`, `browser`, and `all` section values are supported; the model's `read_workspace` tool forwards its requested section. Essential and file reads perform no Google network calls. Gmail and Calendar failures preserve the current account's cached data, drafts and essential workspace, and report a disconnected or unavailable connector so reconnect controls remain accessible. Each Google client has a shared 10-second read budget, at most three attempts, exponential jitter and Retry-After support, with caller cancellation. Permission errors are not retried; known rate-limit 403s are. External writes with uncertain results are never automatically repeated.

Snapshots also expose typed `sources` diagnostics: status, freshness, error code when available, unknown-provenance row IDs and `requiresFreshRead`. The model receives diagnostics for each requested source alongside its rows, including an empty cache under Google 401/503. Cached/unknown rows and failed sources cannot establish current facts or absence; the tool policy and model instructions require a fresh successful authoritative read before using them for an effect. Existing account-binding and fresh Calendar target/version checks still enforce Google mutations.

Every successful live Calendar list/create/update cache write records the verified connection and cache time. Legacy rows without connection provenance remain stored unchanged and appear on cached snapshots with `cache.provenance: "unknown"` and unknown freshness. They are never assigned to the newly connected Google account; known rows belonging to another connection remain excluded. Successful Google reads return the actual current rows and fresh status, without deleting unrelated legacy rows. The mobile agenda labels unknown-account and stale cached events explicitly, and Calendar retains the relevant cached events when its direct read fails.

`PUBLIC_API_URL` and `ALLOWED_ORIGINS` accept HTTP(S) origins without userinfo, query, fragment or subpaths. The API mounts at `/`; a public subpath requires a separate proxy arrangement and is rejected in this configuration. Numeric port and idle-limit values are validated alongside the fork's existing computer and mode validators.

## Verification and dependencies

Behavioral tests cover 15-minute access, 48-hour/30-day use, per-device revocation and races, ten simultaneous expired responses, native rotation crash boundaries, on-disk database reopen, locked SecureStore, origin-bound credential storage, consumed POST Request retries, cookie attributes/CSRF, delayed cross-tab responses and long offline web recovery, connector isolation, typed gateway diagnostics, and bounded/cancelled Google retries. Run:

```sh
pnpm exec tsx --test tests/device-sessions.test.ts apps/mobile/test/auth-manager.test.ts tests/oauth.test.ts
pnpm exec tsx --test tests/workspace-freshness.test.ts
pnpm exec tsx --test tests/google.test.ts tests/config.test.ts
pnpm test
pnpm typecheck
```

These fixtures do not verify a physical phone, real Google accounts, or deployment HTTPS. The existing mobile app must be rebuilt to include the new native modules. Expo SDK 54 uses [expo-secure-store ~15.0.8](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/) and [expo-crypto ~15.0.9](https://docs.expo.dev/versions/v54.0.0/sdk/crypto/). Their Expo [MIT notice](licenses/EXPO-MIT.txt) is preserved; existing OpenMuse licensing, package IDs, scheme, demos and adapters remain unchanged.
