# Self-hosted model backends

OpenMuse owns its agent loop, tools and durable history. Select `AGENT_BACKEND=model` and `MODEL=provider/model-id`. Both chat and delegated tasks use the same resolver. Demo/sample agents and the original `openai/`, `anthropic/`, `google/` (`gemini/`) providers continue to work.

| Provider | Credentials | API |
| --- | --- | --- |
| `chatgpt/` | Official Sign in with ChatGPT credential file | Public Responses, streaming, `store:false` |
| `grok/`, `xai-oauth/` | Grok device login credential file | xAI Responses, subscription bearer |
| `mimo/` | Dedicated Xiaomi Token Plan URL and key | Responses or Chat Completions |
| `local/`, `ollama/`, `llamacpp/` | Optional local gateway key | Chat Completions or Responses |
| `compatible/` | Configured endpoint and optional key | Chat Completions or Responses |
| `openai/`, `anthropic/`, `google/` | Existing provider API keys | Existing SDKs; independently billed |

Subscription providers never fall through to an API key. To use a billed provider, select it explicitly in `MODEL` or the fallback list. No OpenAI/Anthropic/Google key is required for local, SIWC, Grok, or MiMo Token Plan use. `compatible/` is a protocol adapter; billing depends on the endpoint you configure.

## Ordered fallback

```dotenv
AGENT_BACKEND=model
MODEL=chatgpt/your-account-model-slug
MODEL_FALLBACKS=grok/your-account-model-id,mimo/your-plan-model-id
```

Fallback switches the current inference after an admission/network/usage failure, before a successful HTTP stream opens. Candidates must satisfy the request's tools, vision, structured output and context requirements. Each receives the current full history. Completed tools are never reexecuted by pre-admission fallback. Invalid configuration, unsupported input and cancellation stop without trying another model. Once a fallback succeeds, later steps in that run continue from it and may advance further. A new run considers the configured primary again, subject to shared health/cooldown.

Streaming acceptance is distinct from completion: Responses requires `response.completed` with completed status and a successfully exhausted stream. Chat Completions requires an explicit `stop`, `tool_calls` or legacy `function_call` finish reason; `length` and `content_filter` preserve an incomplete result. Verification follows known streaming request semantics and cannot be disabled by a missing, incorrect or differently cased response Content-Type. Genuine non-streaming structured JSON remains supported. Clean EOF, `response.incomplete`, `response.failed`, late failure and socket loss never confirm success. Tool fragments are buffered until completion; a complete-looking argument fragment is never an effect authorization. Visible text is retained. After an accepted interruption, the run stops without restarting its turn. The task is saved as `waiting_provider`, with `task.state.providerCheckpoint` carrying validated AG-UI input history, completed tool IDs/results and partial public text. No hydrated image bytes, reasoning or provider metadata enter this checkpoint. The durable actor must consume its operation journal and this checkpoint before automatic continuation; this provider milestone alone does not claim restart/replay acceptance.

The AG-UI `openmuse.model` event records every selected provider/model and whether a fallback occurred, without credentials or endpoint URLs. Chat shows a discreet notice; Apps shows active selection and safe Portuguese temporary-unavailability messages. A provider failure does not disconnect OpenMuse or other connectors. ChatGPT usage errors retain the fixed Usage settings link.

## Capabilities and inference quota

```dotenv
MODEL_QUOTA_SCOPE=process
MODEL_PROVIDER_QUOTAS={"chatgpt":{"total":4},"grok":{"total":4},"mimo":{"total":4}}
MODEL_CAPABILITIES={"chatgpt/gpt-6-luna":{"tools":true,"vision":true,"structuredOutput":true,"contextTokens":1050000}}
MODEL_MAX_ATTEMPTS=3
MODEL_DEADLINE_MS=300000
MODEL_ATTEMPT_TIMEOUT_MS=60000
MODEL_COOLDOWN_MS=200
MODEL_IMAGE_CONTEXT_TOKENS=8192
```

`contextTokens` describes the model's real context window. It is not a spending, latency or history-retention budget. GPT-6 Luna's documented window is [1,050,000 tokens](https://developers.openai.com/api/docs/models/gpt-6-luna); the example above declares that window. Declare each additional model's verified window separately rather than copying one value across providers. Account catalog metadata is registered when available; an explicit declaration takes precedence. An older 131,072-token operational budget in this deployment was incorrectly used as Luna's capacity and is superseded by the current declaration.

Use the model IDs and limits supported by the selected account/endpoint. Model declarations are Zod-validated operator configuration, not proof of account access. Unspecified models retain the existing text/tool/schema wire compatibility assumption with a finite 32768-token context bound; vision defaults to false. Public status labels this `compatibility_assumption`, distinct from `declared` or an explicit validated preflight result. `ModelRouter.confirmCapabilities` accepts an actual preflight result; it does not invent a catalog or probe an undocumented route. Select the SIWC model from `pnpm auth chatgpt models`; an environment-selected ID alone does not establish availability. The copied native harness estimates actual request context, including tools and images, and uses the selected model's window for admission and compaction. A native regression preserves a request above 200,000 estimated tokens with a declared 1,050,000-token window. It is a local protocol test, not an account-specific million-token load test. Transport base64 is never counted as ordinary text or stripped from dispatch. Canonical history remains saved, and OpenClaw owns compaction and context-overflow recovery. Screenshot/file image promotion requires an explicitly vision-capable model.

One router and provider health pool serve independently constructed chat/task adapters in the chosen deployment: one API process with the embedded TaskWorker and PGlite. Inference quota is separate from the four global background work units. The default per-provider bound is three background calls and one interactive call; configure a lower `total`, `background` (1–3), or `interactive` (1). Provider aliases share their seats. For total ≥2, background is capped to reserve a chat seat; at total=1, idle background is admitted and queued chat receives the next free seat. Active inference is never canceled just because chat arrives, so quota one cannot promise an immediate reply. A measured concurrency bound can reduce the pool through `ModelRouter.observeQuota`; request/token-per-minute limits are never mistaken for concurrency limits.

These leases are process-local. PostgreSQL and the standalone worker remain supported, but multiple API/worker processes do not share an account's inference pool. Operators must divide that account's budget explicitly among processes or supply a future shared admission adapter. `MODEL_QUOTA_SCOPE=shared` fails at startup with an explicit diagnostic; it cannot silently claim a shared quota. Public runtime status also reports `quotaScope: process`.

Retries are centralized: SDK retries are zero; `MODEL_MAX_ATTEMPTS` bounds total attempts across candidates, and the same overall deadline covers queueing and failover. A per-attempt timeout leaves budget for another candidate. Admission, retry and exhausted-attempt diagnostics use the same canonical capability/context filter, including preflight declarations. Incapable healthy fallbacks cannot mask a capable model's rate limit or erase its wake-up time. Shared model cooldown honors numeric/date `Retry-After`; long waits park the work instead of looping. Models in cooldown are excluded across new adapters. Streaming and non-streaming structured output use the same capability filter and inference seats; SIWC remains on its streaming-only Responses route. No retries or capability changes authorize an external effect.

## Continue with ChatGPT on a laptop

The CLI implements the official public-client flow: dynamic agent registration, loopback OAuth with PKCE/state/nonce, JWKS signature and identity validation, and plan-use scopes. It uses neither an API key nor a client secret. Sign-in grants model access under the selected account/workspace, without importing ChatGPT conversations. [Official OSS overview](https://developers.openai.com/siwc/token-sharing-open-source), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

Install this fork and dependencies on your laptop, then:

```bash
pnpm install
pnpm auth chatgpt login
pnpm auth chatgpt status
pnpm auth chatgpt models
```

Open the printed **Continue with ChatGPT** link on that same laptop. Its listener binds `127.0.0.1:1455/auth/callback` before opening the system browser. If the port is occupied, use `--port 0` to select a free port. `--no-browser` prints the link without opening it. The CLI deliberately omits optional ID-token login hints, keeping tokens out of the printed URL.

Approve use of your ChatGPT plan. `status` shows whether that permission was granted; identity-only sign-in cannot perform inference. Choose a model slug from `models`, which reads your account's live catalog. Each registration retains its issued client ID and verified subject, including after a session expires. Reauthorizing the same record reuses that client and host identity. For a different account/workspace, choose a different `--file` and set `CHATGPT_AUTH_FILE` to that record. Registrations with identical email addresses are kept separate. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Transfer the selected registration to the VPS

Default credentials live in `DATA_DIR/credentials/chatgpt.json`; runtime host identity is separately stored in `DATA_DIR/credentials/host.json`. Files are owner-only, directories are protected, writes are atomic, and symlinks are rejected. Keep this directory outside source control. Custom paths use `CHATGPT_AUTH_FILE` and `GROK_AUTH_FILE`.

On the VPS, initialize its independent host identity before importing:

```bash
pnpm auth chatgpt host
```

From the laptop, copy **only the selected credential record**, using SSH:

```bash
scp .openmuse/credentials/chatgpt.json user@your-vps:/tmp/openmuse-chatgpt-import.json
```

On the VPS as the OpenMuse service user:

```bash
chmod 600 /tmp/openmuse-chatgpt-import.json
pnpm auth chatgpt import /tmp/openmuse-chatgpt-import.json
rm /tmp/openmuse-chatgpt-import.json
pnpm auth chatgpt status
pnpm auth chatgpt models
```

Import preserves the VM's existing host ID instead of adopting the laptop's copied ID. Do not copy the laptop's `host.json`. After transferring, let the VPS own all refreshes; stop using that same rotating session on the laptop. API and optional standalone task worker on the VPS must share the credential volume and Unix owner. A process-shared lock prevents refresh-token races. Only initialize or import credentials in an operator environment; credentials are never passed into the agent's computer/browser. [Official self-hosted VM procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

Access tokens last one hour. The running API/task worker checks expiry each minute and refreshes near expiry even while idle, honoring `earliest_refresh_at`. Successful refresh atomically replaces the rotating token set. Transient failures preserve credentials; terminal refresh errors clear unusable tokens while retaining the registration for reauthorization. CLI login/import/status do not open the application database or require the server access/encryption keys. [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference).

SIWC uses `https://api.openai.com/v1/responses`, `store:false`, `stream:true`, instructions/developer messages, full local history, and namespace-grouped client function tools. It strips fields rejected by the preview and preserves namespace names on tool-call replay. Supported still images remain available when the selected model supports them. Audio/video input, transcription APIs, hosted image generation, hosted MCP and native computer tools are unavailable through this path; OpenMuse's local function tools can implement those tasks separately. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Usage-limit failures link to ChatGPT Usage settings in the mobile chat. The app exposes **Manage ChatGPT usage**, preserving history. No reset time or remaining allowance is inferred. Region/account/workspace and preview-route access may reject an otherwise valid login; check the surfaced status/code and the official recovery guide. [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

## Grok device login

```bash
pnpm auth grok login
pnpm auth grok status
```

Run on the VPS, then open the printed xAI verification URL on your phone or laptop and enter the code. No laptop callback, SSH tunnel or credential transfer is needed. Set `MODEL=grok/your-model-id`; `grok-4.6` is the model used in the currently researched Hermes guide, subject to your account's availability. Runtime refresh uses the rotating subscription grant. `XAI_API_KEY` is never read by this provider.

The implementation adapts Nous Research's published device flow at commit `e05b16348b1d06a3311237423b0a4fc30d9c5aa1`: public OIDC discovery on `auth.x.ai`, the published device endpoint/client/scopes, RFC8628 polling, and discovered token endpoint. Endpoint origins are validated again before refresh and redirects are rejected. Short-lived tokens use a bounded refresh lead time. xAI may deny OAuth API access by subscription tier even after device login; a 403 is surfaced without looping through login or silently substituting a billed key. [xAI announcement](https://x.ai/news/grok-hermes), [Hermes auth source](https://github.com/NousResearch/hermes-agent/blob/e05b16348b1d06a3311237423b0a4fc30d9c5aa1/hermes_cli/auth_xai.py), [Hermes guide](https://github.com/NousResearch/hermes-agent/blob/e05b16348b1d06a3311237423b0a4fc30d9c5aa1/website/docs/guides/xai-grok-oauth.md). The original [Nous MIT notice](licenses/HERMES-MIT.txt) is retained.

## Xiaomi MiMo Token Plan

```dotenv
MODEL=mimo/mimo-v2.5-pro
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-dedicated-plan-key
MIMO_API=responses
```

Copy the exact regional URL/key and supported model from the Xiaomi subscription dashboard. The `mimo/` provider rejects the regular pay-per-token endpoint. `MIMO_API=chat-completions` is also available; Responses is the default. [Xiaomi's official integration guide](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/codex.md), [Cursor/Token Plan guide](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/cursor.md).

## Local and generic compatible endpoints

```dotenv
MODEL=local/your-installed-model
LOCAL_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_API=chat-completions
# LOCAL_API_KEY=optional-gateway-key
```

Install an Ollama model separately or point `LOCAL_BASE_URL` at llama.cpp's compatible server. In containers, the URL must reach the model host from the server container. Budget the model's RAM separately from the browser/computer limits; an external model host is also supported.

For any compatible service, use `MODEL=compatible/model-id` and `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY`, and `OPENAI_COMPATIBLE_API=chat-completions|responses`. IDs such as `vendor/model:tag` are passed intact. Keyless endpoints do not require an OpenAI key. Protocol selection is explicit; no probing request is replayed across APIs.

Image generation is an installed computer/media tool. The provider adapter remains disabled until an operator sets `OPENAI_IMAGE_MODEL`, `GROK_IMAGE_MODEL`, `OPENAI_COMPATIBLE_IMAGE_MODEL`, or `LOCAL_IMAGE_MODEL` for an endpoint that actually supports `/images/generations`. Ordinary Ollama/llama.cpp text servers do not provide that route. SIWC and MiMo never advertise hosted image generation. Explicit OpenAI image selection uses the separately billed API key; Grok uses its protected subscription bearer, subject to xAI eligibility. Still-image **input** is a separate, model-dependent capability.

Automated checks use mock OAuth endpoints, generated JWKS signatures and real TanStack tool/stream conversion. Subscription login, inference, tier/region eligibility, MiMo plan access, installed local models and image endpoints require operator accounts/services and are not claimed as live-verified.
