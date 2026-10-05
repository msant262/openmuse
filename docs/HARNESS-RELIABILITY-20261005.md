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

