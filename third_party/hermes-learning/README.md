# Hermes learning adaptation

Source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/158fd638da1629c8e62caf9ade1515d162def8ab),
MIT, copyright 2025 Nous Research. The license is included in this directory.

`apps/server/src/learning/hermes-policy.ts` copies `_MEMORY_REVIEW_PROMPT`,
`_LESSON_LAYER_BLOCK` and `_DO_NOT_CAPTURE_BLOCK` verbatim from
`agent/background_review.py`. `apps/server/src/learning/prompts.ts` maps those
policies to the existing database tools and adapts the declarative
memory, review, procedure consolidation and failed-work exclusion guidance in
`agent/background_review.py` and `agent/prompt_builder.py` at that revision.
`PersonalLearning` adapts the bounded detached post-turn review pattern with a
restricted tool surface and successful-write accounting. The implementation
uses OkamiBot's durable worker and existing database revision/suppression APIs;
it does not embed the Hermes runtime or create additional Markdown stores.
New foreground messages preempt the review. Failed persistence cannot be reported
as a quiet successful review. User facts require authenticated source quotations;
procedure updates require a current read and verified successful task receipts.

The adapters preserve OkamiBot's existing revision checks, history and forgotten
source suppression. Corrections supported by newer user statements update the
same record; they do not delete memory files or overwrite user-owned procedures.
Follow-up state is a small index over these sourced plan memories, used by the
existing heartbeat and suggestion journal. It is not an independent memory store.

The memory-flush lifecycle and periodic heartbeat comparison uses OpenClaw
`da979df299e88c3711f6ee2cd3c7443dd045584b`; its existing MIT attribution lives in
`third_party/openclaw`. Source content and user-controlled memory remain data,
never executable authority. Configured model selection and budgets are retained.

History retrieval adapts `tools/session_search_tool.py` at
[`1298c8e74baa73e1a2b90124228d017261ac6bc4`](https://github.com/NousResearch/hermes-agent/blob/1298c8e74baa73e1a2b90124228d017261ac6bc4/tools/session_search_tool.py):
discovery followed by canonical message reads/scrolling, bounded message text,
and demotion of repetitive automation. The PostgreSQL adapter uses the existing
owner-scoped stores, lexical relevance and per-thread diversity; it adds later
user updates so an old plan can be checked against subsequent cancellation.
Search supports accent normalization and English/Portuguese stemming, not
cross-language embedding similarity.

Semantic compaction also adapts generation ownership/cancellation rollback from
`agent/context_compressor_summary.py` at `1298c8e74baa73e1a2b90124228d017261ac6bc4`.
A superseded writer cannot commit. Cancellation invalidates its own checkpoint
without restoring a potentially cancelled predecessor; canonical history can
regenerate the cache. Summary failure is explicit and does not erase that history.

Procedure maintenance adapts `tools/skill_usage.py`, `agent/curator.py` and
`tools/skill_ledger.py` at `1298c8e74baa73e1a2b90124228d017261ac6bc4`: explicitly
agent-owned methods, separate views/runs and version-specific verified outcomes,
pinned/user-owned protection, weekly maintenance after two hours idle, and the
14-day stale / 30-day recoverable archive defaults. Active task and routine
references protect methods. Source code is Python; these contracts are ported to
our typed store and existing worker, with immutable database revision snapshots
and atomic mutation receipts instead of filesystem JSONL/blob backups. The head
record retains at most 30 versions; exact older versions remain readable and
rollback creates a new version without deleting history. Consolidation is an
explicit operation limited to identical eligible learned methods; the curator
does not rewrite methods using a model. SOUL is outside every maintenance path.
