The shared scene builds five original 3D characters from Three.js meshes. `AvatarRenderer` uses
WebGL directly on web and the existing React Native WebView on Android/iOS. Native HTML bundles
the same scene and Three.js locally, disables external navigation and connections, and never
receives API credentials. `AvatarThumbnail` uses locally rendered PNGs for preset cards and the
explicitly labelled static fallback when WebGL is unavailable.

`AvatarStudio` loads the current owner's identity, previews and saves a validated `AvatarDesign`
through `/api/agent/identity`. It does not write the agent's name or personality. Existing profile
settings and revision history handle those fields. Legacy identities without a design receive the
3D capybara default; an explicit saved design always takes precedence.

Use `AvatarRenderer` with `design={identity.avatarDesign}` and an `idle`, `thinking` or `talking`
state. Pass `active={false}` while another large preview is open. `AvatarStudio` exposes
`onPreviewActiveChange` for that purpose. Only the studio preview opens a graphics context; all
five selector cards are images. Web scenes pause offscreen; native scenes check their bounds and
pause in the background. Device reduced-motion preferences stop the animation loop entirely.
Pixel ratio is capped at 1.5, motion is capped at 30 fps, and disposal releases geometries,
materials, the shadow texture, animation callbacks and the WebGL context.

After changing the scene, run `pnpm --dir apps/mobile build:avatar` to regenerate the checked-in
Android bundle. `pnpm --dir apps/mobile check:avatar` verifies it is current. With workspace
dependencies and Playwright's Chromium installed, `pnpm --dir apps/mobile verify:avatar` checks
actual rendered pixels, pauses, reduced motion, custom designs, network isolation and disposal.
Set `OKAMI_AVATAR_CHROMIUM` to use an existing Chromium binary. Preview artifacts are written to
`/tmp/okami-avatar-review` by default, or `OKAMI_AVATAR_ARTIFACT_DIR`.


The October 2026 character revision uses original plush silhouettes with deterministic, batched
curved fibers, a locally generated textile bump texture and studio image-based lighting. Shared
textures, the environment render target and shadow targets are explicitly disposed. The robot
uses ceramic surfaces; all five preserve the version-1 saved appearance contract. Geometry stays
below 420,000 vertices and 80 meshes per character. Fibers are batched per surface, never per hair.

The conversation uses `framing="portrait"`; the appearance studio shows the full character.
`thinking` includes a laptop and alternating typing paws, while `talking` follows the text reply
with small head/paw/mouth gestures (it does not imply synthesized audio). Reduced motion keeps
an informative static pose. After visual verification, copy the five named PNGs from the render
artifact directory to `apps/mobile/assets/avatars/`; these are actual local renders of the models.
