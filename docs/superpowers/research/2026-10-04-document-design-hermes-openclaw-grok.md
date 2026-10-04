# Document design: Hermes, OpenClaw and Grok

Research date: 2026-10-04. Scope: official public repositories and documentation. Product code, deployment and credentials were not changed. This audit describes observed source behavior; recommendations are identified separately. It does not infer consumer-product internals from a model's capabilities.

## Finding

Document quality requires three distinct capabilities: a composition model, a renderer and review of the rendered result. A valid file and correct extracted text establish delivery and content integrity, but do not establish visual quality. Our current `create_document` implementation accepts one plain-text body and title; `packages/integrations/src/document.ts` applies one body font/size and linear wrapping. The artifact skill explicitly describes plain paragraphs. The observed plain PDF is consistent with that interface, rather than evidence that the language model cannot design.

The strongest directly reusable office implementation found is Hermes's MIT document tooling. It has useful structured blocks and native editable Office output, but its basic PDF renderer still uses generic sample styles. OpenClaw contributes diagram composition and bounded PDF processing, not a bundled full office-authoring pipeline. Grok publicly promises styled office files by default; the publicly inspectable Grok Build code establishes document reading and skills infrastructure, not the implementation behind those consumer features.

## References pinned for reproducibility

| Project | Inspected revision | Local reference |
| --- | --- | --- |
| Hermes Agent | `158fd638da1629c8e62caf9ade1515d162def8ab` | `/tmp/hermes-document-design-reference` |
| OpenClaw | `da979df299e88c3711f6ee2cd3c7443dd045584b` | `/tmp/openclaw-harness-reference` |
| Grok Build | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` | `/tmp/grok-document-design-reference` |

The OpenClaw reference uses a partial checkout. Files absent from its working tree were inspected with `git show HEAD:<path>` and the complete tracked file list, rather than treating missing checkout files as missing capabilities. No upstream code was executed or copied into the product for this audit.

## Hermes: concrete authoring tools, with limits

The bundled [PDF skill](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/pdf/SKILL.md) creates documents from JSON containing headings, paragraphs, tables, images and page breaks. It separates creation from extraction, form filling and page editing. It recommends rasterizing pages and using vision inspection when layout matters, and directs precise HTML-to-PDF work to a browser renderer.

Its actual [pdf_create.py](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/pdf/scripts/pdf_create.py) uses ReportLab Platypus, sample heading/body styles, gray table grids and automatic pagination/page numbers. This is a real advance over an undifferentiated text body, but it is not a sophisticated design system: there is no general theme contract, editorial art direction or guaranteed review gate. Unknown element types are warned about and skipped. Adopting this helper unchanged would still allow visually generic output and silent content omissions.

The [PowerPoint skill](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/powerpoint/SKILL.md) supports layouts, formatted text, solid backgrounds, images, tables, shapes, charts, speaker notes and company templates. Its verification workflow reopens the output to inspect content, renders every slide and uses vision to identify overlap, truncation and color problems. The [render helper](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/powerpoint/scripts/pptx_render.py) runs LibreOffice to PDF and Poppler to PNG, with subprocess timeouts. However, missing render dependencies yield `rendered:false` with exit code zero; the skill then permits outline-only verification. That fallback is not adequate evidence for our requested default design quality.

The [DOCX skill](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/docx/SKILL.md) supports document styles, margins, headings, rich text runs, lists, tables, images, headers/footers, templates and fields. It keeps native editable content. Its package validator checks structural health, not visual layout or full OOXML schema compliance. PDF conversion requires LibreOffice; page and contents fields require a real office renderer to calculate their values. Its default verification is content/structure read-back, so an additional visual review stage is needed for designed documents.

An optional [finance presentation skill](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/optional-skills/finance/pptx-author/SKILL.md) adds useful editorial guidance: takeaway titles, one idea per slide, template inheritance and figures bound to source workbook cells. It identifies itself as adapted from Anthropic's Apache-2.0 financial-services work. This is separate from Hermes's bundled MIT office skills; its attribution must not be conflated with the latter.

For design direction, the optional [mono-color skill](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/optional-skills/creative/mono-color/SKILL.md) is more explicit: resolve a recipe containing layout, palette, typography, negative space, image role and visual focus; generate; inspect at full and thumbnail size; retry on concrete defects. Its text and JSON design catalogs are MIT, while the source artwork is explicitly excluded. This manifest-and-review pattern is useful. Its poster aesthetic and rigid ink limits should not become a universal report or slide theme.

## OpenClaw: useful assets and processing, not office parity

The pinned [PDF tool documentation](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/docs/tools/pdf.md) describes analysis of existing PDFs. Its extraction fallback renders pages only when they contain insufficient extractable text. Consequently, a text-rich but badly laid-out generated report may never produce an image for review. This analysis optimization cannot serve unchanged as a design acceptance gate.

The [document extraction runtime](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/extensions/document-extract/document-extractor.runtime.ts) is a useful reference for worker isolation, cancellation, page selection, aggregate pixel budgets and explicit partial-result metadata. For design review, every required page needs rendering irrespective of text density; the total image budget and review coverage should remain explicit.

The bundled [diagram-maker skill](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/skills/diagram-maker/SKILL.md) makes standalone SVG/HTML or editable Excalidraw assets. It plans layout before drawing, keeps labels concise, assigns colors by meaning and specifies padding and connector layering. This is directly relevant to diagrams embedded in reports. It does not assemble a PDF/DOCX/PPTX.

The [nano-pdf skill](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/skills/nano-pdf/SKILL.md) delegates edits to an existing page and asks for a sanity check. The [visualize skill](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/skills/visualize/SKILL.md) covers responsive interactive visuals/dashboard widgets, with theme and accessible-label conventions. Neither is evidence of a ready-made native office export system. The tracked bundled skills inspected did not include general DOCX/PPTX authoring skills; this finding does not cover every third-party ClawHub package.

## Grok/xAI: consumer capability versus public implementation

xAI's [May 18 skills announcement](https://x.ai/news/grok-skills) states that built-in skills create styled PDF, DOCX, PowerPoint and spreadsheet files without setup. It describes slide visual hierarchy and notes, and consistent Word headings/tables/list formatting. This supports using designed files as a product baseline. It does not publish those skill bodies, renderers or a visual-review algorithm.

The official [PowerPoint product page](https://x.ai/grok/powerpoint) describes editable slides, theme/master-layout matching and takeaway titles. The [PowerPoint announcement](https://x.ai/news/introducing-powerpoint-addin) adds research, diagrams and images; the [Word announcement](https://x.ai/news/introducing-word-addin) describes structured drafting and diagrams inside Word. These are documented user workflows, not reusable source components.

The public [Grok Build repository](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) is a coding-agent harness. The inspected tree has generic skill discovery plus [PDF reading/rendering](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/read_file/pdf.rs) and [PPTX text extraction](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/read_file/pptx.rs). PDF reading defaults to page images, with explicit text mode, byte/page limits and processing timeouts. That image-first review pattern is relevant. No bundled PDF/DOCX/PPTX authoring skill implementation was found in the tracked tree inspected; consumer Grok office generation remains a separate, unverified implementation.

The [API code-execution documentation](https://docs.x.ai/developers/tools/code-execution) describes sandboxed Python with constrained file access; [Files documentation](https://docs.x.ai/developers/files) principally describes attaching/searching existing documents. Neither alone establishes API parity with consumer office generation.

## Reuse candidates

| Candidate | Observed licensing | Recommended use |
| --- | --- | --- |
| Hermes `skills/productivity/{pdf,docx,powerpoint}/scripts` and corresponding tests | Each skill has its own MIT license, copyright 2026 Nous Research | Selectively adapt creation, native-file inspection and rendering helpers; preserve notices. Add our own input bounds, file ownership and visual completion policy. |
| Hermes `optional-skills/creative/mono-color/design-system/*.json` and recipe/review instructions | MIT, copyright 2026 Yan Liu; example artwork excluded | Model a declarative design brief/catalog mechanism; do not import its specific aesthetic as the default for all formats. |
| OpenClaw `diagram-maker` and `document-extract` source | Repository MIT, copyright 2026 OpenClaw Foundation; dependencies have separate notices | Diagram composition guidance and bounded renderer orchestration. Existing integration notices do not automatically cover newly copied assets/dependencies. |
| Grok Build PDF reading and skill plumbing | First-party Apache-2.0; third-party notices retained separately | Reference image-first document review. Rust transplantation is unnecessary for our TypeScript renderer; no office-authoring implementation identified. |

License evidence: [Hermes PDF](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/pdf/LICENSE), [DOCX](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/docx/LICENSE), [PowerPoint](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/skills/productivity/powerpoint/LICENSE), [mono-color](https://github.com/NousResearch/hermes-agent/blob/158fd638da1629c8e62caf9ade1515d162def8ab/optional-skills/creative/mono-color/LICENSE.txt), [OpenClaw](https://github.com/openclaw/openclaw/blob/da979df299e88c3711f6ee2cd3c7443dd045584b/LICENSE), [Grok Build](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/LICENSE). These are observed repository declarations, not an assertion that every external font/image/library is covered by that license.

## Proposed implementation direction

1. **Make design implicit in ordinary document requests.** Resolve audience, purpose, document type and visual direction from context. Choose sensible defaults without an extra questionnaire. Preserve explicit requests for plain/minimal output.
2. **Separate semantic content from presentation.** Add bounded structured blocks: heading, paragraph/rich text, list, table, image, diagram, chart, callout and deliberate page/slide break. Add theme tokens for typography, palette, spacing and page geometry. Keep plain text/Markdown exports available without pretending they contain rich layout.
3. **Use format-specific composition.** PDF needs print pagination and readable page hierarchy; DOCX needs actual named styles, native tables, headers and editable text; PPTX needs slide-level composition, native shapes/text, speaker notes and controlled density. A screenshot of a whole page is not an editable Office document.
4. **Treat assets as evidence-bearing inputs.** Use diagrams/charts when they explain the material, intentional illustrations when appropriate, and preserve user branding. Carry source/provenance and an asset identifier through generation; do not invent research figures or add filler imagery to meet a quota.
5. **Require render, inspect and repair.** Render all delivered pages/slides under a bounded pixel budget; inspect full pages plus a contact sheet for hierarchy and consistency. Check clipping, overlap, missing glyphs/assets, cramped tables, excessive density and blank accidental pages. Track covered page numbers. Missing renderer or unreviewed pages means visual quality is unverified, not passed.
6. **Bind acceptance to the final bytes.** Keep the existing operation ID, cancellation/revision barriers, scoped file ownership and durable delivery receipt. Add a visual-review record bound to the final file hash, renderer version, page count and review coverage. A later edit invalidates the review. Content extraction and native package checks remain independent requirements.

A useful first benchmark is the recovered Portuguese self-description report rendered in PDF, DOCX and PPTX with a coherent but format-appropriate visual identity, an explanatory architecture diagram, visible section hierarchy and verified editable Office content. Compare exported page images, not only XML/text. Include long Portuguese words/accents, a multipage table, a dense slide and a missing-asset case. This is a proposed acceptance fixture, not an upstream benchmark claim.
