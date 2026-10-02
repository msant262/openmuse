# OkamiBot implementation status

Execution of the [approved twelve-milestone plan](plans/2026-10-02-lenovo-agent-implementation.md), starting at `8c8c1a4`. The earlier seven VPS milestones remain recorded separately in the historical plan.

| Milestone | Integrated status |
| --- | --- |
| 1 — Device sessions and connector resilience | Reviewed and integrated; deployment/device acceptance pending |
| 2 — Durable chat, questions and personality | Reviewed and integrated; physical device acceptance pending |
| 3 — Four work slots, resources and global pause | Reviewed and integrated; native executor acceptance pending |
| 4 — Task direction, recovery and verified completion | Reviewed and integrated; native/provider composition follows |
| 5 — Capability-aware model fallback | Reviewed and integrated; real subscription acceptance pending |
| 6–12 | Pending integration |

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
