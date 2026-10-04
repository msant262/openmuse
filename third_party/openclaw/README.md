# OpenClaw source reuse

Upstream: https://github.com/openclaw/openclaw

Reviewed source revision: `da979df299e88c3711f6ee2cd3c7443dd045584b`.
The upstream MIT notice is preserved in [LICENSE](LICENSE).

| Local file | Upstream file | Adaptation |
| --- | --- | --- |
| `apps/server/src/engine/promised-work-prompt.ts` | `src/agents/promised-work-prompt.ts` | Attribution header added; policy text unchanged. Included in both chat and background-worker provider prompts. |
| `apps/server/src/skill-frontmatter.ts` | `packages/markdown-core/src/frontmatter.ts` | Portable parser copied; package-specific `isRecord` import replaced by an equivalent local predicate. YAML parsing and recovery behavior retained. |
| `apps/server/src/engine/openclaw/tool-loop-no-progress.ts` | `src/agents/tool-loop-no-progress.ts` | Algorithm unchanged; import uses a local structural record type. |
| `apps/server/src/engine/openclaw/tool-loop-argument-churn.ts` | `src/agents/tool-loop-argument-churn.ts` | Algorithm unchanged; import uses a local structural record type. |
| `apps/server/src/engine/openclaw/tool-result-limits.ts` | `src/agents/tool-result-limits.ts` | Portable live-cap constants/functions copied; normalization-dependent helpers omitted. Local adapter additionally caps conservative UTF-8 bytes. |

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
