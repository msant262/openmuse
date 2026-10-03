# Personal VPS deployment

This deployment runs one OpenMuse owner on a Linux **2 vCPU / 8 GB VPS**, using the existing mobile app. The root `docker-compose.yml` runs the API with its in-process task worker/PGlite, persistent Chromium, the nonroot open computer and its authenticated egress gateway. CopilotKit Intelligence, Composio and native push credentials are optional. The MIT source, demo and local browser-only `infra/compose.yaml` workflow remain available.

The optional Lenovo primary browser and VPS backup use the
[hybrid overlay and browser routing](docs/BROWSER-FALLBACK.md). The VPS browser
keeps its 2 GiB limit; native accounts and privilege mode require operator setup.

| Service | Maximum resident memory | Persistent state |
| --- | ---: | --- |
| server | 1280 MiB | `server-data`: embedded DB, threads/tasks/audit/routines, files, signing key, subscription credentials/VM host ID |
| browser | 2048 MiB | `browser-data`: profiles, cookies, takeover metadata/downloads; shared memory capacity 1 GiB inside this cap |
| computer | 2944 MiB | `workspace` at `/workspace`; `computer-home` at `/home/node`, including command receipts/logs/user tools |
| computer-egress | 128 MiB | Firewall/authenticated proxy, separate PID namespace |
| openbao | 256 MiB | `openbao-data`: encrypted credential vault; private vault network |

Total: **6656 MiB / 6,979,321,856 bytes**, below decimal 7 GB. The hybrid overlay starts API, browser and vault at **3584 MiB**, with the legacy computer/gateway available by profile. Every long-running container has init as PID 1, restart policy, healthcheck and memory/PID limits. Container swap is disabled; add host swap for the OS/build/maintenance headroom, not as an increased model budget. A large local LLM is not bundled. Image builds, CPU int8 transcription and concurrent Chromium activity need timing/resource checks on your actual host.

## 1. Prepare the host and 4 GiB swap

Use Docker Engine **28 or later** and its Compose plugin, Python 3, git, and enough disk for images/model/browser/downloads/backups. Install from the [official Docker Linux instructions](https://docs.docker.com/engine/install/). Docker documents earlier localhost-publish leakage to neighboring hosts; don't use that older behavior for private access. [Port publishing](https://docs.docker.com/engine/network/port-publishing/).

Keep the production checkout and env owned by root if using the provided root systemd timer. Clone your fork/reviewed revision to `/opt/openmuse`, then:

```bash
cd /opt/openmuse
sudo install -m 600 .env.example .env
sudo install -d -m 700 -o 1000 -g 1000 deployment-secrets
sudo install -d -m 700 /var/backups/openmuse
docker version
docker compose version
swapon --show
```

If no appropriate swap already exists, on a filesystem supporting ordinary swap files (for example ext4), create **4 GiB**. Do not overwrite an existing `/swapfile`. Sparse/COW/Btrfs files need filesystem-specific preparation or a swap partition; confirm with your distribution's instructions.

```bash
sudo bash -eu <<'SWAP'
if [ -e /swapfile ] || [ -L /swapfile ]; then
    printf '%s\n' '/swapfile already exists; inspect it before changing swap.' >&2
    exit 1
fi
dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
SWAP
# Add this line once to /etc/fstab with your editor:
# /swapfile none swap sw 0 0
swapon --show
free -h
```

## 2. Private access and protected configuration

Compose publishes **only `127.0.0.1:8787`**. Browser/computer/gateway ports are never published, and neither the API nor computer gets Docker socket/host networking. Use one of these access paths:

- **Private Tailscale HTTPS:** install Tailscale on host and phone, allow only your devices, and run `sudo tailscale serve --bg http://127.0.0.1:8787`. Set `PUBLIC_API_URL` to the HTTPS tailnet URL it prints. Keep Funnel disabled. [Serve instructions](https://tailscale.com/docs/features/tailscale-serve).
- **HTTPS reverse proxy on the host:** point your domain to the VPS and configure Caddy/nginx with TLS and streaming enabled to `127.0.0.1:8787`. For Caddy, the site block below supplies automatic HTTPS; install/configure it according to your distribution. Allow HTTPS (and port 80 only if your certificate issuance/redirect needs it) plus restricted SSH in the provider security group/host firewall. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

```caddyfile
openmuse.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

Don't publish raw 8787/8790/8810/8811, use host networking, enable Docker direct routing, or expose the computer to a LAN. Verify raw ports from a different host as well as `ss -lnt` on the VPS. Public/private URLs must be reachable on the phone; localhost is only useful for an SSH-tunneled laptop session.

Edit the root-owned mode-600 `.env`. The root Compose file fixes live mode/model backend, container bind/data paths, RPC computer and the single in-process worker. Local `.env.example` sample defaults still work outside that Compose deployment. Set:

```dotenv
PUBLIC_API_URL=https://openmuse.example.com
ALLOWED_ORIGINS=https://your-web-client.example.com
MODEL=chatgpt/your-account-model-slug
OPENMUSE_ACCESS_KEY=replace-with-random-24-or-more-characters
TOKEN_ENCRYPTION_KEY=replace-with-base64-of-exactly-32-random-bytes
WORKER_TOKEN=replace-with-random-32-or-more-characters
COMPUTER_TOKEN=replace-with-a-different-random-32-or-more-characters
COMPUTER_CONTROL_SUBNET=172.30.88.0/24
COMPUTER_SERVER_IP=172.30.88.2
COMPUTER_HOST_PUBLIC_IPS=all-actual-vps-public-ipv4-addresses-comma-separated
APPROVAL_POLICY=money
ROUTINE_TIMEZONE=Europe/Berlin
```

Generate secrets into this protected file using a local password manager or `openssl rand`: 32 random bytes encoded base64 for the encryption key, and random 32-byte hex values for the other keys. Never put server keys in `EXPO_PUBLIC_*`, a Docker build argument, source, command history or a posted Compose dump. `config --quiet` avoids printing interpolated secrets. Use an explicit HTTPS/private URL without a trailing slash. Leave `CPK_INTELLIGENCE_API_KEY` empty for local main-thread routine publication/search.

Check `ip -j addr` and the provider console for **every** host public IPv4/NAT alias; set them all in `COMPUTER_HOST_PUBLIC_IPS`. Resolving `PUBLIC_API_URL` is not a complete inventory. Choose a control subnet not overlapping host/LAN/Tailscale routes, then put the fixed server IP inside it. Gateway startup rejects a missing/invalid public list; review the list after address changes.

The computer shares only the gateway's network namespace. Kernel rules deny private/reserved/metadata/CGNAT/Tailscale/Docker DNS, sibling services, all listed host public IPs and IPv6; IPv6 is also disabled. Its fixed read-only `resolv.conf` uses public resolvers 1.1.1.1/8.8.8.8. Public IPv4 TCP and those DNS resolvers are allowed. The gateway checks exact rules and raw RPC readiness before forwarding. Computer starts after the gateway process starts, **not after its healthcheck**: gateway health needs the computer listener. No arbitrary job dispatch can pass its guard before rules/readiness are verified. Arbitrary public-network shell calls are logged as commands; semantic payment classification applies to supported native/browser/MCP actions, not every possible HTTP side effect inside bash.

## 3. Build, subscriptions and first start

```bash
cd /opt/openmuse
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml build
```

Build with writers stopped or on a separate compatible builder if the host lacks build headroom. Builds download pinned computer tooling and the multilingual faster-whisper small model; runtime transcription is CPU int8/offline, not SIWC audio. The browser image uses repository-root context so its shared payment module exists at the real import path. New named volumes receive UID 1000-owned API/home/workspace directories; the Playwright image prepares `/data` for `pwuser`. If migrating existing volumes, correct their ownership while writers are stopped, then verify from the containers rather than granting additional capabilities to the app.

### Official Sign in with ChatGPT

On your **laptop**, install this revision and run:

```bash
pnpm install --frozen-lockfile
pnpm auth chatgpt login
pnpm auth chatgpt status
pnpm auth chatgpt models
```

Complete the printed link in the same laptop's browser; the PKCE callback listens on `127.0.0.1:1455/auth/callback` (`--port 0` picks an available port). Approve ChatGPT plan use and choose a catalog model slug. This is the official SIWC public-client protocol, not Codex legacy auth or a ChatGPT backend API. [Official sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

On the VPS **before importing**, create its independent stable host ID. These one-shot auth commands do not open PGlite and do not start the API/sidecars:

```bash
docker compose run --rm --no-deps server node dist/apps/server/src/providers/auth-cli.js chatgpt host
sudo install -d -m 700 -o 1000 -g 1000 deployment-secrets/imports
```

From the laptop, securely copy **only the selected registration**, preserving its issued client ID and token metadata:

```bash
scp .openmuse/credentials/chatgpt.json root@your-vps:/opt/openmuse/deployment-secrets/imports/chatgpt.json
```

On the VPS:

```bash
sudo chown 1000:1000 deployment-secrets/imports/chatgpt.json
sudo chmod 600 deployment-secrets/imports/chatgpt.json
docker compose run --rm --no-deps server node dist/apps/server/src/providers/auth-cli.js chatgpt import /run/secrets/imports/chatgpt.json
sudo rm deployment-secrets/imports/chatgpt.json
docker compose run --rm --no-deps server node dist/apps/server/src/providers/auth-cli.js chatgpt status
```

Import preserves the VPS host ID rather than replacing it with the laptop's. Stop the laptop runtime using this copied renewable session; the VM owns later serialized rotating refreshes. Protected credentials/host ID stay in `server-data`, and maintenance checks expiry every minute to refresh near hourly expiry. Renew/re-login after invalid/expired refresh rather than falling back to a billed key implicitly. Never run two deployments from copied rotating credentials. Usage/plan eligibility and actual login are account-dependent. SIWC has no audio/video input or hosted image capability. [Official VM transfer](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [session rotation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [complete model guide](docs/MODEL-BACKENDS.md).

### xAI/Grok device login

```bash
docker compose run --rm --no-deps server node dist/apps/server/src/providers/auth-cli.js grok login
docker compose run --rm --no-deps server node dist/apps/server/src/providers/auth-cli.js grok status
```

Approve the printed device URL/code on your phone/laptop; no callback copy is needed. Set `MODEL=grok/your-eligible-model`. Tokens remain in API-only persistent credentials and rotate with expiry. The researched Hermes/xAI flow is implemented; tier/client eligibility may still return 403. This provider never reads a billed `XAI_API_KEY`. Sources and MIT attribution are in [model backends](docs/MODEL-BACKENDS.md).

### MiMo Token Plan and external/local compatible models

For a Xiaomi subscription, use the **dedicated Token Plan** URL/key/model from its dashboard:

```dotenv
MODEL=mimo/mimo-v2.5-pro
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-dedicated-tp-plan-key
MIMO_API=responses
# Optional ordered alternatives you explicitly configure:
# MODEL_FALLBACKS=local/your-installed-model
```

The region form is `https://token-plan-{region}.xiaomimimo.com/v1`; **`https://api.xiaomimimo.com/v1` is pay-per-token** and is rejected by `mimo/`. Both Responses and explicitly selected Chat Completions are supported. [Xiaomi official guide](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/codex.md).

For Ollama/llama.cpp on a separate trusted host, use `MODEL=local/installed-model-id`, `LOCAL_BASE_URL=http://reachable-model-host:11434/v1`, `LOCAL_API=chat-completions` and an optional gateway key. `127.0.0.1` inside the API means its own container, not your laptop or Docker host. No model service is budgeted on this VPS. Generic `compatible/` fields and optional explicitly billed providers/image models are documented in `.env.example` and [model backends](docs/MODEL-BACKENDS.md). Ordered fallback handles model admission before stream acceptance; it does not replay completed tools.

### Start and validate

```bash
docker compose --env-file .env -f docker-compose.yml up -d --wait --wait-timeout 120
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

Health establishes service/RPC readiness; browser `/health` alone doesn't launch Chromium. Before personal use, run actual browser navigation/takeover and a harmless computer command through the authenticated app, restart and verify saved state. With operator `docker compose exec computer`, test public DNS/HTTPS succeeds and private/metadata/LAN/sibling/Docker-DNS/host-public-IP/IPv6 destinations fail. In an isolated disposable deployment, remove an expected gateway rule and verify its health and command dispatch fail closed, then recreate it together with computer. This kernel check is mandatory acceptance on the real host; static/mock checks do not replace it.

## 4. Google, optional connectors and phone setup

For `WORKSPACE_MODE=live`, create a Google OAuth **web** client, enable Gmail/Calendar APIs and consent/test-user access, set server-only `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and register exactly `${PUBLIC_API_URL}/api/google/callback`. Recreate the server after changes; connect Gmail/Calendar in Apps and grant write scope when needed. Money actions require bound review by default; use `APPROVAL_POLICY=all` for every supported write. Samples retain scripted review. Uncertain external writes are not replayed after restart. Optional sandbox `gog` login is separate: arbitrary shell can read credentials you deliberately place in its home; use the native connector for audited Google actions.

For optional Composio, create one MCP-enabled direct-tools multi-app session with explicit toolkit/tools/connected accounts, remote sandbox and dynamic meta-executors disabled. Copy the **generated returned URL and every returned header** into a protected `deployment-secrets/openmuse-mcp.json` configuration and server env references. There is no universal URL to guess. Set `MCP_CONFIG_FILE=/run/secrets/openmuse-mcp.json` **or** `MCP_SERVERS_JSON`, never both. Each exact tool has trusted `read`/`write`/`money` effect; broad multi-execute/shell/proxy tools are rejected. See [exact schema and Composio setup](docs/ROUTINES-CONNECTORS-MEMORY.md#remote-mcp).

Root Compose explicitly passes the common `COMPOSIO_API_KEY`, `COMPOSIO_USER_API_KEY`, `COMPOSIO_ORG_ID` and `COMPOSIO_PROJECT_ID` aliases only to server. Map actual returned header names to those aliases in `headerEnv`. If another configured server requires a new secret env name, add an **API-only override** such as the following (the filename `docker-compose.override.yml` is used automatically when calling Compose without `-f`; when using explicit `-f`, include it explicitly):

```yaml
services:
  server:
    environment:
      MY_MCP_SECRET: ${MY_MCP_SECRET:?Set the returned MCP header value}
```

Store that value in protected `.env`, reference `MY_MCP_SECRET` from `headerEnv`, and use `docker compose --env-file .env -f docker-compose.yml -f docker-compose.override.yml ...` consistently. The backup script uses the base deployment; it discovers actual running volumes/images and archives `.env`/secret files, but **save custom override files separately in your protected recovery store** and restore them before starting. Never blanket-export `.env` to sidecars. Make credential/config files UID 1000-owned mode 600, directory 700. No required Composio SaaS is introduced; generic remote MCP or no MCP both work.

Set mobile `EXPO_PUBLIC_API_URL` to the **phone-reachable private HTTPS/HTTPS API URL before building**. Expo inlines it at build time; use a clean export/build after changing it. On your laptop:

```bash
EXPO_PUBLIC_API_URL=https://openmuse.example.com pnpm --dir apps/mobile exec expo export --platform web --output-dir dist/web --clear
# For an installed native app, set the same variable in its development/release build environment:
pnpm --dir apps/mobile ios
pnpm --dir apps/mobile android
```

Sign in with the shared strong access key. Google callbacks and signed file/browser-console links use the same `PUBLIC_API_URL`. A web UI is a separate Expo static export, not the API's `/` JSON response; serve that export privately or on HTTPS and put its origin in `ALLOWED_ORIGINS`. Use an Expo development/native build for PDF modules and notifications, not Expo Go. JavaScript/Hermes exports do not create signed APK/IPA binaries.

Optional native push is **direct APNs/FCM**, without Expo's push service. Put an APNs `.p8` under `deployment-secrets`, set `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` and correct `APNS_SANDBOX`; provision/sign iOS Push Notifications entitlements. For Android, supply `GOOGLE_SERVICES_FILE` only to the native build, and a server-only FCM service-account JSON plus `FCM_CREDENTIALS_FILE`/`FCM_PROJECT_ID`; enable FCM messaging API/permissions. Credentials never enter the mobile bundle. Rebuild/sign/install, grant OS consent and enable Phone notifications in Apps. Missing credentials show `not_configured`, with durable Activity notices still available; polling isn't push. [Platform steps and delivery limits](docs/ROUTINES-CONNECTORS-MEMORY.md#native-phone-notifications).

## 5. Daily backup, restore and upgrades

The host-only scripts require exactly one existing API/browser/computer container and named state volumes. API holds PGlite and its worker; no second writer or database process exists. `DATABASE_URL` is excluded from root Compose; the script refuses an external Postgres deployment, which needs a separate `pg_dump`/restore procedure.

```bash
sudo /opt/openmuse/scripts/backup.sh --project-dir /opt/openmuse --env-file /opt/openmuse/.env --backup-dir /var/backups/openmuse --retention-days 14
sudo install -m 644 infra/systemd/openmuse-backup.service infra/systemd/openmuse-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openmuse-backup.timer
systemctl list-timers openmuse-backup.timer
journalctl -u openmuse-backup.service
```

The timer runs daily at 03:15 UTC with a small randomized delay and catches a missed run. Change the root-owned unit paths if your checkout differs. It locks the backup directory against overlapping script backup/restore, stops API first (abort/join chat/tasks/refresh/native-action and server-tool receipts, then close PGlite), flushes browser profiles and terminates computer jobs. Only confirmed normal **exit 0 without OOM/error** permits copying; exit 1, SIGKILL/137, SIGTERM/143 or failed stop refuses the copy. Unconfirmed task/tool/action receipts or failed database writes remain flagged through shutdown, including failures before the stop signal or caught by a tool. Fully recorded application/provider errors still allow a clean exit. Inspect and resolve failed storage/receipts before restarting and retrying; never bypass the clean-exit check. Docker stop alone doesn't prove DB/profile consistency. Gateway stays running to preserve the network namespace. Daily backups interrupt active computer jobs; receipts reconcile uncertain/interrupted work without silently running it again.

A bounded 128 MiB/networkless transient helper reads all four named volumes and protected `.env`/`deployment-secrets`, preserving numeric owners/modes. Archives include the complete PGlite directory, files, signing key, API credential/host records, browser profiles/downloads, workspace and home/receipts, plus nonsecret manifest. This is a stopped-writer snapshot, not a live tar of PGlite. Private mode-700 output/mode-600 archives, checksums, atomic final publication and 14-day successful retention apply. Failed copies publish no archive or prune previous successes, and all previously running writers are resumed even after copy failures; previously stopped writers stay stopped. Confirm health afterward. Keep space for two archives/staging plus images and monitor disk growth; volumes don't provide portable disk quotas. `--timeout-seconds` defaults to 1800 per host command, `--retention-days` accepts 1–365. Encrypt archives before optional off-host storage: they contain credential/browser/session secrets and must never be served as agent artifacts or committed. Keep encryption key and custom configuration in a protected recovery store too.

For a restore drill, select a trusted archive/checksum and stop writers first:

```bash
docker compose stop server browser computer
sudo /opt/openmuse/scripts/restore.sh --project-dir /opt/openmuse --env-file /opt/openmuse/.env --backup-dir /var/backups/openmuse --archive /var/backups/openmuse/openmuse-YYYYMMDDTHHMMSSZ-XXXXXXXX.tar.gz
```

Restore validates checksums/paths, refuses running writers and extracts into **new** named volumes plus a private `restored-...` recovery directory. It never overwrites active volumes/config or automatically starts the app. Review its recovered `deployment.env`, `deployment-secrets`, manifest and `volumes.env`. Copy recovered secrets/config into the protected deployment paths only after review; put the four generated `OPENMUSE_*_VOLUME` assignments into `.env` (replace older assignments, don't create ambiguous duplicates). Preserve UID/modes and stop the original deployment before using restored rotating tokens. An old refresh token may require a fresh laptop login/import; a restore on a new VM needs a new independent host ID before import. Keep the old volumes until validation succeeds.

Recreate **gateway and computer together** to attach the new namespace/volumes, and then browser/server:

```bash
docker compose up -d --force-recreate computer-egress computer
docker compose up -d --force-recreate --wait --wait-timeout 120 browser server
```

Check durable chats/partial replies, main-thread routine result/notice without duplication, audit/task statuses, files, browser saved login/takeover, workspace/home and command receipts. Never automatically redo uncertain external actions. Restore failure leaves only labeled new volumes/private staging for operator inspection/cleanup; existing volumes stay intact.

For upgrades: take a successful backup, stop writers, update to a reviewed revision, build while stopped, and use the same coupled gateway/computer recreate followed by browser/server. Change gateway/container configuration only with that coupled recreate; restart policies don't prove an old computer joined a replaced namespace. Never use `down -v` or volume pruning as an ordinary upgrade step. Don't run the timer concurrently with an upgrade; stop the timer around manual upgrades and enable it afterward.

## Verification boundaries

Static Compose parsing/byte-budget/security checks, image file/import contracts, real built API active-stream SIGTERM/PGlite restart, and host-script mock failure/real archive round-trip tests run without Docker. They do **not** establish actual Docker image builds, initial named-volume permissions, kernel/cgroup rules, namespace replacement behavior, live container backup/restore, 2-vCPU transcription/browser performance, HTTPS/Tailscale setup, live subscription/Google/Composio accounts or physical native delivery. Perform those checks on the actual VPS; [verification evidence](docs/VERIFICATION.md) distinguishes current checks from historical Docker results.


### Final integration behavior

Durable browser tasks save operation intents and tool receipts before resume; completed
logical acts are deduplicated across new numbered snapshots. An accepted but unconfirmed
act requires manual site inspection and a new task for further automatic browser work. A known pre-dispatch skip caused by a paused task can run normally after resume under the same logical action ID.
The task's five-minute deadline applies to inference/idle time. Bounded foreground tools
own their up-to-thirty-minute deadline, and cancellation joins their receipt before the
worker releases the run. Explicit background jobs keep their independent durable receipts.

Phone Disable/logout serializes revocation after older registration requests. Provider dispatch revalidates the current token, platform and registration epoch after audit persistence; a completed revocation in that interval suppresses the send. Direct OS
sends appear in the append-only Action log with provider acceptance, rejection or unknown
outcome; success does not prove physical phone delivery. Paused routines stay paused when
their title/prompt/schedule is edited. MCP configured-header credentials, including raw
Bearer components, are scrubbed from result strings and keys before history/receipt storage.

Audit startup recovery traverses bounded keyset batches with a fixed startup cutoff;
normal maintenance reaches known receipts beyond unresolved entries. Raw cumulative chat
storage compaction is deferred: the canonical SQL history projection reduces duplicate
API JSON but does not bound stored database size. Monitor data-volume and backup growth;
no physical storage, VPS memory or sustained performance result is inferred from fixtures.

Latest integration check: **407/407** automated tests pass; server/browser-worker types,
server build and tracked/new-source Biome pass (204 files; four existing provider-test
warnings). Mobile source/dependencies are unchanged and their prior type/export checks
remain applicable.
The prior 385-test milestone proof is historical. New fixtures cover browser resume and
uncertain dispatch, foreground lifetime/cancellation, native consent races, configured MCP
credential scrubbing, paused routine edits and audit backlog/native send receipts. These
checks do not establish a deployed VPS, account eligibility or physical phone delivery.

Web/iOS/Android JavaScript/Hermes exports pass; signed mobile/device acceptance remains
unverified. Independent checks of the final compiled build passed actual HTTP/PGlite/model/
MCP integration and active-stream SIGTERM (exit 0 in 0.06s), retained the partial reply
through restart, and admitted a fresh turn. Official Compose configuration and exact
interpolated API environment passed again with 6,845,104,128 bytes of service caps and
1 GiB browser shared memory. This new final-build evidence supersedes the earlier
milestone verification counts without implying Docker or physical-device execution.


The repaired build also passes the expanded actual HTTP consent check: Disable completes
while the real native-send audit INSERT completion is held, and releasing that write causes
zero provider sends. The original compiled integration, SIGTERM/restart and official static
Compose checks passed again on that repaired build. These fixtures use synthetic providers
and local services; operator Docker/VPS/device/account validation remains required.
