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
MODEL_FALLBACKS=mimo/mimo-v2.5-pro,local/your-installed-model
```

Fallback switches only the current model request after an admission/network/usage failure, before a successful HTTP stream opens. Each candidate receives the current full tool/history context. Completed tools are never reexecuted by fallback. A stream interrupted after acceptance stops the run, keeping completed tool results; send a follow-up to continue. Invalid configuration, unsupported input, and cancellation stop without trying another model. Once a fallback succeeds, later steps in that run continue from it and may advance further. A new run starts with the configured primary again.

The AG-UI `openmuse.model` event records fallback provider/model selection without credentials or endpoint URLs. SDK retries stay bounded for the existing providers and compatible endpoints. Subscription inference does not blindly retry an admission error; an explicitly ordered fallback can handle it.

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
