# Chat and Google action presentation — 6 October 2026

Published implementation: `217f3357174019d4680afe4ba277e292506bcbce`.

## Behavior

- Incoming text, attachments and late card layout keep the conversation at its actual bottom while the user is following it. An intentional upward scroll pauses following; sending or choosing the latest-message button resumes it. History remains paginated and virtualized.
- Task summaries show the actual outcome, original request and related action. Cancelled work does not display generic English delivery criteria or imply another operation is pending. Repeated stages are grouped without losing inspectable operation receipts. Phones use a compact summary/request/plan/steps navigation strip.
- Google action history identifies the actual resource, service, account and recorded changes. Document edits show inserted or replaced text rather than only “Change completed”. Links use the reviewed or confirmed resource ID and the selected Google account.
- Opening a detail performs one owner-scoped GET to `/api/actions/:id/details`. Public origin snapshots preserve the request at preparation; historical proposals can recover the request from their owned, soft-removed task. No task state, credentials or executor bindings are included. Opening history cannot execute or approve an operation.
- Terminal actions stay compact in chat and open fully in the detail sheet. Raw JSON remains collapsed. Pending destructive actions still require the exact human approval and hash.

## Automated verification

73 targeted Google Workspace, action-service and frontend tests passed. A final 27-test pass covered presentation, real card callbacks and approval policy after the last UI adjustment. Root and mobile TypeScript checks, server compilation, Web export and the signed Android build passed. Biome reported no errors; existing test-fixture warnings remain.

The tests cover owner isolation, immutable origin snapshots after task edits/removal, old-history recovery, correct account/resource links, before/after replacement text, actual draft controls, no write on opening history, timezone conversion, approval hashes and scroll-follow behavior.

## Published application observations

The production action `9388eff0b59a22f44cb86127b89e1dc28332860953de24ec73ecd94bb224a485` now shows:

- Document: **Okami confirmação final**.
- Location: **Google Drive · Google Docs**, account **msant262@gmail.com**.
- Change: inserted **Documento criado e salvo pelo aplicativo.**
- Purpose: the original natural chat request to create that named document with this text.
- An **Open document** button that was clicked and opened the exact Google Docs document `1j09jf3Q9JrdgWFu8Zd2iwYqEnG25sSKp0W4ZjP-_Q7E`, with the expected document title.

The origin endpoint was observed once per opening: approximately 36 ms in the desktop observation and 1.23 s in the responsive-phone observation. These are individual observations, not latency guarantees.

At 1440 × 1100 and 390 × 844, the real action details displayed correctly without horizontal overflow; technical JSON remained collapsed. The phone sheet scrolls its body while keeping the close action accessible.

A natural follow-up about a one-hour evening routine was sent through the published chat without instructing the model to render a card. The response increased the conversation content from 4,273 to 5,433 pixels; the final bottom gap was **0 pixels** with no manual scroll.

## Release evidence and limits

Private publication receipts: `/root/okami-deployment/action-context-20261006/` on the VPS. API deployment drained current work, closed the sole database writer before backup, preserved the global pause and environment, and finished maintenance. Server and browser health checks passed.

- API image: `sha256:45a719539fde80e26025a0270451807dceee7a5221f8251b8b7d35cf31bac061`.
- Web release: `/opt/okami-web/releases/action-context-20261006-217f3357`.
- Public HTML SHA-256: `98c3e36d3f4fd0fc84e14bf48efff68c85d7bb08d9dd1b5af46f179f8c629859`.
- Signed ARM64 APK SHA-256: `dc055a4a36c8011cf8abc44388d49b4c57ac5fe36907dd9d99fad82bfaeeb275` (67,213,285 bytes). The published download hash, production signer and native Firebase configuration were verified.

Phone layout verification used the responsive browser. The environment's Android emulator failed to boot, so this is not physical-device acceptance. Google Docs paints document contents on canvas; the link was confirmed by document ID and actual title, not by claiming its body appeared in `document.body.innerText`. This report does not claim every Google Workspace operation has been accepted through chat.
