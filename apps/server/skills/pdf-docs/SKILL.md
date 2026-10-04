---
name: pdf-docs
description: Compose designed PDF reports and editable DOCX/Word documents with headings, tables, diagrams, owned illustrations and verified rendered pages. PDF, Word, relatório e documento profissional.
required-tools: [create_document]
---
# PDF and Word documents

Read `builtin:document-design`. Choose PDF for fixed pages or DOCX when the user requests editable Word content. Preserve the requested format. Compose the document in `create_document.content` with `format: "pdf"` or `"docx"`, optional title and supported design settings. Plain text output is appropriate only when that is the requested format.

Structure the narrative with real Markdown headings and paragraphs. Keep sections focused. Use lists for actual groups or sequences, blockquotes for a useful callout, Markdown tables for comparisons, and descriptive linked source labels. Avoid a long wall of equally styled paragraphs. Use a cover for a substantial report only when it helps orientation; a one-page brief should begin with its content.

Use these supported visual blocks when the content calls for them:

- An owned PNG/JPEG illustration on its own paragraph: `![Useful caption](file:FILE_ID)`. Source the file through current tools. Remote image URLs and raw HTML are not document input.
- A fenced `chart` JSON block with `title`, equal-length `labels` and numeric `values`, and optional `unit`, for verified quantitative data.
- A fenced `metrics` JSON block with `items` containing `label`, `value` and optional `detail`, for real key figures.
- A fenced `steps` JSON block with `items` containing `title` and optional `detail`, for a real sequence or process.

Do not invent data to use a visual block. An explanation of this assistant can use a simple truthful process sequence and capability comparison rather than decorative statistics. Read `read_runtime` for actual local facts. Verify time-sensitive external facts through sources and retain dates and caveats.

Keep tables narrow enough to read; split unrelated content instead of forcing many columns onto a page. Check that headings stay with the following content and page breaks leave complete sections. DOCX should retain editable headings, paragraphs, lists and tables. A screenshot of prose does not satisfy an editable document request.

Create, render with `inspect_document`, inspect the actual pages and confirm each batch with `confirm_document_review` on a subsequent worker turn. Repair missing content and visible defects with `create_document`, a fresh `operationId` and `replaceFileId` pointing to the task's previous draft; review the replacement. Then `finish_task` delivers the final owned attachment.
