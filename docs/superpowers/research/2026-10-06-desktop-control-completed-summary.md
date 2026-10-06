# Desktop control and completed task presentation — 2026-10-06

Implementation: `3fca024eea6bc05fab657516e1bb370f81e90c80`.

## Report and confirmed cause

Taking manual control displayed “Native graphical operation could not be confirmed; inspect before repeating input.” The registered Lenovo executor recorded the reported clicks as `rejected_not_dispatched`, code `STALE_FRAME`, with cleanup confirmed. They never reached X11.

At 09:26:51.839 UTC and 09:34:14.119 UTC, the bound observations were respectively 09:26:49.935 and 09:34:12.246. Each had one intervening observation with identical image pixels. The driver retained only the newest observation ID, while the human viewer polled every 750 ms. An already dispatched capture can finish even when its HTTP client aborts. Repainting also made the strict whole-screen pixel comparison unsuitable for live human input.

The completed task summary still rendered the legacy `EvidenceList`: clipped search-index JSON and raw page navigation Markdown. The earlier per-operation presentation did not cover that summary.

## Changes

Manual input accepts a previously displayed, known observation in a bounded history of 16 observation metadata entries, with the existing 30-second maximum age. It still checks session generation, dimensions, bounds, trusted human authority and revocation before dispatch and between input events. It invalidates the history before performing a gesture and on control reset or mask changes. Image pixel buffers are not retained in the history. Agent input retains its strict latest-observation and unchanged-pixel requirements.

The broker chooses the human path only after trusted authorization. No additional authority field was added to the phone or model action schema. Expired-frame messages are readable and do not trigger automatic replay.

The completed summary now reuses the operation renderer for file previews, recorded completion checks, missing work and source cards. It parses complete saved search/fetch receipts, deduplicates safe source URLs, and identifies an actually fetched page separately from a search result. Legacy clipped JSON is preserved in the collapsed technical section rather than repaired into invented sources. Navigation Markdown is omitted from summary excerpts. Original saved evidence and completion remain accessible under “Detalhes técnicos (JSON).” English and Portuguese interface text are provided.

## Validation

- New desktop regression cases failed before the driver/broker fix; all 25 native desktop tests subsequently passed.
- All 62 executor contract/correction/media tests passed.
- All 10 desktop service, native authority, client state and mounted browser component tests passed, including rejected input and uncertain outcomes without replay.
- All 160 mobile app tests passed, including four new completed-summary cases. Type checking, lint and the Expo web export passed.
- Browser tests and filesystem fixtures ran with a private disk-backed `TMPDIR` after `/tmp` memory pressure caused environment failures. No unrelated code was changed for those failures.

The actual public app was tested against the registered Lenovo desktop after installation. Eight manual actions (four clicks, three key presses and one text input) were recorded as `succeeded`, with cleanup confirmed and no stale-frame rejection. Visual inspection confirmed the Applications menu, typed text in Application Finder and closing that dialog. No diagnostic file was saved. Taking control reset revision 1 successfully; handing control back reset revision 2 successfully and returned the viewer to “Observing.”

The original completed “Infográfico: Gemini 4 Argon” task was opened in the published app without regenerating it. Its image loaded at 1086 × 1448. The summary displayed the recorded delivery check and five readable source cards, with the fetched Google page marked as consulted. Index JSON, page breadcrumbs and raw schema keys were absent from the default summary. Expanding the technical section exposed the original evidence and completion; collapsing it hid them again. At a 390-pixel viewport, document and dialog widths both remained 390 pixels. The collaborative preview was restored to its original fill mode.

These checks verify presentation of saved records, not a new factual verification of their underlying article claims.

## Published distribution

Web release: `/opt/okami-web/releases/desktop-summary-20261006-3fca024e` at `https://app.okamibot.cloud/`.

- Bundle: `_expo/static/js/web/index-560c54b47681ddd4e8ace9cdc544dc58.js`.
- Public HTML SHA-256: `168722e0e272e2c54bcaecbdc437b64d9e014826e8059237ce4e76fd7c5185bf`.
- Public bundle SHA-256: `a04cf89d23003e2f50a636b468346a339457de404ab87ab7e8797d0fdb177e2a`.
- Previous web release retained: `/opt/okami-web/releases/step-viewer-20261006-bbb8bb69`.

The Lenovo installation updated only `/opt/okami-computer/desktop/driver.py` and `desktop/broker.py`, retaining their prior versions in a private deployment backup. Only `okami-session@lenovo-okami.service` was restarted, after confirming zero running command/media jobs. The managed session recovered display, capture, input and browser readiness. Executor epoch remained 31; supervisor, X11 adapter, registration and credentials were unchanged.

- Driver SHA-256: `2b4996294af64ba7239812cbd280e1ff6341be4d9bc15584f72654477f915b00`.
- Broker SHA-256: `d38f52af9dccd3f32c1374b81b3ede4e8891d9647ef32428f0eb01c27a296cae`.

API/executor routes and APK download handlers were preserved. The API was not redeployed; its source remains `5fdfe1b97d647130cd6a80b0cb923c7913b21837`. No model settings or task data were changed. No APK was built for this web report.

Private validation and deployment receipts: `artifacts/desktop-summary-20261006/` (ignored by Git).
