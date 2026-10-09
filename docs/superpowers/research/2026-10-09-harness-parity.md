# Harness parity and ordinary-task acceptance — 2026-10-09

The user's acceptance requires complete research, real document delivery, robust name lookup and the tools used by Hermes/OpenClaw. **Whole-harness acceptance remains open.** Source presence, aliases, fixture-model tests and individual passing chats do not establish complete parity or perfect model behavior.

## Reference scope

Readonly source snapshots: Hermes `e0550c97bbd916cd5ff8fa0450e6291c31921b94`, OpenClaw `432ade6f500de6cdb0bcd4b0948a07bf466672f1`. The checked-in loop remains original OpenClaw at `b56ae70a5e7e302dc2165c96b60214e84e19c7b1`. No upstream product was installed. The accompanying JSON preserves Hermes's 55 literal core tools and OpenClaw source-name observations, with their limitations. Hermes check functions and OpenClaw embedded mode gate some surfaces; optional plugins are not automatically installed tools.

Primary sources: [Hermes core toolsets](https://github.com/NousResearch/hermes-agent/blob/e0550c97bbd916cd5ff8fa0450e6291c31921b94/toolsets.py), [OpenClaw tool assembly](https://github.com/openclaw/openclaw/blob/432ade6f500de6cdb0bcd4b0948a07bf466672f1/src/agents/openclaw-tools.ts).

## Reproduced production failure

A new ordinary chat received only: `Me manda de novo o PDF da trilha de cursos de IA que você preparou.` With configured Luna, it searched the computer and the history, then asked the person to reupload or recreate the PDF. The app actually held 58 visible files, including two `Trilha-de-cursos-de-IA-Beatriz.pdf` records. One was the final attachment of a succeeded original task. The claim that the PDF was unavailable was unsupported.

A prior paused delivery tried `export_computer_file` on `/workspace`. The native read rejected a directory with `ValueError: File operation requires a file path`, but classified the synchronous read failure as `outcome_unknown`, freezing the task as if a write might have been dispatched.

## Implemented repairs

- `search_saved_files`: owner-scoped app library search, task provenance, final-delivery priority, accents/spacing/partial terms and explicitly marked approximate candidates; presentation pagination does not imply a full list was returned.
- `read_saved_file`: actual PDF page text, OOXML content and UTF-8, with recoverable character offsets. Metadata is not document content. Search and read do not attach files.
- `attach_saved_file`: reattaches existing bytes after owner/visibility checks and hashes them; no regeneration or duplicate file. The current task receives an actual attachment receipt.
- Reuse of full visual review requires the original task to have succeeded with verified completion, the same final artifact, matching original revision and unchanged bytes. Current delivery must have its own successful attachment operation. New/unreviewed/changed documents retain the review requirement.
- `view_file` renders selected PDF pages as private pixel previews, including uploaded scans. It does not replace the authoring-review protocol.
- Computer file reads/exports reject the workspace directory before native dispatch. Native synchronous file inspection failures settle as failed with cleanup confirmation; writes, commands and graphical operations retain their uncertainty protections.
- Drive folder lookup falls back to a fully paginated folder index only after all selected account queries confirm absence. Approximate names are candidates requiring content/context confirmation, not automatic identity. OAuth/account/provider errors retain partial coverage.
- Optional `execute_code` uses the unchanged original OpenClaw headless Code Mode worker and tool bridge. Its current capability catalog contains run-scoped read tools, each dispatched through the normal host/journal boundary with actual results. It exposes no server process, imports, credentials or filesystem; writes keep their ordinary tools and approval policy. It stops child dispatch after task pause/termination. This is read/computation RPC, not full Hermes Python-kernel or browser-exec parity.
- Saved-file instructions are separate from document-authoring instructions, so a direct lookup does not load PDF/Office creation rules into unrelated image tasks.
- Drive counts distinguish files, folders and shortcuts across all provider pages before limiting the displayed shortlist. Approximate-folder telemetry includes the actual index scanned.
- Explicit free-access recommendations receive a focused source/content review even when optional broad research review is off. It uses the currently selected model with no review fallback or image round, distinguishes full access from free registration/trials and optional certificates, and sends specific repair steps back to the worker. Ordinary lookups retain zero review calls. Selected replacement artifacts are reviewed without discarded drafts.

## Capability comparison

| Upstream capability | Existing/added Okami host surface | Remaining proof or gap |
| --- | --- | --- |
| Web search/extraction | `search_web`, `web_fetch`, `web_extract`, complete-data `read_web_data` | Ordinary research plus delivered report acceptance required |
| Shell/Python and process lifecycle | `run_computer_command`, status/cancel, persisted receipts; original `execute_code` read RPC | Native availability and real command proof; full Python RPC and mutation RPC remain distinct |
| Files and PDF/image reading | Computer read/write/import/export, new saved-file search/read/attach, `view_file` PDF pixels | Standalone patch/search-files parity is not established merely by shell fallback |
| Creative images | `generate_image`, connected-provider status, `view_file` | Prior factual map acceptance failed/slow; a lookup fix does not approve it |
| History | `search_past_threads`, `read_past_thread`, durable task evidence and preserved tool outputs | Native session administration/agent catalog is not equivalent to history lookup |
| Memory and skills | Typed personal memory, skills list/search/read, saved procedures, automatic learning | Current normal-chat recall and automatic procedure learning need separate acceptance |
| Browser interaction | Navigate/snapshot, click/fill/select/press/scroll, screenshots, owned upload/download, human control | Browser back, console, raw CDP, dialog handling and programmatic browser execution remain distinct gaps |
| Secrets/accounts | Private credential forms/storage, owned connection and OAuth tools | Raw vault export/unlock is not implemented by an account-list alias |
| Plans/delegation/schedules | Todos, child task delegation/wait, goals, routines and proactivity | Full dispatcher kanban, cross-session messaging and gateway administration are not proven equivalents |
| Voice/video/music | Transcription and some existing provider media adapters | Agent TTS/video/music-generation tool parity remains open; no silent billed provider fallback |
| Upstream admin/UI/plugin surfaces | Existing app settings and connector discovery | Nodes/gateway/mobile/theme/plugin/portal tools require explicit adapters; not provided by copying names |

## Validation and publication

The broad pre-publication run executed 1,655 tests: 1,653 passed, and two instruction-isolation tests failed. Those failures exposed eager PDF authoring instructions and were corrected without relaxing the assertions. The final image-isolation rerun passed 2/2. The affected integration regression group executed 79 tests; its large-output failure exposed a native signature collision in the new Code Mode bridge. After correcting the argument boundary, the final harness/document/verification group passed 39/39, including the large-output and all three Code Mode tests. Counts overlap and must not be summed. Root TypeScript, copied-harness build/hash verification and changed-file Biome checks passed. Native Python contracts/corrections/media passed 64/64.

The final broad root/mobile run passed 1,658/1,658. Subsequent Drive-count and access-selection changes have their own focused regression runs; the broad count must not be presented as covering tests added after that run started.
Drive/Workspace/harness regression passed 33/33. Research/review/default-image regression passed 46/46 after the access gate and selected-artifact filter, including red-before-fix checks for unconfirmed free access and discarded drafts. The configured default image path still performs zero broad review calls. Root TypeScript passed after these changes.

Commit `3c221654` was published through guarded API/native handoff. Native journal entries remained 918 before/after; configuration and database were preserved. API shutdown exited zero. Thirty-two historical uncertain operations were preserved, not cleared to make readiness appear clean.

## Ordinary production chats after first publication

All use the configured `chatgpt/gpt-6-luna`, new conversations, ordinary requests, no tool-name hints and no operator-provided lookup results.

- `Me manda de novo o PDF da trilha de cursos de IA que você preparou.` The worker completed in 22.7 seconds, searched and read the saved library, then reattached the original file without regeneration or a question. Downloaded 85,272 actual PDF bytes matched the attachment receipt SHA-256 `6f3d1384baab118f9e3860fffbe6c88984c6ef3377fbe86d113af04dba17d607`. The original user artifact is preserved.
- `Veja quantos arquivos tem na pasta MOVIGN DE do meu Drive e me diga em qual conta está.` Lookup found `MovingDE` in the owning account and listed children in 15.6 seconds. It reported 35 combined items, while the observed inventory has 29 files and 6 folders. Location/typo recovery passed; precise requested file-count acceptance requires the new count fields and a repeat chat.
- `Pesquise três cursos gratuitos para começar em IA generativa e me entregue um PDF comparando conteúdo, idioma, duração e se o certificado é pago. Coloque os links das fontes.` The worker produced and visually reviewed a three-page PDF, then marked success after 174 seconds. **Acceptance failed:** one selected course had unconfirmed full free access, and some conditions were supported only by a historical article. File and pixel verification cannot establish selection eligibility. This observed failure led to the focused access review; a normal production repeat is required before accepting this repair.

The next guarded server publication and remaining capability acceptance are pending. Diagnostic conversations/devices/files belong only to this run; original user data, Google accounts, companions and historical uncertain effects must be preserved. **Whole-harness acceptance remains open.**
