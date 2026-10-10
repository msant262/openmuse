# OpenClaw source reuse

Upstream: https://github.com/openclaw/openclaw

## Active embedded harness (5 October 2026)

Chat and model-backed task workers now call the upstream `runEmbeddedAgent`
executor compiled from [harness/](harness/), pinned to
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1` (2026.9.8). This replaces the
application's TanStack agent loop on those execution paths. The earlier portable
helpers described below are historical reuse; they are not the new executor.

The copied tree contains the executor's dependency closure, workspace packages,
runtime worker entrypoints and SQL schemas. [UPSTREAM.json](harness/UPSTREAM.json)
records SHA-256 hashes for 10,664 unchanged upstream files. `pnpm build:harness`
checks every hash before compiling the copied source. The two host-owned files
listed in the manifest expose the embedded entrypoint and package metadata.
The original MIT notice is preserved in [harness/LICENSE](harness/LICENSE).

The original executor owns tool discovery (`tool_search`, `tool_describe`,
`tool_call`), model/tool iteration, retry and terminal recovery, context guards,
compaction, session trees, command lanes and runtime worker scheduling. The
application does not impose the former 10/16-turn or automatic 96-step task cap.
Accumulated usage is still recorded, and explicitly configured task budgets are
still honored. Streaming idle checks and attempt cancellation run through the
upstream harness; the host allows a six-hour attempt instead of its former
one-minute provider and five-minute inference deadlines.

`apps/server/src/engine/openclaw-agent.ts` is the integration boundary. An
upstream provider plugin uses the application's authenticated model transport,
model selection and credential storage. An upstream tool plugin exposes the
application's owner-scoped tools through the native discovery protocol. Actual
tool receipts, approvals, durable task ownership, image references and UI events
remain application records. Native session/compaction trees are saved separately
and restored only when they match the authoritative transcript. The host does
not replace the upstream agent loop or enable a second owner for external effects.

The host enables the original loop detector. For a dispatched host tool, it keeps
the native child call and outcome and removes confirmed duplicate `tool_call`
transport records from the native diagnostic history. Failed wrappers without a
dispatched child remain visible. This uses the original session-state export in
the host-owned entrypoint; upstream thresholds and algorithms are unchanged.
Detailed host instructions follow native tool visibility and discovery receipts,
so deferred tool modules do not add instructions before they are selected.
The original `session_status` tool remains allowed. Live clock metadata uses
upstream's current-time formatter at the model transport boundary, preserving the
authoritative user transcript and native session tree. Host question forms follow
the native policy of asking for decisions or private input only when necessary.
Public HTML reads use upstream's visibility sanitizer and Markdown extractor,
keeping links beside their source text. The host preserves accessible image
labels, resolves public links, and retains its existing network and owner guards.
Core command tools are visible without discovery only for a configured owner
computer. Structured dataset queries remain discoverable. A completed computer
start has a succeeded operation receipt even while the computer itself is running.
Legacy starts are reconciled only against their independently confirmed native
start receipt; interrupted or uncertain effects remain blocked.
Known OpenAI reasoning contracts are resolved by the copied provider helper;
the native effort reaches the actual admitted provider route. Unknown fallbacks
keep their own defaults. Large JSON excerpts preserve actual source values and
expose structure instead of replacing a large root with an empty query result.
Conversation handoffs preserve the canonical transcript through the origin
message boundary. The former 12-turn/64k-character fork cuts and 32k-character
user/assistant checkpoint cuts are removed; native model admission and
compaction own the context budget. Source-derived partial exits before an
image exists receive one continuation in the same task revision before ending.

Only the embedded source is compiled into this service. No OpenClaw application
package, CLI, gateway service or onboarding command is installed or started.
Bundled product plugins are disabled; our existing tools and skills are supplied
at the host boundary. This is source reuse of the embedded harness, not a claim
that OpenClaw's separate channels, OAuth flows or product UI have been reproduced.

The [acceptance record](ACCEPTANCE.md) covers the native iteration and restart
tests, real-provider research run, and production publication.

Reviewed source revision: `da979df299e88c3711f6ee2cd3c7443dd045584b`.
The upstream MIT notice is preserved in [LICENSE](LICENSE).

| Local file | Upstream file | Adaptation |
| --- | --- | --- |
| `apps/server/src/engine/promised-work-prompt.ts` | `src/agents/promised-work-prompt.ts` | Attribution header added; policy text unchanged. Included in both chat and background-worker provider prompts. |
| `apps/server/src/skill-frontmatter.ts` | `packages/markdown-core/src/frontmatter.ts` | Portable parser copied; package-specific `isRecord` import replaced by an equivalent local predicate. YAML parsing and recovery behavior retained. |
| `apps/server/src/engine/openclaw/tool-loop-no-progress.ts` | `src/agents/tool-loop-no-progress.ts` | Algorithm unchanged; import uses a local structural record type. |
| `apps/server/src/engine/openclaw/tool-loop-argument-churn.ts` | `src/agents/tool-loop-argument-churn.ts` | Algorithm unchanged; import uses a local structural record type. |
| `apps/server/src/engine/openclaw/tool-result-limits.ts` | `src/agents/tool-result-limits.ts` | Portable cap functions copied; live results scale with the effective context instead of stopping at 64k characters. The build substitutes these functions in the native module, preserving its other guard functions and byte-verified upstream source. The model projection and native persistence/dispatch/context guards share one budget; global context admission remains active. |

`tool-progress.ts` and `tool-output.ts` are application adapters, not upstream code.
They consume canonical TanStack history, preserve existing effect receipts, and provide
bounded output paging. The first guard uses exact arguments/outcomes; OpenClaw's
provider-specific volatile-output normalization and typed terminal-exec classifiers
are not represented as implemented here.

The original copyright and license apply to these reused portions. Other application
components keep their existing license and provenance.

## Additional reuse: 4 October harness implementation

`apps/server/src/engine/openclaw/tool-search-ranking.ts` copies
`src/agents/tool-search-ranking.ts` at `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`.
Only the normalization-core `isRecord` import is replaced with a local predicate;
BM25, tokenization, query expansion and parameter text traversal are preserved.
`engine/tool-discovery.ts` adapts the search/describe progressive disclosure
contract of OpenClaw ToolSearchRuntime and Hermes `tools/tool_search.py` at
`1298c8e74baa73e1a2b90124228d017261ac6bc4`. It keeps original native execution
identities instead of adding an independent effect dispatcher.

Semantic compaction ports the summary structure, exact-identifier extraction and
quality audit from `src/agents/agent-hooks/compaction-safeguard-quality.ts` at
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`, including the query-expansion,
UTF-16 and prompt-data sanitization helpers it uses. Imports and portable string
helpers are adapted to this repository. The existing configured streaming
provider generates summaries; bounded source windows are validated before an
owner-scoped, source-fingerprinted checkpoint is committed. Complete required
operation receipts remain outside the summary in the model context.

Event heartbeat adapts `src/infra/session-event-wake.ts` (wake priority,
250 ms coalescing, retaining deferred work) and ports
`src/infra/heartbeat-active-hours.ts` at the same pinned revision. Events use
owner-scoped durable rows, atomic claims with review tasks, retry backoff and
reconciliation on the existing one-minute maintenance tick. There is no second
scheduler. Plan deadlines, goal changes and task outcomes are actual producers.
Native Gmail and the primary calendar are polled every five minutes; changed
source versions enqueue a review, whose existing evidence checks run again
before publication. This adapter does not install Google Pub/Sub, `gog`, or
assume background support from an arbitrary MCP connector. Gmail change polling
uses [`users.getProfile.historyId`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
without downloading message bodies. Disconnected and partial coverage is explicit.

## Conversation continuity (5 October)

`engine/openclaw/history-turns.ts` copies `limitHistoryTurns` from
`src/agents/embedded-agent-runner/history.ts` at `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`.
The message type is generalized; user-turn boundaries, prelude retention and
batched eviction are unchanged. `engine/delegated-context.ts` adapts the
parent-transcript fork contract in `subagents/spawn/subagent-spawn-context.ts`
to this application's authenticated canonical transcript and task store. Prior
source receipts and exact user messages accompany the new task, while effect
authority and operation journals stay in the existing worker.

`engine/openclaw/plan-completion.ts` ports the unfinished-plan terminal check from
`src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts` and its
`terminal-retry-state.ts` at the same revision. The follow-up text is unchanged.
The adapter persists the one-shot check by task direction revision, requeues the
existing task and reuses its journal. Explicit stop, lease loss, waiting for input,
provider continuation and completed effects remain owned by the existing runtime.

Research delivery retries also use the unchanged `getNoProgressStreak` algorithm
from `tool-loop-no-progress.ts`. Its local result fingerprint contains source
observations, outstanding delivery issues and artifact IDs, rather than stopping
after a fixed number of reviews. The research review and provider context adapters
remain application code. Provider projection keeps the largest compatible configured
context; a smaller fallback is admitted only if it can carry the actual retained
request, so it cannot discard a larger model's research history in advance.
