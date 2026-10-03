# MCP accounts in OkamiBot

Configured MCP HTTP/SSE servers remain optional. Apps shows the allowed direct tools
and connection state. A server may use environment headers, or an OAuth account whose
client registration, PKCE verifier and tokens are stored in the private OpenBao vault.
No token lookup route or model tool is exposed. Disconnect disables future calls locally;
it does not claim that the provider revoked its existing grant.

Example entry for `MCP_SERVERS_JSON` (use real provider URLs):

```json
[{"id":"notes","url":"https://mcp.example.test/mcp","tools":{"read_notes":"read"},
  "oauth":{"authorizationOrigins":["https://auth.example.test"],"clientId":"registered-client-id"}}]
```

`clientId` is optional when the provider supports dynamic client registration. A confidential
registered client may specify `clientSecretEnv` with an environment variable name. Origin
allowlists are exact HTTPS origins, configured by the operator; discovered redirects or
issuers cannot extend them. Every call rechecks the configured tool allowlist and active
account. OAuth and an environment Authorization header cannot be combined.

Set `PUBLIC_API_URL` to the actual HTTPS address. Register the exact callback
`PUBLIC_API_URL/api/mcp/oauth/callback`. With Tailscale, the phone's browser must be on the
tailnet. Some providers reject private callbacks or require a publicly reachable client
metadata document. This implementation supports preregistration and dynamic registration,
and reports that incompatibility; it does not automatically publish the administrative API.
No client metadata document is publicly exposed.

Authorization uses the installed official MCP SDK's discovery, PKCE, registration and
refresh flow, following [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
Callback state is single-use, owner/account/configuration bound and expires after ten minutes.
Tokens refresh before expiry; concurrent refreshes are serialized. Provider errors return
limited reconnect instructions, without raw token replies.

For fixed browser login adapters, `CAPTCHA_MAX_SUBMISSIONS` (1–3) and
`CAPTCHA_ATTEMPT_MS` (1000–60000) bound one logical challenge. The saved deadline and
submission counter survive provider retries and restart. DOM controls and normalized
visual click/drag require a fresh observation of the trusted challenge region. Password
regions are excluded. A challenge that cannot be isolated, lacks supported controls,
requires a personal factor, or exhausts its budget asks for Take control on the same
browser. Handback wakes only that task and verifies the site's real success indicator.
The budget does not renew. OTP/passkeys use real factors; OTP remains attached to the
task direction rather than counting provider retry attempts.

Validation uses the real SDK against synthetic OAuth metadata/token fixtures, actual
Chromium CAPTCHA fixtures and task/database/grant tests. Real third-party account OAuth,
site-specific CAPTCHA adapters and physical phone login still require deployment acceptance.
