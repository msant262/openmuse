# Server document authoring and delivery

Reference examined: `/tmp/openclaw-harness-reference`, commit `da979df299e88c3711f6ee2cd3c7443dd045584b` (read-only).

## Concrete upstream patterns

- `src/agents/core-coding-tools.ts:367` composes workspace write/edit tools; `:415` composes exec. These provide general file and program execution rather than a first-class PDF renderer.
- `src/agents/sessions/tools/file-write-verification.ts:12` verifies the persisted file type, byte count and exact UTF-8 readback. `write.ts:379` uses that proof for interrupted-write recovery; `:446` checks normal writes before reporting success. The reusable behavior is evidence from actual persisted bytes, not a successful-looking model statement.
- `src/agents/tools/media-generate-result-shared.ts:15` carries structured attachment references through both foreground results and completion metadata. `generated-attachments.ts` distinguishes safe display text from actual attachment references.

No OpenClaw PDF implementation or unrestricted host execution was copied into this change. OpenMuse already owns file publication intentions, owner checks, task/revision barriers, journal recovery and originating-chat publication. Replacing those with an upstream path writer would discard existing authority and recovery guarantees.

## Implemented behavior

`create_document` is a common `mediaTools` tool, available to chat and the task worker. Chat uses the existing durable-effect delegation path. The worker creates PDF, text or Markdown files locally and returns a real `Files.reference`; the existing artifact callback records the file on the task and completion publishes it to the originating conversation. No browser, source form, email or remote computer is involved.

The schema bounds content to 120000 UTF-16 code units, filenames to 120 and titles to 200. Control characters, malformed Unicode and empty text are rejected. PDF layout wraps paragraphs and long words, paginates up to 100 pages, and embeds licensed DejaVu Sans for Portuguese and other supported Unicode characters. Unsupported glyphs fail explicitly rather than disappear. Text and Markdown preserve the supplied UTF-8 bytes. PDF is intentionally plain paragraph layout, not HTML/Markdown rendering.

Rendering is deterministic across a publication retry. A document intention binds owner-scoped operation identity to the complete request. Existing `Files` publication hashes and task effect barriers remain authoritative; persisted bytes are read back and hashed before a success reference is returned. `create_document` is included in file reconciliation, and uncertain publication errors remain uncertain in the tool receipt.

PDF completion previously checked only AcroForm values. It now also extracts actual page text with PDF.js when explicit content requirements need it; title, subject and other metadata cannot satisfy those requirements. Existing form-value checks remain. PDF inspection still enforces 10 MiB/500 pages; extracted text is capped at one million characters. Scanned-image text is not OCRed.

`build:server` copies fonts, their license and bundled skill documents into matching `dist` paths, which the existing Docker runtime copy includes. PDF-LIB/fontkit usage follows the [official custom-font API](https://pdf-lib.js.org/docs/api/classes/pdfdocument#registerfontkit); PDF.js is pinned as a runtime dependency. No host-system fonts are required.

## Verification

Initial tests failed because the tool was absent, normal PDF text could not satisfy criteria, and the worker could not produce an attachment. The seven new tests then passed with actual PDF bytes, Portuguese/Greek text, pagination, long-word wrapping, exact UTF-8/Markdown content, unsupported-input bounds, owner isolation, idempotency, metadata-only rejection, crash reconciliation, and chat-to-worker-to-originating-conversation delivery. Existing PDF/file/verifier/recovery suites and compiled asset smoke checks are run separately before integration.
