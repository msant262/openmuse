# Web and Android release recovery — 5 October 2026

The accessible-companion deployment rebuilt mobile from the selective API branch
`a3349fe`. That branch contained an older mobile tree, although its API history
was current. The previously deployed directory `3512f6c-public` also used an API
release name: its actual web files came from newer mobile work, finalized in
`1ed264c3`. The directory name was incorrectly treated as a mobile source pin.

This regressed the branded shell, composer, direct message controls, and saved
conversation state handling. Checking the newly added settings alone missed the
regression. Existing conversation records were not deleted or changed.

## Recovery

The original web and APK were restored first. Corrected artifacts were then built
from `0cf8a94e339358efe7467ff771ff64c06f5566ad`, retaining the modern UI and the
memory, installation, and direct Google improvements. The public routes now serve:

- Web: `/opt/okami-web/releases/0cf8a94-recovery-public`.
- Bundle: `index-bda8c2405557635b56c3f494e0d0e99f.js`;
  SHA-256 `6cfb74f0f1e73b44aaff1fbd830e3fab3b81175ae38560788053843d0696c92e`.
- APK: `okamibot-0cf8a94-arm64-v8a.apk`, 68,811,063 bytes;
  SHA-256 `682b33ddf34c2a209d9e60870829b0847199278464c63cc41db43d9954b25ea1`.

The APK signature and embedded public API URL were verified. The build receipt
marked the source dirty because `.orca/` was untracked; tracked mobile sources
matched the recorded commit. Physical Android installation was not repeated.

API `a3349fe`, Google OAuth configuration, user identity/avatar, and persisted
conversation data were retained. Only the root web and current APK Serve handlers
changed. Cached immutable assets and unrelated handlers were preserved. The
Cloudflare tunnel allowlist was also corrected to serve `/okami-mark.png`; the
branded loader had otherwise requested a 404.

## Verification

Real production conversations were opened through temporary paired browser
devices at desktop (1134 px) and mobile (390 px) widths. The checks exercise the
existing named conversation and the empty main conversation, switch between them,
reload each, and restore independent unsent drafts after switching and reloading.
They also verify message controls and the modern shell. Drafts remain only in the
temporary browser; server message mutations are blocked. Devices are revoked in
cleanup. No messages were sent to the user's conversations.

The candidate passed those checks against the real API before publication. The
public deployment is checked again without overriding static files. Settings
checks cover installation, saved-memory navigation, and direct Google controls;
OAuth remains configured without authorizing the operator's personal account.

An initial empty-thread check sampled the composer during asynchronous hydration
and failed. Waiting for the usable composer and selecting within the conversation
dialog resolved that test error; no additional application loading fix is claimed
from that observation. The user's original loading failure was not independently
reproduced in a fresh browser. Published recovery tests establish that the tested
existing conversations load and survive the navigation paths described above.

Evidence is local under `artifacts/web-regression-recovery/`. Screenshots and
conversation-bearing receipts are private and are not committed.

## Separate source pins

`/root/okami-deployment/source-pin` records the API release.
`/root/okami-deployment/mobile-source-pin` records the mobile source independently.
`/root/okami-deployment/mobile-0cf8a94.json` records both plus artifact hashes.

Before rebuilding web or Android, check that the proposed mobile source contains
the last published mobile history and matches the tracked working tree:

```sh
python3 scripts/verify_mobile_baseline.py \
  --previous-mobile-source 1ed264c3 \
  --mobile-source 0cf8a94e
```

For the next release, use `0cf8a94e` as the previous mobile source. The check rejects
`a3349fe` as a successor to `1ed264c3`. Three repository-fixture tests cover the
wrong API branch, a legitimate mobile successor with independent API work, and
uncommitted tracked mobile changes. This checks source continuity; it does not
replace browser acceptance or prove that a descendant contains no regressions.

Serve rollback snapshot:
`/root/okami-deployment/serve.before-corrected-mobile-0cf8a94.json`.
Cloudflare configuration snapshot:
`/root/okami-deployment/cloudflared-before-brand-route-20261005.yml`.
