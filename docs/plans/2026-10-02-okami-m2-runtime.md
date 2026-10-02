# Milestone 2: durable conversation and profiles

This milestone implements the conversation and personality sections of the approved
Lenovo agent design. It preserves the upstream package/data IDs, MIT notices, demo
policy and optional hosted adapter. Production local mode uses the existing sole
PGlite writer; no remote services or accounts were provisioned.

## Acceptance and replay

`POST /api/conversations/:threadId/messages` validates the authenticated owner's
envelope and acknowledges only after committing it. `clientMessageId` identifies
the logical message within its thread. `contentHash` binds the trimmed text,
attachment IDs, optional target task and annotations; reusing an ID with different
content returns a conflict. The first acceptance persists the message/run IDs,
receipt and numbered journal entry in one transaction. A retry confirms that
binding even if an attachment or task changed after the original acceptance.

`LocalThreads` drains the inbox at initialization, on acceptance and during
maintenance. Reconnecting a phone is unnecessary for accepted work to start.
Per-thread reply leases serialize responses without blocking admission or the
independent `TaskWorker`. Browser, computer, media and remote MCP tools in the
direct conversation actually create durable tasks and return a task ID. Closing
the app, disconnecting its stream or stopping a reply does not abort that task.

`GET /api/conversations/:threadId/events?cursor=N` returns owner-scoped events with
gap-free sequence numbers, stable IDs, optional run IDs and an explicit origin
(`user`, `live`, `history` or `task`). The head and tail are read from one SQL
snapshot. CopilotKit remains the response protocol. Historic run errors become
informational custom events during replay; a live error remains visible.

Each outward AG-UI event is saved under the live lease before delivery. Private
reasoning events are excluded from both the journal and transcript checkpoints.
Recovery atomically saves an interrupted run snapshot, its missing journal entries
and matching lease release. A run that had started before a crash is replayed as
interrupted, never automatically executed again. An acceptance claimed before
creation of any run can safely return to accepted admission. Task and routine
publications use deterministic IDs and commit their transcript/journal under a
thread lease before releasing it.

A rejected initial run write now checks the persisted run boundary in one SQL
transaction. With no run present, the same accepted message/run IDs remain queued,
the matching lease is released and a durable failure disposition is journaled
before retry with bounded backoff. Any persisted run is conservatively interrupted
and never automatically repeated. Mobile journal synchronization continues while
the response stream waits, keeping that disposition visible after acknowledgement;
the notice clears when the original run starts. If saving the disposition also
fails, the message remains dispatching for healthy startup recovery.

## Mailbox and checkpoint contract for milestone 4

The validated `TaskMailbox` type lives in `packages/domain/src/runtime.ts` and is
stored as `task-mailbox`. Its fields are `directiveId`, `taskId`,
`clientMessageId`, `messageId`, `threadId`, `seq`, `desiredRevision`, `status`,
text, attachment IDs and typed annotations. The stable directive ID is
`directive:<threadId>:<clientMessageId>`. Acceptance, task admission hints,
mailbox record and directive journal event commit together. The task's full
top-level `state` value and status are compared exactly before replacement;
concurrent checkpoint keys cannot pass the comparison and be overwritten.
Contention retries are bounded at eight attempts.

Nonterminal tasks receive status `received`; terminal tasks receive
`completed_before_apply` and are never rerun. Milestone 2 does not claim that a
direction has been applied. Milestone 4 must consume these same records at safe
points, persist `appliedRevision`/consumed `mailboxSeq` together with the actor
checkpoint and publish the applied receipt. The mailbox records are authoritative;
the current legacy worker's state writes are not yet a revision-aware mailbox
checkpoint. Milestone 4 must preserve the admission hints or derive them from the
records when updating state. `ConversationInbox.onAccepted` is the delivery
callback, already connected to the local drain, for scheduler integration.

## Mobile persistence and interaction

The outbox writes before reporting a local send. Draft text/attachments, every
pending message, transcript cache, event cache and cursor share one persisted
record scoped by API origin, paired owner/device identity and thread. Web writes
read and modify that record inside a single IndexedDB read/write transaction,
including writes from another tab. Native Expo files alternate checksummed
generations and preserve the previous complete generation across a torn write.
Inaccessible data or two damaged existing generations fail visibly instead of
resetting the queue. Native concurrency assumes the application's sole JS/file
writer. A synchronous submission guard coalesces double taps while persistence is
pending, and does not erase a draft edited during that write.

Uncertain delivery stays in the queue with its original ID. ACK loss does not
remove later messages. Events are merged by ID, and the cursor advances only over
a contiguous saved sequence. AppState, network and publication notifications
trigger reconnect. The composer remains available during a response; Enter sends,
Shift+Enter inserts a newline, and Stop affects the response. Thread selection
restoration and menu dismissal precede navigation; future dates use the profile's
locale.

Typed inline questions support single/multiple choice and text, field labels,
required fields and a submit button using React Native controls. Web radio and
checkbox controls expose checked state and accept Space/Enter. Answering atomically
stores the response receipt, closes that question and queues only its owning task.
Late or stale answers cannot revive terminal work. Generic routes reject secret
field names/solicitation schemas and credential/OAuth/approval kinds; answers
cannot change money approval. This is validation of supported channels, not a
semantic guarantee about arbitrary text. Credential adapters are reserved for
milestone 8. The existing document answer route maps trusted PDF field names to
typed IDs and preserves omitted optional fields rather than inventing consent.

The same literal credential identifier validator covers English/Portuguese field
IDs, answer keys, titles, labels and choice metadata. Answers revalidate saved
schemas and trusted document binding names too; obsolete unsafe cards render a
trusted-channel notice instead of editable generic fields. A neutral label cannot
make a named `senha` field or a `Password for this login` title acceptable.

## Profiles

New defaults are centralized in `brand.ts` as OkamiBot. Global profile migration
preserves an already chosen legacy name and tone. Assistant name and preferred
user name are independent, alongside language, tone, formality, response length,
humor, emojis and bounded text style. Global and conversation records have
independent CAS revisions and idempotent receipts. Reset restores profile defaults
without deleting memory or connections. Settings and chat use the same service.

Chat writes require a saved, authenticated user message bound to the actual thread
and run, and only preferences stated in that message can be persisted. Supported
ordinary language includes Portuguese name/style requests and several language
and tone variations. Unsupported or materially ambiguous requests produce a short
clarification rather than accepting a model-invented patch. External content and
one-task instructions do not authorize a profile write.

Automatic profile writes accept a conservative grammar of complete direct commands,
not preference words found inside arbitrary prose. Every clause must be recognized;
unknown narrative or attribution leaves the whole request on the ordinary work
path without changing the profile. Mixed preference/work requests likewise remain
on that path because later prose may limit a preference to the requested work.
The bounded name-and-simple-plan shorthand (“Me chame de Ana e faça um plano para
amanhã”) is supported only when its complete suffix matches; arbitrary work suffixes
are never treated as authority. Bare answers such as “German” or “Short” do not
persist preferences. Unsupported wording can be clarified or edited in profile
settings. Reset likewise requires a complete direct profile/preferences command
and matching scope. Reselecting the current
settings scope preserves the loaded profile and unsaved edit.

One prompt builder loads the effective profile at each chat/task model safe point;
tasks preserve their origin thread, while routines use the global profile. Existing
bounded memory context remains separate. Changing style does not cancel work or
change authentication, tools, money policy or resource privileges.

## Remaining acceptance work

Milestone 3 provides the shared admission/resource scheduler and four-task
integration. Milestone 4 applies mailbox revisions and actor checkpoints. Milestone
8 enables trusted credential/OAuth cards. Milestone 11 turns the validated
message/attachment/version/frame annotations into capture UI; their coordinates
are descriptive data and do not execute input actions. Android issue #128 requires
physical acceptance during milestones 11/12. Browser and fixture tests here do not
claim hardware, physical filesystem crash recovery, Android keyboard or account
acceptance. Milestone 1's stable paired `MuseApi.identityKey` replaces the additive
legacy-session compatibility shim when the root integrates the branches.
