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
