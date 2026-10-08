# Performance and stability investigation — 2026-10-08

## Production evidence

- Latest API restart: 09:05 UTC, following `Reached heap limit Allocation failed — JavaScript heap out of memory`. The current cgroup reported zero OOM kills. Merely raising the container limit yesterday did not fix allocation pressure.
- Baseline idle API CPU samples: 25–46%; container memory about 1.23–1.25 GiB of 2 GiB. Native browser stayed near 490 MiB with negligible CPU.
- The live store contains 7,505 task operations totaling 139,290,251 bytes. `TaskJournal.operations` fetched every operation belonging to the account and then filtered in JavaScript, repeating this during research and tool execution. Mutation receipts separately total about 192 MB; no historical evidence was deleted.
- A 15-second production query profile observed 2,640 notification lookups from push recovery. Settled intents and already audited deliveries were repeatedly read and audited.
- Native executor long polling repeatedly loaded all delivery payloads, including terminal deliveries; the global inbox poll loaded completed messages every 250 ms.
- Mobile-size browser baseline, existing production build, ten seconds after reload: 1,218,986 API response bytes, 52 API requests. Agent snapshots contributed 306,913 bytes across four responses; interaction history contributed 186,919 bytes across eleven responses. This is a controlled headless-browser measurement, not a physical phone/GPU measurement.

## Fixes

- Scope task-operation queries by owner and task, with a matching partial index. Preserve all receipts, approvals and uncertain effects.
- Query due inbox messages, pending publications and queued executor deliveries in SQL. Read no unrelated history on these polling paths.
- Persist the successfully audited push status, reconcile only incomplete audits and notification status mismatches, and retain restart recovery.
- Apply worker overlap protection before heartbeat persistence so a blocked database cannot accumulate timer-driven writes.
- Restore an active conversation in one bounded message/state snapshot, reopening only unfinished protocol boundaries. Replay only subsequent tokens/tool receipts to the client. Compact consecutive tokens before reconstructing server checkpoints.
- Read only the latest run for task dispatch/background publication, retaining complete authoritative context for inference and full history retrieval.
- Use authenticated, resource-scoped ETags for the agent workspace and conversation interactions. A 304 avoids rebuilding the workspace and retains client object identity. Invalidate on mutations/account changes; bound the transport cache. Periodic liveness/expiry checks still run.
- Avoid recreating the conversation cards when their response has not changed.
- Correct document color regex serialization: JSON Schema does not carry case-insensitive RegExp flags. Uppercase hexadecimal colors now pass native tool validation. Accept realistic design briefs without the former 160-character rejection.

## Upstream review

Reviewed the 64 commits reachable from `CopilotKit/openmuse` main but absent from our ancestry, pinned at `1ac68f3909f2478ab6280883f1ab5ea65eb5719d`. This pin has not advanced since the preceding review; ancestry divergence is not 64 new unreviewed feature changes.

- [PR 109](https://github.com/CopilotKit/openmuse/pull/109): adapted status-scoped idea refresh queries.
- [PR 110](https://github.com/CopilotKit/openmuse/pull/110): completed section-scoped Workspace reads, preserving our multi-account Google authority and native integrations.
- [PR 108](https://github.com/CopilotKit/openmuse/pull/108), notification scoping, interrupted-chat handling and several concurrency fixes already have local equivalents.
- Did not replace the customized native desktop, Google approval policy, memory/profile persistence, connected-account handling or model/context configuration with upstream defaults.

Validation and production acceptance measurements are recorded after publication below.
