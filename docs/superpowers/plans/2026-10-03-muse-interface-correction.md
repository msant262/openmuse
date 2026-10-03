# Muse interface correction — 3 October 2026

The owner explicitly approved the plush companions and their creation quality. The interface was rejected: screens, menus and dialogs must closely follow the actual Muse product. This correction preserves the approved artwork, generation pipeline, saved characters, account state and animation behavior.

## Reference and implementation

The [reference audit](../research/2026-10-03-muse-interface-reference.md) separates observed screens from inferred adaptations. It includes actual light desktop settings/library screenshots, official mobile footage and the independent desktop walkthrough. Reference media remains outside the product.

| Surface | Correction |
| --- | --- |
| Settings | Centered 760×570 desktop window, 212px category column, grouped controls; mobile category list/detail with back navigation. Accessible close, Escape and outside dismissal. |
| Customization | Dedicated companion dialog with appearance/personality tabs, existing four-candidate creator and saved gallery. This dialog is an app adaptation; the observed Muse creation flow occurs in chat. |
| Navigation/chat | Narrow rail with companion, Search and five destinations; bottom menu. Mobile floating companion and separate floating composer/navigation. Collapsed desktop retains the small central companion. |
| Message menu | Undimmed selected message and Reply/Copy/Share menu. Reply retains annotation behavior; copy/share use actual message text and report failures. |
| Feed | Editorial rows built from real tasks, notifications and artifacts, with Discuss/details. No fabricated news or decorative activity. |
| Ideas/Goals | Categorized rows and bundled dimensional illustrations, green Tracking/blue Goals, expandable milestones and dated task history. |
| Library | Desktop category sidebar, search and real document/image previews with grid/list. Mobile Artifacts/Media and compact rows. No invented document covers. |
| Task detail | Selectable event/step lineage beside summary/results, independent scrolling; mobile stack. Approval, input, retry, stop, timing, budget and evidence controls remain accessible. |
| Utilities | Compact connector groups, viewer-focused document/browser dialogs and persistent action footers. Computer tabs fit narrow screens. |
| Agent panel | Full-screen mobile panel with compact portrait and four icon tabs; activity, approvals and queued tasks use actual saved state. |

The existing provider boundaries and mounted chat instances remain intact to preserve drafts, outbox state and streaming. There are no backend schema/provider changes in this correction. Fluent Emoji illustrations are bundled with Microsoft's MIT notice; no runtime font/network dependency is required for those images.

## Validation

Desktop and mobile captures live in `artifacts/muse-interface/verification/`. Local sample tasks, goals, a monitor and documents exercise populated states through the normal API; none of these fixtures were written to production. Browser verification covers settings geometry, Escape/draft preservation, companion state playback, responsive navigation, agent panel, message actions, real PDF previews, locale changes and overflow. Focused behavioral tests cover feed ordering/coalescing, library file identity/filtering, thread/session races, outbox, media and viewer takeover/pixel continuity.

Final build pins, test outcomes, Android acceptance and publication receipts are recorded with the release after verification. Screenshots establish the reviewed visual implementation, not a claim of exact pixel equivalence or the owner's acceptance. Dark theme, Meta-specific account/billing controls and a full conversational avatar-creation tool are not inferred from screenshot similarity.

Pre-publication verification passed 139/139 UI/mobile behavioral tests, including the real Playwright desktop-viewer regression. An additional focused avatar/language/viewer run passed 22/22 (overlaps the broader set). Root/server and mobile TypeScript passed. Biome checked 508 files with zero errors; warnings were not treated as absence of findings. Root browser receipt `root-ui-checks.json` confirms the measured settings bounds, preserved draft after Escape, exactly one compact desktop companion, a 390×844 full-screen mobile panel, locale/navigation checks without horizontal overflow and zero page errors. Tests were updated where the deliberate message-menu design changed their component harness; their real quote/copy/share and locale-race assertions remain.

## Final source and web publication

Implementation commits: `2161986` and `f4eec06`; both signed Android builds and the web export use clean source `f4eec06317fc06d28278645e5d9fea00a69963e2`. The final composer fix was exercised in the browser after the integrated suite: clearing a long draft restores the empty 44px input. No files changed in the companion assets, media renderer, server or domain packages.

Web is published at `https://app.okamibot.cloud`, served from `/opt/okami-web/releases/f4eec06-public`. Previous releases remain available for rollback. The API stays on `openmuse-server:product-32a1ae5`; no API restart, generation or identity update was performed. The public JS bundle matches the local SHA256 `ffa4466701dbc97b73c6556c94b2df93913a513bd17423006ac39308d8c507f2`. Public health is 200, unauthenticated API 401 and executor/deployment paths 404.

The authenticated public browser smoke verified desktop settings bounds (760×570), connectors, existing companion playback, library and mobile settings/overflow, with zero page errors. Only session operations and normal conversation reconnect POSTs occurred; no content/profile/selection mutations were sent. All temporary browser pairings were revoked. Receipts: `artifacts/muse-interface/web-build.json`, `public-web-checks.json` and `verification/public-ui-checks.json`. The side-by-side gallery is `artifacts/muse-interface/comparison.html`.

## Android artifacts

Both APKs are release builds from clean `f4eec06`, using the existing production signer SHA256 `e6d8e6aeb25f3c1603efd369b9898dbb865343f4148a1969cd85383331053f8a`, verified public API URL and unchanged application ID.

- ARM64: 58,889,561 bytes, SHA256 `0d84d1e4ddf8fd1d526af8f8ece8d77772ecdd1a0ad7d6b80fa8f9f6f55076c8`.
- x86_64: 60,638,496 bytes, SHA256 `534a43f1664d764724cc1ca9045685c1a0cf30ceac43fc41d424b4f60a6d0000`.

Artifacts and native evidence live in `artifacts/android/muse-interface-release/`. Root independently checked the local APK hashes, ARM64 signer and the uploaded ARM64 bytes on the VPS.

The ARM64 public route now serves `/opt/okami-web/downloads/okamibot-f4eec06-arm64-v8a.apk`. A complete download from `https://app.okamibot.cloud/downloads/okamibot.apk?v=f4eec06` returned 200 and exactly matched the signed local bytes and SHA256. Receipt: `artifacts/muse-interface/public-apk-checks.json`.

Native API 34 acceptance used an in-place x86_64 upgrade against the public workspace. Pairing and the unsent draft survived. Settings sections/General/Connectors, Android Back, full-screen agent panel, approvals, appearance/personality tabs, Feed, Ideas, Goals, Library with an existing file, and a real task detail were observed. Account changes made concurrently from another session propagated; the test did not restore an older identity or avatar. PT-BR was checked in the browser; a dedicated native PT-BR pass was not completed. No physical phone test was performed.

The temporary native draft was removed. Emulator language/network/animation settings match their baseline, and the final filtered fatal/error logcat contains zero lines. Local web/API preview processes and review browsers were closed after verification. Cleanup evidence: `artifacts/android/muse-interface-release/evidence/local-cleanup.json`.
