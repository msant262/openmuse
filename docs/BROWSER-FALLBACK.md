# Browser executor fallback

The opt-in hybrid deployment keeps coordination, the only PGlite writer, published
files, and a headless backup browser on the VPS. Lenovo remains the primary native
browser/desktop executor. The existing worker adapter, sample app, MIT notices,
and Docker computer deployment remain available.

`BROWSER_FALLBACK_ENABLED=true` enables persisted browser task bindings. Each
binding includes the executor, epoch, profile, session generation, route fence,
and broker-proven authentication state. `browser_research` performs public
navigation and observation. It can continue with a fresh observation on the VPS
when Lenovo is unavailable before or during reading. A moved task retains its
destination binding when Lenovo reconnects; old session/snapshot references cannot
authorize an action on the new profile. Public research accepts no site actions.

`browser_navigate` and `browser_act` remain personal-browser operations. Unknown
operations, input, credential submission, downloads/imports and reviewed actions
are conservatively mutable. They never migrate or repeat automatically after a
lost response. Existing operation receipts and uncertain states remain available
for reconciliation. Shell, desktop and long-running computer jobs do not migrate.
The API rechecks the live profile lease and current task revision, run authority
and pause state immediately before sending to the VPS, after vault or queue waits.
A lost response, invalid/truncated success receipt or explicit uncertain login
receipt holds the profile and work admission for inspection; it cannot trigger a
second submission. Read-only inspection can use that held profile.
The router uses existing work admission and resource leases; it creates no
additional background slots. The global limit remains four across both hosts.

VPS profiles persist independently by owner and saved account identity. Source
cookies/profile files are never copied while in use. A saved credential is not
proof of login: authenticated destination work requires the credential broker's
exact executor/profile/session/generation identity. Missing login or a wrong
account waits for an authorized login or secure challenge. Secrets are never
returned to browser tool results. Required executor-local artifacts must have
their exact version published before a different host can use them.

The authenticated VPS `/executor` handshake negotiates protocol and separate
capability versions, and reports a worker instance ID. `BROWSER_EXECUTOR_ID`
defaults to `openmuse-server` in both API and worker. In hybrid mode,
`BROWSER_REQUIRE_BINDING=true` rejects unbound worker requests. Signed authority
binds exact arguments, profile, worker lifecycle, task revision and physical lease
fence. The outer worker profile queue rechecks them before browser dispatch;
mutable receipts are persisted before dispatch and replay does not repeat input.
The existing Chromium queue, public-network/SSRF guard, downloads and profile
close cleanup remain in the BrowserManager.

Use the root Compose file with `deploy/compose.hybrid.yml`; the overlay requires
Compose support for `!override`. Set `NATIVE_EXECUTOR_ID` to the registered Lenovo
account's executor and place its protected manifest at
`deployment-secrets/native-executors.json`. The manifest's fixed host, UID, owner
and full-trust/restricted setting remain operator controlled. The primary Lenovo
full-trust sudo configuration does not provide containment guarantees.

The overlay starts the API, OpenBao vault, and 2 GiB browser; the original Docker computer and
gateway have the `legacy-computer` profile. Their absent credentials no longer
prevent interpolation of an unused profile. The legacy RPC API and gateway still
validate the token and all host public IPs at runtime and fail closed if missing.
VPS profiles stay on `browser-data`; Lenovo profiles stay in the native account's
private directory. Back up each host's profiles with its writer quiesced. This
change does not provision accounts, copy live profiles, or establish physical
backup/restore evidence. The API, browser and vault limits total 3584 MiB. The
legacy VPS computer uses 2944 MiB so even the root stack with its vault remains
at 6,979,321,856 bytes, below the original decimal 7 GB budget. Additional services
must fit that aggregate limit.

Automated protocol fixtures establish routing and rejection behavior. They do not
establish physical Wi-Fi failover, actual site accounts/CAPTCHA, full-trust host
containment, Chromium performance in 2 GiB, or deployed Compose behavior. Hardware,
real account and backup acceptance remain separate.
