# Muse fidelity correction

The owner rejected the previous implementation as visually dissimilar. Passing functional tests and publishing the previous build did not meet the acceptance criterion. The required result is close visual and motion fidelity to Muse, including creating genuinely new characters instead of changing five procedural models.

## Visual and functional target

Use inspected original footage as the direct reference: the official sizzle's beige companion at 6–10 seconds and headphones/laptop working state at 21–24 seconds, the official product tour's mobile layout, and Claire Vo's creation flow at 1710–1790 seconds. The latter shows four image candidates followed by “Generating video.” State video clips are our implementation choice supported by that evidence; the footage does not establish Meta's underlying rendering engine.

The default character needs the same compact hood/bell silhouette, shallow peach face, small black bead eyes, understated smile, short dense textile material, fixed soft studio light and restrained movement. Working changes to a coherent scene with headphones and laptop. No giant reflective eyes, exaggerated bouncing or visibly intersecting primitive meshes. Newly authored reference-conditioned artwork replaces the earlier models in the active presentation.

The owner's further clarification applies this quality criterion to every newly created character, not only the beige default. Free descriptions must retain the requested creature and distinctive features while consistently producing beautiful tactile 3D plush, harmonious proportions, a lovable face and restrained animation. A dragon or robot must not be forced into the default beige hood. Validate the shared generation brief with visibly different subjects and actual provider output.

The desktop shell uses a narrow icon rail, separate optional side-chat list, restrained central chat/composer and avatar inspector. Mobile uses a small floating companion, name/status capsule, translucent top fade and floating composer/navigation. Library belongs in primary navigation; integrations remain accessible through utilities.

## Implementation

- Replace the active WebGL presentation with local/default or owner-authorized image/video assets. Keep a poster visible until the first decoded frame, crossfade state changes, mute all clips, pause hidden/background/offscreen playback and respect reduced motion. Polling must not restart playback when a signed media URL refreshes.
- Add durable owner-scoped avatar assets and generation jobs. Description → four actual image candidates → user selection → applied poster and real idle/working/responding clips. Saved characters remain selectable; generation errors and uncertain provider outcomes stay visible and retries are explicit.
- Use the existing Grok OAuth subscription independently of the selected chat model. Real image and video generation have been confirmed against the authenticated upstream; do not implement fake candidate variations. First/last-frame inputs preserve the intended loop pose. Generate a working-pose still before animating it.
- Preserve account/session boundaries, file ownership, previous selected identity until a deliberate selection, and operational drain/restart behavior. The legacy appearance schema remains readable for compatibility.

## Acceptance

Compare equivalent screenshots and actual motion sequences against the inspected references. Check prompt-created characters, four distinct candidates, selection, generation status, saved gallery/reload, idle/working/responding transitions and reduced motion with actual media. Validate desktop/mobile composition and native performance with the final assets. Tests and builds establish regression safety; they do not establish visual acceptance. The previous release is explicitly not the accepted visual result.

Evidence and generation prompts are stored under `artifacts/muse-fidelity/`; source research is under `artifacts/muse-research/fidelity/`. Only newly authored/generated assets enter the product. Reference links: [official design article](https://introducing.muse.ai/), [official product tour](https://www.youtube.com/watch?v=wHn0hTjvFoo), [creation walkthrough](https://www.youtube.com/watch?v=2UwemqPkJSQ), [official sizzle](https://about.fb.com/wp-content/uploads/2026/09/Introducing-Muse_Sizzle-Video.mp4).

## Implemented and published on 3 October 2026

- Backend: `32a1ae56b1da2deefbc53fc2fca6dd1c2ed9106a`, image `openmuse-server:product-32a1ae5`. Deployment used maintenance/drain and preserved the inactive pause at revision 16. Later static releases did not restart the API.
- Final web and signed Android: `360b60dfafb91f9af8d47a45ea470ff458019c46`, including Portuguese “Trabalhando” and the new plush launcher/splash artwork. Web directory: `/opt/okami-web/releases/360b60d-public`.
- Public ARM64 download: `https://app.okamibot.cloud/downloads/okamibot.apk?v=360b60d`, 58,499,825 bytes, SHA256 `a7f56342c0072751977f29e2bc8cfd184afce1463eb36f7b323ed5018b0ed23d`. A complete public download matched the signed local build. The public root contains the final JS bundle; health 200, unauthenticated API 401, public executor/deployment routes 404.

The shared generation brief was exercised with four turquoise dragons and four lavender robots. The production UI then generated four orange foxes with sage scarves, selected option two, applied its still and completed real idle/working/responding videos. The working image has coherent headphones, laptop and table. The gallery survived reload; selecting the saved fox played all three clips without another generation. Completing the job did not override a later selection. Production HTTP Range returned 206 with valid MP4 bytes.

Browser evidence confirms decoding and advancing video time, stable playback across URL refresh, offscreen pause/resume, reduced-motion posters and desktop/mobile layout. The final Android update preserved pairing and a test draft. Its new icon, Portuguese state labels, current saved character and HOME/resume passed with no filtered logcat errors. All three bundled videos, offline playback and a static reduced-motion poster were observed on the core `32a1ae5` build; the renderer is unchanged in `360b60d`. Native background pause has code coverage and AppState gating, but the release did not expose direct player-state telemetry: persistent codec allocation cannot prove whether playback paused.

Node verification ran in two batches (431/432 and 519/519). The one failure was the browser-test build harness missing MP4 loading/Expo URL definitions; fixing it made the actual Playwright viewer test pass. Final focused verification passed generation/rendering/viewer 19/19, studio 11/11, localization 4/4 and branding 1/1. Mobile/server TypeScript, server/web builds and lint with zero errors passed; existing lint warnings remain. Both APK builds came from the clean final functional commit with the persistent production certificate.

Evidence receipts: `artifacts/muse-fidelity/live/generation-status.json`, `public-release-verification.json`, `public-range-check.json`, `session-cleanup.json`, `artifacts/muse-fidelity/shell/media-checks.json` and `artifacts/android/muse-fidelity-release/evidence/native-acceptance.json`. Screenshots, generated candidates and complete video clips are adjacent to the receipts. Default image/video prompts and provenance are tracked in `apps/mobile/assets/companions/README.md`.

During final acceptance a separate user session created and selected another character. That choice was preserved; the old identity backup was not restored over it. Only our two temporary acceptance sessions were revoked and their private credential files removed. Local test servers/browsers and the owned Android emulator were stopped; native language/network/animation settings were restored.

Physical-phone testing and the owner's visual judgment remain outstanding. This publication implements the requested creation and presentation changes and provides actual generated-media evidence; automated checks do not establish near-identical appearance or user approval.
