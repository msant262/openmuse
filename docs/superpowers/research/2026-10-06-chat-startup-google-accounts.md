# Recent chat startup, concurrent Google accounts and compact alerts

Published implementation: `b75ce93f622ecea74f02cc6304cd3daf48886e67`, following `6a699c1b` and `de4f85df`. All implementation commits were pushed to `main`.

## Causes and changes

Reconnect previously replayed historical runs and their text deltas before restoring the full transcript. Polling repeatedly read complete run history. The client replayed the conversation journal from cursor zero, cached the complete transcript, rendered every message and mounted previously visited conversations in hidden screens.

Reconnect now restores the latest 50 display messages in one canonical snapshot, with incremental events only for current work. Completed historical text is not animated again. The journal starts from its latest checkpoint, returns bounded summaries and retains its head cursor. Cache writes are bounded and coalesced, preserving offline messages and drafts. Older messages load through backward pagination. The selected conversation alone mounts, using a virtualized list. Social metadata is queried only for messages explicitly loaded in that screen, with bounded requests and SQL filtering. Full stored history and the executor's model context remain available; the display page is not a model context limit.

Google OAuth previously used a single credential slot. The updated store keeps multiple independently encrypted accounts, an optional default and explicit email/connection-ID selection. All sign-in paths preserve other accounts, including callers without the new add-account flag. Reauthorization updates the matching email instead of replacing another account. Disconnect affects the selected account. OAuth generations fence stale callbacks; refresh and reviewed email execution retain the selected account's identity. Mail caches distinguish identical provider IDs in separate accounts.

The failed production task consulted only `list_site_connections`. That broker listed native OAuth rows as if they were browser credentials, even though their shapes and authorization mechanisms differ. A fresh native Gmail read succeeded before deployment. Browser credentials now expose only their own metadata. Native Google account metadata reaches chat and worker prompts, and `list_google_accounts` stays visible in the actual copied OpenClaw executor. Gmail search and thread-reading tools remain discoverable through its native catalog. No browser password or model-visible OAuth token is needed for an already connected account.

Proactive reminders now occupy one 44-pixel bar. Opening it shows collapsed alert titles; selecting one mounts its reason, evidence and controls. Confirmed responses update the pending list immediately, and stale polling cannot resurrect a resolved revision. Resolved, suppressed, accepted and snoozed reminders leave the chat. Their history remains under Notifications, collapsed until selected.

## Verification

- Startup regression: 230 messages over four completed runs restore only the latest 50, emit fewer than 10 initial events and no historical text deltas. Backward pages recover all 230; storage and full history are retained. Journal startup excludes historical text/tool payloads and begins at the saved head.
- OAuth integration verifies concurrent personal/work accounts, separate scopes, exact account tokens, duplicate-email reauthorization, disconnect isolation, owner isolation and reviewed sender identity across default changes.
- New mounted UI tests verify the compact bar, lazy detail rendering, immediate resolution and stale-revision handling. Existing durable responses still preserve idempotency and uncertain acknowledgments.
- Relevant new and regression groups passed: 41 Google/discovery/credential/proactivity tests; 59 native harness, conversation, credential, startup and outbox tests; 13 startup/social/Gmail tests; and 9 alert/submission tests. Groups overlap. Root/mobile type checking, server compilation, web export and signed Android build passed. No entire-repository test-suite claim is made.
- The published app was reopened at a 390 × 844 viewport. In the measured warm reload, all 23 messages and the latest response were present at 416 ms after navigation. The initial journal request used `latest=true&summary=true`; the sole chat connection completed in 34 ms. Message rendering occurs in list batches; this is not replay of old model output. These timings describe this browser, cache and conversation, not a physical-phone benchmark.
- A draft survived switching away and back; the diagnostic draft was subsequently cleared. Only the selected thread continued conversation polling. The viewport and document widths both stayed at 390 pixels. The alert bar measured 44 × 358 pixels; its panel stayed within 390 pixels. The resolved Google security alert was absent from chat and present as a collapsed entry in Notifications.
- The Gmail account panel exposed “Add another Google account”, account-specific disconnect and permission controls. Actual additional Google sign-ins were not performed; concurrent accounts were verified against simulated OAuth/provider responses.
- A production task using the configured `chatgpt/gpt-6-luna` successfully called `list_google_accounts`, `search_mail`, `read_tool_output` and `finish_task`, reporting 20 inbox matches. This test authorized reads only. The diagnostic task was removed and its temporary native device revoked. The existing Google connection, model preferences and user pause revision 16 were preserved.

The real account currently grants Gmail read-only access. The production diagnostic establishes account discovery and mail reads, not mailbox cleanup, email sending or Calendar writes. Android emulator startup failed in the environment; the APK is signed and inspected, but physical-device acceptance has not been performed.

## Distribution

API image: `sha256:b52e254171c3a3d6435083daf2a4ebbc8a054e0815621a907a98a4a2aae7aa26`. The copied OpenClaw harness remains at `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`. API data was backed up after confirmed graceful shutdown of its sole PGlite writer. Deployment maintenance was finished; API/browser health recovered, with zero running tasks/conversations/admissions, the original 27 historical operation records and no held resources. The prior image and data backup are retained.

Web: `https://app.okamibot.cloud/`, release `/opt/okami-web/releases/chat-startup-google-20261006-b75ce93f`. Both public and origin HTML/bundle hashes were verified; API/executor handlers were preserved.

- Bundle: `_expo/static/js/web/index-f57747440ed127e82dee73ec9b4d9bb8.js`.
- HTML SHA-256: `41f31e56c9fd670031f39a47893ad282d44e44de660c0595a8a664ddc325e75d`.
- Bundle SHA-256: `88a376147bcafb93c9766cf93525f30ad23a74a97f75b7e489a16aebe97fe228`.

Android: `https://app.okamibot.cloud/downloads/okamibot.apk`, 67,164,133 bytes, ARM64 release, embedded public API and Firebase push configuration verified. The existing project certificate is preserved: `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`. APK SHA-256: `f71dedf0c9b6a038762018addff3faa634f7db00bf8499273d4ce514f23894b1`, confirmed by downloading the public canonical URL. A newly staged versioned URL returned a cached CDN 404; it is not the advertised download. Build metadata's dirty flag reflects the unrelated untracked `.orca/` directory; tracked implementation source was clean.

Ignored validation, signed artifacts and deployment receipts: `artifacts/chat-startup-google-20261006/`. Session credentials remained private on the server and were not copied into source or receipts.
