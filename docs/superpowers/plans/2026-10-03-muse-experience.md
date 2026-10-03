# Muse experience refinement

The owner requested a substantially closer Muse experience, especially character quality, animation, previews, cards and customization. This continues the authorized product implementation and public rollout.

## Evidence and direction

Inspected the [official design article](https://introducing.muse.ai/), [Alex Cornell's product tour](https://www.youtube.com/watch?v=wHn0hTjvFoo), [Claire Vo's extended walkthrough](https://www.youtube.com/watch?v=2UwemqPkJSQ), and Meta's shopping/sizzle demonstrations. Downloaded the two tours in 1080p and inspected selected frames (58 captures), storyboards, primary design images and the official tour transcript. This does not claim every second was watched or listened to. Research evidence lives in ignored `artifacts/muse-research`; it is not shipped as product artwork.

The reference uses a compact persistent companion, short readable activity, rich actual deliverables, restrained rounded surfaces and immediate customization feedback. The walkthrough shows generated avatar variations and a generating-video state; it does not establish that Muse renders runtime 3D. Okami keeps its already requested local 3D architecture and creates original plush characters.

## Implementation

1. Replace disconnected plastic character shapes with cohesive plush silhouettes, tactile fibers, glossy button eyes, soft studio lighting, expressive idle/working/responding poses and a working laptop prop. Preserve all five species, stored customization, offline native rendering, reduced motion and resource disposal.
2. Keep the companion visible in the conversation and connect it to real foreground activity. Make appearance the first customization surface, simplify advanced controls and preserve owner/scope save guards.
3. Render saved plans/reports/comparisons as readable previews. Use real file/browser content and actionable footers. Collapse completed questions and technical receipts without losing details or changing authorization semantics.
4. Review actual rendered web/native screens, run focused lifecycle/persistence/card tests, full checks and builds, then publish the updated web and signed Android artifact using the existing deployment process.

## Acceptance

Review all five rendered characters, idle/working/responding, reduced motion, offline behavior, custom save/reload and owner changes. Review welcome/chat/results/questions/settings in EN and PT-BR on phone and desktop widths. No fabricated artifacts, fake generation claims, copied Meta artwork, automatic approvals or user data resets.

## Delivered implementation and verification

Character, shell and result-card implementation is committed in `abb6f84`; `a2845d4` adds a bundled thumbnail/loading state until native WebGL reports readiness, with accurate studio captions. The local 3D scene and original artwork are unchanged by that follow-up. A cold studio reopen took 10.677 seconds on the software-rendered API 34 emulator; the loading preview avoids leaving an empty stage during that work. This is an emulator sample, not a physical-device performance claim.

The final source passed 931/931 Node tests, both TypeScript projects, the web export and Biome with zero errors (189 existing warnings, two infos). Server build passed before the wrapper-only follow-up. Actual five-species renders, custom colors, working/responding, portrait framing, reduced motion, inactive/offscreen pause, no HTTP dependencies and disposal passed the isolated WebGL verification. The first render attempt hit a screenshot timeout under competing software GPU/build/test load; rerunning in isolation passed without source changes.

Public web checks cover 390, 1024, 1280 and 1440-pixel widths, actual pairing/reload, selection/disclosure accessibility and no console errors. The final deployment at `/opt/okami-web/releases/a2845d4-public` rendered the custom Fox saved through native settings. Android receipts record both signed architectures and their exact hashes. Full evidence is under `artifacts/muse-rework/`, `artifacts/android/muse-release/` and `artifacts/android/muse-release-evidence/`; research materials remain excluded from product assets. The backend stays on `openmuse-server:product-d6fa127`.

The final Android update preserved pairing and the unsent draft, displayed the local loading preview and transitioned to WebGL without fallback. Native reduced motion produced zero changed preview pixels across the observation interval; normal working animation changed 66,431 pixels. The original identity and profile compared exactly equal to the private backup after restoration. The published ARM64 APK was downloaded from the public versioned-query link and matched the signed artifact in both length and SHA256. Operator web/API acceptance sessions were revoked. Physical-device acceptance remains separate.
