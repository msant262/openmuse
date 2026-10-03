# Local memory and conversation context

Facts, revisions, suppression records, profiles and transcripts live in the authoritative Store. No Intelligence account, additional SaaS or Markdown database is required. Existing MIT notices and demo/adapters remain.

Memory corrections and forgetting require the current `expectedRevision` and a stable `requestId`. The authenticated settings channel assigns origin; tools retain their accepted-message reference where available. A correction and its history snapshot commit together with the durable mutation receipt. An older request cannot overwrite a later correction. Restoring creates a new revision and preserves original acquisition time. Profile history and restore operate on exactly one global/conversation scope and the existing validated field allowlist. The settings channel authorizes profile restore; arbitrary quoted text and retrieved facts cannot restore preferences or permissions.

Forgetting marks a fact inactive and stores hashes of its current and recorded previous texts as durable recovery suppressions. Current text determines the fingerprint, including legacy raw edits with missing/stale fingerprint metadata. Save and correction check suppression under the same transaction lock as forgetting; automatic retrieval also excludes earlier recovered copies, including legacy facts. Deliberate authenticated settings restore creates a new active revision with an exception bound to that fact's current fingerprint; suppression continues preventing automatic recovery into another fact. Histories remain inspectable, including forgotten entries. Literal credential payloads are rejected before fact/history writes; this is a literal guard, not a promise to identify every secret hidden in arbitrary prose.

Fingerprint case folding runs only in JavaScript (NFKC, trim, lowercase). SQL validates a versioned SHA-256 byte binding of the fingerprint and current text instead of repeating Unicode case conversion. Legacy repair reads at most 100 rows per batch, checks the current text before applying metadata, and preserves revision/history and pagination timestamps. A concurrent unnormalized edit stays outside active recall; a save encountering it returns a retryable conflict rather than creating a duplicate. Explicit edit/history access still performs the existing legacy revision initialization.

`validUntil` requires an ISO date/time with an explicit offset. Optional `timezone` validates an IANA zone; it does not guess an offset for an ambiguous civil time. Retrieval compares instants, including the Europe/Berlin DST transition. No language is inferred from a timezone. `createdAt` remains acquisition time; `updatedAt` describes a later correction. Request-word retrieval is bounded and facts are labeled as untrusted data below the corrected profile and current task instructions.

Finished local runs migrate atomically to `thread_messages`, one canonical row per message. Their redundant cumulative `messages`, `inputMessages` and RUN_STARTED inputs are removed. Incremental rich events, state, M2 inbox receipt IDs and conversation cursors survive. A running run retains its recovery checkpoint. Public paged reads recover expired runs and overlay the latest durable input/events while a run is active, including current receipts before checkpoint updates. They read one current checkpoint rather than all finished cumulative histories. Migration is idempotent and resumes after restart; every mutation uses Store's write/persistence-failure path. Old conversations remain searchable. Public `messages?limit=...&cursor=messageId` pages retain stable message IDs; an unknown cursor returns a fresh page with `snapshotRequired: true`.

The provider receives bounded `providerMessages` at each TanStack model step; canonical messages remain available for replay. The bound counts UTF-8 bytes of serialized messages, system/profile/state, tools and schema, plus an explicit output reserve (4096 by default). Images use an explicit allowance (8192 by default). The browser/file wrapper uses the dispatch hydrator's shared construction, counting repeated receipt metadata and JSON serialization exactly instead of a fixed overhead guess. This conservative bound matches M5 admission; it is not an exact tokenizer. Completed tool calls/results are selected together. Current user input, supplied operation anchors and their receipts are mandatory. Missing required history, an oversized base prompt or mandatory history that cannot fit produces a clear error; evidence is never removed to force dispatch.

Profile settings bind loaded profiles, history pages, restore actions and pending responses to the selected scope, thread and pairing identity. A response from an earlier selection cannot replace the current fields or authorize a restore on another scope.

`AgentService.contextModel` now resolves the shared M5 router's actual declared or
preflight capacities. Mandatory context (including tool schemas, current input,
required receipts and output reserve) first excludes models that cannot hold it;
projection then uses the smallest remaining compatible capacity. Tools/vision/schema
eligibility stays with the same router. A tiny fallback does not block a larger
capable primary, and projection does not invent capabilities or acquire another
inference slot. The final M4 journal supplies top-level effect call IDs as required
anchors; primitives use their enclosing call. Partial provider text is not a receipt.
Actual SDK/provider tests cover declared and preflight fallback capacity, mandatory
large receipts, and a completed HTTP write followed by EOF, disk restart and resumed
execution with one physical write. Desktop capture receipts use their observedAt
capture time (not the asset storage time). Provider composition tests verify fresh
frames hydrate and frames older than five minutes keep audit references without
loading pixels; the canonical transcript remains unchanged. Actual M7 desktop
composition and physical capture acceptance are tracked separately.

Retention and limits are explicit:

- HTTP facts: 4000 characters; service/legacy fact limit: 12000. Retrieved facts occupy at most 8000 UTF-8 bytes and each long fact is capped at 4000 characters with a truncation flag.
- Memory/profile/message/notification pages: at most 100 entries. Context retrieval reads the most recent 200 canonical messages plus required operation anchors.
- Individual conversation events: 1 MiB. RUN_STARTED input copies are excluded before the event write. Existing file/upload quotas remain.
- Canonical transcripts, rich events, receipt/history and suppression records have no automatic destructive expiry. Paging bounds reads; it does not silently erase audit evidence. Explicit archival/backup management remains an operator concern.
- Typed observations and recognized desktop_observe receipts older than five minutes lose inline image content in active context and retain their artifact reference. Expired frames do not require a vision model; ordinary uploaded images do not expire. M7 supplies capture metadata; this module never changes its capture timestamp. Required uncertain-operation references and assets are never deleted by this module.

The long synthetic fixture compares raw serialized transcript/run bytes before and after migration. Those numbers describe fixture redundancy, not PostgreSQL allocated storage, VPS RAM, a physical hardware benchmark, or verified Android behavior.
