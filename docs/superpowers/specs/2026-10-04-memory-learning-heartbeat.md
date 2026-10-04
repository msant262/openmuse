# Memory, learning and useful proactive follow-up

User scope (reconfirmed 4 October): remember user facts, preferences and recurring
patterns without requiring a save command; learn useful methods; notice important
mail/deadlines; follow up unfinished work and plans discussed in conversation
(e.g. a trip with no hotels/flights yet), asking whether to continue. This was
already intended in the 2 October Lenovo design. Do not ask the user to restate it.

## Evidence

Production at 10:53 UTC has zero memories, no goals/routines, no suggestions, and
eight completed four-hour proactive reviews. Worker is running and global pause
is off. Gmail/calendar are disconnected. The scheduler works; its source coverage
and rule-only review do not implement conversation-based initiative. Memory writes
only occur through optional model tools; context uses literal query substrings.

## Reference adaptation

Hermes `158fd638da1629c8e62caf9ade1515d162def8ab`: `agent/background_review.py`,
`agent/prompt_builder.py`, memory tools. Adapt its post-turn bounded review,
separate personal facts and reusable procedures, update-before-duplicate guidance,
restricted tools, protected user procedures and successful-write reporting.
OpenClaw `da979df299e88c3711f6ee2cd3c7443dd045584b`: memory flush and heartbeat.
Keep persistence independent of trimmed model context, coalesce periodic wakeups,
use current source evidence, and record quiet/partial/alert outcomes.

Keep the existing VPS database authoritative, including revisions, suppression,
user corrections, owner isolation and source references. Do not add a Markdown
mirror or another execution framework. Ship license/provenance for adapted prompts.

## Implementation

1. Always provide a bounded personal-memory baseline plus relevant retrieval;
   remind the chat to persist durable facts and consult past sessions/procedures.
2. Use the existing low-priority durable task worker for background reviews of
   accepted user turns and verified task outcomes. Recover unreviewed sources on
   restart; coalesce duplicates. Only memory/procedure tools are available.
3. Save concise facts/preferences/patterns and open plans with exact source quotes,
   acquisition time and revision history. Repeated events need multiple examples;
   explicit habits may use the user's own statement. Correct a matching record,
   resolve/cancel a plan from new evidence, and never resurrect forgotten evidence.
4. Save general reusable procedures from verified work; update only agent-learned
   procedures automatically. Do not save failed attempts as proven workflows or
   execute a procedure merely because it was learned.
5. Extend proactive review to due conversation plans, unfinished tasks, important
   mail and upcoming calendar commitments. Semantic classification uses the same
   configured model. Suggestions retain source versions, deduplication, snooze,
   resolution and opt-out. Reading a source does not authorize external actions.
6. Expose learning and heartbeat status, last/next review, partial/disconnected
   coverage and controls in the existing settings; keep quiet cycles quiet.

## Acceptance

Regression tests for real persistence/reload, correction/forgetting, provenance,
owner isolation, restart/coalescing, global pause/budgets, untrusted source handling,
plan follow-up/resolution/snooze, important-mail classification and no duplicate
continuation. Connected-model isolated runs must demonstrate capture, recall in a
fresh chat, learned procedure reuse and proactive plan/mail notifications. Run full
tests, types/lint, web/native acceptance and builds, then publish and verify public
artifacts. Do not invent a production Gmail connection or claim an email read while
disconnected. Existing personal content and pairing must be preserved.
