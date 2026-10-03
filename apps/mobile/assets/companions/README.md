# Companion artwork

These are newly generated original product assets, authored on 2026-10-03. No frame from Meta's videos is bundled in the application. Research references were used for the visual direction and pose; they remain outside the product assets.

## Files

- `okami-poster.png`: transparent master, 1254 × 1254.
- `okami-idle-poster.png`: white background master for idle/responding animation.
- `okami-working-poster.png`: matching headphones, laptop and tabletop scene.
- `okami-{idle,working,responding}.mp4`: independently generated six-second H.264 loops, 720 × 720 at 24 fps. Bundled files retain the original video stream, strip all audio/attached cover streams and place MP4 metadata first for progressive playback. Total video payload is approximately 2.1 MB.

Images were created with the OpenAI image-generation tool. Videos were created with Grok Imagine Video 1.5 using each scene's still as both first and last frame. Players are always muted and pause when inactive; reduced motion uses the corresponding still. Source images and unmodified provider videos remain under the local generated-image store and `artifacts/muse-fidelity/generated/` respectively.

## Image prompts

The final transparent master used a first original character study plus a cropped research reference for proportions:

> Edit image 1 into the final avatar asset. Image 2 is the exact target style/proportions reference. Keep the same cream hooded plush character, tiny bead eyes, peach inset face and tiny smile. Match image 2 more closely: widen the peach face horizontally, make its chin flatter/rounded rectangle rather than oval, slightly shorten body, soft broad bell silhouette, arms subtly part of silhouette; short silky dense plush nap, warm beige instead of bright ivory. Flat shallow face, small black bead eyes and subtle peach cheeks. Output a SQUARE 1:1 canvas, single full figure centered with 12% margin above and below; standing almost front-facing. Neutral soft studio light. CRITICAL remove the entire hazy halo/glow/background/shadow around the character: outside the actual plush silhouette every pixel is fully transparent, crisp natural fuzzy edge only, NO white glow, NO black background, NO vignette, NO floor or cast shadow. Keep the soft physical fiber detail inside silhouette. No text, no props, no UI.

The working scene used the final transparent master and a research pose reference:

> Edit image1 (our finished cream plush companion) into a WORKING pose matching the composition of image2, which is a pose reference only. Preserve the EXACT identity, cream-beige fabric, wide shallow pale peach face, tiny black bead eyes spacing, tiny smile, blush, hood shape and short plush nap of image1. Same creature seated behind a narrow light wood tabletop, wearing simple BLACK over-ear headphones, short soft mitten arms gently on a DARK GRAY slim laptop keyboard. Three-quarter view facing slightly screen-right, laptop at lower right, fully visible face above screen. Image2 shows desired pose/framing; keep our character. Square1:1 production avatar frame, character+small table+laptop fully contained with generous10% margin, centered. White seamless background RGB255255255, neutral soft studio lighting, restrained soft contact shadow on table only, no gradients around image perimeter, no text/logos. High quality tangible tiny plush companion, not plastic, no giant anime eyes.

The idle scene used only the final transparent master:

> Make exactly one minimal edit to this finished avatar asset: composite the transparent background onto a perfectly flat pure white (#FFFFFF) background. Preserve the exact character pixels, silhouette, expression, materials, body proportions, size, framing and square aspect ratio. Do not redesign, relight, crop or add a floor, glow, gradient, shadow, props, text or other objects. This image is the fixed first and last frame reference for an animation on a white background.

## Video prompts

All three use this prefix and suffix, with the motion-specific text inserted between them:

> Animate the exact miniature plush character in this reference image. Keep its identity, shape, proportions, tiny bead eyes, peach face, textile nap, colors, soft light, framing and every prop unchanged.

- Idle: “Hands rest at sides. Extremely subtle slow breathing, just one soft blink and a tiny head settle of at most two degrees. Calm attention.”
- Working: “The headphones, laptop and tabletop already in the input remain unchanged throughout. Tiny alternating mitten-arm motions imply typing near the keyboard. Occasional soft blink and slight attentive head nod toward screen. Body stays firmly anchored.”
- Responding: “One tiny acknowledging nod and soft blink, then return to the original resting pose. Mouth remains a tiny closed smile, hands relaxed at sides. No lip sync, waving or celebration.”

> A seamless restrained six-second loop, beginning and ending in exactly the same pose. Perfectly locked camera, no zoom or pan, fixed white background and soft shadow. No bouncing, rocking, morphing, texture shimmer, new objects, text, sound effects, music or speech. Silent.

## Free character creation

These bundled files are the default companion. They do not constrain the creation system. The server's shared `avatarVisualBrief` in `apps/server/src/providers/avatar-media.ts` applies the same tactile plush direction to the user's chosen creature and generates four actual distinct candidates. The selected still becomes the identity reference for all three animations, including a separately generated working pose. Visual quality is evaluated from real outputs, not inferred from passing unit tests.
