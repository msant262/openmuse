# Renewed work and research recovery — 5 October 2026

The reported conversation repeated a previous partial answer when the user asked
for current information again. Testing only a new conversation had missed that
path. This change distinguishes renewed work from saved results and validates
continuation against the durable receipt.

## Reproduced defects

1. `continue_task` returned an ended task's old result as a normal receipt.
   It now reports that the new request was not executed and directs the model to
   start fresh work with the relevant conversation context. Historical status
   questions still use the saved result without starting another job.
2. A task could finish between the conversation's state check and mailbox
   admission. The mailbox recorded `completed_before_apply`, but the conversation
   still acknowledged ongoing work. The conversation now checks that receipt
   before confirming continuation.
3. The first real-provider acceptance run after those fixes started a new
   research task, but stopped after an unsuccessful TSE read. `finish_task` with
   `outcome=partial` bypassed an independent review that identified concrete
   recovery steps. A partial outcome now requires the review to confirm an
   observed blocker without viable next steps. Available alternative sources or
   read methods keep the worker working. Genuine blocked work may still deliver
   its verified findings and limitations.
4. Under load, buffered conversation events could keep embedded database writes
   running in a microtask chain long enough to starve the session lease heartbeat.
   Persistence now yields to the event loop between writes while retaining
   ordering and the rule that an event is durable before delivery to the client.
5. The live correction scenario admitted the directive but took 147 seconds to
   acknowledge it. The adapter replaced its acknowledgment context on every
   inference, discarding subsequent tool errors and inviting the same invalid
   call again. It now anchors the context replacement at the accepted receipt
   and preserves later calls/results, including errors.
6. A later live run tried `start_computer` with the computer disabled. The audit
   wrapper marked it dispatched before the backend rejected its configuration,
   leaving an unknown effect that blocked otherwise successful browser research.
   Docker and RPC configuration checks now run before resource acquisition and
   journal dispatch. Errors after an actual dispatch retain their existing
   reconciliation requirements.

The race, premature partial delivery, stream starvation, lost acknowledgment
errors and configuration rejection were each reproduced by a failing test before
their fixes. No additional attempt limit was introduced.

## Repeatable regression coverage

[Conversation tests](../tests/conversation-renewed-work.test.ts) exercise the
actual conversation agent, copied harness, database, mailbox and thread runner,
with a local provider protocol fixture:

- Renewed requests after succeeded, failed and cancelled work.
- Completion in each of those states during mailbox admission.
- Corrections to queued, running, paused and input-waiting tasks.
- Reading a saved result without another job.
- Invalid tool arguments followed by repair, preserving the user's words.
- Tool errors during acknowledgment after the correction was already accepted.
- Retrying after a lost acknowledgment without duplicating the directive.
- References to another conversation or another owner.
- Identical new messages after partial delivery versus replaying one transport run.

[Research review tests](../tests/research-delivery-review.test.ts) cover a premature
partial result followed by an actual alternative-source read and verified
delivery. Existing cases also cover more than three review attempts, genuine
blocked partial delivery, plain-text completion, inherited source recovery,
formatting repair and correcting an artifact without losing authoring tools.

[Computer preflight regressions](../tests/computer-preflight-research.test.ts)
attempt startup, a file write and a command on both a disabled Docker backend and
an RPC backend without valid configuration, then complete research through a web
source. They check that rejected operations were never dispatched and do not
leave unknown effects or prepared computer audits.

The adjacent inbox, steering and replay suites cover concurrent messages,
changed retry payloads, restart, stale checkpoints, directives before and after
dispatch, completion races, cancelled inference and AG-UI reconnects.
The [stream fairness regression](../tests/thread-stream-fairness.test.ts) exercises
a real database and short lease while injecting costly writes; all 160 text
chunks must survive without a run error. The existing long-history test also
checks 266 durable events, restart, one final snapshot and lease renewal.

An initial full-suite run exposed both stream starvation and a timing assumption
in `model-file holds its background slot before native claim across controller
restart`. The latter now repeats valid empty long polls while the model runtime
starts, with a bounded test deadline. Its admission, restart and resource-slot
assertions remain intact.

```sh
pnpm exec tsx --test --test-concurrency=2 tests/conversation-renewed-work.test.ts tests/conversation-inbox.test.ts tests/runtime-inbox-integration.test.ts tests/task-steering.test.ts tests/thread-replay.test.ts tests/conversation-handoff.test.ts
pnpm exec tsx --test --test-concurrency=2 tests/research-delivery-review.test.ts tests/research-flow.test.ts tests/harness-continuity.test.ts
pnpm exec tsx --test --test-concurrency=2 tests/local-threads.test.ts tests/thread-stream-fairness.test.ts tests/thread-replay.test.ts tests/shutdown.test.ts tests/native-composition.test.ts
pnpm exec tsx --test --test-concurrency=2 tests/computer-preflight-research.test.ts tests/computer.test.ts tests/computer-rpc.test.ts tests/computer-resource-leases.test.ts tests/action-audit.test.ts tests/task-recovery.test.ts tests/m3-root-residuals.test.ts tests/m3-review-corrections.test.ts
pnpm test
pnpm typecheck
pnpm lint
```

The full suite uses a bounded number of test processes to fit the host's memory;
this is a test runner setting, not an agent execution limit.

## Real-provider acceptance scope

The acceptance script seeds an isolated database with the reported conversation's
history and ended task, uses the configured production model, and captures real
tool receipts and live task plans. Production credentials are copied to an
isolated directory, mounted read-only at their origin, and refresh is blocked.
Production conversations are not used as a test destination.

The scripted user sequence checks renewed research through worker delivery,
asking for saved results, requesting another update after success, correcting
queued work, casual conversation while work remains open, retrying after
cancellation, and a separate research request while another job is pending.
Only the first research job is executed to delivery in this sequence; subsequent
steps verify actual conversation routing and durable admission. Running-worker
steering and races are exercised by the deterministic integration suites.

Private evidence, including the failed acceptance run, is retained under
`artifacts/renewed-research/continuation/`. Production history and credentials are
not part of this document or the committed fixtures.

## Acceptance results

The final candidate `47c4079` passed all seven real-provider scenarios using
`chatgpt/gpt-6-luna`:

| Scenario | Observed outcome |
| --- | --- |
| Renewed request after the recorded failure | New durable task; research delivered and independently verified in 243 seconds, with zero user questions |
| Ask for saved results | Used saved task status; no new task |
| Ask for another update after success | Created exactly one new task |
| Correct queued work | Stored the exact directive once on the existing task; acknowledged in 27 seconds |
| Casual message during pending work | Responded without starting or steering work |
| Retry after cancellation | Rejected continuation of the cancelled task, then delegated a new task; cancellation remained intact |
| Separate request while work is pending | Created its own task |

The research encountered unsuccessful TSE reads, continued to alternative
sources and data endpoints, updated its durable plan during execution, passed
delivery review after five attempts, and published its result to the conversation.
The acknowledgment timing above is a single acceptance observation, not a
latency guarantee. The provider, copied harness and research tools were real;
computer execution and external write integrations were disabled in the isolated
acceptance environment.

Final development-tree verification:

- `pnpm test`: **1,404 passed, zero failures/cancellations/skips** (705 seconds),
  with test processes restricted to six CPU cores for host memory capacity.
- `pnpm typecheck`: passed for server and mobile.
- `pnpm lint`: passed with zero errors; 278 existing warnings and 8 informational
  diagnostics remain.
- Production candidate Docker build: passed, including TypeScript compilation
  and copied-harness packaging.

The production candidate is derived from the deployed `3512f6c` baseline with
only the nine changed runtime files applied. It excludes unrelated development
features. Its build and the seven-scenario acceptance used the same `47c4079`
image.

The server was deployed as `47c4079` on 5 October 2026. Post-deployment checks
confirmed that the running container matches the accepted candidate, the public
API health endpoint returns `ok: true`, and the browser remains healthy.
Maintenance was released; the persisted pause revision, retained-operation count
and resource ownership state were preserved. The previous server image remains
available for rollback.
