"""Test-only bridge: real native Gate, Python jobs, Journal and Workspace.

The application endpoints, task authority and file publisher run in the Node
test. OS launch is local by default; opt-in staged QA uses registered systemd
units with a private test workspace. Provider/review values remain fixtures;
this does not prove Google effects or a model's natural tool selection.
"""
import json
import os
from pathlib import Path
import queue
import signal
import shutil
import subprocess
import sys
import threading
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from executor.files import Workspace
from executor.python_kernel import KernelProcess, RUNNER_PATH
from executor.python_transport import NativePythonJobs
from executor.supervisor import Gate, Journal

directory = Path(sys.argv[1])
registered = sys.argv[2:] == ["--registered"]
budget = managed = None
if registered:
    from executor.filesystem import open_directory
    from executor.job_runtime import HostBudget, JobRuntime, host_snapshot
    from executor.python_kernel_native import ManagedPythonLaunchers
    from executor.user_session import UserSession, root_owned_json
    config = root_owned_json("/etc/okami-executor/lenovo-okami.json")
    accounts = root_owned_json("/etc/okami-executor/users.json")
    assert config["executorId"] == "lenovo-okami" and config.get("pythonKernelEnabled") is not True
    assert directory.parent == Path("/var/lib/okami-executor/python-integration-qa")
    uuid.UUID(directory.name)
    directory.mkdir(mode=0o700)
    account = dict(accounts[config["executorId"]])
    workspace = Path(account["workspace"]) / (".qa-python-integration-" + directory.name)
    workspace.mkdir(mode=0o700)
    os.chown(workspace, account["uid"], account["gid"])
    account["workspace"] = str(workspace)
    anchors = [open_directory(account["home"]), open_directory(workspace)]
    runtime = JobRuntime(UserSession({config["executorId"]: account}), executor_id=config["executorId"],
                         home_fd=anchors[0], workspace_fd=anchors[1])
    snapshot = lambda: host_snapshot(config["hostId"], accounts=accounts.values())
    budget = HostBudget(snapshot()["memoryTotalBytes"], config.get("reserveBytes", 4 * 1024**3),
        state_path=Path("/var/lib/okami-executor") / ("host-" + config["hostId"] + "-resources.sqlite"))
else:
    workspace = directory / "workspace"
    workspace.mkdir()
workspace_identity = (workspace.stat().st_dev, workspace.stat().st_ino)
journal = Journal(directory / "journal.sqlite")
gate = Gate(journal, lambda reason: jobs.contain(), trust_mode=account["trustMode"] if registered else "restricted")
files = Workspace(workspace, directory / "file-state")
write_lock = threading.Lock()
commands = queue.Queue()
pending = {}
pending_lock = threading.Lock()
children = []


def send(value):
    with write_lock:
        sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def read():
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("kind") == "http-result":
            with pending_lock:
                target = pending.get(message["id"])
            if target is not None:
                target.put(message)
        else:
            commands.put(message)
    commands.put({"kind": "close"})


def request(route, body):
    identity, response = uuid.uuid4().hex, queue.Queue(maxsize=1)
    with pending_lock:
        pending[identity] = response
    try:
        send({"kind": "http", "id": identity, "route": route, "body": body})
        result = response.get(timeout=20)
        if "error" in result:
            raise ValueError(result["error"])
        return result["value"]
    finally:
        with pending_lock:
            pending.pop(identity, None)


def publish():
    for receipt in journal.unacknowledged():
        send({"kind": "receipt", **receipt})


def launch(scope, sentinel):
    process = subprocess.Popen([sys.executable, "-I", "-u", str(RUNNER_PATH), sentinel],
        cwd=workspace, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True)
    children.append(process)

    def stop():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
        return True
    return KernelProcess(process, stop)


if registered:
    assert subprocess.check_output(["systemctl", "is-active", "okami-executor@lenovo-okami.service"], text=True).strip() == "active"
    managed = ManagedPythonLaunchers(runtime, journal, budget, executor_id="lenovo-okami",
        guard=lambda: gate.open and not gate.quarantined and not gate.needs_reconciliation
                      and gate.clock() < gate.deadline, snapshot=snapshot)
    def launch_factory(owner, memory):
        launcher = managed.factory(owner, memory)
        def tracked(scope, sentinel):
            handle = launcher(scope, sentinel)
            children.append(handle.process)
            return handle
        return tracked
else:
    launch_factory = lambda owner, memory: launch
jobs = NativePythonJobs("lenovo-okami", journal, guard=lambda operation:
    gate.check(operation, inspection=operation.get("inspection") is True),
    consume=request, launch_factory=launch_factory, publish=publish,
    stopped_scope=managed.stopped_scope if registered else lambda scope: True)
threading.Thread(target=read, daemon=True).start()
send({"kind": "ready"})
try:
    while True:
        command = commands.get()
        if command["kind"] == "close":
            break
        try:
            if command["kind"] == "lease":
                gate.handshake(command["epoch"], command["pause"], command["watchdogMs"] / 1000)
                gate.reconciled()
                send({"kind": "result", "id": command["id"], "value": {"reconciled": True}})
                continue
            if command["kind"] == "ack":
                journal.acknowledge(command["operationId"], command["sequence"])
                continue
            if command["kind"] == "cancel":
                value = jobs.cancel(command["operationId"])
            elif command["kind"] == "inspect":
                value = {"exists": (workspace / command["path"]).exists(),
                         "children": len(children)}
            elif command["kind"] == "units":
                value = [{**record, "properties": dict(line.split("=", 1) for line in
                         subprocess.check_output(["systemctl", "show", record["unit"],
                             "--property=User,Group,MemoryMax,ControlGroup,BindsTo,KillMode,ActiveState"],
                             text=True).splitlines() if "=" in line),
                         "reservation": budget.jobs[record["unit"]]}
                         for record in managed.records()] if registered else []
            else:
                operation = command["operation"]
                gate.check(operation, inspection=operation.get("inspection") is True,
                           containment=operation["kind"] == "cancel")
                fresh = journal.receive(operation)
                if not fresh:
                    publish()
                    value = {"replayed": True}
                elif operation["kind"] == "command":
                    jobs.start(operation)
                    value = {"started": True}
                elif operation["kind"] == "cancel":
                    target = journal.get(operation["args"]["operationId"])["operation"]
                    assert all(target[key] == operation[key] for key in ("executorId", "taskId", "resourceKey"))
                    confirmed = jobs.cancel(target["id"])
                    assert jobs.wait(timeout=5)
                    value = {"cancelled": True, "contained": confirmed}
                    journal.receipt(operation["id"], {"status": "succeeded", "data": value})
                    publish()
                else:
                    value = jobs.reply(operation) if operation["capability"] == "python" else files.handle(operation)
                    journal.receipt(operation["id"], {"status": "succeeded", "data": value})
                    publish()
            send({"kind": "result", "id": command["id"], "value": value})
        except Exception as error:
            send({"kind": "result", "id": command["id"], "error": type(error).__name__ + ": " + str(error)})
finally:
    contained = jobs.contain()
    settled = jobs.wait(timeout=5)
    if not contained or not settled or any(child.poll() is None for child in children):
        raise RuntimeError("Test peer did not contain every interpreter")
    if registered:
        assert managed.contain() and not managed.records()
        assert not any(key.startswith("okami-python-") and value.get("executorId") == "lenovo-okami"
                       for key, value in budget.jobs.items())
        budget.close()
        for anchor in anchors:
            os.close(anchor)
    files.close()
    journal.close()
    if registered:
        assert not workspace.is_symlink() and (workspace.stat().st_dev, workspace.stat().st_ino) == workspace_identity
        shutil.rmtree(workspace)
        shutil.rmtree(directory)
