---
name: artifacts
description: Create and deliver actual PDF documents, text or Markdown files and image infographics. Gerar e entregar PDF, documento, arquivo, imagem e infográfico.
required-tools: [create_document]
---
# Create and deliver the requested artifact

Establish the requested format and content from the user's request and existing context. Proceed with reasonable layout choices; ask only for missing facts that prevent useful work.

Use the actual registered tools. In chat, creation tools queue a durable task and return a task card. In a worker they perform the operation and return its receipt. A queued task is not the finished artifact.

For PDF, text or Markdown, use `create_document` when registered. Supply the complete composed `content`, a descriptive `name`, optional `title`, the `format` and a stable `operationId`. PDF content is text with paragraphs and line breaks, rendered across pages automatically. Text and Markdown preserve their content. Do not pass instructions to write a document in place of its content. New documents need no email, source PDF, browser or native computer.

For an image, poster or infographic, use `image_generation_status` and `generate_image`. Keep verified facts, dates and source labels in the visual prompt. Image generation is independent of the chat model; use the selected connected provider and its real receipt.

Research only facts that require outside verification. For a document about this assistant, read `read_runtime` and the relevant installed workflows or saved procedures. Do not substitute documentation about another product for this app's capabilities.

When a format or layout exceeds a direct creation tool, inspect `computer_status` before choosing an available computer workflow. Export the finished file with an appropriate file tool. Do not claim a tool is connected merely because it is listed.

Inspect the successful file receipt: file identity, name, MIME type and size. In a worker, use `finish_task` only after the requested artifact exists. The runtime publishes owned attachments into the originating conversation. A text outline or a promise to attach later does not satisfy an artifact request. Never repeat a pending or uncertain media operation automatically.
