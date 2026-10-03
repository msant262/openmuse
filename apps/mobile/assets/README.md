# OpenMuse capybara

`capybara.png` is original artwork generated for OpenMuse with the built-in image-generation tool on September 16, 2026. The transparent PNG is bundled locally and used by the shared `Mascot` component. Sky, sand and lilac backgrounds preserve the avatar color preference. The asset is included under this repository's MIT license.

Generation prompt: “An original friendly capybara assistant mascot, with a broad boxy rounded snout, small round ears, tiny relaxed eyes, a squat body and short legs. Sitting in a gentle three-quarter view, with warm caramel and oat tan coloring, a calm expression, a soft clay/plush finish and restrained detail readable at 48–96 pixels. Entire character centered on a transparent background. One character, no clothing, props, text, logos or watermark.”

The OkamiBot fork also uses this unchanged MIT image as its launcher/adaptive icon and web favicon. The app's display name changes; the original artwork and this attribution remain intact.


## Current 3D companions

`avatars/{capybara,wolf,fox,cat,robot}.png` are locally rendered previews of the original
Three.js models in `src/avatar/model.ts`, revised October 3, 2026. They are selector thumbnails
and the labelled fallback for devices without WebGL. Live characters use those same locally
bundled 3D models, not remote videos or image generation. No Meta/Muse character assets are
included. The older `capybara.png` above is retained as historical artwork and is not the current
live avatar. See `src/avatar/README.md` for reproduction and resource limits.
