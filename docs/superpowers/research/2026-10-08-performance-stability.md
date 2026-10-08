# Performance and stability investigation — 2026-10-08

## Production evidence

- Latest API restart: 09:05 UTC, following `Reached heap limit Allocation failed — JavaScript heap out of memory`. The current cgroup reported zero OOM kills. The VPS currently has approximately 39 GB free (60% filesystem use); Docker reports only about 34 MB of reclaimable image space, so disk exhaustion is not the observed cause. Merely raising the container limit yesterday did not fix allocation pressure.
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
- Restore an active conversation in one bounded message/state snapshot, reopening only unfinished protocol boundaries. Replay only subsequent tokens/tool receipts to the client. Merge only consecutive text/argument tokens before reconstructing server checkpoints, preserving initial state, metadata and event ordering.
- Read only the latest run for task dispatch/background publication, retaining complete authoritative context for inference and full history retrieval.
- Use authenticated, resource-scoped ETags for the agent workspace and conversation interactions. A 304 avoids rebuilding the workspace and retains client object identity. Invalidate on mutations/account changes; bound the transport cache. Periodic liveness/expiry checks still run. Scope revisions to visible resource dependencies; ignore completed desktop observations and background persistence. Read-only social-window POST requests retain the cache. Accept weak validators emitted by the production compression proxy.
- Avoid recreating the conversation cards when their response has not changed.
- Correct document color regex serialization: JSON Schema does not carry case-insensitive RegExp flags. Uppercase hexadecimal colors now pass native tool validation. Accept realistic design briefs without the former 160-character rejection.

## Upstream review

Reviewed the 64 commits reachable from `CopilotKit/openmuse` main but absent from our ancestry, pinned at `1ac68f3909f2478ab6280883f1ab5ea65eb5719d`. This pin has not advanced since the preceding review; ancestry divergence is not 64 new unreviewed feature changes.

- [PR 109](https://github.com/CopilotKit/openmuse/pull/109): adapted status-scoped idea refresh queries.
- [PR 110](https://github.com/CopilotKit/openmuse/pull/110): completed section-scoped Workspace reads, preserving our multi-account Google authority and native integrations.
- [PR 108](https://github.com/CopilotKit/openmuse/pull/108), notification scoping, interrupted-chat handling and several concurrency fixes already have local equivalents.
- Did not replace the customized native desktop, Google approval policy, memory/profile persistence, connected-account handling or model/context configuration with upstream defaults.

## Validation and publication

- Broad Node 24 suite: 1,637 tests, 1,635 passed in the first complete run. It exposed loss of initial state in the generic event compactor and an assertion expecting historical token replay. Both were corrected; the complete conversation/replay suites then passed 22/22. The final browser/query/cache suites passed 49/49, and the public-proxy regression passed independently. Server/mobile strict type checks and production builds passed.
- Real-domain validation caught the compression proxy weakening ETags (`W/`), which local app tests did not reproduce. Both agent and interaction routes now perform the proper weak comparison for conditional GET.
- Code-only API publication preserves the live PGlite volume, environment hash, companions, accounts, approvals, pause state and historical uncertain effects. Current API pin: `ad01cf30`; web and Android frontend source: `270f1a56` (the later commits change server-only HTTP handling and document inspection). Public web bundle and signed APK hashes were verified after publication.
- Android release preserves package `app.openmuse.mobile`, project certificate, Firebase resources, Hermes and production URL. It updated the existing emulator installation with its credentials/data intact. The x86_64 emulator build was tested separately from the arm64 download; the emulator cannot execute this app's arm64-only native libraries despite advertising ARM translation.

## Measured acceptance

Same public domain, same account/main conversation, 390 × 844 browser viewport, ten seconds after reload:

| Measurement | Previous build | Published build |
| --- | ---: | ---: |
| API payload excluding media | 597,932 bytes | 198,138 bytes |
| Agent polling payload | 306,913 bytes / 4 full responses | 77,385 bytes / 1 full response + 3 × 304 |
| Interaction polling payload | 186,919 bytes / 11 full responses | 16,911 bytes / 1 full response + 10 × 304 |
| Composer ready, warm reload | 1,085 ms | 859 ms |

This is a 66.9% decrease in non-media API payload and an 80.9% decrease in the combined repeated agent/card payload. Total media bytes are deliberately not compared: range requests and cached companion video differed between runs (the later run fetched about 2.5 MB of video). These measurements do not establish a physical-phone GPU improvement.

- Reopened the existing user course conversation on web and Android; the recent conversation displayed immediately instead of replaying all historical tokens. Native Android PSS after opening it: approximately 275 MiB (emulator measurement, not a physical phone).
- Natural chat QA, without tool/card instructions or model overrides: “Pesquise três cursos gratuitos de IA para iniciantes. Quero os links, se o certificado é gratuito ou pago e um roteiro de estudos de quatro semanas em PDF.” Initial acknowledgement was visible within eight seconds. Reload during research restored the question, acknowledgement and live task in 1.93 seconds.
- The configured primary remains `chatgpt/gpt-6-luna`, with the existing Grok/MiMo fallbacks; no model preference or context capacity was changed for testing.
- While research/rendering ran, sampled API memory stayed around 1.23 GiB of 2 GiB; the published API stayed healthy with zero restarts. CPU samples varied, so no unsupported percentage reduction is asserted. The after profile no longer transferred all task-operation history during browser admission recovery.

## Research workflow acceptance

The first natural course/PDF test failed acceptance: after two PDF revisions, the agent asked to change the requested format instead of delivering. Byte-level inspection confirmed that the PDF already contained clickable link annotations. The agent incorrectly inferred missing hyperlinks from raster previews, and treated an ordinary section continuation across pages as a failed review.

The document inspection tool now returns actual PDF hyperlink evidence with each page preview; review instructions distinguish concrete delivery defects from optional polish and preserve the requested format. A native tool regression creates, renders and inspects a real PDF and checks its URL annotations. The document/PDF/tool-output suites passed 24/24, and the final strict type check passed. The research instructions also distinguish genuinely free course access from free enrollment, trials and paid subscriptions, checking certificate charges separately.

The second run verified the format repair: acknowledgement within eight seconds, reload during research in 472 ms, and a real three-page PDF delivered after approximately three minutes. It passed native PDF link and visual checks without a user question. Content acceptance nevertheless failed: Google AI Essentials was included as free based on an enrollment CTA, despite missing full-access evidence. The [Google pricing FAQ](https://grow.google/ai-essentials/) confirms paid access; the final harness instruction now requires observed confirmation of each explicit selection constraint before authoring, and excludes trials, subscriptions and unconfirmed eligibility from free-only requests. The final fresh conversation completed autonomously in 212.32 seconds, delivering a real 72,300-byte four-page PDF. It selected Elements of AI, Microsoft Learn and Great Learning, with observed free course-access evidence, instead of the paid Coursera choice. Certificate status was distinguished: free under completion conditions, profile achievement rather than professional certificate, and a certificate whose public fee could not be confirmed. That remaining certificate uncertainty is disclosed; this test does not establish complete certificate-price coverage or perfect research accuracy. The attachment was opened in the native Android document viewer, and all four pages passed native inspection.

Own QA tasks/conversations were removed and five generated test PDFs were archived from presentation using identity-checked updates in the running API process. Canonical receipts/files were retained for audit; no user history, companion, Google connection, approval or memory was removed. Temporary profiling hooks and the loopback inspector were closed.
