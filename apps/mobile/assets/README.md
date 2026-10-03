# OpenMuse capybara

`capybara.png` is original artwork generated for OpenMuse with the built-in image-generation tool on September 16, 2026. The transparent PNG is retained as historical artwork under this repository's MIT license.

Generation prompt: “An original friendly capybara assistant mascot, with a broad boxy rounded snout, small round ears, tiny relaxed eyes, a squat body and short legs. Sitting in a gentle three-quarter view, with warm caramel and oat tan coloring, a calm expression, a soft clay/plush finish and restrained detail readable at 48–96 pixels. Entire character centered on a transparent background. One character, no clothing, props, text, logos or watermark.”

The original artwork and this attribution remain intact. The current launcher, adaptive icon and web favicon use the newly authored plush companion under `companions/`.


## Previous procedural companions

`avatars/{capybara,wolf,fox,cat,robot}.png` are locally rendered previews of the original
Three.js models in `src/avatar/model.ts`, revised October 3, 2026. They are selector thumbnails
and were the labelled fallback for devices without WebGL in the previous release. These models
remain for legacy data compatibility but no longer render the active companion. No Meta/Muse
character assets are included. See `src/avatar/README.md` for legacy reproduction and resource limits.

## Current plush companions

`companions/` contains the original generated stills and three locally bundled state videos used
by the default companion. Its [asset record](companions/README.md) preserves generation prompts
and production details. New user-described characters are created through the dedicated media
generation service, then stored with the owner's files; the player uses their stills and videos.
