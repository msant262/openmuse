# Routines, connectors and personal memory

These modules use OpenMuse's existing owner-scoped Postgres/PGlite database. They do not require CopilotKit Intelligence, Expo's push service, or Composio. Keep `CPK_INTELLIGENCE_API_KEY` empty for self-hosted main-chat publication and past-chat search. The optional legacy cloud mode still works, but routine results in that mode are available through Activity rather than automatic main-chat publication, and local past-chat search is unavailable.

## Scheduled routines

Set `ROUTINE_TIMEZONE=Europe/Berlin` (or your IANA timezone) and keep `TASK_WORKER_ENABLED=true` on the process executing tasks. The scheduler runs alongside that task worker. If using a separate task worker, use shared Postgres as documented in [rich threads](RICH-THREADS.md); PGlite must have a single process owner.

Ask in chat: “Every weekday at 8:00 send me today's agenda in Portuguese.” The model translates that request into `manage_routine`; it returns the saved timezone and next run. Without a model backend, the Apps or Activity routine editor still works. Its day/time fields cover daily and weekday schedules, with cron available under Advanced schedule. All schedules persist in the DB and continue when the mobile app closes.

The app can create, edit, pause, resume and delete routines. The agent tool supports the same operations. Schedules have five numeric cron fields; seconds and timezone abbreviations are rejected. Daylight-saving transitions follow `cron-parser`'s IANA timezone handling. Routines execute ordinary delegated tasks, so payment review, cancellation, connected tools and action logging apply. Pausing/deleting stops future slots; a slot already queued remains a separate task that can be cancelled in Activity.

The scheduler saves a pending UTC slot before enqueueing it, then uses a deterministic task key. Restart recovery resumes that slot before advancing its schedule. Missed schedules produce one latest due run, rather than a backlog of old external actions. If the previous run is still queued/running/paused/waiting for approval, the next occurrence is skipped. An existing pending slot survives enqueue failures and is retried. Edits during a pending enqueue require retrying; pause/delete can invalidate the pending slot.

Completed results wait behind an active main-chat lease. Publication commits a deterministic assistant message under the same lease as normal chat turns. A separate durable notification follows the post. Restart recovery repairs either boundary without re-running the task or repeating its external writes. The main chat reconnects while idle after receiving that in-app update.

Authenticated endpoints:

- `GET /api/agent/routines`: schedules and default timezone.
- `POST /api/agent/routines`: title, prompt, cron, optional timezone/enabled, and a stable `idempotencyKey` of 16–160 characters. Reusing it for changed details returns 409, including simultaneous requests. A deleted routine keeps its key tombstone; create a replacement with a new key.
- `POST /api/agent/routines/:id`: selected fields to update.
- `POST /api/agent/routines/:id/delete`: stop future slots and tombstone the schedule.

## Remote MCP

The official MIT MCP TypeScript SDK connects to Streamable HTTP (`transport: "http"`) or legacy HTTP/SSE (`"sse"`). Transport is explicit; failed HTTP connections do not silently try a second transport. Connections/tool discovery have deadlines, shutdown aborts requests, and external writes are never automatically retried. Shutdown waits for model calls and later native approval executors through their success/uncertain receipt persistence before releasing the adapter.

Choose `MCP_CONFIG_FILE=/run/secrets/openmuse-mcp.json` or `MCP_SERVERS_JSON` with the same array. Do not set both. Example configuration; replace the endpoint and exact tool names with values returned by your server:

```json
[
  {
    "id": "composio",
    "url": "https://your-generated-session-endpoint.example/mcp",
    "transport": "http",
    "account": "wife-personal-project",
    "headerEnv": { "x-api-key": "COMPOSIO_API_KEY" },
    "tools": {
      "GMAIL_FETCH_EMAILS": "read",
      "GMAIL_CREATE_EMAIL_DRAFT": "write",
      "GITHUB_GET_ISSUE": "read"
    }
  }
]
```

`headerEnv` maps actual header names to server environment variables. Include every returned authentication/account header, including `x-user-api-key`, `x-org-id` or `x-project-id` when applicable, without converting them into guessed headers. Endpoint URLs, resolved headers and device credentials never go to the model or mobile app. Store configuration outside version control; a generated session URL can itself be sensitive. Requests and SSE endpoint announcements cannot forward credentials across origins or redirects.

Every tool requires an exact local allowlist entry and effect: `read`, `write`, or `money`. Limits are ten servers and fifty allowlisted tools per server. Keep the list small enough for the selected model's tool limit. Unknown tools and unsupported JSON schemas are omitted. Exposed names are `mcp_<server>_<tool>` (long or punctuated names get a stable suffix). An unavailable server exposes only a status tool.

Treat the effect list as trusted operator configuration: remote annotations and the model cannot grant autonomy. Payment/purchase names require `money`; any tool able to move money through less obvious arguments must also be configured as `money`. Broad meta-execution, browser, proxy, computer, shell and remote code tools are rejected because they could bypass the effect list. Read calls enter the action log. Writes use the native ActionService policy/audit and stable owner/task-or-turn intent keys. Money review shows a bounded argument preview with amount, currency, recipient and product when present; authentication fields and configured secrets are redacted, and omitted detail is marked explicitly. The private binding retains the complete arguments. Review binds arguments, tool schema, endpoint, account label, effect list and resolved header identity; changed credentials/configuration require a fresh action. Uncertain remote writes stay `outcome_unknown`; inspect the connected app before creating another action.

### Optional Composio multi-app setup

Create a session with the SDK's direct-tools preset, explicit toolkits/tool names, and MCP enabled. This yields a single generated URL for the selected apps. Keep sandbox, dynamic executors and connection-management meta tools disabled. Prefer a narrowly scoped project API key and select the intended connected accounts/auth configs. Copy **the returned `session.mcp.url` and all `session.mcp.headers`**, mapping each header value to its own server environment variable; do not invent a universal endpoint. Match OpenMuse's allowlist to that direct tool list.

Composio's current header export requires TypeScript `@composio/core >= 0.19.1` or Python `composio >= 0.22.1`. Its setup SDK is optional; OpenMuse only needs the generated URL/configuration and environment-backed keys. Follow [Composio's session MCP guide](https://docs.composio.dev/docs/sessions-via-mcp) and [session filters/account settings](https://docs.composio.dev/docs/configuring-sessions) to create/export your configuration. Live Composio account access has not been tested here.

## Native phone notifications

Activity notifications are always durable. Its three-second refresh is in-app polling, **not native push**. Optional direct APNs (iOS) or FCM HTTP v1 (Android) can notify a closed/background native app. OpenMuse never calls Expo's push service. The notifications plugin requires rebuilding the native app; a web export or Expo Go cannot establish this delivery path. See [Expo's direct APNs/FCM setup](https://docs.expo.dev/push-notifications/sending-notifications-custom/).

For iOS, provision the app's bundle identifier with the Apple Push Notifications capability and install a build signed with the corresponding entitlements. Set `APNS_KEY_FILE` to a protected `.p8` file, plus `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_TOPIC` (the bundle identifier). Set `APNS_SANDBOX=true` for development tokens, false for production tokens. Supply all four fields; an incomplete configuration reports not configured.

For Android, register the native app's package name in Firebase. Provide its downloaded `google-services.json` to native build configuration using `GOOGLE_SERVICES_FILE` (a mobile build variable). Keep that file out of this repository. Enable the FCM API and supply a server-only service-account JSON file with messaging permissions through `FCM_CREDENTIALS_FILE`, plus `FCM_PROJECT_ID`. These credentials are independent of Google Workspace OAuth and never enter the mobile bundle. The fixed FCM token/send endpoints receive abort/deadline signals.

In Apps, enable Phone notifications and accept the operating system permission. The mobile client registers its native device token with the authenticated server, handles token rotation, and opens the task when a notification is tapped. Disable removes that registration; logout also removes it where the server is reachable. Device token values are not returned by the listing endpoint.

Native payloads contain only a short task title and notification/task IDs, not result text. Creation atomically freezes the eligible original devices/tokens with the notice; token rotation, another phone or later credential configuration cannot create historical alerts. Recovery reconciles unfinished original targets and visible status, including a crash before the first send. Each unsent target must still have the same consenting registration before claim and dispatch. Disable/logout, rotation or re-enrollment suppresses the original target permanently without enrolling its replacement; enabling again applies to fresh notices. Ordinary same-token registration refreshes retain consent. Pre-upgrade notices without target snapshots can reconcile existing claims but do not acquire new targets. Per-device send claims persist before dispatch. A timeout, shutdown or expired interrupted claim becomes uncertain and is not resent automatically, avoiding duplicate pushes. An accepted provider response means accepted by APNs/FCM; it does not prove delivery to the physical phone. Missing credentials are shown as not configured, with Activity still available. Real signed iOS/Android installation and physical OS delivery remain unverified.

Authenticated endpoints are `GET /api/agent/push/devices`, `POST /api/agent/push/devices` with installationId/platform/native token, and `POST /api/agent/push/devices/:id/delete`.

## Memory and past conversations

`remember_fact`, `recall_memory` and `forget_memory` persist explicit user facts/preferences in the existing memories table. Fact IDs survive edits and deduplication compares current normalized content atomically, so remembering an original fact after editing it saves that requested fact separately. Existing IDs and HTTP edit/forget contracts remain valid. Both chat and delegated model tasks receive a bounded saved-fact context. Oversized facts are excerpted in context without consuming the budget for later short preferences; recall and the app retain their full stored text. Recalled text and past-chat excerpts are data, never authority. Existing app memory controls continue to work.

`search_past_threads` returns owner-scoped user/assistant excerpts, thread IDs, message IDs and dates. Searches use the latest settled canonical transcript per thread in SQL, cap results at thirty excerpts of five hundred characters, and omit archived threads unless requested. Another owner cannot search, recall or forget those records.

Thread reconnect/history/publication also project settled cumulative run snapshots in SQL: one latest full canonical transcript/state, incremental AG-UI events from older runs, and complete active-run recovery data under the same MVCC read. Redundant `RUN_STARTED.input` copies are omitted only for settled replay. Canonical snapshots restore actual user/tool message order and state; old history remains available. Existing raw cumulative records remain on disk, so storage growth still needs monitoring and backups. This change bounds duplicated history loaded into the API; it does not impose retention or silently discard old messages. The regression fixture checks 1,000 cumulative small-text turns; a multi-gigabyte legacy database on the target VPS has not been benchmarked.
