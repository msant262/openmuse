"""Fixed native user/cgroup launcher for the persistent Python controller.

No model-selectable UID, source path, environment, home or sudo policy. The
caller must admit the RAM budget before launching and connect contain() to the
native watchdog. This adapter is not advertised until that wiring is complete.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading

from .filesystem import open_directory
from .python_kernel import KernelProcess, RUNNER_PATH
from .trust_policy import service_privileges


def stop_python_unit(runtime, executor_id, unit, process=None):
    """Observe/stop the exact root-recorded unit, including collected services."""
    if not isinstance(unit, str) or not re.fullmatch(r"okami-python-[a-f0-9]{64}\.service", unit):
        raise ValueError("Invalid owned Python unit")
    expected = (runtime.cgroup_root / "okami.slice" / "okami-bots.slice"
                / runtime.sessions.slice(executor_id) / unit)
    try:
        try: runtime.runner(["systemctl", "stop", unit])
        except subprocess.CalledProcessError: pass
        try:
            observed = runtime.runner(["systemctl", "show", unit, "--property=LoadState,ActiveState,ControlGroup"])
        except subprocess.CalledProcessError as error:
            observed = error.stdout or ""
            if isinstance(observed, bytes): observed = observed.decode(errors="replace")
        fields = dict(line.split("=", 1) for line in observed.splitlines() if "=" in line)
        if not (fields.get("LoadState") == "not-found" or fields.get("ActiveState") in ("inactive", "failed")):
            return False
        if process is not None: process.wait(timeout=10)
        group = fields.get("ControlGroup", "")
        if group and runtime.populated(group): return False
        if expected.exists() and "populated 1" in (expected / "cgroup.events").read_text(): return False
        return True
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


class NativePythonLauncher:
    def __init__(self, runtime, *, executor_id, owner, memory_bytes, guard,
                 before_launch=lambda scope, unit: None, after_stop=lambda unit: None):
        if (not isinstance(owner, str) or not owner or len(owner) > 1024
                or type(memory_bytes) is not int or memory_bytes < 16 * 1024**2
                or not callable(guard)):
            raise ValueError("A registered owner, admitted memory budget and native gate are required")
        runtime.sessions.account(executor_id)
        self.runtime, self.executor_id, self.owner = runtime, executor_id, owner
        self.memory_bytes, self.guard = memory_bytes, guard
        self.before_launch, self.after_stop = before_launch, after_stop
        self.units, self.lock = {}, threading.Lock()

    def command(self, scope, sentinel):
        if (not isinstance(scope, tuple) or len(scope) != 3 or scope[:2] != (self.executor_id, self.owner)
                or not isinstance(scope[2], str) or not 1 <= len(scope[2]) <= 1024):
            raise ValueError("Python scope does not match the registered native executor and owner")
        if not isinstance(sentinel, str) or not re.fullmatch(r"[A-Za-z0-9@_-]{1,128}", sentinel):
            raise ValueError("Invalid Python private framing identity")
        if self.guard() is not True:
            raise RuntimeError("Native Python gate is closed")
        runtime = self.runtime
        if runtime.executor_id != self.executor_id or runtime.home_fd is None or runtime.workspace_fd is None:
            raise ValueError("Native Python requires the registered directory anchors")
        account = runtime.sessions.account(self.executor_id)
        for path, anchor in [(account["workspace"], runtime.workspace_fd), (account["home"], runtime.home_fd)]:
            current = open_directory(path)
            try:
                actual, expected = os.fstat(current), os.fstat(anchor)
                if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
                    raise ValueError("Native Python directory anchor changed")
            finally:
                os.close(current)
        unit = "okami-python-" + hashlib.sha256(json.dumps([scope, sentinel]).encode()).hexdigest() + ".service"
        properties = {
            "Type": "exec", "User": account["user"], "Group": str(account["gid"]),
            "WorkingDirectory": "/workspace", "KillMode": "control-group", "OOMPolicy": "kill",
            "BindsTo": "okami-executor@" + self.executor_id + ".service",
            "After": "okami-executor@" + self.executor_id + ".service",
            "CPUWeight": "100", "IOWeight": "100", "TasksMax": "512",
            "MemoryMax": str(self.memory_bytes), "TimeoutStopSec": "5", "SendSIGKILL": "yes",
            "UMask": "0077", "PrivateTmp": "true",
            "BindPaths": (f"/proc/{os.getpid()}/fd/{runtime.workspace_fd}:/workspace "
                          f"/proc/{os.getpid()}/fd/{runtime.home_fd}:" + account["home"]),
            "ReadWritePaths": "/workspace " + account["home"],
            "Environment": "PATH=/usr/local/bin:/usr/bin:/bin HOME=" + account["home"] + " LANG=C.UTF-8",
            **service_privileges(account),
        }
        argv = ["systemd-run", "--quiet", "--pipe", "--wait", "--expand-environment=no",
                "--unit=" + unit, "--slice=" + runtime.sessions.slice(self.executor_id),
                *["--property=" + key + "=" + value for key, value in properties.items()],
                "/usr/bin/python3", "-I", "-u", str(RUNNER_PATH), sentinel]
        return argv, unit

    @staticmethod
    def _source_is_trusted():
        # Fixed code is installed by the root coordinator. The registered bot
        # must never replace the supervisor-side launcher or child runner.
        for path in [RUNNER_PATH, RUNNER_PATH.parent / "vendor" / "hermes_code_kernel.py"]:
            for entry in [path, *path.parents]:
                info = entry.lstat()
                if (info.st_uid != 0 or info.st_mode & 0o022 or
                        (entry == path and not stat.S_ISREG(info.st_mode)) or
                        (entry != path and not stat.S_ISDIR(info.st_mode))):
                    raise ValueError("Native Python source must be root-owned and not writable by bots")

    def __call__(self, scope, sentinel):
        if os.geteuid() != 0:
            raise ValueError("Only the registered native supervisor may launch Python units")
        self._source_is_trusted()
        argv, unit = self.command(scope, sentinel)
        # Root journal identity and physical admission precede systemd dispatch.
        self.before_launch(scope, unit)
        # systemd-run carries only the private streams; systemd changes User
        # before Python starts. Node/server credentials never enter its env.
        try:
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}, close_fds=True)
        except Exception:
            if stop_python_unit(self.runtime, self.executor_id, unit): self.after_stop(unit)
            raise

        def stop():
            try:
                if not stop_python_unit(self.runtime, self.executor_id, unit, process): return False
                self.after_stop(unit)
                with self.lock: self.units.pop(unit, None)
                return True
            except Exception:
                return False

        handle = KernelProcess(process, stop)
        with self.lock:
            self.units[unit] = handle
        # A gate may close during service start. Own and stop the exact unit;
        # the controller retains an unconfirmed stop rather than spawning again.
        if self.guard() is not True:
            stop()
        return handle

    def contain(self):
        """Called by the native watchdog once this adapter is registered."""
        with self.lock:
            handles = list(self.units.values())
        outcomes = [handle.stop() for handle in handles]
        return all(outcomes)


class ManagedPythonLaunchers:
    """Crash-safe ownership and idle RAM reservations for the fixed supervisor."""
    def __init__(self, runtime, journal, budget, *, executor_id, guard, snapshot, max_sessions=4):
        self.runtime, self.journal, self.budget = runtime, journal, budget
        self.executor_id, self.guard, self.snapshot = executor_id, guard, snapshot
        self.max_sessions, self.launchers, self.lock = max_sessions, [], threading.RLock()

    def records(self):
        return self.journal.state("python-units") or []

    def _remember(self, scope, unit, memory):
        with self.lock, self.journal.lock:
            records = self.records()
            if len(records) >= self.max_sessions:
                raise ValueError("Native Python session capacity remains owned")
            record = {"unit": unit, "executorId": self.executor_id, "scope": list(scope), "memoryBytes": memory}
            self.journal.state("python-units", [*records, record])
            snapshot = self.snapshot()
            try:
                self.budget.admit(unit, memory, False, snapshot["memoryAvailableBytes"],
                    snapshot.get("unmanagedAccountBytes", 0), snapshot.get("managedSessionBytes", 0), self.executor_id)
            except Exception:
                # No process has been started. Keep the record if either
                # durable rollback fails, for the startup cleanup path.
                self._forget(unit, memory)
                raise

    def _forget(self, unit, memory):
        with self.lock, self.journal.lock:
            self.budget.release(unit, self.executor_id, memory, False)
            self.journal.state("python-units", [item for item in self.records() if item["unit"] != unit])

    def factory(self, owner, memory):
        launcher = NativePythonLauncher(self.runtime, executor_id=self.executor_id, owner=owner,
            memory_bytes=memory, guard=self.guard,
            before_launch=lambda scope, unit: self._remember(scope, unit, memory),
            after_stop=lambda unit: self._forget(unit, memory))
        with self.lock:
            self.launchers = [item for item in self.launchers if item.units]
            self.launchers.append(launcher)
        return launcher

    def recover(self):
        """Stop durable old units even if Python is disabled after a rollback."""
        outcomes = []
        with self.lock:
            for item in self.records():
                if (set(item) != {"unit", "executorId", "scope", "memoryBytes"}
                        or item["executorId"] != self.executor_id or not isinstance(item["scope"], list)
                        or len(item["scope"]) != 3 or item["scope"][0] != self.executor_id
                        or type(item["memoryBytes"]) is not int or item["memoryBytes"] < 16 * 1024**2):
                    raise ValueError("Retained Python unit ownership is invalid")
                self.budget.restore(item["unit"], item["memoryBytes"], False, self.executor_id)
                confirmed = stop_python_unit(self.runtime, self.executor_id, item["unit"])
                outcomes.append(confirmed)
                if confirmed: self._forget(item["unit"], item["memoryBytes"])
        return all(outcomes)

    def stopped_scope(self, scope):
        with self.lock:
            records = [item for item in self.records() if item["scope"] == list(scope)]
            for item in records:
                if not stop_python_unit(self.runtime, self.executor_id, item["unit"]): return False
                self._forget(item["unit"], item["memoryBytes"])
        return True

    def contain(self):
        with self.lock: launchers = list(self.launchers)
        outcomes = [launcher.contain() for launcher in launchers]
        # Also includes launch attempts that failed before returning a handle.
        return self.recover() and all(outcomes)
