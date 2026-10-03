# Durable proactive reviews

Connected live mode uses one persistent `ProactivityService` for periodic review and `find_ideas`. The existing maintenance timer queues that review through the ordinary task worker; it does not run a second scheduler. Sample/demo mode retains its existing idea generator. This document covers the M11 review, goal and routine integration slice; mobile attachments, voice, advanced monitors and reusable procedures have separate acceptance gates.

## Configuration and chat

`PROACTIVITY_ENABLED=true` and `PROACTIVITY_INTERVAL_HOURS=4` are server defaults. A user's first saved settings record inherits those defaults; subsequent changes persist in the database with a revision. Intervals can be changed from 0.25 to 168 hours through the authenticated settings endpoint. Environment interval defaults accept whole hours from 1 to 168. No quiet period is imposed.

Ask “Revise meus e-mails a cada 2 horas”, “Review my emails every 2 hours”, or “Prüfe meine E-Mails alle 2 Stunden”. `get_proactivity_settings` returns the revision, and `update_proactivity_settings` verifies the current accepted user message and run before changing it. Source text, old chats and arbitrary model arguments cannot change this setting. Unsupported or ambiguous wording requires clarification or an explicit settings edit. A change affects the next due calculation without replacing an in-flight review or replaying missed intervals.

The confirmed personal deployment uses `ROUTINE_TIMEZONE=Europe/Berlin`, including automatic daylight saving changes. [DEPLOY.md](../DEPLOY.md) already sets it explicitly. Generic configuration and the demo retain UTC defaults. Display language remains an independent profile field, and explicit routine/task timezone overrides remain supported.

## Admission, persistence and coverage

Each owner has at most one queued or running review cycle. Its generation, cycle/task IDs, cursor, source coverage, observation times and watermark are durable. Elapsed intervals coalesce into one current review. Review tasks have low priority, use the same global four background slots, and receive an accumulated budget of 16 source reads and five minutes of read time. They cannot reserve a fifth slot. Interactive chat and status inspection use the existing independent inbox path.

Review reads are journaled through M4. Restart or explicit global pause preserves the task, cursor and accumulated budget. Resuming the same cycle rereads current sources rather than treating an older journal receipt as fresh evidence. Exhaustion finishes the review with partial coverage and keeps the unfinished pagination cursor for a later interval. A cancelled or failed review also settles as partial when maintenance next examines it, so it cannot strand the heartbeat forever. None of these states declares the user's pending work complete.

Source limits are explicit:

- Mail: the authenticated connection must have a body-readable Gmail scope. Review lists at most 30 inbox messages from the last 30 days and reads up to eight distinct actual threads. A thread read includes sent replies and draft labels; more than 100 messages or a body over 12,000 characters makes that thread partial. Omitted or unavailable data cannot prove that a request is unanswered. Read/unread flags and a prepared draft do not prove completion. The current detector uses explicit PT/EN/DE question or reply/action cues and can miss implicit requests; it does not claim to classify every email.
- Calendar: authorized primary calendar only, over seven days, using an explicit zone and the shared date adapter. Unavailable, truncated or uncertain-zone data remains visible as partial coverage. The review makes no free-agenda assertion.
- Goals and tasks: pages of 50 existing records, with persistent continuation cursors. Human goals without a plan can receive a planning suggestion; open human stages can receive a concrete next step. Already queued/running authorized tasks keep their existing work. The absence of activity is presented as uncertainty, rather than proof that a person did nothing.

`Iniciar` and `Continuar` bind the request, suggestion revision, conversation, target IDs and observed version. The server rereads current mail or checks the current goal/task revision before linking work, and checks it again before the next effect and the concrete Google write callback. A sent reply, changed source or completed stage closes or blocks the obsolete work. An unavailable source preserves the pending decision. Concrete email replies also retain the selected thread, source message and observed recipient scope; the source cannot broaden that scope through new recipients. This domain validation does not claim semantic containment of arbitrary shell or GUI actions.

Delegated tasks inherit that authority through their saved parent/root chain. Dispatch resolves the current ancestor suggestions and inputs, including Continue bindings saved only on the parent suggestion. Missing, inconsistent or excessively deep ancestry blocks a new effect until it can be verified; valid child work continues within the same four slots and root budget.

## Cards and provenance

Suggestions appear as inline interaction cards in their recorded conversation, with evidence and observation times. They provide Iniciar/Continuar, Adiar, Resolvido and Não lembrar in PT/EN/DE. Acceptance commits the existing goal/stage/task link with the answer before confirming. A full queue returns a queued task; the card reports running only after the actual task state changes. Continue delivers one durable M4 mailbox direction to the same task and preserves its progress and budget.

The mobile submission uses M2's existing persistent storage adapter. It saves the exact response ID and payload before sending, shares one in-flight promise for a double tap, and retries the same response after a lost acknowledgement or restart. The server's durable mutation receipt rejects reuse of an ID with different details and prevents another task from being created.

New snooze answers must be in the future before local persistence. A coded server rejection of an invalid snooze allows editing the saved answer after reopening the app. Ambiguous HTTP errors, lost acknowledgements and expired snoozes with uncertain receipts retain the original ID and payload for retry.

Adiar saves an explicit offset-bearing `snoozeUntil`. Resolvido records the user's declaration and marks the original stage or goal with human provenance. Não lembrar persists suppression by semantic pending-item key, through equivalent evidence and restart. “Voltar a lembrar” records an explicit reversal in the interaction history; a later review must revalidate the source before publishing another pending card. History is retained.

Goals retain stable goal/milestone/task IDs. Live progress patches require the current revision and a single milestone ID, preserving concurrent human edits. Delegating an existing stage reuses its linked task. A completed human stage cannot be delegated again. Human declarations from the app/card or an explicit named chat command have `user` provenance; verified bot results have `agent` provenance and evidence references. A whole milestone-array replacement is rejected in live mode.

Review and acceptance also resolve older tasks linked only by `goalId`. A unique existing plan is linked and continued with its original ID, progress and budget. Multiple matching root tasks require an explicit choice and do not produce another planning card or task. Creating live goal work advances the goal revision atomically, so a concurrent review acceptance cannot commit against a task set that changed through the supported API.

Suggestion, interaction event and publication outbox are committed together before notification. Semantic item keys deduplicate cards and task links; deterministic publication keys use the existing durable notification/push service. Suggestion notices target the exact review task; inline cards replay in the recorded conversation. Routine result notifications retain their exact execution task IDs. Physical OS push delivery and any additional suggestion-specific navigation require the separate mobile acceptance gate.

## Authenticated API

All endpoints use the existing authenticated owner; model arguments cannot select another owner or source account.

- `GET /api/agent/proactivity/settings` and `POST` with `{expectedRevision, enabled?, intervalHours?, requestId?}`.
- `POST /api/agent/proactivity/review` returns the current cycle and actual task state, or `paused`, `disabled`, or `not_due`.
- `GET /api/agent/proactivity/cycles` returns a bounded cycle page; `GET /suggestions?threadId=…` returns saved suggestions.
- `POST /api/agent/proactivity/suggestions/:id/respond` takes `{requestId, clientResponseId, expectedRevision, action, snoozeUntil?}`; targets or source overrides are rejected.
- `POST /api/agent/proactivity/suggestions/:id/unsuppress` takes `{expectedRevision}` and preserves the reversal in the existing conversation journal.

Behavioral tests use temporary persistent local databases, an injected clock and synthetic Google adapters only. They cover four-slot saturation, pause/restart, fresh sent replies, unknown sources, CAS races, lost acknowledgements, durable suppression, budget exhaustion and final dispatch checks. No real account, email or push action is part of this evidence. Full M11 integration review, native exports and physical Android/iOS/Lenovo/VPS acceptance are separate from the review service tests.
