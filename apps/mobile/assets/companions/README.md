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

These bundled stills and videos remain available as Mini Muse. They do not constrain the creation system. The server's shared `avatarVisualBrief` in `apps/server/src/providers/avatar-media.ts` applies the same tactile plush direction to the user's chosen creature and generates four actual distinct candidates. The selected still becomes the identity reference for all three animations, including a separately generated working pose. Visual quality is evaluated from real outputs, not inferred from passing unit tests.

## Okami wolf

`okami-wolf.png` is the original transparent plush wolf added October 4, 2026 with the OpenAI image-generation tool. The default wolf now has its own bundled animations. Mini Muse retains all three existing animations, and selecting either built-in companion preserves the user's saved gallery.

Generation direction: a calm, friendly silver-gray wolf cub with ivory muzzle and chest, charcoal facial mask, pointed ears, small paws, curled fluffy tail, and restrained cyan/magenta ear accents. Full body, almost front-facing, neutral studio light, transparent background, no props, text, floor or shadow. Designed to remain recognizable at header size.

### Wolf motion assets

- `okami-wolf-idle-poster.png`: white-background animation reference, created from the transparent wolf using built-in `image_gen`. Identity, seated pose, fur, face, ears, paws and tail preserved; no new props, text or scenery.
- `okami-wolf-working-poster.png`: the same wolf wearing black headphones, with its front paws on a small dark-gray laptop on a light wood tabletop. Created with built-in `image_gen`, using the original wolf as the identity reference and a fixed white background.
- `okami-wolf-{idle,working,responding}.mp4`: three independent Grok Imagine Video 1.5 generations, using the matching still as both first and last frame. H.264, 720 × 720, 24 fps, 145 frames (approximately six seconds). Total video payload: 3,926,052 bytes. Bundled exports keep the original video stream, remove attached covers/audio and move MP4 metadata before the video data. No soundtrack.

Video prompt prefix:

> Animate the exact miniature plush wolf cub in this reference. Keep its identity, silver-gray and ivory fur, charcoal facial mask, glossy black eyes with tiny cyan highlights, cyan and magenta inner-ear accents, rounded short muzzle, pointed ears, paws and fluffy tail unchanged.

Motion instructions:

- Idle: “Paws rest in the exact seated pose. Gentle natural breathing, one soft blink and a tiny content head settle. Calm attention. Tail stays resting.”
- Working: “Headphones, laptop and tabletop remain unchanged. Two existing soft front paws make small alternating typing movements on the keyboard. Occasional blink and a slight attentive nod toward the laptop. Head stays above the laptop; body and tail stay anchored.”
- Responding: “One small, clearly visible friendly acknowledging nod and a gentle blink, then return to the exact resting seated pose. Paws stay down and mouth stays a gentle closed smile. No speech, lip sync, waving or celebration.”

Video prompt suffix:

> A seamless six-second loop, beginning and ending in precisely the same pose. Camera completely locked; no zoom, pan, crop changes, swaying, bouncing, new body parts, new props or texture shimmer. Pure white background stays fixed. Preserve all framing, proportions, materials, lighting and props in the reference. No words, logos, music, sound effects or audio.

Source videos, generation receipts, full prompts and frame sequences are in local `artifacts/okami-wolf-motion/generated/`. Playback uses the existing shared player: muted loops, paused when hidden/backgrounded, with the matching still for reduced motion or unavailable video. The existing circular and rounded framing applies on both themes and platforms.
