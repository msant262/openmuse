# Conversation continuity, progress, previews and native control

The resumed session started with uncommitted harness/UI fixes and failed live
acceptance. Production was still API `595b764`, web/APK `b82d434`. The original
provider transcript was read as historical context and left unchanged.

## Changes

- Delegated work retains the original user request, completed conversation turns,
  preceding results and observed sources. Corrections go to the existing task.
  OpenClaw history bounds and Hermes argument repair/todo handling are adapted
  with source pins and MIT notices in `third_party/HARNESS-CONTINUITY.md`.
- The chat handoff uses a closed objective schema with acknowledgment and reaction
  choices. Internal arbitrary task payloads remain in the service API. The live
  ChatGPT model accepted the handoff and reaction in one inference.
- Tasks persist completed/current plan steps and show animated activity. Research
  review includes every region's observations, reviews image deliverables, and can
  recover using sources from earlier work. Recovery call IDs are deterministic and
  fit the provider's 64-character limit, including when task IDs are already hashes.
  Once the requested facts are collected, delivery repair retains artifact creation
  and inspection tools so a rejected image/document can actually be corrected.
- Public JSON reads support compressed responses, structured selection and paging.
  A truncated response is explicitly identified and can be followed with bounded
  field selection. Public URL/DNS checks remain on every fetch.
- Server-authored PPTX/DOCX files get an owner-scoped cached PDF preview after
  verifying the original authoring hash. The reader navigates all rendered pages.
- Native control tolerates a closed browser tab while preserving failures on a live
  tab. A restarted browser worker receives the last control revision. Headed
  Chromium opens its replacement tab before closing its last startup window, and
  a session whose window was closed can be opened again.

## Validation

- Node suite: **1,370 passed, zero failures**, including mobile tests.
  `artifacts/harness-continuity/suite-verified.log`.
- Server/mobile and worker TypeScript checks passed. Native Python suite:
  **93 passed**. After the final artifact-repair and browser-reopen changes,
  **39 targeted regressions passed**, including research delivery, context,
  handoff, task recovery, content verification and desktop input/authority.
- Browser acceptance at widths 1134 and 390 verified current/completed plan steps
  and PPTX page 1 → 2. Screenshots and receipts are in
  `artifacts/harness-continuity/ui-check.json` and adjacent PNGs.
- Production native API acceptance opened Example Domain, acquired human control,
  delivered Alt+F4, renewed the grant and returned control to the agent. Native
  epoch 30, session generation `5609e1aa-17ca-4e0c-b7bd-913362444a5c`.
  Browser restart and reopening after a human closed the window also passed:
  `desktop-browser-restart-accepted.log` and `desktop-browser-reopen-accepted.log`.
  After the API release, observation, take-control, heartbeat and release passed
  again (`desktop-after-release.log`, final control revision 14).
- Android release APK built locally, signature and embedded production URL verified.
  SHA-256 `27661a6dd859530d24e8cfd4d58e3271988e747e6592ab9b4c9efe3f80397e07`.
  No physical Android-device acceptance was performed.

## Real-model result and limits

An isolated production candidate used the preserved user profile, selected model
(`chatgpt/gpt-6-luna`), 117 conversation messages and previous research results.
The original infographic request created one task and an assistant reaction in one
inference (21.166 seconds). A subsequent direction reached the same task mailbox.
The worker read the BBC results JSON for all 27 UFs, retained the requested year,
and asked no user questions. It generated and revised the infographic using those
observations, correcting both the aggregate UF count and source attribution.
The task completed in 592.688 seconds with the delivery review accepted.
This establishes successful research and infographic delivery, not instant replies.

The final image has all 27 rows and the observed percentages, with exterior results
separate and source/time/partial-result labeling. A deterministic check of the
receipts confirmed coverage and the 15/12 UF count. The output uses regional tables;
it did **not** satisfy the extra geographic-map direction introduced in the smoke
test. The semantic reviewer accepted it despite that format mismatch. Geographic
map compliance remains a known limitation; this run must not be cited as passing
that assertion. Evidence and the inspected final image are under
`artifacts/harness-continuity/live-accepted/`.

## Native recovery and rollout status

Only the native browser JS/source and desktop broker were patched on the Lenovo.
Backups are under `/root/okami-deployment/harness-browser-before`. The old desktop
service and browser process were confirmed exited, and their replacement generation
was checked through the broker. Four old graphical receipts received cleanup-only
updates through the native Journal API; their outcomes remain `outcome_unknown`.
The audit retains both versions. The subsequent ordinary reset reconciled the
remaining browser receipt. At prepublication inspection, work admissions, held
resources and pending native deliveries were zero. Twelve historical unresolved
operation records remain; no successful effect was fabricated or replayed.

API release `4b9ac42535633eefeaa30c9f690c238fb5c5194c` overlays the scoped server
changes onto production `595b764`, avoiding unrelated memory/compaction changes
in the workspace HEAD. It was activated on 2026-10-05, together with web release
`4b9ac42-public` and the signed APK. Deployment preserved the pause state, historical
operations and desktop session, and left no maintenance gate active. The native
worker JS hash is `75ebcf6b75fcf7f5fa3e0f9b26458c9124f0a75560ab2c399b9eff864084cac5`.

Public browser checks passed at widths 740 and 390 for Reply and the reaction
picker, with no page errors or unintended writes. Profile/model/avatar digests
before and after were identical:
`f0e9bfb1b824e2f020869fc086ebb7cc300c7d924e3b2eff3fd26864740029ff`.
The release scripts retain previous images, web assets, Serve configuration and
native source backups for rollback. Receipts are in `deploy-api.log`,
`activate-web.log`, `public-acceptance.json` and `public-download-check.json` under
`artifacts/harness-continuity/`.
