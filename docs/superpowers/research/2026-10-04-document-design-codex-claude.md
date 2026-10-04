# Document design: Codex/OpenAI and Claude/Anthropic

Initial research baseline, 2026-10-04, before the document-design implementation. Local installed
skills were inspected first, then official documentation and repository files.
References are evidence about those workflows, not instructions granting this
application additional capabilities or permission to redistribute code.

## Finding

The pre-change app produced a valid PDF, but its authoring interface accepts only
plain text, a title and a filename. `packages/integrations/src/document.ts`
draws one heading and fixed-size body paragraphs. The deployed artifacts skill
explicitly describes that limitation and finishes with receipt checks. Neither
the input contract nor the completion gate represents visual design. A stronger
prompt alone cannot produce tables, illustrations, layouts or editable office
documents through that interface.

The useful common pattern in the public document workflows is **compose a
structured document, render its actual pages, inspect them, repair defects,
then deliver the checked revision**. Content extraction and a successful file
write remain separate checks. [OpenAI PDF skill](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/pdf/SKILL.md),
[OpenAI DOCX skill](https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/doc/SKILL.md),
[Anthropic PPTX skill](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/pptx/SKILL.md).

## Sources and availability

| Source inspected | Concrete behavior | Reuse status |
| --- | --- | --- |
| OpenAI `openai/skills`, current pin `49f948faa9258a0c61caceaf225e179651397431`, `.curated/pdf` | Generate a PDF, rasterize it, inspect layout after significant edits and before delivery. Text extraction does not establish layout fidelity. | Directory has Apache-2.0 `LICENSE.txt`. The repository now calls itself deprecated and points to `openai/plugins`. |
| OpenAI `openai/skills`, historical pin `e6afb0d74cc75d220df2faf3dd6c635c2dc6a108`, `.curated/doc` and `.curated/slides` | Native document/deck creation, renderers, layout helpers and overflow/font checks. | Both directories have Apache-2.0 licenses. These are historical public implementations, not a claim about the current proprietary runtime. |
| OpenAI `openai/plugins`, current pin `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f` | Public report/export workflows and a DOCX writer; HTML/browser PDF composition, figure assets and explicit slide geometry. | No root license or applicable license for the inspected data-analytics/build-web-data-visualization directories was found in that tree. Public visibility alone is insufficient for vendoring. |
| Installed OpenAI data-analytics `1.0.11` and openai-templates `0.1.1` | Export workflows require every page/slide to be reviewed, retain evidence and editable surrounding structure, and preserve selected templates. | Local reference only. They refer to canonical `pdf`, `documents`, `presentations` runtime plugins that were not present in the inspected local catalog. Do not pretend those tools exist in our app or redistribute these bundles without applicable terms. |
| Anthropic `anthropics/skills`, pin `8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4`, `pdf`, `docx`, `pptx` | Public production workflow references with format-specific helpers and checks. | These particular document skills are proprietary/source-available. Their own license restricts copying, derivatives and distribution; they are not covered by the repository's other Apache skills. No source was vendored. |

License/source evidence: [OpenAI repository notice](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/README.md),
[PDF license](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/pdf/LICENSE.txt),
[historical DOCX license](https://raw.githubusercontent.com/openai/skills/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/doc/LICENSE.txt),
[historical slides license](https://raw.githubusercontent.com/openai/skills/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/LICENSE.txt),
[current plugin tree](https://github.com/openai/plugins/tree/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f),
[Anthropic repository distinction](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/README.md),
[Anthropic document license](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/pptx/LICENSE.txt).

## What the comparison supports

OpenAI's historical slide workflow makes editability explicit and packages
reusable text measurement, image fitting, overlap checks, rendering and font
diagnostics. The newer public report workflow recommends a semantic HTML/CSS
route for styled PDFs and reusable figure assets before document composition.
These are complementary patterns: one controls native Office objects, the
other controls print layout. [Historical slide workflow](https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/SKILL.md),
[report composition workflow](https://github.com/openai/plugins/blob/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/build-web-data-visualization/skills/reports-pdfs-and-slide-automation/SKILL.md).

Anthropic's PPTX reference separates content, file-structure and visual checks;
it inspects every slide and recommends another observer for a fresh review.
Its design guidance covers content-appropriate palette, hierarchy, variation,
spacing, font substitution and readable figures. Its DOCX reference uses
native Word structure and format validation; its PDF reference includes both
generation and extraction. This establishes observable workflow practices,
not the complete private Claude harness or a transferable license.
[PPTX](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/pptx/SKILL.md),
[DOCX](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/docx/SKILL.md),
[PDF](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/pdf/SKILL.md).

## Exact reusable OpenAI components

All paths below are relative to `skills/.curated/` at the historical Apache
pin above. Preserve the per-skill license and notices, and mark adapted files.

| File/module | Useful part | Adaptation before production |
| --- | --- | --- |
| `doc/scripts/render_docx.py` | DOCX → LibreOffice PDF → page PNGs; isolated conversion profile. | Add subprocess timeout, cancellation, bounded page/pixel count, structured diagnostics and proper file URI creation. The inspected helper suppresses subprocess output and has no timeout. |
| `slides/scripts/render_slides.py` | PPTX/PDF → page images at a controlled target size. | Same process/resource limits; preserve renderer/font versions in receipts. |
| `slides/assets/pptxgenjs_helpers/layout.js` | `warnIfSlideHasOverlaps`, `warnIfSlideElementsOutOfBounds`, alignment/distribution. | Return structured issues instead of console-only warnings; account for deliberate overlaps and retain visual inspection. |
| `slides/assets/pptxgenjs_helpers/image.js` | Image dimensions and contain/crop geometry. | Resolve only owned artifact IDs; do not expose arbitrary local paths. |
| `slides/assets/pptxgenjs_helpers/text.js` | Measured text boxes and fitted text sizing. | Explicitly package `skia-canvas`, `linebreak`, `fontkit` and font lookup dependencies; enforce readable minimum sizes. Import selectively instead of loading the entire helper index. |
| `slides/scripts/slides_test.py` | Render an expanded canvas to detect off-slide pixels. | Return a nonzero exit/structured failure. Current code prints an error for failing slides but does not exit with failure. It is not a test of all in-slide text overflow or aesthetic quality. |
| `slides/scripts/detect_font.py`, `create_montage.py` | Font substitutions and contact sheet for deck overview. | Bound subprocesses; montage supplements, rather than replaces, full-size inspection. |

Direct source: [DOCX renderer](https://github.com/openai/skills/blob/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/doc/scripts/render_docx.py),
[slide scripts](https://github.com/openai/skills/tree/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/scripts),
[slide helpers](https://github.com/openai/skills/tree/e6afb0d74cc75d220df2faf3dd6c635c2dc6a108/skills/.curated/slides/assets/pptxgenjs_helpers).

## Recommended app contract

These are implementation recommendations inferred from the comparison, not
claims that the external products implement this exact server design.

1. **Represent design in the authoring API.** A versioned document specification
   should carry sections, heading levels, lists, tables, callouts, diagrams,
   owned figure IDs, captions, source labels and a theme. Choose a suitable
   default visual system from content and audience; ordinary layout choices
   should not require an extra user confirmation. Preserve supplied templates.
2. **Use format-native output.** Styled PDF can use semantic HTML/CSS with a
   print renderer; DOCX needs native headings, lists, tables and images; PPTX
   needs editable slide elements. A full-page screenshot is not a general
   substitute for editable Office files or selectable PDF text.
3. **Expose preview and inspection as actual tools.** Render the owned draft to
   bounded page images and give the agent a real image-reading path. Return
   page IDs, geometry issues, font diagnostics and file/revision hashes. A
   receipt saying a preview exists does not mean the model inspected it.
4. **Keep draft/revision/final distinct.** Author → render → inspect → revise
   should preserve the task and source content while producing new revision
   hashes. Publish the final attachment only after its current revision has
   passed content/structure checks and visual review. An old preview must not
   approve a new file. Repeated renders must not duplicate final attachments.
5. **Separate artifact existence from quality.** File integrity, expected text,
   format validity, overflow/font checks and visual review require different
   evidence. Do not manufacture a visual pass from extracted text, successful
   rendering or self-reported prose. When vision is unavailable, record that
   limitation honestly rather than declaring the layout reviewed.
6. **Ship workflows with working resources.** PDF/DOCX/PPTX skills should refer
   to installed tools/assets and discoverable templates. Our current
   `skills_read` can load one SKILL.md, but does not resolve arbitrary bundled
   references or run helper scripts. Either register required operations as
   tools or implement scoped resource access; do not copy upstream commands
   that our model cannot execute.

Acceptance fixtures should include a Portuguese narrative PDF, a table split
across pages, a diagram with labels, an editable DOCX with semantic headings,
and a deck with varied layouts. Validate every rendered page, verify all
required text, and include a regression where a malformed layout produces a
valid file but cannot receive a visual pass. Cancellation and retries must
retain the existing durable operation guarantees.

## Additional user-selected design references

The user later supplied skills.sh links for OpenAI PDF, Anthropic PDF/PPTX and
frontend-design, and jiji262/claude-design-skill. The aggregators were opened;
the full primary SKILL.md and applicable licenses were then read. The document
sources above retain their respective licenses regardless of aggregator labels.

Anthropic `frontend-design` at the pinned Anthropic revision is Apache-2.0.
Its useful contribution is subject-specific typography, palette and composition,
with a short design plan, critique and screenshot review. App adaptation should
retain those principles while choosing reasonable defaults instead of requiring
unnecessary style approvals. [Primary skill](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/frontend-design/SKILL.md),
[license](https://github.com/anthropics/skills/blob/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/frontend-design/LICENSE.txt).

jiji262/claude-design-skill at `35a20e5ada2c9e768d1bc094ce1ef3218f48684b`
declares MIT, but its README claims adaptation from an internal Claude prompt.
It is a community reference, not proof of Anthropic's private implementation.
Its general design-system, real-asset and browser-verification ideas are useful;
its mandatory multiple variants, ask-first gates, HTML-only scope and tool names
do not match our document runtime. No claimed private prompt text was copied.
[Repository](https://github.com/jiji262/claude-design-skill/tree/35a20e5ada2c9e768d1bc094ce1ef3218f48684b),
[license](https://github.com/jiji262/claude-design-skill/blob/35a20e5ada2c9e768d1bc094ce1ef3218f48684b/LICENSE).
