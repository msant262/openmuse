# Persistent Python integration boundary

Status: API corrections published at `e6b2d839`, native containment correction at
`c7fa614f`; **enabled, with natural Luna persistence verified and overall
acceptance pending**.

`python_kernel.py` owns a conversation's interpreter and installs fresh caller
callbacks for every cell. `python_kernel_runner.py` executes the unchanged
Hermes `RUNNER_CELL_SOURCE`; `vendor/hermes_code_kernel.py` and its MIT notice pin
the original source. The adapter also uses upstream `KernelRegistry`. It does
not install Hermes, replace the agent loop or import its model/tool dispatcher.

`NativePythonLauncher` renders and launches a fixed registered user's transient
systemd unit with private pipes, directory anchors, explicit RAM, the bot slice,
the existing privilege mode and `BindsTo` the supervisor. The launcher validates
root-owned source before starting a process. Its unit rendering and directory
checks have local tests. An isolated real unit on the registered native executor
verified the actual user/group, bot cgroup, 512 MiB limit, supervisor binding,
persistent variables, full callback results, ordinary errors and timeout cleanup
including a descendant. Its temporary sources/journal were removed and its
shared RAM reservation returned to its exact prior state. This infrastructure
test did not send a chat or call a provider. A full-trust account retains the
existing full-trust containment limitation.

`NativePythonJobs` binds a cell to the durable received envelope and publishes a
single current RPC request with a root-generated sequence and digest. Typed
reply controls must match the parent task, revision, executor epoch, session
resource fence and exact request. The native journal records only a private
reply reference, digest and byte count; reply bytes are consumed ephemerally.
Retransmitted operation IDs never rerun a cell or a reply. A normal final cell
receipt reports `cellSettled`; it does not claim the still-live unit was stopped.

The supervisor wires this surface only when its root-owned
`pythonKernelEnabled` configuration is explicitly `true`. The current deployed
configuration is now enabled following API-first publication and registered-unit checks. Disabled requests cannot fall back to shell
execution. Enabled sessions use a separate conversation resource key rather
than the CPU-heavy command key. Their idle interpreters retain per-unit physical
RAM reservations, and native snapshots avoid counting that RAM twice. Unit
identity is durably recorded before admission and process dispatch. Watchdog,
pause, reconnect, suspend, cancellation and shutdown contain registered kernels;
startup also cleans retained units after a disabled rollback. Cleanup failures
retain their exact unit and budget. Startup preserves uncertain outcomes and
never restores a namespace by replaying source.

An actual API restart exposed a containment failure: systemd refused to stop a
Python unit after the watchdog froze its account slice. That left the executor
quarantined and removed Python from the worker's available tools. Teardown now
checks the exact registered unit's cgroup and uses its `cgroup.kill` interface
when ordinary stop fails. It verifies both the terminal unit and empty cgroup;
it does not thaw the account or a sibling. Unconfirmed teardown retains its
ownership and RAM reservation. The regression passes on an actual frozen QA
unit as well as in local tests. See the [kernel cgroup v2 interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
for the process-tree kill primitive.

The caller supplies `(executor_id, owner, conversation_id)`, an admitted memory
budget and its authorized tool callbacks. Python cannot select an account,
approval state, executor epoch or resource fence. Interpreter output and its
frames remain untrusted data. Only the original host journal can establish an
effect's actual receipt or a user's decision.

The API now validates cell/reply envelopes, owns the per-conversation M3 resource
lease and delivers bounded full replies through a node-authenticated private
endpoint. It derives host call IDs from the canonical parent and root request
sequence/digest. A private async scope permits only that exact callback to pass
its own waiting cell's effect barrier; other running or uncertain effects still
block it. New Python cells also check pending effects before creation and at the
final dispatch barrier. Ordinary host tools keep their task journal, full-result
path and approval policy. API reply envelopes retain metadata only; the same
claimed control can recover a lost response without repeating the host tool.

The copied OpenClaw host has an optional Python runtime alongside its unchanged
JavaScript runtime. Python appears only when the explicit API enable flag and
the connected/reconciled native capability both permit it. Conversation scope
comes from the task's actual origin thread; the model cannot choose the owner,
session, native account, memory reservation or fence. `finish_task` is excluded
from the Python cell catalog so completion occurs after the cell settles.

Cells serialize per session. Errors preserve variables; reset, exit, timeout,
pause and protocol failure report their state consequences. A pending review
stops the interpreter before later source lines can execute; it requires a new
cell after the ordinary host operation settles. It never replays the old cell.
Calls from old contexts are refused even after a new cell starts. A callback
that outlives timeout blocks another cell for the same scope until it settles.
Failed process cleanup also blocks replacement until the exact unit is stopped.
An accepted host `continue:false` reply with confirmed containment records a
failed/stopped cell, not an uncertain execution that would block approval
resumption forever. It never records source success or settles a separate host
effect. Cancellation, timeout and unconfirmed containment remain uncertain.

Python receives full tool results. Controller diagnostics retain bounded
previews, not a second transcript of every large result. Exact args/results
must be saved by the ordinary host dispatcher. Captured output is bounded by
UTF-8 bytes; clipped stdout has an exclusive, owner-private output file in the
ordinary workspace. It is a retained output, rather than hidden executor state:
the existing file transport can export its exact bytes/hash, the app can attach
it with `export_computer_file`, and the existing controlled trash/version/restore
flow preserves recovery. Kernel reset never deletes it. Internal `.okami-*`
paths remain blocked; no private-state exception or automatic deletion of user
documents is introduced. Test cleanup selects only its own exact outputs.

The following acceptance work remains:

1. Verify nested native command admission and approval/denial resumption through
   the actual model/task runtime. The API/registered-unit bridge below proves
   file attachment and owned cancellation, not natural model/provider behavior.
2. Preserve the compatible API/native protocol, ordinary task leases, per-unit
   RAM and exact rollback ownership. Publication is complete; validate subsequent
   API corrections with the actual model rather than treating activation as acceptance.
3. Complete actual UI approval/denial, resumption and cancellation through Python
   callbacks in ordinary Luna chats. Natural persistence now passes across two
   tasks with a real reused namespace and verified completion. Ordinary native
   CSV delivery and natural Gmail draft/send/read/approved-trash also pass, but
   those do not establish Python callback approval acceptance. Preserve existing
   JavaScript behavior and honest availability metadata. The acceptance gate
   remains false until the remaining checks pass.

Local verification:

```sh
PYTHONPATH=apps/computer:scripts python3 -m unittest \
  executor.test_python_kernel executor.test_python_kernel_native \
  executor.test_python_transport \
  executor.test_contracts executor.test_media executor.test_search \
  executor.test_corrections scripts.test_native_install \
  scripts.test_reload_native_browser
```

These tests cover the interpreter and native contracts, including the actual
Supervisor receipt/reply path, rejection while disabled, unchanged received
envelopes, cross-task/revision/epoch/fence refusal, corrupted reply rejection,
real cell persistence, pause/timeout/cancellation and retransmission. Host
callbacks/review payloads in this suite are local fixtures. They do not
constitute published harness acceptance or prove Hermes/OpenClaw tool parity.

The API/native integration tests also connect actual node-authenticated Hono
endpoints, M3/M4 task authority, the original computer export/Files publisher,
native Gate/Journal/PythonJobs and real interpreters. They verify complete
20,000-item RPC results, exact attachment bytes, long-output export, same-ID
delivery without another effect, host-review stopping later source lines and
an API-owned cancellation retaining its interrupted outcome. A nested ordinary
native command also runs through the original computer tool, M3/M4 task journal,
separate CPU-heavy lease and physical command budget while its Python cell waits.
The four cases pass both locally and with actual registered systemd units.
Test provider and
review values remain fixtures. The default OS launcher is local; the opt-in
registered-unit run uses root-owned staged sources, the actual registered
user/cgroup/RAM reservation and a private QA workspace, with no production
configuration/service change. All temporary sources, journals, output files and
reservations are removed after verification. A passing bridge run is separate
from published Luna chat and actual user review acceptance.
