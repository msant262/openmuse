"""Managed job services under a shared bots slice; never a UID-wide kill sweep."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading

from .user_session import run
from .filesystem import open_directory


class HostBudget:
    """Additional host safety accounting; admission/work slots belong to the VPS.

    MemAvailable is physical RAM. Swap never adds available admission capacity.
    Frozen jobs keep their resource reservation and heavy ownership.
    """
    def __init__(self, memory_total_bytes, reserve_bytes=4 * 1024**3, state_path=None):
        if not 3 * 1024**3 <= reserve_bytes <= 4 * 1024**3 or reserve_bytes >= memory_total_bytes:
            raise ValueError("Host reserve must leave an aggregate bot budget")
        self.total, self.reserve = memory_total_bytes, reserve_bytes
        self._jobs = {}
        self.lock = threading.RLock()
        self.db = None
        if state_path is not None:
            Path(state_path).parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self.db = sqlite3.connect(state_path, check_same_thread=False)
            os.chmod(state_path, 0o600)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, value TEXT NOT NULL)")
            self.db.commit()

    @property
    def jobs(self):
        if self.db:
            return {key: json.loads(value) for key, value in self.db.execute("SELECT id,value FROM reservations")}
        return self._jobs

    def save(self, job_id, value):
        if self.db:
            self.db.execute("INSERT INTO reservations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", (job_id, json.dumps(value)))
        else:
            self._jobs[job_id] = value

    def close(self):
        if self.db:
            self.db.close()

    @property
    def reserved_bytes(self):
        return sum(job["bytes"] for job in self.jobs.values())

    @property
    def heavy_owner(self):
        return next((key for key, job in self.jobs.items() if job["heavy"]), None)

    def check_binding(self, job_id, memory_bytes, heavy, executor_id=None):
        existing=self.jobs.get(job_id)
        if existing and ((existing["bytes"],existing["heavy"])!=(memory_bytes,heavy) or
                         existing.get("executorId") not in (None,executor_id)):
            raise ValueError("Host reservation belongs to another executor or resource budget")
        return existing

    def admit(self, job_id, memory_bytes, heavy=False, memory_available_bytes=0, unmanaged_bytes=0,managed_session_bytes=0,executor_id=None):
        with self.lock:
            if self.db:
                self.db.execute("BEGIN IMMEDIATE")
            try:
                jobs = self.jobs
                if job_id in jobs:
                    existing=self.check_binding(job_id,memory_bytes,heavy,executor_id)
                    if executor_id is not None and existing.get("executorId") is None:
                        self.save(job_id,{**existing,"executorId":executor_id})
                    return
                if heavy and any(job["heavy"] for job in jobs.values()):
                    raise ValueError("Host heavy workload is busy; keep second load queued")
                if (not isinstance(memory_bytes, int) or isinstance(memory_bytes, bool) or not isinstance(heavy, bool)
                        or memory_bytes <= 0 or unmanaged_bytes < 0 or managed_session_bytes<0
                        or sum(job["bytes"] for job in jobs.values()) + memory_bytes + unmanaged_bytes + managed_session_bytes > self.total - self.reserve
                        or memory_bytes > memory_available_bytes - self.reserve):
                    raise ValueError("Insufficient physical RAM memory budget; swap is not admission capacity")
                self.save(job_id, {"bytes": memory_bytes, "heavy": heavy, "frozen": False,"executorId":executor_id})
            finally:
                if self.db:
                    self.db.commit()

    def restore(self, job_id, memory_bytes, heavy,executor_id=None):
        """Existing uncertain/frozen work still owns its safety reservation."""
        with self.lock:
            if self.db:
                self.db.execute("BEGIN IMMEDIATE")
            try:
                self.check_binding(job_id,memory_bytes,heavy,executor_id)
                self.save(job_id, {"bytes": memory_bytes, "heavy": heavy, "frozen": True,"executorId":executor_id})
            finally:
                if self.db:
                    self.db.commit()

    def freeze(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job:
                self.save(job_id, {**job, "frozen": True})
                if self.db:
                    self.db.commit()

    def release(self, job_id,executor_id=None,memory_bytes=None,heavy=None):
        with self.lock:
            if self.db:self.db.execute("BEGIN IMMEDIATE")
            try:
                existing=self.jobs.get(job_id)
                if existing:
                    self.check_binding(job_id,existing["bytes"] if memory_bytes is None else memory_bytes,
                                       existing["heavy"] if heavy is None else heavy,executor_id)
                    if self.db:self.db.execute("DELETE FROM reservations WHERE id=?", (job_id,))
                    else:self._jobs.pop(job_id, None)
            finally:
                if self.db:self.db.commit()


class JobRuntime:
    def __init__(self, sessions, runner=run, cgroup_root=Path("/sys/fs/cgroup"), state_root=Path("/var/lib/okami-executor/jobs"),workspace_fd=None,home_fd=None,executor_id=None):
        self.sessions, self.runner = sessions, runner
        self.cgroup_root, self.state_root = Path(cgroup_root), Path(state_root)
        self.active = {}
        self.lock = threading.RLock()
        self.workspace_fd,self.home_fd,self.executor_id=workspace_fd,home_fd,executor_id

    def unit(self, operation_id):
        # UUID/hash IDs are valid wire identities; hash into a fixed systemd-safe unit.
        if not isinstance(operation_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", operation_id):
            raise ValueError("Invalid operation ID")
        return "okami-job-" + hashlib.sha256(operation_id.encode()).hexdigest() + ".service"

    def launch(self, operation):
        account = self.sessions.account(operation["executorId"])
        workspace_source,home_source=account["workspace"],account["home"]
        if self.workspace_fd is not None or self.home_fd is not None:
            if self.executor_id!=operation["executorId"] or self.workspace_fd is None or self.home_fd is None:
                raise ValueError("Native job directory anchors do not match registered executor")
            for path,anchor in ((account["workspace"],self.workspace_fd),(account["home"],self.home_fd)):
                current=open_directory(path)
                try:
                    actual,expected=os.fstat(current),os.fstat(anchor)
                    if (actual.st_dev,actual.st_ino)!=(expected.st_dev,expected.st_ino):raise ValueError("Native job directory anchor changed")
                finally:os.close(current)
            workspace_source=f"/proc/{os.getpid()}/fd/{self.workspace_fd}"
            home_source=f"/proc/{os.getpid()}/fd/{self.home_fd}"
        args = operation["args"]
        cwd = args.get("cwd", "/workspace")
        if (not isinstance(cwd, str) or not (cwd == "/workspace" or cwd.startswith("/workspace/"))
                or ".." in cwd.split("/") or "\x00" in cwd):
            raise ValueError("Invalid job workspace path")
        actual_cwd = Path(account["workspace"]) / cwd.removeprefix("/workspace").lstrip("/")
        # Preflight no-follow every directory. systemd resolves this again inside
        # its per-job bind mount; task code never selects host root directories.
        if actual_cwd.exists():
            current = Path(account["workspace"])
            for part in actual_cwd.relative_to(current).parts:
                current = current / part
                if current.is_symlink():
                    raise ValueError("Job workspace symlink is not permitted")
        timeout = args.get("timeoutMs", 1800000)
        if not isinstance(timeout, int) or not 1000 <= timeout <= 1800000:
            raise ValueError("Invalid job timeout")
        if operation.get("kind","command")=="media":
            kind=args.get("mediaKind")
            parameters=args.get("parameters")
            if kind not in ("transcribe","preview") or not isinstance(parameters,dict):
                raise ValueError("Invalid native media request")
            encoded=base64.b64encode(json.dumps({"kind":kind,"parameters":parameters}).encode()).decode()
            if len(encoded)>24000:raise ValueError("Media request exceeds limit")
            executable=["/opt/okami-computer/venv/bin/python","-I",str(Path(__file__).resolve().parent.parent/"media_job.py"),encoded]
        else:
            command = args.get("command")
            if not isinstance(command, str) or not 1 <= len(command) <= 16000:
                raise ValueError("Invalid command")
            executable=["/usr/bin/bash", "--noprofile", "--norc", "-c", command]
        unit = self.unit(operation["id"])
        # No shell runs as root: systemd changes to the fixed registered User first.
        argv = ["systemd-run", "--quiet", "--no-block", "--unit=" + unit,
                "--expand-environment=no", "--property=Type=exec", "--property=RemainAfterExit=yes",
                "--slice=" + self.sessions.slice(operation["executorId"]),
                "--property=User=" + account["user"], "--property=Group=" + str(account["gid"]),
                "--property=WorkingDirectory=" + cwd, "--property=BindPaths=" + workspace_source + ":/workspace " + home_source+":"+account["home"],
                "--property=KillMode=control-group", "--property=OOMPolicy=kill",
                "--property=BindsTo=okami-executor@" + operation["executorId"] + ".service",
                "--property=After=okami-executor@" + operation["executorId"] + ".service",
                "--property=CPUWeight=100", "--property=IOWeight=100",
                "--property=TasksMax=512", "--property=RuntimeMaxSec=" + str(timeout / 1000),
                "--property=TimeoutStopSec=5", "--property=SendSIGKILL=yes",
                "--property=ReadWritePaths=/workspace " + account["home"],
                "--property=PrivateTmp=true",
                "--property=Environment=PATH=/usr/local/bin:/usr/bin:/bin HOME=" + account["home"] + " LANG=C.UTF-8",
                *executable]
        from .trust_policy import service_privileges
        argv[-len(executable):-len(executable)]=["--property="+key+"="+value for key,value in service_privileges(account).items()]
        memory = args.get("memoryMaxBytes")
        if memory is not None:
            if not isinstance(memory, int) or memory < 16 * 1024**2:
                raise ValueError("Invalid job memory budget")
            argv.insert(-len(executable), "--property=MemoryMax=" + str(memory))
        with self.lock:
            if operation["id"] in self.active:
                return {"unit": unit, "status": "running"}
            self.active[operation["id"]] = {"unit": unit, "executorId": operation["executorId"], "kind":operation.get("kind","command")}
        # The watchdog can contain the account slice while systemd-run waits.
        # Keep this identity even if its response is lost: inspect, never relaunch.
        self.runner(argv)
        return {"unit": unit, "status": "running"}

    def inspect(self, operation_id):
        unit = self.unit(operation_id)
        output = self.runner(["systemctl", "show", unit, "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,ControlGroup"])
        fields = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        # systemctl supplies success/zero defaults for missing units. These
        # fields are not execution evidence, regardless of their ordering.
        job = self.active.get(operation_id)
        expected=None
        if job:
            account = self.sessions.account(job["executorId"])
            expected = self.cgroup_root / "okami.slice" / "okami-bots.slice" / ("okami-bots-u" + str(account["uid"]) + ".slice") / unit
        if fields.get("LoadState") == "not-found":
            return {"status":"outcome_unknown", "cleanupConfirmed":expected is not None and not expected.exists(),
                    "message":"Prior service is absent or unloaded; external outcome remains unknown"}
        if fields.get("LoadState") != "loaded":
            return {"status":"outcome_unknown","cleanupConfirmed":False,"message":"Managed unit load state is unconfirmed"}
        if fields.get("ActiveState") in ("activating", "deactivating") or (
                fields.get("ActiveState")=="active" and fields.get("SubState")!="exited"):
            return {"status":"running","cleanupConfirmed":False}
        cgroup = fields.get("ControlGroup", "")
        if cgroup and self.populated(cgroup):
            return {"status": "outcome_unknown", "cleanupConfirmed":False,"message": "Job exited but descendant cleanup is unconfirmed"}
        if fields.get("Result") == "oom-kill":
            return {"status": "failed", "cleanupConfirmed":True,"message": "Job service exceeded memory budget; desktop preserved", "exitCode": 137}
        if fields.get("Result") == "timeout":
            return {"status": "outcome_unknown", "cleanupConfirmed":True,"message": "Job timed out; external effects may already have occurred"}
        exited=(fields.get("ActiveState") in ("inactive","failed") or
                fields.get("ActiveState")=="active" and fields.get("SubState")=="exited")
        executed=(int(fields.get("ExecMainStartTimestampMonotonic","0"))>0 and
                  int(fields.get("ExecMainExitTimestampMonotonic","0"))>0 and
                  fields.get("ExecMainCode") in ("1","exited"))
        if exited and executed and "ExecMainStatus" in fields:
            status=int(fields["ExecMainStatus"])
            return {"status":"succeeded" if status==0 and fields.get("Result")=="success" else "failed",
                    "cleanupConfirmed":True,"exitCode":status}
        if exited:
            return {"status":"outcome_unknown","cleanupConfirmed":True,
                    "message":"Job has no owned process-exit proof; cancelled or unstarted effects remain uncertain"}
        return {"status": "outcome_unknown", "cleanupConfirmed":False,"message": "Managed job receipt is unavailable; no automatic repetition"}

    def populated(self, cgroup):
        if not cgroup.startswith("/okami.slice/okami-bots.slice/") or ".." in cgroup.split("/"):
            raise ValueError("Managed job escaped aggregate slice")
        try:
            events = (self.cgroup_root / cgroup.lstrip("/") / "cgroup.events").read_text()
            return "populated 1" in events
        except FileNotFoundError:
            return False

    def cancel(self, operation_id):
        self.runner(["systemctl", "stop", self.unit(operation_id)])

    def freeze(self, operation_id):
        self.runner(["systemctl", "freeze", self.unit(operation_id)])

    def thaw(self, operation_id):
        self.runner(["systemctl", "thaw", self.unit(operation_id)])

    def contain(self, executor_id, freeze=True):
        contained = True
        with self.lock:
            jobs = [(key, value) for key, value in self.active.items() if value["executorId"] == executor_id]
        for operation_id, job in jobs:
            try:
                (self.freeze if freeze else self.cancel)(operation_id)
                fields = self.runner(["systemctl", "show", job["unit"], "--property=FreezerState,ControlGroup"])
                if freeze and "FreezerState=frozen" not in fields:
                    contained = contained and self.inspect(operation_id).get("cleanupConfirmed", False)
            except (OSError, ValueError, subprocess.SubprocessError):
                try:
                    contained = contained and self.inspect(operation_id).get("cleanupConfirmed", False)
                except Exception:
                    contained = False
        return contained

    def adopt(self, operation):
        # After supervisor restart, record the old service for containment; never launch it again.
        with self.lock:
            self.active[operation["id"]] = {"unit": self.unit(operation["id"]), "executorId": operation["executorId"], "kind":operation.get("kind","command")}

    def release(self, operation_id):
        with self.lock:
            if operation_id not in self.active:return
            unit=self.unit(operation_id)
            # Supervisor commits its owned terminal receipt before calling
            # release. Retention prevents short successes being GC'd before it.
            fields=self.runner(["systemctl","show",unit,"--property=LoadState"])
            if "LoadState=not-found" not in fields:
                self.runner(["systemctl","stop",unit])
                fields=self.runner(["systemctl","show",unit,"--property=LoadState"])
                if "LoadState=not-found" not in fields:
                    try:self.runner(["systemctl","reset-failed",unit])
                    except subprocess.CalledProcessError:
                        if "LoadState=not-found" not in self.runner(["systemctl","show",unit,"--property=LoadState"]):raise
            self.active.pop(operation_id,None)

    def output(self, operation_id):
        # Journal data is read from the fixed unit only, not an arbitrary log path.
        text = self.runner(["journalctl", "--unit=" + self.unit(operation_id), "--output=cat", "--no-pager", "--lines=2000"])
        encoded = text.encode("utf8")
        if self.active.get(operation_id,{}).get("kind")=="media":
            try:
                line=next(line for line in reversed(text.splitlines()) if line.startswith("OKAMI_MEDIA_RESULT:"))
                if len(line.encode())>131072:raise ValueError("Media result exceeds limit")
                result=json.loads(line.removeprefix("OKAMI_MEDIA_RESULT:"))
                if not isinstance(result,dict):raise ValueError("Invalid media result")
                return {"stdout":"", "stderr":"", "truncated":False, "result":result}
            except (StopIteration,ValueError):
                return {"stdout":"", "stderr":"Media result unavailable; inspect the input, installed tools and offline model", "truncated":False,"mediaError":True}
        return {"stdout": encoded[:131072].decode("utf8", errors="replace"), "stderr": "",
                "truncated": len(encoded) > 131072}


def unmanaged_memory(accounts, proc_root=Path("/proc")):
    """Count existing registered-UID sessions without moving or killing them.

    PSS avoids charging shared pages twice. RSS is a conservative fallback for
    kernels lacking smaps_rollup. Personal users are included by MemAvailable,
    and are never enumerated as bot workloads.
    """
    uids={account["uid"] for account in accounts}
    measured=0
    for pid in proc_root.iterdir():
        if not pid.name.isdecimal():continue
        try:
            status=(pid/"status").read_text().splitlines()
            uid=int(next(line for line in status if line.startswith("Uid:")).split()[1])
            if uid not in uids or "/okami.slice/okami-bots.slice/" in (pid/"cgroup").read_text():continue
            try:
                pss=next(line for line in (pid/"smaps_rollup").read_text().splitlines() if line.startswith("Pss:"))
                measured+=int(pss.split()[1])*1024
            except (FileNotFoundError,ProcessLookupError,StopIteration):
                rss=next((line for line in status if line.startswith("VmRSS:")),None)
                if rss:measured+=int(rss.split()[1])*1024
        except (FileNotFoundError,ProcessLookupError):
            continue  # Process exited during its read-only sample.
    return measured


def host_snapshot(host_id, cgroup_root=Path("/sys/fs/cgroup"), meminfo_path=Path("/proc/meminfo"), heavy_owner=None, accounts=()):
    memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in meminfo_path.read_text().splitlines()}
    base = cgroup_root / "okami.slice" / "okami-bots.slice"
    def number(name):
        text = (base / name).read_text().strip()
        return None if text == "max" else int(text)
    current=number("memory.current")
    job_current=0
    for account in accounts:
        account_group=base/("okami-bots-u"+str(account["uid"])+".slice")
        try:
            for child in account_group.iterdir():
                # Both families have durable physical reservations. Idle Python
                # units retain theirs until their exact cgroup is stopped.
                if re.fullmatch(r"okami-(?:job|python)-[0-9a-f]{64}\.service",child.name):
                    try:job_current+=int((child/"memory.current").read_text())
                    except FileNotFoundError:pass
        except FileNotFoundError:pass
    return {"hostId": host_id, "memoryTotalBytes": memory["MemTotal"], "memoryAvailableBytes": memory["MemAvailable"],
            "botsCurrentBytes": current, "botsHighBytes": number("memory.high"),
            "botsMaxBytes": number("memory.max"), "pressure": (base / "memory.pressure").read_text()[:2048],
            "heavyOwner": heavy_owner,"unmanagedAccountBytes":unmanaged_memory(accounts) if accounts else 0,
            "managedSessionBytes":max(0,current-job_current)}
