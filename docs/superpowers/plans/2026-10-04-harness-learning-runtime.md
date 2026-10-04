# Harness Learning and Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement consistent memory, deferred tools, semantic context compaction, useful history retrieval, event-driven heartbeat and maintainable learned procedures.

**Architecture:** Retain the existing owner-scoped store, journal, worker and provider adapters. Port the audited Hermes/OpenClaw algorithms and contracts into small adapters; one authority for memory writes and one dispatcher for effects. Preserve canonical transcripts and receipts when changing model-visible context.

**Tech Stack:** TypeScript, Zod, TanStack AI, PostgreSQL/PGlite, node:test.

**Spec:** `docs/superpowers/research/2026-10-04-harness-hermes-openclaw-review.md`, findings 2–7, and the user's current six-part objective. The user's rule separating memory from SOUL is mandatory. Natural SOUL intent, cache optimization and additional loop classification are separate audit findings, not prerequisites added to this objective.

## Global Constraints

- Memory never grants authority or modifies SOUL; profile edits require the current user's explicit request.
- Reuse pinned Hermes `1298c8e74baa73e1a2b90124228d017261ac6bc4` and OpenClaw `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`, with license/attribution for copied code.
- Do not recreate cancelled, expired, resolved or forgotten plans; preserve owner isolation and revision conflicts.
- Keep canonical operation receipts, uncertain effects, cancellation and restart semantics intact.
- Source data does not authorize effects. No new external account is assumed connected.
- Existing feature branch/workspace is the continuation target; preserve prior audit documents.

## Review Focus

- Corrections after an earlier plan was summarized/learned must take precedence, including across restart.
- Deferred tool execution must retain the actual tool identity and receipts, not hide effects behind a generic bridge.
- Cancellation during compaction or source refresh must not publish stale summaries/alerts.
- Automation history must not crowd out the user's actual conversation or another owner's data.
- Procedure maintenance must protect user-owned/pinned content and associate outcomes with the exact version used.

## Task 1: Consistent sourced memory

**Files:** Create `apps/server/src/learning/memory-writer.ts`, `tests/sourced-memory.test.ts`; modify `learning/service.ts`, `personal-tools.ts`, `engine/model.ts`, `learning/prompts.ts` and affected integration fixtures.

**Interfaces:** Export `sourcedMemoryInput` and `writeSourcedMemory(service, owner, raw, messages, origin, requestKey)`. `PersonalLearning.learn` and foreground/task memory tools consume the same input and writer. Tool sources are loaded from owner-scoped accepted inbox messages; callers cannot invent origin metadata.

- [x] Write/run failing tests: direct writes without authentic evidence fail; valid preferences persist with evidence; worker sources cannot spoof current chat; later cancellation updates one plan and retires its alert; profile remains unchanged.
- [x] Extract and strengthen shared evidence/revision/expiry validation; route remember/correct through it, bind forget to an explicit current user request. Preserve settings APIs and existing forgotten-fingerprint protection.
- [x] Run `pnpm exec tsx --test tests/sourced-memory.test.ts tests/personal-learning.test.ts tests/memory-history.test.ts tests/routines-integration.test.ts tests/proactivity-learning.test.ts`. Expected: all pass.
- [x] Commit Task 1 with tests and source attribution.

## Task 2: Deferred native tools

**Files:** Create `engine/tool-discovery.ts`, `tests/tool-discovery.test.ts`; modify `engine/tanstack-agent.ts` and runtime/tool catalog declarations as required.

**Interfaces:** A per-run `ToolDiscovery` owns an immutable available tool catalog and a set of loaded schemas. Search returns bounded metadata, describe exposes validated schemas; runtime dispatch still uses the original registered executable and journal identity. Restore loaded identities from canonical history on continuation.

- [x] Write/run failing tests: simple chat excludes heavy schemas; exact names/discovery find a capability; describe then actual execution works; unavailable names fail; effect receipts survive restart and handoff/final-turn restrictions.
- [x] Port/adapt lexical ranking and progressive disclosure, retaining a small eager control set and all underlying authorization checks.
- [x] Run `tests/tool-discovery.test.ts`, `tests/memory-context.test.ts`, task context/resume and chat handoff tests. Expected: lower measured schema bytes with preserved behavior.
- [x] Commit Task 2.

## Task 3: History retrieval

**Files:** Create `history-retrieval.ts`, `tests/history-retrieval.test.ts`; modify `db.ts`, `personal-tools.ts`, `memory.ts`, schema initialization if needed.

**Interfaces:** `HistoryRetrieval.search(owner, {query, limit, before?, after?})` yields source/message IDs and bounded snippets; `read(owner, {threadId, messageId, before?, after?})` yields a bounded canonical message neighborhood. Memory recall uses ranked retrieval with active-state filters before ranking.

- [x] Write/run failing tests: reordered words/accent variants retrieve sources; follow-up reads reveal cancellation after original plan; stale/forgotten memories never rank; automation is demoted; pagination and owner isolation hold.
- [x] Adapt Hermes discover/read/scroll and OpenClaw lexical/diversity ranking to the existing store; expose recovery tools without injecting whole histories. Preserve literal-ID lookup and canonical fallback.
- [x] Run `tests/history-retrieval.test.ts`, memory history/context and personal learning tests. Expected: all pass.
- [x] Commit Task 3.

## Task 4: Validated semantic compaction

**Files:** Create `engine/context-compaction.ts`, `tests/context-compaction.test.ts`; modify `engine/tanstack-agent.ts`, conversation/model integration and persistence.

**Interfaces:** A scoped compactor receives canonical messages, required operation IDs, the effective context budget and an abort signal; returns a validated summary plus retained message tail. Summaries carry source boundary/fingerprint and persist separately from canonical transcripts. Provider-backed summarization uses existing routing/admission.

- [x] Write/run failing tests: long chat plus “continue” retains original constraints/corrections; invalid summary cannot replace history; cancellation/stale writers cannot persist; restart restores summary and never repeats effects.
- [x] Port OpenClaw structured summary/quality checks with Hermes cancellation ownership. Compact before history loss, accounting for schemas/output reserve; preserve complete required call/result groups and exact IDs.
- [x] Run compaction/context/resume/provider restart tests. Expected: meaningful original requests survive bounded model context without altering canonical evidence.
- [x] Commit Task 4.

## Task 5: Event-driven heartbeat

**Files:** Create `proactivity/events.ts`, `tests/proactivity-events.test.ts`; modify `proactivity/service.ts`, `engine/service.ts`, source integration/notification paths and settings/domain where necessary.

**Interfaces:** `ProactivityEvents.enqueue(owner, {source, key, revision, dueAt?, ...})` durably coalesces authenticated source/task/plan events; the existing scheduler consumes eligible events and time deadlines. Source adapters report explicit connection/coverage/version and reread before publication.

- [x] Write/run failing tests: a near deadline/event bypasses the normal four-hour cadence; duplicate events yield one review; pending events survive restart/pause; cancellation retires an alert; disconnected/partial sources are not empty-success.
- [x] Adapt OpenClaw wake priority/coalescing/active-hours into the durable scheduler; wire actual task/plan/source producers, source polling/watch ingestion and deadline wakeups. Retain periodic reconciliation and native notification delivery.
- [x] Run proactivity event/learning/persistence/race/pause/authority tests. Expected: timely single alerts and no stale publication.
- [x] Commit Task 5.

## Task 6: Learned procedure maintenance

**Files:** Create `learning/procedure-maintenance.ts`, `tests/procedure-maintenance.test.ts`; modify `playbooks.ts`, domain playbook schemas, learning/service and task outcome integration.

**Interfaces:** Paginated procedure catalog/read; durable usage/outcome records reference exact procedure/version/task. Maintenance applies versioned archive/restore/consolidation operations only to eligible learned records and preserves history.

- [x] Write/run failing tests: bounded discovery plus exact read; successful reuse/failure attributed once; correction updates an existing method; archive/rollback recover an earlier usable version; user-owned/pinned methods cannot be automatically edited.
- [x] Adapt Hermes usage/provenance/curator/ledger contracts to existing versions and verified task outcomes; connect scheduled maintenance to the existing worker, never SOUL.
- [x] Run procedure maintenance/playbooks/personal learning and task completion tests. Expected: all pass.
- [x] Commit Task 6.

## Task 7: Integrated acceptance

- [x] Run full `pnpm test` with bounded concurrency/CPU, `pnpm typecheck`, `pnpm lint`; investigate every new failure and report pre-existing failures explicitly.
- [x] Exercise realistic integrated conversations: preferences across sessions, a cancelled dated trip, long-task continuation, deferred document/email capabilities, urgent-source event and procedure correction/reuse.
- [x] Obtain a fresh whole-change review per the executing-plans skill, fix material findings with regression tests, record attribution and limitations.
- [x] Audit every six-part requirement against runtime paths and tests; preserve evidence in an acceptance document before marking the goal complete. Publication follows the already-authorized deployment scope only after concrete verification.

## Execution rulings

- The user explicitly requested implementation of the audited six-part scope. Continue without another plan-approval round.
- Work in the existing feature branch to preserve the requested session continuation and installed local fixtures; no concurrent product edits were present at start.
- Use native execution for interdependent runtime changes and a fresh final reviewer; the review subagent is explicitly required by the selected execution skill.
