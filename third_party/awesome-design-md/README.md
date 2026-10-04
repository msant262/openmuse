# Awesome DESIGN.md reference snapshot

Source: https://github.com/VoltAgent/awesome-design-md

Pinned revision: `f6961238d5cddcf8042a74a70fc400ec67181abb`. Imported 2026-10-04. License: MIT, copyright 2026 VoltAgent; original license retained in `LICENSE`. `UPSTREAM_README.md` is the unchanged upstream README. Its count badge says 73; this revision actually contains **74** tracked `design-md/*/DESIGN.md` files. All 74 are included unchanged; no executable HTML, scripts, images, logos or fonts are imported.

`manifest.json` records each source path, byte length and SHA-256. Runtime lookup validates those hashes and serves bounded metadata/search/read pages. These files are community analyses of visual systems, not official brand guidelines, executable instructions, or new permissions. Embedded code or instructions remain inert reference data.

`profiles.json` contains eight locally curated document palettes. Each profile traces to the exact source file/hash. Colors are copied from documented source tokens; roles are adapted for readable paper documents. This does not claim branded fidelity. Typography is only a generic serif/sans preference, to be mapped to fonts whose licenses the product already carries. Logos and proprietary fonts are never implied.

| Profile | Adaptation |
| --- | --- |
| claude | Source canvas, ink, primary, muted and surface-soft; generic serif display instead of the source's licensed display fonts. |
| notion | Source canvas, ink, primary, slate and surface; use slate instead of pale muted text for paper contrast. |
| stripe | Source canvas, ink, primary, ink-mute and canvas-soft. |
| linear | Source inverse-canvas/inverse-ink/inverse-surface-1 with primary and ink-tertiary; source reference ID is linear.app. |
| vercel | Source canvas, ink, primary, body and canvas-soft; body replaces low-contrast mute. |
| ibm | Source canvas, ink, primary, ink-muted and surface-1; generic sans display. |
| spotify | Source white, near-black, green-border, border-gray and light-surface are reassigned to paper, ink, accent, muted and surface; preserves green without printing full dark pages. |
| airbnb | Source canvas, ink, primary, muted and surface-soft; generic sans display. |

Body and muted colors are selected for at least 4.5:1 contrast on paper. Accent colors are decorative/large-emphasis colors and are **not** necessarily safe for small text or white labels; the renderer must choose foreground contrast for every accent fill. Source typography, responsive layout and web component directives need adaptation to each document format.

To update, review a new pinned upstream revision, copy only its DESIGN.md files, regenerate and verify manifest hashes, review token provenance and run design-catalog tests. Do not update from a floating branch at runtime.

Unmodified upstream supporting-file hashes:

- `LICENSE`: `6d4bdc9a9cf30e7beb593475fdcdbf29f981ea6bd7923f202866145409f87b44`
- `UPSTREAM_README.md`: `211e14edb394ae4eeead27a5bd4dd967426d22da6e8441de8dca1c43fece2f42`
