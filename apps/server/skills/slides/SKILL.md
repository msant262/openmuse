---
name: slides
description: Create designed, editable PowerPoint/PPTX presentations with a clear narrative, varied meaningful visual layouts and rendered slide review. Slides, deck, apresentação e PowerPoint.
required-tools: [create_document]
---
# Editable presentations

Read `builtin:document-design`. Use `create_document` with `format: "pptx"` for a PowerPoint request. Choose an available visual profile through `design_references`; adapt emphasis and content to the audience rather than making every presentation look identical.

Build a narrative, not a report split mechanically into screens. Give each section a meaningful heading and one main point. Use `#` or `##` headings to start a titled section, `###` for an inline subheading, and a standalone `---` to end the current text slide. Paragraphs and lists flow onto readable continuation slides; charts, tables, quotes, metrics, steps and images get their corresponding layouts. Compose concise text and use supported `chart`, `metrics` and `steps` blocks or owned PNG/JPEG figures when they explain the point. Keep related content together and preserve a readable amount of information per slide.

Plan the actual slide count from these layout rules. A figure gets its own slide: place a brief takeaway after the table/chart/process so it can share the figure's slide; avoid inserting an introductory prose slide before every figure. A text section can share several short paragraphs or list items. Use the `title` and optional cover settings once instead of repeating the title as a body-only section. For a six-to-eight-slide deck, plan six-to-eight content units, accounting for a cover and any figure continuations. After rendering, remove unnecessary dividers and condense wording if automatic continuations exceed the requested count.

Text slides use a title column and a wider body column. Start with a short heading and about 60–90 words of body text, usually two to four concise points; this is a composition guide, not an exact page limit. Keep detailed inventories and repeated caveats out of the slide body. State a shared limitation once, near the relevant claim. Budget a five-step process with a paragraph of commentary as two slides. If the rendered deck is longer than requested, shorten the dense sections and remove repeated explanations before regenerating; changing heading levels alone does not reduce the amount of content.

Adjacent section headings share a hierarchy on the next content slide. Use an explicit `---` after a heading only when an intentional divider slide serves the narrative. A short warning alone on a continuation slide usually belongs with a more concise version of the preceding content.

Balanced continuations are valid: a longer process may span two slides with the same section title and different numbered steps. Check the actual step numbers and content before calling this duplication. Repair concrete defects such as clipped text, overlaps, unreadable labels, missing content or isolated trailing fragments. Once the deck meets the requested scope and is readable, preserve working layouts instead of recreating the file for successive stylistic variations. Review comments must describe pages visible in that receipt; do not reconfirm a superseded draft as a way to review the current file.

Use visual variation where it serves content: quantitative comparison, key finding, process, image-led explanation or compact table. Keep type, colors and spacing consistent across these layouts. Prefer native editable text, shapes, tables and charts where the renderer supports them. Do not flatten the entire deck into screenshots or claim an image is an editable chart.

Keep speaker detail out of crowded slide bodies. If a slide becomes dense, shorten wording, split the topic or choose a clearer visual structure before reducing type. Figures must carry correct units, captions and sources. Never invent values, brand assets or testimonial content to fill space.

Render the resulting deck with `inspect_document`. Inspect every actual slide for cropping, text overflow, cramped labels, overlapping shapes, poor contrast, inconsistent margins and source/footer collisions. Check that visuals remain readable at presentation size. Record each batch through `confirm_document_review` only after receiving its pixels in the following worker turn. To repair, use `create_document` with a fresh `operationId` and `replaceFileId` referencing the task's previous deck, then review the replacement.

Finish only when the complete final deck exists and all of its slides have passed review. Deliver the editable PPTX requested by the user, with any separately requested PDF companion handled as its own file and review.
