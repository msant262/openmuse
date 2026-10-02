# Personal self-hosted OpenMuse

Goal: one personal agent, used from the existing mobile app, on a 2 vCPU / 8 GB VPS.

## Architecture read before implementation

`apps/mobile` is an Expo React Native/web client. CopilotKit headless hooks consume AG-UI streams and rich tool results; authenticated REST endpoints provide tasks, files, Google connections and browser consoles. `apps/server` is a Hono API. Its own `ConversationAgent` and TanStack model loop execute tools, while `engine/service.ts` and `engine/worker.ts` run durable tasks with SQL leases, checkpoints and receipts. CopilotKit Intelligence currently supplies thread persistence/replay and management, not the agent loop.

`db.ts` abstracts PostgreSQL or embedded PGlite through owner-scoped JSONB records, normally under `.openmuse/postgres`. Documents and signing material live alongside it. PGlite requires one process; the server normally hosts the task worker. `ActionService` prepares and claims Google writes with account/version checks and idempotency. Google tokens are encrypted.

`apps/worker` is a separate token-protected Playwright/Chromium HTTP service. Profiles, cookies and downloads persist per session. Its queue serializes session operations; a validating proxy pins public destination IPs to prevent SSRF/rebinding. The mobile Take control console already sends click/text/key/scroll input to this browser. `apps/computer` supplies a nonroot Docker image and bounded filesystem helper; the server currently manages offline containers with a persistent workspace. `packages/backends` contains a disabled, contract-tested OpenBot adapter, independent of the native agent.

Prefer additive adapters, existing PGlite/Postgres storage, and the current mobile protocol. A custom durable runner is preferable to a separate SQLite database if the runtime interface permits it. Upgrade matching runtime/mobile versions only if necessary. Keep optional keyed Intelligence behavior.

## Global constraints

- Keep MIT notices and upstream directory structure; preserve demo/sample mode.
- One commit per milestone, including its documentation and passing `pnpm test` evidence.
- No required vendor cloud or per-token API; optional providers/connectors only.
- No secrets in source, logs, browser/computer environment or generated artifacts.
- Preserve browser SSRF guards, session ordering, human takeover and saved logins.
- Computer: nonroot, no host networking/socket/secrets, block private/metadata egress; open profile 3 GB, timeout at most 30 minutes, persistent workspace/home.
- Default approvals only for payments, purchases and money transfers; append-only external-action audit.
- Compose total memory at most 7 GB; private access or HTTPS plus access key of at least 24 characters.

## Review focus

Test durable replay after restart, ownership and simultaneous runs; fallback without repeating tools; stale browser references and takeover; arbitrary file traversal and private-network egress; routine claims/restarts and connector allowlists. Live account and Docker checks must be reported separately from mocked contract tests.

### Task 1: Local durable threads

- [x] Inspect runtime runner/thread interfaces, implement a Store-backed runner and thread API compatible with mobile hooks; persist events, history, state, thread metadata and main-thread creation.
- [x] Make CPK key optional, preserve keyed mode, update demo, deployment/docs and relevant tests; prove no Intelligence network calls in local mode and replay rich results after restart.
- [x] Run `pnpm test`, server/mobile typechecks and build; commit milestone 1.

### Task 2: Subscription and compatible models

- [x] Add provider adapters for OpenAI-compatible Chat Completions/Responses, MiMo/local, official SIWC credential login/copy/hourly refresh, and researched Hermes Grok device flow (or explicit unsupported stub if clean integration is unavailable).
- [x] Support `MODEL=provider/id` and ordered fallback, safe pre-dispatch fallback, `store:false`, tool mapping, usage-limit messages and no SIWC audio input; document official protocol sources.
- [x] Contract-test provider/auth/fallback behavior, run `pnpm test` and typechecks; commit milestone 2.

### Task 3: Browser operation and takeover

- [x] Add numbered snapshots, guarded click/fill/select/press/scroll, navigation and screenshot endpoints/tools to the existing worker/service, conversation and task loop.
- [x] Reject stale references, serialize actions and persist takeover state; mobile browser cards/console let the person watch, take control, and hand back without losing profiles.
- [x] Test public destination guards, actions and takeover; run suite and worker/mobile typechecks; commit milestone 3.

### Task 4: Open computer, files and media

- [x] Add configurable isolated open profile, persistent home/workspace, bounded long commands/background jobs and a fail-closed egress gateway with a documented deployment contract.
- [x] Add image definitions with Office/Python/PDF/media tooling, CPU int8 faster-whisper small and `gog`; implement attachment transfer/download cards, transcription/text/SRT and capability-gated image generation.
- [x] Test command/file/media and firewall contracts; run suite/typechecks/builds, record unavailable Docker checks; commit milestone 4.

Milestone 4 validation: 327 tests pass, server/mobile typechecks and server/web builds pass,
14 Python contracts pass, and real offline EN/PT/DE/video transcription passed. No Docker
engine is available; image builds, kernel/namespace isolation and actual LibreOffice
conversion remain unverified. Final Compose/resource/egress acceptance belongs to Task 7.

### Task 5: Autonomy and audit

- [x] Add configurable approval policy defaulting to money only, autonomous Google actions, payment browser detection/review and append-only DB action log with mobile screen.
- [x] Preserve idempotency, cancellation, account binding and uncertain-write handling; audit successful and failed external actions without secrets.
- [x] Test policy/execution/audit behavior and mobile types; run suite; commit milestone 5.

### Task 6: Routines, MCP and memory

- [x] Add cron routine CRUD, natural-language agent tool, durable task-worker execution, main-thread results and push notifications.
- [x] Add remote streamable HTTP/SSE MCP client with per-server allowlists and optional Composio configuration; apply action policy/audit.
- [x] Add memory save/recall/forget/context injection and past-thread search; test leases/dedup/restarts/allowlists/memory ownership; run suite/types; commit milestone 6.

### Task 7: VPS deployment

- [x] Add Compose/server/browser/computer with init/restart/healthchecks, memory caps, persistent volumes and private/HTTPS access; avoid Docker socket in the computer and agent server.
- [x] Add daily DB/workspace backup, complete `.env.example` and `DEPLOY.md` for swap, subscriptions, MiMo/local, Google/Composio and mobile setup.
- [x] Validate Compose/config/scripts/build and full tests, record live limitations and exact run instructions; commit milestone 7.

Historical milestone 7 validation before final integration fixes: 385 tests passed,
server/mobile/browser-worker types and server build passed, and tracked/new source
passed Biome (four existing provider-test warnings).
Official standalone Compose 5.5.1 validates the exact 6,845,104,128-byte stack and its
resolved API environment. Actual compiled API active-stream SIGTERM exits 0 in 0.06s;
partial replies persist across PGlite restart and a fresh turn proceeds without replay.
Review regressions retain failed task/SQL receipts even before shutdown, join in-flight
heartbeat writes, and preserve clean exits for fully recorded application failures.
No Docker engine is available; image builds, kernel/cgroup/namespace isolation, initial
volume permissions, live container backup/restore, VPS load and real-account/native
delivery acceptance remain unverified. DEPLOY.md contains the exact operator steps.


Final integration fixes retain seven milestones: durable ordinary browser intents/tool
history and uncertain-action fences; foreground tool lifetime and cancellation drain;
serialized native consent/registration; shared configured-secret scrubbing; default-free
routine patches; complete paginated audit recovery and native delivery auditing. The
linked browser/experience/model/demo guides now describe the installed adapters and
actual configuration. New native-module fixtures use deferred permission/token/API
responses; exports are JavaScript/Hermes artifacts, not physical phone acceptance.
Raw cumulative chat storage compaction remains deferred. The SQL canonical projection
bounds duplicate API history, not physical database/disk growth; monitor disk and backups.

First final integration verification (historical ab77407): **401/401** tests pass (standalone full suite,
zero failures/cancelled/skipped; 52.03s). Server/mobile/browser-worker types and server
build pass; Biome checks 203 tracked/new source files with the four original provider-test
warnings. Web/iOS/Android JavaScript exports pass. The initial
full run was 400/401 because a mutual-exclusion test used a 150ms lease under parallel
PGlite load; its normal-lease fixture passes focused and in the final full suite.
No production thread lease behavior changed. The mobile harness's Node URL type import
was corrected afterward and its four native consent tests and mobile types passed again.

Root independently reran the final compiled HTTP/PGlite/model/MCP checks (15 local model
requests, 3 MCP calls), including paused HTTP routine edits, raw/whole Bearer scrubbing,
and safe native-send Activity entries. Actual compiled SIGTERM again exited 0 in 0.06s
with durable partial reply, fresh restart and exactly 2 inference requests. Official
Compose plus exact API environment checks again passed at 6,845,104,128 bytes total and
1 GiB browser shm. These are new final-build checks; Docker/container/VPS/account/device
limits above remain unchanged.


Scoped residual repair preserves consent after awaited push audit persistence and records
known pre-dispatch browser skips separately from completed/uncertain operations. The same
logical skipped action can run after resume; completed receipts still deduplicate and
unknown dispatches remain fenced. Latest standalone suite: **407/407**, no failures,
cancellations or skips (52.88s). Server/browser-worker types and server build pass; Biome
passes 204 tracked/new source files with the four existing provider-test warnings. Mobile
source/dependencies are unchanged, so the prior mobile types and three JS/Hermes exports
remain applicable. Fresh repaired-build root acceptance also passed: completed authenticated HTTP Disable
while the real audit-start INSERT completion is held causes zero provider sends. The
compiled HTTP/PGlite/model/MCP fixture retains its 15 local model requests/3 MCP calls,
SIGTERM exits 0 in 0.06s with durable partial/restart/fresh turn, and official static
Compose/exact API environment checks pass. No live account, device or Docker claims.
