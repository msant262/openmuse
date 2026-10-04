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
