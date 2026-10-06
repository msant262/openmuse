# Google Workspace: native operations and chat acceptance

## Scope and connected accounts

The native catalog contains 206 pinned official methods across Gmail, Calendar, Drive, Docs, Sheets and Slides. The catalog is discovered lazily; individual schemas and required branches are described on demand. This is not a claim of live acceptance of every method, administrative operation or Google product.

The original account `bcferrari23@gmail.com` remains connected and remains the default. The test account `msant262@gmail.com` is connected simultaneously and has the actual Gmail write/send, Calendar write and Drive write grants. Normal Connect/Add another account now requests the complete Workspace grant; the former read-only default was an application connector bug, corrected in `962ea02f`. Native operations select an account by email or connection ID and bind each prepared action to that exact connection.

The project's Drive, Docs, Sheets and Slides APIs were enabled through the user's authenticated Google Cloud preview, project `okamibot` / `423999114350`. API-disabled errors are distinguished from missing account scopes. No billing or IAM settings were changed. No passwords or tokens were requested in chat.

The configured agent model remains `chatgpt/gpt-6-luna`. Model settings and the original default account are preserved.

## Implementation and actual failures corrected

- Native Google writes share the existing durable action executor, account identity, dispatch barriers, operation IDs and provider receipts. Uncertain writes are never blindly repeated. Read failures remain definite read errors rather than becoming uncertain writes.
- Broad Docs/Sheets/Slides batch schemas stay compact; complete executable request examples retain the required `parameters`/`body` envelope. Truncated resource IDs fail before Google dispatch. A real Luna Docs run had previously confused an expanded schema branch with the body envelope and shortened an ID; its partial outcome is retained as diagnostic evidence, not counted as successful acceptance.
- Every native deletion, trash operation, clear operation and nested content-removal request requires a human decision, independently of the general money-only policy. Legacy calendar deletion also requires a human. Calendar deletion reads the actual event for the card and binds its ETag to Google's conditional delete. Approval cannot silently apply to a changed event. [Google's versioned-resource contract](https://developers.google.com/workspace/calendar/api/guides/version-resources) supports conditional deletion through `If-Match`.
- A real Gmail draft has an owner-scoped server record with frozen sender connection and content. The chat card displays sender, recipients, subject, body and Send, Copy, Delete and Save draft controls. Private MIME/attachment bytes never enter its public payload. Deletion prepares an approval instead of deleting immediately. Stable click IDs recover receipts without duplicate writes.
- Ordinary requests to write or reply to email prepare a real draft automatically. The person need not mention tools, a card or “do not send.” The live `prepare_email` path now composes a Gmail draft rather than treating preparation as automatic sending. Negated sending does not create a contradictory completion obligation.
- Actual chat execution exposed omitted optional draft fields. The harness now parses/defaults inputs at the runtime boundary, not just in its advertised schema. Another actual run exposed an internal operation ID exceeding the API's limit; that internal ID is now hashed without losing stable identity.
- The front previously rendered delegated tasks only for registered foreground tools. A native `save_gmail_draft` handoff was ignored, hiding the actual draft artifact. Delegated results are now recognized independently of tool name, so the task, draft and approval cards appear for native Google operations as well.

Implementation commits include `f0c948fa`, `b059b7a9`, `b4968903`, `962ea02f`, `d4a899e4`, `085d2e5e`, `d16343e4`, `e0752dc6` and `ad7d2ff1`, pushed to `main`. The final targeted groups passed 67 transport/executor/card/action tests and 33 cloud-write/verification/card tests (overlapping), with server/root/mobile type checks passing.

## Verification boundaries

Relevant integration/regression tests passed: the 93-test group for catalog, executor, Google transport, account routing, actions, cards and task verification; the updated catalog example group (10 tests); the ordinary-email regression group (27 tests); the copied-worker/native-draft group (14 tests); and the updated card/handoff group (4 tests). These groups overlap. Root/mobile type checking and server compilation passed.

The copied-worker regression makes an ordinary email request, runs `prepare_email`, creates exactly one Gmail draft against a simulated provider, attaches its native card and completes with the real draft receipt. This is automated harness integration evidence, not live Google or browser acceptance.

An initial live chat request explicitly mentioned showing the card and not sending. The user correctly rejected that induced test as acceptance. It is excluded. Its real execution still found bugs described above. The first ordinary live request recovered from the too-long internal operation ID and saved a real draft, but is also not counted as an error-free final acceptance run.

Final acceptance uses ordinary requests entered through a new conversation in the shared production browser, thread `53d0ad59-1224-430a-97ac-9ab440e44b5f`. No tool/card instruction is included in the accepted composition requests. Actual card controls and provider readback are checked independently of the model’s success sentence.

## Earlier direct live provider tests

These tests exercised the application's authenticated native executor against the real Google account. They are useful provider evidence, but do not replace chat acceptance. Their identified resources and readback receipts are private deployment artifacts.

| Flow | Confirmed Google result |
| --- | --- |
| Gmail search/read | Five matching inbox messages and metadata read |
| Gmail drafts | Create, read and update a real draft |
| Gmail sending | Test sent to `msant262@gmail.com`; actual SENT label and recipient verified |
| Gmail labels | Own test label create/apply/remove/delete, before the subsequent per-deletion approval requirement |
| Calendar | List four calendars; search, create, read, edit, find event and free/busy query |
| Calendar reminder | Popup reminder configured for five minutes before the own test event |
| Existing Drive/Docs | Find 100 native documents; read a real Doc (6,343 characters); export it as text |
| Existing Sheets/Slides | Read three sheet rows and an existing slide |
| Drive files | Create own folder, upload text, download verified content and upload an authorized artifact |
| Docs | Create, insert text, read it back, move to folder and export |
| Drive restore | Own test copy trashed/restored before the subsequent per-deletion approval requirement |
| Sheets | Create, write, read formula result `3`, append row, inspect and move to folder |
| Slides | Create, edit/read slide, retrieve page, export PDF and move to folder |

Reference test resources: event `qek4n2gqhr7gn337hi8rjohvkc`; folder `1PHy53eJaB2G3nYxpDw18ayIdAMIIMAgi`; Doc `1rOTLjLGhQLQBH-vlWoVeZyHaBPFWU93z2kuZ9nRDgZc`; Sheet `1WxYf_dgLv196f-FulsOEKWNm3PcGWAYIL94t0LFOjLY`; Slides `1z32qHMwSQdTbiwgLC7WWfmrOOp_L-PVuhpXAPvFvaig`; sent message `1a111b296f4ada52`.

The reminder configuration is confirmed; delivery of a phone notification has not been observed. SENT verification is distinct from recipient inbox delivery. No exhaustive live coverage of all 206 catalog methods is claimed. Resources from unsuccessful diagnostics are not silently deleted after the user's approval requirement.

## Final ordinary browser acceptance

The ordinary request “Escreve um e-mail ... agradecendo pela ajuda e confirmando que o aplicativo foi testado” completed in task `20b2504045781c5e1599a5de1f87012afc39dbf1fe025d3b5568ab41cab67c85` using `list_google_accounts` and `prepare_email`, with no operation errors. Its owner-scoped draft card is `6acf0271b2647a31f6a52e18ae32effa21c7f48a8d6dc42363f03f4c16657f4a`.

Actual browser interaction confirmed:

- Copy hides the body and controls immediately after copying. Save draft hides them after the real save completes. View draft reopens the contents.
- Delete prepares a visible approval with the account, subject, recipient and remote draft reference. The draft still existed in Google while approval was pending.
- The actual Deny UI handler was clicked. The action became denied, the approval collapsed, and provider readback confirmed the draft remained (`r340246111718869072`). No deletion occurred in this accepted denial test.
- After reopening, Send was clicked. The card became Sent and collapsed. Google message `1a111df6eccabd88` has the actual SENT and INBOX labels and recipient `msant262@gmail.com`.
- Handled cards survive reload as summaries. The Actions tab was opened in the live desktop layout and from the compact chat card. It lists summaries and opens the selected full record; full email bodies are not included in the paginated history response.

Live UI checks exposed stale history after a decision. The tab now reloads its bounded summary page when action IDs/statuses change. Unknown operation names no longer leak raw API method IDs into the primary UI.

A Calendar request explicitly asking for 15:00 UTC was sent as `2026-10-07T15:00:00Z`; Google returned `17:00:00+02:00`, the same instant. This was not an incorrect write. Reviews now format the instant in its named timezone and display that timezone. Another ordinary request without a zone read the selected calendar’s `Europe/Berlin` timezone and created 15:00 local time. It correctly reported partial delivery because the old `prepare_event` schema did not support the requested reminder. The simple event tool now carries optional validated reminders through the write and confirmed response, and respects the selected account.

An ordinary three-file request created and wrote the actual Doc `1zsDfpyDQeCx1KHFBPfJ2NI-tk0gU22JDLiv0r3Dlj28`, Sheet `1U7k0oW6pA4FF4o92NBDXhevAQRvM7u9qzh4U_Mbtwag` and Slides `1mLynW7sq8URCtwnUWkrlqgF6XnXO1goSuSDphl4rEXk` through six successful native operations. Independent Google readback confirmed the requested document sentence, the sheet’s calculated total 30, the one-slide presentation showing 30, and all three Drive files. The task incorrectly failed its fallback observation criterion; the final correction uses a confirmed native Google write receipt for cloud writing, with explicit requested-content requirements retained. It does not treat an unrelated provider write as proof.

Earlier failed/partial diagnostic tasks retain their actual outcomes and are not presented as error-free acceptance. The final Calendar and cloud-writing checks after the correction are recorded below.

## Distribution and recovery

Web/API and signed ARM64 APK are published through the existing production release scripts. API replacement uses maintenance, no active work, confirmed graceful shutdown and a PGlite backup after its sole writer closes. Prior releases/images remain available for rollback; production environment values and copied OpenClaw upstream pin `b56ae70a5e7e302dc2165c96b60214e84e19c7b1` remain unchanged.

The UI/card release `d4a899e4` was followed by `085d2e5e`, `d16343e4`, `e0752dc6` and the final code release `ad7d2ff1`. The final web/API/APK receipt is recorded below. The project signing certificate and Firebase configuration remain intact. Physical-phone acceptance is not claimed.

Private receipts are under `/root/okami-deployment/workspace-google-20261006/`, `workspace-google-connect-20261006/`, `workspace-google-chat-20261006/`, `workspace-google-email-20261006/` and `workspace-google-natural-20261006/`; corresponding local build artifacts are ignored. Diagnostic credentials remain private and are revoked after final testing.

## Autonomous recovery and concrete requests for input

The reported generic question was a real `search_mail` timeout incorrectly classified as an effect. That produced an uncertain-write barrier and a free-text question containing the internal English reconciliation exception. Legacy Gmail/Calendar reads now use read classification throughout dispatch and verification; definite read failures are retryable reads. Maintenance supersedes the obsolete question and queues only proven Google reads, preserving the original failed receipt and error. It never releases or repeats an uncertain write. Unknown writes instead show a concrete paused status with the task/account and explain that no text response is needed. Necessary human questions require a clear missing fact/decision, purpose and expected answer; default form labels use that question instead of “Your answer.”

A second actual interruption had checkpointed the accepted provider stream but omitted scheduling. Transient stream/network/provider timeouts now carry a retry time and original failure code. The worker resumes its saved continuation; permanent credential/quota failures remain unscheduled. Maintenance also schedules older accepted interruption records, including records whose `nextRunAt` field is absent rather than explicitly null. The absent-field regression failed before the final fix and passed afterward. The old search task was subsequently removed and returns 404, so its final live automatic completion is not claimed.

Google tasks now expose a small request-selected native tool surface directly: account listing, Workspace discovery/schema/execution and relevant email/calendar helpers. The 206 individual provider methods remain lazy. A real AG-UI client regression also reproduced a duplicate RUN_STARTED event when connecting before its durable counterpart; reconnect now emits each start once and closes the actual open run before another start.

Commits `3b97e538`, `5f747c1f` and `982a67f6` are pushed to `main`. Targeted verification passed 73 Google/completion/provider/interactions tests, three context/restart tests, and the expanded absent/null scheduling regression. The 47-test read/verification/AG-UI group also passed; groups overlap. Root/mobile type checking and server compilation passed. Formatting checks pass with pre-existing non-null/any warnings retained.

A new ordinary request in production conversation `7a8539ff-6065-45cc-8b2b-7f444879bdf1`, task `1ffbebaf5786ab18ef0f9ef6e446fbbb483e19f28c2116a1d100b3bb2f609755`, asked for a Google Doc with quoted literal text. It completed with six successful native discovery/write/read operations and no operation errors, using the configured Luna. Actual Doc `1j09jf3Q9JrdgWFu8Zd2iwYqEnG25sSKp0W4ZjP-_Q7E` contains “Documento criado e salvo pelo aplicativo.” Provider readback used read-only requests; there was no manual external repair.

The ordinary calendar task `cfee2aaf663e2930d555bec71512c37aa88a779ed1d0ffab4721a7ad8b83a4bb` created event `6juc6pg9gvnqmo1le91jm4a71c`. Independent readback confirms 2026-10-07 15:00–15:15 in Europe/Berlin and an explicit popup reminder five minutes before. This confirms the saved time and reminder configuration, not delivery of a phone alert.

The first API candidate `3b97e538` was automatically rolled back when the release guard treated the legitimate read recovery (29 pending operations becoming 28) as an unexpected count change. The database's failed read receipt and superseded input were preserved. The subsequent API `5f747c1f` deployed safely. The final release uses strict operation/resource invariants now that the legacy read has been recovered; no deployment bypass or environment change was required.

The scheduling-correction production API is `982a67f64490ac9a11d1e6851448e3f690ad3461`, image `sha256:20ec1a536b5a0b2add3c9221a63cd2449536a29089d2c14c35c3af0b61c27bfb`. The release finished with maintenance closed, no active tasks/conversations/admissions/native deliveries, zero held resources, and the preserved 28 historical pending operations. The user's global pause remains false at revision 16 and the environment SHA remains `e566527a9433b5fdc64aa31bf3ceb701aee4a11b00a41ce14aa879865d223981`.

Web and signed ARM64 APK remain the validated `ad7d2ff1` UI release, since the later fixes are server behavior and a nullable TypeScript scheduling field. Web bundle `_expo/static/js/web/index-46ddedd2f454646a9a12b32fb99f0280.js`, HTML SHA `d715200ea4339b072065640327d8e5b12e43fe435a180c4af618e7c4df45885e`. Public APK `https://app.okamibot.cloud/downloads/okamibot.apk?v=ad7d2ff1`, 67,188,709 bytes, SHA `b2b3c38ecb81d7ca5fcfc317b5084d1f2dffb2497021eab3ec0ca5d28ec9e64e`, signing certificate `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`. The public download/hash and Firebase configuration were checked during that publication; physical-device acceptance remains unobserved.

The final account/model baseline again confirms both original connections, original default `bcferrari23@gmail.com`, actual write grants for `msant262@gmail.com`, and unchanged `chatgpt/gpt-6-luna` preferences. No new Google authorization or user-supplied runtime answer was necessary.

A fresh ordinary combined search in the same production conversation completed in task `23fdfa05cf1d07ca33dab7a35b737584a3c4758f2d49a60089a9f320b892d879`. It found the real “Okami revisão de email” message, the final Doc in Drive, and the saved event, reporting 15:00–15:15 Europe/Berlin. No free-text answer, retry click, manual task wake or external data repair was used. Native operation details and final deletion-denial evidence are recorded in private chat receipts.

The combined search completed through eight successful native Google discovery/read operations, without operation errors. The Calendar deletion request in the same conversation, task `2870059ea8a1a3577f118ddab976c1d55d112464372c60b6c9028bf6103d88ea`, prepared human review action `0435ed9f0e7e09ad877f8688ee8d20ab5a83cc250dfe7152d2b1dc3e16ba7009`. The card showed the actual account, event title/ID, 15:00–15:15 Europe/Berlin and an explicit deletion notice, with technical data collapsed. Readback confirmed the event remained while review was pending. A preview pointer-click did not dispatch the denial; the actual unique button's DOM click handler did. Provider readback then confirmed the action denied, no deletion dispatch and the event still confirmed. This proves the application handler and provider boundary; it does not claim reliable pointer hit-testing in the automation transport.

The handled Calendar approval disappeared from the conversation and was available as a Declined summary in Actions. Opening that row and choosing View details showed the formatted account/event/time and no approval controls. A real denial also exposed an internal English failure message after the task resumed. Commit `c84b7840` treats the human's denial as cancellation with concrete localized feedback naming the item/account, preserving prior receipts and reporting that this action was not executed. It publishes that feedback through the normal chat delivery without a task-error attention notice or a new free-text question. Two worker/publication tests cover Portuguese and English. The final 39-test completion/Google/AG-UI group passes, as do root/mobile type checks and server compilation.

The decision-feedback API release is `c84b78408b362c4d5d383001403e8b28ca4c9af0`, image `sha256:4c0fdd3e00f2899de40f014f49f66a32612b160bdd22cf81bda2ca7d7e981bd0`. Its guarded publication again preserved the environment, pause revision and resource/operation records. Web/APK remain the `ad7d2ff1` UI release.

Final ordinary Calendar acceptance after that publication used new conversation `63d5f8e9-bada-42b1-b719-212474bba014`, task `b9ca7d28c9593ed53ce45ec8b29b0dce988ed235451f48f468f6e79a10e863a7` and action `cf0cfc4c6ca36b756a89b531cd43f9e076ee746edcd22be3cbb9a5505b859d83`. The app prepared the actual event review automatically from the ordinary deletion request. Pending readback confirmed no deletion. The focused preview Deny pointer-click succeeded in this new conversation; no DOM fallback or direct decision API call was used in the final run. The task became cancelled and chat published: “Você recusou a ação para ‘Okami agenda verificada’ na conta msant262@gmail.com. Essa ação não foi executada.” The card disappeared from the conversation and the action remained denied. Google confirmed that the event remains saved, with no delete dispatch. The earlier pointer limitation is retained above rather than erased.

Final API/browser health checks pass; source/image, environment and pause match the release receipt, maintenance is closed, and task/conversation/admission/native-delivery/held-resource counts are zero. The original 28 historical operation records remain; these are not counted as 28 active tasks or claimed newly successful work. Account/model checks again pass, preserving both account connections, original default and Luna. The temporary diagnostic device is revoked and its private session file removed at the end of testing; neither Google OAuth connection is revoked. Test resources are preserved after declined deletion, and no manual external repair was used.

UI evidence includes the final pending Calendar card `/home/marcos/.t3-nightly/userdata/browser-artifacts/browser-screenshot-app-okamibot-cloud-muwwe3ey-745c3194.png` and the final localized cancelled result `/home/marcos/.t3-nightly/userdata/browser-artifacts/browser-screenshot-app-okamibot-cloud-muwwfdfg-f31a8c42.png`. Email decision/Actions evidence is retained in the private earlier chat artifacts and screenshots referenced by deployment records. Public report content contains no access tokens, session credentials or private MIME payloads.
