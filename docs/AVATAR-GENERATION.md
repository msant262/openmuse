# Original plush companions

Avatar creation uses a dedicated Grok Imagine adapter, independently of the model selected for chat. `AVATAR_PROVIDER=auto` detects the protected Grok OAuth grant already used by OpenMuse. `grok` selects that adapter explicitly; `off` disables generation while preserving uploads and saved characters. No paid API-key fallback is selected implicitly.

The default image model is `grok-imagine-image-2.0`; the video model is `grok-imagine-video-1.5`. Override these with `AVATAR_IMAGE_MODEL` and `AVATAR_VIDEO_MODEL`. Credentials remain in the existing `GROK_AUTH_FILE` or `DATA_DIR/credentials/grok.json`, never in the client or executor. Without a grant the studio reports unavailable generation and accepts owned uploads. Account limits and entitlement failures are shown as actual failures.

The global art direction applies to every requested creature: original premium plush designs, compact harmonious silhouettes, tiny bead eyes, gentle faces, tactile short textile nap and soft studio lighting. The requested creature and colors remain free; creation does not select a predefined species, mesh or color variation.

## Workflow and persistence

1. `POST /api/agent/avatars/generations` with `{requestId,prompt,label?}` creates an owner-scoped durable job. One image request produces four actual candidate images.
2. `GET /api/agent/avatars/generations/:id` returns its status, phase, candidates and errors. `awaiting_selection` means the candidates are stored and can be selected.
3. `POST /api/agent/avatars/generations/:id/select` with `{requestId,assetId}` applies that candidate's still image and queues three state videos: `idle`, `working` and `responding`.
4. Before the working video, the image-edit endpoint creates a matching working still with headphones, laptop and tabletop. Each six-second video uses its state still as the first and last frame on video 1.5, a locked camera and `generate_audio:false`. Each motion retains its own poster.
5. Completed video bytes are imported into the owner's file store before a motion becomes available. The provider's temporary URLs are not exposed to the client. Owner-signed media URLs support byte ranges and refresh whenever the asset is read.

`GET /api/agent/avatars` supplies capability status, assets, recent generations and active selection. `POST /api/agent/avatars/:id/select` selects an existing asset without generating anything again. `POST /api/agent/avatars/default/select` restores the bundled companion while preserving the gallery. `POST /api/agent/avatars/import` accepts `{requestId,label,posterFileId,motions?}` using files uploaded through the existing file endpoint; every file is checked against the current owner and media signature. Existing `AvatarDesign` version 1 remains readable for compatibility.

Jobs retain provider video request IDs across restarts and retry GET/download operations against the same receipt. An image or video POST interrupted without a receipt becomes `uncertain` and is never repeated automatically. Explicit retry uses `POST /api/agent/avatars/generations/:id/retry`; uncertain outcomes require `acknowledgeUncertain:true` because another request can consume quota again. Repeating a successful request ID returns the existing operation. A failed video-session lookup can resume the same receipt after reconnection.

The embedded task worker runs media jobs; the existing worker lifecycle starts and drains them. New effects use shared work admission and stop during runtime pause or deployment maintenance. Accepted video receipts continue reconciling during maintenance, and active media work participates in backup readiness checks.

## Provider references

The [xAI subscription integration announcement](https://x.ai/news/grok-hermes) documents subscription access to image and video creation. [Image generation](https://docs.x.ai/developers/model-capabilities/images/generation), [JSON image editing](https://docs.x.ai/developers/model-capabilities/images/editing), [video generation](https://docs.x.ai/developers/model-capabilities/video/generation) and [first/last-frame control](https://docs.x.ai/developers/model-capabilities/video/reference-to-video#first--last-frame) define the adapter's HTTP contracts. Hosted image generation remains unavailable through [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations); this adapter does not route media through that flow.
