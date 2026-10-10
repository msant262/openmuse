# Persistent Python integration boundary

Status: core implemented and locally tested; **not exposed in the published
`execute_code` tool or native capability catalog**.

`python_kernel.py` owns a conversation's interpreter and installs fresh caller
callbacks for every cell. `python_kernel_runner.py` executes the unchanged
Hermes `RUNNER_CELL_SOURCE`; `vendor/hermes_code_kernel.py` and its MIT notice pin
the original source. The adapter also uses upstream `KernelRegistry`. It does
not install Hermes, replace the agent loop or import its model/tool dispatcher.

`NativePythonLauncher` renders and launches a fixed registered user's transient
systemd unit with private pipes, directory anchors, explicit RAM, the bot slice,
the existing privilege mode and `BindsTo` the supervisor. The launcher validates
root-owned source before starting a process. Its unit rendering and directory
checks have local tests; actual native launch is still unverified. A full-trust
account retains the existing full-trust containment limitation.

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

1. Add typed native cell/request/reply transport and canonical operation
   identities. Do not derive host tool-call identities from child-supplied IDs.
   Epoch, task revision, fencing, cancellation and receipt reconciliation stay
   authoritative. Uncertain operations must remain inspectable without replay.
2. Admit actual RAM and account for idle interpreters in native snapshots.
   Register controller/launcher teardown with watchdog, suspend, owner closure
   and supervisor shutdown. Nested native command calls must neither deadlock
   on the cell's resources nor bypass physical admission.
3. Route each callback through the existing `executeTool`/task journal and
   original approval policy, with the current foreground/task catalog. A Python
   reply cannot stand in for an effect receipt, attach a file or finish a task.
4. Connect optional Python execution to the copied OpenClaw host; preserve
   existing JavaScript behavior and honest availability metadata. Complete
   ordinary Luna chats in the published app, including persistence, real
   Workspace reads, delivery, actual UI approval/denial and cancellation.

Local verification:

```sh
PYTHONPATH=apps/computer:scripts python3 -m unittest \
  executor.test_python_kernel executor.test_python_kernel_native \
  executor.test_contracts executor.test_media executor.test_search \
  executor.test_corrections scripts.test_native_install \
  scripts.test_reload_native_browser
```

These tests cover the interpreter and native contracts. They do not constitute
published harness acceptance or prove complete Hermes/OpenClaw tool parity.
