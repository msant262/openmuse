# Document revision context and provider recovery

## Observed incident and limits of the evidence

The connected PPTX smoke for `149d5bb` ended in `waiting_provider` after seven
document creations and repeated inspections/confirmations. The final six-slide
artifact was independently readable, but its review was incomplete. The existing
smoke exported operation receipts and the task question, then deleted its isolated
database. It did **not** export the provider checkpoint's admission requirements.
The exact historical cause cannot be reconstructed from the remaining evidence.

Evidence: `artifacts/document-design/live-149d5bb/pptx/pptx-receipt.json`.
The retained 24 document operation calls and receipts total 38,042 UTF-8 bytes.
Their seven `create_document` calls contain successive authoring sources; all
successful effect pairs were mandatory context even after the files were replaced.
The runtime's conservative byte-based estimator and configured capacities remain
unchanged.

Separately, protocol tests reproduced a routing defect: a successful text-only
fallback made later requests ignore an earlier model even when only that earlier
model met the new vision, structured-output or context requirements. The routing
fix keeps the selected suffix when it remains compatible and reconsiders the full
configured order when it does not. Cooldown/quota admission still applies. This
verified generic defect is not asserted to be the cause of this particular smoke.

## Narrow repair

- `ToolOutputStore` omits only authoring `content` from a successfully created
  local document after a later successful `create_document` receipt confirms that
  it replaced that exact file. Calls, IDs, operation IDs, other arguments, all
  receipts, and the current document source remain intact. Failed, pending,
  uncertain, unrelated, or differently named tool outputs cannot establish that
  proof. All successful replay call IDs for the replaced file are covered.
- The omission records a hash and character count of the recorded source and
  points to `read_tool_output(part="arguments")`. Argument paging is available
  only for successful local document calls observed in that same task or
  conversation. Other tools' private arguments are not exposed.
- New journal entries/checkpoints preserve up to the actual 120,000-character
  document content limit with existing secret scrubbing. Other fields and tools
  retain their 32,000-character bound. Old records are not rewritten; argument
  reads explicitly describe recorded arguments and do not promise recovery of
  text already truncated by an earlier journal version.
- The TanStack adapter interruption callback persists canonical messages, not the
  compacted provider view. Partial assistant text remains separate. A new agent
  instance can reconstruct the exact recorded source, hash it consistently and
  page it without replaying the document effect. Projection is idempotent.
- Both context-admission and provider-dispatch checkpoints now carry an optional,
  strictly bounded admission record: requirements, configured model capabilities,
  compatibility decisions, considered candidates and cooldown timestamps. The
  smoke exports these fields and history counts/bytes through an allowlist;
  prompts, arguments, checkpoint messages, image bytes and credentials are absent.

No visual-review gate, effect authorization, retry limit or model capacity was
relaxed. Pixel input still loads only the latest owned image; its budget allowance
is separate from base64 transport bytes.

## Verification

- RED: `artifacts/document-design/document-context-red.log` demonstrates the
  missing projection and unsupported scoped argument read. The fixed-capacity
  fixture originally needed 142,589 and now fits below 131,072 while retaining all
  seven mandatory receipts and the current draft.
- GREEN: `artifacts/document-design/context-focused-green.log`, **38/38** across
  document context, task recovery/resume, real TanStack loops, output paging,
  admission/image-budget composition and smoke evidence export.
- The 120k regression runs the real provider protocol through an interrupted text
  stream, persists the checkpoint, reloads it through `TaskActor.history`, starts a
  new TanStack agent and reads original text beyond offset 70,000. It checks the
  original hash, separate partial text, full source and absence of repeated effects.
- The pre-dispatch diagnostic regression rejects an oversized mandatory context
  before any provider request and records the precise requirements/capabilities.
- Routing has **59/59** focused tests in the companion routing agent's validation,
  including vision, structured-output and larger-context transitions plus cooldown.

A local reconstruction with the retained live operations and the actual worker
tool inventory reached inference both before and after the repair:

| Measurement | Before | After |
| --- | ---: | ---: |
| Mandatory context admission | 123,492 | 108,816 |
| Serialized provider request bytes | 120,193 | 105,538 |
| Serialized request input bytes | 46,871 | 31,998 |

Logs: `artifacts/document-design/context-reconstruction.log` and
`artifacts/document-design/context-reconstruction-after.log`. The after inventory
includes the slightly larger argument-paging tool schema. The reconstruction lacks
the original full delegated brief, intermediate assistant text and task state; it
demonstrates retained evidence and lower context pressure, not an exact replay of
the lost failure. A fresh connected-provider smoke is still required.

## Follow-up: premature completion in `5d32491`

The next connected run reached completion without a provider interruption. Its
failure was a different, directly observable control-flow defect. In
`artifacts/document-design/live-5d32491/pptx/pptx-receipt.json`, operation 61
confirmed `passed:false` for pages 5–8 of the final document, operation 66 approved
only page 9, and operation 67 called `finish_task` with a success claim. The
verification correctly returned `complete:false` and partial completion. However,
`finish_task` unconditionally installed the failed outcome, and the loop's
`shouldContinue` stopped before the model could act on the incomplete result.

The narrow repair keeps this completion request nonterminal only when every
failed criterion belongs to an actual server-authored `designVersion:2` document
still in the task's deliverables. It returns `repairable:true`, the exact pending
pages when known, and repair/reinspection guidance. It does not emit the rejected
summary as a result or publish it. A model turn that ends in prose with the same
missing gate queues continuation with that guidance. Missing external delivery or
other failed criteria retain their existing partial/failure semantics. Passing
still requires the same owned bytes, hash, revision, image observation and complete
page coverage.

RED: `artifacts/document-design/completion-repair-red.log`, three real worker
cases ended prematurely. GREEN:
`artifacts/document-design/completion-repair-focused.log`, **38/38**, including:

- Missing review → rejected finish → inspection with actual pixels → confirmation
  → verified delivery.
- Failed review → rejected finish → replacement bytes → fresh inspection and
  confirmation → only the repaired document delivered.
- Premature final prose → queued continuation → verified delivery.
- Missing email delivery plus document review → existing terminal partial result.
- Rejected finish and prose across worker continuations share the original
  four-inference budget, then stop in `waiting_input/budgetExhausted`; no inference
  resumes without a budget extension and no premature thread publication occurs.

The independent reviewer confirmed the five focused cases and the unchanged
verification/authorization boundaries. This fixes repairability; it does not make
aesthetic judgments pass automatically or increase the work budget.

## Follow-up: repeated workflow and superseded preview instructions

The `32ea8b3` connected PPTX run stopped before reviewing its last eight-slide
document. Its admission checkpoint recorded 131,289 required units against the
configured 131,072 limit. The final document was visually readable, but that did
not satisfy its missing harness review or publication. Evidence remains in
`artifacts/document-design/live-32ea8b3/pptx/pptx-receipt.json`.

The provider projection now deduplicates byte-identical, complete `skills_read`
receipts only after checking their workflow authority, source, ID and content
hash. It retains one complete copy, preferring an already mandatory tool group.
Explicit context dependencies keep any projected alias together with its complete
source. Different versions, policies, provenance, failed reads and incomplete
reads remain unchanged. Original results remain in canonical history and can be
paged after interruption and restart.

For a successfully replaced document, the projection also shortens the exact
known procedural instruction on its old inspection receipts. All hashes, IDs,
pages, observations and other evidence fields remain intact. New or page-specific
warnings are preserved verbatim; current-document instructions are unchanged.
The fixture covering eleven superseded previews reduces mandatory context by
more than 1,800 units without changing the review gate or model limits.

Admission failures now include bounded numeric counts for mandatory messages and
each tool's argument/result bytes. Smoke evidence records skill hashes and byte
counts without exporting workflow text. This makes the next pressure incident
diagnosable without exposing provider checkpoints or private content.

## Follow-up: capability reads incorrectly classified as effects

The next connected run (`4c3e9ba`) still stopped at 131,243 units. Its new
diagnostics showed 76,512 units of base instructions/tool schemas and 41,515
mandatory message bytes. The mandatory tool list included `image_generation_status`
and a parallel group with three skill reads and a design reference. Only two
document drafts had been created. This evidence ruled out repeated drafts alone
as a sufficient explanation.

The worker's effect classifier omitted `image_generation_status` from its
read-only tools. That status lookup only reads available image capabilities, but
the journal marked it as an effect and required its complete parallel call group
in every subsequent inference. The correction classifies this exact tool as a
read. Actual generation, document creation and inspection remain mandatory
effects; tool-pair grouping and provider capacity are unchanged.

The regression executes the real worker/provider protocol through capability
lookup, file creation and completion, then projects a mixed capability/reference
batch using the journal's required IDs. It failed with
`CONTEXT_REQUIRED_TOO_LARGE` before the correction and fits afterwards, retaining
the complete file operation and leaving optional reads in canonical history.
Evidence: `artifacts/document-design/image-status-context-red.log` and
`artifacts/document-design/image-status-context-green.log`.
