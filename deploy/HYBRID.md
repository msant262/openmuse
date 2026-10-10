# Lenovo / VPS installation and operation

Use the final composed, reviewed source revision. The installer requires the
connected M7 browser/domain code, M8 broker and M11 `media_job.py`; it refuses
incomplete source. Keep root-owned code outside bot homes. Preparation and
activation are separate commands, and neither creates a new account or runtime
host. Keep the project MIT license and [dependency notices](THIRD-PARTY.md).

The October 3 read-only inventory found Lenovo Ubuntu 26.04.1/Python 3.14.4,
Node 22.22.1 and existing `okami-bot` UID 1003/GID 1004. VPS Ubuntu 24.04.4 has
2 CPUs, about 8 GB RAM, Compose 5.5.1 and the existing Hermes service. Verify those
facts again at installation; they are not proof that services/models are installed.
The operator subsequently verified all M11 requirement wheels with the real
Lenovo Python 3.14 temporary venv; no package or model was installed by that probe.

## Private control path and phone pairing

Lenovo is `100.91.96.14`; VPS is `100.113.59.40`. Preserve existing SSH/RDP and
personal services. Limit tailnet grants to the existing administrative devices,
Lenovo-to-VPS TCP 8787 and root forced-command backup SSH between these two hosts.
Do not allow the bot's general network tools to reach tailnet, private networks,
other accounts or metadata endpoints. Native control is the root supervisor's
authenticated fixed IP origin, `http://100.113.59.40:8787`, over Tailscale encryption.

Start with `.env.example`, apply `hybrid.env.example` to a private copy, then supply
the real provider/model declarations and operator secrets. Keep `.env` mode 0600
and `deployment-secrets` mode 0700. The reviewed deploy binds
`OPENMUSE_BIND_HOST=100.113.59.40`; the default overlay supports loopback for other
topologies, but loopback alone is unreachable from this Lenovo supervisor.

The phone/web `PUBLIC_API_URL=https://srv1667308.tail107988.ts.net` is separate
from node control. On this tailnet Serve was initially disabled. After enabling
the existing tailnet's Serve permission, the operator can configure and inspect:

```sh
sudo tailscale serve --bg http://100.113.59.40:8787
sudo tailscale serve status
```

Verify HTTPS from the paired phone before using OAuth callbacks. This does not
enable Funnel or public ingress and does not claim direct TLS on the numeric IP.
Use the same private HTTPS API URL in the mobile build; pair the existing owner
and devices through the app. Paired access tokens remain 15 minutes; refresh and
device revocation persist. `SESSION_DEVICE_IDLE_DAYS=0` removes idle expiry only.
For OAuth MCP connectors see [MCP OAuth](../docs/MCP-OAUTH.md); credential adapters
and CAPTCHA bounds use [the broker setup](openbao/README.md).

## Existing-account native plan

Create a protected input directory, for example `/root/okami-deployment/inputs`.
Copy the fixed schemas in `apps/computer/deployment/users`: `users.json`,
`apps.json`, `lenovo-okami.json`, and a private `lenovo-okami.credential.json`.
The credential has `{"token":"<random per-node token of 32+ characters>"}`; its
SHA256 alone goes into VPS `deployment-secrets/native-executors.json`, with the
real authenticated owner, `executorId=lenovo-okami`, `hostId=lenovo`,
`osAccountId=1003` and `trustMode=full-trust`. Never put its plaintext in the VPS
environment, browser, mobile bundle, a model prompt or task output.

Keep the existing account/home/UID/GID and `workspace=/home/okami-bot/workspace`.
Add a fixed desktop registration to the user record, for example:

```json
"hostId": "lenovo",
"desktop": {
  "sessionId": "REPLACE_WITH_FIXED_OPERATOR_GENERATED_UUID",
  "display": 71,
  "proxyPort": 18777,
  "profileId": "personal",
  "width": 1280,
  "height": 720
}
```

Use a display and proxy port not occupied by another service/account. The native
browser binds its public-destination-only proxy to that exact loopback port;
the registered UID rules permit both TCP directions there only while its gate is
open. Other loopback services remain blocked. Never add this proxy to the
administrative reply exceptions, which intentionally survive pause.
Register exact DNS and network
exceptions, then verify the *existing* SSH/RDP reply socket UID/direction/address
metadata before setting `administrativeRepliesVerified=true`. The installer
refuses unverified firewall inputs; it does not require a new RDP client account
or guess a broad administrative allow rule. Its nft batch replaces only the
dedicated `inet okami_executor` table, preserving other firewall policy.

`full-trust` preserves sudo and all existing groups, including docker/lxd/input.
Managed session/jobs set `NoNewPrivileges=no` and retain those authorized
privileges. The account can use sudo or privileged groups to leave managed
cgroups, reach other files or bypass UID network policy. Root-owned supervisor
code and scoped journals prevent ordinary task arguments from selecting another
identity; they do **not** contain a hostile full-trust account. Report
`containmentGuaranteed=false`, including after pause. No VM, group removal,
GNOME/RDP replacement, UID process sweep or OS Python replacement is installed.

## Compatible Python and native dependencies

On the deployed Ubuntu 26.04 Python 3.14, `faster-whisper==1.2.1` requires the
compatible pinned `av==18.1.0`. PyAV 19 removed the `metadata_errors` keyword used
by that Whisper decoder; wheel resolution alone did not expose the runtime failure.
Keep the requirements pin and run an actual transcription after changing either
dependency. See [PyAV's changelog](https://github.com/PyAV-Org/PyAV/blob/main/CHANGELOG.rst)
and [the measured deployment record](../docs/DEPLOYMENT-ACCEPTANCE.md).

Python 3.14 wheel support is an explicit preflight. Before apt or code/service
mutation, the installer creates a temporary venv and asks pip to resolve every
pinned requirement as a binary wheel. It fails without changing packages when
a wheel is missing. Check this independently on the reviewed Lenovo source:

```sh
sudo python3 scripts/install_native.py preflight-python \
  --source /opt/openmuse --media-python /usr/bin/python3
```

If incompatible, install a separate root-owned CPython under `/opt/okami-python`
using an operator-reviewed, digest-verified uv release and a compatible Python
patch version. [uv manages separate Python installations](https://docs.astral.sh/uv/guides/install-python/).
For example, after reviewing the available 3.13 patch version:

```sh
sudo /usr/local/bin/uv python install 3.13 --install-dir /opt/okami-python --no-bin
sudo env UV_PYTHON_INSTALL_DIR=/opt/okami-python /usr/local/bin/uv python find --managed-python 3.13
```

Resolve the returned interpreter's real root-owned path, rerun wheel preflight
with that exact `--media-python` path, and pin it in the rendered plan. Do not use
`--default`, alternatives, symlinks replacing `/usr/bin/python3`, or a user-home
interpreter. The supervisor/desktop stdlib code continues to use OS Python; media
uses only `/opt/okami-computer/venv/bin/python` and the fixed `media_job.py` entrypoint.

The plan installs LibreOffice Writer/Calc/Impress, ffmpeg, poppler-utils,
ImageMagick, Python pip/venv/Xlib/Pillow, git/curl/jq, age, Xvnc/XFCE and the
required runtime libraries. It preserves already installed services. The frozen
worker `npm ci` runs without lifecycle scripts, compiles native JavaScript with
its pinned TypeScript dependency, then prunes build dependencies. Ubuntu's Node
can omit TypeScript support, so the managed unit runs `native-dist/.../native.js`
without replacing OS Node. The matching Playwright CLI
explicitly installs Chromium and Linux dependencies. Its cache is root-owned,
readable by the bot, at `/opt/okami-computer/playwright-browsers`. The managed
session sets `PLAYWRIGHT_BROWSERS_PATH` and selects `--browser-channel chromium`;
the real headed sandbox/CDP preflight must pass. There is no `--no-sandbox` fallback.
On Ubuntu with restricted unprivileged user namespaces, preparation installs the
scoped `okami-chromium` AppArmor exception for the exact root-owned Playwright
executable path, following the shipped Chrome profile's `userns` permission.
It records executable/profile SHA256 values and never changes the global sysctl
or personal Chrome profile. AppArmor itself matches paths, not hashes; verification
checks the installed receipt. A browser update requires a new reviewed preparation.
Gog 0.43.0 is downloaded with the plan's fixed digest; installation does not log
into or connect a Google account.

Read the measured MemTotal bytes and keep a measured 3–4 GiB host reserve. Generate
the review plan without downloading the model, then include the fixed small-model
download only in the plan the operator will actually prepare:

```sh
sudo python3 scripts/install_native.py plan --source /opt/openmuse \
  --inputs /root/okami-deployment/inputs --output /root/okami-deployment/native-plan.json \
  --memory-total-bytes ACTUAL_MEMTOTAL_BYTES --media-python /EXACT/COMPATIBLE/PYTHON
# Once the package/model effects and exact hashes are reviewed, render the same
# plan with --with-asr-model if the pinned model is not installed.
sudo python3 scripts/install_native.py prepare --plan /root/okami-deployment/native-plan.json
sudo python3 scripts/install_native.py activate --plan /root/okami-deployment/native-plan.json
sudo python3 scripts/verify_hybrid.py --host lenovo --check-asr-model
```

When extracting a release archive, use umask 022 and tar `--no-same-permissions`
to keep source directories nonwritable by other users. Preparation publishes
code/model assets as readable 0755/0644 while private configuration stays 0700/0600.
Inputs, plan, source and every ancestor must be root-owned, nonwritable by other
users and free of symlinks at apply time. Preparation refuses live managed units,
copies only reviewed scoped source, installs dependencies, verifies rendered
systemd units and reloads systemd. It does not start services. Activation starts
only the dedicated firewall, registered session and supervisor, then installs
the sleep gate. Preserve the inventoried lid/power/Wi-Fi policies and existing
SSH/RDP; check restart/unlock with those paths still available.

Updating compiled native browser files does not reload the separate graphical
process. A supervisor restart alone leaves its old Node modules in memory.
After a reviewed browser publication, use the existing coordinator's owned
maintenance interval and wait for tasks, HTTP requests, admissions, resources
and native deliveries to drain. Reload both writers with the installed helper:

```sh
sudo python3 /opt/okami-computer/repository/scripts/reload_native_browser.py \
  --config /etc/okami-backup/native.json --maintenance-id OWNED_MAINTENANCE_ID \
  --worker /opt/okami-computer/repository/native-dist/apps/worker/src/native.js \
  --worker-sha256 REVIEWED_WORKER_SHA256 \
  --receipt /var/lib/okami-deployment/UNIQUE_RELOAD_RECEIPT.json
```

The helper retains the closed-gate stop/resume order and verifies a new browser
process, unchanged selected bytes, configuration, pause and prior journal
receipts. Existing uncertain outcomes remain uncertain. The coordinator must
finish its maintenance interval after verification; validate the actual browser
operation through a fresh ordinary chat. No active task or native job may be
stopped to satisfy this publication preflight.

The ASR path is `/opt/openmuse/models/whisper-small`, pinned to Systran's small
snapshot `536b0662742c02347bc0e980a01041f333bce120`. It uses CPU/int8, bounded CPU
threads and local-only inference; no paid ASR or external audio upload. Loading
the actual installed model is part of `--check-asr-model`. A partial/existing
model directory is not overwritten automatically. Inspect it before reusing it.

## VPS capacity and start

| Reservation | Bytes |
| --- | ---: |
| API/PGlite/embedded worker | 2,147,483,648 |
| Headless browser fallback | 2,147,483,648 |
| OpenBao | 268,435,456 |
| Existing Hermes reserve (at least measured current/peak) | 2,415,919,104 |
| OS/Tailscale/other host reserve | 1,073,741,824 |
| Total with inventoried Hermes peak | **8,053,063,680** |

PGlite recovery and the embedded harness exceeded the former 1,280 MiB API cap
on cold start. The hybrid API now reserves 2 GiB while retaining the 1 GiB OS
reserve and the measured Hermes reservation. The verifier bounds the total by
both the nominal 8 GiB ceiling and actual MemTotal; it fails if a larger Hermes
peak or insufficient MemAvailable breaks the budget. Before startup it requires full cold headroom; while running
it subtracts only those same containers' current cgroup allocation and verifies
their actual caps. The existing 4 GiB host swap protects the OS from brief
pressure; it adds no admission capacity and containers/native bots remain
unswappable. Hermes is preserved. Do not enable `legacy-computer` under this
budget: its extra services do not fit this ceiling.

Initialize [OpenBao](openbao/README.md) first, with separate offline seal/recovery
material and scoped application/snapshot tokens. Then use the same composed files
for every deployment and backup command:

```sh
sudo docker compose --env-file .env -f docker-compose.yml -f deploy/compose.hybrid.yml config --quiet
sudo docker compose --env-file .env -f docker-compose.yml -f deploy/compose.hybrid.yml up -d --build
sudo python3 scripts/verify_hybrid.py --host vps --check-vault
```

Keep exactly one API/PGlite/task-writer process. All tasks across both hosts still
share the four durable work slots, one heavy host reservation and exact resource
leases. Technical heartbeat is 15 seconds, server watchdog 40 seconds; these are
protocol constants rather than invented env knobs. Node epoch, task revision,
browser/profile generation and frame fences are mandatory after reconnect. No
shell/desktop migration or replay of uncertain mutable effects occurs. Browser
read-only research may use the VPS fallback; authentication uses the broker's
exact target profile binding and trusted login validation.

## Daily encrypted two-host backup

Use an offline/operator-held age identity and put only its public recipient into
the host configs. Create `/etc/okami-backup` root-owned 0700 and root-owned 0600
copies of `backup/vps.example.json`, `native.example.json` and `receiver.example.json`.
Replace every placeholder. The API bearer file holds a separate root-operator
`odb1` credential with 32 random bytes; it never holds `OPENMUSE_ACCESS_KEY`, an
`om1` paired session, device refresh material or a legacy session. Its only API
scope is **GET `/api/deployment/status`, POST `/api/deployment/maintenance`, and
POST `/api/agent/runtime-pause`**, with exact paths/methods, no query strings,
strict JSON and a 4 KiB body cap. It cannot pair/refresh a device, access owner
files/chat/tasks, or authenticate a node. The snapshot token separately has only
`openbao/backup-policy.hcl`, never root or credential-write policy.
Keep recovery identity/static seal key offline and outside the bot account; full
sudo remains a host-compromise limitation, not an at-rest security guarantee.

Bootstrap the operator secret once, before the first server start (or during a
reviewed idle restart window). The script generates an exclusive root-owned 0600
token file and writes **only its SHA256** into the preserved private API env:

```sh
sudo python3 scripts/operator_backup_token.py create \
  --output /etc/okami-backup/api-bearer --env-file /opt/openmuse/.env
```

Copy that file privately through the existing administrative SSH route to Lenovo's
same root-owned 0600 path, never through chat, a model tool or the forced archive
receiver. Both host backup configs already refer to that path. The server sees
only `DEPLOYMENT_OPERATOR_TOKEN_SHA256`; its plaintext is not mounted in app,
browser or bot environments. If the env write failed after creating the file,
use `sync-env` with the same arguments to publish its hash without generating a
replacement. Existing tokens are never silently overwritten.

Load the hash at normal initial startup, or recreate only the idle server with
the same hybrid Compose files after preserving the runtime pause/work state.
The operator token has no 15-minute session expiry, so the timer runs without
manual device login or refresh. Revoke it by removing/replacing the env hash and
recreating the API. For rotation, create a new private file at a new path, update
both protected copies and the server hash in the coordinated idle window, then
resume the backup timer. Keep the new secret out of CLI argv/stdout and provider
configs. Unset/malformed/changed hashes fail closed; ordinary device sessions and
their own rotation/revocation remain independent.

Install the committed receiver on both hosts at
`/usr/local/sbin/okami-backup-receive`; the native installer does this on Lenovo.
Set the receiver `peerHost` to `vps` on Lenovo and `lenovo` on VPS. Separate SSH
keys have fixed, restrictive authorized-key commands, for example:

```text
restrict,command="/usr/local/sbin/okami-backup-receive",from="100.113.59.40" ssh-ed25519 PUBLIC_VPS_RECEIVER_KEY
restrict,command="/usr/local/sbin/okami-backup-native",from="100.113.59.40" ssh-ed25519 PUBLIC_VPS_SNAPSHOT_KEY
```

On VPS install the reciprocal receiver key restricted to `100.91.96.14`.
Append these reviewed lines; do not replace existing authorized_keys or SSH/RDP
config. Private transfer/snapshot keys stay in root-only `/etc/okami-backup` and
strict known-host verification is required. Neither remote command accepts a
model-selected shell/path/account. The receiver accepts only immutable age
envelopes of the expected host, correct checksum, at most 20 GiB and 1 GiB free
reserve. Local backup retention is 14 days after a successful commit/transfer;
monitor peer inbox capacity separately and retain verified offline copies.

```sh
sudo python3 scripts/deployment_backup.py backup --mode hybrid-vps \
  --config /etc/okami-backup/vps.json --quiesce --drain-timeout-seconds 300 \
  --transfer --retention-days 14
sudo install -m 644 infra/systemd/okami-hybrid-backup.service infra/systemd/okami-hybrid-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now okami-hybrid-backup.timer
sudo journalctl -u okami-hybrid-backup.service
```

`--quiesce` closes HTTP/new SQL task admission under the same runtime lock, drains
ongoing work without killing it, and waits for leases, unknown operations, viewers
and active requests. Only when empty does it take an acknowledged revision-bound
temporary pause. It preserves a prior user pause and any user pause revision
change. A 300-second drain failure is visible and leaves execution intact; daily
success is not guaranteed when viewers/unknown effects remain occupied.

The VPS coordinator first calls Lenovo's fixed snapshot command for the same
batch UUID. Lenovo confirms the global pause, stops only its managed idle session
and supervisor, encrypts account home/workspace/profiles plus root journals and
versions/config, transfers the committed ciphertext to VPS, then restores only
previously running managed units. VPS rechecks the same pause revision, stops
only server/browser with clean exit, and saves a real online OpenBao Raft snapshot.
Hermes, OpenBao and legacy/personal services stay running. It encrypts DB,
attachments/publications, headless profiles, env/config and Raft snapshot, transfers
to Lenovo, then resumes only a backup-owned acknowledged pause. Interrupted or
dirty shutdown, missing peer, encryption or transfer failure does not prune old
copies. Any incomplete backup retains a backup-owned pause, including failure of
the remote writer's restoration. A reachable API alone does not prove that native
containment recovered. Inspect service state and the visible pause before resuming;
the coordinator never overwrites a newer user pause revision. Native shutdown
closes the verified UID network gate, stops the supervisor, then thaws only its
drained managed account/session for graceful stop. Restart restores physical
pause before starting the supervisor; unrelated SSH/RDP sessions remain unchanged.
A lost pause ACK is never guessed; inspect that visible pause manually.
Do not make concurrent operator vault/config writes during the snapshot window.

## Isolated recovery and acceptance

```sh
sudo python3 scripts/deployment_backup.py restore --mode hybrid-vps \
  --config /etc/okami-backup/vps.json --archive /var/backups/okami/peer/EXACT_ARCHIVE.tar.gz.age \
  --identity-file /OPERATOR_OFFLINE_MEDIA/age-identity
```

Restore checks checksum and authenticated age decryption, validates paths and
extracts into a fresh operator-private `restoreDir/isolated-UUID`. It refuses
agent homes/active state, does not overwrite production volumes, and starts no
API/executor/cron. The emitted `compose.inspect.json` has network none, no ports,
no imported production env/tokens, sample backend, and disabled worker,
proactivity, computer and browser. If an operator starts it for inspection,
adjust ownership only inside that isolated copy for image UID 1000. Keep native
journals inactive; never connect restored stale executors to the live API.

Restore Raft separately in an isolated OpenBao 2.7.1 instance with the separately
held static key/recovery material, no production network or application token.
Use `bao operator raft snapshot restore -force` only there, then confirm a saved
fixture value. The encrypted archive excludes `openbao-unseal.key`. Revoke/replace
old production tokens before promotion. Back up the seal key and recovery material
on offline media independently of routine cross-host archives.

The isolated actual-tool proof is reproducible without any production credential:

```sh
python3 scripts/verify_openbao.py --bao-binary /PATH/TO/VERIFIED/2.7.1/bao
AGE_BINARY=/usr/bin/age AGE_KEYGEN_BINARY=/usr/bin/age-keygen \
  python3 -m unittest discover -s scripts -p test_hybrid_backup_tools.py -v
```

After physical readiness, install `infra/systemd/okami-soak@.service` on VPS;
Lenovo's plan installs the same unit with its native script path. Create private
`/etc/okami-soak/vps.json` / `lenovo.json` from `soak/*.example.json`, then start
`systemctl start --no-block okami-soak@vps` and the Lenovo instance. It records
only managed memory/OOM, host load/pressure/temperature and unauthenticated API
health round-trip timing for 24 hours. Results and JSONL are root-private under
`/var/lib/okami-soak`. Short/interrupted/gapped captures do not claim 24 hours.

Health round-trip p95 is not desktop ACK/chat/provider latency. Complete those
separate measurements, four-task/chat/takeover/close-app/push journey, Wi-Fi and
restart recovery, five light sessions and an admitted >8 GiB workload before
marking physical acceptance complete. Brand/assets/platform exports are a
separate release check. [Verification evidence](../docs/VERIFICATION.md) records
automated proofs separately from pending installation and the 24-hour run.
