# Durable task direction, receipts and completion

Task direction uses the existing durable conversation inbox. Accepting a direction commits its inbox receipt, mailbox sequence and desired task revision together. The running task applies the mailbox at model/tool safe points without cancelling a dispatched job. The app displays received and applied receipts and requires an explicit target; an uncertain mobile send retries its original message ID and immutable body. A later authentication or task rejection cannot resolve an earlier lost acknowledgement. Only a definitive first rejection or the original acceptance receipt permits removal.

The runtime uses the existing four-unit work admission, inference admission and resource leases. Children inherit their parent's root budget and timing; a waiting parent releases its slot. Their effective mandatory validity is the earliest current validity in the owner-bound ancestry, checked in the last dispatch transaction. A missing or cyclic ancestor fails closed. A command or native file with unconfirmed physical cleanup keeps its held admission and exact resource handles until a cleanup receipt confirms release is safe. Physical cleanup does not turn an unknown semantic result into success.

## Dispatch and restart

`TaskJournal` records a concrete tool identity before the SDK executes it. Nested computer primitives receive separate durable identities and the existing resource handles. The final Store transaction checks the current task lease, desired/applied revision, global pause, mandatory validity and the exact lease ID/fence before queued work becomes dispatching. Work already handed off retains its original receipt; a new direction does not claim to undo it. Pending approval also retains its prepared revision, so applying a new direction cannot revive an old proposal.

Completed tool call/result pairs survive restart in `task-checkpoints` and `task-operations`. `history(owner, taskId)` reconstructs those pairs and unresolved evidence; `requiredHistoryIds(owner, taskId)` exposes the operation anchors for bounded provider context. Primitive and native children remain in the audit without duplicating provider pairs. Browser control replay resolves an original owned intent through its snapshot target; a new explicit browser operation ID denotes a distinct intended repetition. Unknown effects block further mutable work. Argument equality alone does not merge generic intentions.

Local file publication records its intent before writing. Recovery of that same intent verifies the published bytes and repairs its mapping; two explicit imports with equal bytes still have different IDs. Provider checkpoint consumption validates the M5 version 1 envelope and admits completed, journal-backed call/result pairs. Partial provider text is a separate buffer. Public checkpoints discard thinking/credential fields, media payloads and configured secrets. The M5 producer callback is composed separately in the next milestone and awaits durable persistence before interruption is published.

Reviewed MCP, browser and Google adapters receive a durable action callback and invoke it immediately before their mutable request, after catalogue, session, attachment, credential and target preflight waits. Preflight does not mark the action dispatched. Manual approval uses the same persisted action/task authority without requiring model async scope. An operation already marked dispatching or running must also revalidate current authority before another physical boundary; existing dispatch evidence remains available for reconciliation.

Deterministic PDF import/fill uses this common journal with identities bound to the task, applied revision, workflow stage and immutable arguments. A publication completed before a lost checkpoint is reconciled by that identity, then supplies the original file receipt on replay. It neither republishes another filled copy nor bypasses current-revision verification.

An explicit finish, user question or pending review stops further inference and drains already dispatched tool work. Typed abort causes distinguish human cancellation, shutdown, lease takeover and heartbeat failure; losing a connection does not deny a still-valid review.

## Timing and budget controls

The API prefix is `/api/agent`. Task detail includes authoritative budget, timing/revision, criteria, completion, mailbox receipts and operation receipts.

| Route | Body |
| --- | --- |
| `POST /tasks/:id/directives` | `clientMessageId`, `text`, optional `expectedRevision`, `threadId`, `attachmentIds` |
| `POST /tasks/:id/timing` | `requestId`, `expectedRevision`, optional `priority`, `dueAt`, `validUntil`, `timezone` |
| `POST /tasks/:id/budget` | `requestId`, `expectedRevision`, `additionalSteps`, optional `additionalMilliseconds` |

Timing and budget mutation receipts make a lost ACK retry recover its original result. Reusing a request ID with changed arguments fails. Timing edits preserve execution state. The older priority route remains compatible; mobile controls use the revisioned timing route.

`dueAt` is a desired completion target and permits work after it has passed. `validUntil` prohibits a new effect after that instant and is checked again after waits and restart. A dispatched effect keeps its confirmed/unknown receipt. The default user zone is `Europe/Berlin`; impossible dates and missing/repeated DST wall times require clarification. Local input accepts `DD/MM/YYYY HH:mm`; an explicit ISO offset disambiguates repeated times. IANA timezone validation also applies to timezone-only edits.

The default finite tree budget is 96 model steps and six hours of accumulated active execution. The per-turn limit of 16 steps queues automatic continuation within that same budget. Provider changes and child tasks do not reset it. Exhaustion preserves partial work and requires an explicit extension; total steps cannot exceed 10,000. Extension mutations merge only authorized limits and their revision, preserving concurrently charged steps/time; retrying the same receipt does not extend again. Background receipt polling and resource wakeups retain the same job identity. Blocked routines publish a warning and keep scheduling future occurrences when the prior task settles.

## Evidence for completion

Criteria are persisted before completion. Delegation preserves the accepted user goal and server-derived file/send/content obligations. Model criteria can add requirements, including qualifying a generic observation; they cannot replace mandatory criteria even by reusing their IDs. Literal enumerated sections/fields are retained and checked against actual data, rather than the final summary. Empty named structured values do not satisfy those content checks. Freeform goals without a bounded literal rubric still use the supported structural/observed checks; this does not claim universal semantic verification.

File and requested send/calendar/command obligations have separate checks. Email receipts must match exact requested recipients; command receipts must confirm success. Read receipts cannot stand in for a requested write. Connector verification resolves the private server-owned binding by action ID and checks its action hash, executed tool/argument binding and successful transport receipt against the action result. A display preview cannot supply authority. A browser submission requires an owned completed action plus observed confirmation. Evidence and artifacts must belong to the task's applied revision; creating a cached evidence object does not refresh its source acquisition time.

PDFs must parse and have pages. Text/JSON files must contain useful valid content. Standard DOCX, XLSX and PPTX packages require bounded ZIP members, CRC/size agreement, strict XML diagnostics, package content types, document relationships and useful content in their actual document/sheet/slide parts. ZIP limits are 1,024 members, 2 MiB per expanded member and 16 MiB total expansion; archives over 32 MiB, encrypted/unsupported ZIP encodings and XML entity declarations are rejected. Unsupported formats remain unverified. This is structural verification with persisted required items, rather than a second model's opinion.

XML parsing uses the directly pinned scoped `@xmldom/xmldom` 0.9.12 with all parser diagnostics treated as failures. See its [parser documentation](https://github.com/xmldom/xmldom) and [security policy](https://github.com/xmldom/xmldom/blob/master/SECURITY.md). A nonempty ZIP entry alone is not a valid Office witness.

`finish_task` succeeds only when the current assessment is verified. Partial delivery retains useful artifacts, passed checks, remaining criteria and the impediment, and publishes them to the originating thread/notifications. It does not fabricate an artifact from the final summary or mark every plan step complete.

## Native composition boundaries

`TaskExecutorAuthority` provides the structural M6 authorization/receipt interface without creating another operation or admission authority. `currentExecutorContext` derives task provenance from trusted async scope and can bind the existing audited computer resource scope. Commands require a server-calculated resource budget; model arguments cannot select host/UID or provide authority. Authenticated manual requests must first receive a durable immutable request/device binding. Missing context/authority fails closed.

A native node receipt owns physical completion and cleanup. Logical file/version success is recorded after the awaited backend publication/hash/version ACK returns; a failed ACK remains uncertain. Owned command cancellation uses the original task/target/resource authority as containment after cancellation or pause. Fixed session stop after pause remains a root/M7 integration gate until a server-owned session generation is bound; an executor ID alone does not grant that authority.

This milestone uses HTTP fixtures and local disk databases for integration evidence. Native Lenovo readiness, desktop generation, real accounts, Android installation, Tailscale and broad-sudo hardware behavior require the separately ordered root milestones. No remote machine, account or privilege was changed here.

Explicit user file formats remain mandatory even if the model selects a different
workflow kind. A PDF-only workflow cannot verify a requested DOCX deliverable.
For supported literal section requirements, text and extracted Office content must
contain content after each required label; headings alone remain unverified. This
is a structural check, not an assessment of the factual quality of freeform prose.
