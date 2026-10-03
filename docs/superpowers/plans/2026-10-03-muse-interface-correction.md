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
