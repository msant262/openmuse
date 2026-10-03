# Release verification

## Current hybrid acceptance · October 3, 2026

The [deployment acceptance record](DEPLOYMENT-ACCEPTANCE.md) supersedes historical
deployment/Android limitations below where it reports an actual completed check.
Final server shutdown/recovery source `993e611` passed **867/867** Node tests (182.8 seconds)
and server TypeScript. Native twenty-second HTTP polls close promptly on shutdown;
queued delivery and authorization-race tests preserve durable state. Mobile/worker types and the native executor's **92/92** Python
tests passed at `985b51d`, including bounded cold desktop startup after thaw. The subsequent backup-only
`7c899ec` passed **49/49** script tests, including authenticated real-age encryption,
frozen-session shutdown, validated SIGTERM receipts, partial-stop recovery and
preservation of user pause after restoration failure. A real container probe also
confirmed a private 24,601-byte Raft snapshot streamed from the OpenBao tmpfs;
Docker archive/cp cannot read that mount. The final stream contract tests both
success and cleanup after a partial-copy failure.

The real VPS runs API/PGlite, Chromium and OpenBao; the native Lenovo runs the
registered graphical executor. Take control/capture/input/handback, native command,
Unicode file read/write, Office generation/PDF preview and four downloadable Office/PDF
exports passed. A real API/read/file-write/Store restart fixture also verifies
post-write export recovery without another Lenovo read; an unrelated unknown mutation
remains unresolved. This models a crash boundary rather than sending SIGKILL.
A real coordinated encrypted backup, peer checksum verification and isolated restore
also passed: PGlite, native SQLite journals/workspace and an actual OpenBao 2.7.1
Raft snapshot (scoped tokens, revoked bootstrap root, restart and wrong-key checks).
The daily backup timer is enabled for Europe/Berlin. Metadata-only 24-hour
collectors started October 3 at 06:25:09 UTC (VPS) and 06:25:59 UTC (Lenovo);
the complete observation remains pending.
Whisper small CPU/int8 processed a two-second silent WAV; spoken
language accuracy was not measured. The Android release was installed and exercised
on a disposable emulator. Private HTTPS now passes with a trusted certificate;
a physical phone and live model/Google/push accounts remain
unverified. The following preparation/release sections retain historical evidence.

## Hybrid deployment preparation · October 3, 2026

This is preparation evidence, separate from installation and physical acceptance.
No production services, accounts, packages, models, RDP or network policies were
changed by the deployment implementation task. The operator independently
provisioned the VPS 4 GiB swap and verified the real Lenovo Python 3.14 wheel
resolution in a temporary venv; those are separate host actions.

- Connected API/SQL focal tests pass: quotas use verified owner/device identities,
  reject spoofed XFF as a quota identity, and keep two viewers/four task requests,
  uploads, Take control and Stop separate from exhausted polling. Maintenance
  uses the real WorkAdmission SQL lock, drains an actual TaskWorker without abort,
  closes new requests/claims, retains cleanup authority, expires and preserves
  a user pause revision.
- The real API also accepts the dedicated root backup operator after paired and
  legacy sessions expire. Only the three exact maintenance/status/pause routes
  work; public pairing, owner chat/files/tasks, signed links, executor routes,
  wrong methods/queries/encoded paths, extra JSON fields and large bodies are
  rejected. Changing/removing the configured digest revokes the token while
  ordinary paired-device authentication remains unchanged. The bootstrap stores
  only a digest in server env and an exclusive private token file on each host.
- Native installer/selective backup/receiver/budget contracts pass, including
  Python-wheel failure before apt, root-owned scoped imports/Playwright cache,
  full-trust sudo properties, measured Hermes + OS reserve under decimal 7 GB,
  exact 4 GiB swap header tolerance, warm/cold headroom, dirty-stop/encryption/peer
  failures, private archive paths and owned pause CAS. Host-control fixtures use
  actual files/GNU tar but do not claim Docker/systemd installation acceptance.
- **Actual age 1.2.1 encryption/decryption passes** with a generated local recovery
  identity: ciphertext hides the fixture, authenticated isolated restore succeeds,
  and tampered ciphertext fails even with a recomputed external checksum. No
  production volume or service is started by restore.
- **Actual official OpenBao 2.7.1 proof passes**, with independently verified release
  binary digest: single-node Raft/static seal, auto-unseal after restart, real
  snapshot restore confirmed by the original saved value, and incorrect seal key
  blocking access. The fixture uses loopback/temp state and no dev mode or live
  credential. The official gog 0.43.0 binary and separate tagged license digests
  were verified; no Google authentication was attempted.
- Server, worker and mobile TypeScript checks and the server build pass. The
  focused Node tests and 18 native desktop Python contracts pass. Biome passes
  the new modules/tests; the existing `desktopViewers!` non-null assertion in
  `app.ts` remains an unchanged warning. Broad tests on the final composed source
  must be coordinated separately with concurrency 4; no fresh full-suite claim
  is made by this preparation report.
- The collector/report tests distinguish complete 24-hour sampling from short,
  interrupted and gapped captures. The local collector is prepared but **the
  physical 24-hour soak is pending**, as are actual managed Chromium/ASR startup,
  cross-host live backup/restore, production OpenBao restart/sealed behavior,
  five light sessions, >8 GiB workload, desktop ACK/chat/provider latency and
  phone/push/Wi-Fi/restart journeys. Brand/platform exports remain a separate
  release task. Follow [the hybrid procedure](../deploy/HYBRID.md).

## Personal VPS integration · October 2, 2026

- **385 tests pass**, with zero failures or skipped tests, including the existing sample/demo contracts. Server/mobile/browser-worker TypeScript checks, server build and Biome checks of tracked/new source pass. During implementation, the broad `pnpm lint` command scanned ignored research and encountered a historical `.superpowers` JSON formatting error; four existing model-provider test warnings remain.
- The four-service deployment has an exact **6,845,104,128-byte** memory budget, one API/PGlite/in-process worker, init/restart/health contracts, loopback-only published API, persistent DB/profile/workspace/home, minimal sidecar secrets and coupled computer/gateway networking. Tests check the Compose structure and actual browser/shared-module layout under Node's native TypeScript loader.
- Shutdown checks hold native and ordinary server-tool receipts through model cancellation, seal new work, persist partial local replies, release leases and reject unconfirmed persistence. Task finalization and settled/caught SQL write failures remain known through shutdown; complete ticks and outstanding heartbeat writes are joined. Fully recorded ordinary application/provider errors permit a clean exit. Backup tests mock Docker control while exercising real archive round trips, private modes/numeric ownership, stop/OOM/kill failures, resume failures, retention, checksums, unsafe paths and restores into fresh state.
- Independent acceptance ran the **actual compiled API** against a continuous local model stream and on-disk PGlite: active-stream SIGTERM exited 0 in **0.06 seconds**, HTTP closed, the partial reply survived restart, and an immediate new turn completed with exactly two total model requests and no reader errors. The official standalone **Compose 5.5.1** validator accepted isolated configuration and the exact interpolated API environment, including optional blank values, also passed compiled `readConfig`.
- No Docker daemon is available here. These checks establish neither image builds nor kernel/cgroup/namespace isolation, initial volume permissions, live container backup/restore, VPS load, account login, HTTPS/Tailscale nor physical native push. The [deployment guide](../DEPLOY.md) lists exact startup and real-host acceptance steps. Docker and native demonstrations below are historical evidence from their stated release, not verification of this new stack.

## Earlier release evidence

September 16, 2026 · Capybara and distinct mobile/web demos, following the agent browser release · local fictional workspace. This records exercised behavior and its limits; it does not establish that every planned capability is complete.

## Automated checks

- **154 tests pass**, with no failures or skipped tests, across the API, task engine, integrations, computer lifecycle, Docker runner, conversation queue, browser address handling, domain, and native date handling. Five new checks cover email search/read ownership, disconnected mail, evidence-based demo replies, and exhibit extraction without navigation noise.
- Biome formatting/lint, server/mobile/browser-worker TypeScript checks, and the server build pass.
- Expo exports web, iOS Hermes, and Android Hermes bundles. These exports do not produce signed native binaries.
- The **real Chromium lifecycle test passes**: public page navigation/read, failed profile cleanup, same-UUID reopen, text truncation, and localStorage/profile persistence after restart.
- The **real Docker computer smoke test passes** against the isolated `colima-openmuse` context: local image build, nonroot commands, read-only system files, disabled network, capped output, text editing, symlink rejection, PDF byte-preserving import/export, stop/start file persistence, and interruption of an actually running command. Its disposable container and volume are removed after the test.
- CI now includes a separate computer-container build/smoke job. Its YAML parses with unique keys and valid workflow triggers. The existing browser-container CI job was not rerun locally for this release; remote CI results remain separate from these local checks.

## Agent browser verification

- September 16: fresh native iPhone capture exercised Hacker News → CopilotKit → takeover and scrolling. A separate desktop capture exercised actual mailbox search/read → full email viewer → Monterey Bay Aquarium research → takeover. Browser results came from real Chromium; email came from the isolated fictional mailbox. The web capture reported no page errors. Live model and Google-account acceptance remain outside this recording.
- September 16: the new capybara bundles on web, iOS and Android. Both final recordings and covers were visually inspected, and MP4/GIF dimensions, durations, and decoding were checked. All 154 tests, lint, typecheck, server build, and three platform exports pass locally. Worker/container implementation is unchanged; the earlier smoke-test evidence below is historical.

- Actual CopilotKit BuiltInAgent streams `browse_web` calls and results. Tests cover successive reads, honest worker failures, cancellation, owner isolation, concurrent navigation/read pairing, and persistent per-thread profile reuse.
- Native iPhone acceptance: ask for Hacker News highlights → fully terminate and relaunch the app → summarize CopilotKit → open **Take control**. Both page reads returned the same session ID, and the console displayed the live CopilotKit page. Local chat now has a stable routed CopilotKit thread identity across app launches.
- Inline cards show reading progress, the source title, a real browser preview, and takeover. A historical source does not display a different page after that browser moves on. Pending calls show paused status after a stopped run; takeover waits until the active chat run finishes.
- The [AI Mock runner](DEMO.md#run-the-agent-browser-demo) drives the actual model/tool loop against a separate real Chromium worker. Its three tests verify prompt routing, current-turn tool results, failures, and model-protocol execution. Recorded responses are scripted page excerpts, not live-model reasoning.
- Full formatting/lint, server/mobile/worker types, all 149 tests, server build, all three Expo exports, frozen lockfile validation, and the real Chromium lifecycle test passed for this change. The Docker implementation and runtime dependencies did not change; its prior smoke evidence remains below.

## Feature acceptance matrix

| Area | Evidence | Boundary |
| --- | --- | --- |
| CopilotKit chat | Real runtime streams AG-UI events; actual BuiltInAgent/TanStack AI run against a local model-protocol fixture, call server tools including a computer command, persist its receipt, save a plan, prepare an event, wait for approval, and resume from the receipt. | Live model quality and provider-account acceptance are pending. |
| Durable work | Real PGlite restart, two-worker lease races, expired-lease recovery, cancellation, pause/resume, missing inputs, approval fairness, and saved outcomes are tested. | The server host must remain running. PGlite cannot be shared across processes; use PostgreSQL for a separate worker. |
| Document job | Background import → field input → new PDF → action review → sample sent receipt is tested without a client. The iPhone viewer displays the saved names and checkbox on a real two-page PDF. | Supported AcroForms only. OCR/scanned forms and some field types are not supported. |
| Reviews | Ownership/hash/version binding, expiry, account changes, disconnects, concurrent decisions, uncertain writes, and cancellation are tested. | An already dispatched provider request may finish after cancellation. |
| Gmail / Calendar | Real adapter code with controlled HTTP fixtures covers OAuth state races, scopes, complete MIME/threads/attachments, CRLF sends, calendar discovery, event CRUD, ETags, time zones, DST gaps, and unsupported recurrence. | No live Google credentials were supplied. A real-account acceptance run remains required. |
| Browser | Actual Chromium screenshots and console displayed on iPhone and web. Hacker News and CopilotKit navigation were exercised through both clients and updated the worker's page. Ownership, authorization, URL/DNS/egress checks, failed downloads, and recovery have automated coverage. | A separate Chromium worker; no automatic booking/payment or hostile-tenant isolation. |
| Linux computer | Native Terminal created `today.md`; Files read/save and PDF import/export/view were exercised. The real Docker smoke verifies isolation and persistence. Regressions cover owner binding, literal host argv, output caps, timeout/stop failures, stale-executor restart fencing, retryable Stop, and interrupted recovery without replay. | One owner, noninteractive commands, no terminal network, graphical desktop, or full VM. Persistent volumes have no portable per-volume disk quota. |
| Ideas | Evidence/accept/edit/dismiss and acceptance races are tested. Regression coverage retires completed document suggestions and excludes sent replies while preserving unfinished incoming requests. | Rules-based suggestions; broader model-derived personalization remains future work. |
| Goals / Tracking | Milestone validation, goal/task pausing, sample observation baseline/change/deduplication, failure backoff, and automatic pause are tested. A real public-page watch previously saved actual text. | Device push and adaptive long-term planning are not implemented. |
| Finance | CSV parsing, exact cents, invalid/ambiguous input, and persisted artifacts are tested. A new task delegated from the iPhone menu produced income 4,200.00, spending 110.99, and remaining 4,089.01 from four sample transactions. | Imported CSV only; no bank connection. |
| Identity / memory | Edit, persist, and forget paths are tested through the authenticated API. | Single owner per deployment. |
| Rich Threads | Local runner tests reopen a real on-disk PGlite database and replay rich tool results, custom events and state through AG-UI. Real runtime routes verify zero network calls, main-thread creation, owner scoping, pagination, rename/archive/restore, competing runner claims, stop and expired-lease recovery. Existing keyed-mode tests and SDK queue-error tests remain. | Postgres lease SQL is exercised through PGlite; a separate live Postgres/multiple-host acceptance test and physical-device smoke test remain. Optional Intelligence boundary is mocked; its live WebSocket replay needs a project key. |
| OpenBot | Disabled adapter has protocol and identity contract tests against a pinned public revision, including computer gateway, takeover, refusal, and uncertain outcomes. | No live identity, routine, or computer backend bridge yet. |
| Native / web UI | iPhone simulator and web preview have been exercised. Native acceptance covers actual task/results navigation, PDF pages, browser navigation, Linux Terminal and Files, finance, and goals. | Android is bundle-validated, not installed on a device/emulator. |

## Release fixes and interface polish

- The composer remains available during replies. Send changes to Stop in the same input pill, with a visible follow-up queue, retained drafts while navigating, and a control for returning to the latest message.
- The composer browser acceptance check verified the shared button position, enabled Stop with an empty draft, draft retention after stopping, immediate sending afterward with no held follow-ups, and reset to Send on natural completion. It reported no runtime errors. The iPhone simulator recording also shows the inline stop control. All seven [CI jobs for this change](https://github.com/CopilotKit/openmuse/actions/runs/35021854345) passed.
- The refreshed [mobile and web demos](DEMO.md) run 38 and 42 seconds at 1920 × 1080, with matching animated previews. Both feature the capybara; the web story combines email and aquarium research. The removed model/browser footer captions and web headline remain absent.
- The avatar opens activity and approvals. Name, tone, avatar color, and background-update preferences persist. Sheets adapt to narrow screens; icon targets, text contrast, and message spacing are refined.
- Computer separates Browser, Terminal, and Files. Command receipts remain visible, **New command** reopens the input, and an explicit straight-quote correction handles pasted smart quotes. Command and file drafts persist across sheet navigation; late file responses cannot overwrite a newer editor.
- Browser takeover uses a light console with live connection state, keyboard controls, retained text after errors, and visibility-aware previews. Regression tests verify edited-address reopen, signed-link renewal after 16 minutes, and owner boundaries. The console was inspected on web and the iPhone simulator.

- Ideas no longer proposes processing a sent reply or repeating a completed matching document task. The reproduction failed before the fix; both regression checks now pass.
- Guided chat delegation now emits actual AG-UI tool-call results linked to persisted task IDs. The runtime regression test verifies the task reference and original source email.
- Refined the composer focus state, spacing, send/attachment targets, and removable attachment chips. Older results expand on demand. Repeated “sample” labels were removed from product copy; Apps retains explicit local-data status and reviews explain local actions.
- The menu now retains **Delegate task** after chat has history. Creating a new finance task from this entry was exercised on iPhone and produced its saved artifact.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm --dir apps/worker typecheck
pnpm test
pnpm build:server
pnpm --dir apps/mobile exec expo export --platform all --output-dir dist/release
pnpm --dir apps/worker exec playwright install chromium
pnpm test:browser
# Requires a responsive Docker daemon; use DOCKER_CONTEXT if needed:
docker build -t openmuse-computer:local apps/computer
pnpm test:computer
# Separate browser-container acceptance (not run locally for this release):
pnpm --dir apps/worker test:docker
```

The [demo guide](DEMO.md) describes the native walkthrough. The CI workflow defines these validation categories for a fresh Linux environment. See [GitHub Actions](https://github.com/CopilotKit/OpenMuse/actions/workflows/ci.yml) for remote CI results. No real mail was sent, purchase made, or private Google account connected during release verification.

## Still outside this release

Health, bank, social, and WhatsApp connectors; a managed generated-tool registry; voice/media generation; automatic purchases/reservations; mobile push; multi-tenant identity; and full desktop VM isolation. See the [roadmap](../ROADMAP.md).
