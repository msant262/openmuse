# Accessible companion — 5 October 2026

**Corrected after a user-reported web regression.** API release
`a3349fe0d616429cabe604118d6c4d86f4bb1473`, derived from `47c4079`, remains deployed.
Its mobile tree was older than the already-published app. Building web and Android
from that API source removed existing UI and conversation recovery behavior. The
earlier claim that the omitted mobile changes were unpublished was incorrect.

Web and Android now use mobile source
`0cf8a94e339358efe7467ff771ff64c06f5566ad`, which retains the published mobile
history through `1ed264c3` and includes the improvements below. API and mobile
source pins are recorded separately. See [the recovery record](WEB-RELEASE-RECOVERY.md)
for the deployed files and conversation checks. The original verification below
is retained as historical evidence; it did **not** establish release continuity
or adequate coverage of existing conversation navigation.

## Delivered behavior

- Mobile web Settings exposes Install app: signed Android APK download and Safari
  home-screen instructions for iOS. No iOS store build is claimed.
- Memory opens saved facts first, with separate forgotten/expired/all filters,
  search, pagination, editable cards, cancel, confirm-forget, direct restoration,
  revision history, and an optional date without an ISO/UTC input requirement.
  Filters run before database pagination. Stale search responses are ignored;
  a mutation finishing after a filter change refreshes the currently selected view.
- Connections presents Gmail and Google Calendar directly. Google app credentials
  belong to the installation; each person chooses their account on Google's page.
  Composio is optional and appears only in advanced connections when configured.
  An unconfigured catalog supplies no app tools to the worker and never requests
  a Composio platform key from the person using the assistant.
- OAuth opens during the tap to avoid popup blocking, supports same-window
  fallback, refreshes after account/permission changes, and has usable cancelled
  and expired-link pages. The account endpoint returns only a safe receipt.
- The foreground exposes actual reaction, sticker, GIF and quoted-reply tools
  directly to the model. Background workers retain upstream tool discovery.

## Google installation

Dedicated Google Cloud project `okamibot`, client `OkamiBot Web`, external audience
in production, Gmail and Calendar APIs enabled. Authorized origin:
`https://app.okamibot.cloud`; redirect: `/api/google/callback`. Read scopes are the
default; Gmail sending and Calendar editing are additional permissions. Homepage
and privacy pages are published on the app domain.

No personal Google account was authorized or read during setup. Production
reported `configured: true` and `connected: false`. The real authorization URL
opened Google's sign-in page for `okamibot.cloud`, without a client/redirect error.
QA states were cancelled and temporary paired devices revoked afterward.

Google verification has not been completed. The external app may show Google's
unverified-app warning; this is not a Composio or end-user API-key requirement.
Google describes the personal-use exception and its limits in its
[verification guidance](https://support.google.com/cloud/answer/13464323?hl=en).
An actual account token exchange and account switch remain for the account owner
to authorize; deterministic tests cover those state transitions.

## Verification

- Final production-derived candidate: **32/32** targeted tests for memory,
  Google, component interaction handlers, durable social delivery and the optional
  Composio catalog. Model-protocol fixture helpers were copied from the current
  test suite; production runtime source remained the isolated candidate.
- Real browser at 390 × 844: **11 paths passed**, with no page errors: edit/cancel,
  saved edit, forget/cancel/confirm, restore, expired filter, empty search/recovery,
  invalid-date correction, simulated list outage/retry, install instructions,
  direct Google controls, and sample disconnect/reconnect. Desktop Portuguese
  layout was inspected at 1280 × 1000.
- Real production model `chatgpt/gpt-6-luna`, isolated conversations: spontaneous
  reactions to celebration and thanks, successful sticker and sourced GIF tool
  receipts, and no media/reaction tools for a text-only request. All five passed.
  Existing durable-thread tests verify replay after reopening the conversation.
- Full development suite: **1,411 passed, 2 failed** out of 1,413. The failures were
  a temporary-directory permission assertion and a one-second controlled Office
  process startup assertion. The two affected files then passed **10/10** using
  the normal temporary directory. An earlier run was invalidated by temporary
  disk exhaustion; it is not counted as acceptance. The subsequently added memory
  filter race was reproduced failing, fixed, and passed in the final candidate.
- Development typecheck and lint completed successfully (existing lint warnings
  remain). Production server build/typecheck passed. The isolated production
  mobile baseline still has three pre-existing nullable-budget type errors in
  `task-runtime-controls.tsx`; web export and signed Android compilation passed.
- Original production browser verification found installation, memory filters and native
  Google controls, with no page errors. The public APK download's SHA-256 matched
  the now-withdrawn signed build: `df80b836f660a621781bd834dd8063263743f3b4b1f43cddc20dff92235c2106`.
  The final APK receipt records a dirty checkout solely from an untracked web
  build log; no tracked application source changed during the build. Physical
  Android microphone/install acceptance was not performed.

## Audio capability

Incoming recording/attachments and offline Whisper transcription already exist.
The deployed Lenovo transcription implementation processed a synthetic 4.2-second
audio file into the expected sentence and SRT subtitles; invalid audio was
rejected. The temporary input/output files were removed. This validates the real
ASR implementation, not a physical phone microphone round-trip. There is no TTS
output integration in this release; text response styling is not speech synthesis.

## Deployment and rollback

API, web and APK were published with idle-work checks. API/browser health recovered,
maintenance was released, and pause revision 16 remained unchanged. Google secrets
are private operator configuration, absent from git and public test artifacts.
Existing cached web assets and unrelated proxy/download routes were preserved.

API/environment rollback references:
`openmuse-server:before-accessible-a3349fe` and
`/root/okami-deployment/env-before-accessible-a3349fe`.
Previous API pin: `47c4079`. Previous web/APK: `3512f6c`.
Serve backup: `/root/okami-deployment/serve.before-accessible-a3349fe.json`.
Evidence is retained locally under `artifacts/accessible-companion/`; screenshots
and provider receipts are not committed because they can contain workspace data.
