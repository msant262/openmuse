# Persistent Python integration boundary

Status: core and native transport implemented; **disabled in production and not
exposed in the published `execute_code` tool or native capability catalog**.

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
configuration remains false. Disabled requests cannot fall back to shell
execution. Enabled sessions use a separate conversation resource key rather
than the CPU-heavy command key. Their idle interpreters retain per-unit physical
RAM reservations, and native snapshots avoid counting that RAM twice. Unit
identity is durably recorded before admission and process dispatch. Watchdog,
pause, reconnect, suspend, cancellation and shutdown contain registered kernels;
startup also cleans retained units after a disabled rollback. Cleanup failures
retain their exact unit and budget. Startup preserves uncertain outcomes and
never restores a namespace by replaying source.

The caller supplies `(executor_id, owner, conversation_id)`, an admitted memory
budget and its authorized tool callbacks. Python cannot select an account,
approval state, executor epoch or resource fence. Interpreter output and its
frames remain untrusted data. Only the original host journal can establish an
effect's actual receipt or a user's decision.

Cells serialize per session. Errors preserve variables; reset, exit, timeout,
pause and protocol failure report their state consequences. A pending review
stops the interpreter before later source lines can execute; it requires a new
cell after the ordinary host operation settles. It never replays the old cell.
Calls from old contexts are refused even after a new cell starts. A callback
that outlives timeout blocks another cell for the same scope until it settles.
Failed process cleanup also blocks replacement until the exact unit is stopped.

Python receives full tool results. Controller diagnostics retain bounded
previews, not a second transcript of every large result. Exact args/results
must be saved by the ordinary host dispatcher. Captured output is bounded by
UTF-8 bytes; clipped stdout has an exclusive, owner-private spill file in the
workspace. These temporary outputs still need the app's owned-file delivery
and retention integration before production activation.

The following work is required before enabling this surface:

1. Implement the matching API protocol schemas, canonical cell/reply authority,
   private reply-grant endpoint and native receipt polling. Derive host call IDs
   from the parent canonical operation and verified root sequence. A child cannot
   select these IDs. Fresh epoch/revision/session fencing and effect barriers must
   remain authoritative; only the explicitly owned running Python parent can be
   bypassed while dispatching its verified host callback, never unrelated
   pending or uncertain effects. Preserve uncertain outcomes without replay.
2. Route each callback through the existing `executeTool`/task journal and
   original approval policy, with the current foreground/task catalog. A Python
   reply cannot stand in for an effect receipt, attach a file or finish a task.
   Make nested native-command admission and cancellation use the original host
   policy without deadlocking on the outer cell's session lease.
3. Connect optional Python execution to the copied OpenClaw host; preserve
   existing JavaScript behavior and honest availability metadata. Complete
   ordinary Luna chats in the published app, including persistence, real
   Workspace reads, delivery, actual UI approval/denial and cancellation.

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
