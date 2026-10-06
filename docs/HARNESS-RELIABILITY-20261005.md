# Harness reliability and conversation performance — 5 October 2026

This incident began with a completed-looking election answer marked partial and
an infographic job that failed before delivering a usable comparison. The exact
original user requests were used for live acceptance; no source URLs, results,
image prompts or scripted model replies were injected into those requests.

## Runtime and boundaries

Chat and model tasks execute the original OpenClaw `runEmbeddedAgent`, copied at
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`. The upstream manifest checks 10,664
unchanged files; the native build compiles 10,641 inputs and produces 5,573 outputs.
The native executor owns iteration, discovery, recovery, context protection,
compaction, session trees, lanes and scheduling. No OpenClaw installation,
onboarding or gateway service is introduced. Host tools retain the application's
existing effect authority, ownership, review policy and durable receipts.

The previous automatic model-turn and task-step caps were already removed.
Explicit user/operator budgets and actual provider context capacity still apply.
The `64` failure in this incident was the provider's maximum **call ID length**,
not a permitted number of calls. Wire aliases now hash overlong identifiers and
preserve call/result pairing; native journal identities remain intact.

## Corrected failures

- Conversational delegation retains the original user objective. Model-created
  briefs and completion criteria cannot expand it. The foreground normally omits
  a rewritten prompt and acknowledges the accepted request in the first inference.
- Provider-required null placeholders are normalized only for host schema fields
  that are optional and nonnullable. Required nullable fields retain explicit null.
- Long nested native operation IDs no longer prevent an actual generated image
  from being published. Publication receipts remain replay-safe.
- Large tool results remain complete in canonical storage. The live native
  projection stays valid JSON, retains numerical fields when possible, identifies
  omitted text, and permits pointer-based reads. Nested receipt JSON is not cut
  a second time by a generic 32,000-character checkpoint string limit.
- Public data reads decode compact JWS payloads, with no claim of signature
  verification. Generic expansion, grouping, locale-aware sums and shares process
  every source row before output paging or filtering. Invalid grouping pointers
  explain the source/item scope needed for repair. Invalid values never produce
  incomplete totals presented as complete.
- Basic search, fetch, extraction, public data and image tools are immediately
  callable using OpenClaw's original `catalogMode: direct-only`. Other tools remain
  discoverable through its native catalog.
- Independent delivery review receives the actual image bytes. Source text is
  preserved completely when it fits the configured model, rather than losing
  central facts to a fixed 12,000-character excerpt. Context-pressure excerpts are
  explicitly labeled. A request audit records each explicit requirement and its
  observed evidence; an unsatisfied audit item blocks completion even if the model
  returns `complete: true`. A winner-only figure does not fulfill a request for
  both candidates' values in every state.
- The hosted image agent receives the current UTC timestamp and the application
  rendering brief, preserving supplied numbers, labels and source attribution.
  Previously this transport omitted the time grounding sent to the chat agent.
- Native session persistence includes the original versioned session header.
  Without it, upstream interpreted each restoration as a legacy migration and
  rebuilt entry identities. Follow-up tests now verify retained session and
  message identities across normal conversation turns.
- Confirmed physical cleanup releases stale admission before unrelated maintenance
  can fail. Historical unknown outcomes remain unknown and are not replayed.

## Response and chat cost

The complete native runtime is initialized before API readiness, without model
transport, host tools or external effects. A local protocol benchmark measured
8.47 seconds of startup initialization. Warm first text took 126–243 ms for one
turn, 207–227 ms for 100 turns and 602–605 ms for 500 turns. These figures exclude
real provider latency and use the same durable history path as the app.

A real foreground acknowledgment dropped from 32.79 seconds in an earlier
candidate to 4.93 seconds after omitting the redundant delegated prompt. Later
runs observed 5.14 and 5.53 seconds. These are observations, not a latency guarantee.
Source access, provider response and actual image generation add their own time.

The chat indexes message details, reactions and tool receipts once per render.
Unchanged assistant Markdown is memoized. Streaming storage coalesces superseded
snapshots: a regression with 100 updates and 500 historical messages performs at
most two writes while preserving the final snapshot and accepted local messages.

## Acceptance evidence

Private evidence is retained under `artifacts/harness-incident-20261005/` and the
corresponding protected VPS directory. Credentials and private transcripts are
excluded from commits. Earlier failed candidates are preserved as failures.

The v7 candidate generated a PNG and the semantic review incorrectly accepted it.
Manual inspection rejected that run: it supplied only the winner's percentage per
state and its answer admitted geographic defects. Its automatic `accepted.json`
is not sufficient evidence of meeting the original request. This false positive
motivated the request-audit regression and the new completion gate.

Targeted validation passed: objective/explicit criteria, cleanup despite an
unrelated maintenance error, long IDs and publication replay, canonical JSON,
provider schema normalization, restored native sessions, complete aggregation,
actual image review, repair tools and streaming persistence. The copied source
hash check and build, server/mobile type checks, web export and signed Android
builds also passed. The final complete suite passed all 1,457 tests, with zero
failures, skips or cancellations. Root lint completed with zero errors; existing
warnings remain. Final live-run and publication results are recorded below when
publication acceptance finishes. The later hosted-image grounding change passed
all seven image transport tests and server type checking.

The real end-to-end run on candidate `7dad026` completed both exact requests in
one conversation, with one durable task per request and zero user questions.
Research took 107.94 seconds; the foreground acknowledgment took 5.53 seconds.
The infographic took 1,053.96 seconds (17 minutes 34 seconds), including recovery
from an expired isolated credential and five generated revisions. Only its final
image was manually accepted: all 27 UFs, both candidates' 54 percentages matching
the observed values, correct leadership colors and G1 attribution to TSE. The
first four images are retained as rejected revisions. This demonstrates recovery
and actual delivery; it does not establish an acceptable infographic latency.
The subsequent image transport was tested with the unchanged final generation
prompt captured from this run: one image completed in 49.31 seconds with the
current timestamp and faithful attribution. A duplicated map label was detected
in that raw output. This narrowly validates the transport and time/attribution
fix; it does not replace the accepted end-to-end artifact above.
Final image SHA-256:
`0f5642b5e29f7ba803ac05093f0411ecba0cd5f3f0c2aa6bf333998aa4ba3c0e`.

An ARM64 production APK was built with the existing production signing identity.
SHA-256: `cef7bfe94bc9b0a17d7c6e647f0938c6bfff49991e1b9b82b0a6e0601c4509dd`.
A separate x86_64 build from the same mobile sources opened the authenticated
conversation and activity panel on Android 14. No physical ARM64 device was used.

## Publication

The production API candidate overlays the scoped server fixes and the previously
published FCM priority correction onto production base `a3349fe`. It excludes the
unreleased memory, learning and proactivity changes already present on `main`.
Candidate source: `f5405b8545ec06d6d8fab9f7f3871e98a4cb41f7`.
Implementation on main: `66a7bbc4` and image grounding `d6cd2eba`.

Published API image: `openmuse-server:harness-f5405b8`, image ID
`sha256:3a97b3e92820f809f172ac4d3cfc9697efcda35de36c857899da5ad06730f961`.
API and production browser health checks passed; deployment maintenance ended and
the pause state remained unchanged. The confirmed stale native admission cleared
from one to zero. The 14 historical unknown operations were preserved.

Web and signed ARM64 APK release: `harness-reliability-20261005`. Public HTTPS
responses were downloaded and matched these hashes:

- Web entry: `e3902888d8f85ee8e9316297a3055294d70573966194958bf6f8c161b3546bb6`.
- APK: `cef7bfe94bc9b0a17d7c6e647f0938c6bfff49991e1b9b82b0a6e0601c4509dd`.

The authenticated collaborative browser loaded the new
`index-8001c0c8cc307dde43a409745eaa7311.js` bundle, original conversation and
activity panel. Unrelated Tailscale routes and historical failed tasks remained
intact. The APK link is <https://app.okamibot.cloud/downloads/okamibot.apk>.

## Follow-up loop and image attribution

The subsequently failing short follow-up was reproduced from its saved canonical
conversation. The original request for a geographic map was still present. Its
image prompts explicitly permitted a 27-state grid and then requested three
columns by nine rows. The historical image receipt did not record which provider
actually generated the file; current automatic routing alone cannot establish
that historical selection.

The delivery reviewer had a separate accounting defect: it compared inner JSON
bytes with a token budget, while outer provider admission estimated the complete
request differently. Replaying the original review produced
`MODEL_CAPABILITY_UNAVAILABLE` with **zero provider HTTP calls**. Its catch-all
converted that operational failure into a generic semantic repair. The executor
then repeated `finish_task` without a useful correction.

Reviews now use the copied native executor's token estimator on the full request,
including instructions and image allowance. Observations are projected only
under actual configured context pressure. An unavailable review preserves the
pending summary, selected files and applied revision, waits for the provider,
and resumes that review before executor inference. It does not ask for another
image or another source read. A changed user revision invalidates the pending
candidate. Actual semantic rejections retain concrete missing requirements and
distinguish presentation repair from additional research.

`finish_task.artifactIds` selects the intended final files. Rejected drafts remain
in the journal and file library, but task details expose only accepted delivery
files. Deterministic file verification also evaluates that selection. Image
receipts and tool results now record the actual provider and model, including
replay of a completed operation. Automatic subscription selection is unchanged;
it prefers connected Codex GPT Image, independently of the conversational model.

An isolated real follow-up on the scoped candidate used the exact short request
and captured original context. Actual image tool requests named `gpt-image-2`.
It completed in 795.10 seconds with zero user interventions and one delivered
image; four rejected drafts remained archived. Manual inspection and comparison
against the observed source verified a geographic map, all 27 UFs, both
candidates' 54 percentages, leadership colors and source/time attribution.
Image SHA-256:
`b1bb98978cc7aa3f758f328a4d6b623b8f2838d5d4590bfdd21319861ec72973`.
This establishes correctness and terminal delivery for the failing follow-up;
13 minutes remains an unacceptable latency observation. The final image briefing
also explicitly requires complete source coverage before generation and treats
images as drafts until inspected and selected.

The new regression cases failed on the old code and pass after the correction:
escaped source facts that fit native context; a review outage followed by
review-only resume with one generation; and a short follow-up requiring
geographic repair and delivery of only the selected final revision. Image
transport tests verify actual generator metadata and replay without another
provider call. Focused final validation passed all 31 review, image and media
harness tests; server and scoped candidate compilation passed. The 10,664 copied
upstream files still match their original hashes.

The first scoped publication used source
`b1d4b4020d4b9de9cd598f16a618473e5c03ff45`, based on `f5405b8`.
Image: `openmuse-server:harness-loop-b1d4b40`, image ID
`sha256:1f8ccd93bd8651caf29051be8c57e03f1c6096c4cb4c611b0ee40f71a449670d`.
Public API and production browser checks passed. Maintenance ended and pause
revision 16 remained unchanged. The 20 historical pending/unknown journal
entries and two retained resource leases were preserved. The six entries added
since the previous deployment are observations belonging to a cancelled desktop
viewer whose physical native operations are all terminal; none were replayed or
marked successful during this publication. These retained records still prevent
a stopped-writer backup readiness claim.

The exact follow-up was then submitted once through the production conversation
inbox in the original thread. This exposed additional avoidable data-query
retries: bare field names were used as JSON pointers, `/` was confused with the
empty root pointer, and object-key aggregation omitted `entries=true`. Pointer
errors now return observed, escaped field paths and types, without source values,
and explain the correct root/entry mode. Two new regressions failed before the
change; all 12 public-data tests pass after it. Production acceptance, final
publication and complete suite results are recorded below after verification.
Private evidence is retained under `artifacts/harness-loop-20261005/` and its
protected VPS counterpart.

The first production follow-up did **not** pass acceptance. It created an empty
map and a seven-UF partial draft; delivery review correctly rejected both. After
the remaining source reads, ordinary executor admission again returned a generic
capability error. The copied runtime subsequently compacted at its threshold
but did not retry the failed inference, because the host error was not recognized
as context overflow. No final file was delivered for that failed attempt.

Host admission now translates a rejection to the native context-overflow
protocol only when authenticated candidates satisfy every required capability
except token capacity. Missing vision/tools, provider credentials and an explicit
irreducible context floor retain their original failures. OpenClaw owns the
compaction and retry; no additional host agent loop or count limit was introduced.
A real native regression first failed without any provider call; with the fix,
original auto-compaction summarizes, retries successfully and persists its tree.

Research-derived image briefs are checked before dispatching the image provider.
Missing values, placeholders and an incorrect requested form return concrete
repairs without creating an image receipt. Brief review outages preserve that
phase and resume it before executor inference. Successful approval is reused for
the same prompt, revision and observations; final pixel review stays independent.
Both incomplete-data and unavailable-review recovery regressions pass, including
zero premature generations and no repeated research.

The second scoped API publication used
`ae28921f413c222f3e43a5f2047dd8c7f9a7c31e`, image ID
`sha256:63d0f8de3e417cf77023c6049336c5e04b500edeb9c80a11aa285ec68f7fdf9c`.
Public health recovered to HTTP 200, maintenance ended, pause revision 16 and
historical occupancy 20/2 were preserved. The same failed production task was
retried through its control API with its prompt, original context and observed
receipts intact. A 144,814-token host admission triggered original native
auto-compaction and successful prompt retry instead of a capability failure.
Final artifact acceptance remains to be recorded after inspecting the result.

Verification so far: all 44 research/image/worker/data tests, all seven media
harness tests and all eight copied executor tests pass. Server typecheck, scoped
production compilation and repository lint pass (existing warnings remain).
All 10,664 original upstream file hashes still match the pinned revision. The
three owned diagnostic containers and their isolated network were removed;
production services and preserved incident evidence were retained.

During that production retry, pre-generation review refused a 27-UF brief with
figures contradicting observed sources (including MG, PB, RJ and SC), and then
refused a replacement proposing only four UFs. Neither request dispatched an
image generator. This prevented additional inaccurate/partial images from
consuming generation time, but the conversational model still restarted source
coverage on each continuation and repeatedly proposed a partial finish.

Saved web evidence had only a 1,000-character excerpt, while the canonical source
receipts remained in the journal. `read_task_evidence(includeSourceData=true)` now
retrieves those complete receipts within the current owner/task scope, without
another network read. Default evidence pagination remains unchanged. Execution
instructions explicitly preserve successful source coverage across compaction
and retries; current/stale/conflicting information can still require a refresh.
The regression retrieves percentages outside the saved excerpt and proves there
was only one network read. All 52 related tests and all 17 native/context tests
pass, with server typecheck, scoped compilation and lint also passing.

A broader run exposed that an irreducible host instruction/catalog envelope
could also be classified as recoverable overflow. The bridge now checks the
minimum envelope plus current user message against available capacity before
handing token pressure to native compaction. The existing 8,000-token admission
regression again parks without a provider call and resumes after a verified
capacity change. The superseded complete-suite run was stopped after these new
changes; its results are not a final complete-suite pass.

The source-recovery publication is pinned to
`f1e7ef5615944aaea562f8857ae9abfad078f0c6`, image ID
`sha256:d30cf1bad4481975512c0baad6dec8963144603b0e974c63be1fd10307c1e854`.
The owned diagnostic task was paused while no generator was dispatched, the API
was replaced with occupancy and pause preserved, and the same task resumed
through its control API. Public acceptance and the new complete-suite result
are still pending below.

## Final recovery and corrected model capacity, 2026-10-06

The source-recovery tree passed 1,467/1,467 tests with no failures or skips
in 966,911 ms. Subsequent resume and context changes have their own verification
below; that earlier run is not a claim about code changed afterwards.

A brief diagnostic text-model comparison selected Astra for the owned task.
It obtained the remaining RO, SE and TO observations and prepared a complete
27-UF brief. After the user rejected this higher-consumption model, the original
selection was restored to `selected: null`, effective `chatgpt/gpt-6-luna`.
It remains restored. The comparison is not the implementation or a required
conversational fallback, and production acceptance reused its saved observations.
It therefore does not establish a fresh, Luna-only end-to-end research trial.

The next Luna continuation interpreted an old `waiting_provider` tool receipt
as current even though the saved brief review had succeeded. Review recovery now
retains the complete generation arguments and original revision, and dispatches
the reviewed request through a stable journal identity before executor inference.
It also recovers older paused requests from owned canonical journal records.
Ownership, revision, effect authorization and pending/unknown-effect checks still
apply; an uncertain generation is never automatically repeated. Completed image
metadata explicitly supersedes the earlier waiting receipt. Regressions cover
new and legacy recovery, one generation, no new research, and actual image pixels
in the resumed executor's request. A hypothesis about absent resumed pixels was
not confirmed by that test; no extra image-hydration mechanism was added.

The same production task, `676e70ae…2799df`, succeeded at
`2026-10-06T00:53:14.962Z`, on attempt 9. The final resumed attempt began its first
generation at `00:43:12.403Z`, required three GPT Image generations and took about
ten minutes. This is successful delivery, not a low-latency acceptance. Final
review also showed source-excerpt pressure under the former 131,072 declaration.
The task delivered exactly one reviewed PNG, had zero user questions, and the
collaborative browser showed Completed without background work still running.
Other drafts remain archived. Manual inspection matched all 27 UFs and all 54
table values to the approved, source-backed brief; numbered Northeast callouts,
geographic outlines, colors, candidates, election/turn and attribution are visible.
Actual generation receipts identify `codex/gpt-image-2`.
Final file SHA-256:
`d6b73033befb16020dcab68383843f8f241e7bbb0138baffd492d6a17adfc702`.
Private evidence: `production-accepted-final.json`,
`production-manual-acceptance.json`, and `production-geography-1.png`.

The 32,768-token regression is a deliberately smaller fixture, not a production
window. It completes research, generation and delivery with no larger-model
fallback; DeepSeek, MiMo and MiniMax have not been exercised with live credentials.
Production had instead declared 131,072 tokens for Luna. The deployment log
confirmed that this was an operational budget incorrectly reused as capacity,
not a measured model maximum. [Official GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
specifies 1,050,000 tokens. The private deployment declaration is now 1,050,000,
and the native bridge also derives its default window from provider capabilities
rather than an unrelated 131,072 constant. Context capacity is separate from
explicit user spending budgets. A real copied-executor regression retains a
request above 200,000 estimated tokens, including early/middle/late records,
without compaction, and exposes source retrieval for the correct larger window.
This validates local protocol/admission behavior, not a million-token request
against the connected account. Examples and backend instructions now distinguish
verified capacity, catalog metadata and compatibility assumptions.

The final scoped API publication is pinned to
`73b15b54e4b857e51717857e019ca1282d7897dc`, image ID
`sha256:537ae030e6c8fd56aa304a05e201736df45df1d1a4ffaee8e3ac99dd0f0c96d2`.
Live process configuration confirms `chatgpt/gpt-6-luna`, declared 1,050,000
context tokens, with the original owner selection unchanged. Maintenance ended,
pause revision 16 stayed unchanged, and the completed task and its selected file
survived the replacement. Historical occupancy is now 21 operations / two leases:
the additional entry is an interrupted read-only `read_web_data` wrapper from
the owned comparison. It was preserved, not replayed or marked successful.
The browser, web bundle and APK were not rebuilt for these server changes.

All 45 final native, preference, capability-transition, research-review and image
tests pass. Server typecheck, scoped compilation and repository lint pass
(existing warnings remain). The intermediate full-suite run loaded the new
large-window regression before the corresponding bridge change and was stopped;
it is not reported as a final pass. The fresh complete-suite result is recorded
below after it finishes.

An extra read-only review diagnostic was subsequently started with `docker exec`
as a second Node process inside the 1,280-MiB API container. Loading another copy
of the runtime exceeded that container's memory allowance; the diagnostic exited
137 and the API restarted once. This was an avoidable diagnostic mistake, not
a completed review or a million-token account acceptance. That extra process is
gone. Internal health and the public app returned HTTP 200; authenticated checks
confirmed the original Luna selection, completed task, one final file, unchanged
pause revision and preserved occupancy 21/2. No generation or source task was
replayed during recovery. Evidence: `post-diagnostic-restart.json`.

Final verification of the completed tree: **1,470/1,470 tests passed**, zero
failures, cancellations or skips, in 552,200 ms. Log:
`artifacts/harness-loop-20261005/full-suite-context-final.log`.
The scoped production source is retained by the immutable
[`deploy/harness-loop-20261006`](https://github.com/msant262/openmuse/tree/deploy/harness-loop-20261006)
tag for reproducible deployment/restore. Publication intentionally uses the
previous accepted production base with these seven server files applied; other
unreleased features already present in main were not included in this API image.
