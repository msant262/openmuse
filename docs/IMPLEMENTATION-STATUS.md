# OkamiBot implementation status

Execution of the [approved twelve-milestone plan](plans/2026-10-02-lenovo-agent-implementation.md), starting at `8c8c1a4`. The earlier seven VPS milestones remain recorded separately in the historical plan.

| Milestone | Integrated status |
| --- | --- |
| 1 — Device sessions and connector resilience | Reviewed and integrated; deployment/device acceptance pending |
| 2 — Durable chat, questions and personality | Reviewed and integrated; physical device acceptance pending |
| 3 — Four work slots, resources and global pause | Reviewed and integrated; native executor acceptance pending |
| 4 — Task direction, recovery and verified completion | Reviewed and integrated; native/provider composition follows |
| 5 — Capability-aware model fallback | Reviewed and integrated; real subscription acceptance pending |
| 6 — Native Linux executor and file recovery | Reviewed and integrated; physical deployment acceptance pending |
| 7 — Native desktop and browser | Reviewed and integrated; physical deployment acceptance pending |
| 8 — Private credentials and connector OAuth | Reviewed and integrated; real account/device acceptance pending |
| 9 — Capability-aware browser fallback | Reviewed and integrated; physical partition acceptance pending |
| 10 — Bounded context and long-term memory | Reviewed and integrated; physical/provider acceptance pending |
| 11–12 | Pending integration |

## Milestone 1

Device pairing persists while short-lived access tokens renew silently. Native credentials use SecureStore; web renewal uses a Secure, HttpOnly cookie and coordinates same-origin tabs. Revocation applies per device. Google failures no longer unpair the app or prevent essential startup; cached Calendar entries retain provenance, and tools expose source availability and freshness.

The initial review identified missing Calendar cache provenance and discarded tool diagnostics. Both were corrected and approved in a scoped independent review. The final integration passed `pnpm test` (441/441) and `pnpm typecheck` on 2026-10-02. Web and Android JavaScript exports passed before the narrow cache/diagnostics correction; these exports are not native app builds.

A real Chromium probe against the local server also verified pairing, cookie renewal, same-device identity and revocation. The cookie was Secure/HttpOnly/SameSite=Lax and unavailable through `document.cookie`. This used localhost's secure-context exception, not deployed HTTPS.

Still required: native binary/device acceptance (including locked/rebooted phone), deployed HTTPS, and a real Google account. The credential-recovery tradeoffs and supported browser/origin requirements are documented in [DEVICE-SESSIONS.md](DEVICE-SESSIONS.md).

## Milestone 2

Accepted messages, IDs, receipts and conversation events are committed together.
The server drains accepted work independently of the phone connection. Native
checksummed files and web IndexedDB preserve queued sends and drafts; long or
mutable chat requests create durable tasks. Questions use typed inline cards,
while generic forms reject supported literal credential fields and money approval.

Global and conversation profiles have independent revisions. Writes from chat are
bound to accepted user text and the current run. Root corrected the remaining
source/task-scope finding after the implementer's two deliveries: automatic writes
accept complete direct preference commands and a bounded name-plus-plan shorthand;
ambiguous mixed prose stays on the ordinary work path. Reset follows the same
explicit authority rule. Unsupported wording can be clarified or edited in settings.

The final scoped independent review approved all original findings. Root's final
integration passed `pnpm test` (477/477, 112.7 seconds), server/mobile typecheck and
changed-source Biome checks on 2026-10-02. Full lint before the final narrow parser
change had zero errors and 36 existing warnings. The durable mailbox is ready for
milestone 4; this milestone does not claim steering has already been applied.

An actual Android API 34 emulator also compiled and ran the native app during
integration. A force-stop/reopen preserved its draft and paired device identity.
This used a disposable x86_64 debug APK and local sample server. It does not prove
physical-phone, release ARM64, reboot, offline or push-notification acceptance.

## Milestone 3

The scheduler admits at most four durable background work units, including child
work and physical background jobs. Each run renews and releases its own fenced
resource handles. Priority and timing affect eligible work without interrupting
jobs already running. The mobile runtime controls expose persisted global pause,
active jobs and uncertain external actions; resumption requires an explicit action.

Command/media dispatch and mutable file/start handoffs recheck pause after local
preparation. Reviewed browser actions share the profile lease with normal agent
operations. Unclassified remote failures retain ownership as an unknown outcome.
Resource admission distinguishes an explicit busy/not-dispatched rejection from
an uncertain submission; the former can retry its original command identity.

After the implementer's two deliveries, root corrected residual audit recovery,
replay ownership, file pause, browser error classification and legacy read_web
tracking defects. A live command attempt is tracked through claim, acquisition,
publication and cleanup, so the selected single API/embedded-worker deployment's
maintenance cannot retire it midway. Durable conditional claims and exact handle
cleanup survive restart; internal generation-bound acquisition prevents a new
preflight from borrowing a previous attempt's handles. This is not a distributed
preflight-liveness implementation for multiple API/worker processes.

Final root checks on 2026-10-02 passed `pnpm test` (512/512, 80.0 seconds),
server/mobile typecheck and full lint (zero errors, 36 existing warnings). Focused
ownership/pause/recovery checks passed 28/28. Computer Python contracts passed
14/14 on the unchanged Python source. Final independent scoped review approved
the two remaining same-key races, with three fresh targeted regressions passing.

Native executor confirmation and measured host memory admission belong to milestone
6. Safe resolution of an uncertain reviewed-browser hold belongs to milestones
4/7; this milestone conservatively keeps that profile occupied and exposes the
uncertainty. No physical Lenovo/VPS deployment acceptance is claimed here.

## Milestone 4

Task directions now persist in a mailbox and apply at safe points without cancelling
already dispatched work. A durable operation journal retains completed receipts,
unknown outcomes and tool history for recovery. Adapter dispatch checks current
task revision, pause, resource ownership and validity after awaited preparation.
Children share their parent budget and current validity; bounded work can continue
across turns and explicit budget extensions preserve usage already charged.

The mobile task controls show received/applied directions, timing, budgets, partial
delivery and uncertain operations. User file formats and supported explicit content
requirements remain mandatory even when a model proposes a different workflow.
Empty required headings cannot verify text or Office output. Completion is based
on owned files and receipts; arbitrary prose quality is not universally verified.

The implementer's final review passed the original nine adverse cases. Root then
closed the two residual format/content findings and added actual runtime/provider
and file regressions. Final root validation passed the complete existing test glob with explicit concurrency 4
(571/571, 108.0 seconds), server/mobile typecheck, and changed-source Biome
(56 files, zero errors, six existing warnings). Focused completion/dispatch cases
passed 28/28. These checks were performed on 2026-10-02.

Production model-router composition follows in milestone 5. Native executor
authority, desktop session generations and bounded context composition remain
required in milestones 6, 7 and 10. No physical Lenovo/VPS, real provider account
or Android acceptance is claimed by this milestone.

## Milestone 5

Model routing uses an ordered provider list, declared/preflight capabilities,
context limits and provider cooldowns. The supported single API process reserves
interactive inference capacity separately from background work. The app displays
provider limits and recoverable waiting states. Distributed quota sharing is
explicitly unsupported; this deployment uses one API process and embedded worker.

An interrupted accepted stream retains its completed tool history and a separate
partial-text buffer. The M4 journal consumes that checkpoint after restart without
repeating a completed external action. Incomplete streams cannot flush partial
tool calls even when a provider sends an incorrect content-type header.

The actual HTTP file-write → provider EOF → disk DB restart → resumed task test
passed with exactly one physical write and one logical write operation. Routing
and restart checks passed 38/38; combined M4/M5 regressions passed 52/52 after
declaring the synthetic test models' rich-context capacity. Production capability
checks and conservative defaults were preserved. Final combined validation on 2026-10-02 passed all 610 tests in 113.2 seconds,
server/mobile typecheck, and changed-source lint with zero errors.

Real ChatGPT/Grok/MiMo entitlement, model capabilities and account quotas still
require account acceptance. No subscription support was invented for Anthropic
or Cursor. M10 supplies bounded context/history integration later.


## Milestone 6

The VPS now dispatches computer commands and controlled file/version operations
through a registered native Linux supervisor. The node pulls scoped operations,
reconciles epochs and durable receipts, reports readiness and measured host
resources, and publishes file hash/version metadata separately from operation
completion. The aggregate host budget supports a configurable command allocation;
accounts do not each reserve a fixed 8 GB. Native user/session, systemd and UID
network policy modules preserve the administrator's existing services.

The production application composes the M4 authority and M3 resource handles.
Paired manual requests use private typed records and the same four-slot task worker;
accepted requests survive disk restart and retries preserve the original intention.
Revoked devices cannot dispatch queued work. Owned cancellation remains available
during global pause. Controlled file writes retain recoverable versions and cached
publication receipts are invalidated if the origin reports a conflict.

After the implementer's two deliveries, root corrected a bounded conflict-ACK
backlog and connected the default app/manual API. Independent review of that
composition found a pre-publication admission gap. Root now holds occupancy before
native delivery and preserves it through pause/cancel until physical cleanup is
confirmed. A partial-state SQL precedence defect exposed by that integration was
also corrected. The regression admits only three additional jobs while one native
effect remains active, including after a simulated controller restart.

Final validation on 2026-10-03 passed the complete existing test glob at concurrency
4 (645/645, 123.3 seconds), server types, nine production composition regressions
and 56 Python executor contracts. Mobile/worker types passed before the final
server-only admission correction. Changed-source lint had zero errors and three
style warnings. Earlier isolated local nftables/systemd probes passed; these do
not constitute deployment acceptance on the Lenovo/VPS.

The authorized Lenovo account keeps broad sudo and privileged groups and is
explicitly full-trust: managed-job controls cannot guarantee containment against
that account's own privileges. Desktop lifecycle/Take control, private login,
browser fallback and final installation remain in milestones 7–9/12. Native media
and physical Android/account acceptance are not claimed here. See
[the native deployment guide](../apps/computer/deployment/README.md).


## Milestone 10

Memory facts have scope, provenance, revision, edit/forget controls and explicit
retention settings. Past-thread search and compaction preserve source references;
profile settings use current revisions and Unicode-safe normalized matching.
Context projection retains the current request, system policy, complete tool
pairs and required journal receipts inside the selected models' shared capacity.
A provider with insufficient capacity waits for configuration instead of silently
dropping required evidence or repeating a completed operation.

Fresh desktop observations hydrate masked pixels through owned assets. Captures
older than five minutes remain audit references, with pixels excluded from active
model context. The original transcript and user-uploaded images remain intact.
The capture timestamp, not a deduplicated asset's creation time, determines age.

After the implementer's deliveries, root corrected Unicode and actual model/
journal integration and connected M7's observation receipt format. The final
source tree passed the complete existing test glob at concurrency 4 on 2026-10-03
(685/685, 141.6 seconds), server/mobile types, and nine provider/context composition
regressions. No live subscription or physical desktop acceptance is claimed.

This independent milestone was integrated ahead of 7–9 while their connected
browser/credential corrections were still in review. See [MEMORY-CONTEXT.md](MEMORY-CONTEXT.md).

## Milestone 7

The registered Linux account has a managed X11 desktop, persistent Chromium profile,
numbered browser actions and observed-frame desktop input. The phone viewer uses the
same session with exclusive take-control/handback, stale-frame rejection and bounded
interactive admission. Uncertain native inputs preserve their work slot and resource
leases until inspected/reset; they are not replayed.

Browser-backed source search, workspace uploads with hash checks, downloads published
as file attachments, popup/dialog guards and visibility-aware previews are connected
to the existing conversation, task journal and resources. Search currently uses the
DuckDuckGo HTML index; blocked or changed layouts return an explicit unavailable state.
Unsupported popup tabs close and script dialogs dismiss; automatic multi-window
selection/acceptance is not implemented.

Root integrated the implementer's second delivery, corrected its Docker shared-module
layout/dependency resolution, and combined it with milestone 10. The final full suite
passed **706/706** (142.4 seconds) on 2026-10-03. Root composition checks passed 14/14;
Docker-layout import/backup checks passed 3/3. The delivery also passed 21/21 real
Chromium fixtures, 18/18 Python desktop checks and server/mobile/worker type checks.
Real login, spreadsheet editing, phone intervention and file transfer on the deployed
Lenovo remain physical acceptance work in milestone 12.

## Milestone 8

Private credential cards send directly to the OpenBao-backed broker. Passwords and
verification codes bypass chat messages, mobile outboxes, model context and action
logs. Native injection uses a one-use, exact-operation grant; the VPS uses its
existing browser worker. Revocation, task direction, pause and session generation
are checked before dispatch. Same-UID/full-sudo desktop access remains full trust.

MCP connections now use the official SDK OAuth flow with PKCE, state validation,
owner/config binding, private token persistence and serialized refresh. The phone
Connections screen starts authorization and disconnects locally. Provider-side
revocation is not claimed. Provider redirect/registration compatibility and real
accounts still require deployment acceptance; see [MCP-OAUTH.md](MCP-OAUTH.md).

CAPTCHA handling gives the agent a bounded attempt using a trusted adapter region,
numbered controls or observed visual coordinates. Three submissions or 60 seconds
lead to phone handback; provider retries do not reset the budget. Unknown input
outcomes are retained. Cross-origin challenges that cannot be isolated need the
person. MFA codes are never guessed.

Root completed missing OAuth and bounded-challenge behavior after the implementer's
two deliveries, composed the final desktop/context changes and fixed Docker memory
accounting for the co-located vault. The complete suite passed **724/724**
(148.8 seconds), with server/mobile/worker type checks and four real Chromium
challenge fixtures, on 2026-10-03. No physical vault/login/phone acceptance is claimed.

## Milestone 9

Public browser research and source search can use an independent persistent VPS
profile when the native executor is offline. Routing checks concrete capabilities,
protocol version, profile/session generation and resource fences. Login on a
destination uses the private broker and that destination's own profile; cookies
are not copied. Shell and desktop jobs remain bound to Lenovo.

A possible external mutation is never replayed on another machine. Lost or invalid
mutable receipts retain their admission and profile holds for inspection. Signed
worker requests bind exact method, path, body and current task authority. Vault
reads finish before a final pause/direction/lease check. CAPTCHA continues only on
its recorded executor/session and retains the original attempt budget.

Root composed the second delivery with final desktop, vault and context changes,
then added regressions for source search, uploads and CAPTCHA routes. The complete
suite passed **755/755** (165.2 seconds) on 2026-10-03; composed focus checks passed
39/39, new source-search/CAPTCHA receipt cases 4/4, and real worker HTTP contracts
3/3. Server/mobile/worker type checks passed. Earlier delivery Chromium fixtures
passed 19/19; physical Wi-Fi loss and rejoin remain deployment acceptance.

## Milestone 11

The four-hour proactive review uses the same durable work admission, records
versioned evidence and suggests continuations for unanswered email, unfinished
work and plans. Replies recheck current source state before acting. Connected
resource annotations, result libraries and explicitly saved verified procedures
remain bound to the owner, task revision and source frame/version.

Phone file/camera/audio/share inputs use a persistent bounded outbox. Native
transcription runs as a durable job and publishes complete text/subtitle files
to the VPS, including after disconnect/restart. Failed output reads can retry
without rerunning transcription; only the exact read-only failed receipt ancestry
is reconciled. Unknown reads or external mutations still prevent verified
completion. Local Office/media helpers retain the native workspace and task budget.

MCP transport caching preserves the M8 OAuth binding and checks revocation and
configuration again at dispatch/cache publication. Cached remote descriptions are
scrubbed before model context. Google MIME, agenda and timezone regressions are
covered alongside the proactive workflows.

Root composed both implementer deliveries, corrected MCP revocation races and
native transcript completion, then ran the complete suite: **841/841 passed**
(178.3 seconds) on 2026-10-03. Server/mobile/worker types passed; connected Python
checks passed 58/58 earlier in composition and targeted transcript recovery passed
3/3. A stale receipt-text assertion was updated to the complete-file contract.
Physical microphones, Google accounts, installed ASR model and phone UI remain
milestone 12 acceptance; no such acceptance is implied by fixture tests.
