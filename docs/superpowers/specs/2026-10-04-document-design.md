# Designed document authoring

The user rejected the plain four-page PDF and requested appropriate visual design
for PDF, PPTX and DOCX, with reusable public harness/skill practices and an actual
integration of VoltAgent's awesome-design-md catalog. The task is authorized as
an implementation and deployment continuation; no further style questionnaire
is needed to establish that scope.

The former renderer could only draw a title and uniformly styled text. Its skill
explicitly described plain paragraphs, while acceptance checked file/content
integrity without judging composition. A second defect prevented generated
64-character image IDs from entering the model's image input. Both rendering
capability and the completion workflow need to change.

## Architecture

- Bundle all 74 pinned VoltAgent DESIGN.md references with MIT provenance and
  bounded discovery/read. Eight source-traced profiles provide practical paper,
  ink, surface, accent and type-family roles. References inform purpose-specific
  composition; they do not authorize code execution or imply brand endorsement.
- Parse complete Markdown into native headings, rich text, lists, tables,
  quotations, owned images and bounded data-driven chart/metrics/steps blocks.
  No arbitrary HTML, remote asset fetching or installed brand fonts are implied.
- Produce native designed PDFs and editable DOCX/PPTX. Use consistent type scales,
  measured pagination, repeating table headers, meaningful diagrams and exact
  chart quantities. Keep short documents compact; covers are optional.
- Use local LibreOffice for generated Office previews and PDF.js/Canvas for page
  images. Rendering is serialized, bounded, cancellable and independent of the
  personal desktop executor. Only server-authored owned documents enter this path.
- `inspect_document` returns a contact sheet of one to four actual pages. The
  provider records which pixels reached a completed inference before allowing
  `confirm_document_review`. Completion covers all pages of the exact document
  hash and current task revision. This proves a model visual assessment occurred;
  it is not an objective aesthetic score.
- Corrections use a fresh operation with `replaceFileId`, scoped to the current
  task's own draft. The old file is preserved, while only its replacement remains
  in task deliverables. Reconciliation restores generation metadata and excludes
  internal preview images from publication and the user's file list.

## Sources and adaptation

The two research notes under `docs/superpowers/research/2026-10-04-document-design-*`
distinguish public source from vendor capability announcements and proprietary
internals. OpenAI's Apache document workflows and Anthropic's Apache frontend
design guidance inform the installed skills. Anthropic's proprietary PDF/PPTX/
DOCX source is not copied. The supplied community Claude Design skill is reviewed
as a community reference, without treating its internal-prompt claims as vendor
authority. Attribution and licenses ship in `third_party/document-skills`.

## Acceptance

Require semantic preservation, editable Office objects, stable operation replay,
owner isolation, crash recovery, revision-bound visual review, full page coverage,
and no delivery of failed drafts or internal previews. Render and inspect actual
PDF, DOCX and PPTX examples with contrasting profiles. Fix visible defects before
the connected-provider test. Then exercise chat → durable worker → rendered
review → originating attachment with real configured models in an isolated test
database, publish the tested revision and replace the poor original PDF through
normal task controls. Preserve failure evidence and state remaining limits.
