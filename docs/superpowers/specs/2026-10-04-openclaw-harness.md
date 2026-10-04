# Executable, resumable assistant harness

The owner requested a review of the entire harness and maximum practical reuse of OpenClaw after three product failures: research exhausted the chat tool loop without delivering an infographic, a simple PDF stalled on model admission, and Google setup exposed deployment variables. This work is authorized implementation, including release and recovery of the existing PDF task.

## Evidence and architecture decision

Reference: OpenClaw commit `da979df299e88c3711f6ee2cd3c7443dd045584b`, MIT, copyright 2026 OpenClaw Foundation. Reuse portable policy and algorithm modules with their license and provenance. Adapt the execution contract to the existing TanStack model loop, durable task journal, file store and native approval policy. Replacing the entire service with OpenClaw would also replace product identity, mobile integration, native leases, approvals and stored tasks; it is not required to repair these failures.

The PDF's first chunk completed 16 model turns and 62 read-only operations. Its next attempt added 48 evidence records (47,826 serialized bytes) to the fixed prompt. Tool schemas were counted before JSON Schema conversion: the same local worker catalog measured 109,209 fixed bytes with raw schemas versus 61,563 after normalization. The accumulated evidence plus this overestimate rejected the next attempt before optional history could be pruned. That rejection saved about 171 KB of canonical history into a provider checkpoint; a later retry would embed that checkpoint again into its mandatory system prompt, preventing recovery. Production declares 131072 context tokens for the selected and first fallback models. Normalize schemas, bound the evidence index with scoped retrieval, and replay checkpoint history only through the context projection; do not conceal these defects with larger advertised model capacities.

## Execution contract

1. A requested action must start a real tool or durable task before the assistant promises future work. A task only completes with verified evidence and delivery to its originating conversation.
2. The same actual tool catalog and current runtime facts drive model instructions and self-description. Saved procedures are disclosed as procedures, not fictitious installed skills. Public technical sources supplement local facts when needed.
3. Full canonical messages and operation receipts remain durable. Provider context is a bounded projection, with complete call/result pairs, retained effect receipts and accessible omitted tool output. Resume never embeds its own provider history into mandatory instructions.
4. Repeated identical calls with unchanged outcomes receive a warning and eventually a veto before execution. Novel arguments and changed outcomes remain possible recovery paths. Control and delivery tools remain usable.
5. Large observations cannot consume the entire model context. Oversized output is bounded for inference and can be paged on demand; raw receipts remain intact for replay and audit.
6. Ordinary document creation has a server-side path with bounded content, valid bytes, idempotent receipts and normal artifact delivery. It does not depend on a connected desktop. Complex native work retains the existing executor.
7. Model routing, interruption, cancellation, authorization and journal reconciliation retain their existing guarantees. No model/provider switch bypasses approval or repeats an unconfirmed effect.

## Scope of the complete review

Review chat/worker loops; prompt construction and runtime inventory; procedure/skill discovery; tool schema conversion, result size and context projection; model selection and fallback; durable continuation and recovery; native executor lifecycle; file creation, verification and publication; connector authentication; effect authorization and cancellation. Record each as reuse, adaptation, existing behavior retained, or an explicit unresolved limitation. The result is not a claim of full OpenClaw feature parity.

## Validation and release

Use regression tests for real failure boundaries, not assertions against prompt wording alone. Cover a long read-only continuation, exact provider admission, repeated results, changed-result recovery, output paging, multilingual multi-page PDF creation, idempotency and originating-thread attachment. Run the repository suite, server/mobile type checks and lint. Exercise actual connected-provider chat-to-worker image and PDF delivery, resume the preserved PDF task, and verify downloaded bytes/content. Release from a clean commit and verify public health, identity/avatar, provider/executor connection and maintenance clearance. The already completed Google/Android release remains recorded separately at `7529b63`.
