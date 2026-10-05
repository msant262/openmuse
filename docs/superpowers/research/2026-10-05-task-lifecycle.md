# Live task progress, deletion and research continuity

The historical Orca transcript was read without modification. Workspace HEAD at the
start was `5acb6aa`; production remained on `4b9ac42`. The new screenshots exposed
four gaps: generic plans never changed, active tasks prevented conversation deletion,
task status was hard to distinguish and old work could not be removed, and researched
answers could be rejected or lose their source observations during delivery repair.

## Evidence and changes

The production election task `c9e6bb13e75a31edaf0506f8a2b90d170aebb3f70a797e63da6b6a2ee499fab6`
had used 13 of 96 inference steps. Its research review accepted the answer, but the
response verifier required literal phrases such as “estado atual” and “fontes
verificáveis”. Response criteria can now consume the accepted semantic decision only
for the exact delivery hash and current task revision, with a successful research
read. File and effect receipt checks retain their existing contracts.

A second isolated model run exposed another cause. Once only delivery tools were
needed, the mandatory prompt fit a 32,768 context fallback. Projection then used that
fallback's capacity even though the primary and another fallback declared 131,072.
The next request contained only the original question and no source observations.
Context projection now uses the largest compatible configured window; inference
admission still requires the selected provider to carry the actual request. The
current review is refreshed in prompt context, and delivery repair retains saved
result paging and plan tools.

Research reviews continue when observations, remaining issues or artifacts change.
OpenClaw's no-progress streak detects repeated unchanged failures instead of a total
three-review cutoff. A regression completes after five research reviews with new
observations. OpenClaw's unfinished-plan follow-up is ported from pinned revision
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`, with its unchanged follow-up text and
one-shot terminal check. The adapter reuses the existing task, lease and journal.
The reused source and MIT notices are recorded in `third_party/openclaw/README.md`.

Task detail projects completed, active and failed journal operations for generic or
unmaintained plans. Maintained model plans retain their titles and show execution
receipts underneath. The open modal refreshes every two seconds and prioritizes its
enriched detail over the generic sidebar snapshot. Final delivery has one milestone.
Task summaries render Markdown. Status labels use distinct colors and icons.

Conversation deletion explicitly stops the reply and unfinished tasks of that
conversation, interrupts accepted inbox entries and retries the existing atomic
delete. The responsive confirmation and translated error remain within the viewport.
Individual task removal first fences an active parent, cancels it and its children,
then soft removes the entries. Bulk cleanup removes succeeded, failed and cancelled
work. Saved files and journal receipts remain stored. A removal cannot resume through
stale controls. No production user conversations or tasks were deleted during testing.

## Verification and release

The red/green regression for mixed context sizes exercises the real SDK and provider
protocol: after a source read, delivery repair must receive the original observation
with a smaller fallback configured. Current review instructions must also survive.

Browser acceptance at 1134px and 390px checks an open plan changing from 1/3 to 2/3
without a timestamp change/reload, status/removal controls, persistent task removal,
bulk cleanup preserving active work, and conversation deletion with unfinished work.
A forced translated deletion error verifies that the confirmation buttons still fit.
Evidence is under ignored `artifacts/task-lifecycle/`.

Published API overlay `7581bd3425999d2506b9fc6da4e28324e4628bdd` on the existing
`4b9ac42` production base. Unrelated context/memory changes already present in local
HEAD were not bundled into this release. Server image:
`sha256:99c33a468e91cbf4b7af64ed230d424d2c3b20963701f0916f6e1c29cea6fe26`.

The exact release passed an isolated real `chatgpt/gpt-6-luna` research run in
121,846 ms, with verified completion, no questions and a custom three-step plan
updated while running. Delivery repair requests retained 9 and 10 prior tool
results and the current review. Earlier candidate runs also completed. All real
runs used isolated stores and copied credentials without refreshing production
OAuth tokens or publishing test work to the user's conversations.

Public Playwright acceptance at 1134px and 390px passed six checks, without page
errors or attempted user-data mutations. A historical production task showed
completed execution steps instead of four pending placeholders. Before/after
profile/model/avatar digest:
`f0e9bfb1b824e2f020869fc086ebb7cc300c7d924e3b2eff3fd26864740029ff`.
Profile revisions stayed global 9 / conversation 0. The runtime pause and retained
operation counts matched before and after API replacement.

Published web entry: `index-d414e31bc4aaf04b559cc333dc6acc5c.js`, SHA-256
`68bec88dcf1d6e364b0e3e2c7f61481f08a3fcd63898e850ae91951011edd69a`.
Signed arm64 APK: 68,798,775 bytes, SHA-256
`4c77cd0048f749b0ccf9a7cde6defdef9e8315fc424acba90fd0a1bd13997668`.
The public APK and JavaScript hashes match the staged artifacts, and `/api/health`
returned success. Android API origin, production signing and upstream notices
were verified. Physical Android acceptance was not performed in this session.

Final complete test run: 1,378 passed, 0 failed (`suite-published.log`). TypeScript
checks passed for server and mobile. The 53 targeted routing/research/lifecycle tests
and nine composition checks passed. Mixed-capacity composition assertions now retain
source history while still exercising smaller fallbacks after a 503 when the actual
request fits. Formatting/lint checks have no errors; existing warning-level assertions
remain. Local browser acceptance passed 12 checks across both viewport sizes.
