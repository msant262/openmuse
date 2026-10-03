# Native Lenovo executor

This source supplies the native command/files executor. The production API uses
`RemoteComputerBackend` and `/executor/:executorId/*`; a persistent root supervisor
pulls authenticated, journal-authorized operations over Tailscale. Commands run
as the fixed registered bot account. Administrative actions use a root-owned
catalog of fixed executable arguments; node requests cannot choose another user,
root shell, package recipe, or root environment. Keep the existing OpenMuse
package IDs and MIT notices.

The physical machines are the VPS and Lenovo. Aoostar is a development/backup
machine. Lenovo's existing `okami-bot` is UID 1003/GID 1004 with broad sudo and
privileged groups. Register it as `full-trust`: the API and pause ACK then explicitly
report `containmentGuaranteed:false`. Managed jobs have controls, but the native
account can escape them through existing privileges or another user session.
Containment-based mutable failover must remain disabled in this mode. Provisioning
preserves existing groups, sudo, GNOME/RDP, personal accounts, and user managers.

## Composition before enabling effects

Use the single VPS Store writer. `ExecutorRegistry` owns delivery/receipt state,
bound to the authoritative M4 operation; it creates no task, mailbox, admission,
heavy lease, or inference slot. `createApp` now composes the production authority and context automatically:

- `TaskExecutorAuthority` resolves the registered host and wakes the existing task
  actor when receipts arrive. `currentExecutorContext` binds the active journal
  operation to the exact M3 handles acquired by the audited computer boundary.
  Caller/model arguments cannot supply task/runToken/revision/epoch/fence/budget.
- Paired-device commands and file/recovery routes create private, typed durable
  requests, then use the same TaskWorker and four background slots. Model-created
  tasks cannot select this private path. Send a stable `Idempotency-Key` (or the
  recovery request's `requestId`) on retries. A changed payload conflicts; a retry
  cannot resume a user-paused task. An HTTP timeout does not cancel accepted work.
- A native command may return its running receipt or HTTP 202 with a task ID while
  admission is pending. Inspect that task/receipt instead of issuing a new request.
  Original request/device bindings survive a disk restart. Revoked devices cannot
  start queued work. Owned command cancellation reuses the existing task authority
  during global pause, without needing another background slot.
- `NATIVE_COMMAND_MEMORY_MB` supplies the operator's command budget (default 3072),
  still subject to measured host capacity and reserve. Desktop session lifecycle,
  its input grants and inspection while paused are composed in milestone 7;
  session stop requires the registered session's safety authority.
- Keep physical command IDs stable: SHA256(`owner:idempotencyKey`). M3's dispatch
  audit and `waitingComputerCommandId` use this ID. File/version primitives must
  remain mapped to their parent intention; unknown effects cannot be rerun under
  another generated physical ID. Version API callers persist `requestId` for
  retries; the physical ID is SHA256(`owner:file-version:requestId`).

Missing authority or context causes readiness/error responses and prevents sends.
Mutable native delivery holds its existing work slot before publication. Worker
cleanup preserves that slot when pause/cancel interrupts a still-unconfirmed
physical effect; a reconnect cannot admit four replacement jobs over it.
`nativeAdmissionPending` tracks physical occupancy independently of normal command
polling and the separate uncertainty recovery state.

Queued background commands may outlive an inference turn only with the same task
revision and retained physical M3 admission/handles. Unknown physical commands
and file mutations retain their exact leases until cleanup confirmation. The
existing audit reconciler consumes `computer-file-holds` handle metadata; it is
resource cleanup metadata, not another operation/admission journal.

Node success describes physical completion. Logical file/restore success waits
for durable artifact hash/generation/version-ID publication ACK. M4 must record
the parent SDK result after this await, rather than marking the parent complete
from the earlier node receipt. Semantic uncertainty remains after physical
cleanup; it never grants an automatic retry.
An epoch change retires a never-claimed queued command only after a database CAS
proves it stayed queued. If a concurrent claim wins, the operation stays unknown
until physical reconciliation confirms cleanup. A failed authoritative receipt
write keeps reconciliation closed and retries that same receipt.

VPS configuration:

```text
COMPUTER_BACKEND=native
COMPUTER_PROFILE=open
COMPUTER_ENABLED=true
NATIVE_EXECUTOR_ID=lenovo-okami
NATIVE_COMMAND_MEMORY_MB=3072
NATIVE_EXECUTOR_REGISTRATIONS_FILE=/operator-controlled/server-registrations.json
FILE_VERSION_RETENTION_DAYS=30
FILE_VERSION_MAX_BYTES=2147483648
```

The registrations file contains the real owner, Lenovo host/account IDs, explicit
trust mode, and SHA256 of a random per-executor bearer token. Keep token plaintext
only in Lenovo's root-private credential file. Example hashes/owners are
placeholders; no live credentials are committed. The node credential cannot use
owner `/api/*` routes or another executor's routes. The node route is mounted
outside device authentication, with its own scoped authentication and bounded
JSON parsing; Tailscale access still requires operator network configuration.

## Reviewed native installation

Prepare these root-owned files under `/etc/okami-executor` (private directory,
credential mode 0600). The loader checks every ancestor and refuses writable or
symbolic configuration paths:

- `users.json`, based on `users/users.example.json`, registering the existing
  account/home/private workspace and fixed network catalog;
- `apps.json`, a fixed executable/argument catalog, based on the example;
- `lenovo-okami.json`, based on `users/lenovo-okami.example.json`;
- `lenovo-okami.credential.json`, containing only the real node token.

Install source under root-owned `/opt/okami-computer`, outside bot homes, with
`executor/` importable there. Python stdlib, systemd/cgroup v2, nftables, and
Tailscale are required. This implementation does not install packages or change
services automatically. The local administrative app helper takes only registered
catalog IDs; it is absent from node RPC.

First run `python3 deployment/users/provision.py` with the root-owned registry to
review its JSON plan. `--apply` creates missing explicitly registered accounts and
scoped private workspaces. Existing native UID/GID/home must match exactly. It
never changes existing sudo/groups or kills/moves sessions. Existing home 0750 is
accepted only with a private primary group and no world permissions. Changing an
existing home to 0700 requires the explicit `--tighten-home` deployment decision.
Every directory component is opened no-follow; file tools retain a workspace
descriptor and revalidate its logical ancestry before publication.

Render service files into an operator review directory:

```text
python3 -m executor.deployment --registry /etc/okami-executor/users.json \
  --memory-total-bytes ACTUAL_MEMTOTAL_BYTES --reserve-bytes 4294967296 \
  --output /root/okami-units-review
```

Use the actual `/proc/meminfo` MemTotal, with a measured reserve of 3–4 GiB. The
aggregate `okami-bots.slice` gets the remainder and MemoryHigh at 90%; per-account
MemoryMax stays infinity. Jobs have a trusted measured MemoryMax, CPUWeight,
IOWeight, TasksMax, control-group cleanup and service-scoped OOMPolicy=kill.
Jobs/session/D-Bus descend from `okami.slice/okami-bots.slice`, while root
supervisors remain in `system.slice`. Jobs bind the supervisor's retained home
and workspace directory descriptors and revalidate their logical ancestry before
launch. Admission counts job peak reservations,
managed non-job/session memory, existing unmanaged registered-UID PSS (RSS
fallback), and physical MemAvailable. Swap contributes no admission capacity.
One heavy job per physical host is persisted across supervisors/restarts; a
frozen or uncertain job keeps its reservation. Jobs over 8 GiB are allowed when
the aggregate budget permits them. These controls create no additional VPS work
slots. Recalibrate under real desktop/browser/build pressure.

Each job retains its systemd exit result with `Type=exec` and `RemainAfterExit`.
An exited retained unit is distinct from a running process. The supervisor
commits the owned terminal receipt before stopping/releasing that unit. Missing
units carry semantic uncertainty; systemctl's default zero/success fields are
never execution proof. Startup reconciles cleanup-confirmed terminal commands,
including already acknowledged receipts, against their matching shared RAM and
heavy reservations. Executor/budget binding prevents releasing another node's
reservation; legacy unowned rows require exact local journal/budget proof.

Supervisor death stops its managed jobs through BindsTo. ExecStopPost closes the
fixed UID gate and freezes only the registered workload slice/session; startup
again begins closed and reconciles old receipts. A paused controller acknowledges
revision/epoch/contained/guaranteed separately. A failed containment proof
quarantines the executor. Receipt collection/inspection remains available; a
fixed owned cancel can stop its job while paused. No UID process kill sweep is
used. Existing RDP/SSH/user-manager processes are measured, rather than moved or
killed; restricted mode refuses escaped workloads, while full-trust discloses
the limitation.
Root file publication has its own safe point: pause cannot report containment
while a destructive publication is in progress. Recovery capture, trash and
restore propagate live pause/watchdog cancellation before mutation. If a race
displaces a later human inode, verification failure restores it exclusively or
retains an explicit recovery staging entry, including oversized/nonregular files
and exhausted backup storage.

## Network and RDP installation gate

Keep `administrativeRepliesVerified:false` until the real RDP/SSH client addresses,
source ports, output socket UID, and conntrack reply direction have been checked.
The example's empty catalog intentionally prevents full-trust firewall rendering
and gate mutation. An old established outbound agent connection must not bypass
pause. Administrative exceptions are exact root-registered client IP + source
port 22/3389/3390 + TCP reply + established state, before the closed-UID gate;
there is no blanket established allowance. Do not add guessed client IPs or
permit private destinations globally to keep RDP working.

After that acceptance gate, `deployment/firewall/render.py` produces a single nft
batch that destroys only `inet okami_executor` and recreates it with every bot
closed. Repeated loads replace the dedicated table atomically, preserving
unrelated host tables; malformed batches preserve the prior table. This uses
the documented [nft table destroy operation](https://www.netfilter.org/projects/nftables/manpage.html)
and [atomic batch replacement](https://wiki.netfilter.org/wiki-nftables/index.php/Atomic_rule_replacement).
Install its reviewed output at `/etc/okami-executor/firewall.nft`. The helper
verifies the whole installed policy before and after changing closed-UID
membership, including fixed hooks, UID jumps, IPv4/IPv6 blocked unions, DNS,
administrative replies, and rule order. Numeric nft output and equivalent merged
CIDRs are normalized for this comparison.

Policy denies local/private/link-local/tailnet/cloud metadata destinations,
unregistered DNS/DoT, non-TCP/UDP, and local proxy endpoints for registered UIDs.
An IPv4/IPv6 FIB local-route rejection also blocks services listening on this
host's public addresses. Exact cataloged DNS, exceptions and administrative
replies precede that rejection. These UID rules cover packets carrying the
registered socket UID. Kernel retransmissions after a process exits can lack
that UID; the isolated test observed that limit. Previously transmitted requests
cannot be retracted, and this policy does not promise containment of orphan
sockets or the existing full-sudo account.
Explicit resolvers and exception IP/port pairs belong to the root catalog. Root
supervisor/control credentials remain outside bot homes and workload mounts;
privileged sockets and other homes are inaccessible to managed services. Broad
native sudo/groups invalidate an account-wide network/IPC containment guarantee.

Install reviewed units only after host preflight. Keep current RDP and personal
sessions active throughout. Add the generated `sleep-target.conf` under
`sleep.target.d/` only together with running supervisors: the root-private Unix
socket hook confirms containment before sleep, CLOCK_BOOTTIME includes suspend,
and resume requires a new handshake/reconciliation. The M6 session unit supplies
D-Bus lifetime only. M7 supplies the separately tested graphical driver; command
heartbeat never marks display/capture/input/browser ready.

## Controlled file recovery

Binary transfers support 25 MiB and generic MIME/.bin; PDF compatibility tools
retain their existing 10 MiB/PDF checks. Text tools support 256 KiB. Staging uses
bounded chunks/progress/cancellation/fsync. Before publication the executor checks
the workspace anchor, destination revision, staged inode/content, and final
published inode/content. Root recovery backups precede mutation; immutable
version IDs are UUIDs, artifact IDs are origin scoped, content versions are
SHA256, and generation prevents stale publication from replacing a newer one.
Pending publications recheck current source hash before ACK. Symlinks, nonregular
files, shared hard links, and human edits during publication fail closed. If an
atomic exchange is uncertain, its displaced original is preserved for recovery.
An origin hash/missing-file conflict is stored for that exact artifact,
generation, version ID and hash. It does not close the executor or block receipt
collection, job cleanup, inspection or unrelated work. Readiness exposes the
conflict and the VPS invalidates matching current publication metadata. The
original logical write/restore remains uncertain; inspect the current file to
publish a new observed generation instead of retrying the mutation.

The first controlled edit observes and backs up an existing file. Later edits use
the published expected hash; inspect the actual file with
`inspect_computer_artifact` when a human has changed it. Capture/trash/restore use
the same journal/leases as other operations. Restore creates a new version and
uses a new conflict-copy path when the current human version differs, then waits
for origin publication ACK. Chat has inspect/list/capture/trash/restore tools;
the app's recovery panel lists owner-scoped versions and persists restore IDs
across retries. Offline recovery reports pending/error, never invented success.

Retention is 30 days and 2 GiB by default, explicitly configurable on VPS and
origin. Budget/disk exhaustion stops mutation before replacing the source.
Pruning is an explicit local maintenance operation, never performed silently
during a write. Back up version content/journals with a real backup policy; trash
and controlled versions do not undo arbitrary shell/GUI edits or external effects.

## Acceptance and rollback

Pure TypeScript/Python contracts cover ID/epoch/fence/revision/receipt sequencing,
lost ACKs, restart/suspend/paused/unknown work, source/parent/stage races,
restore conflict, disk pressure, shared budgets and scoped cleanup. For actual
nft repeat-load validation, run the fixed `firewall/test_namespace.py` under
`sudo -n unshare --net`, passing the caller's `/proc/self/ns/net` identity as
`--host-netns`; the runner refuses the host namespace. It checks two identical
loads, a preserved unrelated sentinel table, a failed atomic batch, and UID gate
round trip. This is local kernel acceptance, separate from Lenovo acceptance.
`firewall/test_local_egress.py`, with the same isolated-namespace guard, checks
actual public IPv4/IPv6 and loopback sockets, exact trusted DNS/exception access,
closed-gate established traffic, and cataloged administrative reply directions.
`systemd/test_lifecycle.py --owned-units` under authorized local sudo checks fixed
temporary controller/job units under nobody: short success, nonzero exit,
cancellation, timeout, retained-result restart, durable receipt before release,
and complete owned-unit cleanup. It refuses any pre-existing proof unit and does
not change an existing account or service.

Root integration must still exercise real M4 admission/context/manual-device
provenance and physical cleanup, then check Lenovo's actual accounts/ancestry,
private IPC, service death, all managed descendants, calibrated pressure/OOM,
RDP replies, IPv4/IPv6/DNS/private/proxy behavior, Wi-Fi loss, suspend/resume,
receipt recovery, and real file restore. Record exact source SHA and hardware
evidence separately. Installed desktop packages or heartbeat alone supply no M7
readiness evidence.

For rollback, pause through the authoritative runtime, retain unknown receipts,
stop only the registered executor/session/job services, and archive root-private
journals/version content before changing source. Remove only reviewed generated
units/hooks and the dedicated `okami_executor` table after verifying remaining
registered controllers; restore any operator-chosen permissions from recorded
inventory. Do not flush host nft tables, kill UID processes, remove existing
accounts, or change GNOME/RDP, personal services, groups, sudo, or vault data.
