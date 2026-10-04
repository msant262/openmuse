# Memory, procedural learning and heartbeat acceptance — 4 October 2026

## Reference and scope

The previous interface session had finished at `3e1f3ac` / `f32997f`. Its transcript
was read as historical context and left untouched. This change addresses automatic
personal memory, reusable lessons and proactive follow-up requested afterward.

Hermes reference: `158fd638da1629c8e62caf9ade1515d162def8ab`, particularly
`agent/background_review.py`, `agent/prompt_builder.py` and the memory tools.
The memory-review, lesson-shape and exclusion policy blocks are copied verbatim,
with MIT attribution in `third_party/hermes-learning`. Its detached bounded review,
separate declarative facts and procedures, update-before-duplicate policy,
read-before-update and successful-write accounting are adapted to existing tools.

OpenClaw reference: `da979df299e88c3711f6ee2cd3c7443dd045584b`, memory-flush lifecycle
and heartbeat runner. Durable unreviewed source records survive context trimming;
periodic reviews coalesce, use current evidence and record quiet/partial outcomes.
The application retains its existing database, owner isolation, task worker,
revision history, source suppression and suggestion journal. It does not embed
another agent runtime or maintain a second Markdown memory store.

## Resulting behavior

- A low-priority review considers finished user turns and verified task outcomes.
  Foreground conversation preempts it. Small talk, one-off requests, fictional
  examples, credentials and unverified methods are excluded by the review policy.
- Personal facts, explicit habits, preferences and open plans carry authenticated
  source quotations. Newer corrections change the existing revision; cancelled or
  resolved plans retire their pending suggestions. Forgotten evidence is suppressed.
- Useful procedures come from verified work and successful tool receipts. Existing
  learned procedures can be consolidated; user-owned procedures are protected.
  Fresh conversations receive a bounded procedure index and can read the method.
- Memory context includes a bounded baseline so a differently worded question can
  recall personal context. It does not depend solely on literal query substrings.
- Heartbeat considers due plans, unfinished work, important mail and near-term
  calendar events. The configured model selects source-backed candidates, with
  no external action tools. Current source versions are checked before acting.
- Settings expose cadence, last/next review, source coverage and review-now.
  Memory exposes learning status, revision history and source quotations.

## Failures found and corrected

1. A model used the wrong memory UUID and then claimed the review was complete.
   Failed writes now remain pending; tools execute in order and finish refuses an
   unresolved write. Counts come from successful journal receipts.
2. Historical evidence was compared against write time rather than source time.
   Older backfill can no longer override a later user correction.
3. The original combined adapter could treat “no personal facts” as completion
   before considering verified procedures. The prompt now asks for both decisions
   independently and retains the no-change reason.
4. Cold connected acceptance exceeded the hybrid API's former 1 GiB ceiling once.
   The overlay now uses the existing base budget of 1.25 GiB. Connected acceptance
   completes in that limit; deployment resource-budget tests pass.
5. Production verification exposed an unsupported automatic preference: the
   reviewer copied assistant-personality settings and cited an unrelated thank-you.
   The record was retired through the normal revisioned forgetting API, retaining
   history and suppression. Assistant personality is now excluded from review
   evidence. A regression verifies the boundary, and connected acceptance includes
   a persona-rich account with only an ordinary PDF request: it must save nothing.
6. After removing persona context, one connected run wrote correct English memory
   text. Its Portuguese-only test regex failed. Acceptance now recognizes both
   languages and also requires the correct evidence IDs and exactly three useful
   initial entries. The failing receipt is retained; this was an assertion issue.

7. Automatic learning now passes known plan deadlines into the existing memory
   validity field. An expired plan leaves active recall and its pending suggestion
   becomes obsolete without requiring a cancellation message. Relative dates are
   anchored to source time. Undated plans are not assigned invented expiry dates.

## Verification evidence

Local evidence is under `artifacts/memory-heartbeat/` (not committed). Production
captures are private local files; temporary verification pairings are revoked.
No synthetic facts, mail or travel plans were inserted into the production account.

- Full suite: 1,225 passed, zero failures (`full-tests-final.log`). The final
  learning changes were then covered by 17 passing focused tests, including the
  additional quiet-review receipt and persona-boundary regressions.
- Final TypeScript checks pass. Full lint had no errors, 253 warnings and four
  informational findings; it is not warning-free. Final changed-file lint has no
  errors. Server build and five deployment-budget tests pass.
- Connected acceptance uses the configured `chatgpt/gpt-6-luna`, an isolated
  database and copied credentials with OAuth refresh prohibited. Mail is a fixture
  only at the external-source boundary; classification uses the real model.
- Nine scenarios cover automatic facts/preferences/habits/plans, noise and fiction
  exclusion, fresh-chat recall, due-trip initiative, same-plan cancellation and
  reminder retirement, important non-reply mail versus newsletters, forgotten
  provenance, learned-procedure retrieval, and a quiet persona-rich account.
- Browser acceptance covers desktop/mobile layouts, source coverage, cadence
  persistence and memory provenance without runtime errors.
- Signed x86 Android acceptance uses an isolated local API. Upgrade retains theme;
  cadence persists and memory quotations are visible. ARM64 release signature and
  embedded public API URL are verified. No physical-device claim is made.
- Public browser checks verify enabled learning, heartbeat settings, disconnected
  mail, mobile layout and exact signed APK bytes without writing personal settings.

## Deployment

Web and ARM64 APK: `8e5eec0c363c86733bce5129725b2e02aedf5686`.
API: `6760f5e`, including the persona-boundary correction and dated-plan expiry.

- Public application: https://app.okamibot.cloud
- APK: https://app.okamibot.cloud/downloads/okamibot.apk?v=8e5eec0
- APK size: 58,983,769 bytes.
- APK SHA-256: `1f36b8e18696453426bbb2274eddafef14f2c5ac1b3e1d962642dbaf2f570435`.
- Signing certificate is unchanged:
  `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`.

API replacement uses the maintenance admission fence, retaining both existing
human-control leases. Profile, saved companion and global-pause revision are
unchanged. The native supervisor reconnects through its ordinary service restart.
Previous API images, web assets, APK and routing configuration remain available.
The final API image is
`sha256:c3e9bc6ab0de660c840e59a88d83938a3d74c0959a64c4e6587d0bb958856d67`;
Docker reports healthy, no OOM kill and a 1,342,177,280-byte memory ceiling.

Production backfill completed four review batches. It retained one verified PDF
procedure. The unsupported automatic personal entry described above is forgotten,
not active. No new personal facts were manufactured to make the memory count rise.
A production heartbeat completed at 12:19:16 UTC with a quiet result and current
memory coverage. Task coverage remains explicitly paginated; mail and calendar
are disconnected. The next scheduled review is 16:19:16 UTC at the retained
four-hour cadence. Learning has no pending review or error, the worker is running,
and global pause remains off at revision 16.

Mail and calendar are disconnected in this account: native Google, Composio and
MCP checks found no active source. The heartbeat cannot inspect real email until
an account is connected. Connected mail behavior is demonstrated with isolated
source fixtures, not represented as a live inbox read. Model selection remains
probabilistic; quotations, revisions, receipts, current-source checks and visible
history make its decisions inspectable rather than guaranteeing perfect inference.
