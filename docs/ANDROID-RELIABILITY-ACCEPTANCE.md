# Android reliability — 5 October 2026

The published Android build lacked Firebase client configuration and the API
lacked FCM credentials. The previous local session had also left incomplete
remote-control error handling. Native acceptance found an additional issue:
React Native's AbortSignal has no `throwIfAborted()` or `reason`, so the new
preview cancellation code failed before it could load a desktop frame.

## Changes

- Android builds embed the configuration for the existing `app.openmuse.mobile`
  package. Public release builds reject missing or mismatched Firebase resources.
  The existing private signing certificate is retained for in-place updates.
- The dedicated OkamiBot notification service account has FCM permissions. Its
  private key is mounted only in the API; neither the key nor device tokens are
  committed. Notifications use high FCM delivery priority and the app's channel.
- Native notification registration recovers on foreground resume and preserves
  the newest token across delayed startup and rotation.
- Audio recording handles Android auto-pause, preparation races, and closing the
  panel. A failed local save retains the recording for an explicit retry.
- Document/camera pickers prevent overlapping launches. Camera activity recovery
  retains the originating conversation, and failed transcription retries use a
  new persisted request identity.
- Desktop takeover cancels obsolete preview reads, keeps the image in place,
  avoids unrelated workspace refreshes, and polls faster during human control.
  Denied/uncertain input clears local authority without replaying the gesture;
  a stale-frame rejection waits for fresh pixels. Cancellation works with the
  actual React Native AbortController polyfill.

## Verification

All **40 targeted tests passed**, covering native notification consent/token races, audio and
attachment interactions, preview cancellation, and mounted desktop behavior.
The Python build/baseline checks passed 15 tests. TypeScript checks passed and
changed-file lint passed with one existing non-null-assertion warning.

Android 14 Google APIs x86_64 emulator, signed release APK:

- Android permission prompt appeared, registration reported enabled, and the
  production API adapter's FCM send arrived in the system notification tray
  while the app was backgrounded. Tapping it reopened the app.
- Microphone permission appeared, recording advanced and stopped, the resulting
  31.936-second M4A uploaded, and its transcription task completed successfully.
  This verifies the flow, not speech accuracy or a physical microphone.
- Android's document picker opened; a 61-byte QA text file was selected and
  uploaded successfully.
- The final APK displayed the desktop, acknowledged Take control, opened and
  dismissed the desktop Applications menu through native touch, and handed
  control back. The desktop image bounds stayed `[106,1504][976,1993]` across
  input, without the previous layout shift. The QA conversation was deleted and
  the emulator's temporary notification registration was disabled afterward.

Browser acceptance checks existing conversations, navigation, reload, and
independent unsent drafts at 390 and 1134 pixels against the production API.
Both the final candidate and public deployment passed eight checks with no page
errors or failed HTTP responses. A preceding browser run closed unexpectedly;
the successful final run used disk-backed temporary storage after the Android
build completed. All test sessions, including the interrupted browser session,
were revoked afterward. Evidence and private screenshots are local
under `artifacts/android-native-reliability/` and `artifacts/web-regression-recovery/`.

The full-suite runs inherited from the previous session were interrupted by
resource exhaustion and are not a clean full-suite result. Native tests here do
not establish behavior on the user's physical phone or carrier network.

## Release and rollback

The API remains based on `a3349fe`, with only the FCM Android priority patch added
in image `openmuse-server:android-notifications-20261005`. Configuration activation
used a maintenance lease and preserved the existing pause revision and work
state. Rollback image: `openmuse-server:before-android-notifications-20261005`;
environment backup: `/root/okami-deployment/env-before-android-notifications-20261005`.

Mobile source retains `0cf8a94e339358efe7467ff771ff64c06f5566ad` plus the recorded
working tree changes. It must not be described as a clean commit build. Source
hashes and the patch are recorded separately under
`/root/okami-deployment/android-notifications-20261005/`.

Published web: `/opt/okami-web/releases/android-reliability-20261005`.
Public APK: `https://app.okamibot.cloud/downloads/okamibot.apk`.
The downloaded 68,823,351-byte APK matches the locally verified signed build:
`19ec30219ca215598c56580be08fffa11b7fd329311471a5ec5efcac7c901e17`.
The public HTML also matches the final web export, and API health passed.
Previous immutable web assets and unrelated routes remain served.

Mobile rollback: `/root/okami-deployment/serve.before-android-reliability-20261005.json`.
The previous web root was `0cf8a94-recovery-public`; the previous APK was
`okamibot-0cf8a94-arm64-v8a.apk`. Keep both when rolling back. For a future mobile
release, preserve the recorded working tree delta as well as the base commit;
checking ancestry alone cannot represent this release.
